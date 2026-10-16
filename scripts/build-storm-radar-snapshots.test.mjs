/**
 * Tests for the MRMS radar snapshot builder.
 *
 * The selection helpers are pure precisely so this suite needs no network and no
 * 1.1 GB download cache: the truncation rule is a data-integrity decision, and a
 * decision that can only be exercised by a two-minute full-window rebuild is a
 * decision that quietly regresses.
 *
 * @module scripts/build-storm-radar-snapshots.test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  CELL_DEG,
  cellFeature,
  cellIndex,
  compareBySeverity,
  DAY_INDEX_EPOCH,
  dayIndex,
  decodePerDayRecords,
  DOMAIN_MAX_LAT,
  DOMAIN_MIN_LAT,
  DOMAIN_MIN_LON,
  encodePerDayRecords,
  featuresByYear,
  GRID_CELL_COUNT,
  GRID_COLUMNS,
  GRID_COL_BASE,
  gridCol,
  GRID_MAX_LON,
  GRID_ROW_BASE,
  GRID_ROWS,
  gridRow,
  HAIL_RETAIN_MM,
  inDomain,
  ingestMeshGz,
  mergeYearFeatures,
  perDayMeta,
  perDayRecords,
  PER_DAY_MM_SCALE,
  PER_DAY_RECORD_BYTES,
  radarMeta,
  restrictYearsToKeys,
  selectKeptCells,
  writePerDayBin,
  writeGeoJsonlGz,
  writeMetaJson,
  yearBucket,
} from './build-storm-radar-snapshots.mjs';

/** One accumulator entry, as `ingestMeshGz` leaves it. */
function cell(i, j, maxMm, { corePoints = 1, days = ['20210101'] } = {}) {
  return {
    i,
    j,
    maxMm,
    corePoints,
    days: new Set(days),
    firstYmd: days[0],
    lastYmd: days[days.length - 1],
  };
}

/** An accumulator of the shape the builder builds: year -> `i:j` -> cell. */
function accumulator(entries) {
  return new Map(
    entries.map(([year, list]) => [
      year,
      new Map(list.map((c) => [`${c.i}:${c.j}`, c])),
    ]),
  );
}

/** Build a feature in the exact shape the builder emits. */
function feature(i, j, mx, { cp = 1, dy = 1, y0 = 2021, y1 = 2021 } = {}) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [
        Math.round((j * 0.25 + 0.125) * 100000) / 100000,
        Math.round((i * 0.25 + 0.125) * 100000) / 100000,
      ],
    },
    properties: { i, j, d: 0.25, mx, cp, dy, y0, y1 },
  };
}

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storm-radar-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Absolute path of one cached MRMS daily-maximum download, or null when the ETL
 * cache has not been populated. Lets the suite prove the real decode path without
 * making a 1.1 GB download a precondition for running it.
 * @param {string} ymd
 * @returns {string|null}
 */
function meshCacheFile(ymd) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = path.join(
    process.env.GEV_PROJECT_ROOT || root,
    '.gev-cache',
    'build',
    `noaa_mrms_pds_s3_amazonaws_com_CONUS_MESH_Max_1440min_00_50_${ymd}_MRMS_MESH_Max_1440min_00_50_${ymd}_000000_grib2_gz.bin`,
  );
  return fsSync.existsSync(file) ? file : null;
}

test('truncation keeps the strongest hail cells, not the first N ingested', () => {
  // The cells Map is filled in download-completion order, so `slice(0, N)`
  // would keep whatever finished first. Here the weakest cell is first.
  const features = [
    feature(10, 10, 26),
    feature(11, 11, 41),
    feature(12, 12, 188),
    feature(13, 13, 33),
    feature(14, 14, 75),
  ];

  const { kept, truncated, cellsBeforeTruncation } = selectKeptCells(
    features,
    3,
  );

  assert.equal(truncated, true, 'the ceiling was applied');
  assert.equal(
    cellsBeforeTruncation,
    5,
    'the pre-truncation count is reported',
  );
  assert.equal(kept.length, 3);
  assert.deepEqual(
    kept.map((f) => f.properties.mx),
    [188, 75, 41],
    'the 200mm core survives and the 25mm core is the one dropped',
  );
  assert.ok(
    !kept.some((f) => f.properties.mx === 26),
    'the weakest cell is discarded, which is the whole point',
  );
});

test('a naive first-N slice would have kept different cells, so the sort is load-bearing', () => {
  const features = Array.from({ length: 50 }, (_, n) => feature(n, n, 25 + n));
  // Ingestion order here is worst-first, the pathological order a slow-network
  // day can produce: ascending severity.
  const naive = features.slice(0, 10).map((f) => f.properties.mx);
  const ranked = selectKeptCells(features, 10).kept.map((f) => f.properties.mx);

  assert.deepEqual(naive, [25, 26, 27, 28, 29, 30, 31, 32, 33, 34]);
  assert.deepEqual(
    ranked,
    [74, 73, 72, 71, 70, 69, 68, 67, 66, 65],
    'ranking inverts which cells the ceiling keeps',
  );
});

test('selection is independent of ingestion order, so two runs emit identical bytes', () => {
  const features = [
    feature(1, 1, 50),
    feature(2, 2, 50),
    feature(3, 3, 90),
    feature(4, 4, 50),
    feature(5, 5, 90),
    feature(6, 6, 30),
  ];
  const forward = selectKeptCells(features, 4);
  const reversed = selectKeptCells([...features].reverse(), 4);

  assert.deepEqual(
    forward.kept.map((f) => `${f.properties.i}:${f.properties.j}`),
    reversed.kept.map((f) => `${f.properties.i}:${f.properties.j}`),
    'reversed insertion order selects the same cells in the same order',
  );
  // Equal peaks must fall back to the grid index, not to arrival order.
  assert.deepEqual(
    forward.kept.map((f) => `${f.properties.i}:${f.properties.j}`),
    ['3:3', '5:5', '1:1', '2:2'],
    'the 90mm cells lead; the three 50mm cells are ordered by grid index',
  );
});

test('a window under the ceiling keeps every cell and says it was not truncated', () => {
  const features = [feature(1, 1, 30), feature(2, 2, 60)];
  const { kept, truncated, cellsBeforeTruncation } = selectKeptCells(
    features,
    3,
  );

  assert.equal(truncated, false);
  assert.equal(cellsBeforeTruncation, 2);
  assert.equal(kept.length, 2);
  assert.deepEqual(
    kept.map((f) => f.properties.mx),
    [60, 30],
    'even untruncated output is ranked, so the file is stable run to run',
  );
});

test('the grid-index tiebreak is numeric, so negative indices do not sort lexically', () => {
  const ordered = [
    feature(-10, -10, 40),
    feature(-9, -9, 40),
    feature(-1, -1, 40),
    feature(0, 0, 40),
  ].sort(compareBySeverity);

  assert.deepEqual(
    ordered.map((f) => f.properties.i),
    [-10, -9, -1, 0],
  );
});

test('a day is routed to the bucket named by its own stamp, not a cell-wide one', () => {
  const cellsByYear = new Map();

  const first = yearBucket(cellsByYear, '20210615');
  assert.equal(first.year, 2021);
  const sameYear = yearBucket(cellsByYear, '20210101');
  assert.equal(
    sameYear.bucket,
    first.bucket,
    'two days in one year share one bucket, so cp/dy accumulate',
  );
  const otherYear = yearBucket(cellsByYear, '20240515');
  assert.equal(otherYear.year, 2024);
  assert.notEqual(
    otherYear.bucket,
    first.bucket,
    'a new year gets its own accumulator rather than inheriting prior years',
  );
  assert.deepEqual([...cellsByYear.keys()].sort(), [2021, 2024]);
  assert.equal(cellsByYear.get(2021).size, 0, 'the bucket starts empty');
});

test('a cell active in 2021 and 2024 lands in both year files, each with that year own peak', () => {
  // The defect this guards: one merged accumulator makes every cell's mx the
  // whole-period peak, so a "2021" file either drops this cell (if its last
  // activity was later) or publishes 2024 hail strength under a 2021 label.
  const cellsByYear = accumulator([
    [
      2021,
      [
        cell(163, -405, 39.4, {
          corePoints: 31,
          days: ['20210615', '20210616'],
        }),
      ],
    ],
    [
      2024,
      [
        cell(163, -405, 88.1, {
          corePoints: 42,
          days: ['20240515', '20240516'],
        }),
        cell(170, -400, 30, { corePoints: 5, days: ['20240515'] }),
      ],
    ],
  ]);

  const byYear = featuresByYear(cellsByYear);

  assert.deepEqual([...byYear.keys()], [2021, 2024], 'years ascend');
  const shared = (list) => list.find((f) => f.properties.i === 163);
  assert.equal(shared(byYear.get(2021)).properties.mx, 39.4, '2021 peak');
  assert.equal(shared(byYear.get(2024)).properties.mx, 88.1, '2024 peak');
  assert.equal(shared(byYear.get(2021)).properties.cp, 31);
  assert.equal(shared(byYear.get(2024)).properties.cp, 42);
  assert.equal(
    shared(byYear.get(2021)).properties.dy,
    2,
    'two distinct 2021 days',
  );
  assert.equal(
    shared(byYear.get(2024)).properties.dy,
    2,
    'two distinct 2024 days',
  );
  for (const list of byYear.values()) {
    for (const f of list) {
      assert.equal(
        f.properties.y0,
        f.properties.y1,
        'a per-year record cannot claim activity outside its own year',
      );
    }
  }
  assert.deepEqual(
    byYear.get(2024).map((f) => f.properties.mx),
    [88.1, 30],
    'each year file is ranked strongest-first',
  );
  assert.equal(byYear.get(2021).length, 1, 'the 2024-only cell is not in 2021');
  assert.deepEqual(
    Object.keys(byYear.get(2021)[0].properties).sort(),
    ['cp', 'd', 'dy', 'i', 'j', 'mx', 'y0', 'y1'],
    'consumers key on i:j and read cp/dy/mx; the shape must not drift',
  );
});

test('the combined snapshot is folded back out of the per-year records', () => {
  const byYear = featuresByYear(
    accumulator([
      [
        2021,
        [
          cell(163, -405, 39.4, {
            corePoints: 31,
            days: ['20210615', '20210616'],
          }),
        ],
      ],
      [
        2024,
        [
          cell(163, -405, 88.1, {
            corePoints: 42,
            days: ['20240515', '20240516'],
          }),
          cell(170, -400, 30, { corePoints: 5, days: ['20240515'] }),
        ],
      ],
    ]),
  );

  const merged = mergeYearFeatures(byYear);

  assert.equal(
    merged.length,
    2,
    'one record per cell, however many years it spans',
  );
  const shared = merged.find((f) => f.properties.i === 163);
  assert.deepEqual(
    shared.properties,
    {
      i: 163,
      j: -405,
      d: 0.25,
      mx: 88.1,
      cp: 73,
      dy: 4,
      y0: 2021,
      y1: 2024,
    },
    'mx is the strongest year, cp and dy sum, y0/y1 widen to the span',
  );
  const single = merged.find((f) => f.properties.i === 170);
  assert.equal(single.properties.y0, 2024);
  assert.equal(
    single.properties.y1,
    2024,
    'a one-year cell keeps a zero-width span',
  );
});

test('merging the year files is order-independent', () => {
  const entries = [
    [2021, [cell(1, 1, 50, { corePoints: 2, days: ['20210101'] })]],
    [2024, [cell(1, 1, 90, { corePoints: 3, days: ['20240515'] })]],
  ];
  const forwards = mergeYearFeatures(featuresByYear(accumulator(entries)));
  const backwards = mergeYearFeatures(
    featuresByYear(accumulator(entries.slice().reverse())),
  );

  assert.deepEqual(
    forwards.map((f) => JSON.stringify(f)),
    backwards.map((f) => JSON.stringify(f)),
    'two runs over the same days emit the same combined bytes',
  );
});

test('the union of the year files is an exact partition of the combined file, even under truncation', () => {
  const byYear = featuresByYear(
    accumulator([
      [
        2021,
        [
          cell(1, 1, 90, { days: ['20210101'] }),
          cell(2, 2, 26, { days: ['20210101'] }),
        ],
      ],
      [
        2024,
        [
          cell(1, 1, 30, { days: ['20240515'] }),
          cell(3, 3, 60, { days: ['20240515'] }),
        ],
      ],
    ]),
  );

  for (const maxCells of [100, 2]) {
    const { kept } = selectKeptCells(mergeYearFeatures(byYear), maxCells);
    const keys = kept.map((f) => `${f.properties.i}:${f.properties.j}`);
    const published = restrictYearsToKeys(byYear, new Set(keys));
    const union = new Set(
      [...published.values()]
        .flat()
        .map((f) => `${f.properties.i}:${f.properties.j}`),
    );

    assert.equal(
      union.size,
      keys.length,
      'no year file contributes a duplicate key',
    );
    assert.deepEqual(
      [...union].sort(),
      [...keys].sort(),
      'the union IS the combined set',
    );
    if (maxCells === 2) {
      assert.equal(kept.length, 2);
      assert.equal(
        published.get(2021).length,
        1,
        'the weakest cell is dropped from every file at once, not just the combined one',
      );
    }
  }
});

test(
  'a real MRMS day is ingested into its own year bucket with its own statistics',
  { skip: !meshCacheFile('20210615') ? 'no cached MRMS day on disk' : false },
  () => {
    // End-to-end over the real decoder, when the ETL cache is present: 20210615
    // peaks at 56.2mm in cell 171:-406 and 20240515 peaks at 44.2mm in the same
    // cell, which is exactly the case the flat accumulator got wrong.
    const cellsByYear = new Map();
    ingestMeshGz(
      fsSync.readFileSync(meshCacheFile('20210615')),
      '20210615',
      cellsByYear,
    );
    ingestMeshGz(
      fsSync.readFileSync(meshCacheFile('20240515')),
      '20240515',
      cellsByYear,
    );

    const byYear = featuresByYear(cellsByYear);
    const in2021 = byYear
      .get(2021)
      .find((f) => f.properties.i === 171 && f.properties.j === -406);
    const in2024 = byYear
      .get(2024)
      .find((f) => f.properties.i === 171 && f.properties.j === -406);
    assert.ok(
      in2021 && in2024,
      'the cell is present in both years, not just one',
    );
    assert.equal(in2021.properties.y0, 2021);
    assert.equal(in2021.properties.y1, 2021);
    assert.equal(in2024.properties.y0, 2024);
    assert.equal(in2024.properties.y1, 2024);
    assert.equal(
      in2021.properties.mx,
      56.2,
      "2021's own peak, not the year's best",
    );
    assert.equal(
      in2024.properties.mx,
      44.2,
      "2024's own peak, not the archive best",
    );
    assert.equal(
      Math.max(in2021.properties.mx, in2024.properties.mx),
      56.2,
      'whichever year is stronger is what the merged cell reports',
    );
    assert.equal(
      in2021.properties.dy,
      1,
      'one ingested day means one distinct day',
    );
  },
);

test('per-year writes are gzipped GeoJSONL, byte-identical across writes, and atomic', async (t) => {
  const dir = await tmpDir(t);
  const file = path.join(dir, 'storm_radar_hail_2024.geojsonl.gz');
  const second = path.join(dir, 'again', 'storm_radar_hail_2024.geojsonl.gz');
  const features = [
    feature(1, 1, 90, { y1: 2024 }),
    feature(2, 2, 60, { y1: 2024 }),
  ];

  const size = await writeGeoJsonlGz(file, features);
  await writeGeoJsonlGz(second, features);

  assert.ok(size > 0, 'the writer reports the size it wrote');
  assert.deepEqual(
    await fs.readFile(file),
    await fs.readFile(second),
    'gzip output is reproducible: no mtime or ordering leaks into the bytes',
  );

  const lines = zlib
    .gunzipSync(await fs.readFile(file))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], features[0], 'the feature shape is unchanged');
  assert.deepEqual(
    Object.keys(lines[0].properties).sort(),
    ['cp', 'd', 'dy', 'i', 'j', 'mx', 'y0', 'y1'],
    'consumers key on i:j and read cp/dy/mx; the shape must not drift',
  );
  assert.deepEqual(
    await fs
      .readdir(dir, { withFileTypes: true })
      .then((all) =>
        all.filter((entry) => entry.isFile()).map((entry) => entry.name),
      ),
    ['storm_radar_hail_2024.geojsonl.gz'],
    'the .tmp file is renamed away, never left behind',
  );
});

test('meta sidecars record the truncation decision the artefact cannot otherwise show', async (t) => {
  const dir = await tmpDir(t);
  const meta = radarMeta({
    builtAt: '2026-10-15T00:00:00.000Z',
    window: { from: '2024-01-01', to: '2024-12-31', days: 366 },
    unavailableDays: [{ ymd: '20240715', error: '404' }],
    cellCount: 40000,
    corePointCount: 120000,
    truncated: true,
    cellsBeforeTruncation: 51932,
  });

  assert.equal(meta.truncated, true);
  assert.equal(meta.cellsBeforeTruncation, 51932);
  assert.equal(meta.cellCount, 40000);
  assert.equal(meta.maxCells, 40000);
  assert.equal(
    meta.window.days,
    366,
    'the year sidecar carries its own window',
  );

  const file = path.join(dir, 'storm-radar-sources_2024.json');
  await writeMetaJson(file, meta);
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(raw.endsWith('}\n'), 'sidecars keep the trailing newline');
  assert.deepEqual(JSON.parse(raw), meta);
  assert.deepEqual(await fs.readdir(dir), ['storm-radar-sources_2024.json']);
});


test('the domain bounds are the ones the MRMS grid actually spans', () => {
  // The retained index space is derived from these bounds, so they are checked
  // as arithmetic rather than as magic numbers: a bound that moved by one unit
  // would shift the space, and the plan's 16-bit encoding rests on its size.
  assert.equal(DOMAIN_MIN_LON, -125);
  assert.equal(DOMAIN_MIN_LAT, 21);
  assert.equal(DOMAIN_MAX_LAT, 56);
  assert.equal(CELL_DEG, 0.25);
  assert.equal(GRID_ROW_BASE, Math.round(DOMAIN_MIN_LAT / CELL_DEG));
  assert.equal(GRID_COL_BASE, Math.round(DOMAIN_MIN_LON / CELL_DEG));
  assert.equal(GRID_ROWS, Math.round((DOMAIN_MAX_LAT - DOMAIN_MIN_LAT) / CELL_DEG));
  assert.equal(
    GRID_COLUMNS,
    Math.round((GRID_MAX_LON - DOMAIN_MIN_LON) / CELL_DEG),
  );
  // 140 rows x 260 columns, measured off the archive: the western bound is the
  // first retained column (-125 / 0.25) and the grid runs east to -60.005.
  assert.equal(GRID_ROW_BASE, 84);
  assert.equal(GRID_COL_BASE, -500);
  assert.equal(GRID_ROWS, 140);
  assert.equal(GRID_COLUMNS, 260);
  assert.equal(GRID_CELL_COUNT, 36_400);
  // The reason the encoding is 16-bit at all. A stride derived from a full 360°
  // of longitude instead of the retained domain would be 1,440 columns, and
  // 140 x 1,440 = 201,600 does not fit a uint16.
  assert.ok(GRID_CELL_COUNT < 65_536, 'the index space fits a uint16');
});

test('a point exactly on each bound is in, a hair outside is out', () => {
  // Inclusive bounds, which is what the original inline `lon < -125 || lat < 21
  // || lat > 56` implied. Written as a table so a future bound change has to
  // change the table, not drift away from it.
  for (const [lon, lat, inside] of [
    [-125, 40, true],
    [-125.0001, 40, false],
    [-124.9999, 40, true],
    [-100, 21, true],
    [-100, 20.9999, false],
    [-100, 21.0001, true],
    [-100, 56, true],
    [-100, 56.0001, false],
    [-100, 55.9999, true],
  ]) {
    assert.equal(
      inDomain(lat, lon),
      inside,
      `lat=${lat} lon=${lon} ${inside ? 'is' : 'is not'} inside the domain`,
    );
  }
  assert.ok(inDomain(DOMAIN_MIN_LAT, DOMAIN_MIN_LON), 'the SW corner is in');
  assert.ok(inDomain(DOMAIN_MAX_LAT, GRID_MAX_LON - 0.01), 'the NE corner is in');
});

test('gridRow and gridCol are the arithmetic the accumulator keys on', () => {
  // Not a re-derivation of the same expression: the point is that the emitted
  // key and the 16-bit index space agree about which cell a point belongs to.
  assert.equal(gridRow(54.995), 219);
  assert.equal(gridRow(21), 84);
  assert.equal(gridCol(-129.995), -520, 'a point west of the bound still has a column');
  assert.equal(gridCol(-125), -500);
  assert.equal(gridCol(-60.005), -241);
  assert.equal(
    `${gridRow(39.995)}:${gridCol(-101.51)}`,
    '159:-407',
    'Denver lands on the cell the committed climatology uses',
  );
});

test('cellIndex is a bijection onto the retained space, corner to corner', () => {
  assert.equal(cellIndex(GRID_ROW_BASE, GRID_COL_BASE), 0);
  assert.equal(
    cellIndex(GRID_ROW_BASE + GRID_ROWS - 1, GRID_COL_BASE + GRID_COLUMNS - 1),
    GRID_CELL_COUNT - 1,
  );
  // The fixture the plan names: 2021-06-15 peaks at 56.2mm in 171:-406.
  const index = cellIndex(171, -406);
  assert.equal(index, (171 - GRID_ROW_BASE) * GRID_COLUMNS + (-406 - GRID_COL_BASE));
  assert.ok(index >= 0 && index <= 65_535);
  // No two cells in the space share an index, which is what "stored as a
  // uint16" depends on and what a wrong stride would break silently.
  const seen = new Set();
  for (let i = GRID_ROW_BASE; i < GRID_ROW_BASE + GRID_ROWS; i += 1) {
    for (let j = GRID_COL_BASE; j < GRID_COL_BASE + GRID_COLUMNS; j += 1) {
      const index = cellIndex(i, j);
      assert.ok(index >= 0 && index < GRID_CELL_COUNT, `${i}:${j} is in range`);
      assert.ok(!seen.has(index), `${i}:${j} aliases an index already taken`);
      seen.add(index);
    }
  }
  assert.equal(seen.size, GRID_CELL_COUNT);
});

test('cellIndex refuses a cell outside the space instead of aliasing one inside', () => {
  // The failure this guards is silent: a wrapped or clamped index puts hail on
  // the map in the wrong cell and nothing downstream can tell. Risk #1 in the
  // plan is exactly this shape.
  assert.throws(() => cellIndex(GRID_ROW_BASE - 1, GRID_COL_BASE), RangeError);
  assert.throws(
    () => cellIndex(GRID_ROW_BASE + GRID_ROWS, GRID_COL_BASE),
    RangeError,
  );
  assert.throws(() => cellIndex(GRID_ROW_BASE, GRID_COL_BASE - 1), RangeError);
  assert.throws(
    () => cellIndex(GRID_ROW_BASE, GRID_COL_BASE + GRID_COLUMNS),
    RangeError,
  );
  assert.throws(
    () => cellIndex(0, 0),
    RangeError,
    'the grid origin is outside the retained domain',
  );
});

test(
  'every cell a real MRMS day produces is inside the retained index space',
  { skip: !meshCacheFile('20240615') ? 'no cached MRMS day on disk' : false },
  () => {
    // Through the real decoder rather than through the predicate: a bound that
    // moved by one unit would surface here as a cell `cellIndex` refuses, which
    // is the shape of the bug the plan calls the weakest link in the rebuild.
    //
    // 2024-06-15 is the day that touches both edges of the space, so it pins
    // both: at the retain floor the hail reaches the first retained column
    // (-125 / 0.25 = -500) and the last (-60.005 / 0.25 = -241). Loosen the
    // western bound and the space grows; tighten the eastern one and this cell
    // is outside it.
    const cellsByYear = new Map();
    ingestMeshGz(
      fsSync.readFileSync(meshCacheFile('20240615')),
      '20240615',
      cellsByYear,
      { retainMm: HAIL_RETAIN_MM },
    );
    const cells = cellsByYear.get(2024);
    assert.ok(cells.size > 0, 'the day produced cells');
    const columns = new Set();
    const rows = new Set();
    for (const cell of cells.values()) {
      assert.ok(inDomain((cell.i + 0.5) * CELL_DEG, (cell.j + 0.5) * CELL_DEG));
      assert.ok(cellIndex(cell.i, cell.j) >= 0);
      columns.add(cell.j);
      rows.add(cell.i);
    }
    assert.equal(Math.min(...columns), GRID_COL_BASE, 'hail reached -125');
    assert.equal(
      Math.max(...columns),
      GRID_COL_BASE + GRID_COLUMNS - 1,
      'hail reached the grid eastern edge, so the stride is exactly this wide',
    );
    // Latitude has slack: the grid stops at 54.995°N, three columns short of
    // the 56°N bound, so nothing has ever exercised the northern edge.
    assert.equal(Math.max(...rows), 219, 'the grid tops out here, not at 56°N');
  },
);

test(
  'the retain floor reaches cells the core floor discards, and moves nothing else',
  { skip: !meshCacheFile('20240615') ? 'no cached MRMS day on disk' : false },
  () => {
    // The invariant the two-threshold split exists to protect: the per-day
    // artifact sees an order of magnitude more, and the published climatology
    // sees exactly what it saw before. Not a re-statement of the thresholds —
    // this drives the real decoder twice and compares the two accumulators.
    const core = new Map();
    ingestMeshGz(fsSync.readFileSync(meshCacheFile('20240615')), '20240615', core);
    const retained = new Map();
    ingestMeshGz(
      fsSync.readFileSync(meshCacheFile('20240615')),
      '20240615',
      retained,
      { retainMm: HAIL_RETAIN_MM },
    );
    const coreCells = core.get(2024);
    const retainedCells = retained.get(2024);
    assert.ok(
      retainedCells.size > coreCells.size * 5,
      'the lower floor reaches an order of magnitude more cells',
    );
    for (const [key, cell] of coreCells) {
      assert.equal(
        retainedCells.get(key)?.maxMm,
        cell.maxMm,
        `cell ${key} keeps its peak under the lower floor`,
      );
      // `corePoints` is deliberately *not* invariant: it counts 1 km points at
      // or above the floor, so a lower floor counts more of them in the same
      // cell. What must not move is the peak, which is what the published
      // climatology reads.
      assert.ok(
        retainedCells.get(key).corePoints >= cell.corePoints,
        `cell ${key} counts at least as many points under a lower floor`,
      );
    }
    for (const [key, cell] of retainedCells) {
      if (coreCells.has(key)) continue;
      assert.ok(
        cell.maxMm >= HAIL_RETAIN_MM && cell.maxMm < 25,
        `cell ${key} is only reachable below the core floor`,
      );
    }
  },
);

test('cellFeature still emits exactly the eight properties consumers read', () => {
  const feat = cellFeature(171, -406, {
    mx: 56.2,
    cp: 3,
    dy: 2,
    y0: 2021,
    y1: 2021,
  });
  assert.deepEqual(Object.keys(feat.properties).sort(), [
    'cp',
    'd',
    'dy',
    'i',
    'j',
    'mx',
    'y0',
    'y1',
  ]);
  assert.deepEqual(feat.properties, {
    i: 171,
    j: -406,
    d: 0.25,
    mx: 56.2,
    cp: 3,
    dy: 2,
    y0: 2021,
    y1: 2021,
  });
});

// ---------------------------------------------------------------------------
// Per-day artifact
// ---------------------------------------------------------------------------

test('every field of the per-day encoding fits a uint16, and the writer says so', () => {
  // The scale is the load-bearing number: MESH peaks at 1,437.4 mm over the
  // archive, so `x 10` is 14,374 and fits, while `x 100` is 143,740 and wraps
  // silently into a plausible-looking wrong value.
  assert.equal(PER_DAY_MM_SCALE, 10);
  assert.ok(Math.round(1437.4 * PER_DAY_MM_SCALE) <= 65_535, 'the peak fits');
  assert.ok(Math.round(1437.4 * 100) > 65_535, 'the obvious scale would not');
  assert.equal(PER_DAY_RECORD_BYTES, 6);
  assert.ok(GRID_CELL_COUNT <= 65_535, 'the index space fits');
  // And the writer refuses rather than truncating, which is the only safe
  // answer: `Buffer.writeUInt16LE` does not throw past 65,535.
  assert.throws(
    () =>
      encodePerDayRecords([
        { cellIndex: 0, dayIndex: 0, maxMm: 6553.6 },
      ]),
    RangeError,
  );
  assert.throws(
    () => encodePerDayRecords([{ cellIndex: 70_000, dayIndex: 0, maxMm: 25 }]),
    RangeError,
  );
  assert.throws(
    () =>
      encodePerDayRecords([
        { cellIndex: 0, dayIndex: 70_000, maxMm: 25 },
      ]),
    RangeError,
  );
});

test('dayIndex counts from the archive start, not from the window start', () => {
  assert.equal(DAY_INDEX_EPOCH, '2021-01-01');
  assert.equal(dayIndex('20210101'), 0, 'day zero is the epoch itself');
  assert.equal(dayIndex('20210102'), 1);
  assert.equal(dayIndex('20210615'), 165, 'the 2021-06-15 fixture day');
  assert.equal(dayIndex('20241015'), 1383);
  assert.equal(dayIndex('20261015'), 2113, 'the end of the committed window');
  // The epoch is fixed to the archive, so extending the window end does not
  // move an earlier day's index. That is the whole reason it is not the window
  // start: a moving epoch re-dates the whole artifact on the next rebuild.
  const wide = [dayIndex('20210101'), dayIndex('20261015')];
  const narrow = [dayIndex('20210101'), dayIndex('20260801')];
  assert.equal(wide[0], narrow[0], 'the same day keeps the same index');
});

test('records round-trip through the binary encoding unchanged', () => {
  const records = [
    { cellIndex: 0, dayIndex: 0, maxMm: 10 },
    { cellIndex: GRID_CELL_COUNT - 1, dayIndex: 2124, maxMm: 1437.4 },
    { cellIndex: cellIndex(171, -406), dayIndex: 165, maxMm: 56.2 },
  ];
  const decoded = decodePerDayRecords(encodePerDayRecords(records));
  assert.equal(decoded.length, records.length);
  assert.deepEqual(
    decoded.map((r) => r.cellIndex),
    [0, GRID_CELL_COUNT - 1, cellIndex(171, -406)].sort((a, b) => a - b),
    'records come back sorted by (dayIndex, cellIndex)',
  );
  for (const record of decoded) {
    const original = records.find(
      (r) =>
        r.cellIndex === record.cellIndex && r.dayIndex === record.dayIndex,
    );
    // Millimetres survive to the tenth, which is the precision the scale buys.
    assert.ok(Math.abs(original.maxMm - record.maxMm) <= 0.05);
  }
  assert.throws(
    () => decodePerDayRecords(Buffer.alloc(7)),
    RangeError,
    'a partial record is refused rather than read as a short one',
  );
});

test('the per-day payload is byte-identical whatever order records arrive in', () => {
  // Records come out of the accumulator in download-completion order under
  // `pooled()`, so without the sort two runs over the same window would produce
  // different bytes for identical data.
  const records = [
    { cellIndex: 300, dayIndex: 165, maxMm: 44.1 },
    { cellIndex: 12, dayIndex: 165, maxMm: 30.2 },
    { cellIndex: 900, dayIndex: 20, maxMm: 12.3 },
    { cellIndex: 5, dayIndex: 900, maxMm: 88.8 },
  ];
  const shuffled = [records[3], records[1], records[0], records[2]];
  assert.ok(encodePerDayRecords(shuffled).equals(encodePerDayRecords(records)));
});

test('a per-day write is gzipped, atomic, and reproducible on disk', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-per-day-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const records = [
    { cellIndex: 1, dayIndex: 2, maxMm: 33.3 },
    { cellIndex: 4, dayIndex: 2, maxMm: 51.1 },
  ];
  const file = path.join(dir, 'storm_radar_hail_perday.bin.gz');
  const first = await writePerDayBin(file, records);
  const bytes = await fs.readFile(file);
  assert.equal(bytes[0], 0x1f, 'gzip magic');
  assert.equal(bytes[1], 0x8b);
  // No mtime in the header: two writes of the same records are identical bytes.
  await writePerDayBin(file, records);
  assert.ok((await fs.readFile(file)).equals(bytes), 'byte-identical on rewrite');
  assert.equal(first, bytes.length);
  assert.deepEqual(await fs.readdir(dir), ['storm_radar_hail_perday.bin.gz']);
  assert.deepEqual(
    decodePerDayRecords(zlib.gunzipSync(bytes)).length,
    2,
    'it decodes back to what went in',
  );
});

test('per-day records respect the kept-cell set', () => {
  const kept = new Set(['171:-406', '84:-500']);
  const perDay = new Map([
    ['171:-406', new Map([['20210615', 56.2]])],
    ['84:-500', new Map([['20210615', 12.1], ['20210616', 30.4]])],
    ['219:-241', new Map([['20210615', 99.9]])],
  ]);
  const records = perDayRecords(perDay, kept);
  assert.equal(records.length, 3, 'the dropped cell contributes nothing');
  assert.ok(
    !records.some((r) => r.cellIndex === cellIndex(219, -241)),
    'a cell MAX_CELLS dropped is not in the day records either',
  );
  assert.deepEqual(
    records.map((r) => r.dayIndex),
    [165, 165, 166],
    'every cell-day of every kept cell is present',
  );
});

test(
  'the per-day accumulator sees sub-core cells the published climatology drops',
  { skip: !meshCacheFile('20240615') ? 'no cached MRMS day on disk' : false },
  () => {
    // The split, through the real decoder. The published bucket must not gain a
    // single cell: a 12 mm cell has no business in a file whose threshold is
    // 25 mm, and the whole invariant of the change is that those files stay
    // byte-identical.
    const cellsByYear = new Map();
    const perDay = new Map();
    ingestMeshGz(
      fsSync.readFileSync(meshCacheFile('20240615')),
      '20240615',
      cellsByYear,
      { perDay },
    );
    const published = cellsByYear.get(2024);
    const publishedKeys = new Set([...published.keys()]);
    let subCoreOnly = 0;
    for (const days of perDay.values()) {
      const peak = Math.max(...days.values());
      if (peak >= 25) continue;
      subCoreOnly += 1;
      assert.ok(peak >= HAIL_RETAIN_MM, 'retained from 10 mm, not from nothing');
      const key = [...perDay.keys()].find((k) => perDay.get(k) === days);
      assert.ok(
        !publishedKeys.has(key),
        `sub-core cell ${key} is in the day records and not in the climatology`,
      );
    }
    assert.ok(
      subCoreOnly > 1000,
      `the day has sub-core cells worth publishing (${subCoreOnly})`,
    );
    // Where the two accumulators overlap they must agree exactly: one day
    // ingested, so a published cell's lifetime peak is that day's peak.
    let checked = 0;
    for (const [key, cell] of published) {
      const day = perDay.get(key);
      assert.ok(day, `published cell ${key} has a day record`);
      assert.equal(day.get('20240615'), cell.maxMm, `cell ${key} agrees on its peak`);
      checked += 1;
    }
    assert.ok(
      checked > 200,
      `checked ${checked} overlapping cells`,
    );
  },
);

test('the per-day sidecar states the epoch, the scale and the geometry', () => {
  const meta = perDayMeta({
    builtAt: '2026-10-16T00:00:00.000Z',
    window: { from: '2021-01-01', to: '2026-10-15', days: 2125 },
    unavailableDays: [],
    recordCount: 253016,
    cellCount: 21947,
    truncated: false,
    cellsBeforeTruncation: 21947,
  });
  assert.equal(meta.dayIndexEpoch, DAY_INDEX_EPOCH);
  assert.equal(meta.format.mmScale, PER_DAY_MM_SCALE);
  assert.equal(meta.format.recordBytes, PER_DAY_RECORD_BYTES);
  assert.equal(meta.geometry.columns, GRID_COLUMNS);
  assert.equal(meta.geometry.rowBase, GRID_ROW_BASE);
  assert.equal(meta.hailRetainThresholdMm, HAIL_RETAIN_MM);
  assert.equal(meta.hailCoreThresholdMm, 25);
  assert.equal(meta.recordCount, 253016);
  assert.equal(meta.window.to, '2026-10-15');
  // The seven published sidecars must not grow a day-index field they cannot
  // honour, which is why this is a separate shape.
  assert.equal(radarMeta({
    builtAt: 'x',
    window: { from: '2021-01-01', to: '2026-10-15', days: 2125 },
    unavailableDays: [],
    cellCount: 1,
    corePointCount: 1,
    truncated: false,
    cellsBeforeTruncation: 1,
  }).dayIndexEpoch, undefined);
});

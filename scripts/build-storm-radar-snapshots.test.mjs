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
  CELL_DEG_FINE,
  cellFeature,
  cellIndex,
  cellIndexFine,
  cellIJFine,
  compareBySeverity,
  DAY_INDEX_EPOCH,
  dayFromIndex,
  dayIndex,
  decodeFineDayRecords,
  decodePerDayRecords,
  DOMAIN_MAX_LAT,
  DOMAIN_MIN_LAT,
  DOMAIN_MIN_LON,
  encodeFineDayRecords,
  encodePerDayRecords,
  featuresByYear,
  GRID_CELL_COUNT,
  GRID_CELL_COUNT_FINE,
  GRID_COLUMNS,
  GRID_COLUMNS_FINE,
  GRID_COL_BASE,
  GRID_COL_BASE_FINE,
  gridCol,
  GRID_MAX_LON,
  GRID_ROW_BASE,
  GRID_ROW_BASE_FINE,
  GRID_ROWS,
  GRID_ROWS_FINE,
  gridRow,
  HAIL_RETAIN_MM,
  HAIL_RETAIN_MM_FINE,
  inDomain,
  ingestMeshGz,
  mergeYearFeatures,
  perDayMeta,
  perDayRecords,
  perDayRecordsByYear,
  fineDayFileName,
  fineDayMeta,
  FINE_DAY_HEADER_BYTES,
  FINE_DAY_RECORD_BYTES,
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
  assert.equal(DAY_INDEX_EPOCH, '2020-10-14');
  assert.equal(dayIndex('20201014'), 0, 'day zero is the epoch itself');
  assert.equal(dayIndex('20201015'), 1);
  assert.equal(dayIndex('20210101'), 79, 'the 2021-01-01 day');
  assert.equal(dayIndex('20210615'), 244, 'the 2021-06-15 fixture day');
  assert.equal(dayIndex('20241015'), 1462);
  assert.equal(dayIndex('20261015'), 2192, 'the end of the committed window');
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
    [dayIndex('20210615'), dayIndex('20210615'), dayIndex('20210616')],
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
    window: { from: '2020-10-14', to: '2026-10-15', days: 2193 },
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
    window: { from: '2020-10-14', to: '2026-10-15', days: 2193 },
    unavailableDays: [],
    cellCount: 1,
    corePointCount: 1,
    truncated: false,
    cellsBeforeTruncation: 1,
  }).dayIndexEpoch, undefined);
});

test('per-day records shard by the calendar year of their day', () => {
  const records = [
    { cellIndex: 1, dayIndex: dayIndex('20211231'), maxMm: 20 },
    { cellIndex: 2, dayIndex: dayIndex('20220101'), maxMm: 30 },
    { cellIndex: 3, dayIndex: dayIndex('20260615'), maxMm: 40 },
  ];
  const byYear = perDayRecordsByYear(records);
  assert.deepEqual([...byYear.keys()], [2021, 2022, 2026], 'ascending by year');
  // The boundary matters: 31 December and 1 January are one index apart and a
  // year apart, so a sharding bug here would move a record across the year
  // boundary and mis-date it in the file that is supposed to hold one year.
  assert.equal(byYear.get(2021).length, 1);
  assert.equal(byYear.get(2021)[0].dayIndex, dayIndex('20211231'));
  assert.equal(byYear.get(2022)[0].dayIndex, dayIndex('20220101'));
  // And the year round-trips through the epoch both ways.
  for (const [year, list] of byYear) {
    for (const record of list) {
      assert.equal(Number(dayFromIndex(record.dayIndex).slice(0, 4)), year);
    }
  }
});

test('a day index round-trips through its epoch', () => {
  for (const ymd of ['20210101', '20211231', '20220101', '20240229', '20261015']) {
    assert.equal(dayFromIndex(dayIndex(ymd)), ymd);
  }
  assert.equal(dayFromIndex(0), '20201014', 'day zero is the epoch');
  assert.throws(
    () => dayFromIndex(70_000),
    RangeError,
    'an index past the uint16 range is refused rather than dated',
  );
});


// ===========================================================================
// The fine grid. The source has always been 1 km; the published field is a 25x
// downsample of it, and these pin the sibling that undoes that.
// ===========================================================================

test('the fine grid is 1 km and 25x finer than the published one', () => {
  assert.equal(CELL_DEG_FINE, 0.01, 'one hundredth of a degree');
  assert.equal(CELL_DEG / CELL_DEG_FINE, 25, 'and a 25x downsample per axis');
  // Measured off a cached day: ni=7000, nj=3500 over -129.995..-60.005 and
  // 54.995..20.005. These must match or the fine grid is not this archive's.
  assert.equal(GRID_COLUMNS_FINE, 6500, 'columns across the retained domain');
  assert.equal(GRID_ROWS_FINE, 3500, 'rows across the retained domain');
});

test('the fine bases are pinned to absolute geography, not to each other', () => {
  // Written after a real miss: expressing every fine-grid test in terms of the
  // fine constants means they are all self-consistent even when the constants
  // are wrong. Setting GRID_ROW_BASE_FINE to DOMAIN_MAX_LAT/CELL_DEG_FINE — a
  // transposed base, the most likely mistake here — left all 38 tests passing.
  // These are absolute values, so they fail.
  assert.equal(GRID_ROW_BASE_FINE, 2100, '21N / 0.01 = row 2100');
  assert.equal(GRID_COL_BASE_FINE, -12500, '-125 / 0.01 = column -12500');
  assert.equal(
    GRID_ROW_BASE_FINE,
    Math.round(DOMAIN_MIN_LAT / CELL_DEG_FINE),
    'and the south edge is the minimum latitude, not the maximum',
  );
  assert.equal(
    GRID_COL_BASE_FINE,
    Math.round(DOMAIN_MIN_LON / CELL_DEG_FINE),
    'west edge from the minimum longitude',
  );
});

test('a known Colorado cell resolves to its absolute index and back', () => {
  // 39.625N, 104.875W — the densest measured-hail cell of 2026-06-01 (Denver /
  // Arapahoe, eight reported stones). An end-to-end pin from real coordinates
  // through the real function, so no constant can drift without this noticing.
  //
  // Note the column: Math.floor(-104.875 / 0.01) is -10488, NOT -10487. Floor
  // on a negative longitude rounds toward minus infinity, so this point sits in
  // the cell spanning -104.88..-104.87. The builder's own `gridCol` floors the
  // same way, which is what keeps the two grids in agreement; a `Math.round`
  // anywhere would shift every western cell by one.
  const i = Math.floor(39.625 / CELL_DEG_FINE); // 3962
  const j = Math.floor(-104.875 / CELL_DEG_FINE); // -10488
  assert.equal(i, 3962);
  assert.equal(j, -10488, 'floor, not round — the western cells hang off -1');
  const index = cellIndexFine(i, j);
  assert.equal(index, 1862 * GRID_COLUMNS_FINE + 2012);
  assert.deepEqual(
    cellIJFine(index),
    { i: 3962, j: -10488 },
    'and decodes back to the same real cell',
  );
  // The same coordinate on the coarse grid is a different index space, which is
  // the collision documented in the sibling test.
  assert.notEqual(cellIndex(Math.floor(39.625 / CELL_DEG), Math.floor(-104.875 / CELL_DEG)), index);
});

test('the fine index space does not fit a uint16, which is why it is uint32', () => {
  // The load-bearing fact, asserted rather than trusted. `writeUInt16LE`
  // truncates silently past 65,535, which at this size would alias tens of
  // thousands of cells onto each other and shift hail across the map with no
  // error anywhere downstream.
  assert.equal(GRID_CELL_COUNT_FINE, 22_750_000);
  assert.ok(
    GRID_CELL_COUNT_FINE > 0xffff,
    'the fine space exceeds uint16, so a 16-bit index is a silent-corruption bug',
  );
  assert.ok(
    GRID_CELL_COUNT_FINE <= 0xffffffff,
    'and it does fit uint32, which is what the encoder writes',
  );
  // The coarse space is what made uint16 viable in the first place.
  assert.ok(
    GRID_CELL_COUNT <= 0xffff,
    'the coarse space still fits, so the published artifacts are untouched',
  );
});

test('the fine index round-trips at both ends of the space', () => {
  const origin = { i: GRID_ROW_BASE_FINE, j: GRID_COL_BASE_FINE };
  assert.equal(cellIndexFine(origin.i, origin.j), 0, 'the origin is index 0');
  const back = cellIJFine(0);
  assert.deepEqual(back, origin, 'and decodes back to the same cell');

  const last = GRID_CELL_COUNT_FINE - 1;
  const lastIJ = cellIJFine(last);
  assert.equal(
    cellIndexFine(lastIJ.i, lastIJ.j),
    last,
    'the last index round-trips too',
  );
  assert.equal(
    lastIJ.i,
    GRID_ROW_BASE_FINE + GRID_ROWS_FINE - 1,
    'at the final row',
  );
  assert.equal(
    lastIJ.j,
    GRID_COL_BASE_FINE + GRID_COLUMNS_FINE - 1,
    'and the final column',
  );
});

test('the fine index refuses every cell outside the retained space', () => {
  const base = { i: GRID_ROW_BASE_FINE, j: GRID_COL_BASE_FINE };
  // One row/col past each edge, in both directions. The function refuses rather
  // than degrading because an aliased index misplaces hail with no later error.
  assert.throws(() => cellIndexFine(base.i - 1, base.j), RangeError, 'north of');
  assert.throws(
    () => cellIndexFine(base.i + GRID_ROWS_FINE, base.j),
    RangeError,
    'south of',
  );
  assert.throws(() => cellIndexFine(base.i, base.j - 1), RangeError, 'west of');
  assert.throws(
    () => cellIndexFine(base.i, base.j + GRID_COLUMNS_FINE),
    RangeError,
    'east of',
  );
  // The last valid cell must NOT throw, or the bound is off by one.
  assert.doesNotThrow(() =>
    cellIndexFine(
      base.i + GRID_ROWS_FINE - 1,
      base.j + GRID_COLUMNS_FINE - 1,
    ),
  );
});

test('the fine inverse refuses an index outside the space', () => {
  assert.throws(() => cellIJFine(-1), RangeError, 'negative');
  assert.throws(() => cellIJFine(GRID_CELL_COUNT_FINE), RangeError, 'past the end');
  assert.throws(() => cellIJFine(1.5), RangeError, 'and a non-integer');
  assert.doesNotThrow(() => cellIJFine(GRID_CELL_COUNT_FINE - 1), 'the last one');
});

test('the fine and coarse index spaces genuinely collide, which is the hazard', () => {
  // Both spaces start at index 0 — that is what "origin" means in each — so a
  // payload decoded with the wrong grid does NOT throw. It returns plausible
  // numbers for the wrong places. This is why the fine path is a sibling
  // function and a sibling cache rather than a parameterised one, and why this
  // test documents the collision instead of pretending it away.
  assert.equal(
    cellIndex(GRID_ROW_BASE, GRID_COL_BASE),
    0,
    'the coarse origin is index 0',
  );
  assert.equal(
    cellIndexFine(GRID_ROW_BASE_FINE, GRID_COL_BASE_FINE),
    0,
    'and so is the fine origin',
  );

  // The collision is real: one stored index, two completely different cells.
  // Index 1 is the cell immediately east of the origin in each grid, and those
  // are 25 fine cells apart in longitude.
  const coarseIJ = (index) => ({
    i: Math.floor(index / GRID_COLUMNS) + GRID_ROW_BASE,
    j: (index % GRID_COLUMNS) + GRID_COL_BASE,
  });
  const fineIJ = cellIJFine(1);
  const coarseIJ1 = coarseIJ(1);
  assert.equal(coarseIJ1.j - GRID_COL_BASE, 1, 'coarse: one 0.25-degree column');
  assert.equal(fineIJ.j - GRID_COL_BASE_FINE, 1, 'fine: one 0.01-degree column');
  assert.equal(
    (coarseIJ1.j - GRID_COL_BASE) * CELL_DEG,
    0.25,
    'so the same index means a different longitude in each grid',
  );
  assert.equal(
    (fineIJ.j - GRID_COL_BASE_FINE) * CELL_DEG_FINE,
    0.01,
    '25x apart — decoding with the wrong grid misplaces hail without error',
  );
});

test('the fine retain floor is a severity threshold, not a round number', () => {
  // 19 mm is three-quarters of an inch: the NWS severe threshold and the lowest
  // band the category draws. It replaces 10 mm only for the FINE field, and the
  // measured trade is why: 245 MB -> 28 MB across the window, and 3,065 -> 979
  // mean rings per day.
  assert.equal(HAIL_RETAIN_MM_FINE, 19);
  assert.ok(
    HAIL_RETAIN_MM_FINE > HAIL_RETAIN_MM,
    'the fine floor is higher than the coarse one',
  );
  // It must not have changed the coarse floor, which is a published artifact.
  assert.equal(HAIL_RETAIN_MM, 10, 'the published per-day floor is untouched');
});


// ===========================================================================
// The fine family's own contract. GATE A — the coarse artifacts must come out
// byte-identical — is what these protect, and it is asserted rather than trusted
// because it was violated once during development.
// ===========================================================================

test('a fine day shard round-trips exactly and sorts by cell', () => {
  const cells = [
    { i: 5599, j: -6001, maxMm: 127.4 },
    { i: 2100, j: -12500, maxMm: 19 },
    { i: 3962, j: -10488, maxMm: 38.5 },
  ];
  const buffer = encodeFineDayRecords('20260601', cells);
  assert.equal(
    buffer.length,
    FINE_DAY_HEADER_BYTES + cells.length * FINE_DAY_RECORD_BYTES,
    'a magic header, then six bytes per cell — the day index is in the',
  );
  assert.equal(
    buffer.subarray(0, 4).toString('latin1'),
    'FINE',
    'and the magic, which is what tells the two six-byte families apart',
  );
  const back = decodeFineDayRecords(new Uint8Array(buffer));
  // Order is by cellIndex, so a consumer walks them geographically.
  assert.deepEqual(
    back.map((c) => `${c.i}:${c.j}`),
    ['2100:-12500', '3962:-10488', '5599:-6001'],
  );
  const key = (c) => `${c.i}:${c.j}:${c.maxMm}`;
  assert.deepEqual(
    back.map(key).sort(),
    cells.map(key).sort(),
    'and every value survives the round trip',
  );
});

test('a truncated fine payload is refused, which is what rejects an SPA shell', () => {
  const buffer = encodeFineDayRecords('20260601', [{ i: 2100, j: -12500, maxMm: 19 }]);
  assert.throws(
    () =>
      decodeFineDayRecords(
        new Uint8Array(buffer.subarray(0, buffer.length - 2)),
      ),
    RangeError,
    'a length that is not a whole number of records is a refusal, not garbage',
  );
  assert.throws(
    () => decodeFineDayRecords(buffer.subarray(0, FINE_DAY_HEADER_BYTES + 2)),
    RangeError,
    'and so is a payload with the magic but no whole record after it',
  );
  assert.throws(
    () =>
      decodeFineDayRecords(
        new Uint8Array(Buffer.concat([Buffer.from('COAR'), buffer.subarray(4)])),
      ),
    RangeError,
    'a coarse shard is refused by the magic',
  );
  assert.deepEqual(
    decodeFineDayRecords(new Uint8Array(buffer)).length,
    1,
    'while the whole thing decodes',
  );
});

test('the fine encoder refuses values it cannot represent', () => {
  assert.throws(
    () => encodeFineDayRecords('20260601', [{ i: 2100, j: -12500, maxMm: 9000 }]),
    RangeError,
    'millimetres that overflow uint16 at scale 10',
  );
  assert.throws(
    () => encodeFineDayRecords('20260601', [{ i: 999999, j: -12500, maxMm: 19 }]),
    RangeError,
    'a cell outside the fine space',
  );
});

test('a fine shard filename carries its day, and the round trip agrees', () => {
  assert.equal(
    fineDayFileName('20260601'),
    'storm_radar_hail_fine_2026-06-01.bin.gz',
  );
  assert.match(fineDayFileName('20240101'), /_2024-01-01\.bin\.gz$/);
});

test('the fine manifest records the geometry, the floor, and every day', () => {
  const days = ['20260601', '20260602'];
  const meta = fineDayMeta({
    builtAt: '2026-10-17T00:00:00.000Z',
    window: { from: '2026-06-01', to: '2026-06-02', days: 2, retentionYears: 3 },
    unavailableDays: [],
    days,
    recordCount: 2,
    cellCount: 2,
    bytes: 40,
  });
  // The geometry is the part a consumer cannot guess, so it is pinned here and
  // in the loader test that reads it back.
  assert.equal(meta.geometry.gridDeg, 0.01);
  assert.equal(meta.geometry.cellCount, GRID_CELL_COUNT_FINE);
  assert.equal(meta.geometry.rowBase, 2100);
  assert.equal(meta.geometry.colBase, -12500);
  assert.equal(meta.retainMm, 19);
  assert.equal(meta.dayIndexEpoch, '2020-10-14');
  assert.equal(meta.encoding.cellIndexBits, 32, 'and the index width is declared');
  assert.equal(meta.encoding.bytesPerRecord, FINE_DAY_RECORD_BYTES);
  assert.equal(meta.encoding.dayIndexInFilename, true);
  assert.deepEqual(meta.days, days, 'every published day is listed');
  assert.equal(meta.dayCount, 2);
  assert.equal(meta.recordCount, 2);
});


test('--fine-only skips the coarse artifacts and still writes the fine ones', async () => {
  // The bug this pins: the fine emission was briefly left INSIDE the coarse
  // `else` branch, so `--fine-only` skipped the fine shards as well. The build
  // reported success, printed nothing about fine output, and left the previous
  // day's shards on disk untouched. Two rebuilds "passed" with stale data before
  // it was caught by checking a file's mtime — nothing failed, which is the
  // whole problem with a flag that only turns things OFF.
  //
  // Asserted on the source structure rather than by running the 400-second
  // build: the guard must close before the fine emission begins.
  const source = fsSync.readFileSync(
    new URL('./build-storm-radar-snapshots.mjs', import.meta.url),
    'utf8',
  );
  const guard = source.indexOf('end the coarse-only guard');
  const fine = source.indexOf('const fineOutDir');
  assert.ok(guard > 0, 'the coarse guard is closed explicitly');
  assert.ok(
    fine > guard,
    'and the fine emission comes AFTER it, not inside the coarse branch',
  );
  // The reverse is the bug: a fine emission before the guard close would mean
  // --fine-only never runs.
  assert.ok(
    source.indexOf('Wrote ${emittedFine.length') > guard,
    'and the fine summary line is outside too',
  );
});

test('a built fine shard round-trips through the runtime decoder', async () => {
  // Builder and runtime must agree on the format, or every shard is garbage in
  // the app while the builder's own tests pass.
  const runtime = await import('../src/data/stormReports.js');
  const cells = [
    { i: 2100, j: -12500, maxMm: 19 },
    { i: 3962, j: -10488, maxMm: 38.5 },
  ];
  const bytes = new Uint8Array(encodeFineDayRecords('20260601', cells));
  // Compared as bytes, not via toString('latin1'): that is a Buffer method and
  // a Uint8Array's takes no argument, so it silently joins the numbers instead
  // and the assertion reads '70,73,78,69'.
  assert.deepEqual(
    [...bytes.subarray(0, 4)],
    [0x46, 0x49, 0x4e, 0x45],
    'FINE, byte for byte',
  );
  const out = runtime.indexFineDay(bytes);
  assert.equal(out.count, cells.length, 'and the runtime decodes it');
  assert.deepEqual(
    out.cells.map((c) => `${c.i}:${c.j}:${c.maxMm}`).sort(),
    cells.map((c) => `${c.i}:${c.j}:${c.maxMm}`).sort(),
  );
});

/* ======================================================================
 * The storage floors stay BELOW the product floor.
 *
 * The product draws from one inch (25.4 mm). The artifacts deliberately keep
 * everything down to 19 mm fine and 10 mm coarse, so sub-inch hail survives on
 * disk and can be re-thresholded the moment anyone asks a different question.
 *
 * This test exists because raising a retention floor is a one-line change that
 * deletes measured radar, is easy to justify in a commit message ("align with
 * product"), and is very hard to notice afterwards. Somebody will try. This is
 * the thing that stops them.
 * ====================================================================== */

test('the storage floors stay under the product floor', () => {
  const PRODUCT_FLOOR_MM = 25.4;
  assert.ok(
    HAIL_RETAIN_MM_FINE < PRODUCT_FLOOR_MM,
    `fine storage floor ${HAIL_RETAIN_MM_FINE} mm must stay below the product's ${PRODUCT_FLOOR_MM} mm, or sub-inch hail is being deleted`,
  );
  assert.ok(
    HAIL_RETAIN_MM < PRODUCT_FLOOR_MM,
    `coarse storage floor ${HAIL_RETAIN_MM} mm must stay below the product's ${PRODUCT_FLOOR_MM} mm`,
  );
});

test('the shipped fine shards really do contain sub-inch cells', async () => {
  // A constant asserting the floor is low proves nothing about the bytes. This
  // reads actual shipped artifacts and checks the sub-inch data is really there
  // - which is the whole claim the floor test above protects.
  const dir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'data',
    'local_data',
    'storm',
  );
  const files = (await fs.readdir(dir)).filter((name) =>
    /^storm_radar_hail_fine_.*\.bin\.gz$/.test(name),
  );
  assert.ok(files.length > 0, 'there are fine shards to check');

  const samples = [files[0], files[Math.floor(files.length / 2)], files.at(-1)];
  let sawSubInch = 0;
  for (const name of samples) {
    const buf = zlib.gunzipSync(
      await fs.readFile(path.join(dir, name)),
    );
    assert.equal(
      buf.slice(0, 4).toString('latin1'),
      'FINE',
      `${name} carries the fine magic`,
    );
    // 4-byte magic, then 6-byte records, millimetres in tenths.
    const count = (buf.length - 4) / 6;
    for (let i = 0; i < count; i += 1) {
      const at = 4 + i * 6;
      const mm = buf.readUInt16LE(at + 4) / 10;
      if (mm >= 25.4) continue;
      if (mm > 0) {
        sawSubInch += 1;
        break;
      }
    }
  }
  assert.ok(
    sawSubInch > 0,
    'sub-inch readings are present in the shipped shards, so the product floor is a rendering choice and not a data loss',
  );
});

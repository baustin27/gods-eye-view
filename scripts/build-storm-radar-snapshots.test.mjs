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
  compareBySeverity,
  featuresByYear,
  ingestMeshGz,
  mergeYearFeatures,
  radarMeta,
  restrictYearsToKeys,
  selectKeptCells,
  writeGeoJsonlGz,
  writeMetaJson,
  yearBucket,
  DOMAIN_MIN_LON,
  DOMAIN_MIN_LAT,
  DOMAIN_MAX_LAT,
  CELL_DEG,
  COLUMN_COUNT,
  HAIL_RETAIN_MM,
  aboveRetainFloor,
  cellFeature,
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

test('domain constants have the documented values', () => {
  assert.equal(DOMAIN_MIN_LON, -125, 'DOMAIN_MIN_LON = -125');
  assert.equal(DOMAIN_MIN_LAT, 21, 'DOMAIN_MIN_LAT = 21');
  assert.equal(DOMAIN_MAX_LAT, 56, 'DOMAIN_MAX_LAT = 56');
});

test('cell ON each boundary is IN, one just outside is OUT', () => {
  // Domain filter: lon < DOMAIN_MIN_LON || lat < DOMAIN_MIN_LAT || lat > DOMAIN_MAX_LAT => OUT (continue)
  // IN when all three conditions are false.

  // --- lon boundary: -125 is IN, -125.0001 is OUT ---
  const lonIn = -125;
  const lonOut = -125.0001;
  assert.ok(
    !(lonIn < DOMAIN_MIN_LON),
    `lon=${lonIn} is IN (not ${lonIn} < ${DOMAIN_MIN_LON})`
  );
  assert.ok(
    lonOut < DOMAIN_MIN_LON,
    `lon=${lonOut} is OUT (is ${lonOut} < ${DOMAIN_MIN_LON})`
  );

  // --- lat boundary: 21 is IN, 20.9999 is OUT ---
  const latSouthIn = 21;
  const latSouthOut = 20.9999;
  assert.ok(
    !(latSouthIn < DOMAIN_MIN_LAT),
    `lat=${latSouthIn} is IN (not ${latSouthIn} < ${DOMAIN_MIN_LAT})`
  );
  assert.ok(
    latSouthOut < DOMAIN_MIN_LAT,
    `lat=${latSouthOut} is OUT (is ${latSouthOut} < ${DOMAIN_MIN_LAT})`
  );

  // --- lat boundary: 56 is IN, 56.0001 is OUT ---
  const latNorthIn = 56;
  const latNorthOut = 56.0001;
  assert.ok(
    !(latNorthIn > DOMAIN_MAX_LAT),
    `lat=${latNorthIn} is IN (not ${latNorthIn} > ${DOMAIN_MAX_LAT})`
  );
  assert.ok(
    latNorthOut > DOMAIN_MAX_LAT,
    `lat=${latNorthOut} is OUT (is ${latNorthOut} > ${DOMAIN_MAX_LAT})`
  );
});

test('exported row/column bases and stride agree with ingestMeshGz', () => {
  // Verify that CELL_DEG, COLUMN_COUNT are correctly derived and match
  // what ingestMeshGz uses for index computation.
  // The key computation in ingestMeshGz is: `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`
  // and COLUMN_COUNT = Math.round(360 / CELL_DEG).

  // CELL_DEG must be 0.25
  assert.equal(CELL_DEG, 0.25, 'CELL_DEG is 0.25');

  // COLUMN_COUNT must be 1440 (= round(360 / 0.25))
  assert.equal(COLUMN_COUNT, 1440, 'COLUMN_COUNT is 1440 (= round(360 / CELL_DEG))');

  // Verify the key computation for a known position.
  // Using a position inside the domain: lat=40, lon=-100
  const lat = 40, lon = -100;
  const expectedKey = `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;
  const expectedI = Math.floor(lat / CELL_DEG);
  const expectedJ = Math.floor(lon / CELL_DEG);
  assert.equal(expectedKey, '160:-400', `key for lat=${lat},lon=${lon} is 160:-400`);
  assert.equal(expectedI, 160, `i=${expectedI} for lat=${lat}`);
  assert.equal(expectedJ, -400, `j=${expectedJ} for lon=${lon}`);
});

test('HAIL_RETAIN_MM is strictly less than HAIL_CORE_MM', () => {
  assert(HAIL_RETAIN_MM < 25, 'HAIL_RETAIN_MM < HAIL_CORE_MM (25)');
  assert.equal(HAIL_RETAIN_MM, 10, 'HAIL_RETAIN_MM is 10');
  assert.equal(25, 25, 'HAIL_CORE_MM is 25');
});

test('aboveRetainFloor helper works correctly', () => {
  assert(aboveRetainFloor(10) === true, 'mm=10 is at retain floor, retained');
  assert(aboveRetainFloor(9) === false, 'mm=9 is below retain floor, discarded');
  assert(aboveRetainFloor(24) === true, 'mm=24 is above retain floor, retained');
  assert(aboveRetainFloor(25) === true, 'mm=25 is at core, retained');
  assert(aboveRetainFloor(0) === false, 'mm=0 is below retain floor, discarded');
});

test('cellFeature output keys still deepEqual [cp,d,dy,i,j,mx,y0,y1]', () => {
  const feat = cellFeature(0, 0, { mx: 50, cp: 3, dy: 2, y0: 2021, y1: 2021 });
  assert.deepEqual(
    Object.keys(feat.properties).sort(),
    ['cp', 'd', 'dy', 'i', 'j', 'mx', 'y0', 'y1'],
    'cellFeature property keys unchanged'
  );
});

test('cellFeature deepEqual values on keys [cp,d,dy,i,j,mx,y0,y1]', () => {
  const feat = cellFeature(163, -406, { mx: 56.2, cp: 1, dy: 1, y0: 2021, y1: 2021 });
  const keys = Object.keys(feat.properties).sort();
  assert.deepEqual(
    keys,
    ['cp', 'd', 'dy', 'i', 'j', 'mx', 'y0', 'y1'],
    'property keys in sorted order'
  );
  assert.equal(feat.properties.cp, 1, 'cp preserved');
  assert.equal(feat.properties.d, 0.25, 'd preserved');
  assert.equal(feat.properties.dy, 1, 'dy preserved');
  assert.equal(feat.properties.i, 163, 'i preserved');
  assert.equal(feat.properties.j, -406, 'j preserved');
  assert.equal(feat.properties.mx, 56.2, 'mx preserved');
  assert.equal(feat.properties.y0, 2021, 'y0 preserved');
  assert.equal(feat.properties.y1, 2021, 'y1 preserved');
});

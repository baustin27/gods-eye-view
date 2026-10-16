import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  MAGNITUDE_UNITS,
  clearStormReportCache,
  filterReports,
  indexRadarYear,
  loadRadarForYear,
  loadRadarForYears,
  rankStorms,
  stormDays,
  unpackReport,
} from './stormReports.js';
import {
  clearCache,
  eventsFor,
  eventsForYears,
} from '../layers/stormReports/source.js';

const HAIL = (date, size, lat = 35, lon = -97, over = {}) => [
  date,
  600,
  0,
  size,
  lat,
  lon,
  over.fips ?? '40027',
  over.state ?? 'OK',
  over.county || 'Cleveland',
  over.loss || 0,
  over.comment || '',
  'spc-bulk,ncei',
  over.trace ? 1 : 0,
  over.stormRef ?? -1,
];
const WIND = (date, size, over = {}) => [
  date,
  700,
  1,
  size,
  35,
  -97,
  over.fips ?? '40027',
  over.state || 'OK',
  '',
  over.loss || 0,
  '',
  'spc-bulk',
  0,
  over.stormRef ?? -1,
];

test('a packed row expands back to every field the UI needs', () => {
  const report = unpackReport(
    HAIL('2025-05-16', 1.75, 37.57, -84.3, {
      fips: '21021',
      state: 'KY',
      county: 'Fayette',
      loss: 5000,
      comment: 'quarter size hail',
    }),
  );
  assert.equal(report.date, '2025-05-16');
  assert.equal(report.minute, 600);
  assert.equal(report.hazard, 'hail');
  assert.equal(report.size, 1.75);
  assert.equal(report.lat, 37.57);
  assert.equal(report.countyFips, '21021');
  assert.equal(report.county, 'Fayette');
  assert.equal(report.loss, 5000);
  assert.equal(report.comment, 'quarter size hail');
  assert.deepEqual(report.sources, ['spc-bulk', 'ncei']);
  assert.equal(report.trace, false);
  assert.equal(
    report.stormRef,
    -1,
    'no storm, because this fixture names none',
  );
});

test('a packed row carries the ordinal of the storm it belongs to', () => {
  const report = unpackReport(HAIL('2025-05-16', 2, 35, -97, { stormRef: 7 }));
  assert.equal(report.stormRef, 7, 'the ordinal into the year events array');
});

test('filtering keeps the storm ordinal, so a filtered row is still traceable', () => {
  const rows = [
    HAIL('2025-05-16', 2, 35, -97, { stormRef: 3 }),
    HAIL('2025-05-16', 0.25, 35, -97, { stormRef: 4 }),
  ];
  const kept = filterReports(rows, { minSize: 1 });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].stormRef, 3);
});

test('a row packed before the ordinal existed reads as belonging to no storm', () => {
  const report = unpackReport(HAIL('2025-05-16', 2).slice(0, 13));
  assert.equal(report.stormRef, -1);
});

test('a degenerate magnitude stays absent rather than becoming zero inches of hail', () => {
  // The packer writes size 0 for "no usable magnitude", so unpacking cannot
  // recover a real 0.00in. That is the intended trade: a degenerate reading
  // reads as absent, and the trace flag carries the fact that a storm was
  // there at all.
  const report = unpackReport(HAIL('2025-05-16', 0, 35, -97, { trace: true }));
  assert.equal(report.size, null);
  assert.equal(report.trace, true, 'the storm is still on the map');
});

test('an unknown time stays unknown rather than becoming midnight', () => {
  const report = unpackReport([...HAIL('2025-05-16', 2)]);
  report.minute = -1;
  assert.equal(
    unpackReport([...HAIL('2025-05-16', 2)].map((v, i) => (i === 1 ? -1 : v)))
      .minute,
    null,
  );
});

test('wind and hail carry different units so they cannot be read as each other', () => {
  assert.equal(MAGNITUDE_UNITS.hail, 'in');
  assert.equal(MAGNITUDE_UNITS.wind, 'kt');
  assert.equal(unpackReport(WIND('2025-05-16', 62)).hazard, 'wind');
  assert.equal(unpackReport(WIND('2025-05-16', 62)).size, 62);
});

test('filtering by size keeps everything at or above the bar and nothing below', () => {
  const rows = [
    HAIL('2025-05-16', 0.75),
    HAIL('2025-05-16', 1.0),
    HAIL('2025-05-16', 1.75),
    HAIL('2025-05-16', 2.5),
  ];
  const kept = filterReports(rows, { hazard: 'hail', minSize: 1.0 });
  assert.deepEqual(
    kept.map((r) => r.size),
    [1.0, 1.75, 2.5],
  );
  assert.equal(
    filterReports(rows, { minSize: 10 }).length,
    0,
    'a bar nothing clears is empty, not everything',
  );
});

test('a filter of no size returns every report, so the UI can loosen freely', () => {
  const rows = [HAIL('2025-05-16', 0.25), HAIL('2025-05-16', 3.0)];
  assert.equal(filterReports(rows, {}).length, 2);
  assert.equal(filterReports(rows, { hazard: 'hail' }).length, 2);
});

test('filtering by hazard separates hail from wind', () => {
  const rows = [HAIL('2025-05-16', 2), WIND('2025-05-16', 62)];
  assert.equal(filterReports(rows, { hazard: 'hail' }).length, 1);
  assert.equal(filterReports(rows, { hazard: 'wind' }).length, 1);
  assert.equal(filterReports(rows, { hazard: 'hail' })[0].hazard, 'hail');
});

test('a date range is inclusive at both ends', () => {
  const rows = [
    HAIL('2026-07-01', 2),
    HAIL('2026-07-15', 2),
    HAIL('2026-07-31', 2),
    HAIL('2026-08-01', 2),
  ];
  const kept = filterReports(rows, { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(kept.length, 3);
  assert.ok(!kept.some((r) => r.date === '2026-08-01'));
});

test('county and state filters work, and a report without a county is excluded', () => {
  const rows = [
    HAIL('2026-07-15', 2, 35, -97, { fips: '40027' }),
    HAIL('2026-07-15', 2, 35, -97, { fips: '40109' }),
    HAIL('2026-07-15', 2, 35, -97, { fips: '', state: 'OK' }),
  ];
  assert.equal(filterReports(rows, { countyFips: ['40027'] }).length, 1);
  assert.equal(
    filterReports(rows, { states: ['OK'] }).length,
    3,
    'all three are in Oklahoma, including the row with no county code',
  );
  assert.equal(
    filterReports(rows, { countyFips: ['40027', '40109'] }).length,
    2,
  );
  assert.equal(
    filterReports(rows, { countyFips: ['40027', '40109'], states: ['TX'] })
      .length,
    0,
    'the two filters combine',
  );
});

test('the storm-day list runs newest first and respects the range', () => {
  const index = {
    days: {
      '2026-06-28': { hail: 5, wind: 10, total: 15 },
      '2026-07-15': { hail: 100, wind: 200, total: 300 },
      '2026-08-10': { hail: 50, wind: 600, total: 650 },
    },
  };
  const all = stormDays(index);
  assert.deepEqual(
    all.map((d) => d.date),
    ['2026-08-10', '2026-07-15', '2026-06-28'],
  );
  assert.equal(stormDays(index, { from: '2026-07-01' }).length, 2);
  assert.equal(
    stormDays(index, { hazard: 'hail', minReports: 50 }).length,
    2,
    '100 and 50 clear 50',
  );
  assert.equal(
    stormDays(index, { hazard: 'wind', minReports: 200 }).length,
    2,
    '200 and 600 clear 200; the day with 10 does not',
  );
});

test('an empty or absent index yields no days rather than throwing', () => {
  assert.deepEqual(stormDays({ days: {} }), []);
  assert.deepEqual(stormDays({}), []);
});

test('storms rank by hail first, then wind', () => {
  const events = [
    { id: 'a', maxHailIn: 1.5, maxWindKt: 90 },
    { id: 'b', maxHailIn: 2.5, maxWindKt: 40 },
    { id: 'c', maxHailIn: null, maxWindKt: 80 },
    { id: 'd', maxHailIn: 2.5, maxWindKt: 70 },
  ];
  assert.deepEqual(
    rankStorms(events).map((e) => e.id),
    ['d', 'b', 'a', 'c'],
  );
  assert.deepEqual(
    rankStorms(events, { minHailIn: 2.5 }).map((e) => e.id),
    ['d', 'b'],
  );
  assert.deepEqual(
    rankStorms(events, { minWindKt: 75 }).map((e) => e.id),
    ['a', 'c'],
  );
});

test('ranking is capped so the UI never renders an unbounded list', () => {
  const events = Array.from({ length: 500 }, (_, i) => ({
    id: String(i),
    maxHailIn: i / 100,
  }));
  assert.equal(rankStorms(events, { limit: 10 }).length, 10);
});

test('clearing the cache leaves the module usable', () => {
  clearStormReportCache();
  assert.equal(filterReports([HAIL('2025-05-16', 2)], {}).length, 1);
});

/*
 * ── Radar, year-scoped ─────────────────────────────────────────────────────
 *
 * The radar snapshot is one gzipped file per year. These tests drive the real
 * loader through a stubbed `fetch`, because the two things that broke it before
 * are both about the bytes rather than the parsing: Vite rewriting the asset
 * URL, and the dev server inflating a `.gz` that the loader then tried to
 * inflate again.
 */

const RADAR_LINE = (i, j, over = {}) =>
  JSON.stringify({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-97.125, 35.125] },
    properties: {
      i,
      j,
      d: 0.25,
      mx: 41.2,
      cp: 12,
      dy: 3,
      y0: 2021,
      y1: 2021,
      ...over,
    },
  });

/**
 * Serve the named snapshot files and record every URL asked for.
 * @param {Record<string, {body: string, gzipped?: boolean, status?: number}>} files
 */
function stubFetch(files) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const file = String(url).split('/').pop();
    const entry = files[file];
    if (!entry) return new Response('not found', { status: 404 });
    const bytes =
      entry.gzipped && entry.body !== undefined
        ? gzipSync(Buffer.from(entry.body, 'utf8'))
        : Buffer.from(entry.body ?? '', 'utf8');
    return new Response(bytes, { status: entry.status ?? 200 });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = real;
    },
  };
}

/** Forget every memoised year so one test's fetch never satisfies another's. */
function resetYearCaches() {
  clearStormReportCache();
  clearCache();
}

test('a year of radar is read into the same i:j keys the cross-reference uses', () => {
  const cells = indexRadarYear(
    [
      RADAR_LINE(140, -388),
      RADAR_LINE(145, -319, { mx: 1225.6, cp: 365, dy: 4 }),
    ].join('\n'),
  );
  assert.equal(cells.size, 2);
  assert.deepEqual(cells.get('140:-388'), {
    mx: 41.2,
    cores: 12,
    days: 3,
    y0: 2021,
    y1: 2021,
  });
  assert.equal(cells.get('145:-319').mx, 1225.6, 'rounded off at the tenth');
});

test('the radar cell fields are named for what they hold, not what the wire says', () => {
  const cells = indexRadarYear(RADAR_LINE(1, 2, { mx: 55, cp: 7, dy: 5 }));
  const cell = cells.get('1:2');
  assert.equal(cell.cores, 7, 'cp is a core count');
  assert.equal(
    cell.days,
    5,
    "dy is this cell's own day count, not a payload maximum",
  );
});

test('a payload that will not parse yields no cells rather than throwing', () => {
  assert.equal(indexRadarYear('<!doctype html><html></html>').size, 0);
  assert.equal(indexRadarYear('').size, 0);
  assert.equal(indexRadarYear(undefined).size, 0);
});

test('one year of radar costs one fetch, and asking twice costs no more', async () => {
  resetYearCaches();
  const stub = stubFetch({
    'storm_radar_hail_2021.geojsonl.gz': {
      body: RADAR_LINE(140, -388),
    },
  });
  try {
    const first = await loadRadarForYear(2021);
    const second = await loadRadarForYear(2021);
    const concurrent = await Promise.all([
      loadRadarForYear('2021'),
      loadRadarForYear('2021'),
    ]);
    assert.equal(
      stub.calls.length,
      1,
      'one file, and the in-flight load is joined',
    );
    assert.equal(first, second, 'the same memoised map, not a re-parse');
    assert.equal(concurrent[0], first);
    assert.equal(first.size, 1);
  } finally {
    stub.restore();
    resetYearCaches();
  }
});

test('a second year is a second fetch, and the first year is not refetched', async () => {
  resetYearCaches();
  const stub = stubFetch({
    'storm_radar_hail_2021.geojsonl.gz': { body: RADAR_LINE(1, 1) },
    'storm_radar_hail_2026.geojsonl.gz': {
      body: [RADAR_LINE(2, 2), RADAR_LINE(3, 3)].join('\n'),
    },
  });
  try {
    await loadRadarForYear(2021);
    const merged = await loadRadarForYears([2021, 2026]);
    assert.equal(merged.size, 3);
    assert.deepEqual(stub.calls.map((u) => u.split('/').pop()).sort(), [
      'storm_radar_hail_2021.geojsonl.gz',
      'storm_radar_hail_2026.geojsonl.gz',
    ]);
  } finally {
    stub.restore();
    resetYearCaches();
  }
});

test('a year with no radar file degrades to an empty map instead of throwing', async () => {
  resetYearCaches();
  const stub = stubFetch({
    'storm_radar_hail_2021.geojsonl.gz': { body: RADAR_LINE(1, 1) },
    // 2027 is absent from the stub, so it answers 404.
  });
  try {
    const missing = await loadRadarForYear(2027);
    assert.equal(missing.size, 0);
    const merged = await loadRadarForYears([2021, 2027]);
    assert.equal(merged.size, 1, 'the year that exists still comes through');
  } finally {
    stub.restore();
    resetYearCaches();
  }
});

test('the dev server inflates the .gz for us, and the loader does not try again', async () => {
  resetYearCaches();
  // Served as opaque bytes: gzip magic present, so it must be inflated.
  const stub = stubFetch({
    'storm_radar_hail_2021.geojsonl.gz': {
      body: RADAR_LINE(9, 9),
      gzipped: true,
    },
  });
  try {
    const cells = await loadRadarForYear(2021);
    assert.equal(cells.size, 1, 'a still-compressed payload is inflated once');
    assert.ok(cells.has('9:9'));
  } finally {
    stub.restore();
    resetYearCaches();
  }
});

test('a file served already inflated is read as-is', async () => {
  resetYearCaches();
  // What the dev server actually sends: Content-Encoding handled by fetch, so
  // the bytes arrive plain and a second DecompressionStream pass would throw.
  const stub = stubFetch({
    'storm_radar_hail_2021.geojsonl.gz': { body: RADAR_LINE(8, 8) },
  });
  try {
    assert.equal((await loadRadarForYear(2021)).size, 1);
  } finally {
    stub.restore();
    resetYearCaches();
  }
});

test('merging years takes the worse peak and adds the counts', async () => {
  resetYearCaches();
  const stub = stubFetch({
    'storm_radar_hail_2021.geojsonl.gz': {
      body: RADAR_LINE(1, 1, { mx: 90, cp: 4, dy: 2, y0: 2021, y1: 2021 }),
    },
    'storm_radar_hail_2026.geojsonl.gz': {
      body: [
        RADAR_LINE(1, 1, { mx: 55, cp: 6, dy: 3, y0: 2026, y1: 2026 }),
        RADAR_LINE(2, 2, { mx: 30, cp: 1, dy: 1, y0: 2026, y1: 2026 }),
      ].join('\n'),
    },
  });
  try {
    const merged = await loadRadarForYears([2026, 2021]);
    assert.equal(merged.size, 2);
    assert.deepEqual(merged.get('1:1'), {
      mx: 90,
      cores: 10,
      days: 5,
      y0: 2021,
      y1: 2026,
    });
    assert.equal(
      merged.get('1:1').cores,
      10,
      'a cell in both years is counted twice, which is what a merged map means',
    );
  } finally {
    stub.restore();
    resetYearCaches();
  }
});

test('an empty year request is an empty map and no fetches', async () => {
  resetYearCaches();
  const stub = stubFetch({});
  try {
    assert.equal((await loadRadarForYears([])).size, 0);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    resetYearCaches();
  }
});

/*
 * ── Event ordinals ─────────────────────────────────────────────────────────
 *
 * `stormRef` is an ordinal into one year's events array, so a concatenated list
 * needs the year offsets before any ordinal means anything.
 */

const EVENTS = (year, count) =>
  JSON.stringify({
    events: Array.from({ length: count }, (_, i) => ({
      id: `${year}-${i}`,
      date: `${year}-05-16`,
      maxHailIn: i / 10,
    })),
    count,
  });

function stubEvents(counts) {
  const files = {};
  for (const [year, count] of Object.entries(counts)) {
    files[`storm_events_${year}.json.gz`] = { body: EVENTS(year, count) };
  }
  return stubFetch(files);
}

test('two years of events report the index each year block starts at', async () => {
  resetYearCaches();
  const stub = stubEvents({ 2023: 7, 2025: 4 });
  try {
    const { events, offsets, years } = await eventsForYears([2025, 2023]);
    assert.deepEqual(years, ['2023', '2025'], 'resolved in year order');
    assert.equal(events.length, 11);
    assert.deepEqual(offsets, { 2023: 0, 2025: 7 });
    assert.equal(events[offsets['2023'] + 3].id, '2023-3');
    assert.equal(events[offsets['2025'] + 2].id, '2025-2');
  } finally {
    stub.restore();
    resetYearCaches();
  }
});

test('an ordinal from the wrong year resolves to a different storm, which is the point', async () => {
  resetYearCaches();
  const stub = stubEvents({ 2023: 7, 2025: 4 });
  try {
    const { events, offsets } = await eventsForYears(['2023', '2025']);
    const flat = events[3];
    const resolved = events[offsets['2025'] + 3];
    assert.notEqual(flat.id, resolved.id, 'the flat index was the wrong storm');
    assert.equal(resolved.id, '2025-3');
  } finally {
    stub.restore();
    resetYearCaches();
  }
});

test('a year with no events still gets an offset, pointing at the next block', async () => {
  resetYearCaches();
  const stub = stubEvents({ 2023: 5, 2026: 2 });
  try {
    const { events, offsets } = await eventsForYears(['2023', '2024', '2026']);
    assert.deepEqual(offsets, { 2023: 0, 2024: 5, 2026: 5 });
    assert.equal(events.length, 7);
  } finally {
    stub.restore();
    resetYearCaches();
  }
});

test('eventsFor still returns the bare list it always did', async () => {
  resetYearCaches();
  const stub = stubEvents({ 2023: 2, 2025: 1 });
  try {
    const list = await eventsFor(['2025', '2023']);
    assert.ok(Array.isArray(list));
    assert.deepEqual(
      list.map((e) => e.id),
      ['2023-0', '2023-1', '2025-0'],
    );
  } finally {
    stub.restore();
    resetYearCaches();
  }
});

test('one events request per year, shared between eventsFor and eventsForYears', async () => {
  resetYearCaches();
  const stub = stubEvents({ 2023: 3, 2025: 3 });
  try {
    const a = await eventsFor(['2023']);
    const b = await eventsForYears(['2023']);
    const c = await eventsFor(['2023']);
    assert.deepEqual(b.events, a);
    assert.deepEqual(c, a);
    assert.equal(stub.calls.length, 1, 'the year is memoised, not refetched');
  } finally {
    stub.restore();
    resetYearCaches();
  }
});

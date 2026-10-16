import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAGNITUDE_UNITS,
  clearStormReportCache,
  filterReports,
  rankStorms,
  stormDays,
  unpackReport,
} from './stormReports.js';

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
  assert.equal(report.stormRef, -1, 'no storm, because this fixture names none');
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

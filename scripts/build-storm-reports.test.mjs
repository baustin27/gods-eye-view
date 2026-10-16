import assert from 'node:assert/strict';
import test from 'node:test';

import { assemble, clusterOrphanReports, dailyDays, dayStamp } from './build-storm-reports.mjs';

test('the day index stops short of today, because today may be unpublished', () => {
  const days = dailyDays(2026, 2026, new Date('2026-10-15T12:00:00Z'));
  assert.equal(days.length, 287);
  assert.equal(days[0], '2026-01-01');
  assert.equal(
    days[days.length - 1],
    '2026-10-14',
    'yesterday is the last sure day',
  );
  assert.ok(days[days.length - 1] < '2026-10-15');
});

test('the day range is inclusive of both ends and crosses a year boundary', () => {
  const days = dailyDays(2025, 2026, new Date('2026-01-03T00:00:00Z'));
  assert.equal(days[0], '2025-01-01');
  assert.equal(days[days.length - 1], '2026-01-02');
  assert.ok(days.includes('2025-12-31'));
  assert.ok(days.includes('2026-01-01'));
});

test('asking for a window that has not started yields no days', () => {
  assert.deepEqual(dailyDays(2030, 2031, new Date('2026-10-15T00:00:00Z')), []);
});

test('the filename stamp is two-digit year, month, day', () => {
  assert.equal(dayStamp('2025-06-29'), '250629');
  assert.equal(dayStamp('2026-01-05'), '260105');
  assert.equal(dayStamp('2021-12-31'), '211231');
});

test('assemble splits by year and counts each hazard per day', () => {
  const make = (date, hazard, extra = {}) => ({
    id: `${date}-${hazard}`,
    date,
    minute: 0,
    hazard,
    size: 1,
    lat: 40,
    lon: -74,
    loss: 0,
    trace: false,
    sources: ['spc-bulk'],
    comment: null,
    countyFips: null,
    county: null,
    state: null,
    ...extra,
  });
  const { years, index } = assemble([
    make('2021-05-16', 'hail'),
    make('2021-05-16', 'wind'),
    make('2021-05-16', 'hail'),
    make('2026-08-10', 'hail'),
  ]);

  assert.deepEqual([...years.keys()], ['2021', '2026']);
  assert.equal(years.get('2021').count, 3);
  assert.equal(years.get('2021').hazards.hail, 2);
  assert.equal(years.get('2021').hazards.wind, 1);
  assert.equal(years.get('2026').count, 1);

  assert.deepEqual(index['2021-05-16'], { hail: 2, wind: 1, total: 3 });
  assert.deepEqual(index['2026-08-10'], { hail: 1, wind: 0, total: 1 });
});

test('assemble sorts each year so a rebuild is byte-identical', () => {
  const make = (date, minute, lat) => ({
    id: `${date}-${minute}-${lat}`,
    date,
    minute,
    hazard: 'hail',
    size: 1,
    lat,
    lon: -74,
    loss: 0,
    trace: false,
    sources: ['spc-bulk'],
    comment: null,
    countyFips: null,
    county: null,
    state: null,
  });
  const reports = [
    make('2021-05-16', 600, 40),
    make('2021-05-16', 60, 35),
    make('2021-05-17', 60, 30),
  ];
  const first = assemble([...reports]).years.get('2021').reports;
  const second = assemble([...reports.reverse()]).years.get('2021').reports;
  assert.deepEqual(first, second, 'input order must not change the output');
  assert.deepEqual(
    first.map((r) => r[1]),
    [60, 600, 60],
    'chronological, so the next day follows within the same year',
  );
});

test('assemble packs to the compact wire form', () => {
  const { years } = assemble([
    {
      id: 'x',
      date: '2025-05-16',
      minute: 728,
      hazard: 'hail',
      size: 1.75,
      lat: 37.57,
      lon: -84.3,
      countyFips: '21021',
      state: 'KY',
      county: 'Fayette',
      loss: 5000,
      trace: false,
      sources: ['spc-daily'],
      comment: 'quarter size',
    },
  ]);
  const packed = years.get('2025').reports[0];
  assert.ok(Array.isArray(packed), 'rows ship as tuples, not objects');
  assert.equal(packed[0], '2025-05-16');
  assert.equal(packed[1], 728);
  assert.equal(packed[2], 0, 'hail is hazard index 0');
  assert.equal(packed[3], 1.75);
  assert.equal(packed[11], 'spc-daily', 'sources is the eleventh slot');
  assert.equal(packed[12], 0, 'the twelfth slot is the trace flag');
  assert.equal(packed.length, 14, 'fourteen slots, not thirteen');
  assert.equal(packed[13], -1, 'no storms were passed, so no storm');
});

/**
 * A report shaped the way the build leaves it, for the storm-ordinal tests.
 * @param {string} date
 * @param {object} extra
 */
function report(date, extra = {}) {
  return {
    id: extra.id ?? `${date}-${extra.hazard ?? 'hail'}`,
    date,
    minute: 600,
    hazard: 'hail',
    size: 1,
    lat: 35,
    lon: -97,
    loss: 0,
    trace: false,
    sources: ['spc-bulk'],
    comment: null,
    countyFips: null,
    county: null,
    state: null,
    ...extra,
  };
}

test("a report's stormRef is its ordinal in that year's event array", () => {
  // Two storms on the same day, which is the case a date match gets wrong, and
  // a third on the next day.
  const storms = [
    { id: 'EP-1', date: '2025-05-16' },
    { id: 'EP-2', date: '2025-05-16' },
    { id: 'EP-3', date: '2025-05-17' },
    { id: 'EP-4', date: '2026-05-16' },
  ];
  const { years } = assemble(
    [
      report('2025-05-16', { id: 'b', minute: 120, episodeId: 'EP-2' }),
      report('2025-05-16', { id: 'a', minute: 60, episodeId: 'EP-1' }),
      report('2025-05-17', { id: 'c', episodeId: 'EP-3' }),
      report('2026-05-16', { id: 'd', episodeId: 'EP-4' }),
    ],
    storms,
  );
  const rows = years.get('2025').reports;
  assert.equal(rows[0][13], 0, 'the first storm of the day is ordinal 0');
  assert.equal(rows[1][13], 1, 'the second storm of the day is ordinal 1');
  assert.equal(rows[2][13], 2, 'the day after is the next ordinal of the year');
  assert.equal(
    years.get('2026').reports[0][13],
    0,
    'ordinals are scoped to the year the event file holds',
  );
});

test('an NCEI report resolves to the event it was joined to', () => {
  const storms = [
    { id: 'EP-20250516-1', date: '2025-05-16' },
    { id: 'EP-20250517-1', date: '2025-05-17' },
  ];
  const { years } = assemble(
    [
      report('2025-05-16', { episodeId: 'EP-20250516-1' }),
      report('2025-05-17', { episodeId: 'EP-20250517-1' }),
    ],
    storms,
  );
  const rows = years.get('2025').reports;
  assert.equal(rows[0][13], 0);
  assert.equal(rows[1][13], 1);
});

test('a clustered report resolves to its own cluster, not to the day', () => {
  // Two clusters on one day. The clusterer keys on time and distance, so two
  // storms hours apart on the same date come back as two clusters.
  const orphans = [
    report('2025-06-01', { id: 'a1', minute: 60, lat: 30, lon: -97 }),
    report('2025-06-01', { id: 'a2', minute: 90, lat: 30.2, lon: -97.1 }),
    report('2025-06-01', { id: 'b1', minute: 900, lat: 41, lon: -87 }),
    report('2025-06-01', { id: 'b2', minute: 930, lat: 41.1, lon: -87.1 }),
  ];
  const { inferred } = clusterOrphanReports(orphans);
  assert.equal(inferred.length, 2, 'two clusters on one day');

  const { years } = assemble(orphans, inferred);
  const refs = years.get('2025').reports.map((r) => r[13]);
  assert.deepEqual(
    [...refs].sort(),
    [0, 0, 1, 1],
    'each cluster gets its own ordinal, and no report borrows the other one',
  );
  // And the ordinal means what it says: it indexes the event array.
  const byKey = new Map(inferred.map((storm, i) => [storm.id, i]));
  for (const member of orphans) {
    const storm = inferred.find((s) => s.id === member._stormKey);
    assert.equal(byKey.get(storm.id), refs[orphans.indexOf(member)]);
  }
});

test('a report belonging to no storm is stamped -1, not 0', () => {
  const { years } = assemble(
    [
      report('2025-07-01', { id: 'a-lonely', minute: 60 }),
      report('2025-07-01', { id: 'b-joined', minute: 120, episodeId: 'EP-9' }),
    ],
    [{ id: 'EP-9', date: '2025-07-01' }],
  );
  const rows = years.get('2025').reports;
  assert.equal(rows[0][13], -1, 'an unattributed report belongs to no storm');
  assert.equal(rows[1][13], 0);
});

test('an event whose year is not the report year cannot be resolved', () => {
  // `buildStormEvents` dates an episode from its first report in insertion
  // order, so an episode straddling 31 Dec / 1 Jan can land in one year's
  // event file while a report of it sits in the next year's report file. A
  // year-scoped ordinal lookup has no answer for that report, and -1 is the
  // honest one.
  const { years } = assemble(
    [report('2026-01-01', { episodeId: 'EP-20251231-1' })],
    [{ id: 'EP-20251231-1', date: '2025-12-31' }],
  );
  assert.equal(years.get('2026').reports[0][13], -1);
});

test('no storms passed means every report is unattributed', () => {
  const { years } = assemble([
    report('2021-05-16', { episodeId: 'EP-1' }),
  ]);
  assert.equal(years.get('2021').reports[0][13], -1);
});

test('an inferred storm never takes an id another storm already uses', () => {
  // A cluster id is derived from the first report of the cluster, so nothing
  // guarantees two storms cannot derive the same one. When they do, the second
  // claimant takes a suffixed key instead of shadowing the first — otherwise a
  // report would resolve to whichever storm happened to be written first.
  const makeOrphans = () => [
    report('2025-06-01', { id: 'a1', minute: 60, lat: 30, lon: -97 }),
    report('2025-06-01', { id: 'a2', minute: 90, lat: 30.2, lon: -97.1 }),
    report('2025-06-01', { id: 'b1', minute: 900, lat: 41, lon: -87 }),
    report('2025-06-01', { id: 'b2', minute: 930, lat: 41.1, lon: -87.1 }),
  ];
  const first = makeOrphans();
  const firstStorms = clusterOrphanReports(first).inferred;
  const claimed = new Set(firstStorms.map((storm) => storm.id));
  const takenBefore = new Set(claimed);

  const second = makeOrphans();
  const secondStorms = clusterOrphanReports(second, claimed).inferred;
  const keys = new Set(second.map((r) => r._stormKey));
  assert.equal(keys.size, 2, 'two clusters, two keys');
  assert.ok(
    [...keys].every((key) => !takenBefore.has(key)),
    'a key in use by another storm is never handed out again',
  );

  // Four storms now carry two distinct pairs of ids, and each report still
  // resolves to the ordinal of its own storm rather than to the first twin.
  const { years } = assemble(second, [...firstStorms, ...secondStorms]);
  const refs = years.get('2025').reports.map((r) => r[13]);
  assert.deepEqual([...refs].sort(), [2, 2, 3, 3]);
});

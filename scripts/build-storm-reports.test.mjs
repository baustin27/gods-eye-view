import assert from 'node:assert/strict';
import test from 'node:test';

import { assemble, dailyDays, dayStamp } from './build-storm-reports.mjs';

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
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

import {
  STORM_SORT_KEYS,
  buildStormDays,
  radarDayFor,
  sortStormDays,
} from './storms.js';

/**
 * Tests for the storm-date list.
 *
 * The numbers here are the CONTRACT, and they were measured from the two
 * artifacts the desk ships - not estimated, and not derived from the code
 * under test. A day list that quietly loses a spine is a day list that looks
 * plausible: an empty radar column and an empty report column look the same
 * on the page, and only the counts tell them apart.
 *
 * The artifacts are read HERE, at the call site, because the module is pure:
 * it takes the parsed artifacts and never touches the disk, so the same
 * numbers can be computed in a test, in a script or in the browser.
 */

/** The parsed cities artifact. */
const CITIES = JSON.parse(
  gunzipSync(readFileSync(new URL('../public/data/cities.json.gz', import.meta.url))),
);

/** The parsed swaths artifact. */
const SWATHS = JSON.parse(
  gunzipSync(readFileSync(new URL('../public/data/swaths.json.gz', import.meta.url))),
);

/** Every storm day in the country, the two spines unioned. */
const NATIONAL = buildStormDays({ cities: CITIES, swaths: SWATHS, state: '' });

/** The Colorado days. */
const COLORADO = buildStormDays({ cities: CITIES, swaths: SWATHS, state: 'CO' });

/** The rows of one kind. */
const ofKind = (rows, kind) => rows.filter((row) => row.kind === kind);

/** The first and last date of a set of rows. */
const span = (rows) => {
  const dates = rows.map((row) => row.date).sort();
  return [dates[0], dates[dates.length - 1]];
};

/* ======================================================================
 * THE TWO SPINES, and the union of them.
 *
 * A report day is a day somebody measured a stone inside a town. A radar day
 * is a day the 1 km field reached something. The list is both, because a list
 * of either alone hides half the work.
 * ====================================================================== */

test('the list is the union of the two spines', () => {
  const reportDays = NATIONAL.filter((row) => row.kind !== 'radar');
  const radarDays = NATIONAL.filter((row) => row.kind !== 'reports');
  assert.equal(reportDays.length, 1248, 'the report days');
  assert.equal(radarDays.length, 1586, 'the radar days');
  assert.equal(NATIONAL.length, 1708, 'and the union of them');
  assert.deepEqual(span(reportDays), ['2021-01-06', '2026-10-13']);
  assert.deepEqual(span(radarDays), ['2021-01-02', '2026-10-15']);
});

test('the days that are on both spines are counted on both spines', () => {
  assert.equal(ofKind(NATIONAL, 'both').length, 1126);
  assert.equal(ofKind(NATIONAL, 'reports').length, 122);
  assert.equal(ofKind(NATIONAL, 'radar').length, 460);
  // A day with reports and no radar reach, and a day with radar reach and no
  // reports, are the two halves of the list that only the UNION can show.
  // The first report day is no longer the first REPORT-ONLY day: with six
  // years of radar behind it, 6 January 2021 is a day the radar reached as
  // well as a day somebody called in.
  assert.deepEqual(span(ofKind(NATIONAL, 'reports')), ['2021-01-24', '2026-10-08']);
  assert.deepEqual(span(ofKind(NATIONAL, 'radar')), ['2021-01-02', '2026-10-15']);
});

test('a day is on the list once', () => {
  const dates = NATIONAL.map((row) => row.date);
  assert.equal(new Set(dates).size, NATIONAL.length);
});

/* ======================================================================
 * COLORADO, which is the desk's market.
 *
 * The numbers are the ones a canvasser acts on, and they come out of the
 * artifacts EXACTLY - the sum of the ACS housing units of the tracts the
 * radar reached.
 * ====================================================================== */

test('the biggest Colorado radar day is 2023-06-22', () => {
  const biggest = COLORADO.reduce((best, row) =>
    row.houses !== null && (!best || row.houses > best.houses) ? row : best,
  null);
  assert.ok(biggest, 'Colorado has radar days');
  assert.equal(biggest.radarDay, '2023-06-23', 'and it is the shard of that day');
  // The row is dated the day the reports were filed, and the shard that
  // covers that day is the one that measured the hail - which is why the
  // biggest number in the list is on the row before it.
  assert.equal(biggest.date, '2023-06-22', 'the row is the day before the shard');
  // THE HOUSES IN REACH are the houses that were UNDER THE HAIL: the share
  // of each tract the 1 km field covered, times the units in it. The market
  // size - every unit in the tracts the hail touched - is beside it.
  assert.equal(biggest.houses, 274771, '274,771 houses under the hail');
  assert.equal(biggest.units, 437840, 'out of 437,840 housing units');
  assert.equal(biggest.tracts, 247, 'across 247 tracts');
  assert.equal(biggest.radarPlaces, 37, 'and 37 places');
  assert.ok(
    Math.abs(biggest.largest - 62.6 / 25.4) < 1e-9,
    'the largest reading, in inches',
  );
  assert.ok(Math.abs(biggest.largest - 2.46) < 0.005, 'which reads as 2.46 inches');
});

test('2025-07-07 in Colorado is 17,750 houses in 24 tracts', () => {
  const row = COLORADO.find((day) => day.radarDay === '2025-07-07');
  assert.ok(row, 'the shard is on a row');
  assert.equal(row.date, '2025-07-06', 'on the row of the day it covers');
  assert.equal(row.houses, 17750, '17,750 houses under the hail');
  assert.equal(row.units, 40221, 'out of 40,221 housing units');
  assert.equal(row.tracts, 24);
  assert.equal(row.radarPlaces, 3);
});

test('the houses in reach are never more than the market, and usually far less', () => {
  // The apportioned count is the claim and the unit count is the market, and
  // the claim is always the smaller of the two - a number that claimed more
  // houses than the tracts it came from held would be a bug in the
  // arithmetic rather than a rounding.
  for (const row of COLORADO) {
    if (row.houses === null) continue;
    assert.ok(
      row.houses <= row.units,
      `${row.date}: ${row.houses} houses claimed from ${row.units} units`,
    );
  }
  // And over the whole Colorado window the claim is a fraction of the
  // market, because most of the tracts the hail reached were only clipped.
  const houses = COLORADO.reduce((total, row) => total + (row.houses || 0), 0);
  const units = COLORADO.reduce((total, row) => total + (row.units || 0), 0);
  assert.equal(houses, 2227005);
  assert.equal(units, 5543260);
});

test('Colorado is a market of 143 places with hail in the default window', () => {
  // The desk's default window is 1955-2025 and its default floor is an inch,
  // and this is the market the storm list is a day-by-day view of: the places
  // that saw a stone that big inside the window.
  const colorado = new Set(
    CITIES.cities.filter((place) => place.st === 'CO').map((place) => place.id),
  );
  const inWindow = (day) => day.slice(0, 4) >= '1955' && day.slice(0, 4) <= '2025';
  const market = new Set(
    CITIES.cityDays
      .filter(
        (row) =>
          colorado.has(row.geoid) &&
          Number(row.n) > 0 &&
          Number(row.max) >= 1 &&
          inWindow(row.d),
      )
      .map((row) => row.geoid),
  );
  assert.equal(market.size, 143);
});

test('the Colorado list is the state, and not the country', () => {
  const national = new Map(NATIONAL.map((row) => [row.date, row]));
  // The country's houses for a shard, keyed by the shard itself: a report row
  // and a radar row can both point at the same shard, and the country's number
  // for it is the same either way.
  const country = new Map(NATIONAL.map((row) => [row.radarDay, row.houses]));
  for (const row of COLORADO) {
    const day = national.get(row.date);
    assert.ok(day, 'every Colorado day is a day in the country');
    assert.ok(
      row.reports <= day.reports,
      `no more reports than the country on ${row.date}`,
    );
    const countryHouses = country.get(row.radarDay);
    if (row.houses !== null && countryHouses !== null && countryHouses !== undefined) {
      assert.ok(
        row.houses <= countryHouses,
        `no more houses in reach than the country on ${row.radarDay}`,
      );
    }
  }
});

test('Colorado has 175 report days and 302 radar days', () => {
  // The two spines, measured per state: the days people filed hail in
  // Colorado, and the days the radar reached something in it. The radar
  // spine grew when the field went back to 2021, and it is the larger of the
  // two now, which is the point of a field that goes back further than the
  // report archive.
  const reportDays = COLORADO.filter((row) => row.kind !== 'radar');
  const radarDays = COLORADO.filter((row) => row.kind !== 'reports');
  assert.equal(reportDays.length, 175);
  assert.equal(radarDays.length, 302);
});

test('73% of the Colorado report days have a radar reach', () => {
  // 128 of 175, where it was 67 of 175 when the field only went back to
  // 2024. The +1 offset is the pairing - it covers more than twice as many
  // report days as any other offset - and the coverage grows as the field
  // reaches further back, because a report day in 2021 was on the radar too.
  //
  // The number that matters is the one that did NOT grow: the 47 report days
  // with no radar reach are days before the 1 km field starts, and no amount
  // of history changes them.
  const reportDays = COLORADO.filter((row) => row.kind !== 'radar');
  const covered = reportDays.filter((row) => row.houses !== null);
  assert.equal(covered.length, 128);
  assert.ok(covered.length / reportDays.length > 0.72);
  assert.ok(covered.length / reportDays.length < 0.74);
});

/* ======================================================================
 * THE JOIN: a report day is covered by the shard named the next day.
 * ====================================================================== */

test('a report day takes its radar columns from the shard that covers it', () => {
  // The fixtures are small enough to reason about by hand.
  const cities = {
    cities: [
      { id: '0820000', name: 'Denver', st: 'CO', state: 'Colorado' },
      { id: '4055000', name: 'Oklahoma City', st: 'OK', state: 'Oklahoma' },
    ],
    cityDays: [
      { geoid: '0820000', d: '2024-05-31', n: 2, n1: 1, max: 1.5 },
      { geoid: '0820000', d: '2024-06-01', n: 3, n1: 2, max: 2 },
      { geoid: '4055000', d: '2024-06-01', n: 1, n1: 0, max: 0.75 },
    ],
  };
  const swaths = {
    rows: [
      { g: '08001000100', k: '0820000', d: '2024-06-01', m: 50.8, c: 2, u: 1200 },
      { g: '08001000200', k: '0820000', d: '2024-06-01', m: 30, c: 1, u: 300 },
      { g: '08001000300', k: '0820000', d: '2024-06-02', m: 25.4, c: 1, u: 100 },
    ],
  };
  const rows = buildStormDays({ cities, swaths, state: 'CO' });
  assert.equal(rows.length, 3, 'two report days and one radar day');

  const friday = rows.find((row) => row.date === '2024-05-31');
  assert.equal(friday.kind, 'reports', 'the radar did not reach that day');
  assert.equal(friday.radarDay, '2024-06-01', 'and the shard that covers it is the next');
  assert.equal(friday.houses, 1500, 'the houses under the shard that covers it');
  assert.equal(friday.tracts, 2);
  assert.equal(friday.radarPlaces, 1);
  assert.equal(friday.reports, 2, 'the reports filed that day');
  assert.equal(friday.severe, 1, 'the reports of an inch or more');
  assert.equal(friday.places, 1, 'the places that filed them');
  assert.equal(friday.largest, 2, 'the radar\'s largest reading, in inches');

  const saturday = rows.find((row) => row.date === '2024-06-01');
  assert.equal(saturday.kind, 'both', 'the radar reached that day');
  assert.equal(saturday.radarDay, '2024-06-02', 'and its own columns come from the next shard');
  assert.equal(saturday.houses, 100);
  assert.equal(saturday.reports, 3);

  const sunday = rows.find((row) => row.date === '2024-06-02');
  assert.equal(sunday.kind, 'radar', 'a radar day nobody called in');
  assert.equal(sunday.radarDay, '2024-06-02', 'and a radar day is its own shard');
  assert.equal(sunday.houses, 100);
  assert.equal(sunday.reports, 0);
});

test('a day with no radar reach has no number for it', () => {
  const cities = {
    cities: [{ id: '4055000', name: 'Oklahoma City', st: 'OK', state: 'Oklahoma' }],
    cityDays: [{ geoid: '4055000', d: '2024-06-01', n: 1, n1: 0, max: 0.75 }],
  };
  const rows = buildStormDays({ cities, swaths: { rows: [] }, state: 'OK' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'reports');
  assert.equal(rows[0].houses, null, 'null, not zero: the radar did not reach here');
  assert.equal(rows[0].tracts, null);
  assert.equal(rows[0].radarPlaces, null);
  assert.equal(rows[0].largest, 0.75, 'so the largest stone is the reports\'');
});

test('a radar day with nobody calling it in is still a row', () => {
  const cities = { cities: [{ id: '0820000', name: 'Denver', st: 'CO' }], cityDays: [] };
  const swaths = {
    rows: [{ g: '08001000100', k: '0820000', d: '2024-07-17', m: 42.5, c: 3, u: 4000 }],
  };
  const rows = buildStormDays({ cities, swaths, state: 'CO' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'radar');
  assert.equal(rows[0].houses, 4000, 'the houses in reach');
  assert.equal(rows[0].reports, 0, 'and nobody called it in');
  assert.equal(rows[0].places, 0);
  assert.equal(rows[0].radarPlaces, 1);
});

test('the state filter keeps only that state', () => {
  const oklahoma = buildStormDays({ cities: CITIES, swaths: SWATHS, state: 'OK' });
  assert.ok(oklahoma.length > 0, 'Oklahoma has days');
  // The country is the union of the states, so it has at least as many days
  // as any one of them and no more than all of them put together.
  const nationalDates = new Set(NATIONAL.map((row) => row.date));
  for (const row of [...COLORADO, ...oklahoma]) {
    assert.ok(nationalDates.has(row.date), 'a state day is a country day');
  }
  const union = new Set([...COLORADO, ...oklahoma].map((row) => row.date));
  assert.ok(union.size <= NATIONAL.length, 'and the states do not invent days');
});

/* ======================================================================
 * THE SORT, because every header is a control.
 * ====================================================================== */

test('every column sorts, both ways', () => {
  const columns = [
    'date',
    'houses',
    'reports',
    'severe',
    'largest',
    'places',
    'radarPlaces',
    'tracts',
  ];
  assert.deepEqual([...STORM_SORT_KEYS].sort(), [...columns].sort());
  for (const key of columns) {
    for (const dir of ['asc', 'desc']) {
      const sorted = sortStormDays(COLORADO, key, dir);
      assert.equal(sorted.length, COLORADO.length, `${key} ${dir} keeps every row`);
      const values = sorted.map((row) => row[key]);
      const measured = values.filter((value) => value !== null);
      for (let i = 1; i < measured.length; i += 1) {
        const before = measured[i - 1];
        const after = measured[i];
        const ordered = dir === 'asc' ? before <= after : before >= after;
        assert.ok(ordered, `${key} ${dir} is out of order at ${i}: ${before} then ${after}`);
      }
    }
  }
});

test('a day with no radar reach is not the biggest', () => {
  const rows = [
    { date: '2024-01-01', houses: null, reports: 1, severe: 0, largest: 1, places: 1, radarPlaces: null, tracts: null, kind: 'reports' },
    { date: '2024-01-02', houses: 10, reports: 2, severe: 0, largest: 1, places: 1, radarPlaces: 1, tracts: 1, kind: 'both' },
  ];
  const sorted = sortStormDays(rows, 'houses', 'desc');
  assert.equal(sorted[0].date, '2024-01-02', 'the day with houses comes first');
  assert.equal(sorted[1].houses, null, 'and the day without them is last');
  const ascending = sortStormDays(rows, 'houses', 'asc');
  assert.equal(ascending[1].date, '2024-01-01', 'the unmeasured day is last there too');
});

test('the sort is a copy and does not edit the list', () => {
  const rows = [
    { date: '2024-01-01', houses: 1, reports: 0, severe: 0, largest: 1, places: 0, radarPlaces: 0, tracts: 0, kind: 'both' },
    { date: '2024-01-02', houses: 9, reports: 0, severe: 0, largest: 1, places: 0, radarPlaces: 0, tracts: 0, kind: 'both' },
  ];
  const before = rows.map((row) => row.date);
  sortStormDays(rows, 'houses', 'desc');
  assert.deepEqual(rows.map((row) => row.date), before, 'the list is untouched');
});

test('the newest storm is at the top when the list is sorted by date', () => {
  const sorted = sortStormDays(COLORADO, 'date', 'desc');
  const dates = sorted.map((row) => row.date);
  for (let i = 1; i < dates.length; i += 1) {
    assert.ok(dates[i - 1] >= dates[i], 'newest first');
  }
});

test('a tie is broken the same way every time', () => {
  const rows = [
    { date: '2024-01-01', houses: 10, reports: 0, severe: 0, largest: 1, places: 0, radarPlaces: 0, tracts: 0, kind: 'both' },
    { date: '2024-03-01', houses: 10, reports: 0, severe: 0, largest: 1, places: 0, radarPlaces: 0, tracts: 0, kind: 'both' },
    { date: '2024-02-01', houses: 10, reports: 0, severe: 0, largest: 1, places: 0, radarPlaces: 0, tracts: 0, kind: 'both' },
  ];
  const sorted = sortStormDays(rows, 'reports', 'desc');
  assert.deepEqual(
    sorted.map((row) => row.date),
    ['2024-03-01', '2024-02-01', '2024-01-01'],
    'newest first among the ties',
  );
});

/* ======================================================================
 * THE SHIFT, which is the one arithmetic fact the list rests on.
 * ====================================================================== */

test('the radar day a report day is covered by is the next day', () => {
  assert.equal(radarDayFor('2024-05-31'), '2024-06-01');
  assert.equal(radarDayFor('2024-12-31'), '2025-01-01', 'over a year boundary');
  assert.equal(radarDayFor('2024-02-28'), '2024-02-29', 'into a leap day');
  assert.equal(radarDayFor('2023-02-28'), '2023-03-01', 'over a short February');
});

test('a day that is not a day is refused rather than rolled over', () => {
  assert.throws(() => radarDayFor('2024-13-01'), RangeError);
  assert.throws(() => radarDayFor('2024-02-30'), RangeError);
  assert.throws(() => radarDayFor('yesterday'), TypeError);
  assert.throws(() => radarDayFor(''), TypeError);
});

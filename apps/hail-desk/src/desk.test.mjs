import assert from 'node:assert/strict';
import test from 'node:test';

import { queryCounties, yearBounds } from './data.js';
import { csvFilename, toCsv } from './csv.js';
import { DEFAULT_FILTERS, filtersFromHash, hashFromFilters } from './state.js';

/**
 * Tests for the Hail Desk's data layer.
 *
 * The desk's job is to put a number next to the right county. Every test here
 * is about that: that a score belongs to the county it is shown next to, that
 * a window's counts are the window's counts, and that a file handed to a
 * spreadsheet cannot execute anything.
 */

/**
 * A county row in the shape the desk's artifact carries.
 *
 * The `ye` tallies are the flat array the artifact uses; the decoder turns
 * them into the Map the core's window arithmetic needs.
 */
function county(over = {}) {
  const {
    fips = '08059',
    name = 'Jefferson',
    st = 'CO',
    hn = 100,
    hs = 40,
    hx = 3,
    wn = 10,
    ws = 2,
    wx = 60,
    y0 = 1955,
    y1 = 2025,
    units = 251183,
    umoe = 194,
    pop = 582825,
    bld = 194997730,
    pl = 0,
    years = [
      [2000, 5, 1],
      [2001, 7, 2],
      [2020, 11, 3],
    ],
    ...rest
  } = over;
  return {
    fips,
    name,
    st,
    hn,
    hs,
    hx,
    wn,
    ws,
    wx,
    y0,
    y1,
    units,
    umoe,
    pop,
    bld,
    pl,
    ye: years.flat(),
    dc: { 2000: [5, 1], 2001: [7, 2], 2020: [11, 3] },
    ...rest,
  };
}

const FILTERS = {
  ...DEFAULT_FILTERS,
  fromYear: 2000,
  toYear: 2024,
  state: '',
  minHailTenths: 0,
  q: '',
};

test('a score stays with the county it belongs to', () => {
  // The merge is the risk: the score comes from `scoreCounties` and the facts
  // come from the artifact, and they are joined by FIPS. If the join is
  // wrong, the table shows one county's name beside another county's score,
  // and nothing anywhere looks broken.
  const rows = [county(), county({ fips: '08031', name: 'Denver', st: 'CO' })];
  const out = queryCounties(rows, FILTERS);
  for (const row of out) {
    const own = rows.find((source) => source.fips === row.fips);
    assert.equal(row.name, own.name, 'the name is the row it came from');
    assert.equal(row.units, own.units, 'and so are the housing units');
    assert.equal(row.st, own.st);
  }
  assert.equal(out.length, 2);
});

test('the window counts are the window counts', () => {
  const rows = [county()];
  const out = queryCounties(rows, { ...FILTERS, fromYear: 2000, toYear: 2001 });
  assert.equal(out.length, 1);
  // 5 + 7 hail events in 2000 and 2001, and nothing in 2020.
  assert.equal(out[0].window.hailCount, 12);
  assert.equal(out[0].window.windCount, 3);
  assert.equal(out[0].window.partial, false, 'an exact window is never partial');
});

test('a narrow window is not a fraction of a lifetime average', () => {
  // The whole point of the per-year tallies: 2020 alone is 11 events, not
  // 11/71 of the record.
  const rows = [county()];
  const out = queryCounties(rows, { ...FILTERS, fromYear: 2020, toYear: 2020 });
  assert.equal(out[0].window.hailCount, 11);
});

test('the state filter keeps only that state', () => {
  const rows = [
    county({ fips: '08059', name: 'Jefferson', st: 'CO' }),
    county({ fips: '48303', name: 'Lubbock', st: 'TX' }),
  ];
  const out = queryCounties(rows, { ...FILTERS, state: 'co' });
  assert.equal(out.length, 1);
  assert.equal(out[0].st, 'CO');
});

test('the minimum hail filter drops counties that never saw a stone that big', () => {
  const rows = [
    county({ fips: '08059', name: 'Jefferson', hx: 3 }),
    county({ fips: '08031', name: 'Denver', hx: 1 }),
  ];
  const out = queryCounties(rows, { ...FILTERS, minHailTenths: 25 });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Jefferson');
});

test('the search matches a county name', () => {
  const rows = [
    county({ fips: '08059', name: 'Jefferson' }),
    county({ fips: '08031', name: 'Denver' }),
  ];
  const out = queryCounties(rows, { ...FILTERS, q: 'den' });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Denver');
});

test('the year bounds come from the record, not from a guess', () => {
  const rows = [county({ y0: 1960, y1: 2025 })];
  const bounds = yearBounds(rows);
  assert.equal(bounds.min, 1960);
  assert.equal(bounds.max, 2025);
});

test('a CSV cell that looks like a formula is defused', () => {
  // A spreadsheet reads a leading =, +, - or @ as the start of a formula, and
  // a county whose name begins with a dash is not a thing but a VALUE that
  // begins with a dash is. The apostrophe is what stops Excel evaluating it.
  const csv = toCsv(
    [{ name: '=SUM(A1:A9)', units: 5, bld: 10 }],
    [
      { label: 'County', get: (row) => row.name },
      { label: 'Units', get: (row) => row.units },
    ],
  );
  assert.ok(csv.includes("'=SUM(A1:A9)"), 'the formula is prefixed');
  assert.ok(!csv.includes(',=SUM'), 'and not left as a bare formula');
});

test('a CSV value with a comma or a quote is quoted', () => {
  const csv = toCsv(
    [{ name: 'Cook, IL "the county"' }],
    [{ label: 'County', get: (row) => row.name }],
  );
  assert.ok(csv.includes('"Cook, IL ""the county"""'), csv);
});

test('the filters survive a round trip through the URL', () => {
  const filters = {
    ...DEFAULT_FILTERS,
    fromYear: 2000,
    toYear: 2024,
    state: 'co',
    minHailTenths: 15,
    sort: 'units',
    dir: 'asc',
    q: 'denver',
  };
  const hash = hashFromFilters(filters);
  assert.match(hash, /^#v=2&l=8&lo=/, 'the desk names itself in the link');
  const back = filtersFromHash(hash);
  assert.equal(back.fromYear, 2000);
  assert.equal(back.toYear, 2024);
  assert.equal(back.state, 'co');
  assert.equal(back.minHailTenths, 15);
  assert.equal(back.sort, 'units');
  assert.equal(back.dir, 'asc');
  assert.equal(back.q, 'denver');
});

test('a link with no desk parameters reads as the defaults', () => {
  assert.deepEqual(filtersFromHash(''), { ...DEFAULT_FILTERS });
  assert.deepEqual(filtersFromHash('#v=2&l=5&lo=5.m.10'), { ...DEFAULT_FILTERS });
});

test('a link with a different version is ignored rather than half-read', () => {
  assert.deepEqual(filtersFromHash('#v=1&l=7&lo=7.f.2000'), {
    ...DEFAULT_FILTERS,
  });
});

test('the export filename says what the file is', () => {
  const name = csvFilename({ state: 'co', fromYear: 2000, toYear: 2024 });
  assert.match(name, /^hail-desk-co-2000-2024\.csv$/);
});

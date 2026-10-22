import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cityStorms,
  indexCities,
  indexFema,
  indexSwaths,
  queryCities,
  queryCounties,
  radarDays,
  yearBounds,
} from './data.js';
import { csvFilename, toCsv } from './csv.js';
import { DEFAULT_FILTERS, filtersFromHash, hashFromFilters } from './state.js';

test('state isolation round-trips with the selected state and stays off for ALL', () => {
  const restored = filtersFromHash(hashFromFilters({ ...DEFAULT_FILTERS, state: 'TX', iso: 'state' }));
  assert.equal(restored.state.toUpperCase(), 'TX');
  assert.equal(restored.iso, 'state');
  assert.equal(filtersFromHash(hashFromFilters({ ...DEFAULT_FILTERS, state: '', iso: 'state' })).iso, '');
  assert.equal(filtersFromHash(hashFromFilters({ ...DEFAULT_FILTERS, iso: '0816000' })).iso, '');
});

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


/* ======================================================================
 * The CITY view, which is the point of the desk.
 *
 * A canvasser works in a town. These assertions are about the town rows
 * being OBSERVED - counted from the individual reports - rather than
 * modelled, because that was the whole reason the city table exists.
 * ====================================================================== */

/** A city row, and the per-year hail that fell in it. */
function cityFixture(over = {}) {
  const {
    id = '0820000',
    name = 'Denver',
    full = 'Denver city',
    st = 'CO',
    state = 'Colorado',
    units = 352593,
    umoe = 173,
    pop = 713734,
    ...rest
  } = over;
  return { id, name, full, st, state, units, umoe, pop, ...rest };
}

const cityPayload = {
  cities: [
    cityFixture(),
    cityFixture({ id: '4055000', name: 'Oklahoma City', full: 'Oklahoma City city', st: 'OK', state: 'Oklahoma', units: 302751, umoe: 1383, pop: 688693 }),
    cityFixture({ id: '0831150', name: 'Nowhere', st: 'CO', units: 100, umoe: 5, pop: 200 }),
  ],
  cityYears: [
    { geoid: '0820000', y: 2000, n: 10, n1: 4, n15: 2, n2: 1, n3: 0, max: 2.5, wind: 3, wmax: 60 },
    { geoid: '0820000', y: 2020, n: 20, n1: 8, n15: 3, n2: 2, n3: 1, max: 3.5, wind: 5, wmax: 70 },
    { geoid: '4055000', y: 2020, n: 30, n1: 12, n15: 5, n2: 2, n3: 0, max: 2, wind: 1, wmax: 55 },
  ],
  cityDays: [
    { geoid: '0820000', d: '2020-06-14', n: 12, n1: 8, n15: 3, n2: 2, n3: 1, max: 3.5, wind: 2, wmax: 70 },
    { geoid: '0820000', d: '2020-06-15', n: 6, n1: 3, n15: 1, n2: 0, n3: 0, max: 2, wind: 1, wmax: 60 },
    { geoid: '0820000', d: '2020-08-01', n: 2, n1: 0, n15: 0, n2: 0, n3: 0, max: 0.75, wind: 0, wmax: 0 },
    { geoid: '4055000', d: '2020-06-15', n: 30, n1: 12, n15: 5, n2: 2, n3: 0, max: 2, wind: 1, wmax: 55 },
  ],
};

test('a city row counts the hail that actually fell in it', () => {
  const index = indexCities(cityPayload);
  const out = queryCities(index, {
    ...DEFAULT_FILTERS,
    fromYear: 2000,
    toYear: 2020,
    state: '',
    minHailTenths: 0,
    q: '',
  });
  const denver = out.find((row) => row.id === '0820000');
  assert.ok(denver, 'the city is in the result');
  assert.equal(denver.hail, 30, 'both years are summed');
  assert.equal(denver.severe, 12, 'and so are the severe counts');
  assert.equal(denver.max, 3.5, 'the largest stone is the largest of the window');
  assert.equal(denver.years, 2);
});

test('a window is a window, not a share of an average', () => {
  const index = indexCities(cityPayload);
  const one = queryCities(index, {
    ...DEFAULT_FILTERS,
    fromYear: 2020,
    toYear: 2020,
    state: '',
    minHailTenths: 0,
    q: '',
  });
  const denver = one.find((row) => row.id === '0820000');
  assert.equal(denver.hail, 20, 'the 2020 year alone');
  assert.equal(denver.severe, 8);
  assert.equal(denver.years, 1);
});

test('the state filter keeps only that state', () => {
  const index = indexCities(cityPayload);
  const out = queryCities(index, {
    ...DEFAULT_FILTERS,
    fromYear: 1955,
    toYear: 2025,
    state: 'ok',
    minHailTenths: 0,
    q: '',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].st, 'OK');
});

test('the hail threshold is on the window, not on a lifetime maximum', () => {
  const index = indexCities(cityPayload);
  const out = queryCities(index, {
    ...DEFAULT_FILTERS,
    fromYear: 2020,
    toYear: 2020,
    state: '',
    minHailTenths: 30,
    q: '',
  });
  // Oklahoma City's max in 2020 is 2.00", Denver's is 3.50".
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '0820000');
});

test('a city with no hail in the window is not in the list', () => {
  const index = indexCities(cityPayload);
  const out = queryCities(index, {
    ...DEFAULT_FILTERS,
    fromYear: 1955,
    toYear: 1959,
    state: '',
    minHailTenths: 0,
    q: '',
  });
  assert.equal(out.length, 0, 'nothing fell in those years');
});

test('the city search matches a name', () => {
  const index = indexCities(cityPayload);
  const out = queryCities(index, {
    ...DEFAULT_FILTERS,
    fromYear: 1955,
    toYear: 2025,
    state: '',
    minHailTenths: 0,
    q: 'oklahoma',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Oklahoma City');
});


test('the storms in a place are worst first, and a trace is not a storm', () => {
  const index = indexCities(cityPayload);
  const storms = cityStorms(index, '0820000');
  assert.ok(storms.length, 'the place has storms');
  // Worst means the number of severe reports, then the largest stone.
  for (let i = 1; i < storms.length; i += 1) {
    const before = storms[i - 1];
    const after = storms[i];
    assert.ok(
      before.n1 > after.n1 ||
        (before.n1 === after.n1 && before.max >= after.max),
      `storm ${i} is no worse than the one before it`,
    );
  }
  // A day with only a trace is not a storm.
  assert.ok(
    storms.every((storm) => storm.n > 0),
    'every listed day has a hail report in it',
  );
});

test('a place with no storms has none', () => {
  const index = indexCities(cityPayload);
  assert.deepEqual(cityStorms(index, 'nowhere-at-all'), []);
});


/* ======================================================================
 * The swaths: how many houses were under the hail.
 *
 * This is the number the business acts on, and the two halves of it come
 * from different places - the radar says WHERE, the Census says HOW MANY -
 * so the join is where the bugs live.
 * ====================================================================== */

const swathPayload = {
  meta: { thresholdMm: 25.4 },
  rows: [
    { g: '11001020100', k: '1100100', d: '2024-07-17', m: 42.5, c: 3, u: 4000 },
    { g: '11001020200', k: '1100100', d: '2024-07-17', m: 38, c: 2, u: 3000 },
    { g: '11001020300', k: '1100100', d: '2024-07-17', m: 30, c: 1, u: 2000 },
    { g: '11001020400', k: '1100100', d: '2025-01-18', m: 28, c: 1, u: 500 },
  ],
};

test('the swaths roll the tracts up into houses for a place', () => {
  const index = indexSwaths(swathPayload);
  const day = index.byPlaceDay.get('1100100:2024-07-17');
  assert.ok(day, 'the day is there');
  assert.equal(day.tracts, 3, 'three tracts were reached');
  assert.equal(day.houses, 9000, 'and they hold 9,000 houses');
  assert.equal(day.maxMm, 42.5, 'the largest reading among them');
});

test('a place with no radar has no swaths', () => {
  const index = indexSwaths(swathPayload);
  assert.equal(radarDays(index, 'nowhere', { fromYear: 1955, toYear: 2025 }).length, 0);
});

test('the tracts are kept, not just their total', () => {
  // The roll-up is for the town; the canvasser works in a neighbourhood, so
  // the row for each tract the radar reached has to survive the roll-up.
  const index = indexSwaths(swathPayload);
  const day = index.byPlaceDay.get('1100100:2024-07-17');
  assert.equal(day.list.length, 3, 'three tracts in the list');
  assert.deepEqual(
    day.list.map((tract) => tract.units),
    [4000, 3000, 2000],
    'most houses first',
  );
  assert.equal(day.list[0].geoid, '11001020100');
  assert.equal(day.list[0].name, '020100', 'the tract number');
  assert.equal(day.list[0].maxMm, 42.5);
  assert.equal(day.list[0].cells, 3);
});

test('the tract list does not leak across places or days', () => {
  const index = indexSwaths(swathPayload);
  const first = index.byPlaceDay.get('1100100:2024-07-17');
  const second = index.byPlaceDay.get('1100100:2025-01-18');
  assert.equal(first.list.length, 3);
  assert.equal(second.list.length, 1);
  assert.equal(second.list[0].units, 500);
  assert.ok(
    !first.list.some((tract) => tract.geoid === '11001020400'),
    "the 2025 tract is not in the 2024 day",
  );
});

test('the radar days respect the window', () => {
  const index = indexSwaths(swathPayload);
  const all = radarDays(index, '1100100', { fromYear: 1955, toYear: 2025 });
  assert.equal(all.length, 2, 'both days');
  const narrow = radarDays(index, '1100100', { fromYear: 2025, toYear: 2025 });
  assert.equal(narrow.length, 1, 'only the 2025 day');
  assert.equal(narrow[0].d, '2025-01-18');
});

test('the storm list respects the window too', () => {
  // A table filtered to 2024-2026 that then opened a list showing 1987 is a
  // filter that does not filter.
  const index = indexCities(cityPayload);
  const all = cityStorms(index, '0820000', { fromYear: 1955, toYear: 2025 });
  assert.equal(all.length, 3, 'every storm day');
  const narrow = cityStorms(index, '0820000', { fromYear: 2020, toYear: 2021 });
  assert.equal(narrow.length, 3, 'only the days inside the window');
  for (const storm of narrow) assert.ok(storm.d >= '2020' && storm.d <= '2021');
});


/* ======================================================================
 * Realised damage by ZIP.
 *
 * The only number in the desk that says damage HAPPENED rather than
 * that hail fell - and the only one with a floor under it that has to be
 * said out loud: most people with hail damage never apply for help.
 * ====================================================================== */

test('the realised damage is indexed by ZIP', () => {
  const index = indexFema({
    zips: [
      { zip: '80027', households: 14, damage: 12940371, approved: 9000000 },
      { zip: '80620', households: 3, damage: 7840142, approved: 5000000 },
    ],
  });
  assert.equal(index.size, 2);
  const row = index.get('80027');
  assert.equal(row.households, 14);
  assert.equal(row.damage, 12940371);
  assert.equal(index.get('nope'), undefined, 'a ZIP with no damage is absent, not zero');
});

test('every sort key a header offers survives a link', () => {
  // The city view's own default sort is 'severe', and it was not in the
  // codec's enum - so it encoded as the literal string "undefined" and every
  // city link read back sorted by something else.
  for (const key of ['score', 'units', 'hail', 'pop', 'severe', 'severe15', 'big', 'max']) {
    const hash = hashFromFilters({ ...DEFAULT_FILTERS, sort: key });
    assert.ok(
      !hash.includes('undefined'),
      `the sort key ${key} wrote "undefined" into the link: ${hash}`,
    );
    assert.equal(filtersFromHash(hash).sort, key, `the sort key ${key} round-trips`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hailSeverity,
  windSeverity,
  recencyWeight,
  apportionDecade,
  windowCellCounts,
  blendScore,
  severityBand,
  scoreCells,
  scoreCounties,
  searchCounties,
  polygonCenter,
  polygonBounds,
  pointInPolygon,
  indexCellsToCounties,
  describeCellScore,
  HAIL_THRESHOLDS,
  WIND_THRESHOLDS,
  DEFAULT_WEIGHTS,
} from './stormScoring.js';

test('hail severity anchors on the published SPC size lines', () => {
  // Sub-damage sizes contribute nothing.
  assert.equal(hailSeverity(0.5), 0);
  assert.equal(hailSeverity(0), 0);
  assert.equal(hailSeverity(null), 0);
  assert.equal(hailSeverity(undefined), 0);
  assert.equal(hailSeverity('not a number'), 0);

  // Anchors land where the documentation claims they do.
  assert.equal(hailSeverity(HAIL_THRESHOLDS.damaging), 0);
  assert.equal(hailSeverity(HAIL_THRESHOLDS.severe), 0.25);
  assert.equal(hailSeverity(HAIL_THRESHOLDS.saturating), 1);
  assert.equal(hailSeverity(6), 1, 'saturates above grapefruit');

  // Monotone, bounded, and symmetric across the documented bands.
  let previous = -1;
  for (let inches = 0; inches <= 5; inches += 0.05) {
    const value = hailSeverity(inches);
    assert.ok(value >= 0 && value <= 1, `${inches}" must stay in 0..1`);
    assert.ok(value >= previous, 'severity must be non-decreasing in size');
    previous = value;
  }

  // Negative diameters are nonsense, not "small".
  assert.equal(hailSeverity(-3), 0);
});

test('wind severity anchors on the damaging-wind report floor', () => {
  assert.equal(windSeverity(20), 0);
  assert.equal(windSeverity(null), 0);
  assert.equal(windSeverity(WIND_THRESHOLDS.saturating), 1);
  assert.equal(windSeverity(200), 1);

  let previous = -1;
  for (let knots = 0; knots <= 140; knots += 1) {
    const value = windSeverity(knots);
    assert.ok(value >= 0 && value <= 1);
    assert.ok(value >= previous, 'severity must be non-decreasing in speed');
    previous = value;
  }

  // A 50 kt damaging-wind report must outrank a 45 kt non-damaging one.
  assert.ok(windSeverity(50) > windSeverity(45));
});

test('recency weight halves at the half-life and is clamped to the future', () => {
  assert.equal(recencyWeight(2025, 2025, 25), 1);
  assert.equal(
    recencyWeight(2030, 2025, 25),
    1,
    'future events are fully current',
  );
  assert.equal(recencyWeight(2000, 2025, 25), 0.5);
  assert.equal(recencyWeight(1950, 2025, 25), 0.5 ** 3);
  // A non-positive half-life disables recency rather than producing NaN.
  assert.equal(recencyWeight(1950, 2025, 0), 1);
});

test('decade buckets keep the record boundary whole', () => {
  const period = { fromYear: 1955, toYear: 2025 };

  // An interior decade that the period fully covers passes through untouched.
  assert.equal(apportionDecade(100, 2000, period), 100);

  // The last decade is only half-populated by the record itself, so a period
  // reaching the end of the record must return the whole bucket, not half of it.
  assert.equal(
    apportionDecade(51_251, 2020, period, { startYear: 1955, endYear: 2025 }),
    51_251,
    'partial final decade must not be halved',
  );

  // Same for the first decade when the record starts mid-decade.
  assert.equal(
    apportionDecade(2_214, 1950, period, { startYear: 1955, endYear: 2025 }),
    2_214,
    'partial opening decade must not be halved',
  );

  // A genuinely interior sub-decade period is apportioned proportionally.
  const half = apportionDecade(
    100,
    2000,
    { fromYear: 2005, toYear: 2009 },
    {
      startYear: 1955,
      endYear: 2025,
    },
  );
  assert.ok(
    half > 45 && half < 55,
    `expected roughly half of 100, got ${half}`,
  );

  // Windows entirely outside the bucket contribute nothing.
  assert.equal(apportionDecade(100, 2000, { fromYear: 1955, toYear: 1960 }), 0);
  assert.equal(apportionDecade(0, 2000, period), 0);
  assert.equal(apportionDecade(null, 2000, period), 0);
});

test('four-digit and legacy two-digit decade keys both decode to the right era', () => {
  const period = { fromYear: 1955, toYear: 2025 };
  const bounds = { startYear: 1955, endYear: 2025 };

  const modern = windowCellCounts(
    { dc: { 1950: [10, 0], 2000: [20, 0] }, y0: 1955, y1: 2025 },
    period,
    bounds,
  );
  assert.equal(
    modern.hailCount,
    30,
    'four-digit keys must resolve to 1950 and 2000',
  );

  // A two-digit "50" is ambiguous with the 2050s. Decoding it with a naive
  // `+ 2000` maps it to 2050 and silently deletes the pre-2000 record, so the
  // inference has to consider the century.
  const legacy = windowCellCounts(
    { dc: { 50: [10, 0], '00': [20, 0] }, y0: 1955, y1: 2025 },
    period,
    bounds,
  );
  assert.equal(
    legacy.hailCount,
    30,
    'two-digit keys must resolve to 1950 and 2000',
  );
});

test('windowCellCounts preserves the full record when asked for the whole span', () => {
  // A cell whose entire record falls inside the requested period must return
  // exactly its own totals. This is the regression guard for two separate bugs:
  // a dropped pre-2000 decade, and a halved final decade.
  const cell = {
    dc: {
      1950: [2_214, 3_205],
      1960: [7_532, 10_114],
      1990: [71_400, 84_328],
      2000: [137_278, 128_809],
      2020: [51_251, 116_060],
    },
    hs: 100,
    ws: 90,
    hx: 4.5,
    wx: 90,
    cd: 10,
    y0: 1955,
    y1: 2025,
  };
  const bounds = { startYear: 1955, endYear: 2025 };
  const total = windowCellCounts(
    cell,
    { fromYear: 1955, toYear: 2025 },
    bounds,
  );
  assert.equal(total.hailCount, 2_214 + 7_532 + 71_400 + 137_278 + 51_251);
  assert.equal(total.windCount, 3_205 + 10_114 + 84_328 + 128_809 + 116_060);
  assert.equal(total.partial, false, 'a full-record period is not partial');
});

test('windowCellCounts flags an interior period as approximated', () => {
  const cell = {
    dc: { 2000: [100, 100] },
    hs: 10,
    ws: 10,
    hx: 2,
    wx: 60,
    cd: 1,
    y0: 1955,
    y1: 2025,
  };
  const bounds = { startYear: 1955, endYear: 2025 };
  const partial = windowCellCounts(
    cell,
    { fromYear: 2005, toYear: 2009 },
    bounds,
  );
  assert.equal(
    partial.partial,
    true,
    'an interior slice must announce itself as apportioned',
  );
  const whole = windowCellCounts(
    cell,
    { fromYear: 1955, toYear: 2025 },
    bounds,
  );
  assert.equal(whole.partial, false);
});

test('blending keeps the score bounded and responds to every component', () => {
  assert.equal(blendScore({ observed: 0, modelled: 0, exposure: 0 }), 0);
  assert.equal(blendScore({ observed: 1, modelled: 1, exposure: 1 }), 1);
  for (const parts of [
    { observed: 0.5, modelled: 0.5, exposure: 0.5 },
    { observed: 2, modelled: -3, exposure: 0.9 },
    { observed: undefined, modelled: null, exposure: undefined },
  ]) {
    const score = blendScore(parts);
    assert.ok(score >= 0 && score <= 1, `score out of range: ${score}`);
  }
  // Re-weighting toward observed hazard must raise the score when observed
  // dominates, otherwise the weights are decorative.
  const weights = { observed: 0.9, modelled: 0.05, exposure: 0.05 };
  const parts = { observed: 1, modelled: 0, exposure: 0 };
  assert.ok(
    blendScore(parts, weights) >
      blendScore(parts, { ...weights, observed: 0.1 }),
  );
  assert.equal(
    DEFAULT_WEIGHTS.observed +
      DEFAULT_WEIGHTS.modelled +
      DEFAULT_WEIGHTS.exposure,
    1,
  );
});

test('severity bands match the FIRMS thresholds used elsewhere in the app', () => {
  assert.equal(severityBand(0.95), 'red');
  assert.equal(severityBand(0.72), 'red');
  assert.equal(severityBand(0.5), 'orange');
  assert.equal(severityBand(0.2), 'yellow');
  assert.equal(severityBand(0.05), 'blue');
  assert.equal(severityBand(NaN), 'blue');
});

test('polygon helpers handle Polygon, MultiPolygon, holes and null', () => {
  const square = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
      ],
    ],
  };
  assert.equal(pointInPolygon(square, 0.5, 0.5), true);
  assert.equal(pointInPolygon(square, 1.5, 0.5), false);

  const withHole = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [0, 4],
        [4, 4],
        [4, 0],
        [0, 0],
      ],
      [
        [1, 1],
        [1, 2],
        [2, 2],
        [2, 1],
        [1, 1],
      ],
    ],
  };
  assert.equal(pointInPolygon(withHole, 0.5, 0.5), true, 'inside the shell');
  assert.equal(pointInPolygon(withHole, 1.5, 1.5), false, 'inside the hole');

  const multi = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ],
      ],
      [
        [
          [5, 5],
          [5, 6],
          [6, 6],
          [6, 5],
          [5, 5],
        ],
      ],
    ],
  };
  assert.equal(pointInPolygon(multi, 0.5, 0.5), true);
  assert.equal(pointInPolygon(multi, 5.5, 5.5), true);
  assert.equal(pointInPolygon(multi, 3, 3), false);

  assert.equal(pointInPolygon(null, 0, 0), false);
  assert.equal(polygonCenter(null), null);
  assert.equal(polygonBounds(null), null);
  const center = polygonCenter(square);
  assert.ok(
    Math.abs(center.lon - 0.5) < 1e-9 && Math.abs(center.lat - 0.5) < 1e-9,
  );
});

// ---------------------------------------------------------------------------
// Dataset-level operations
// ---------------------------------------------------------------------------

/**
 * Mirrors the shape `toCountyRecord` actually produces. The keys matter: an
 * earlier version of this fixture used the raw GeoJSON keys `st`/`stn`, which
 * production code never sees, and that mismatch is exactly how a real bug —
 * every state-scoped county search silently returning nothing — survived.
 */
function county(overrides = {}) {
  return {
    fips: '048453',
    name: 'Bexar',
    state: 'TX',
    stateName: 'Texas',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-99, 29],
          [-99, 30],
          [-98, 30],
          [-98, 29],
          [-99, 29],
        ],
      ],
    },
    buildingValue: 5e9,
    nriHailRate: 0.0001,
    nriWindRate: 0.0002,
    ...overrides,
  };
}

function cell(overrides = {}) {
  return {
    i: 116,
    j: -396,
    lat: 29.13,
    lon: -98.63,
    hailCount: 200,
    hailSevere: 40,
    maxHailIn: 4.25,
    windCount: 150,
    windSevere: 20,
    maxWindKt: 88,
    compoundDays: 30,
    firstYear: 1955,
    lastYear: 2025,
    decades: { 1950: [20, 15], 2000: [180, 135] },
    ...overrides,
  };
}

test('a cell is assigned to the county that contains it, not a neighbour', () => {
  const cells = [cell()];
  // The neighbouring county has a much larger building stock, so if the join
  // picked by size rather than by containment this test would fail.
  const counties = [
    county({
      fips: '48001',
      name: 'Adjacent',
      buildingValue: 9e9,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-98, 29],
            [-98, 30],
            [-97, 30],
            [-97, 29],
            [-98, 29],
          ],
        ],
      },
    }),
    county({ fips: '048453', name: 'Bexar' }),
  ];
  const result = indexCellsToCounties(cells, counties);
  assert.equal(result.matchedCells, 1);
  assert.equal(result.byCell.get('116:-396').fips, '048453');
});

test('a cell outside every county is reported unmatched rather than misfiled', () => {
  const cells = [cell()];
  const faraway = county({
    fips: '48001',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-80, 40],
          [-80, 41],
          [-79, 41],
          [-79, 40],
          [-80, 40],
        ],
      ],
    },
  });
  const result = indexCellsToCounties(cells, [faraway]);
  assert.equal(result.matchedCells, 0);
  assert.equal(result.unmatchedCells, 1);
  assert.equal(result.byCell.size, 0);
});

test('scoreCells ranks by the blend and reports its own inputs', () => {
  const busy = cell();
  const quiet = cell({
    i: 117,
    j: -396,
    lat: 29.38,
    hailCount: 1,
    windCount: 0,
    decades: { 2020: [1, 0] },
    compoundDays: 0,
    maxWindKt: 0,
    maxHailIn: 0,
  });
  const dataset = {
    cells: [quiet, busy],
    countiesByCell: new Map([
      ['116:-396', county()],
      [
        '117:-396',
        county({
          fips: '48001',
          buildingValue: 1e6,
          nriHailRate: 1e-6,
          nriWindRate: 1e-6,
        }),
      ],
    ]),
    latestYear: 2025,
    earliestYear: 1955,
  };
  const rows = scoreCells(dataset, { fromYear: 1955, toYear: 2025 });
  assert.equal(rows.length, 2);
  assert.ok(rows[0].score > rows[1].score, 'the busier cell must rank first');
  assert.ok(rows[0].score >= 0.5 && rows[0].score <= 1);
  assert.ok(rows[0].modelled > 0, 'FEMA modelled rate must reach the score');
  assert.ok(rows[0].exposure > 0, 'building value must reach the score');
  assert.equal(rows[0].key, '116:-396');
  assert.ok(rows[0].compoundDays > 0);
  assert.equal(rows[0].county.name, 'Bexar');
  // The breakdown must be present so the UI can explain the colour.
  for (const field of [
    'observed',
    'modelled',
    'exposure',
    'band',
    'hailCount',
    'windCount',
  ]) {
    assert.ok(rows[0][field] !== undefined, `missing ${field}`);
  }
});

test('scoreCells honours the hazard toggles', () => {
  const dataset = {
    cells: [cell()],
    countiesByCell: new Map(),
    latestYear: 2025,
    earliestYear: 1955,
  };
  const hailOnly = scoreCells(dataset, {
    fromYear: 1955,
    toYear: 2025,
    includeWind: false,
  })[0];
  const windOnly = scoreCells(dataset, {
    fromYear: 1955,
    toYear: 2025,
    includeHail: false,
  })[0];
  assert.ok(hailOnly.hailCount > 0);
  assert.equal(
    hailOnly.windCount,
    0,
    'wind reports must not count when wind is excluded',
  );
  assert.equal(windOnly.hailCount, 0);
});

test('an empty dataset scores to an empty list instead of throwing', () => {
  assert.deepEqual(scoreCells(null), []);
  assert.deepEqual(scoreCells({ cells: [] }), []);
  assert.deepEqual(scoreCounties(null), []);
  assert.deepEqual(searchCounties(null, 'texas'), []);
});

test('scoreCounties ranks counties and carries the FEMA NRI attributes through', () => {
  const counties = [
    county({
      fips: '48001',
      name: 'Adjacent',
      buildingValue: 1e6,
      decades: { 1950: [1, 1] },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-98, 29],
            [-98, 30],
            [-97, 30],
            [-97, 29],
            [-98, 29],
          ],
        ],
      },
    }),
    county({ fips: '048453', name: 'Bexar', decades: { 1950: [200, 150] } }),
  ];
  const rows = scoreCounties(counties, { fromYear: 1955, toYear: 2025 });
  assert.equal(rows[0].fips, '048453');
  assert.equal(rows[0].nriHailRate, 0.0001);
  assert.ok(rows[0].hailCount > rows[1].hailCount);
  assert.ok(rows[0].buildingValue > 0);
});

test('county search ranks exact, prefix and substring matches in that order', () => {
  const counties = [
    county({ fips: '1', name: 'Cook', state: 'IL', stateName: 'Illinois' }),
    county({ fips: '2', name: 'Cookson', state: 'MN', stateName: 'Minnesota' }),
    county({
      fips: '3',
      name: 'Hancock Cook',
      state: 'IL',
      stateName: 'Illinois',
    }),
    county({ fips: '4', name: 'Travis', state: 'TX', stateName: 'Texas' }),
  ];
  const results = searchCounties(counties, 'Cook');
  assert.equal(results[0].name, 'Cook', 'an exact name must rank first');
  assert.ok(
    results.some((c) => c.name === 'Cookson'),
    'a prefix match must be found',
  );
  assert.ok(
    results.some((c) => c.name === 'Hancock Cook'),
    'a substring match must be found',
  );
  assert.ok(
    !results.some((c) => c.name === 'Travis'),
    'a non-match must be excluded',
  );
  assert.ok(
    results.findIndex((c) => c.name === 'Cook') <
      results.findIndex((c) => c.name === 'Cookson'),
    'exact must outrank prefix',
  );
  assert.equal(searchCounties(counties, '').length, 0);
});

test('describeCellScore explains the number and admits its own uncertainty', () => {
  const row = {
    key: '1:2',
    score: 0.81,
    hailCount: 412,
    windCount: 253,
    maxHailIn: 4.6,
    maxWindKt: 88,
    compoundDays: 18,
    firstYear: 1958,
    lastYear: 2025,
    partial: true,
    county: { name: 'Bexar', st: 'TX' },
  };
  const copy = describeCellScore(row);
  assert.match(copy.title, /Risk 81%/);
  assert.ok(copy.details.some((d) => d.includes('412 hail')));
  assert.ok(copy.details.some((d) => d.includes('4.60"')));
  assert.ok(copy.details.some((d) => d.includes('88 kt')));
  assert.ok(copy.details.some((d) => d.includes('18 hail+wind')));
  assert.ok(
    copy.caveat.includes('apportioned'),
    'must disclose the approximation',
  );
  assert.ok(copy.caveat.includes('1958'), 'must disclose the record span');
  assert.ok(copy.caveat.includes('Bexar'), 'must disclose the modelled source');
});
test('county search accepts the state-qualified forms people actually type', () => {
  const counties = [
    county({ fips: '1', name: 'Cook', state: 'IL', stateName: 'Illinois' }),
    county({ fips: '2', name: 'Cook', state: 'MN', stateName: 'Minnesota' }),
    county({ fips: '3', name: 'Polk', state: 'IA', stateName: 'Iowa' }),
    county({ fips: '4', name: 'Polk', state: 'MN', stateName: 'Minnesota' }),
  ];
  const cases = [
    ['Cook Illinois', 'Cook', 'IL'],
    ['cook, il', 'Cook', 'IL'],
    ['Cook County, Illinois', 'Cook', 'IL'],
    ['polk iowa', 'Polk', 'IA'],
    ['Polk, IA', 'Polk', 'IA'],
  ];
  for (const [query, name, state] of cases) {
    const results = searchCounties(counties, query);
    assert.ok(results.length > 0, `"${query}" should match something`);
    assert.equal(
      results[0].name,
      name,
      `"${query}" ranks the right county first`,
    );
    assert.equal(
      results[0].state,
      state,
      `"${query}" filters to the right state`,
    );
    assert.ok(
      results.every((r) => r.state === state),
      `"${query}" must not return other states`,
    );
  }
});

test('county search can list a state by name or code', () => {
  const counties = [
    county({ fips: '1', name: 'Cook', state: 'IL', stateName: 'Illinois' }),
    county({ fips: '2', name: 'Adams', state: 'IL', stateName: 'Illinois' }),
    county({ fips: '3', name: 'Travis', state: 'TX', stateName: 'Texas' }),
  ];
  assert.deepEqual(
    searchCounties(counties, 'illinois').map((c) => c.fips),
    ['2', '1'],
    'a bare state name lists that state only',
  );
  assert.equal(searchCounties(counties, 'Illinois', 1).length, 1);
  assert.equal(
    searchCounties(counties, 'wyoming').length,
    0,
    'a state nobody is in returns nothing',
  );
});

test('a state qualifier that contradicts the county excludes it', () => {
  const counties = [
    county({ fips: '1', name: 'Cook', state: 'IL', stateName: 'Illinois' }),
  ];
  assert.equal(searchCounties(counties, 'Cook Texas').length, 0);
});

test('scoreCells exposes the county state code on each row', () => {
  const rows = scoreCells(
    {
      cells: [cell()],
      countiesByCell: new Map([
        [
          '116:-396',
          county({ fips: '048453', state: 'TX', stateName: 'Texas' }),
        ],
      ]),
      latestYear: 2026,
      earliestYear: 1955,
    },
    { toYear: 2026 },
  );
  assert.equal(rows[0].county.state, 'TX', 'the summary key is populated');
});

// --- exact per-year windows (stage 2) ---------------------------------------
//
// The decade histogram can only answer a year window by prorating: scaling a
// ten-year bucket by the fraction of it that falls in the window. That assumes
// reports were spread evenly through time. They were not — SPC filing exploded
// after ~1995 — and the result is a fractional report count on roughly half of
// all cells. Per-year tallies answer the same question exactly.

test('a cell with per-year buckets is filtered, not prorated', () => {
  const years = new Map([
    [1975, { hail: 10, wind: 5 }],
    [1980, { hail: 20, wind: 8 }],
    [1984, { hail: 30, wind: 12 }],
    [2000, { hail: 99, wind: 99 }],
  ]);
  const c = cell({ years, decades: { 1970: [60, 25], 2000: [99, 99] } });

  // A window that clips the 1970s bucket mid-decade. Prorating would return
  // 60 * (9/10) = 54; counting returns the exact 60.
  const got = windowCellCounts(c, { fromYear: 1975, toYear: 1984 });
  assert.equal(
    got.hailCount,
    60,
    'counts every report inside the window exactly',
  );
  assert.equal(got.windCount, 25);
  assert.equal(got.partial, false, 'an exact window is never partial');
});

test('exact counts are integers; prorated ones are not', () => {
  const years = new Map([
    [1975, { hail: 10, wind: 5 }],
    [1979, { hail: 30, wind: 15 }],
  ]);
  // The record must extend past the window, or the decade bucket is treated as
  // fully available and apportionDecade hands back the whole count — correct,
  // but not the proration being contrasted here.
  const c = cell({
    years,
    decades: { 1970: [40, 20] },
    firstYear: 1970,
    lastYear: 1985,
  });

  const exact = windowCellCounts(c, { fromYear: 1975, toYear: 1979 });
  assert.ok(
    Number.isInteger(exact.hailCount),
    'per-year path must not invent fractions',
  );
  assert.equal(exact.hailCount, 40, 'both in-window years are counted exactly');

  // Same cell, per-year buckets removed: falls back to the decade histogram.
  const { years: _drop, ...withoutYears } = c;
  const prorated = windowCellCounts(withoutYears, {
    fromYear: 1975,
    toYear: 1979,
  });
  assert.equal(prorated.hailCount, 20, 'five of ten years -> half of 40');
  assert.equal(
    prorated.partial,
    true,
    'the fallback flags itself as an estimate',
  );
});

test('a window outside the recorded years yields nothing, not the whole record', () => {
  const years = new Map([[1985, { hail: 7, wind: 3 }]]);
  const got = windowCellCounts(cell({ years }), {
    fromYear: 2015,
    toYear: 2025,
  });
  assert.equal(got.hailCount, 0);
  assert.equal(got.windCount, 0);
});

test('per-year buckets take precedence over decades when both are present', () => {
  // The decade table is deliberately wrong here; if the scorer preferred it the
  // answer would be 999 rather than the true 4.
  const years = new Map([
    [2016, { hail: 2, wind: 1 }],
    [2017, { hail: 2, wind: 1 }],
  ]);
  const got = windowCellCounts(cell({ years, decades: { 2010: [999, 999] } }), {
    fromYear: 2015,
    toYear: 2025,
  });
  assert.equal(got.hailCount, 4);
  assert.equal(got.windCount, 2);
});

test('a cell whose per-year list failed to decode still scores from decades', () => {
  // An old or damaged snapshot must degrade to an estimate, not to nothing.
  const got = windowCellCounts(
    cell({ years: new Map(), decades: { 2000: [180, 135] } }),
    {
      fromYear: 1955,
      toYear: 2025,
    },
  );
  assert.equal(
    got.hailCount,
    180,
    'falls back rather than rendering an empty cell',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { GRID_DEG, gridCell } from '../../data/stormCrossReference.js';
import {
  HAIL_BANDS,
  HAIL_NICKNAMES,
  MAX_FRAME_ALTITUDE_M,
  MAX_OUTLINE_RADIUS_KM,
  MIN_FRAME_ALTITUDE_M,
  MIN_OUTLINE_RADIUS_KM,
  OUTLINE_CAVEAT,
  OUTLINE_POINT_COUNT,
  WIND_BANDS,
  bandFor,
  bandHailNickname,
  destinationPointKm,
  frameAltitude,
  framingFor,
  gridCellRings,
  hailBand,
  hailNickname,
  hailSizeLabel,
  haversineKm,
  isolationLine,
  magnitudeLabel,
  ringsToDegrees,
  matchesFilter,
  outlineRing,
  parseStormDate,
  radarSwathCells,
  radiusMetres,
  reportedSwathCells,
  stormHeadline,
  stormMagnitude,
  stormMinuteLabel,
  stormPlaces,
  stormTimeRange,
  windBand,
  worstFirst,
  downsampleMaxCells,
} from './model.js';

const report = (over = {}) => ({
  date: '2026-08-10',
  minute: 600,
  hazard: 'hail',
  size: 1.75,
  lat: 35.1,
  lon: -97.4,
  countyFips: '40027',
  county: 'Cleveland',
  state: 'OK',
  loss: 0,
  comment: null,
  sources: ['spc-bulk'],
  trace: false,
  ...over,
});

test('a magnitude lands in exactly one band', () => {
  for (let v = 0.25; v <= 4; v += 0.05) {
    const band = hailBand(v);
    assert.ok(band, `${v} has a band`);
    assert.ok(v >= band.min && v < band.max, `${v} is inside ${band.label}`);
  }
});

test('the band boundaries are the ones the labels claim', () => {
  assert.equal(hailBand(0.75).label, '0.75–1.0"');
  assert.equal(hailBand(1.0).label, '1.0–1.5"');
  assert.equal(hailBand(1.75).label, '1.5–2.0"');
  assert.equal(hailBand(2.75).label, 'over 2.75"');
  assert.equal(windBand(58).label, '58–65 kt');
});

test('an absent magnitude is not drawn as though it were a small one', () => {
  assert.equal(hailBand(null), null);
  assert.equal(hailBand(undefined), null);
  assert.equal(windBand(NaN), null);
  assert.equal(bandFor(null, HAIL_BANDS), null);
});

test('severity increases with magnitude', () => {
  const radii = [0.5, 1, 1.75, 2.5, 3].map((v) => radiusMetres(v, 'hail'));
  for (let i = 1; i < radii.length; i += 1) {
    assert.ok(radii[i] > radii[i - 1], `radius ${i} grows`);
  }
});

test('the radius is capped so a national view is not a solid sheet', () => {
  assert.ok(radiusMetres(99, 'hail') <= 7000);
});

test('the size filter is inclusive at the bar', () => {
  assert.equal(
    matchesFilter(report(), { hazard: 'hail', minSize: 1.75 }),
    true,
  );
  assert.equal(
    matchesFilter(report(), { hazard: 'hail', minSize: 2.0 }),
    false,
  );
  assert.equal(
    matchesFilter(report({ size: null }), { minSize: 1.0 }),
    false,
    'a report with no measurement never satisfies a size bar',
  );
});

test('a report with no county is excluded by a county filter', () => {
  assert.equal(
    matchesFilter(report({ countyFips: null }), { countyFips: ['40027'] }),
    false,
  );
  assert.equal(
    matchesFilter(report({ countyFips: '40027' }), { countyFips: ['40027'] }),
    true,
  );
});

test('the date window is inclusive at both ends', () => {
  assert.equal(
    matchesFilter(report(), { from: '2026-08-10', to: '2026-08-10' }),
    true,
  );
  assert.equal(matchesFilter(report(), { from: '2026-08-11' }), false);
  assert.equal(matchesFilter(report(), { to: '2026-08-09' }), false);
});

test('a radius filter measures from the given centre', () => {
  const near = matchesFilter(report(), {
    center: { lat: 35.1, lon: -97.4 },
    radiusKm: 20,
  });
  const far = matchesFilter(report(), {
    center: { lat: 40, lon: -100 },
    radiusKm: 20,
  });
  assert.equal(near, true);
  assert.equal(far, false);
});

test('an empty filter matches everything', () => {
  assert.equal(matchesFilter(report(), {}), true);
});

test('worst first is what a canvasser works down', () => {
  const reports = [
    report({ id: 'a', size: 1.0 }),
    report({ id: 'b', size: 2.5 }),
    report({ id: 'c', size: 1.75 }),
  ];
  assert.deepEqual(
    worstFirst(reports, 'hail').map((r) => r.size),
    [2.5, 1.75, 1.0],
  );
  assert.equal(
    worstFirst(reports, 'wind').length,
    0,
    'the other hazard is empty, not full of nulls',
  );
});

test('a label carries the unit the hazard actually uses', () => {
  assert.equal(magnitudeLabel(report({ size: 1.75 })), '1.75 hail');
  assert.equal(
    magnitudeLabel(report({ hazard: 'wind', size: 62 })),
    '62 kt wind',
  );
  assert.equal(magnitudeLabel(report({ size: null, trace: true })), 'trace');
  assert.equal(magnitudeLabel(report({ size: null })), 'not measured');
});

test('a half inch is not padded into two decimal places', () => {
  assert.equal(magnitudeLabel(report({ size: 1.5 })), '1.5 hail');
  assert.equal(magnitudeLabel(report({ size: 2 })), '2 hail');
});

test('bands are contiguous with no gap a size could fall through', () => {
  for (const bands of [HAIL_BANDS, WIND_BANDS]) {
    for (let i = 1; i < bands.length; i += 1) {
      assert.equal(
        bands[i].min,
        bands[i - 1].max,
        `${bands[i].label} starts where the last ended`,
      );
    }
  }
});

test('distance is sane enough to gate on', () => {
  assert.ok(haversineKm(35.1, -97.4, 35.1, -97.4) < 0.01);
  assert.ok(haversineKm(39.74, -104.99, 40.015, -105.27) > 35);
});

const TODAY = '2026-10-15';
const at = (day, month, year) => parseStormDate(day, { today: TODAY });

test('reads an ISO date', () => {
  assert.equal(at('2026-08-11'), '2026-08-11');
  assert.equal(at('  2026-08-11  '), '2026-08-11');
});

test('reads a US numeric date', () => {
  assert.equal(at('8/11/2026'), '2026-08-11');
  assert.equal(at('08/11/2026'), '2026-08-11');
  assert.equal(at('8-11-26'), '2026-08-11');
});

test('a number too big for a month means day/month', () => {
  // 13 cannot be a month, so this can only be 13 November.
  assert.equal(at('13/11/2026'), '2026-11-13');
});

test('reads a month name, in either order', () => {
  assert.equal(at('Aug 11 2026'), '2026-08-11');
  assert.equal(at('August 11, 2026'), '2026-08-11');
  assert.equal(at('11 aug 2026'), '2026-08-11');
  assert.equal(at('Sept 6 2026'), '2026-09-06');
  assert.equal(at('Aug 11th 2026'), '2026-08-11');
});

test('a bare month and day means the most recent one already past', () => {
  assert.equal(at('Aug 11'), '2026-08-11', 'August has passed this year');
  assert.equal(at('Sep 30'), '2026-09-30');
  // December has not happened yet, so it means last December.
  assert.equal(at('Dec 3'), '2025-12-03');
});

test('refuses anything that is not a real date', () => {
  assert.equal(at('2026-02-30'), null, 'February has no 30th');
  assert.equal(at('2025-02-29'), null, '2025 is not a leap year');
  assert.equal(at('2024-02-29'), '2024-02-29', '2024 is');
  assert.equal(at('2026-13-01'), null);
  assert.equal(at('tomorrow'), null);
  assert.equal(at(''), null);
  assert.equal(at('   '), null);
  assert.equal(parseStormDate(null), null);
  assert.equal(parseStormDate(20260811), null, 'not a string');
});

test('framing a single report stays close', () => {
  const frame = framingFor([{ lat: 39.05, lon: -105.4 }]);
  assert.equal(frame.lat, 39.05);
  assert.equal(frame.lon, -105.4);
  assert.equal(frame.radiusKm, 0);
  assert.equal(frame.altitudeM, MIN_FRAME_ALTITUDE_M);
});

test('framing a spread centres it and backs off', () => {
  const frame = framingFor([
    { lat: 39.0, lon: -105.0 },
    { lat: 40.0, lon: -105.0 },
  ]);
  assert.ok(Math.abs(frame.lat - 39.5) < 0.001, 'centred between them');
  assert.ok(frame.radiusKm > 50, 'covers the whole spread, not half');
  assert.ok(frame.altitudeM > MIN_FRAME_ALTITUDE_M);
});

test('altitude is clamped at both ends', () => {
  assert.equal(frameAltitude(0), MIN_FRAME_ALTITUDE_M);
  assert.equal(frameAltitude(0.001), MIN_FRAME_ALTITUDE_M);
  assert.equal(frameAltitude(99999), MAX_FRAME_ALTITUDE_M);
});

test('framing nothing is null, not a zero-height camera', () => {
  assert.equal(framingFor([]), null);
  assert.equal(framingFor(null), null);
  assert.equal(framingFor([{ lat: NaN, lon: -105 }]), null);
});

/* -------------------------------------------------------------------------
 * The approximate outline.
 *
 * Pure geometry, no viewer: the ring generator is what a NaN vertex and a
 * zero-radius polygon would break, and both are easier to prove here than
 * through Cesium.
 * ---------------------------------------------------------------------- */

test('the ring is as many points as it claims, all finite', () => {
  const ring = outlineRing({ lat: 35.5, lon: -97.4, radiusKm: 40 });
  assert.equal(ring.length, OUTLINE_POINT_COUNT);
  assert.ok(
    ring.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)),
    'one non-finite vertex makes the whole polygon NaN',
  );
});

test('the ring sits the framing radius away from the centre', () => {
  const frame = { lat: 35.5, lon: -97.4, radiusKm: 40 };
  const ring = outlineRing(frame);
  for (const point of ring) {
    const km = haversineKm(frame.lat, frame.lon, point.lat, point.lon);
    // Great-circle vs. the fixed-radius construction: close, not identical.
    assert.ok(
      Math.abs(km - 40) < 0.5,
      `a ring point ${km.toFixed(3)} km out is not a 40 km ring`,
    );
  }
});

test('a one-report storm still gets a shape', () => {
  // framingFor returns radiusKm 0 for one report, and three identical points is
  // not a polygon - Cesium rejects it.
  const ring = outlineRing(framingFor([{ lat: 35.1, lon: -97.4 }]));
  assert.equal(ring.length, OUTLINE_POINT_COUNT);
  const km = haversineKm(35.1, -97.4, ring[0].lat, ring[0].lon);
  assert.ok(
    Math.abs(km - MIN_OUTLINE_RADIUS_KM) < 0.5,
    `floored to the county-scale minimum, got ${km.toFixed(2)}`,
  );
});

test('a storm spread across a state is capped rather than drawn whole', () => {
  const ring = outlineRing({
    lat: 35.5,
    lon: -97.4,
    radiusKm: 5000,
  });
  const km = haversineKm(35.5, -97.4, ring[0].lat, ring[0].lon);
  assert.ok(
    Math.abs(km - MAX_OUTLINE_RADIUS_KM) < 0.5,
    'a ring over a third of a state would read as a measurement',
  );
});

test('an unusable framing draws nothing at all', () => {
  assert.deepEqual(outlineRing(null), []);
  assert.deepEqual(outlineRing({ lat: NaN, lon: -97.4 }), []);
  assert.deepEqual(outlineRing({ lat: 35.1, lon: undefined }), []);
});

test('a nonsense point count falls back to the default rather than a stub', () => {
  assert.equal(
    outlineRing({ lat: 35, lon: -97 }, { count: 2 }).length,
    OUTLINE_POINT_COUNT,
  );
  assert.equal(outlineRing({ lat: 35, lon: -97 }, { count: 12 }).length, 12);
});

test('a destination point walks a real distance', () => {
  // A degree of latitude is about 111 km, and that is the whole claim the
  // radius makes.
  const north = destinationPointKm(35, -97, 0, 111.19);
  assert.ok(Math.abs(north.lat - 36) < 0.001, 'due north');
  assert.ok(Math.abs(north.lon - -97) < 0.001, 'not sideways');
  const east = destinationPointKm(0, 0, Math.PI / 2, (Math.PI * 6371) / 2);
  assert.ok(
    Math.abs(east.lat) < 1e-6,
    'a quarter turn from the equator is on it',
  );
  assert.ok(Math.abs(east.lon - 90) < 1e-6, 'and a quarter turn east');
  assert.ok(
    Math.abs(east.lon) <= 180.000001,
    'longitude is wrapped into [-180, 180]',
  );
});

test('the outline caveat says what the shape is not', () => {
  assert.match(OUTLINE_CAVEAT, /[Aa]pproximate/);
  assert.match(OUTLINE_CAVEAT, /not a measured storm boundary/);
  assert.match(OUTLINE_CAVEAT, /publishes no storm polygons/);
  assert.match(
    OUTLINE_CAVEAT,
    /fallen well outside it/,
    'the failure mode, named',
  );
});

/* -------------------------------------------------------------------------
 * The storm list's wording.
 * ---------------------------------------------------------------------- */

test('a storm headline counts what is in view, not what the event claims', () => {
  const storm = {
    maxHailIn: 3.25,
    maxWindKt: 62,
    counties: ['Noble', 'Cleveland'],
    states: ['OK'],
  };
  assert.match(stormHeadline(storm, 4), /^4 reports/);
  assert.match(stormHeadline(storm, 4), /3\.25" hail \/ 62 kt wind/);
  assert.match(stormHeadline(storm, 1), /^1 report\b/);
  // With no count given, the event's own total is the fallback.
  assert.match(stormHeadline({ ...storm, reportCount: 41 }), /^41 reports/);
});

test('a magnitude of zero is a hazard nobody measured, not a measurement', () => {
  const storm = { maxHailIn: 0, maxWindKt: 0, hazards: ['wind'] };
  assert.equal(stormMagnitude(storm), 'wind');
  assert.doesNotMatch(stormHeadline(storm, 2), /0" hail/);
});

test('places name two counties and admit there are more', () => {
  assert.equal(
    stormPlaces({ counties: ['A', 'B', 'C', 'D'], states: ['OK'] }),
    'A, B, +2 more · OK',
  );
  assert.equal(stormPlaces({}), null);
});

test('a time window reads as a window, and a missing one as its start', () => {
  assert.equal(
    stormTimeRange({ beginMinute: 930, endMinute: 1015 }),
    '15:30Z-16:55Z',
  );
  assert.equal(stormTimeRange({ beginMinute: 930, endMinute: 930 }), '15:30Z');
  assert.equal(stormTimeRange({ beginMinute: 930 }), '15:30Z');
  assert.equal(stormTimeRange({}), null);
  assert.equal(stormMinuteLabel(1440), null, 'a day has no 24:00');
  assert.equal(stormMinuteLabel(-1), null);
});

test('the isolation line counts what is inside, and says so when it is off', () => {
  assert.equal(
    isolationLine('Texas', { inside: 1342, total: 7484, active: true }),
    '1342 of 7484 reports inside Texas',
  );
  // "Off" has to be legible. A chip that reads inactive and a map that no
  // longer says why is the same silent failure this layer keeps having.
  assert.equal(
    isolationLine('Texas', { inside: 1342, total: 7484, active: false }),
    'isolation off — 1342 of 7484 reports inside Texas',
  );
  assert.equal(
    isolationLine('Bavaria, Germany', {
      inside: 0,
      total: 900,
      active: true,
    }),
    '0 of 900 reports inside Bavaria, Germany',
  );
});

test("the isolation line quotes a storm's own reports when it is given them", () => {
  assert.equal(
    isolationLine('Travis County, Texas', {
      inside: 12,
      total: 40,
      active: true,
      subject: "this storm's reports",
    }),
    "12 of 40 this storm's reports inside Travis County, Texas",
  );
});

test('a place repeats its own approximate label in the isolation line', () => {
  // `describeIsolation` owns the wording; the line has to carry whatever it
  // says verbatim, because the half of that sentence that says "approximate" is
  // the half that stops a box around a point being read as a boundary.
  const describe =
    'New York City, United States — approximate: point with a radius, no boundary data';
  const line = isolationLine(describe, { inside: 3, total: 40, active: true });
  assert.match(line, /^3 of 40 reports inside /);
  assert.match(line, /approximate: point with a radius/);
});

test('an isolation line with no counts reads as zero rather than NaN', () => {
  assert.equal(
    isolationLine('Texas', { active: true }),
    '0 of 0 reports inside Texas',
  );
  assert.equal(
    isolationLine('Texas', { inside: 4, active: false }),
    'isolation off — 4 of 4 reports inside Texas',
  );
});

/* -------------------------------------------------------------------------
 * The REPORTED swath.
 *
 * A cell here is a claim that a stone was measured in it, so the tests are
 * about what may not appear as much as what does: no report, no cell.
 * ---------------------------------------------------------------------- */

const FAR = { lat: 40.2, lon: -100.6 };

test('a cell no report landed in is never drawn', () => {
  const cells = reportedSwathCells([report()]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].key, `140:-390`);
  // The empty cell next door has a key, and still must not appear.
  assert.ok(
    !cells.some((cell) => cell.key === `140:-391`),
    'no report, no pixel',
  );
});

test('the largest stone in a cell colours it', () => {
  const cells = reportedSwathCells([
    report({ size: 1.0 }),
    report({ size: 2.5 }),
    report({ size: 1.75 }),
  ]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].peak, 2.5);
  assert.equal(cells[0].count, 3);
  assert.equal(cells[0].band.id, 'severe');
});

test('the floor keeps the trace of 0.01 inch off the map', () => {
  const cells = reportedSwathCells(
    [report({ size: 0.01, lat: 35.1 }), report({ size: 1.0, ...FAR })],
    { hailFloor: 1.0 },
  );
  assert.equal(cells.length, 1, 'only the cell above the floor survives');
  assert.equal(cells[0].peak, 1.0);
  // Without the floor both are honest measurements and both appear.
  assert.equal(
    reportedSwathCells(
      [report({ size: 0.01, lat: 35.1 }), report({ size: 1.0, ...FAR })],
      { hailFloor: 0 },
    ).length,
    2,
  );
});

test('two cells land in the bands their own stone earns', () => {
  const cells = reportedSwathCells([
    report({ size: 0.9, lat: 35.1 }),
    report({ size: 2.5, ...FAR }),
  ]);
  const byKey = new Map(cells.map((cell) => [cell.key, cell]));
  assert.equal(byKey.get(`140:-390`).band.id, 'small');
  assert.equal(byKey.get(`160:-403`).band.id, 'severe');
});

test('a swath cell key is the exact key the cross-reference joins on', () => {
  const [cell] = reportedSwathCells([report({ lat: 35.1, lon: -97.4 })]);
  assert.equal(cell.key, `${gridCell(35.1)}:${gridCell(-97.4)}`);
  assert.equal(cell.lat, gridCell(35.1) * GRID_DEG + GRID_DEG / 2);
  assert.equal(cell.lon, gridCell(-97.4) * GRID_DEG + GRID_DEG / 2);
  assert.equal(cell.bounds.south, gridCell(35.1) * GRID_DEG);
  assert.equal(cell.bounds.east, (gridCell(-97.4) + 1) * GRID_DEG);
});

test('a wind report is not hail and does not paint a hail swath', () => {
  assert.equal(
    reportedSwathCells([report({ hazard: 'wind', size: 62 })]).length,
    0,
  );
  assert.equal(reportedSwathCells([report({ size: null })]).length, 0);
});

/* -------------------------------------------------------------------------
 * The RADAR swath.
 * ---------------------------------------------------------------------- */

const day = (date, entries) => ({
  date,
  cells: new Map(Object.entries(entries)),
});

test('a swath for the wrong day draws nothing, not every day', () => {
  const radarDays = day('2026-08-10', { '140:-390': 80 });
  assert.deepEqual(
    radarSwathCells(radarDays, { date: '2026-08-11' }),
    [],
    'a mismatched date is empty, not a lifetime fallback',
  );
  assert.equal(radarSwathCells(radarDays, { date: '2026-08-10' }).length, 1);
});

test('a bare cell map names no day and so matches none', () => {
  const bare = new Map([['140:-390', 80]]);
  assert.deepEqual(radarSwathCells(bare, { date: '2026-08-10' }), []);
});

test('the peak per cell is the cell reading, and implausible is flagged', () => {
  const radarDays = day('2026-08-10', {
    '140:-390': 42.5,
    '160:-403': 150,
  });
  const cells = radarSwathCells(radarDays, { date: '2026-08-10' });
  assert.equal(cells.length, 2, 'the artefact cell is kept, not dropped');
  const byKey = new Map(cells.map((cell) => [cell.key, cell]));
  assert.equal(byKey.get(`140:-390`).peakMm, 42.5);
  assert.equal(byKey.get(`140:-390`).implausible, false);
  assert.equal(byKey.get(`160:-403`).peakMm, 150);
  assert.equal(byKey.get(`160:-403`).implausible, true);
});

test('the artefact threshold is a parameter, not a hidden constant', () => {
  const radarDays = day('2026-08-10', { '140:-390': 60 });
  assert.equal(
    radarSwathCells(radarDays, {
      date: '2026-08-10',
      implausibleMm: 50,
    })[0].implausible,
    true,
  );
});

/* -------------------------------------------------------------------------
 * Size-to-object nicknames.
 * ---------------------------------------------------------------------- */

test('the named sizes map to the objects the category uses', () => {
  assert.equal(hailNickname(1.0), 'quarter');
  assert.equal(hailNickname(1.75), 'golf ball');
  assert.equal(hailNickname(2.0), 'hen egg');
  assert.equal(hailNickname(2.5), 'tennis ball');
});

test('an unknown size yields no nickname rather than a wrong one', () => {
  assert.equal(hailNickname(1.1), null);
  assert.equal(hailNickname(null), null);
  assert.equal(hailNickname(undefined), null);
  assert.equal(hailNickname(1.1), null);
  assert.equal(hailSizeLabel(1.1), '1.1"', 'the measurement still renders');
});

test('a label renders the size through trimInches', () => {
  assert.equal(hailSizeLabel(2.5), '2.5" (tennis ball)');
  assert.equal(hailSizeLabel(2), '2" (hen egg)', 'no padded 2.00');
  assert.equal(hailSizeLabel(null), null);
});

test('a metric caller is refused rather than given a foreign object', () => {
  // 25 mm is a hen egg in Denver and a large grape in Toulouse, so a table of
  // US customary objects must not answer for a metric size at all.
  assert.equal(hailNickname(25, { unit: 'mm' }), null);
  assert.equal(hailNickname(2.5, { unit: 'mm' }), null, 'even on a match');
  assert.equal(
    hailSizeLabel(25, { unit: 'mm' }),
    null,
    'and no inch-formatted label either',
  );
});

test('every band has a peer object, including the unnamed ones', () => {
  for (const band of HAIL_BANDS) {
    assert.ok(
      bandHailNickname(band),
      `${band.label} is drawn as a bare number otherwise`,
    );
  }
  assert.equal(HAIL_NICKNAMES.find((n) => n.object === 'tennis ball').inches, 2.5);
});

// ===========================================================================
// Swath rings: the cells have to become POLYGONS before they can read as a
// swath. These tests are written to be killed by the old behaviour — draw a
// rectangle per cell and every one of them fails.
// ===========================================================================

test('a single cell becomes one ring of four corners', () => {
  const rings = gridCellRings([{ i: 136, j: -404 }]);
  assert.equal(rings.length, 1, 'one landmass');
  assert.equal(rings[0].holes.length, 0, 'and no hole in it');
  assert.equal(rings[0].outer.length, 4, 'four corners, closed');
  // Cell corners in INDEX space, so the renderer only has to multiply by the
  // grid step. Getting this wrong would shift every swath by half a cell.
  const corners = rings[0].outer.map(([i, j]) => `${i}:${j}`).sort();
  assert.deepEqual(corners, [
    '136:-403',
    '136:-404',
    '137:-403',
    '137:-404',
  ]);
});

test('a run of cells in a line is ONE ring, not one ring per cell', () => {
  const rings = gridCellRings([
    { i: 0, j: 0 },
    { i: 0, j: 1 },
    { i: 0, j: 2 },
  ]);
  assert.equal(rings.length, 1, 'three cells in a row are one landmass');
  assert.equal(
    rings[0].outer.length,
    4,
    'a 1x3 strip is a rectangle, so collinear vertices are collapsed to four',
  );
  // The long side must still be three cells long, not one: collapsing
  // collinear vertices must not collapse the EDGE. Checking the extent is what
  // catches a version that wrongly drops the run's far end.
  const js = rings[0].outer.map(([, j]) => j);
  assert.equal(Math.min(...js), 0, 'starts at the first cell');
  assert.equal(Math.max(...js), 3, 'and runs to one past the last cell');
});

test('a solid block collapses to its four corners', () => {
  const cells = [];
  for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) cells.push({ i, j });
  const rings = gridCellRings(cells);
  assert.equal(rings.length, 1, 'a 4x4 block is one landmass');
  assert.equal(
    rings[0].outer.length,
    4,
    'and its boundary is four corners, not sixteen lattice steps',
  );
  assert.equal(rings[0].holes.length, 0, 'with no hole inside it');
  // Collapsing collinear vertices must not shrink the shape.
  const js = rings[0].outer.map(([, j]) => j);
  assert.equal(Math.max(...js), 4, 'four cells across is still four cells wide');
});

test('a donut keeps its hole, and the hole is inside the outer ring', () => {
  const cells = [];
  // 3x3 with the middle removed.
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      if (i === 1 && j === 1) continue;
      cells.push({ i, j });
    }
  }
  const rings = gridCellRings(cells);
  assert.equal(rings.length, 1, 'the ring of eight is one landmass');
  assert.equal(rings[0].holes.length, 1, 'with the missing cell punched out');
  // The hole must be the inner square, not the outer one. Cesium takes holes as
  // a second hierarchy; handing it the outer ring here would fill the donut and
  // silently lose the shape.
  const hole = rings[0].holes[0];
  assert.equal(hole.length, 4, 'the hole is a square');
  const holeI = hole.map(([i]) => i);
  const holeJ = hole.map(([, j]) => j);
  assert.deepEqual([...new Set(holeI)].sort(), [1, 2], 'hole spans i 1..2');
  assert.deepEqual([...new Set(holeJ)].sort(), [1, 2], 'hole spans j 1..2');
});

test('two separated groups are two landmasses, neither swallowing the other', () => {
  const rings = gridCellRings([
    { i: 0, j: 0 },
    { i: 10, j: 10 },
  ]);
  assert.equal(rings.length, 2, 'diagonal cells never touch');
  for (const ring of rings) assert.equal(ring.holes.length, 0);
});

test('the ring order and winding are deterministic across runs', () => {
  const cells = [
    { i: 1, j: 1 },
    { i: 0, j: 0 },
    { i: 0, j: 1 },
    { i: 1, j: 0 },
  ];
  const first = JSON.stringify(gridCellRings(cells));
  // Reversed input order must not change the geometry: a renderer that orders
  // rings by input would repaint differently between two identical days.
  const second = JSON.stringify(gridCellRings([...cells].reverse()));
  assert.equal(first, second, 'input order does not reach the output');
});

test('junk in the cell list is dropped, not turned into geometry', () => {
  const rings = gridCellRings([
    { i: 1, j: 1 },
    null,
    { i: NaN, j: 2 },
    { i: 'x', j: 'y' },
    { i: 1.5, j: 2 },
  ]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].outer.length, 4, 'only the one real cell drew');
});

test('an empty set is no rings at all', () => {
  assert.deepEqual(gridCellRings([]), []);
  assert.deepEqual(gridCellRings(null), []);
});

test('ringsToDegrees multiplies by the grid step and adds no offset', () => {
  const [ring] = gridCellRings([{ i: 136, j: -404 }]);
  const [degrees] = ringsToDegrees([ring]);
  // The step is 0.25 degrees, and a corner is `index * step` — NOT
  // `index * step + step / 2`, which is the CENTRE rule. Using the centre rule
  // here would displace every swath by half a cell, which is 14 km and looks
  // like nothing at all.
  for (const point of degrees.outer) {
    assert.ok(Math.abs(point.lat % GRID_DEG) < 1e-9, 'lat is on the step');
    assert.ok(Math.abs(point.lon % GRID_DEG) < 1e-9, 'lon is on the step');
  }
  const lats = degrees.outer.map((p) => p.lat);
  assert.equal(Math.min(...lats), 136 * GRID_DEG, 'the south edge, exactly');
  assert.equal(Math.max(...lats), 137 * GRID_DEG, 'and the north edge');
});

test('pooling the fine field keeps the MAXIMUM, and the field is maxMm', () => {
  // A cell's value is the biggest hail that fell in it, so the biggest hail
  // in five cells is the biggest hail in the cell they become. Averaging
  // would answer a different question and would dissolve the cores.
  const cells = [
    { i: 0, j: 0, maxMm: 30 },
    { i: 1, j: 0, maxMm: 60 },
    { i: 4, j: 4, maxMm: 45 },
    { i: 5, j: 0, maxMm: 20 },
  ];
  const pooled = downsampleMaxCells(cells, 5);
  assert.equal(pooled.length, 2, 'four cells become two 5x5 cells');
  const first = pooled.find((cell) => cell.i === 0 && cell.j === 0);
  assert.equal(first.maxMm, 60, 'the maximum of the first group');
  // The field name matters: the fine path reads `maxMm`, and a pooled cell
  // that carried `peakMm` would arrive as a reading of zero and the mid tier
  // would draw nothing at all.
  assert.equal(first.peakMm, undefined);
  // And the negative side floors correctly: the cell -1 spans [-0.01, 0) and
  // the cell -5 spans [-0.05, -0.04).
  const negative = downsampleMaxCells([{ i: -1, j: 0, maxMm: 10 }], 5);
  assert.equal(negative[0].i, -1, 'a negative cell floors into its own group');
});

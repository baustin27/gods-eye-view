import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HAIL_BANDS,
  MAX_FRAME_ALTITUDE_M,
  MAX_OUTLINE_RADIUS_KM,
  MIN_FRAME_ALTITUDE_M,
  MIN_OUTLINE_RADIUS_KM,
  OUTLINE_CAVEAT,
  OUTLINE_POINT_COUNT,
  WIND_BANDS,
  bandFor,
  destinationPointKm,
  frameAltitude,
  framingFor,
  hailBand,
  haversineKm,
  isolationLine,
  magnitudeLabel,
  matchesFilter,
  outlineRing,
  parseStormDate,
  radiusMetres,
  stormHeadline,
  stormMagnitude,
  stormMinuteLabel,
  stormPlaces,
  stormTimeRange,
  windBand,
  worstFirst,
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

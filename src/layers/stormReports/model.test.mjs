import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HAIL_BANDS,
  WIND_BANDS,
  bandFor,
  hailBand,
  haversineKm,
  magnitudeLabel,
  matchesFilter,
  radiusMetres,
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

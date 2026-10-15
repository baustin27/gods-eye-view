import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DATA_SCOPE,
  SCOPE_GLOBAL,
  SCOPE_VIEWPORT,
  VIEWPORT_SCOPE_MAX_SPAN_DEG,
  quantizeStepForSpan,
  normalizeDataScopeMode,
  regionForScope,
  regionFromViewRect,
  regionKey,
  regionToQueryParam,
  regionToFirmsBbox,
} from './dataScope.js';

const rect = (south, west, north, east) => ({ south, west, north, east });

test('only the two known modes are honoured', () => {
  assert.equal(normalizeDataScopeMode('viewport'), SCOPE_VIEWPORT);
  assert.equal(normalizeDataScopeMode('global'), SCOPE_GLOBAL);
  assert.equal(normalizeDataScopeMode(undefined), DEFAULT_DATA_SCOPE);
  assert.equal(normalizeDataScopeMode('nonsense'), DEFAULT_DATA_SCOPE);
  assert.equal(normalizeDataScopeMode(null), DEFAULT_DATA_SCOPE);
});

test('global mode asks for no spatial filter', () => {
  assert.equal(
    regionForScope(SCOPE_GLOBAL, rect(39, -106, 40, -105)),
    null,
    'global must not produce a region, or every provider pays a filter',
  );
});

test('viewport mode derives a region from the view', () => {
  const region = regionForScope(
    SCOPE_VIEWPORT,
    rect(39.5, -105.5, 39.9, -105.1),
  );
  assert.ok(region, 'viewport mode must produce a region');
  assert.ok(
    region.south <= 39.5 && region.north >= 39.9,
    'must cover the view',
  );
  assert.ok(
    region.west <= -105.5 && region.east >= -105.1,
    'must cover the view',
  );
});

test('a pan smaller than the grid reuses one cache key', () => {
  // The quota guard: a provider miss costs a transaction (FIRMS charges one per
  // source), so a pan that stays inside the current cell must not change the
  // key or every drag would spend quota.
  const a = regionFromViewRect(rect(39.59, -105.41, 39.63, -105.37));
  const nudged = regionFromViewRect(
    rect(39.5905, -105.4105, 39.6305, -105.3695),
  );
  assert.equal(
    regionKey(nudged),
    regionKey(a),
    'a sub-cell pan must not change the key',
  );

  // A pan across cell boundaries must change it, or the key means nothing.
  const far = regionFromViewRect(rect(41.5, -105.5, 41.7, -105.3));
  assert.notEqual(regionKey(a), regionKey(far));
});

test('snapping is outward, so edge features are never excluded', () => {
  const region = regionFromViewRect(rect(39.51, -105.49, 39.53, -105.47));
  assert.ok(
    region.south <= 39.51 && region.north >= 39.53,
    'a region rounding inward would drop on-screen features',
  );
});

test('a continental view is clamped, not honoured in full', () => {
  // 40° tall. Without the clamp this would ask for most of the country — the
  // exact expensive case global mode already exists for.
  const region = regionFromViewRect(rect(20, -120, 60, -80));
  assert.ok(region.north - region.south <= VIEWPORT_SCOPE_MAX_SPAN_DEG + 1e-9);
  assert.ok(region.east - region.west <= VIEWPORT_SCOPE_MAX_SPAN_DEG + 1e-9);
});

test('a street-level view still asks for a real area', () => {
  // Millimetre-scale rectangle: without a floor this would request a box so
  // small the provider rounds it away and returns everything anyway.
  const region = regionFromViewRect(
    rect(39.7906, -105.1291, 39.7907, -105.129),
  );
  assert.ok(region.north - region.south > 0, 'the region must have height');
  assert.ok(region.east - region.west > 0, 'the region must have width');
});

test('impossible rectangles are refused rather than coerced', () => {
  // Number(null) is 0, so a missing edge could silently become the Gulf of
  // Guinea and read as a hit.
  assert.equal(regionFromViewRect(rect(39, -105, 40, null)), null);
  assert.equal(regionFromViewRect(rect(39, -105, 40, undefined)), null);
  assert.equal(regionFromViewRect(rect(40, -105, 39, -104)), null, 'inverted');
  assert.equal(regionFromViewRect({}), null);
  assert.equal(regionFromViewRect(null), null);
  assert.equal(
    regionFromViewRect(rect(-95, -105, 40, -104)),
    null,
    'off the globe',
  );
});

test('extreme latitudes stay inside the globe', () => {
  const region = regionFromViewRect(rect(89.5, -10, 90, 10));
  assert.ok(region.north <= 90, 'north must not exceed the pole');
  assert.ok(region.south >= -90);
});

test('the query param round-trips to FIRMS area syntax', () => {
  const region = regionFromViewRect(rect(39.5, -105.5, 39.9, -105.1));
  const query = regionToQueryParam(region);
  assert.match(query, /^-?\d+\.\d{2},-?\d+\.\d{2},-?\d+\.\d{2},-?\d+\.\d{2}$/);
  assert.equal(query.split(',').length, 4, 'FIRMS wants south,west,north,east');
  assert.equal(regionToQueryParam(null), '', 'global sends no filter');
});

test('the quantize grid tightens as the view does', () => {
  // The point of the adaptive step: zooming in must actually narrow the
  // request, which a single fixed grid cannot do in both directions.
  assert.ok(
    quantizeStepForSpan(0.05) < quantizeStepForSpan(0.15),
    'a tighter view must get a finer grid',
  );
  assert.ok(
    quantizeStepForSpan(0.15) < quantizeStepForSpan(0.4),
    'and it must keep tightening',
  );
  assert.ok(
    quantizeStepForSpan(0.4) < quantizeStepForSpan(0.9),
    'up to the clamp',
  );

  // Within one tier the grid is stable, so a small pan still reuses a key.
  assert.equal(quantizeStepForSpan(0.2), quantizeStepForSpan(0.24));

  // And the emitted precision is finer than the grid in every tier, so keys
  // cannot vary within a single cell.
  for (const span of [0.03, 0.2, 0.45, 0.9]) {
    const step = quantizeStepForSpan(span);
    assert.ok(step <= Math.max(span, 0.02), `step ${step} for span ${span}`);
  }
});

test('a street-level view is no longer widened to a quarter degree', () => {
  // Regression guard: a 0.25° floor once made zoom irrelevant, always
  // requesting a box a few kilometres across no matter how close the camera.
  const tight = regionFromViewRect(
    rect(39.7906, -105.1291, 39.7908, -105.1289),
  );
  assert.ok(
    tight.north - tight.south <= 0.05,
    `street-level span should stay tight, got ${tight.north - tight.south}`,
  );
  const city = regionFromViewRect(rect(39.5, -105.5, 39.9, -105.1));
  assert.ok(
    city.north - city.south < 0.6,
    'and a city view must stay proportionally tighter than before',
  );
});

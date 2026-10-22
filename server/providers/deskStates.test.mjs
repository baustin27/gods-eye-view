/**
 * The state outlines the desk's map draws.
 *
 * The map draws one county's streets and tracts, and the state line is what
 * says where the county is. A state line drawn in the wrong place, or for
 * the wrong country, is worse than no line at all - so the postal code is
 * resolved INSIDE the United States, because "CO" is Colorado and a
 * province in Algeria.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stateOutline } from './deskStates.js';

test('a state has an outline', () => {
  const colorado = stateOutline('CO');
  assert.ok(colorado, 'Colorado has an outline');
  assert.equal(colorado.name, 'Colorado');
  assert.ok(colorado.rings.length, 'with at least one ring');
  const points = colorado.rings[0][0];
  assert.ok(points.length >= 3, 'and a ring with points');
});

test('the outline is in the right place', () => {
  const colorado = stateOutline('CO');
  const ring = colorado.rings[0][0];
  const lons = ring.map((point) => point[0]);
  const lats = ring.map((point) => point[1]);
  // Colorado's bounds, to a tenth of a degree. The outline is SIMPLIFIED, so
  // this is a box, not a boundary.
  assert.ok(Math.min(...lons) > -109.2 && Math.min(...lons) < -108.9);
  assert.ok(Math.max(...lons) > -102.2 && Math.max(...lons) < -101.9);
  assert.ok(Math.min(...lats) > 36.8 && Math.min(...lats) < 37.2);
  assert.ok(Math.max(...lats) > 40.8 && Math.max(...lats) < 41.1);
});

test('the postal code is resolved inside the United States', () => {
  // "CO" is Colorado and a province in Algeria, and the first match in the
  // pack is not the one we want.
  const colorado = stateOutline('CO');
  assert.equal(colorado.name, 'Colorado');
  assert.notEqual(colorado.name, 'Constantine');
});

test('a state that does not exist has no outline', () => {
  assert.equal(stateOutline('ZZ'), null);
  assert.equal(stateOutline(''), null);
});

test('the lookup is case-insensitive', () => {
  assert.equal(stateOutline('co').name, 'Colorado');
  assert.equal(stateOutline('Co').name, 'Colorado');
});

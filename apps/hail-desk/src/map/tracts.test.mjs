/**
 * The tract choropleth's ramp.
 *
 * A ramp that rescales with the data is a ramp that changes meaning every
 * time the map moves, and two maps of two storms are then not comparable. So
 * the scale is pinned, and these tests pin it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tractFill } from './tracts.js';

test('a tract with no houses is drawn, and drawn quietly', () => {
  for (const units of [null, undefined, NaN]) {
    const fill = tractFill(units);
    assert.match(fill, /^rgba\(\d+, \d+, \d+, 0\.0\d+\)$/);
  }
});

/** The alpha of an rgba colour, which is the ramp's value. */
const alpha = (rgba) => Number(rgba.split(',')[3].replace(')', ''));

test('the ramp is pinned, so two maps are comparable', () => {
  // The biggest tract in the data is at the top of the ramp, and it is at
  // the top of the ramp tomorrow too.
  const full = tractFill(5000);
  const half = tractFill(2500);
  assert.ok(alpha(full) > alpha(half));
  // And a tract with the SAME count has the same colour, whatever else is
  // on the map.
  assert.equal(tractFill(1234), tractFill(1234));
});

test('the ramp is logarithmic, so a small tract is not invisible', () => {
  // A linear ramp would put 100 units at a twentieth of the scale, which is
  // 0.02 of an alpha - a fill nobody can see.
  assert.ok(alpha(tractFill(100)) > 0.2);
  assert.ok(alpha(tractFill(0)) < alpha(tractFill(100)));
});

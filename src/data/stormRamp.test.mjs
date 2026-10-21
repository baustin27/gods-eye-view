/**
 * The storm ramp.
 *
 * The globe, the desk, the per-storm artifact and the gallery draw the same
 * weather. These tests are the guard that says they draw it the SAME way: a
 * ramp that drifts is four pictures of one storm that a person has to
 * reconcile, and the reconciliation is the reader's job when it should be
 * the code's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STORM_FLOOR_MM,
  STORM_RAMP,
  stormColorFor,
  stormRampDescending,
} from './stormRamp.js';
import { ARTWORK_BANDS } from './stormArtwork.js';

test('the floor is an inch, exactly', () => {
  assert.equal(STORM_FLOOR_MM, 25.4);
  assert.equal(STORM_RAMP[0].min, 25.4);
});

test('the ramp is five bands, coldest first, and it ascends', () => {
  assert.equal(STORM_RAMP.length, 5);
  for (let i = 1; i < STORM_RAMP.length; i += 1) {
    assert.ok(STORM_RAMP[i].min > STORM_RAMP[i - 1].min);
  }
});

test("a band's edge is the next hotter band's colour", () => {
  for (let i = 0; i < STORM_RAMP.length - 1; i += 1) {
    assert.equal(STORM_RAMP[i].outline, STORM_RAMP[i + 1].color);
  }
  // And the hottest band is edged in white, because there is no hotter band.
  assert.equal(STORM_RAMP[STORM_RAMP.length - 1].outline, '#ffffff');
});

test('the artifact and the gallery draw the SHARED ramp, not a copy', () => {
  assert.equal(ARTWORK_BANDS, STORM_RAMP);
});

test('the globe reads the same ramp, hottest first', () => {
  const descending = stormRampDescending();
  assert.equal(descending.length, STORM_RAMP.length);
  assert.equal(descending[0].min, STORM_RAMP[STORM_RAMP.length - 1].min);
  assert.equal(descending[descending.length - 1].min, STORM_RAMP[0].min);
  // The same colours, in the other order.
  assert.deepEqual(
    descending.map((step) => step.color).sort(),
    STORM_RAMP.map((step) => step.color).sort(),
  );
});

test('a reading under the floor has NO colour', () => {
  assert.equal(stormColorFor(25.3), null);
  assert.equal(stormColorFor(0), null);
  assert.equal(stormColorFor(NaN), null);
  assert.equal(stormColorFor(25.4), '#6d28d9');
  assert.equal(stormColorFor(100), '#fdf4ff');
});

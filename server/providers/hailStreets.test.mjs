import assert from 'node:assert/strict';
import test from 'node:test';

import { streetBounds } from './hailStreets.js';

test('street bounds cover every valid point and ignore invalid lines', () => {
  assert.deepEqual(streetBounds([-105, 39, -104.5, 38.5, -104.8, 39.2]), {
    west: -105,
    south: 38.5,
    east: -104.5,
    north: 39.2,
  });
  assert.equal(streetBounds([]), null);
  assert.equal(streetBounds([NaN, Infinity, null, undefined]), null);
});

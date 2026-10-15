import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOpenSkyStatesUrl } from './opensky.js';

test('an unscoped request keeps the world snapshot', () => {
  const url = buildOpenSkyStatesUrl('');
  assert.equal(url, 'https://opensky-network.org/api/states/all?extended=1');
  assert.equal(new URL(url).searchParams.get('lamin'), null);
});

test('a region becomes OpenSky named bbox params', () => {
  const url = new URL(buildOpenSkyStatesUrl('37.00,-109.10,41.00,-102.00'));
  // Named params, so the axes cannot be transposed the way the FIRMS area
  // segment can.
  assert.equal(url.searchParams.get('lamin'), '37');
  assert.equal(url.searchParams.get('lomin'), '-109.1');
  assert.equal(url.searchParams.get('lamax'), '41');
  assert.equal(url.searchParams.get('lomax'), '-102');
  assert.equal(url.searchParams.get('extended'), '1', 'extended must survive');
});

test('an unusable region falls back to world rather than a bad request', () => {
  // A malformed cache key should never become a silently wrong upstream query.
  assert.equal(
    buildOpenSkyStatesUrl('nonsense'),
    'https://opensky-network.org/api/states/all?extended=1',
  );
  assert.equal(
    buildOpenSkyStatesUrl('1,2,3'),
    'https://opensky-network.org/api/states/all?extended=1',
  );
});

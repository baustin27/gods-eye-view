import assert from 'node:assert/strict';
import test from 'node:test';

import { createUsgsEarthquakeSource } from './source.js';

const SUMMARY =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

test('no scope keeps the keyless summary feed', () => {
  const src = createUsgsEarthquakeSource();
  assert.equal(src.buildUrl(null), SUMMARY);
});

test('a region switches to the FDSN query with named bounds', () => {
  const src = createUsgsEarthquakeSource();
  const url = new URL(
    src.buildUrl({ south: 37, west: -109.1, north: 41, east: -102 }),
  );
  // Named per parameter, so there is no positional axis order to get wrong.
  assert.equal(url.searchParams.get('minlatitude'), '37');
  assert.equal(url.searchParams.get('maxlatitude'), '41');
  assert.equal(url.searchParams.get('minlongitude'), '-109.1');
  assert.equal(url.searchParams.get('maxlongitude'), '-102');
  assert.equal(url.searchParams.get('format'), 'geojson');
});

test('getSnapshot asks for the scoped URL', async () => {
  const seen = [];
  const src = createUsgsEarthquakeSource({
    getScope: () => ({ region: { south: 1, west: 2, north: 3, east: 4 } }),
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, json: async () => ({ features: [] }) };
    },
  });
  await src.getSnapshot();
  assert.equal(seen.length, 1);
  assert.match(seen[0], /fdsnws\/event\/1\/query/);
  assert.match(seen[0], /minlatitude=1/);
});

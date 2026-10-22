import assert from 'node:assert/strict';
import test from 'node:test';

import { countyForTile, placesForState } from './deskGeography.js';
import { runDeskApi } from './deskApi.js';

test('the tile centre resolves to its own county, independently of the view scope', () => {
  const county = countyForTile(14, 3413, 6218);
  assert.equal(county?.geoid, '08031');
  assert.equal(county?.name, 'Denver County');
});

test('adjacent tract tiles return the county index identity from their geography', async () => {
  const jefferson = await runDeskApi(
    new URL('http://localhost/api/desk/tracts/14/3410/6218'),
  );
  const denver = await runDeskApi(
    new URL('http://localhost/api/desk/tracts/14/3411/6218'),
  );

  assert.equal(jefferson.status, 200);
  assert.equal(jefferson.geoid, '08059');
  assert.ok(jefferson.count > 0);
  assert.equal(denver.status, 200);
  assert.equal(denver.geoid, '08031');
  assert.ok(denver.count > 0);
});

test('place outlines are indexed by postal state and include the Census rings', () => {
  const colorado = placesForState(' co ');
  const coloradoSprings = colorado.find(
    (place) => place.name === 'Colorado Springs city',
  );

  assert.ok(colorado.length > 0);
  assert.ok(coloradoSprings);
  assert.ok(coloradoSprings.rings.length > 0);
  assert.ok(coloradoSprings.rings[0][0].length >= 3);
  assert.deepEqual(placesForState(''), []);
});

test('the places endpoint returns a state-scoped outline collection', async () => {
  const result = await runDeskApi(
    new URL('http://localhost/api/desk/places?state=CO'),
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.count, result.body.places.length);
  assert.ok(result.body.count > 0);
  assert.ok(result.body.places.every((place) => place.rings.length > 0));
});

test('an ocean tile has no county to load', async () => {
  const result = await runDeskApi(
    new URL('http://localhost/api/desk/tracts/14/6826/7262'),
  );

  assert.equal(result.status, 204);
  assert.equal(result.count, 0);
  assert.equal(result.geoid, undefined);
});

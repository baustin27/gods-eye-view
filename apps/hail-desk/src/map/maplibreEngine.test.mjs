import assert from 'node:assert/strict';
import test from 'node:test';
import {
  placesToGeoJson,
  stateOutlineToMaskGeoJson,
  swathBandsToGeoJson,
} from './maplibreData.js';

test('swathBandsToGeoJson converts artwork bands to valid GeoJSON polygons', () => {
  const bands = [
    {
      band: { color: '#6d28d9', outline: '#9333ea', label: '1-1.5"', min: 25.4 },
      outer: [
        { lon: -105.1, lat: 39.7 },
        { lon: -105.0, lat: 39.8 },
        { lon: -104.9, lat: 39.7 },
      ],
      holes: [
        [
          { lon: -105.05, lat: 39.72 },
          { lon: -105.0, lat: 39.75 },
          { lon: -104.95, lat: 39.72 },
        ],
      ],
    },
  ];

  const geojson = swathBandsToGeoJson(bands);
  assert.equal(geojson.type, 'FeatureCollection');
  assert.equal(geojson.features.length, 1);

  const feature = geojson.features[0];
  assert.equal(feature.geometry.type, 'Polygon');
  // First ring is outer, second ring is hole
  assert.equal(feature.geometry.coordinates.length, 2);

  // Assert ring closure
  const outer = feature.geometry.coordinates[0];
  assert.deepEqual(outer[0], outer[outer.length - 1]);
  assert.equal(outer.length, 4);

  const hole = feature.geometry.coordinates[1];
  assert.deepEqual(hole[0], hole[hole.length - 1]);

  // Assert properties
  assert.equal(feature.properties.color, '#6d28d9');
  assert.equal(feature.properties.outline, '#9333ea');
  assert.equal(feature.properties.label, '1-1.5"');
  assert.equal(feature.properties.min, 25.4);
});

test('swathBandsToGeoJson gracefully handles empty or invalid bands', () => {
  assert.deepEqual(swathBandsToGeoJson(null), {
    type: 'FeatureCollection',
    features: [],
  });
  assert.deepEqual(swathBandsToGeoJson([]), {
    type: 'FeatureCollection',
    features: [],
  });
  assert.deepEqual(swathBandsToGeoJson([{ outer: [{ lon: 1, lat: 2 }] }]), {
    type: 'FeatureCollection',
    features: [],
  });
});

test('placesToGeoJson scales share and outputs valid Point features', () => {
  const places = [
    { name: 'Denver', geoid: '0820000', state: 'CO', lon: -104.99, lat: 39.73, severe: 50 },
    { name: 'Aurora', geoid: '0804000', state: 'CO', lon: -104.83, lat: 39.72, severe: 25 },
    { name: 'Invalid', lon: NaN, lat: 39.0, severe: 0 },
  ];

  const geojson = placesToGeoJson(places, 100);
  assert.equal(geojson.features.length, 2);

  const denver = geojson.features[0];
  assert.equal(denver.geometry.type, 'Point');
  assert.deepEqual(denver.geometry.coordinates, [-104.99, 39.73]);
  assert.equal(denver.properties.name, 'Denver');
  assert.equal(denver.properties.severe, 50);
  assert.equal(denver.properties.share, 0.5);

  const aurora = geojson.features[1];
  assert.equal(aurora.properties.share, 0.25);
});

test('stateOutlineToMaskGeoJson constructs an inverted world mask with polygon holes', () => {
  const coloradoRings = [
    [
      [
        [-109.05, 37],
        [-102.05, 37],
        [-102.05, 41],
        [-109.05, 41],
      ],
    ],
  ];

  const mask = stateOutlineToMaskGeoJson(coloradoRings);
  assert.equal(mask.type, 'FeatureCollection');
  assert.equal(mask.features.length, 1);

  const polygon = mask.features[0].geometry;
  assert.equal(polygon.type, 'Polygon');
  // First coordinate ring is the outer world boundary
  assert.equal(polygon.coordinates.length, 2);

  const worldOuter = polygon.coordinates[0];
  assert.equal(worldOuter.length, 5);
  assert.deepEqual(worldOuter[0], [-180, -85]);

  const stateHole = polygon.coordinates[1];
  assert.deepEqual(stateHole[0], stateHole[stateHole.length - 1]);
});

test('stateOutlineToMaskGeoJson handles empty or invalid outline', () => {
  assert.deepEqual(stateOutlineToMaskGeoJson(null), {
    type: 'FeatureCollection',
    features: [],
  });
  assert.deepEqual(stateOutlineToMaskGeoJson([]), {
    type: 'FeatureCollection',
    features: [],
  });
});

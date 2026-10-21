import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTWORK_BANDS,
  artworkBands,
  artworkBounds,
  artworkPlaceBounds,
  escapeXml,
  pointInRingDegrees,
  stormArtwork,
} from './stormArtwork.js';

test('a band is the region between two levels, and the bands tile', () => {
  // Four adjacent cells at 45 mm - 1.77 inches, so the 1.5-2 inch band - and
  // one at 60 mm, which is in the 2-2.75 inch band.
  const cells = [
    { i: 3883, j: -10488, maxMm: 45 },
    { i: 3883, j: -10487, maxMm: 45 },
    { i: 3883, j: -10486, maxMm: 45 },
    { i: 3883, j: -10485, maxMm: 45 },
    { i: 3884, j: -10486, maxMm: 60 },
  ];
  const bands = artworkBands(cells);
  assert.ok(bands.length >= 1, 'there is at least one band');
  // Every band is one of the ramp's colours, and the band a cell is in is
  // the band whose range holds it.
  const colours = new Set(bands.map((band) => band.band.color));
  for (const colour of colours) {
    assert.ok(
      ARTWORK_BANDS.some((band) => band.color === colour),
      `${colour} is a ramp colour`,
    );
  }
});

test('a level with no cells in it is skipped, not drawn as an empty ring', () => {
  // One cell at 45 mm. The 1 inch band has cells in it, the 1.5 inch band has
  // cells in it, the 2 inch band has none, and a band with no cells in it is
  // the region between two levels with nothing between them.
  const bands = artworkBands([{ i: 3883, j: -10488, maxMm: 45 }]);
  const used = new Set(bands.map((band) => band.band.min));
  assert.ok(!used.has(50.8), 'the 2 inch band is not drawn');
  assert.ok(!used.has(69.85), 'nor the 2.75 inch band');
});

test('the cell bounds and the place bounds are not the same thing', () => {
  // The cells carry GRID INDICES and the places carry a latitude and a
  // longitude, and mixing them puts the frame in the middle of the Atlantic.
  const cellBounds = artworkBounds([{ i: 3883, j: -10488 }]);
  assert.ok(Math.abs(cellBounds.west - -104.88) < 0.2, 'the cells\' west edge');
  const placeBounds = artworkPlaceBounds([{ lat: 38.83, lon: -104.75 }]);
  assert.ok(Math.abs(placeBounds.west - -104.75) < 0.2, 'the places\' west edge');
  assert.ok(
    Math.abs(placeBounds.west - cellBounds.west) > 0.05,
    'and the two are not the same number',
  );
});

test('the place bounds have air around them', () => {
  const bounds = artworkPlaceBounds([
    { lat: 38.8, lon: -104.8 },
    { lat: 38.9, lon: -104.7 },
  ]);
  assert.ok(bounds.west < -104.8, 'the west edge is outside the westernmost place');
  assert.ok(bounds.east > -104.7, 'and the east edge outside the easternmost');
});

test('a point in a ring is in it, and a point outside it is not', () => {
  const ring = [
    { lat: 38.0, lon: -105.0 },
    { lat: 38.0, lon: -104.0 },
    { lat: 39.0, lon: -104.0 },
    { lat: 39.0, lon: -105.0 },
  ];
  assert.equal(pointInRingDegrees({ lat: 38.5, lon: -104.5 }, ring), true);
  assert.equal(pointInRingDegrees({ lat: 40.5, lon: -104.5 }, ring), false);
  assert.equal(pointInRingDegrees({ lat: 38.5, lon: -103.0 }, ring), false);
});

test('the artwork is an SVG with the day, the numbers and the sources on it', () => {
  const svg = stormArtwork({
    day: '2025-07-07',
    cells: [
      { i: 3883, j: -10488, maxMm: 45 },
      { i: 3884, j: -10488, maxMm: 95 },
    ],
    places: [{ name: 'Colorado Springs', st: 'CO', lat: 38.83, lon: -104.75, houses: 33850 }],
    maxMm: 95,
  });
  assert.match(svg, /^<svg /);
  assert.match(svg, /2025-07-07/);
  assert.match(svg, /95 mm/);
  assert.match(svg, /33,850 houses/);
  assert.match(svg, /Colorado Springs/);
  // The sources, because a picture that says where its numbers came from can
  // be attached to a claim and one that does not is an opinion.
  assert.match(svg, /MRMS MESH/);
  assert.match(svg, /B25001/);
  assert.match(svg, /not a claim that any roof was damaged/);
});

test('a place name with a bracket in it does not break the XML', () => {
  const svg = stormArtwork({
    day: '2025-07-07',
    cells: [{ i: 3883, j: -10488, maxMm: 45 }],
    places: [{ name: 'A & B <Village>', st: 'CO', lat: 38.8, lon: -104.8, houses: 10 }],
    maxMm: 45,
  });
  assert.match(svg, /A &amp; B &lt;Village&gt;/);
  assert.equal(escapeXml('a & b'), 'a &amp; b');
});

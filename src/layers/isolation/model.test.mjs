// Isolation mode: the scrim geometry and the camera arithmetic.
//
// The antimeridian case is the one worth testing hard, and it is tested twice
// over: once as an exact expectation for the United States (three rectangles,
// Aleutian sliver untouched) and once as a property sweep over a grid of points,
// which is the claim the layer actually makes to a reader — everything outside is
// dimmed, everything inside is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAME_ALTITUDE_FACTOR,
  MAX_FRAME_ALTITUDE_M,
  MIN_FRAME_ALTITUDE_M,
  framingForBoxes,
  frameAltitude,
  isolationBoxes,
  scrimRectangles,
  splitNote,
} from './model.js';

/** Texas, comfortably inside the world. */
const TEXAS = [-106.6, 25.8, -93.5, 36.5];

/** The bundled United States bbox, which crosses the date line. */
const UNITED_STATES = [-187.5, 18.9, -67.0, 71.4];

/** Fiji: a small arc straddling the seam. */
const FIJI = [177.0, -19.2, 181.8, -12.5];

const covers = ([west, south, east, north], lat, lon) =>
  lat >= south && lat <= north && lon >= west && lon <= east;

const inAnyBox = (boxes, lat, lon) =>
  boxes.some((box) => covers(box, lat, lon));
const inAnyScrim = (rects, lat, lon) =>
  rects.some((rect) => covers(rect, lat, lon));

/**
 * Sample the whole globe off the grid lines.
 *
 * Offsets of 2.5° from a multiple of 5 keep every sample clear of the box edges
 * this suite uses, so a boundary-touching sample can never be mistaken for a
 * hole in the scrim.
 */
function* globePoints() {
  for (let lat = -87.5; lat < 90; lat += 5) {
    for (let lon = -177.5; lon < 180; lon += 5) yield [lat, lon];
  }
}

test('a mid-world box is dimmed from four sides', () => {
  const rects = scrimRectangles([TEXAS]);
  // North of it, south of it, west of it, and east of it. The longitude
  // complement wraps at the seam, so "west of" and "east of" are two shapes
  // rather than one band running off the edge of the world.
  assert.equal(rects.length, 4);
  assert.deepEqual(rects, [
    [-180, -90, 180, 25.8],
    [-180, 25.8, -106.6, 36.5],
    [-93.5, 25.8, 180, 36.5],
    [-180, 36.5, 180, 90],
  ]);
});

test('the United States splits into the Aleutians and everything else', () => {
  const boxes = isolationBoxes({ bbox: UNITED_STATES });
  assert.equal(boxes.length, 2, 'a straddling bbox becomes two boxes');
  assert.deepEqual(boxes, [
    [172.5, 18.9, 180, 71.4],
    [-180, 18.9, -67.0, 71.4],
  ]);
  const rects = scrimRectangles(boxes);
  assert.equal(
    rects.length,
    3,
    'the complement of the PAIR, not of each box: the band between them is one shape',
  );
  assert.deepEqual(rects, [
    [-180, -90, 180, 18.9],
    [-67.0, 18.9, 172.5, 71.4],
    [-180, 71.4, 180, 90],
  ]);
});

test('the scrim does not dim the sliver the split exists to preserve', () => {
  // Per-box complements would paint over the Aleutians and over the seam. This
  // is the whole reason `scrimRectangles` takes the set.
  const boxes = isolationBoxes({ bbox: UNITED_STATES });
  const rects = scrimRectangles(boxes);
  for (const lat of [20, 35, 52, 53.5, 70]) {
    assert.ok(
      !inAnyScrim(rects, lat, 175),
      `the Aleutian sliver at ${lat}N 175E must stay lit`,
    );
    assert.ok(
      !inAnyScrim(rects, lat, -179),
      `the seam sliver at ${lat}N 179W must stay lit`,
    );
    assert.ok(
      !inAnyScrim(rects, lat, -100),
      `the mainland at ${lat}N 100W must stay lit`,
    );
    assert.ok(
      inAnyScrim(rects, lat, 0),
      `the mid-Atlantic at ${lat}N 0E must be dimmed`,
    );
    assert.ok(
      inAnyScrim(rects, lat, 100),
      `the mid-Pacific at ${lat}N 100E must be dimmed`,
    );
  }
});

test('a small arc across the seam dims everything but its own sliver', () => {
  const boxes = isolationBoxes({ bbox: FIJI });
  assert.equal(boxes.length, 2);
  const rects = scrimRectangles(boxes);
  // Both boxes share a latitude span, so the complement is the two latitude
  // caps plus the one longitude band between the halves.
  assert.equal(rects.length, 3);
  assert.ok(!inAnyScrim(rects, -16, 178.5), 'Fiji itself stays lit');
  assert.ok(!inAnyScrim(rects, -16, -179), 'the western half stays lit');
  assert.ok(inAnyScrim(rects, -16, 0), 'everything else is dimmed');
  assert.ok(inAnyScrim(rects, -60, 179), 'north and south of it are dimmed');
});

test('the scrim covers the complement and nothing else, on a grid sweep', () => {
  // The claim stated as a property rather than as three expected arrays, so a
  // future change to the merge that is still correct cannot fail here, and a
  // change that is not cannot pass.
  const cases = [
    ['Texas', [TEXAS]],
    ['United States', isolationBoxes({ bbox: UNITED_STATES })],
    ['Fiji', isolationBoxes({ bbox: FIJI })],
    ['Russia', isolationBoxes({ bbox: [19.6, 41.2, 190.4, 81.3] })],
    ['California', [[-124.4, 32.5, -114.1, 42.0]]],
    ['Norway', [[4.6, 57.9, 31.1, 71.2]]],
  ];
  for (const [name, boxes] of cases) {
    const rects = scrimRectangles(boxes);
    let dimmedOutside = 0;
    let litInside = 0;
    const edges = new Set(
      boxes.flatMap((box) => [box[0], box[1], box[2], box[3]]),
    );
    for (const [lat, lon] of globePoints()) {
      // A sample landing exactly on an edge belongs to both shapes under an
      // inclusive containment test, which is true of Cesium's rectangles too and
      // says nothing about whether the scrim has a hole in it.
      if (edges.has(lat) || edges.has(lon)) continue;
      const inside = inAnyBox(boxes, lat, lon);
      const dimmed = inAnyScrim(rects, lat, lon);
      if (inside) {
        assert.equal(
          dimmed,
          false,
          `${name}: ${lat}N ${lon}E is inside the isolation and must not be dimmed`,
        );
        litInside += 1;
      } else if (!dimmed) {
        assert.fail(`${name}: ${lat}N ${lon}E is outside and was left lit`);
      } else {
        dimmedOutside += 1;
      }
    }
    assert.ok(dimmedOutside > 0 && litInside > 0, `${name} swept both kinds`);
  }
});

test('no isolation and a world-sized isolation dim nothing', () => {
  assert.deepEqual(scrimRectangles([]), []);
  assert.deepEqual(scrimRectangles(null), []);
  assert.deepEqual(scrimRectangles(undefined), []);
  assert.deepEqual(
    scrimRectangles([[-180, -90, 180, 90]]),
    [],
    'there is nothing outside the world',
  );
});

test('unusable boxes are dropped rather than clamped into a lie', () => {
  assert.deepEqual(scrimRectangles([[Number.NaN, 0, 10, 10]]), []);
  assert.deepEqual(scrimRectangles([['a', 0, 10, 10]]), []);
  assert.deepEqual(scrimRectangles([[1, 2, 3]]), []);
  // A degenerate box is a line, not an area: drawing a scrim around it would dim
  // the world for no reason.
  assert.deepEqual(scrimRectangles([[10, 0, 10, 10]]), []);
  assert.deepEqual(scrimRectangles([[0, 5, 10, 5]]), []);
  // Clamped onto the world rather than drawn off the edge of it: a box reaching
  // past the seam is still a box, and its visible part is the eastern limit.
  assert.deepEqual(scrimRectangles([[-200, 25.8, -93.5, 36.5]]), [
    [-180, -90, 180, 25.8],
    [-93.5, 25.8, 180, 36.5],
    [-180, 36.5, 180, 90],
  ]);
  // Wholly off the map it collapses to a line and is dropped, rather than
  // becoming a box that dims everything.
  assert.deepEqual(scrimRectangles([[-200, -100, -190, -80]]), []);
});

test('isolationBoxes accepts an area, a resolveIsolation hit, or a bbox', () => {
  const expected = [[-106.6, 25.8, -93.5, 36.5]];
  assert.deepEqual(isolationBoxes({ bbox: TEXAS }), expected);
  assert.deepEqual(isolationBoxes({ area: { bbox: TEXAS } }), expected);
  assert.deepEqual(isolationBoxes(TEXAS), expected);
  assert.deepEqual(isolationBoxes(null), []);
  assert.deepEqual(isolationBoxes({}), []);
  assert.deepEqual(isolationBoxes({ bbox: [] }), []);
  // A place is a point with a radius; it still has a box, so it still draws.
  assert.deepEqual(
    isolationBoxes({ kind: 'place', bbox: [-74, 40.6, -73.9, 40.8] }),
    [[-74, 40.6, -73.9, 40.8]],
  );
});

test('framingForBoxes puts the camera over the largest box', () => {
  const frame = framingForBoxes([TEXAS]);
  assert.equal(frame.lat, (25.8 + 36.5) / 2);
  assert.equal(frame.lon, (-106.6 + -93.5) / 2);
  assert.ok(
    frame.radiusKm > 800 && frame.radiusKm < 900,
    `radius ${frame.radiusKm}`,
  );
  assert.equal(frame.altitudeM, frameAltitude(frame.radiusKm));
  assert.equal(frame.index, 0);
  assert.deepEqual(frame.box, TEXAS);
  assert.deepEqual(framingForBoxes([]), null);
  assert.deepEqual(framingForBoxes(null), null);
});

test('a split isolation frames its mainland, not the whole arc', () => {
  const boxes = isolationBoxes({ bbox: UNITED_STATES });
  const frame = framingForBoxes(boxes);
  // Index 1 is [-180, 18.9, -67.0, 71.4] — the mainland. Index 0 is the
  // Aleutians.
  assert.equal(frame.index, 1);
  assert.equal(frame.lon, -123.5);
  assert.equal(frame.lat, (18.9 + 71.4) / 2);
  // The Aleutians at 172.5..180 are not inside the frame we chose, which is the
  // reason the split is reported rather than hidden.
  assert.ok(frame.lon < -67);
});

test('altitude is derived from the span and clamped at both ends', () => {
  assert.equal(frameAltitude(0), MIN_FRAME_ALTITUDE_M);
  assert.equal(frameAltitude(Number.NaN), MIN_FRAME_ALTITUDE_M);
  assert.equal(frameAltitude(-5), MIN_FRAME_ALTITUDE_M);
  // A small place stays above the county rather than inside it.
  assert.equal(frameAltitude(10), MIN_FRAME_ALTITUDE_M);
  // The scale is the field of view, not a magic number.
  assert.equal(
    frameAltitude(1000),
    Math.round(1000 * 1000 * FRAME_ALTITUDE_FACTOR),
  );
  // Bavaria.
  assert.ok(frameAltitude(600) > 1_000_000);
  // The whole planet's half-diagonal still cannot clear the ceiling.
  assert.equal(frameAltitude(1e9), MAX_FRAME_ALTITUDE_M);
});

test('a polar box frames without dividing by a vanishing cosine', () => {
  // Svalbard, near the top of the world: the longitude half-extent narrows with
  // the cosine of the latitude, and a camera sent to 80°N should not be sent to
  // infinity because of it.
  const frame = framingForBoxes([[-60, 78, 40, 83]]);
  assert.equal(frame.lat, 80.5);
  assert.equal(frame.lon, -10);
  assert.ok(
    Number.isFinite(frame.radiusKm) && frame.radiusKm > 0,
    `radius ${frame.radiusKm}`,
  );
  assert.equal(frame.altitudeM, frameAltitude(frame.radiusKm));
  // 100° of longitude at 80.5°N is nowhere near 100° of ground.
  assert.ok(frame.radiusKm < 1200, `polar radius ${frame.radiusKm}`);
});

test('splitNote says something only when the isolation was split', () => {
  assert.equal(splitNote([TEXAS]), '');
  assert.equal(splitNote([]), '');
  assert.equal(splitNote(null), '');
  const note = splitNote(isolationBoxes({ bbox: UNITED_STATES }));
  assert.match(note, /2 boxes/);
  assert.match(note, /antimeridian/);
});

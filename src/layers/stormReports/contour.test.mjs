import assert from 'node:assert/strict';
import test from 'node:test';

import { GRID_DEG, gridCell } from '../../data/stormCrossReference.js';
import {
  CONTOUR_CAVEAT,
  GRID_DEG_FINE,
  contourRings,
  radarSwathCells,
} from './model.js';

/**
 * Iso-contouring the radar field.
 *
 * The staircase it replaces is trivially correct - a grid boundary is easy to
 * trace - so these tests are all about the things a real contour gets wrong:
 * interpolated vertices, winding, holes, and the ambiguity at a saddle.
 */

/** A swath cell at a grid index, at a value. */
const at = (i, j, v) => ({ i, j, v });

/**
 * The bounding box of every vertex in a ring set, in GRID units.
 *
 * `contourRings` returns degrees, and the tests reason about where the line
 * falls relative to the cells it was drawn from - so this converts back rather
 * than having every assertion carry the offset convention by hand.
 */
function extent(rings, deg = GRID_DEG) {
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  const visit = (points) => {
    for (const point of points) {
      const y = (point.lat - deg / 2) / deg;
      const x = (point.lon - deg / 2) / deg;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  };
  for (const ring of rings) {
    visit(ring.outer);
    for (const hole of ring.holes) visit(hole);
  }
  return { minY, maxY, minX, maxX };
}

/**
 * How far from a sample the level is crossed, for a cell at `value`.
 *
 * Linear interpolation between a cell at 40 and a neighbour at 0 puts the 25.4
 * level OFFSET from the high cell, where OFFSET = (40 - 25.4) / 40. It is NOT
 * half a cell: half a cell is where a level halfway up the range sits, and
 * writing the expectations as "6.5 and 12.5" because the boundary LOOKS like
 * it should be halfway is how a contour test ends up asserting something
 * arbitrary and then passing for the wrong reason.
 */
const OFFSET = (40 - 25.4) / 40;

/** A square of cells `radius` across, all at `value`. */
const patch = (i, j, radius, value) => {
  const cells = [];
  for (let di = -radius; di < radius; di += 1)
    for (let dj = -radius; dj < radius; dj += 1)
      cells.push(at(i + di, j + dj, value));
  return cells;
};

test('an empty field contours to nothing', () => {
  assert.deepEqual(contourRings([], 25.4), []);
  assert.deepEqual(contourRings(null, 25.4), []);
  assert.deepEqual(contourRings(patch(10, 10, 2, 40), NaN), []);
});

test('a field entirely under the level contours to nothing', () => {
  // The cells exist and are real; they are just below the line. Drawing them
  // anyway is the same lie as painting them in the weakest band's colour.
  assert.deepEqual(contourRings(patch(10, 10, 2, 20), 25.4), []);
});

test('a square patch contours to a ring, with interpolated corners', () => {
  const rings = contourRings(patch(10, 10, 3, 40), 25.4);
  assert.equal(rings.length, 1, 'one ring');
  const { minY, maxY, minX, maxX } = extent(rings);
  // Inside samples run 7..12, so the contour sits OFFSET outside each end.
  assert.ok(Math.abs(minY - (7 - OFFSET)) < 1e-9, `top edge, got ${minY}`);
  assert.ok(Math.abs(maxY - (12 + OFFSET)) < 1e-9, `bottom edge, got ${maxY}`);
  assert.ok(Math.abs(minX - (7 - OFFSET)) < 1e-9, `left edge, got ${minX}`);
  assert.ok(Math.abs(maxX - (12 + OFFSET)) < 1e-9, `right edge, got ${maxX}`);
});

test('the contour lands BETWEEN cells, never on a cell edge', () => {
  // The whole point of the exercise. A staircase vertex is always on an
  // integer coordinate; a contour vertex must not be.
  const rings = contourRings(patch(10, 10, 3, 40), 25.4);
  // Every vertex lies ON a grid line in one axis and between samples in the
  // other, because a crossing always happens on an edge. What must never
  // happen is a vertex ON A SAMPLE - that is the staircase's signature, and it
  // is what makes the outline step.
  const onSample = rings[0].outer.filter((point) => {
    const y = (point.lat - GRID_DEG / 2) / GRID_DEG;
    const x = (point.lon - GRID_DEG / 2) / GRID_DEG;
    const whole = (n) => Math.abs(n - Math.round(n)) < 1e-9;
    return whole(y) && whole(x);
  });
  assert.equal(onSample.length, 0, 'no vertex sits on a sample');
});

test('a single cell still contours', () => {
  const rings = contourRings([at(10, 10, 40)], 25.4);
  assert.equal(rings.length, 1);
  const { minY, maxY, minX, maxX } = extent(rings);
  // One sample at (10,10) and zeros around it. A staircase would trace the
  // zero-area boundary and draw nothing at all; the contour gives a real shape
  // OFFSET across in both axes.
  assert.ok(Math.abs(maxY - minY - 2 * OFFSET) < 1e-9, 'a real width');
  assert.ok(Math.abs(maxX - minX - 2 * OFFSET) < 1e-9, 'and a real depth');
  assert.ok(Math.abs((minY + maxY) / 2 - 10) < 1e-9, 'centred on the cell');
});

test('a hole in the field comes back as a hole, not a filled disc', () => {
  // A ring-shaped storm. If the winding rule is inverted this renders as a
  // solid blob, which is the classic marching-squares failure and the reason
  // `contourRings` derives its winding from a cross product instead of a
  // hand-written case table.
  const cells = [];
  const outer = 8;
  const inner = 4;
  for (let di = -outer; di < outer; di += 1) {
    for (let dj = -outer; dj < outer; dj += 1) {
      const far = Math.max(Math.abs(di), Math.abs(dj));
      if (far >= inner && far < outer) cells.push(at(50 + di, 50 + dj, 40));
    }
  }
  const rings = contourRings(cells, 25.4);
  assert.equal(rings.length, 1, 'one outer ring');
  assert.equal(rings[0].holes.length, 1, 'carrying exactly one hole');
  const hole = rings[0].holes[0];
  const outerBox = extent(rings);
  const holeBox = {
    minY: Math.min(...hole.map((p) => p.lat)),
    maxY: Math.max(...hole.map((p) => p.lat)),
  };
  assert.ok(
    holeBox.maxY - holeBox.minY < outerBox.maxY - outerBox.minY,
    'the hole is smaller than the shape around it',
  );
});

test('two separate storms come back as two rings', () => {
  const cells = [...patch(10, 10, 2, 40), ...patch(60, 60, 2, 40)];
  const rings = contourRings(cells, 25.4);
  assert.equal(rings.length, 2, 'two separate shapes');
  for (const ring of rings) assert.equal(ring.holes.length, 0, 'neither has a hole');
});

test('a linear ramp contours to a straight line in the right place', () => {
  // Value rises with i. The level is crossed at a fixed i, so the contour is
  // the vertical line i = 20.25 exactly - which is checkable arithmetic rather
  // than eyeballing a shape.
  // Value 3 per step, level at 40: sample 13 reads 39 and sample 14 reads 42,
  // so the level is one third of the way between them.
  const cells = [];
  for (let i = 0; i <= 40; i += 1) {
    for (let j = 0; j <= 6; j += 1) cells.push(at(i, j, i * 3));
  }
  const rings = contourRings(cells, 40);
  assert.equal(rings.length, 1);
  // The ramp only rises, so everything above the crossing is above the level
  // and the shape is a half-plane band, not a closed loop. The low edge is the
  // crossing and the two side edges run the full width of the field, which is
  // what "vertical line" means for a contour.
  // The ramp only rises, so the region above the level reaches the edge of the
  // sampled field - and the contour follows it out past the last sample,
  // because outside the field reads as zero. The low edge is the crossing, and
  // that is the part with arithmetic in it.
  const { minY } = extent(rings);
  assert.ok(Math.abs(minY - (13 + 1 / 3)) < 1e-9, `crossing, got ${minY}`);
});

test('a diagonal ramp still produces a closed ring', () => {
  // The saddle case: the level passes through a square's two diagonal corners
  // at once, which is the only genuinely ambiguous configuration in marching
  // squares and the one that silently opens or closes holes.
  //
  // The slope is 1.5, not 1, on purpose. With an integer slope and an integer
  // level the level lands EXACTLY on a run of samples, and a contour that
  // grazes samples is a pinch point where the ring touches itself - a real
  // degeneracy, but one that makes this test assert something about the
  // chaining rather than about the saddle.
  const cells = [];
  for (let i = 0; i <= 20; i += 1)
    for (let j = 0; j <= 20; j += 1) cells.push(at(i, j, 1.5 * (i + j)));
  const rings = contourRings(cells, 20);
  assert.ok(rings.length >= 1, 'the diagonal resolves into a shape');
  for (const ring of rings) {
    assert.ok(ring.outer.length >= 3, 'every ring has an outline');
    const closed =
      ring.outer[0].lat === ring.outer.at(-1).lat &&
      ring.outer[0].lon === ring.outer.at(-1).lon;
    assert.ok(closed, 'and every ring closes on itself');
  }
});

test('outdegrees survive a saddle without hanging or duplicating', () => {
  const cells = [];
  for (let i = 0; i <= 30; i += 1)
    for (let j = 0; j <= 30; j += 1) cells.push(at(i, j, (i + j) % 2 ? 60 : 10));
  // A checkerboard is the worst case for chaining: every square is a saddle.
  const rings = contourRings(cells, 25.4);
  assert.ok(Array.isArray(rings));
  for (const ring of rings) assert.ok(ring.outer.length >= 3);
});

test('the level is compared against the value, not the presence', () => {
  // The original staircase asked "is this cell in the set", which draws the
  // same outline for a 26 mm cell and a 200 mm one. A contour must separate
  // them: only cells at or above the level contribute.
  const cells = [...patch(10, 10, 3, 60), ...patch(60, 60, 3, 26)];
  const rings = contourRings(cells, 25.4);
  assert.equal(rings.length, 2, 'both patches clear the level');
  const high = contourRings(cells, 50);
  assert.equal(high.length, 1, 'and at 50 mm only the 60 mm patch remains');
});

test('degrees come out on the grid, offset by half a cell', () => {
  const rings = contourRings(patch(0, 0, 2, 40), 25.4, GRID_DEG_FINE);
  assert.equal(rings.length, 1);
  // Sample (i, j) is the CENTRE of a cell, so a vertex at grid coordinate y
  // maps to y * deg + deg / 2 - the same convention `ringsToDegrees` uses for
  // cell corners, and the same one `gridCellRings` traces. Getting this wrong
  // puts every shape half a cell off, which on a 1 km grid is a kilometre.
  const { minY } = extent(rings);
  const expected = (-2 - OFFSET) * GRID_DEG_FINE + GRID_DEG_FINE / 2;
  const lats = rings[0].outer.map((point) => point.lat);
  const minLat = Math.min(...lats);
  assert.ok(
    Math.abs(minLat - expected) < 1e-9,
    `${minLat} vs ${expected} (grid ${minY})`,
  );
});

test('it reads real swath cells straight off the builder', () => {
  // The integration that matters. A storm report's exact location maps to
  // cell indices, and a bigger reading should push the contour outward - so
  // raising one cell's hail has to make the shape grow.
  const day = '2026-08-10';
  const small = radarSwathCells(
    { date: day, cells: new Map([['100:200', 30]]) },
    { date: day },
  );
  const big = radarSwathCells(
    {
      date: day,
      cells: new Map([
        ['100:200', 30],
        ['99:199', 30],
        ['98:198', 30],
      ]),
    },
    { date: day },
  );
  const smallRing = contourRings(
    small.map((c) => ({ i: c.i, j: c.j, v: c.peakMm })),
    25.4,
    GRID_DEG,
  );
  const bigRing = contourRings(
    big.map((c) => ({ i: c.i, j: c.j, v: c.peakMm })),
    25.4,
    GRID_DEG,
  );
  assert.equal(smallRing.length, 1);
  const smallSpan = extent(smallRing).maxX - extent(smallRing).minX;
  const bigSpan = extent(bigRing).maxX - extent(bigRing).minX;
  assert.ok(bigRing.length >= 1, 'three cells in a row make a shape');
  assert.ok(
    bigSpan > smallSpan,
    `a three-cell storm contours wider than a one-cell one: ${bigSpan} vs ${smallSpan}`,
  );
});

test('the caveat is stated wherever the line is drawn', () => {
  assert.match(CONTOUR_CAVEAT, /interpolated/i);
  assert.match(CONTOUR_CAVEAT, /not measured/i);
  assert.match(CONTOUR_CAVEAT, /largest hail in that cell/i);
});

test('gridCell still agrees with the indices the contour consumes', () => {
  // The contour works in raw `i`/`j`. If anything upstream renumbered those,
  // the shape would be right and in the wrong hemisphere.
  // Deliberately NOT on a cell boundary. 39.25 / -104.5 are exact multiples of
  // the 0.25 grid, so gridCell floors them to the cell BELOW and the report
  // sits on the edge of the shape drawn for it - a fixture that fails for a
  // reason that has nothing to do with the contour.
  const lat = 39.3;
  const lon = -104.4;
  const cell = { i: gridCell(lat, GRID_DEG), j: gridCell(lon, GRID_DEG) };
  const rings = contourRings([{ ...cell, v: 40 }], 25.4);
  // Compared in DEGREES. `extent` hands back grid indices, and comparing an
  // index near 157 against a latitude of 39 is a test that can only fail.
  const lats = rings[0].outer.map((point) => point.lat);
  const lons = rings[0].outer.map((point) => point.lon);
  assert.ok(
    Math.min(...lats) < lat && lat < Math.max(...lats),
    'the storm is drawn around the report that produced it',
  );
  assert.ok(
    Math.min(...lons) < lon && lon < Math.max(...lons),
    'in both axes',
  );
});
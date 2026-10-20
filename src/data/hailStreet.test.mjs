import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fineCellIndexAt,
  hailFraction,
  hitCellSet,
  polylineLengthMetres,
} from './hailStreet.js';

/**
 * The fine grid cell that contains a point.
 *
 * The convention matters: the fine shard's centre for a cell (i, j) is
 * (i*0.01 + 0.005, j*0.01 + 0.005), so the cell covers [i*0.01, (i+1)*0.01)
 * and a point sitting exactly on a boundary belongs to the cell ABOVE it, not
 * to either of the two that touch there.
 */
test('a point belongs to the cell above a boundary, not to the one below', () => {
  const index = fineCellIndexAt(39.0, -105.0);
  const expected = (3900 - 2100) * 6500 + (-10500 + 12500);
  assert.equal(index, expected);

  // The far edge of the same cell.
  assert.equal(fineCellIndexAt(39.009999, -104.990001), expected);
  // One step east is the next cell.
  assert.equal(fineCellIndexAt(39.005, -104.985), expected + 1);
});

test('a point off the retained grid has no cell', () => {
  assert.equal(fineCellIndexAt(-80, -170), -1);
  assert.equal(fineCellIndexAt(80, 170), -1);
  assert.equal(fineCellIndexAt(Number.NaN, -105), -1);
});

test('a round coordinate lands in the cell it names, not the one below it', () => {
  // 38.83 / 0.01 is 3882.9999999999995 in a double, and 38.83 is exactly on
  // the boundary between rows 3882 and 3883. Taking the floor of the raw
  // division puts the point in row 3882 - one row of hail off, for every
  // point in the country whose coordinates are round numbers.
  assert.equal(38.83 / 0.01, 3882.9999999999995);
  assert.equal(fineCellIndexAt(38.83, -104.82), (3883 - 2100) * 6500 + (-10482 + 12500));

  // The middle of a cell stays in that cell, which a naive rounding would
  // have pushed into the next one. The cell -10482 covers [-104.82, -104.81),
  // so -104.815 is its middle.
  assert.equal(fineCellIndexAt(38.835, -104.815), (3883 - 2100) * 6500 + (-10482 + 12500));

  // A hair below the boundary is still in the cell below.
  assert.equal(fineCellIndexAt(38.8299, -104.8299), (3882 - 2100) * 6500 + (-10483 + 12500));
});

test('a polyline is measured in metres, and longitude shortens with latitude', () => {
  // One degree of latitude at the equator.
  const northSouth = polylineLengthMetres([0, 0, 0, 1]);
  assert.ok(Math.abs(northSouth - 110574) < 1, String(northSouth));

  // The same longitude span is shorter at 60 degrees north than at the
  // equator, by the cosine of the latitude. Skipping this is the mistake that
  // is invisible in Colorado and visible in Florida.
  const atEquator = polylineLengthMetres([0, 0, 1, 0]);
  const atSixty = polylineLengthMetres([0, 60, 1, 60]);
  assert.ok(
    atSixty < atEquator * 0.55 && atSixty > atEquator * 0.45,
    `${atSixty} vs ${atEquator}`,
  );

  assert.equal(polylineLengthMetres([]), 0);
  assert.equal(polylineLengthMetres([1, 2]), 0);
});

test('a street edge wholly under the hail counts every address', () => {
  const hit = hitCellSet([{ i: 3900, j: -10500, maxMm: 50 }], 25.4);
  assert.equal(hit.size, 1);

  // A short east-west edge, wholly inside the cell's own span of
  // [-105.00, -104.99).
  const points = [-104.999, 39.0, -104.991, 39.0];
  const result = hailFraction(points, hit, { sampleMetres: 5 });
  assert.equal(result.fraction, 1, JSON.stringify(result));
  assert.ok(result.metres > 0);
});

test('a street edge away from the hail counts none', () => {
  const hit = hitCellSet([{ i: 3900, j: -10500, maxMm: 50 }], 25.4);
  const points = [-104.5, 39.5, -104.48, 39.5];
  const result = hailFraction(points, hit, { sampleMetres: 5 });
  assert.equal(result.fraction, 0, JSON.stringify(result));
});

test('a street edge half under the hail counts about half', () => {
  const hit = hitCellSet([{ i: 3900, j: -10500, maxMm: 50 }], 25.4);
  // From 5 m west of the cell's west edge, through the whole cell, to 5 m
  // east of the next cell's east edge: 0.02 degrees of longitude, of which the
  // cell's own 0.01 degrees are the hail.
  const points = [-105.005, 39.0, -104.985, 39.0];
  const result = hailFraction(points, hit, { sampleMetres: 5 });
  assert.ok(
    Math.abs(result.fraction - 0.5) < 0.02,
    `fraction was ${result.fraction}`,
  );
});

test('the hail set keeps the cells over the threshold and drops the rest', () => {
  const cells = [
    { i: 3900, j: -10500, maxMm: 50 },
    { i: 3901, j: -10500, maxMm: 25.3 },
    { i: 3902, j: -10500, maxMm: 25.4 },
    { i: 999999, j: 999999, maxMm: 99 },
  ];
  const hit = hitCellSet(cells, 25.4);
  assert.equal(hit.size, 2, 'the 25.4 cell counts, the 25.3 cell does not');

  // A cell outside the retained index space is refused rather than allowed to
  // wrap into a real cell.
  const wrapped = hitCellSet([{ i: 3900, j: -10500, maxMm: 50 }], 25.4);
  assert.ok(wrapped.has((3900 - 2100) * 6500 + (-10500 + 12500)));
});

test('an edge with no length has no share', () => {
  const hit = hitCellSet([{ i: 3900, j: -10500, maxMm: 50 }], 25.4);
  const result = hailFraction([-105.0, 39.0, -105.0, 39.0], hit);
  assert.equal(result.fraction, 0);
  assert.equal(result.samples, 0);
});

test('every cell round-trips through the point lookup', () => {
  // The property the whole join rests on: the cell a point falls in must be
  // the same cell the shard says it is. Checked across the grid, because a
  // single mismatch is a street that is one cell off the hail - which reads
  // as a street with nothing under it, and nothing anywhere says why.
  const cells = [];
  for (let i = 2100; i < 2100 + 40; i += 1) {
    for (let j = -12500; j < -12500 + 40; j += 7) {
      cells.push({ i, j, maxMm: 50 });
    }
  }
  const hit = hitCellSet(cells, 25.4);
  assert.equal(hit.size, cells.length);
  for (const cell of cells) {
    const lat = cell.i * 0.01 + 0.005;
    const lon = cell.j * 0.01 + 0.005;
    assert.equal(
      fineCellIndexAt(lat, lon),
      (cell.i - 2100) * 6500 + (cell.j + 12500),
      `cell ${cell.i}:${cell.j}`,
    );
  }
});

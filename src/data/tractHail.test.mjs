/**
 * The share of a tract that was under the hail.
 *
 * The share is the difference between a number of houses and a claim about
 * houses, and it is the one piece of arithmetic in the product that decides
 * whether a canvasser is sent to a place where the hail fell.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cellAreaKm2,
  indexTracts,
  shareOfTract,
  tractsReached,
} from './tractHail.js';

/**
 * A square tract, `side` degrees on a side, at a latitude.
 *
 * The pack's own encoding: a ring is a flat list of integers in units of
 * 10^-d degrees, the first vertex absolute and every later one a delta from
 * the one before it. The test writes the pack's format, because a test that
 * invents its own format tests nothing about the pack.
 */
function squareTract(geoid, lon, lat, side, aland) {
  const half = side / 2;
  const ring = [
    [lon - half, lat - half],
    [lon + half, lat - half],
    [lon + half, lat + half],
    [lon - half, lat + half],
    [lon - half, lat - half],
  ];
  const factor = 1e6;
  const encoded = [];
  let px = 0;
  let py = 0;
  for (const [x, y] of ring) {
    const ix = Math.round(x * factor);
    const iy = Math.round(y * factor);
    encoded.push(ix - px, iy - py);
    px = ix;
    py = iy;
  }
  return {
    geoid,
    aland,
    polygons: [[encoded]],
    d: 6,
  };
}

/** The area of a square of `side` degrees at a latitude, in km2. */
function squareKm2(lat, side) {
  const perDegree = 111.32;
  const width = side * perDegree * Math.cos((lat * Math.PI) / 180);
  const height = side * perDegree;
  return width * height;
}

test('a radar cell is smaller at the poles, and the share uses the local size', () => {
  const equator = cellAreaKm2(0);
  const denver = cellAreaKm2(39);
  assert.ok(equator > denver);
  // The Census's own figure for a Colorado cell is about 0.96 km2.
  assert.ok(Math.abs(denver - 0.96) < 0.02, `got ${denver}`);
});

test('a tract wholly under the hail is a share of one', () => {
  // A tract two degrees on a side - about 220 km across, 48,000 km2 - with
  // every sample of a hundred cells inside it.
  const side = 2;
  const feature = squareTract('1', -105, 39, side, squareKm2(39, side) * 1e6);
  const index = indexTracts([feature], 6);
  const tract = index.byGeoid.get('1');
  // The cells a full grid over the tract would be: its area over a cell's.
  const cells = squareKm2(39, side) / cellAreaKm2(39);
  const share = shareOfTract(tract, cells * 5);
  assert.ok(share > 0.95 && share <= 1, `got ${share}`);
});

test('a tract the hail clipped is a fraction, and it is smaller the less it took', () => {
  const side = 2;
  const feature = squareTract('1', -105, 39, side, squareKm2(39, side) * 1e6);
  const index = indexTracts([feature], 6);
  const tract = index.byGeoid.get('1');
  const whole = shareOfTract(tract, 5 * 100);
  const half = shareOfTract(tract, 5 * 10);
  const sliver = shareOfTract(tract, 5);
  assert.ok(whole > half, `${whole} should beat ${half}`);
  assert.ok(half > sliver, `${half} should beat ${sliver}`);
  assert.ok(sliver > 0 && sliver < 0.01, `got ${sliver}`);
});

test('a tract smaller than one cell is counted whole, because 1 km cannot say', () => {
  // A five-thousandths-of-a-degree square: 0.24 km2, which is smaller than
  // the 0.96 km2 cell. The radar cannot resolve it.
  const side = 0.005;
  const feature = squareTract('1', -105, 39, side, squareKm2(39, side) * 1e6);
  const index = indexTracts([feature], 6);
  const tract = index.byGeoid.get('1');
  assert.ok(tract.areaKm2 < cellAreaKm2(39));
  assert.equal(shareOfTract(tract, 1), 1);
  assert.equal(shareOfTract(tract, 5), 1);
});

test('a tract with no published area falls back to its own ring', () => {
  const side = 2;
  const feature = squareTract('1', -105, 39, side, 0);
  const index = indexTracts([feature], 6);
  const tract = index.byGeoid.get('1');
  assert.ok(tract.areaKm2 > 0);
  // The ring's area is close enough to the square's own.
  assert.ok(Math.abs(tract.areaKm2 / squareKm2(39, side) - 1) < 0.02);
});

test('a cell that reaches a tract gives it a share, and the cell is counted once', () => {
  // One cell whose centre is inside the tract.
  const side = 0.4;
  const feature = squareTract('1', -105, 39, side, squareKm2(39, side) * 1e6);
  const index = indexTracts([feature], 6);
  // The cell that contains the tract's centre. The grid is 0.01 degrees, the
  // cell's centre is half a step in.
  const i = Math.floor((39 - 0.005) / 0.01);
  const j = Math.floor((-105 - 0.005) / 0.01);
  const hit = tractsReached(index, [{ i, j, maxMm: 40 }], {
    thresholdMm: 25.4,
    stepDeg: 0.01,
  });
  const row = hit.get('1');
  assert.ok(row, 'the tract was not reached');
  assert.equal(row.cells, 1, 'one cell, counted once');
  assert.ok(row.samples >= 1, 'at least the centre sample landed in it');
  assert.ok(row.share > 0 && row.share <= 1, `got ${row.share}`);
});

test('a cell below the threshold is not a hit at all', () => {
  const side = 0.4;
  const feature = squareTract('1', -105, 39, side, squareKm2(39, side) * 1e6);
  const index = indexTracts([feature], 6);
  const i = Math.floor((39 - 0.005) / 0.01);
  const j = Math.floor((-105 - 0.005) / 0.01);
  const hit = tractsReached(index, [{ i, j, maxMm: 10 }], {
    thresholdMm: 25.4,
    stepDeg: 0.01,
  });
  assert.equal(hit.size, 0);
});

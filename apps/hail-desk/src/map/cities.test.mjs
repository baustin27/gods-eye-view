import assert from 'node:assert/strict';
import test from 'node:test';

import { createViewport } from './viewport.js';
import { createCityPainter } from './cities.js';

test('city boundaries are drawn as closed gold outlines', () => {
  const calls = { closed: 0, strokes: 0 };
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {
      calls.closed += 1;
    },
    stroke() {
      calls.strokes += 1;
    },
  };
  const outline = [
    [
      [-105, 39],
      [-104, 39],
      [-104, 40],
      [-105, 40],
    ],
  ];

  createCityPainter().draw(ctx, createViewport(), [outline]);

  assert.equal(calls.closed, 1);
  assert.equal(calls.strokes, 1);
  assert.equal(ctx.strokeStyle, 'rgba(255, 214, 102, 0.5)');
});

test('city painter respects custom projectFn', () => {
  const points = [];
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    moveTo(x, y) { points.push({ x, y }); },
    lineTo(x, y) { points.push({ x, y }); },
    closePath() {},
    stroke() {},
  };
  const outline = [
    [
      [-105, 39],
      [-104, 39],
      [-104, 40],
    ],
  ];

  createCityPainter().draw(ctx, createViewport(), [outline], (lon, lat) => ({
    x: lon * 2,
    y: lat * 2,
  }));

  assert.deepEqual(points, [
    { x: -210, y: 78 },
    { x: -208, y: 78 },
    { x: -208, y: 80 },
  ]);
});

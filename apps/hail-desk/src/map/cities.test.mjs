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

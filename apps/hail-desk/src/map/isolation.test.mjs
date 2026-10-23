import assert from 'node:assert/strict';
import test from 'node:test';
import { clipToState, drawOutsideState, tilesInState } from './isolation.js';
import { createViewport } from './viewport.js';

const colorado = [
  [
    [
      [-109.05, 37],
      [-102.05, 37],
      [-102.05, 41],
      [-109.05, 41],
    ],
  ],
];

test('isolation rejects tiles wholly outside the state but keeps edge tiles', () => {
  const tiles = [
    { z: 6, x: 12, y: 24 },
    { z: 6, x: 13, y: 24 },
    { z: 6, x: 14, y: 24 },
  ];
  assert.deepEqual(tilesInState(tiles, colorado), tiles.slice(0, 2));
  assert.deepEqual(tilesInState(tiles, null), []);
});

test('isolation clips all polygons and holes in one even-odd path', () => {
  const calls = [];
  const ctx = {
    beginPath() {
      calls.push('begin');
    },
    moveTo() {
      calls.push('move');
    },
    lineTo() {},
    closePath() {
      calls.push('close');
    },
    clip(rule) {
      calls.push(rule);
    },
  };
  clipToState(ctx, createViewport(), colorado);
  assert.deepEqual(calls, ['begin', 'move', 'close', 'evenodd']);
});

test('a missing outline fails closed rather than revealing the world', () => {
  let clipped = false;
  clipToState(
    {
      beginPath() {},
      clip() {
        clipped = true;
      },
    },
    createViewport(),
    null,
  );
  assert.equal(clipped, true);
});

test('the isolation mask paints outside the state, and a missing outline covers all', () => {
  const fills = [];
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill(rule) { fills.push({ rule, color: ctx.fillStyle }); },
  };
  drawOutsideState(ctx, createViewport(), colorado);
  drawOutsideState(ctx, createViewport(), null);
  assert.deepEqual(fills, [
    { rule: 'evenodd', color: '#05080b' },
    { rule: 'evenodd', color: '#05080b' },
  ]);
});

test('tile filtering preserves small islands and excludes tiles entirely inside holes', () => {
  const tile = { z: 6, x: 12, y: 24 };
  const island = [[[[-110, 38], [-109, 38], [-109, 39], [-110, 39]]]];
  assert.deepEqual(tilesInState([tile], island), [tile]);
  const withHole = [[
    [[-130, 20], [-90, 20], [-90, 50], [-130, 50]],
    [[-114, 35], [-105, 35], [-105, 43], [-114, 43]],
  ]];
  assert.deepEqual(tilesInState([tile], withHole), []);
});

test('drawOutsideState and clipToState support custom projectFn', () => {
  const points = [];
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    moveTo(x, y) { points.push(['move', x, y]); },
    lineTo(x, y) { points.push(['line', x, y]); },
    closePath() {},
    fill() {},
    clip() {},
  };
  const poly = [[[[-105, 39], [-104, 39], [-104, 40]]]];
  const proj = (lon, lat) => ({ x: lon * 10, y: lat * 10 });

  drawOutsideState(ctx, createViewport(), poly, '#000000', proj);
  assert.equal(points[0][1], -1050);
  assert.equal(points[0][2], 390);

  points.length = 0;
  clipToState(ctx, createViewport(), poly, proj);
  assert.equal(points[0][1], -1050);
  assert.equal(points[0][2], 390);
});

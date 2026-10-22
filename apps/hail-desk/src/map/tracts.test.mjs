/**
 * The tract choropleth's ramp.
 *
 * A ramp that rescales with the data is a ramp that changes meaning every
 * time the map moves, and two maps of two storms are then not comparable. So
 * the scale is pinned, and these tests pin it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeStreetTile } from '../../../../src/data/streetTile.js';
import { createViewport } from './viewport.js';
import { createTractPainter, tractFill } from './tracts.js';

test('a tract with no houses is drawn, and drawn quietly', () => {
  for (const units of [null, undefined, NaN]) {
    const fill = tractFill(units);
    assert.match(fill, /^rgba\(\d+, \d+, \d+, 0\.0\d+\)$/);
  }
});

/** The alpha of an rgba colour, which is the ramp's value. */
const alpha = (rgba) => Number(rgba.split(',')[3].replace(')', ''));

test('the ramp is pinned, so two maps are comparable', () => {
  // The biggest tract in the data is at the top of the ramp, and it is at
  // the top of the ramp tomorrow too.
  const full = tractFill(5000);
  const half = tractFill(2500);
  assert.ok(alpha(full) > alpha(half));
  // And a tract with the SAME count has the same colour, whatever else is
  // on the map.
  assert.equal(tractFill(1234), tractFill(1234));
});

test('the ramp is logarithmic, so a small tract is not invisible', () => {
  // A linear ramp would put 100 units at a twentieth of the scale, which is
  // 0.02 of an alpha - a fill nobody can see.
  assert.ok(alpha(tractFill(100)) > 0.2);
  assert.ok(alpha(tractFill(0)) < alpha(tractFill(100)));
});

test('the geography tile supplies the county whose tract list colours it', async () => {
  const tileBytes = encodeStreetTile({
    zoom: 14,
    lines: [
      {
        edgeIndex: 0,
        points: [
          [0, 0],
          [4096, 0],
          [4096, 4096],
          [0, 4096],
        ],
      },
    ],
  });
  const calls = [];
  const fills = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/index')) {
      return {
        ok: true,
        json: async () => ({ tracts: [{ units: 100 }] }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'x-gev-geoid': '08031' }),
      arrayBuffer: async () =>
        tileBytes.buffer.slice(
          tileBytes.byteOffset,
          tileBytes.byteOffset + tileBytes.byteLength,
        ),
    };
  };
  const painter = createTractPainter({ fetchImpl });
  const ctx = {
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    fill(rule) {
      assert.equal(rule, 'evenodd');
      fills.push(ctx.fillStyle);
    },
  };
  const tile = { z: 14, x: 3413, y: 6218 };
  const viewport = createViewport({ zoom: 14 });

  assert.doesNotThrow(() => painter.draw(ctx, viewport, [tile]));
  await new Promise((resolve) => setImmediate(resolve));
  painter.draw(ctx, viewport, [tile]);

  assert.deepEqual(calls, [
    '/api/desk/tracts/14/3413/6218',
    '/api/desk/tracts/08/031/index',
  ]);
  assert.deepEqual(fills, [tractFill(100)]);
});

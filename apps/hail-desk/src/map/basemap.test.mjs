import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CARTO_DARK_MATTER,
  ESRI_ATTRIBUTION,
  ESRI_DARK_GRAY_BASE,
  ESRI_DARK_GRAY_REF,
  ESRI_WORLD_BOUNDARIES,
  ESRI_WORLD_IMAGERY,
  ESRI_WORLD_STREETS,
  ESRI_WORLD_TRANSPORTATION,
  createBasemap,
  createTileCache,
  loadBasemapTile,
} from './basemap.js';
import { createViewport } from './viewport.js';

test('basemap exports CARTO_DARK_MATTER, ESRI_WORLD_IMAGERY, and attribution', () => {
  assert.equal(
    CARTO_DARK_MATTER,
    'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  );
  assert.equal(
    ESRI_WORLD_IMAGERY,
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  );
  assert.equal(
    ESRI_WORLD_TRANSPORTATION,
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
  );
  assert.equal(
    ESRI_WORLD_BOUNDARIES,
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  );
  assert.equal(
    ESRI_WORLD_STREETS,
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
  );
  assert.equal(
    ESRI_DARK_GRAY_BASE,
    'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  );
  assert.equal(
    ESRI_DARK_GRAY_REF,
    'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  );
  assert.match(ESRI_ATTRIBUTION, /Esri/);
});

test('loadBasemapTile loads from ESRI for satellite, hybrid, and road modes', async () => {
  const urls = [];
  class MockImage {
    constructor() {
      this.crossOrigin = '';
      this.referrerPolicy = '';
      this._src = '';
    }
    set src(val) {
      this._src = val;
      urls.push(val);
      setImmediate(() => this.onload?.());
    }
    get src() {
      return this._src;
    }
  }

  const tile = { z: 10, x: 215, y: 387 };

  // 1. Default (satellite): uses ESRI_WORLD_IMAGERY with {z}/{y}/{x}
  const satImg = await loadBasemapTile(tile, { ImageImpl: MockImage });
  assert.ok(satImg);
  assert.equal(
    urls[0],
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/10/387/215',
  );

  // 2. Road mode base: uses ESRI_DARK_GRAY_BASE with {z}/{y}/{x}
  const roadBaseImg = await loadBasemapTile(tile, { ImageImpl: MockImage, mode: 'road', layerType: 'base' });
  assert.ok(roadBaseImg);
  assert.equal(
    urls[1],
    'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/10/387/215',
  );

  // 3. Road mode labels: uses ESRI_DARK_GRAY_REF with {z}/{y}/{x}
  const roadLabelsImg = await loadBasemapTile(tile, { ImageImpl: MockImage, mode: 'road', layerType: 'labels' });
  assert.ok(roadLabelsImg);
  assert.equal(
    urls[2],
    'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/10/387/215',
  );

  // 4. Hybrid mode roads: uses ESRI_WORLD_TRANSPORTATION
  const hybridRoadsImg = await loadBasemapTile(tile, { ImageImpl: MockImage, mode: 'hybrid', layerType: 'roads' });
  assert.ok(hybridRoadsImg);
  assert.equal(
    urls[3],
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/10/387/215',
  );

  // 5. Hybrid mode labels: uses ESRI_WORLD_BOUNDARIES
  const hybridLabelsImg = await loadBasemapTile(tile, { ImageImpl: MockImage, mode: 'hybrid', layerType: 'labels' });
  assert.ok(hybridLabelsImg);
  assert.equal(
    urls[4],
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/10/387/215',
  );

  // 6. Carto mode backward compatibility
  const cartoImg = await loadBasemapTile(tile, { ImageImpl: MockImage, mode: 'carto' });
  assert.ok(cartoImg);
  assert.equal(
    urls[5],
    'https://a.basemaps.cartocdn.com/dark_all/10/215/387.png',
  );
});

test('createBasemap draws tactical grid and background before tiles', () => {
  const rects = [];
  const strokes = [];
  const lines = [];

  const ctx = {
    save() {},
    restore() {},
    fillRect(x, y, w, h) {
      rects.push({ x, y, w, h, fillStyle: ctx.fillStyle });
    },
    beginPath() {},
    moveTo(x, y) {
      lines.push(['move', x, y]);
    },
    lineTo(x, y) {
      lines.push(['line', x, y]);
    },
    stroke() {
      strokes.push(ctx.strokeStyle);
    },
    drawImage() {},
  };

  const basemap = createBasemap();
  const viewport = createViewport({ width: 96, height: 96 });

  basemap.draw(ctx, viewport, []);

  // Background rect: #090d16
  assert.equal(rects.length, 1);
  assert.equal(rects[0].fillStyle, '#090d16');
  assert.equal(rects[0].w, 96);
  assert.equal(rects[0].h, 96);

  // 48px tactical grid
  assert.ok(strokes.length >= 1);
  assert.equal(strokes[0], 'rgba(30, 41, 59, 0.45)');
  assert.ok(lines.length >= 6); // 3 vertical + 3 horizontal grid lines for 96x96
});

test('createBasemap cache separates modes and preserves backward compatibility', async () => {
  class MockImage {
    constructor() {
      setImmediate(() => this.onload?.());
    }
  }

  const basemap = createBasemap({ ImageImpl: MockImage });
  const tile = { z: 12, x: 800, y: 1500 };
  const ctx = {
    save() {},
    restore() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    drawImage() {},
  };
  const viewport = createViewport({ width: 100, height: 100 });

  // Satellite mode draw
  basemap.draw(ctx, viewport, [tile], 'satellite');
  await new Promise((r) => setTimeout(r, 20));

  // Satellite key should be backward-compatible: "12/800/1500"
  assert.ok(basemap.cache.get('12/800/1500'));

  // Road mode draw: caches base and labels
  basemap.draw(ctx, viewport, [tile], 'road');
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(basemap.cache.get('road:base:12/800/1500'));
  assert.ok(basemap.cache.get('road:labels:12/800/1500'));

  // Hybrid mode draw: caches roads and labels, reuses satellite base
  basemap.draw(ctx, viewport, [tile], 'hybrid');
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(basemap.cache.get('12/800/1500'));
  assert.ok(basemap.cache.get('hybrid:roads:12/800/1500'));
  assert.ok(basemap.cache.get('hybrid:labels:12/800/1500'));
});

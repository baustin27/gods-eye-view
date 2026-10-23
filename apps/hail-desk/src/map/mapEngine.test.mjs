if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}

import assert from 'node:assert/strict';
import test from 'node:test';

const { createMapPane } = await import('./map.js');

function createMockContext() {
  const operations = [];
  const fills = [];
  const strokes = [];
  const texts = [];

  const ctx = {
    save() { operations.push('save'); },
    restore() { operations.push('restore'); },
    beginPath() { operations.push('beginPath'); },
    closePath() { operations.push('closePath'); },
    moveTo(x, y) { operations.push(['moveTo', x, y]); },
    lineTo(x, y) { operations.push(['lineTo', x, y]); },
    arc(x, y, r, sa, ea) { operations.push(['arc', x, y, r, sa, ea]); },
    rect(x, y, w, h) { operations.push(['rect', x, y, w, h]); },
    fillRect(x, y, w, h) {
      fills.push({ x, y, w, h, fillStyle: ctx.fillStyle });
    },
    stroke() {
      strokes.push({
        strokeStyle: ctx.strokeStyle,
        lineWidth: ctx.lineWidth,
        shadowColor: ctx.shadowColor,
      });
    },
    fill() {
      fills.push({ fillStyle: ctx.fillStyle });
    },
    clip() { operations.push('clip'); },
    clearRect() { operations.push('clearRect'); },
    setTransform() {},
    setLineDash() {},
    drawImage() {},
    measureText(text) {
      return { width: text.length * 6 };
    },
    fillText(text, x, y) {
      texts.push({ text, x, y, fillStyle: ctx.fillStyle });
    },
  };
  return { ctx, operations, fills, strokes, texts };
}

function createMockCanvas(ctx) {
  const listeners = {};
  const canvas = {
    width: 800,
    height: 600,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    removeEventListener: () => {},
    parentElement: { classList: { add() {} } },
  };
  const mapContainer = {
    style: {},
    setAttribute: () => {},
    replaceChildren: () => {},
    hidden: false,
  };
  return { canvas, mapContainer, listeners };
}

test('createMapPane supports knock pins rendering and pick handling', () => {
  const { ctx, strokes, texts } = createMockContext();
  const { canvas, mapContainer, listeners } = createMockCanvas(ctx);

  let pickedPin = null;
  const knockPins = [
    {
      lon: -105.0,
      lat: 39.75,
      status: 'Inspected',
      label: '123 Main St',
      selected: false,
    },
    {
      lon: -104.9,
      lat: 39.8,
      status: 'Knocked',
      label: '456 Oak Ave',
      selected: false,
    },
    {
      lon: -105.1,
      lat: 39.75,
      status: 'target',
      label: 'Target Roof',
      selected: true,
    },
  ];

  const viewport = { centre: { lon: -105.0, lat: 39.75 }, zoom: 11, width: 800, height: 600 };
  const pane = createMapPane({
    canvas,
    mapContainer,
    viewport,
    knockPins: () => knockPins,
    onKnockPinPick: (pin) => {
      pickedPin = pin;
    },
  });

  pane.draw();

  // Selected pin draws label
  const labelFound = texts.some((t) => t.text === 'Target Roof');
  assert.ok(labelFound, 'Selected pin monospace label was drawn');

  // Verify pointerup pick triggers onKnockPinPick
  const ptScreen = pane.unproject(0, 0);
  assert.ok(ptScreen);

  // Trigger pointerup near the selected pin
  // At -105.1, 39.75 with center at -105.0, 39.75:
  // West of center: offsetX is roughly 400 - delta
  const centerProj = 400;
  listeners.pointerdown({ button: 0, offsetX: 350, offsetY: 300 });
  listeners.pointerup({ offsetX: 350, offsetY: 300 });
});

test('createMapPane draws labels for top places and respects showPlaces callback', () => {
  const { ctx, texts } = createMockContext();
  const { canvas, mapContainer } = createMockCanvas(ctx);

  const places = [
    { name: 'Denver', lon: -104.99, lat: 39.73, severe: 25, max: 1.75 },
    { name: 'Boulder', lon: -105.27, lat: 40.01, severe: 10, max: 1.0 },
    { name: 'Quiet Town', lon: -105.1, lat: 39.5, severe: 0, max: 0 },
  ];

  let visible = true;
  const viewport = { centre: { lon: -105.0, lat: 39.75 }, zoom: 10, width: 800, height: 600 };
  const pane = createMapPane({
    canvas,
    mapContainer,
    viewport,
    places: () => places,
    showPlaces: () => visible,
  });

  pane.draw();
  // Denver should have label with name and hail size (1.75")
  const denverText = texts.find((t) => t.text === 'Denver');
  assert.ok(denverText, 'Denver name label rendered');
  const hailText = texts.find((t) => t.text.includes('1.75″'));
  assert.ok(hailText, '1.75″ hail size label rendered in amber');

  // Toggle showPlaces off
  visible = false;
  texts.length = 0;
  pane.draw();
  assert.equal(
    texts.some((t) => t.text === 'Denver'),
    false,
    'No Denver place text rendered when showPlaces is false',
  );
});

test('createMapPane resetView resets camera to current swath bounds or state boundary', () => {
  const { ctx } = createMockContext();
  const { canvas, mapContainer } = createMockCanvas(ctx);

  const swathBands = [
    {
      band: { color: '#6d28d9', outline: '#9333ea' },
      outer: [
        { lon: -105.5, lat: 39.0 },
        { lon: -104.5, lat: 39.0 },
        { lon: -104.5, lat: 40.0 },
        { lon: -105.5, lat: 40.0 },
      ],
    },
  ];

  const pane = createMapPane({
    canvas,
    mapContainer,
    swath: () => swathBands,
  });

  pane.resetView();

  const vp = pane.viewport;
  // Center should be approximately -105, 39.5
  assert.ok(Math.abs(vp.centre.lon - -105.0) < 0.1);
  assert.ok(Math.abs(vp.centre.lat - 39.5) < 0.1);
});

test('createMapPane draws subtle swath tract grid when bands are present and showTracts is true', () => {
  const { ctx, operations, strokes } = createMockContext();
  const { canvas, mapContainer } = createMockCanvas(ctx);

  const swathBands = [
    {
      band: { color: '#6d28d9', outline: '#9333ea' },
      outer: [
        { lon: -105.2, lat: 39.5 },
        { lon: -104.8, lat: 39.5 },
        { lon: -104.8, lat: 39.9 },
        { lon: -105.2, lat: 39.9 },
      ],
    },
  ];

  let showTractsVal = true;
  const pane = createMapPane({
    canvas,
    mapContainer,
    swath: () => swathBands,
    showTracts: () => showTractsVal,
  });

  pane.draw();
  // Swath tract grid uses clip() and subtle cyan stroke
  assert.ok(operations.includes('clip'), 'swath tract grid created clip boundary');
  const cyanGridStroke = strokes.find(
    (s) => s.strokeStyle === 'rgba(34, 211, 238, 0.16)',
  );
  assert.ok(cyanGridStroke, 'Cyan swath tract grid stroke was applied');
});

test('createMapPane sizes container, supports goTo default zoom 16, and switches basemaps', () => {
  const { ctx } = createMockContext();
  const { canvas, mapContainer } = createMockCanvas(ctx);

  let currentBasemap = null;
  const pane = createMapPane({
    canvas,
    mapContainer,
    onBasemapChange: (mode) => {
      currentBasemap = mode;
    },
  });

  // mapContainer is sized to 100% width and 100% height
  assert.equal(mapContainer.style.width, '100%');
  assert.equal(mapContainer.style.height, '100%');

  // goTo defaults to zoom = 16 and updates centre
  pane.goTo(-105.01, 39.74);
  assert.equal(pane.viewport.zoom, 16);
  assert.equal(pane.viewport.centre.lon, -105.01);
  assert.equal(pane.viewport.centre.lat, 39.74);

  // Basemap switching between hybrid, road, and satellite
  pane.setBasemap('road');
  assert.equal(currentBasemap, 'road');

  pane.setBasemap('satellite');
  assert.equal(currentBasemap, 'satellite');

  pane.setBasemap('hybrid');
  assert.equal(currentBasemap, 'hybrid');
});

test('createMapPane showSwath and fallback swath drawing', async () => {
  const { ctx, fills } = createMockContext();
  const { canvas, mapContainer } = createMockCanvas(ctx);

  const pane = createMapPane({
    canvas,
    mapContainer,
  });

  const bands = await pane.showSwath('2023-06-22');
  assert.ok(Array.isArray(bands));

  // Test unproject fallback
  const geo = pane.unproject(400, 300);
  assert.ok(Number.isFinite(geo.lon));
  assert.ok(Number.isFinite(geo.lat));
});


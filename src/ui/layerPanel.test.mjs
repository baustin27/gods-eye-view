import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('panel presentation places Transit between Street Traffic and Bike Share in Movement', () => {
  const source = readFileSync(
    new URL('./layerPanel.js', import.meta.url),
    'utf8',
  );
  const declarations = source.slice(
    source.indexOf('const PANEL_GROUPS ='),
    source.indexOf('const PANEL_POSITIONS ='),
  );
  const order = JSON.parse(
    runInNewContext(`${declarations}\nJSON.stringify(PANEL_ORDER)`),
  );
  assert.deepEqual(
    order.filter(({ label }) => label === 'Movement').map(({ id }) => id),
    [
      'satellites',
      'flights',
      'military',
      'local-adsb',
      'ais-live-vessels',
      'traffic',
      'transit',
      'bikeshare',
    ],
  );
  assert.equal(order.filter(({ id }) => id === 'transit').length, 1);
});

test('partial feed controls distinguish incomplete records from stale data and outages', async () => {
  const { LayerPanel, layerFeedState } = await import('./layerPanel.js');
  const classes = new Map();
  const attrs = new Map();
  const button = {
    classList: { toggle: (key, value) => classes.set(key, value) },
    dataset: {},
    setAttribute: (key, value) => attrs.set(key, value),
  };
  const layer = {
    id: 'ais-live-vessels',
    name: 'Live Vessels',
    source: 'AISStream',
    enabled: true,
    stats: {
      partial: true,
      stale: false,
      count: 2,
      acceptedRowCount: 2,
      rawRowCount: 3,
      lastUpdate: Date.now(),
    },
  };
  const panel = LayerPanel.prototype;
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'PARTIAL');
  assert.equal(button.dataset.feedState, 'partial');
  assert.equal(classes.get('feed-partial'), true);
  assert.equal(classes.get('feed-stale'), false);
  assert.match(attrs.get('aria-label'), /PARTIAL/);
  assert.match(
    panel._buildMetaText(layer),
    /^PARTIAL · AISStream · 2 of 3 records accepted · /,
  );
  assert.match(
    panel._buildMetaText({
      ...layer,
      stats: { ...layer.stats, rawRowCount: 2 },
    }),
    /incomplete snapshot/,
  );
  assert.equal(layerFeedState({ ...layer.stats, stale: true }), 'stale');
  assert.equal(
    layerFeedState({ ...layer.stats, error: 'Connection lost' }),
    'degraded',
  );
  assert.equal(
    layerFeedState({ ...layer.stats, status: 'unavailable' }),
    'unavailable',
  );
  assert.equal(layerFeedState({ ...layer.stats, loading: true }), 'loading');
  layer.stats = { ...layer.stats, partial: false };
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'ON');
  assert.equal(classes.get('feed-partial'), false);
  layer.enabled = false;
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'OFF');
});

test('readout rows contain only toggles and metadata; ordinary rows retain controls', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
  const ids = [
    'wind',
    'weather-radar',
    'weather-satellite',
    'weather-lightning',
    'weather-cyclones',
    'other',
  ];
  let refresh;
  const layers = ids.map((id) => ({
    id,
    name: id,
    icon: '*',
    source: 'Source',
    enabled: true,
    showInTogglePanel: true,
    stats: {},
  }));
  const calls = [];
  const panel = new LayerPanel({
    getLayers: () => layers,
    isEnabled: () => true,
    setEnabled: (...args) => calls.push(args),
    setLayerParams: (...args) => calls.push(args),
    hasRowControls: () => true,
    subscribeRowControls: (_id, callback) => {
      refresh = callback;
    },
    getRowControls: (id) => ({
      readout: id !== 'other',
      summary: { status: 'Loading' },
      info: 'Detailed time',
      chips: [{ id: 'config', label: 'Soft', params: { opacity: 'light' } }],
      legend: [{ label: 'Rain', color: '#abcdef' }],
      list: {
        items: [{ id: 'storm', text: 'Storm', params: { focus: true } }],
      },
    }),
  });
  try {
    panel.mount(f.container);
    for (const id of ids.slice(0, -1)) {
      const row = f.find((n) => n.dataset.layerId === id);
      assert.equal(row.children.length, 2);
      assert.ok(row.querySelector('.data-name'));
      assert.ok(row.querySelector('.data-toggle-meta'));
      for (const cls of [
        'data-toggle-chip',
        'data-count',
        'data-toggle-controls',
        'data-toggle-controls-status',
        'data-row-list',
      ])
        assert.equal(row.querySelector(`.${cls}`), null);
      row.querySelector('.data-toggle-btn').click();
    }
    assert.deepEqual(
      calls.map(([id]) => id),
      ids.slice(0, -1),
    );
    const ordinary = f.find((n) => n.dataset.layerId === 'other');
    assert.equal(
      ordinary.querySelector('.data-toggle-controls-info').textContent,
      'Detailed time',
    );
    assert.ok(ordinary.querySelector('.data-toggle-legend-item'));
    ordinary.querySelector('.data-toggle-chip').click();
    assert.deepEqual(calls.at(-1), [
      'other',
      { opacity: 'light' },
      { origin: 'user' },
    ]);
    assert.equal(typeof refresh, 'function');
  } finally {
    panel.destroy();
    globalThis.document = previousDocument;
  }
});

test('the Recent Imagery readout mounts in its rail body like the weather readout and is rebuilt or released with the panel', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const body = f.document.createElement('div');
  f.document.getElementById = (id) =>
    id === 'recent-imagery-panel-body' ? body : null;
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
  const mounted = [];
  const factory = (container) => {
    const readout = {
      container,
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    mounted.push(readout);
    return readout;
  };
  const panel = new LayerPanel({
    getLayers: () => [],
    isEnabled: () => false,
    setEnabled() {},
    setLayerParams() {},
    hasRowControls: () => false,
    subscribeRowControls() {},
    getRowControls: () => null,
  });
  try {
    panel.attachRecentImagery(factory);
    assert.equal(mounted.length, 0, 'no body before the panel mounts');
    panel.mount(f.container);
    assert.equal(mounted.length, 1);
    assert.equal(mounted[0].container, body);
    panel.mount(f.container);
    assert.equal(mounted[0].destroyed, true, 'a remount rebuilds it');
    assert.equal(mounted.length, 2);
    panel.attachRecentImagery(null);
    assert.equal(mounted[1].destroyed, true);
    panel.attachRecentImagery(factory);
    assert.equal(mounted.length, 3);
    panel.destroy();
    assert.equal(mounted[2].destroyed, true);
    panel.attachRecentImagery(factory);
    assert.equal(mounted.length, 3, 'a destroyed panel mounts nothing');
  } finally {
    panel.destroy();
    globalThis.document = previousDocument;
  }
});

test('an omitted source is visibly unavailable and cannot be toggled on', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const attrs = new Map();
  const button = {
    classList: { toggle() {} },
    dataset: {},
    setAttribute: (key, value) => attrs.set(key, value),
  };
  const layer = {
    id: 'flights',
    name: 'Flights',
    enabled: false,
    stats: {
      sourceUnavailable: true,
      status: 'unavailable',
      error: 'Data source not configured: flights',
    },
  };
  LayerPanel.prototype._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'UNAVAILABLE');
  assert.equal(attrs.get('aria-disabled'), 'true');
  assert.match(button.title, /not configured/);
  LayerPanel.prototype._syncToggleButton(button, { ...layer, enabled: true });
  assert.equal(
    attrs.get('aria-disabled'),
    'false',
    'an active layer can always be switched off',
  );
});

/**
 * Build a panel over the rail fixture with one ordinary layer whose row
 * controls may include the optional typed `field`. Returns the fixture too:
 * the test DOM answers class selectors on elements, not on the document.
 */
async function panelWithField({ withField = true, reject = false } = {}) {
  const { LayerPanel } = await import('./layerPanel.js');
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
  const layer = {
    id: 'storm',
    name: 'Storm',
    icon: '*',
    source: 'S',
    enabled: true,
    showInTogglePanel: true,
    stats: {},
  };
  const committed = [];
  const cancelled = [];
  const controls = {
    readout: false,
    chips: [{ id: 'a', label: 'A' }],
    legend: [],
    info: 'info line',
  };
  if (withField) {
    controls.field = {
      id: 'storm-date',
      value: '2026-08-10',
      placeholder: 'Type a date',
      ariaLabel: 'One storm date',
      onCommit: (raw) => {
        committed.push(raw);
        // A rejected value leaves the field value alone, as the layer would.
        if (reject) return false;
        controls.field.value = raw;
        return true;
      },
      onCancel: () => cancelled.push(true),
    };
  }
  const panel = new LayerPanel({
    getLayers: () => [layer],
    isEnabled: () => true,
    setEnabled: () => {},
    setLayerParams: () => {},
    hasRowControls: () => true,
    subscribeRowControls: () => () => {},
    getRowControls: () => controls,
  });
  const row = () => f.find((n) => n.dataset.layerId === 'storm');
  try {
    panel.mount(f.container);
  } catch (error) {
    panel.destroy();
    globalThis.document = previousDocument;
    throw error;
  }
  return {
    panel,
    committed,
    cancelled,
    row,
    input: () => row().querySelector('.data-toggle-field')._rowFieldInput,
    close() {
      panel.destroy();
      globalThis.document = previousDocument;
    },
  };
}

/** A keydown on the field container, in the fixture's event idiom. */
function key(node, name) {
  const event = new Event('keydown');
  Object.defineProperty(event, 'key', { value: name });
  Object.defineProperty(event, 'target', { value: node });
  node.dispatchEvent(event);
  return event;
}

test('a layer that offers a field gets a real input in its row', async () => {
  const h = await panelWithField();
  const box = h.row().querySelector('.data-toggle-field');
  assert.ok(box, 'the field container is rendered');
  assert.equal(box.hidden, false);
  const input = h.input();
  assert.ok(input, 'and it holds an input');
  assert.equal(input.type, 'text');
  assert.equal(input.value, '2026-08-10', 'seeded from the layer');
  assert.equal(input.placeholder, 'Type a date');
  assert.equal(input.getAttribute('aria-label'), 'One storm date');
  h.close();
});

test('Enter commits the typed value to the layer', async () => {
  const h = await panelWithField();
  const input = h.input();
  input.value = '2026-08-11';
  key(h.row().querySelector('.data-toggle-field'), 'Enter');
  assert.deepEqual(h.committed, ['2026-08-11']);
  h.close();
});

test('Escape abandons the edit and restores the layer value', async () => {
  const h = await panelWithField();
  const input = h.input();
  input.value = 'half typed';
  key(h.row().querySelector('.data-toggle-field'), 'Escape');
  assert.deepEqual(h.committed, [], 'nothing was committed');
  assert.deepEqual(h.cancelled, [true]);
  assert.equal(input.value, '2026-08-10', 'and the field went back');
  h.close();
});

test('a rejected value stays in the field so it can be corrected', async () => {
  const h = await panelWithField({ reject: true });
  const input = h.input();
  input.value = 'next tuesday';
  key(h.row().querySelector('.data-toggle-field'), 'Enter');
  assert.deepEqual(h.committed, ['next tuesday'], 'the layer did see it');
  assert.equal(
    input.value,
    'next tuesday',
    'and rejected it without being reset',
  );
  h.close();
});

test('a layer with no field renders exactly as before', async () => {
  const h = await panelWithField({ withField: false });
  const box = h.row().querySelector('.data-toggle-field');
  assert.ok(box, 'the container still exists');
  assert.equal(box.hidden, true, 'and is hidden');
  assert.equal(box._rowFieldInput, null, 'with no input in it');
  assert.ok(
    h.row().querySelector('.data-toggle-chip'),
    'the chips are unaffected',
  );
  assert.equal(
    h.row().querySelector('.data-toggle-controls-info').textContent,
    'info line',
  );
  h.close();
});

test('the field survives a panel refresh', async () => {
  // The row is built once and then re-synced on every scheduled refresh. The
  // initial build and the refresh pass different arguments, and a field wired
  // into only one of them renders once and is then orphaned: the row looks
  // right until the first refresh, with no error anywhere.
  const h = await panelWithField();
  assert.ok(h.input(), 'rendered on the initial build');
  h.panel._renderToggles();
  assert.ok(h.input(), 'still there after a refresh');
  assert.equal(h.input().value, '2026-08-10');
  h.panel._renderToggles();
  assert.ok(h.input(), 'and after a second one');
  h.close();
});

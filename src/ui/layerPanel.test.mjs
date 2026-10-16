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
async function panelWithField({
  withField = true,
  reject = false,
  asyncField = false,
} = {}) {
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
        // `asyncField` models a layer that must resolve text against data
        // before it knows the value to echo back - resolving a place name to
        // geometry. A synchronous layer returns `true` and is unaffected.
        if (asyncField)
          return new Promise((resolve) => setTimeout(() => resolve(true), 0));
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

// THE REGRESSION. An async `onCommit` used to have its value overwritten by the
// panel with the PRE-resolution field value, which was ''. The box would appear
// for a second and then vanish, because blurring the field committed that blank
// and the layer read it as "clear".
test('an async commit echoes the resolved value, not the pre-resolution blank', async () => {
  const h = await panelWithField({ asyncField: true });
  const input = h.input();
  input.value = 'Denver';
  key(h.row().querySelector('.data-toggle-field'), 'Enter');
  // The layer records its value synchronously here, but the panel's write-back
  // happens a tick later - which is the whole point.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(h.committed, ['Denver']);
  assert.equal(input.value, 'Denver', 'the typed text survived the round trip');
  h.close();
});

test('an async rejection keeps the typed text so it can be corrected', async () => {
  const h = await panelWithField({ reject: true, asyncField: true });
  const input = h.input();
  input.value = 'qqqzzz nowhere';
  key(h.row().querySelector('.data-toggle-field'), 'Enter');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(h.committed, ['qqqzzz nowhere']);
  assert.equal(input.value, 'qqqzzz nowhere', 'not reset to the old value');
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

/**
 * Build a panel over the rail fixture whose single ordinary row carries an
 * ordered list, and hand back the clicks it received. The list is what a layer
 * uses for a sequence — turn-by-turn steps, and the storm report the user picks
 * out of a feed — so an item may drive the layer with `params` or do its own
 * work with `onClick`.
 */
async function panelWithList(items) {
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
  const controls = {
    readout: false,
    chips: [],
    legend: [],
    list: { items },
  };
  const calls = [];
  const panel = new LayerPanel({
    getLayers: () => [layer],
    isEnabled: () => true,
    setEnabled: () => {},
    setLayerParams: (...args) => calls.push(args),
    hasRowControls: () => true,
    subscribeRowControls: () => () => {},
    getRowControls: () => controls,
  });
  try {
    panel.mount(f.container);
  } catch (error) {
    panel.destroy();
    globalThis.document = previousDocument;
    throw error;
  }
  const row = () => f.find((n) => n.dataset.layerId === 'storm');
  const button = (id) => {
    const list = row().querySelector('.data-row-list');
    const entry = list.children.find((n) => n.dataset.listItemId === id);
    return entry.querySelector('.data-row-list-item');
  };
  return {
    panel,
    calls,
    row,
    button,
    /** Dispatch a click the way the DOM would, ignoring the disabled guard. */
    rawClick(id) {
      const node = button(id);
      for (let at = node; at; at = at.parent) {
        const event = new Event('click');
        Object.defineProperty(event, 'target', { value: node });
        at.dispatchEvent(event);
      }
    },
    close() {
      panel.destroy();
      globalThis.document = previousDocument;
    },
  };
}

test('a list item with only onClick runs it instead of going inert', async () => {
  const clicked = [];
  const h = await panelWithList([
    { id: 'a', text: 'Hail 2.75in', onClick: () => clicked.push('a') },
  ]);
  h.button('a').click();
  assert.deepEqual(clicked, ['a'], 'the item did its own work');
  assert.deepEqual(h.calls, [], 'and set no params it never declared');
  h.close();
});

test('a list item with only params still applies them to the layer', async () => {
  const h = await panelWithList([
    { id: 'a', text: 'Step one', params: { focus: 'a' } },
  ]);
  h.button('a').click();
  assert.deepEqual(h.calls, [['storm', { focus: 'a' }, { origin: 'user' }]]);
  h.close();
});

test('onClick wins over params when a list item declares both', async () => {
  const clicked = [];
  const h = await panelWithList([
    {
      id: 'a',
      text: 'Both',
      params: { focus: 'a' },
      onClick: () => clicked.push('a'),
    },
  ]);
  h.button('a').click();
  assert.deepEqual(clicked, ['a'], 'onClick took precedence');
  assert.deepEqual(h.calls, [], 'so the params fallback never ran');
  h.close();
});

test('a disabled list item does nothing at all', async () => {
  const clicked = [];
  const h = await panelWithList([
    {
      id: 'a',
      text: 'Disabled',
      disabled: true,
      params: { focus: 'a' },
      onClick: () => clicked.push('a'),
    },
  ]);
  h.button('a').click();
  assert.deepEqual(clicked, [], 'the DOM never delivered the click');
  assert.deepEqual(h.calls, []);
  // Force the event past the disabled attribute the way a browser would after
  // the node was disabled by an earlier sync; the handler must still refuse.
  h.rawClick('a');
  assert.deepEqual(clicked, [], 'and the handler refused it too');
  assert.deepEqual(h.calls, []);
  h.close();
});

test('a list item left on a disabled layer does nothing', async () => {
  // Turning a layer off does not tear down its row's controls, so the list
  // nodes survive with their handlers and their item ids intact. A click that
  // lands on one after the layer went off must not drive it.
  const clicked = [];
  const h = await panelWithList([
    { id: 'a', text: 'Stale step', params: { focus: 'a' } },
    { id: 'b', text: 'Stale onClick', onClick: () => clicked.push('b') },
  ]);
  h.panel.isEnabled = () => false;
  h.rawClick('a');
  h.rawClick('b');
  assert.deepEqual(h.calls, [], 'no params reached the disabled layer');
  assert.deepEqual(clicked, [], 'and no item callback ran');
  h.close();
});

/** A panel whose one layer returns the optional window control. */
async function panelWithRange({ withRange = true } = {}) {
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
  const calls = [];
  const controls = {
    readout: false,
    chips: [{ id: 'a', label: 'A' }],
    legend: [],
    info: 'info',
  };
  if (withRange) {
    controls.range = {
      id: 'w',
      min: 0,
      max: 29,
      step: 1,
      value: [4, 9],
      ariaLabel: 'Storm day window',
      readout: 'a window',
      onInput: (from, to) => calls.push(['input', from, to]),
      onCommit: (from, to) => calls.push(['commit', from, to]),
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
  const h = {
    panel,
    calls,
    row,
    box: () => row().querySelector('.data-toggle-range'),
    // The fixture answers class selectors with the FIRST match only, and
    // find() returns a single node, so both sliders are walked directly.
    inputs: () => {
      const box = h.box();
      const out = [];
      const walk = (node) => {
        if (node.className === 'data-toggle-range-input') out.push(node);
        for (const child of node.children || []) walk(child);
      };
      walk(box);
      return out;
    },
    close() {
      panel.destroy();
      globalThis.document = previousDocument;
    },
  };
  return h;
}

/**
 * Dispatch from `node` up to the row, because the fixture's EventTarget does
 * not bubble - its own click() helper walks the chain for the same reason.
 */
function fire(node, type, stopAt) {
  for (let current = node; current; current = current.parent) {
    const event = new Event(type, { bubbles: true });
    // The delegated handler reads event.target; the fixture's Event carries none.
    Object.defineProperty(event, 'target', { value: node });
    current.dispatchEvent(event);
    if (current === stopAt) break;
  }
}

test('a layer offering a range gets two labelled sliders', async () => {
  const h = await panelWithRange();
  const box = h.box();
  assert.ok(box, 'the range container is rendered');
  assert.equal(box.hidden, false);
  const [from, to] = h.inputs();
  assert.ok(from && to, 'with two sliders, not one');
  assert.equal(from.dataset.rangeEnd, 'from');
  assert.equal(to.dataset.rangeEnd, 'to');
  assert.equal(from.min, '0');
  assert.equal(from.max, '29');
  assert.equal(from.value, '4');
  assert.equal(to.value, '9');
  assert.match(from.getAttribute('aria-label'), /from/i);
  h.close();
});

test('a drag reports on input and again on commit', async () => {
  const h = await panelWithRange();
  const [from] = h.inputs();
  from.value = '7';
  fire(from, 'input', h.box());
  assert.deepEqual(h.calls[0], ['input', 7, 9]);
  fire(from, 'change', h.box());
  assert.deepEqual(h.calls[1], ['commit', 7, 9]);
  h.close();
});

test('crossed thumbs are reported as a window, not a reversed one', async () => {
  const h = await panelWithRange();
  const [from, to] = h.inputs();
  // The start thumb dragged past the end still means a window with a start.
  from.value = '20';
  fire(from, 'change', h.box());
  assert.deepEqual(
    h.calls.at(-1),
    ['commit', 9, 20],
    'start dragged past the end is still a window, ordered',
  );
  to.value = '2';
  fire(to, 'change', h.box());
  assert.deepEqual(
    h.calls.at(-1),
    ['commit', 2, 20],
    'and the end dragged back past the start, likewise',
  );
  h.close();
});

test('a refresh keeps the slider where the user left it', async () => {
  const h = await panelWithRange();
  const [from] = h.inputs();
  from.value = '12';
  h.panel._renderToggles();
  assert.equal(from.value, '12', 'the node is reconciled, not rebuilt');
  assert.equal(h.inputs().length, 2, 'not rebuilt on every refresh');
  h.close();
});

test('a layer with no range renders exactly as before', async () => {
  const h = await panelWithRange({ withRange: false });
  const box = h.box();
  assert.ok(box, 'the container still exists');
  assert.equal(box.hidden, true, 'and is hidden');
  assert.equal(box._rowRangeNodes, null, 'with no sliders built');
  assert.ok(h.row().querySelector('.data-toggle-chip'), 'chips unaffected');
  h.close();
});

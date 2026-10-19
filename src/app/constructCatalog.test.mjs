import { createSurfaceServices } from './surfaceServices.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationCatalog } from './constructCatalog.js';
import { createStandaloneLayerSources } from '../standalone/layerSources.js';
import { catalogControlServices } from './catalog.js';
import { LayerLifecycle } from '../data/lifecycle.js';
import { fakeStreetLevelProvider } from '../testSupport/streetLevelFakes.mjs';

function fixtureSources(ids, calls) {
  const sources = createStandaloneLayerSources();
  sources.military = {
    getSnapshot: async () => {
      throw new Error('Use identity acquisition');
    },
    async getIdentities(_query, { signal }) {
      calls.push(signal);
      return ids;
    },
  };
  return sources;
}

test('catalogs construct distinct layers and classification from their supplied source', async (t) => {
  const a = new AbortController();
  const b = new AbortController();
  t.after(() => {
    a.abort();
    b.abort();
  });
  const callsA = [];
  const callsB = [];
  const first = createApplicationCatalog({
    sources: fixtureSources(['abc123'], callsA),
    signal: a.signal,
    surface: fixtureSurface(a.signal),
  });
  const second = createApplicationCatalog({
    sources: fixtureSources(['def456'], callsB),
    signal: b.signal,
    surface: fixtureSurface(b.signal),
  });
  assert.equal(first.layers.length, 34);
  assert.ok(first.get('local-adsb'), 'Local ADS-B is registered');
  assert.deepEqual(
    first.metadata.find(({ id }) => id === 'local-adsb'),
    { id: 'local-adsb', disposition: 'local-only' },
    'the hardware-local layer is never serialized into links',
  );
  assert.notEqual(first.weatherClock, second.weatherClock);
  await first.weatherClock.setTarget('2026-09-21T12:00:00.000Z');
  assert.match(
    first.get('wind').getRowControls().info,
    /Forecast · does not follow history/,
  );
  assert.equal(second.get('wind').getRowControls().summary.status, null);
  for (const id of ['weather-radar', 'weather-satellite', 'weather-lightning'])
    assert.equal(
      first.get(id).getDiagnostics().clock.target,
      '2026-09-21T12:00:00.000Z',
    );
  assert.ok(first.get('fire-perimeters'));
  assert.ok(first.get('storm-observed'), 'the storm surface is registered');
  assert.ok(first.get('transit'));
  const order = first.layers.map(({ id }) => id);
  assert.deepEqual(
    order.slice(order.indexOf('traffic'), order.indexOf('directions') + 1),
    ['traffic', 'cctv', 'radio', 'transit', 'bikeshare', 'directions'],
  );
  assert.ok(first.get('bhote-koshi-2026'));
  assert.ok(first.get('bhote-koshi-locator'));
  const lifecycle = new LayerLifecycle({});
  for (const layer of first.layers) lifecycle.register(layer);
  const rows = lifecycle.getAll();
  for (const id of ['bhote-koshi-2026', 'bhote-koshi-locator']) {
    assert.equal(
      rows.find((row) => row.id === id)?.showInTogglePanel,
      false,
      `${id} remains registered for Scenes but is absent from Data Layers`,
    );
    assert.equal(typeof first.get(id).enable, 'function');
    assert.equal(typeof first.get(id).setParams, 'function');
  }
  assert.equal(
    rows.find((row) => row.id === 'flights')?.showInTogglePanel,
    true,
    'ordinary data layer entries remain visible',
  );
  assert.deepEqual(
    first.layers.map(({ id }) => id),
    second.layers.map(({ id }) => id),
  );
  for (const layer of first.layers)
    assert.notEqual(layer, second.get(layer.id));
  assert.equal(
    catalogControlServices(first).satellitesLayer,
    first.get('satellites'),
  );
  assert.equal(callsA.length, 0, 'construction must not acquire');
  await first.militaryRegistry.refreshMilitaryRegistryIfStale();
  await second.militaryRegistry.refreshMilitaryRegistryIfStale();
  assert.equal(first.militaryRegistry.isMilitaryIcao('abc123'), true);
  assert.equal(first.militaryRegistry.isMilitaryIcao('def456'), false);
  assert.equal(second.militaryRegistry.isMilitaryIcao('def456'), true);
  a.abort();
  assert.equal(
    await first.weatherClock.setTarget('2026-09-21T13:00:00.000Z'),
    false,
  );
  assert.equal(callsA[0].aborted, true);
  assert.equal(first.militaryRegistry.isMilitaryIcao('abc123'), false);
  assert.equal(callsB[0].aborted, false);
  assert.equal(second.militaryRegistry.isMilitaryIcao('def456'), true);
});

test('invalid or already cancelled construction fails before classification can acquire', () => {
  const lifetime = new AbortController();
  assert.throws(
    () =>
      createApplicationCatalog({
        sources: { flights: {} },
        signal: lifetime.signal,
        surface: fixtureSurface(lifetime.signal),
      }),
    /catalog source/,
  );
  lifetime.abort();
  assert.throws(
    () =>
      createApplicationCatalog({
        sources: createStandaloneLayerSources(),
        signal: lifetime.signal,
      }),
    { name: 'AbortError' },
  );
});

function fixtureSurface(signal) {
  return createSurfaceServices({
    terrainSource: { getHeights: async () => [] },
    signal,
    eventTarget: null,
  });
}

test('Mapillary can be omitted or replaced without changing catalog membership', (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const sources = fixtureSources([], []);
  delete sources.mapillary;
  const options = {
    sources,
    signal: lifetime.signal,
    surface: fixtureSurface(lifetime.signal),
  };
  const catalog = createApplicationCatalog(options);
  assert.equal(catalog.layers.length, 34);
  assert.deepEqual(catalog.get('street-level').providerIds, []);
  assert.equal(
    catalogControlServices(catalog).streetLevelLayer,
    catalog.get('street-level'),
  );
  assert.match(
    catalog.get('street-level').getUIState().coverage.hint,
    /No street-level imagery providers/,
  );
  const provider = fakeStreetLevelProvider({
    id: 'example',
    pickPrefix: 'example:',
  });
  const replacement = createApplicationCatalog({
    ...options,
    streetLevelProviders: [provider],
  });
  assert.deepEqual(replacement.get('street-level').providerIds, ['example']);
  assert.deepEqual(replacement.metadata, catalog.metadata);
  assert.equal(provider.calls.activate, 0, 'construction must not acquire');
  assert.deepEqual(
    createApplicationCatalog({
      ...options,
      sources: fixtureSources([], []),
      streetLevelProviders: [],
    }).get('street-level').providerIds,
    [],
  );
  assert.throws(
    () =>
      createApplicationCatalog({
        ...options,
        sources: { ...sources, mapillary: {} },
      }),
    /Mapillary source/,
  );
});

test('isolation reaches every layer that can honour it, and is released on abort', async (t) => {
  // The area used to be wired to exactly one layer by hand, so isolating
  // Colorado filtered the storm reports and left every other hazard layer
  // showing the whole world. This asserts the property that replaced it: every
  // layer EXPOSING setIsolation gets told, and none that does not is handed an
  // area it would silently drop.
  const controller = new AbortController();
  const catalog = createApplicationCatalog({
    sources: fixtureSources([], []),
    signal: controller.signal,
    surface: fixtureSurface(controller.signal),
  });
  t.after(() => controller.abort());

  const isolation = catalog.layers.find((l) => l.id === 'isolation');
  assert.ok(isolation, 'the isolation layer exists');

  const honours = catalog.layers.filter(
    (l) => typeof l?.setIsolation === 'function',
  );
  assert.ok(
    honours.length >= 2,
    `more than one layer honours an area (${honours.map((l) => l.id).join(', ')})`,
  );
  assert.ok(
    honours.some((l) => l.id === 'storm-reports'),
    'and storm-reports is still among them',
  );
  assert.ok(
    honours.some((l) => l.id === 'earthquakes'),
    'earthquakes now honours one too',
  );

  // A layer that cannot honour an area must not pretend to.
  assert.equal(
    typeof catalog.layers.find((l) => l.id === 'weather-radar')?.setIsolation,
    'undefined',
    'an imagery layer is not handed an area it cannot apply',
  );
  assert.equal(
    typeof catalog.layers.find((l) => l.id === 'wind')?.setIsolation,
    'undefined',
    'nor is the wind particle canvas',
  );

  // The area actually reaches them.
  const area = { bbox: [-109.05, 37, -102.04, 41] };
  assert.ok(
    isolation.setIsolationText,
    'the layer can resolve an area by name',
  );
  const resolved = await isolation.setIsolationText('Colorado');
  assert.equal(resolved.ok, true, 'Colorado resolves');
  for (const layer of honours) {
    if (layer.id === 'isolation') continue;
    assert.ok(layer.getIsolation?.(), `${layer.id} was told about the area`);
  }

  // And the listeners are released. `onAreaChange` returns a disposer; the
  // single-subscriber version called it as a bare statement and the comment
  // claimed a teardown path that did not exist.
  const before = honours.length;
  controller.abort();
  assert.equal(
    isolation.getIsolation?.() !== undefined,
    true,
    'the layer itself is unaffected by teardown',
  );
  assert.ok(before >= 2, 'and the subscribers were registered to be released');
});

test('clearing the area returns the subscribers to null', (t) => {
  const controller = new AbortController();
  const catalog = createApplicationCatalog({
    sources: fixtureSources([], []),
    signal: controller.signal,
    surface: fixtureSurface(controller.signal),
  });
  t.after(() => controller.abort());
  const isolation = catalog.layers.find((l) => l.id === 'isolation');
  const earthquakes = catalog.layers.find((l) => l.id === 'earthquakes');
  return (async () => {
    await isolation.setIsolationText('Colorado');
    assert.ok(earthquakes.getIsolation?.(), 'set');
    await isolation.setIsolationText('');
    assert.equal(earthquakes.getIsolation?.(), null, 'and cleared');
  })();
});

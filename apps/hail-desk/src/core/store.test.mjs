import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from './store.js';
import { decodeDeskUrl, encodeDeskUrl, CORE_DEFAULTS } from './urlCodec.js';
import { createDataLoader } from './dataLoader.js';

test('store initializes with CORE_DEFAULTS and immutable snapshot', () => {
  const store = createStore();
  const state = store.getState();

  assert.equal(state.state, 'CO');
  assert.equal(state.mode, 'split');
  assert.equal(state.frame, 'DAY');
  assert.equal(state.view, 'storm');
  assert.equal(state.fromYear, 1955);
  assert.equal(state.toYear, 2026);
  assert.equal(state.minHailTenths, 10);

  // Assert immutability
  assert.throws(() => {
    state.mode = 'map';
  }, TypeError);
});

test('setState updates state and invokes subscribers synchronously', () => {
  const store = createStore();
  const history = [];

  const unsub = store.subscribe((next) => {
    history.push(next.mode);
  });

  store.setMode('knock');
  store.setMode('dossier');
  store.setMode('dossier'); // duplicate update should not fire

  assert.deepEqual(history, ['knock', 'dossier']);

  unsub();
  store.setMode('map');
  assert.deepEqual(history, ['knock', 'dossier'], 'unsubscribed listener must not be called');
});

test('convenience actions update state and clear drilldowns appropriately', () => {
  const store = createStore({
    focusedTract: '08031006801',
    focusedStreet: 42,
  });

  // selectState changes state and resets tract/street drilldowns
  store.selectState('tx');
  let state = store.getState();
  assert.equal(state.state, 'TX');
  assert.equal(state.focusedTract, null);
  assert.equal(state.focusedStreet, null);

  // selectStormDay
  store.selectStormDay('2024-06-01');
  state = store.getState();
  assert.equal(state.d, '2024-06-01');

  // setFrame
  store.setFrame('18Z');
  state = store.getState();
  assert.equal(state.frame, '18Z');

  // toggleIsolation
  assert.equal(state.iso, '');
  store.toggleIsolation();
  assert.equal(store.getState().iso, 'state');
  store.toggleIsolation();
  assert.equal(store.getState().iso, '');

  // toggleBasemap
  assert.equal(store.getState().basemap, 'road');
  store.toggleBasemap();
  assert.equal(store.getState().basemap, 'satellite');
  store.toggleBasemap();
  assert.equal(store.getState().basemap, 'road');

  // New core convenience actions
  store.setView('city');
  assert.equal(store.getState().view, 'city');

  store.setSort('units', 'asc');
  assert.equal(store.getState().sort, 'units');
  assert.equal(store.getState().dir, 'asc');

  store.setStormSort('houses', 'asc');
  assert.equal(store.getState().dsort, 'houses');
  assert.equal(store.getState().ddir, 'asc');

  store.setScope('prospect');
  assert.equal(store.getState().dscope, 'prospect');

  store.setYearRange(2020, 2024);
  assert.equal(store.getState().fromYear, 2020);
  assert.equal(store.getState().toYear, 2024);
});

test('urlCodec normalizes casing for modes and frames', () => {
  const decoded = decodeDeskUrl('#mode=MAP&frame=18z');
  assert.equal(decoded.mode, 'map');
  assert.equal(decoded.frame, '18Z');
});

test('store binds and unbinds to window hashchange events', () => {
  let listener = null;
  const mockWin = {
    location: { hash: '#mode=knock&frame=06Z' },
    addEventListener(event, fn) {
      if (event === 'hashchange') listener = fn;
    },
    removeEventListener(event, fn) {
      if (event === 'hashchange' && listener === fn) listener = null;
    },
  };

  const store = createStore();
  const unbind = store.bindWindowHash(mockWin);

  assert.equal(typeof listener, 'function');
  mockWin.location.hash = '#mode=dossier&frame=12Z';
  listener();

  assert.equal(store.getState().mode, 'dossier');
  assert.equal(store.getState().frame, '12Z');

  unbind();
  assert.equal(listener, null);
});

test('urlCodec round-trips state cleanly and preserves backward compatibility', () => {
  const initial = {
    ...CORE_DEFAULTS,
    state: 'CO',
    d: '2024-06-01',
    mode: 'knock',
    frame: '18Z',
    minHailTenths: 15,
  };

  const encoded = encodeDeskUrl(initial);
  assert.ok(encoded.startsWith('#'));
  assert.ok(encoded.includes('mode=knock'));
  assert.ok(encoded.includes('frame=18Z'));

  const decoded = decodeDeskUrl(encoded);
  assert.equal(decoded.state, 'CO');
  assert.equal(decoded.d, '2024-06-01');
  assert.equal(decoded.mode, 'knock');
  assert.equal(decoded.frame, '18Z');
  assert.equal(decoded.minHailTenths, 15);
});

test('urlCodec safely defaults on malformed or empty inputs', () => {
  const decoded = decodeDeskUrl('bad_hash');
  assert.equal(decoded.state, 'CO');
  assert.equal(decoded.mode, 'split');
  assert.equal(decoded.frame, 'DAY');
  assert.equal(decoded.minHailTenths, 10);
});

test('dataLoader deduplicates in-flight calls and caches results', async () => {
  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount++;
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-encoding', 'identity']]),
      text: async () => JSON.stringify({ places: [{ name: 'Denver' }] }),
      json: async () => ({ places: [{ name: 'Denver' }] }),
    };
  };

  const loader = createDataLoader({ fetchImpl: mockFetch });

  // Call loadCityOutlines twice concurrently
  const [res1, res2] = await Promise.all([
    loader.loadCityOutlines('CO'),
    loader.loadCityOutlines('CO'),
  ]);

  assert.equal(fetchCount, 1, 'concurrent requests must deduplicate to single fetch');
  assert.deepEqual(res1, res2);

  // Subsequent call reads from cache
  const res3 = await loader.loadCityOutlines('CO');
  assert.equal(fetchCount, 1, 'cached request must not trigger fetch');
  assert.deepEqual(res3, res1);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DATA_SCOPE_STORAGE_KEY,
  createScopeController,
  readStoredDataScope,
  writeStoredDataScope,
} from './scopeController.js';
import { SCOPE_GLOBAL, SCOPE_VIEWPORT } from './dataScope.js';

/** In-memory localStorage stand-in. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    get size() {
      return map.size;
    },
  };
}

/** Minimal viewer: a rectangle fixed at one place. */
function fakeViewer({
  south = 39.6,
  west = -105.4,
  north = 39.7,
  east = -105.3,
} = {}) {
  const d = Math.PI / 180;
  return {
    camera: {
      computeViewRectangle: () => ({
        south: south * d,
        west: west * d,
        north: north * d,
        east: east * d,
      }),
    },
  };
}

function fakeDataManager(ids = ['local-firms'], { fail = [] } = {}) {
  const refreshed = [];
  return {
    refreshed,
    getEnabledLayerIds: () => ids,
    async refreshLayer(id) {
      if (fail.includes(id)) throw new Error(`cannot refresh ${id}`);
      refreshed.push(id);
      return true;
    },
  };
}

test('the setting persists and round-trips', () => {
  const storage = fakeStorage();
  assert.equal(readStoredDataScope(storage), SCOPE_GLOBAL, 'default is global');
  writeStoredDataScope(SCOPE_VIEWPORT, storage);
  assert.equal(storage.getItem(DATA_SCOPE_STORAGE_KEY), 'viewport');
  assert.equal(readStoredDataScope(storage), SCOPE_VIEWPORT);
});

test('an unknown stored value falls back to global', () => {
  const storage = fakeStorage({ [DATA_SCOPE_STORAGE_KEY]: 'sideways' });
  assert.equal(readStoredDataScope(storage), SCOPE_GLOBAL);
});

test('storage that throws does not break the setting', () => {
  const hostile = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(readStoredDataScope(hostile), SCOPE_GLOBAL);
  assert.equal(writeStoredDataScope(SCOPE_VIEWPORT, hostile), SCOPE_VIEWPORT);
});

test('global mode asks for no region', () => {
  const c = createScopeController({
    viewer: fakeViewer(),
    dataManager: fakeDataManager(),
    storage: fakeStorage(),
  });
  assert.equal(c.getScope().mode, SCOPE_GLOBAL);
  assert.equal(c.getScope().region, null);
  assert.equal(c.getScope().query, '', 'an empty query is what means "world"');
});

test('viewport mode derives a region from the camera', () => {
  const c = createScopeController({
    viewer: fakeViewer(),
    dataManager: fakeDataManager(),
    storage: fakeStorage(),
  });
  return c.setMode(SCOPE_VIEWPORT).then((state) => {
    assert.equal(state.mode, SCOPE_VIEWPORT);
    assert.ok(state.region, 'a viewport region is required');
    assert.match(state.query, /^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/);
  });
});

test('switching scope re-runs every enabled layer', async () => {
  const dm = fakeDataManager(['local-firms', 'earthquakes']);
  const c = createScopeController({
    viewer: fakeViewer(),
    dataManager: dm,
    storage: fakeStorage(),
  });
  await c.setMode(SCOPE_VIEWPORT);
  assert.deepEqual(dm.refreshed.sort(), ['earthquakes', 'local-firms']);
});

test('a disabled layer is not refetched', async () => {
  const dm = fakeDataManager(['local-firms']);
  const c = createScopeController({
    viewer: fakeViewer(),
    dataManager: dm,
    storage: fakeStorage(),
  });
  await c.setMode(SCOPE_VIEWPORT);
  assert.deepEqual(dm.refreshed, ['local-firms']);
});

test('one failing layer does not abort the others', async () => {
  const dm = fakeDataManager(['local-firms', 'earthquakes'], {
    fail: ['local-firms'],
  });
  const c = createScopeController({
    viewer: fakeViewer(),
    dataManager: dm,
    storage: fakeStorage(),
  });
  const state = await c.setMode(SCOPE_VIEWPORT);
  assert.deepEqual(
    dm.refreshed,
    ['earthquakes'],
    'the healthy layer still ran',
  );
  assert.match(state.lastError, /local-firms/, 'and the failure is reported');
});

test('setting the mode it is already in is a no-op', async () => {
  const dm = fakeDataManager(['local-firms']);
  const c = createScopeController({
    viewer: fakeViewer(),
    dataManager: dm,
    storage: fakeStorage(),
  });
  await c.setMode(SCOPE_GLOBAL);
  assert.deepEqual(dm.refreshed, [], 'no needless refetch, no quota spend');
});

test('a slow switch cannot land on top of a newer one', async () => {
  // This is the whole reason the generation guard exists: two toggles during an
  // in-flight refetch must leave the reported mode as the last one requested.
  const dm = fakeDataManager(['local-firms']);
  const c = createScopeController({
    viewer: fakeViewer(),
    dataManager: dm,
    storage: fakeStorage(),
  });

  const slow = new Promise((resolve) => setTimeout(resolve, 20));
  const original = dm.refreshLayer.bind(dm);
  dm.refreshLayer = async (id) => {
    await slow;
    return original(id);
  };

  const first = c.setMode(SCOPE_VIEWPORT);
  const second = c.setMode(SCOPE_GLOBAL);
  const [, finalState] = await Promise.all([first, second]);

  assert.equal(finalState.mode, SCOPE_GLOBAL, 'the newer switch wins');
  assert.equal(c.getState().mode, SCOPE_GLOBAL, 'and the controller agrees');
  assert.equal(finalState.switching, false, 'the flag is not left stuck on');
});

test('refreshRegion only reports a real change', () => {
  const viewer = fakeViewer();
  const c = createScopeController({
    viewer,
    dataManager: fakeDataManager(),
    storage: fakeStorage({ [DATA_SCOPE_STORAGE_KEY]: SCOPE_VIEWPORT }),
  });
  assert.equal(c.refreshRegion(), false, 'the camera has not moved');
  viewer.camera.computeViewRectangle = () => ({
    south: 41 * (Math.PI / 180),
    west: -105.4 * (Math.PI / 180),
    north: 41.1 * (Math.PI / 180),
    east: -105.3 * (Math.PI / 180),
  });
  assert.equal(c.refreshRegion(), true, 'a new cell is a new region');
});

test('a camera that cannot report a rectangle does not throw', () => {
  const c = createScopeController({
    viewer: { camera: {} },
    dataManager: fakeDataManager(),
    storage: fakeStorage({ [DATA_SCOPE_STORAGE_KEY]: SCOPE_VIEWPORT }),
  });
  assert.equal(c.getScope().region, null);
  assert.doesNotThrow(() => c.refreshRegion());
});

test('subscribers see every change', async () => {
  const seen = [];
  const c = createScopeController({
    viewer: fakeViewer(),
    dataManager: fakeDataManager(),
    storage: fakeStorage(),
  });
  c.subscribe((s) => seen.push(s.mode));
  await c.setMode(SCOPE_VIEWPORT);
  assert.ok(seen.includes(SCOPE_VIEWPORT));
});

test('a throwing subscriber does not stop the others', async () => {
  const seen = [];
  const c = createScopeController({
    viewer: fakeViewer(),
    dataManager: fakeDataManager(),
    storage: fakeStorage(),
  });
  c.subscribe(() => {
    throw new Error('bad subscriber');
  });
  c.subscribe((s) => seen.push(s.mode));
  await c.setMode(SCOPE_VIEWPORT);
  assert.ok(seen.includes(SCOPE_VIEWPORT));
});

// --- regressions ------------------------------------------------------------

test('a Set of enabled layers is normalised, not silently skipped', async () => {
  // getEnabledLayerIds returns a Set (lifecycle.js). Reading .length off a Set
  // is undefined, which once made refreshScopedLayers bail out and refetch
  // nothing at all on a mode switch.
  const refreshed = [];
  const ctl = createScopeController();
  ctl.attach({
    viewer: null,
    dataManager: {
      getEnabledLayerIds: () => new Set(['firms', 'flights']),
      refreshLayer: (id) => {
        refreshed.push(id);
      },
    },
  });
  await ctl.setMode('viewport');
  assert.deepEqual(refreshed.sort(), ['firms', 'flights']);
});

test('an array of enabled layers still works', async () => {
  const refreshed = [];
  const ctl = createScopeController();
  ctl.attach({
    viewer: null,
    dataManager: {
      getEnabledLayerIds: () => ['firms'],
      refreshLayer: (id) => refreshed.push(id),
    },
  });
  await ctl.setMode('viewport');
  assert.deepEqual(refreshed, ['firms']);
});

test('camera moveEnd refreshes layers when the region actually changes', () => {
  // The user pans somewhere new; providers must be asked about the new region.
  const refreshed = [];
  let box = { south: 0, west: 0, north: 1, east: 1 };
  let handler = null;
  const D = Math.PI / 180;
  const viewer = {
    camera: {
      computeViewRectangle: () => ({
        south: box.south * D,
        west: box.west * D,
        north: box.north * D,
        east: box.east * D,
      }),
      moveEnd: {
        addEventListener: (fn) => {
          handler = fn;
          return () => {
            handler = null;
          };
        },
      },
    },
  };
  const ctl = createScopeController();
  ctl.attach({
    viewer,
    dataManager: {
      getEnabledLayerIds: () => new Set(['firms']),
      refreshLayer: (id) => refreshed.push(id),
    },
  });
  ctl.setMode('viewport');
  // setMode itself refetches; the pan behaviour is what is under test.
  refreshed.length = 0;

  const before = ctl.getScope().region;
  // Same box: nothing to do.
  handler?.();
  assert.equal(refreshed.length, 0, 'a no-op pan must not refetch');

  // Pan far enough that the quantised region changes.
  box = { south: 40, west: -80, north: 41, east: -79 };
  handler?.();
  assert.notDeepEqual(ctl.getScope().region, before);
  assert.deepEqual(refreshed, ['firms'], 'a real pan must refetch');
});

/**
 * End-to-end wiring check for viewport scoping.
 *
 * Uses the real scope controller, the real USGS source, and the real OpenSky
 * URL builder. The only fakes are the camera (it cannot be constructed without
 * a GL context) and the transport (so requests can be recorded rather than
 * billed). The question under test is the one that unit tests kept missing:
 * does a camera moveEnd actually re-drive the layer sources, end to end?
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createScopeController } from './scopeController.js';
import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { buildOpenSkyStatesUrl } from '../../server/providers/aircraft/opensky.js';

const D = Math.PI / 180;

/** A camera good enough for scoping: a settable view rectangle plus moveEnd. */
function fakeViewer(startBox) {
  let box = { ...startBox };
  let handler = null;
  return {
    get box() {
      return box;
    },
    flyTo(next) {
      box = { ...next };
      handler?.();
    },
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
}

/**
 * Two invariants, and the second is the one people get wrong:
 *
 *  1. The region never reaches outside the requested view. Fetching data the
 *     user cannot see is pure waste — for FIRMS it is a real upstream bill.
 *  2. The region does cover the view *when the view is within the cap*.
 *     VIEWPORT_SCOPE_MAX_SPAN_DEG deliberately clamps a continent-sized view
 *     down to 1 degree, so a wide view is intentionally NOT fully covered.
 */
function assertWithinRequest(region, box, label) {
  assert.ok(
    region.south >= box.south - 1e-9,
    `${label}: fetched south of the view`,
  );
  assert.ok(
    region.north <= box.north + 1e-9,
    `${label}: fetched north of the view`,
  );
  assert.ok(
    region.west >= box.west - 1e-9,
    `${label}: fetched west of the view`,
  );
  assert.ok(
    region.east <= box.east + 1e-9,
    `${label}: fetched east of the view`,
  );
}

function assertCovers(region, box, label) {
  assert.ok(region.south <= box.south + 1e-9, `${label}: south not covered`);
  assert.ok(region.north >= box.north - 1e-9, `${label}: north not covered`);
  assert.ok(region.west <= box.west + 1e-9, `${label}: west not covered`);
  assert.ok(region.east >= box.east - 1e-9, `${label}: east not covered`);
}

test('panning re-drives the real sources with a new region', async () => {
  const viewer = fakeViewer({ south: 37, west: -109.1, north: 41, east: -102 });
  const ctl = createScopeController();

  // The real USGS source, pointed at the controller, with a recording transport.
  const urls = [];
  const usgs = createUsgsEarthquakeSource({
    getScope: () => ctl.getScope(),
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ features: [] }) };
    },
  });

  let refreshes = 0;
  ctl.attach({
    viewer,
    // A Set, as lifecycle.js really returns — the shape that once made the
    // refresh a silent no-op.
    dataManager: {
      getEnabledLayerIds: () => new Set(['earthquakes']),
      refreshLayer: async () => {
        refreshes += 1;
        await usgs.getSnapshot();
      },
    },
  });

  await ctl.setMode('viewport');
  assert.equal(refreshes, 1, 'the mode switch must refresh enabled layers');
  const colorado = new URL(urls[0]);
  assert.match(colorado.pathname, /fdsnws/);
  // A continental view is capped, so containment is all that is claimed.
  assertWithinRequest(ctl.getScope().region, viewer.box, 'continental');

  // Pan to Kansas City. Nothing else in the app is involved from here.
  viewer.flyTo({ south: 38.9, west: -94.8, north: 39.2, east: -94.4 });
  assert.equal(refreshes, 2, 'a pan that changes the region must refresh');
  assertCovers(ctl.getScope().region, viewer.box, 'kansas city');
  const kansas = new URL(urls[1]);
  assert.notEqual(urls[1], urls[0], 'a pan must change the request');
  // regionToQueryParam rounds for the wire, so compare the bounds that actually
  // went out against the view, not against the in-memory region: rounding must
  // never be allowed to shrink the request past what the user can see.
  assertCovers(
    {
      south: Number(kansas.searchParams.get('minlatitude')),
      west: Number(kansas.searchParams.get('minlongitude')),
      north: Number(kansas.searchParams.get('maxlatitude')),
      east: Number(kansas.searchParams.get('maxlongitude')),
    },
    viewer.box,
    'kansas city (as sent)',
  );

  // A pan that stays inside the quantised cell must not re-buy the request.
  const before = urls.length;
  viewer.flyTo({ south: 38.91, west: -94.79, north: 39.19, east: -94.41 });
  assert.equal(
    urls.length,
    before,
    'sub-cell motion must not re-drive the provider',
  );
});

test('the region a pan produces is the one the OpenSky URL carries', async () => {
  const viewer = fakeViewer({
    south: 39.6,
    west: -105.4,
    north: 39.9,
    east: -104.9,
  });
  const ctl = createScopeController();
  ctl.attach({ viewer, dataManager: { getEnabledLayerIds: () => new Set() } });
  await ctl.setMode('viewport');

  const { region } = ctl.getScope();
  assert.ok(region, 'viewport mode must expose a region');
  // 0.5 degree span is well inside the cap, so the view must be fully covered.
  assertCovers(region, viewer.box, 'metro');
  const url = new URL(buildOpenSkyStatesUrl(ctl.getScope().query));
  assertCovers(
    {
      south: Number(url.searchParams.get('lamin')),
      west: Number(url.searchParams.get('lomin')),
      north: Number(url.searchParams.get('lamax')),
      east: Number(url.searchParams.get('lomax')),
    },
    viewer.box,
    'opensky (as sent)',
  );
});

test('global mode asks providers for no spatial filter at all', async () => {
  const viewer = fakeViewer({ south: 37, west: -109.1, north: 41, east: -102 });
  const ctl = createScopeController();
  const urls = [];
  const usgs = createUsgsEarthquakeSource({
    getScope: () => ctl.getScope(),
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ features: [] }) };
    },
  });
  ctl.attach({
    viewer,
    dataManager: {
      getEnabledLayerIds: () => new Set(['earthquakes']),
      refreshLayer: () => usgs.getSnapshot(),
    },
  });

  // Start scoped, then widen. Setting 'global' when it is already the default
  // is correctly a no-op, so the direction that matters is viewport -> global.
  await ctl.setMode('viewport');
  urls.length = 0;
  await ctl.setMode('global');
  assert.equal(
    urls[0],
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    'global mode must not narrow the request',
  );
  // ...and once global, panning must not trigger provider traffic.
  assert.equal(ctl.getScope().region, null);
  const before = urls.length;
  viewer.flyTo({ south: 40, west: -80, north: 41, east: -79 });
  assert.equal(urls.length, before, 'panning in global mode is free');
});

test('a whole-globe view rect falls back to the camera position', async () => {
  // Cesium reports the entire globe when it cannot compute the frustum, which
  // happens once the camera climbs to near-space. That rect's midpoint is
  // (0,0) — the Gulf of Guinea — so trusting it would fetch a box thousands of
  // miles from what the user is looking at.
  const D = Math.PI / 180;
  const cam = { lat: 26.165, lon: -114.291 };
  let handler = null;
  const viewer = {
    camera: {
      computeViewRectangle: () => ({
        south: -Math.PI / 2,
        west: -Math.PI,
        north: Math.PI / 2,
        east: Math.PI,
      }),
      positionCartographic: {
        latitude: cam.lat * D,
        longitude: cam.lon * D,
        height: 9_014_626,
      },
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
  ctl.attach({ viewer, dataManager: { getEnabledLayerIds: () => new Set() } });
  await ctl.setMode('viewport');

  const { region } = ctl.getScope();
  assert.ok(region, 'a region is still expected');
  // Must sit on the camera, not on the null island.
  assert.ok(region.south <= cam.lat && region.north >= cam.lat, 'latitude');
  assert.ok(region.west <= cam.lon && region.east >= cam.lon, 'longitude');
  assert.ok(
    Math.abs((region.south + region.north) / 2 - cam.lat) < 0.6,
    'region must be centred near the camera',
  );
});

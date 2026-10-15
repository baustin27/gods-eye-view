import assert from 'node:assert/strict';
import test from 'node:test';

import { firmsProxy } from '../providers/firms.js';

/**
 * Drive the plugin's middleware directly. The proxy only reaches upstream when
 * FIRMS_MAP_KEY is set, and these tests never set it, so every case here is the
 * keyless path — which is exactly the path a scope change must not disturb.
 */
function mount(overrides = {}) {
  const handlers = [];
  const server = {
    middlewares: { use: (route, fn) => handlers.push([route, fn]) },
  };
  firmsProxy({ ...overrides });
  // firmsProxy returns the vite plugin; installMiddleware is private, so invoke
  // the plugin's configure hook the way Vite does.
  const plugin = firmsProxy({ ...overrides });
  plugin.configureServer(server);
  const [, handler] = handlers.find(([route]) => route === '/api/firms') ?? [];
  return handler;
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload;
      this.settled = true;
    },
  };
}

/**
 * `req.url` as Vite's Connect middleware delivers it: the '/api/firms' mount
 * prefix is already stripped, so this is '/status', never '/api/firms/status'.
 */
const call = async (handler, url) => {
  const res = fakeRes();
  await handler({ url }, res);
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
  };
};

test('a world request behaves exactly as before', async () => {
  const handler = mount();
  assert.ok(handler, 'the /api/firms middleware must be installed');
  const res = await call(handler, '/');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'no_key');
});

test('an explicit empty bbox is the same as no bbox', async () => {
  const handler = mount();
  const res = await call(handler, '/?bbox=');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'no_key');
});

test('a malformed bbox is refused, not widened to world', async () => {
  const handler = mount();
  for (const bbox of [
    'not-a-box',
    '1,2,3',
    '1,2,3,4,5',
    'a,b,c,d',
    '',
    '   ',
  ]) {
    if (bbox.trim() === '') continue; // empty is legal and means world
    const res = await call(handler, `/?bbox=${encodeURIComponent(bbox)}`);
    assert.equal(res.status, 400, `bbox=${bbox} should be refused`);
  }
});

test('an inverted or out-of-range bbox is refused', async () => {
  const handler = mount();
  const bad = [
    '40,-105,39,-104', // inverted latitudes
    '-105,40,-104,39', // inverted longitudes
    '-95,10,40,20', // south below the pole
    '10,-190,20,-180', // west beyond the antimeridian
    '10,10,91,20', // north above the pole
  ];
  for (const bbox of bad) {
    const res = await call(handler, `/?bbox=${encodeURIComponent(bbox)}`);
    assert.equal(res.status, 400, `bbox=${bbox} should be refused`);
  }
});

test('the status route ignores bbox', async () => {
  const handler = mount();
  const res = await call(handler, '/status?bbox=39,-106,40,-105');
  assert.equal(res.status, 200);
  assert.equal(
    res.body.hasKey,
    false,
    'status reports key state, not region state',
  );
});

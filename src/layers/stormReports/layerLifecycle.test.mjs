import assert from 'node:assert/strict';
import test from 'node:test';

import { createStormReportsLayer } from './index.js';

const REPORT = (size, over = {}) => [
  '2026-08-10',
  600,
  0,
  size,
  35.1,
  -97.4,
  over.fips || '40027',
  over.state || 'OK',
  over.county || 'Cleveland',
  over.loss || 0,
  over.comment || '',
  'spc-bulk,ncei',
  0,
];

function stubViewer() {
  const entities = [];
  return {
    entities: {
      add(spec) {
        entities.push(spec);
        return spec;
      },
      removeAll() {
        entities.length = 0;
      },
      values: entities,
    },
    __entities: entities,
  };
}

function host() {
  const published = [];
  return {
    published,
    entityCollection: () => ({ add: (s) => s, removeAll() {} }),
    publish: (msg) => published.push(msg),
  };
}

function makeLayer(rows, events = []) {
  const source = {
    getSnapshot: async () => ({
      years: ['2026'],
      days: {
        '2026-08-10': { hail: rows.length, wind: 0, total: rows.length },
      },
      earliest: '2026-01-01',
      latest: '2026-08-10',
    }),
    reportsFor: async () => rows,
    eventsFor: async () => events,
  };
  const overlayHost = host();
  const layer = createStormReportsLayer({ source, overlayHost });
  layer._testReports = rows;
  layer._testEvents = events;
  return { layer, overlayHost };
}

test('update before enable does nothing and says so', async () => {
  const { layer } = makeLayer([REPORT(2)]);
  layer.init(stubViewer());
  assert.equal(
    await layer.update(),
    false,
    'a disabled layer has nothing to do',
  );
});

test('the first enable loads, renders and reports the change', async () => {
  const { layer, overlayHost } = makeLayer([REPORT(2), REPORT(1.5)]);
  layer.init(stubViewer());
  layer.enable();
  const changed = await layer.update();
  assert.equal(
    changed,
    true,
    'the manager rejects a false return while enabling',
  );
  assert.ok(overlayHost.published.length > 0, 'the layer publishes its state');
  const last = overlayHost.published.at(-1);
  assert.equal(last.id, 'storm-reports');
  assert.equal(typeof last.error === 'object' || last.error === null, true);
});

test('a layer that failed to load surfaces why, rather than hanging', async () => {
  const source = {
    getSnapshot: async () => {
      throw new Error('snapshot exploded');
    },
  };
  const overlayHost = host();
  const layer = createStormReportsLayer({ source, overlayHost });
  layer.init(stubViewer());
  layer.enable();
  const changed = await layer.update();
  assert.equal(typeof changed, 'boolean');
  const last = overlayHost.published.at(-1);
  assert.ok(last.error, 'the error reaches the overlay');
  assert.match(String(last.error.message), /snapshot exploded/);
});

test('the layer speaks the lifecycle protocol the manager drives', () => {
  // The manager calls enable(viewer)/disable(viewer) and judges the transition
  // by update()'s return. A layer that implements setEnabled instead looks
  // perfectly reasonable and fails every enable with "Could not enable the
  // requested layer" — which is exactly what happened.
  const { layer } = makeLayer([REPORT(2)]);
  for (const method of ['init', 'enable', 'disable', 'update', 'destroy']) {
    assert.equal(typeof layer[method], 'function', `${method} must exist`);
  }
  assert.equal(
    layer.setEnabled,
    undefined,
    'setEnabled is not the protocol and would silently do nothing',
  );
});

test('a second update with nothing changed reports no change', async () => {
  const { layer } = makeLayer([REPORT(2)]);
  layer.init(stubViewer());
  layer.enable();
  assert.equal(await layer.update(), true, 'the first enable renders');
  assert.equal(await layer.update(), false, 'the second has nothing to do');
});

test('a parameter change makes the next update do work again', async () => {
  const { layer } = makeLayer([REPORT(2)]);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  assert.equal(await layer.update(), false);
  layer.setParams({ minHailIn: 0.75 });
  assert.equal(await layer.update(), true, 'a new threshold is new work');
});

test('disabling clears the map and makes the next enable re-read', async () => {
  const { layer } = makeLayer([REPORT(2)]);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.disable();
  assert.equal(await layer.update(), false, 'a disabled layer does nothing');
  layer.enable();
  assert.equal(await layer.update(), true, 're-enabling loads again');
});

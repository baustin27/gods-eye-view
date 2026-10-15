import assert from 'node:assert/strict';
import test from 'node:test';

import { createStormReportsLayer } from './index.js';

let reportSeq = 0;
/** Each row gets its own time and position, as distinct reports would. */
const REPORT = (size, over = {}) => {
  const seq = reportSeq++;
  return [
    '2026-08-10',
    600 + seq * 5,
    0,
    size,
    35.1 + seq * 0.02,
    -97.4,
    over.fips || '40027',
    over.state || 'OK',
    over.county || 'Cleveland',
    over.loss || 0,
    over.comment || '',
    'spc-bulk,ncei',
    0,
  ];
};
function stubViewer() {
  const sources = [];
  return {
    dataSources: {
      add(source) {
        sources.push(source);
        return source;
      },
      remove(source) {
        const i = sources.indexOf(source);
        if (i >= 0) sources.splice(i, 1);
        return true;
      },
    },
    entities: {
      add() {},
      removeAll() {},
      values: [],
    },
    __sources: sources,
  };
}

/** Entities the layer currently holds on its own data source. */
function drawn(viewer) {
  return viewer.__sources.flatMap((s) => s.entities.values ?? []);
}

function host() {
  const entries = [];
  const visible = [];
  return {
    entries,
    visible,
    setEntries: (id, list) => {
      if (!Array.isArray(list))
        throw new TypeError('overlay entries must be an array');
      entries.push({ id, list });
    },
    setVisible: (id, on) => visible.push({ id, on }),
    clearSource: (id) => {
      const i = entries.findIndex((e) => e.id === id);
      if (i >= 0) entries.splice(i, 1);
    },
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
  assert.ok(overlayHost.entries.length > 0, 'the layer publishes panel state');
  const last = overlayHost.entries.at(-1);
  assert.equal(last.id, 'storm-reports');
  assert.ok(
    Array.isArray(last.list),
    'entries are an array, as the overlay requires',
  );
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
  const last = overlayHost.entries.at(-1);
  assert.equal(last.list.length, 0, 'a failed load offers no cards');
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

test('reports are drawn onto the layer data source, not shared entities', async () => {
  // Writing into viewer.entities would have every entity cleared by whichever
  // layer rendered last, and the aggregate storm layers already established
  // the CustomDataSource pattern this now follows.
  const viewer = stubViewer();
  const { layer } = makeLayer([
    REPORT(2),
    REPORT(1.75),
    REPORT(1),
    REPORT(0.5),
  ]);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(viewer.__sources.length, 1, 'one data source, added on init');
  // The default threshold is 1.0 inch, so the 0.5 report is filtered out.
  assert.equal(
    drawn(viewer).length,
    3,
    'only reports at or above 1 inch are drawn',
  );
});

test('lowering the threshold draws more', async () => {
  const viewer = stubViewer();
  const { layer } = makeLayer([REPORT(2), REPORT(0.5)]);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(drawn(viewer).length, 1, 'at the default 1 inch threshold');
  layer.setParams({ minHailTenths: 5 });
  await layer.update();
  assert.equal(drawn(viewer).length, 2, '0.5 inch now clears the 0.5 inch bar');
});

test('a report with no magnitude is never drawn as a small one', async () => {
  const viewer = stubViewer();
  const { layer } = makeLayer([REPORT(0), REPORT(2)]);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(drawn(viewer).length, 1, 'the zero-size row is filtered out');
});

test('an exact day narrows the view to that day alone', async () => {
  const viewer = stubViewer();
  // A second day proves the filter bites rather than passing everything through.
  const other = REPORT(2);
  other[0] = '2026-07-04';
  const rows = [REPORT(2), other];
  const { layer } = makeLayer(rows);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const before = drawn(viewer).length;
  assert.ok(before > 0);

  layer.setDate('2026-08-10');
  assert.deepEqual(layer.getDateRange(), {
    from: '2026-08-10',
    to: '2026-08-10',
  });
  await layer.update();
  const onDay = drawn(viewer);
  assert.ok(onDay.length > 0, 'the day still shows its own reports');
  // Cesium wraps entity properties in ConstantProperty; the value is reached
  // with getValue(), not by reading the field.
  assert.ok(
    onDay.every((e) => e.properties.date.getValue() === '2026-08-10'),
    'and nothing from another day',
  );
});

test('the window can be cleared back to the whole record', async () => {
  const { layer } = makeLayer([REPORT(2)]);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  assert.equal(layer.getDateRange().from, '2026-08-10');
  layer.clearDateRange();
  assert.deepEqual(layer.getDateRange(), { from: null, to: null });
});

test('the threshold is stored in tenths so the codec can carry it', () => {
  const { layer } = makeLayer([REPORT(2)]);
  layer.setMinHailIn(1);
  assert.equal(layer.getParams().minHailTenths, 10, 'one inch is ten tenths');
  layer.setMinHailIn(2.5);
  assert.equal(
    layer.getParams().minHailTenths,
    25,
    'two and a half inches is twenty-five',
  );
});

test('the panel offers exact days, not decades', async () => {
  const { layer } = makeLayer([REPORT(2)]);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  // The panel reads `controls.chips`; an array has none, and every control is
  // dropped without a word.
  const controls = layer.getRowControls();
  assert.ok(Array.isArray(controls?.chips), 'chips, as the panel expects');
  assert.equal(controls.readout, false, 'readout must not hide the chips');
  const chips = controls.chips;
  assert.ok(
    chips.some((c) => c.label === 'ALL DATES'),
    'a way back to the whole record',
  );
  assert.ok(
    chips.some((c) => /^20\d\d-\d\d-\d\d$/.test(c.label)),
    'exact days, not decades',
  );
  assert.ok(chips.length >= 3, 'several size thresholds');
  assert.ok(controls.legend.length >= 3, 'a size legend to colour the map by');
  assert.ok(controls.info, 'and a line saying what is on screen');
  assert.ok(
    chips.some((c) => c.id === 'storm-reports-wind'),
    'hazard switch',
  );
});

test('a date chip sets that exact day when clicked', async () => {
  const { layer } = makeLayer([REPORT(2)]);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  const chip = layer
    .getRowControls()
    .chips.find((c) => c.label === '2026-08-10');
  assert.ok(chip, 'the day appears as a chip');
  chip.onClick();
  assert.equal(layer.getDateRange().from, '2026-08-10');
});

test('the overlay is handed cards in the shape it demands', async () => {
  // setOverlayEntries throws unless given an array, and publish() runs inside
  // init(). Passing an object threw there, failed registration, and surfaced
  // only as the manager's generic "Could not enable the requested layer".
  const viewer = stubViewer();
  const overlayHost = host();
  const source = {
    getSnapshot: async () => ({
      years: ['2026'],
      days: { '2026-08-10': { hail: 3, wind: 0, total: 3 } },
    }),
    reportsFor: async () => [REPORT(2), REPORT(1.75), REPORT(1)],
    eventsFor: async () => [],
  };
  const layer = createStormReportsLayer({ source, overlayHost });
  assert.doesNotThrow(() => layer.init(viewer), 'init must not throw');
  layer.enable();
  await layer.update();
  const last = overlayHost.entries.at(-1);
  assert.ok(Array.isArray(last.list));
  assert.equal(last.list.length, 3, 'one card per report at or above 1 inch');
  const card = last.list[0];
  assert.ok(card.id, 'a card has an id');
  assert.ok(card.position, 'and a position to anchor to');
  assert.ok(card.title, 'and something to read');
});

test('a card names the place and the size', async () => {
  const viewer = stubViewer();
  const overlayHost = host();
  const source = {
    getSnapshot: async () => ({ years: ['2026'], days: {} }),
    reportsFor: async () => [
      REPORT(1.75, { county: 'Cleveland', state: 'OK' }),
    ],
    eventsFor: async () => [],
  };
  const layer = createStormReportsLayer({ source, overlayHost });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const [card] = overlayHost.entries.at(-1).list;
  assert.match(card.title, /1\.75 hail/);
  assert.match(card.title, /Cleveland/);
  assert.match(card.details, /2026-08-10/);
});

test('two identical reports at one point stay two markers', async () => {
  // Same date, same size, same coordinate, same hazard. Nothing in the wire
  // tuple is unique, and Cesium rejects a duplicate id outright - dropping
  // the entire rest of the collection, not just the repeat.
  const viewer = stubViewer();
  const rows = [REPORT(2), REPORT(2)];
  rows[1][4] = rows[0][4];
  rows[1][5] = rows[0][5];
  const { layer } = makeLayer(rows);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const ids = drawn(viewer).map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'every entity id is unique');
});

test('clicking a day chip repaints without waiting for update()', async () => {
  // The panel calls chip.onClick() and never calls update() afterwards, and
  // this layer sets updateInterval: 0, so nothing else will. Marking the
  // options dirty and waiting left the map on the previous selection - which
  // is how a working date view looks broken to the person using it.
  const viewer = stubViewer();
  const other = REPORT(2);
  other[0] = '2026-07-04';
  const { layer } = makeLayer([REPORT(2), other]);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(drawn(viewer).length, 2);

  const chip = layer
    .getRowControls()
    .chips.find((c) => c.id === 'storm-reports-2026-08-10');
  assert.ok(chip, 'the day is offered as a chip');
  chip.onClick();

  // No update() call - the repaint has to happen inside the click.
  const shown = drawn(viewer);
  assert.equal(shown.length, 1, 'the map narrowed on its own');
  assert.equal(shown[0].properties.date.getValue(), '2026-08-10');
});

test('the hail threshold chip repaints too', async () => {
  const viewer = stubViewer();
  const rows = [REPORT(1.75), REPORT(0.75)];
  const { layer } = makeLayer(rows);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(
    drawn(viewer).length,
    1,
    '0.75 inch is below the 1 inch default',
  );

  layer
    .getRowControls()
    .chips.find((c) => c.id === 'storm-reports-hail-075')
    .onClick();
  assert.equal(drawn(viewer).length, 2, 'the smaller report appeared at once');
});

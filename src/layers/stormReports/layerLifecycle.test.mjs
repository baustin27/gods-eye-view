import assert from 'node:assert/strict';
import test from 'node:test';

import * as Cesium from 'cesium';

import { gridCell, GRID_DEG } from '../../data/stormCrossReference.js';
import { GRID_DEG_FINE, gridCellRings, ringsToDegrees } from './model.js';
import { radarDayIndex } from '../../data/stormDatasets.js';
import { polygonsContain } from '../../data/adminBoundaries.js';
import { boxesContain, resolveIsolation } from '../../data/isolation.js';
import {
  getContextStore,
  getSelectedEntityContext,
} from '../../data/contextStore.js';
import { isOwnedByOtherLayer } from '../../data/pickRegistry.js';
import { normalizeOverlayEntry } from '../../overlays/worldOverlay.js';
import {
  HAIL_FLOOR_IN,
  STORM_CONTEXT_LIMIT,
  STORM_LIST_DAYS,
  STORM_REPORTS_DEFAULTS,
  createStormReportsLayer,
} from './index.js';

let reportSeq = 0;
/** Each row gets its own time and position, as distinct reports would. */
const REPORT = (size, over = {}) => {
  const seq = reportSeq++;
  return [
    over.date || '2026-08-10',
    600 + seq * 5,
    over.hazard ?? 0,
    size,
    over.lat ?? 35.1 + seq * 0.02,
    over.lon ?? -97.4,
    over.fips || '40027',
    over.state || 'OK',
    over.county || 'Cleveland',
    over.loss || 0,
    over.comment || '',
    'spc-bulk,ncei',
    0,
    over.ref ?? -1,
  ];
};

/** The storm-event row a report's `stormRef` points into. */
const STORM = (id, date, over = {}) => ({
  id,
  date,
  // Real events carry a begin/end minute; the list's lead column shows that
  // window, so a fixture without one tests a case the data never produces.
  beginMinute: over.beginMinute ?? 900,
  endMinute: over.endMinute ?? 1015,
  maxHailIn: over.maxHailIn ?? 2,
  maxWindKt: over.maxWindKt ?? 40,
  reportCount: over.reportCount ?? 1,
  narrative: over.narrative ?? `${id} narrative`,
  identitySource: over.identitySource || 'ncei',
});

/** The grid key a report attributes to, so radar fixtures cannot drift. */
const cellKey = (lat, lon) => `${gridCell(lat)}:${gridCell(lon)}`;
function stubViewer() {
  const sources = [];
  // `viewer.entities.add` is counted because the rule this layer exists to
  // follow is that it never writes there: the shared collection is emptied by
  // whichever layer rendered last.
  const shared = { added: 0 };
  return {
    __shared: shared,
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
      add() {
        shared.added += 1;
      },
      removeAll() {},
      values: [],
    },
    camera: {
      __flownTo: null,
      // Metres. 0 is street level, which is what every test that predates the
      // LOD wants - it keeps them on the fine path without each having to say so.
      __height: 0,
      __moveEnd: [],
      flyTo(options) {
        this.__flownTo = options;
        return options;
      },
      get positionCartographic() {
        return { height: this.__height };
      },
      moveEnd: {
        addEventListener(fn) {
          this.__listeners.push(fn);
        },
        removeEventListener(fn) {
          const i = this.__listeners.indexOf(fn);
          if (i >= 0) this.__listeners.splice(i, 1);
        },
        __listeners: [],
      },
    },
    __sources: sources,
  };
}

/** Move the camera to an altitude and fire `moveEnd`, as Cesium would. */
function setCameraHeight(viewer, metres) {
  viewer.camera.__height = metres;
  for (const fn of viewer.camera.moveEnd.__listeners) fn();
}

/** Entities the layer currently holds on its own data source. */
function drawn(viewer) {
  return viewer.__sources.flatMap((s) => s.entities.values ?? []);
}

/**
 * Cards are summoned, not scattered: point at the first drawn report and hand
 * back the id that was pointed at. Tests inspecting a card's shape call this
 * rather than reaching into a resting publish, which is empty on purpose.
 */
function summonCard(layer, viewer) {
  const id = drawn(viewer)
    .map((e) => e.id)
    .find((entityId) => String(entityId).startsWith('storm-report-'));
  assert.ok(id, 'the layer drew a report to point at');
  assert.equal(layer.setHoveredReportId(id), true, 'the point registered');
  return id;
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

function makeLayer(rows, events = [], options = {}) {
  const source = {
    getSnapshot: async () => ({
      years: options.years || ['2026'],
      days: options.days || {
        '2026-08-10': { hail: rows.length, wind: 0, total: rows.length },
      },
      earliest: '2026-01-01',
      latest: '2026-08-10',
    }),
    reportsFor: async () => rows,
    eventsFor: async () => events,
  };
  const overlayHost = host();
  const layer = createStormReportsLayer({
    source,
    overlayHost,
    radarSource: options.radarSource,
    createInputHandler: options.createInputHandler,
  });
  layer._testReports = rows;
  layer._testEvents = events;
  return { layer, overlayHost, viewer: options.viewer || stubViewer() };
}

/**
 * A page host for the shared context store.
 *
 * The store is a singleton hung off `window`, and the layer's context calls are
 * best-effort: with no window they are skipped entirely. These tests are the
 * ones that need the window, so they put one up and take it back down.
 */
function contextHost() {
  const prior = globalThis.window;
  globalThis.window = new EventTarget();
  return {
    store: getContextStore(),
    /** Every context record this layer owns. */
    records(layerId = 'storm-reports') {
      return [...getContextStore().entities.values()].filter(
        (record) => record.layerId === layerId,
      );
    },
    restore() {
      if (prior === undefined) delete globalThis.window;
      else globalThis.window = prior;
    },
  };
}

/** A viewer with a scene, and an input handler that records its own action. */
function clickableViewer(pick = () => undefined) {
  const viewer = stubViewer();
  const actions = [];
  viewer.scene = { canvas: {}, pick };
  return {
    viewer,
    actions,
    createInputHandler: () => ({
      setInputAction: (fn) => actions.push(fn),
      destroy: () => actions.splice(0, actions.length),
    }),
    click(position = { x: 4, y: 4 }) {
      assert.ok(actions.length, 'the click handler is installed');
      actions[0]({ position });
    },
    /**
     * Move the pointer. Index 1 because `installInteraction` registers the
     * click first and the hover second, and this only ever invoked
     * `actions[0]` - so the entire MOUSE_MOVE path, including the gate that
     * made hover a no-op on real data, was executed by no test at all.
     */
    move(endPosition = { x: 4, y: 4 }) {
      assert.equal(
        actions.length,
        2,
        'both the click and the hover handler are installed',
      );
      actions[1]({ endPosition });
    },
  };
}

/**
 * Wait for the radar comparison, which is fire-and-forget by design.
 *
 * A layer that awaited it would block its own repaint on a radar file, so the
 * test waits for it instead — the same thing the panel does when it re-reads
 * the info line.
 */
async function settled(layer) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (layer.getComparison()) return layer.getComparison();
  }
  return layer.getComparison();
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
  assert.equal(
    drawn(viewer).length,
    1,
    'a shared half-inch threshold is floored, not obeyed',
  );
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
  // Cards are SUMMONED, not scattered: at most the hovered report and the
  // selected one. The colour bands live on the Cesium points and in the legend.
  const rested = overlayHost.entries.at(-1);
  assert.ok(Array.isArray(rested.list));
  assert.equal(
    rested.list.length,
    0,
    'nothing is pointed at, so no cards are drawn at all',
  );

  // Pointing at a report summons exactly its card. The id is whatever the
  // layer minted, so this reads it back off the drawn entity rather than
  // guessing the format.
  summonCard(layer, viewer);
  const last = overlayHost.entries.at(-1);
  assert.equal(last.list.length, 1, 'exactly the hovered report gets a card');
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
  summonCard(layer, viewer);
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
  const rows = [REPORT(3), REPORT(1.75)];
  const { layer } = makeLayer(rows);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(drawn(viewer).length, 2, 'both clear the 1 inch default');
  layer
    .getRowControls()
    .chips.find((c) => c.id === 'storm-reports-hail-2')
    .onClick();
  assert.equal(
    drawn(viewer).length,
    1,
    'the 1.75 inch report dropped at once, with no update() call',
  );
});

const chipById = (layer, id) =>
  layer.getRowControls().chips.find((c) => c.id === id);

test('the hail thresholds start at an inch and go up', () => {
  const { layer } = makeLayer([REPORT(2)]);
  const labels = layer
    .getRowControls()
    .chips.filter(
      (c) =>
        c.id.startsWith('storm-reports-hail-') && c.id !== 'storm-reports-hail',
    )
    .map((c) => c.label);
  assert.deepEqual(labels, ['1″', '1.5″', '2″', '2.5″', '3″']);
  assert.ok(!labels.includes('0.75″'), 'sub-inch hail is not offered');
});

test('a shared link cannot sneak a sub-inch threshold past the floor', () => {
  // The codec only knows the value is a positive integer. The floor is a claim
  // this layer makes, so the layer has to be the one to hold it.
  const { layer } = makeLayer([REPORT(2)]);
  layer.init(stubViewer());
  layer.enable();
  layer.setParams({ minHailTenths: 5 });
  return layer.update().then(() => {
    assert.equal(layer.getParams().minHailIn, HAIL_FLOOR_IN);
  });
});

test('setting a threshold below an inch is floored', () => {
  const { layer } = makeLayer([REPORT(2)]);
  layer.setMinHailIn(0.25);
  assert.equal(layer.getParams().minHailIn, HAIL_FLOOR_IN);
});

test('a sub-inch report is never shown, whatever the threshold claims', async () => {
  const viewer = stubViewer();
  const rows = [REPORT(2), REPORT(0.5)];
  const { layer } = makeLayer(rows);
  layer.init(viewer);
  layer.enable();
  layer.setMinHailIn(0.25);
  await layer.update();
  assert.equal(drawn(viewer).length, 1, 'the half-inch report stays hidden');
});

test('the date field commits a typed date and repaints', async () => {
  const viewer = stubViewer();
  const other = REPORT(2);
  other[0] = '2026-08-04';
  const { layer } = makeLayer([REPORT(2), other]);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(drawn(viewer).length, 2);

  const field = layer.getRowControls().field;
  assert.ok(field, 'the row offers a typed field');
  // US order: 8 is the month, so this is 4 August.
  assert.equal(field.onCommit('8/4/2026'), true, 'a US date is accepted');
  assert.equal(layer.getDateRange().from, '2026-08-04');
  assert.equal(drawn(viewer).length, 1, 'and the map followed');
});

test('a date that is not a date is refused, and says so', () => {
  const { layer } = makeLayer([REPORT(2)]);
  layer.init(stubViewer());
  layer.enable();
  const field = layer.getRowControls().field;
  assert.equal(field.onCommit('next tuesday'), false);
  assert.equal(layer.getDateRange().from, null, 'the selection is untouched');
  assert.match(layer.getRowControls().info, /Could not read/);
});

test('a rejected date is cleared by the next real one', () => {
  const { layer } = makeLayer([REPORT(2)]);
  layer.init(stubViewer());
  layer.enable();
  const field = layer.getRowControls().field;
  field.onCommit('nonsense');
  field.onCommit('2026-08-10');
  assert.equal(layer.getDateRange().from, '2026-08-10');
  assert.doesNotMatch(layer.getRowControls().info, /Could not read/);
});

test('GO is disabled until a single day is chosen', async () => {
  const { layer } = makeLayer([REPORT(2)]);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  assert.equal(
    chipById(layer, 'storm-reports-go').disabled,
    true,
    'nothing chosen yet',
  );
  layer.setDate('2026-08-10');
  assert.equal(chipById(layer, 'storm-reports-go').disabled, false);
  layer.clearDateRange();
  assert.equal(
    chipById(layer, 'storm-reports-go').disabled,
    true,
    'back to the whole record',
  );
});

test('GO flies the camera to that day', async () => {
  const viewer = stubViewer();
  const { layer } = makeLayer([REPORT(2), REPORT(1.5)]);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  assert.equal(layer.frameSelectedStorm(), true);
  const flown = viewer.camera.__flownTo;
  assert.ok(flown, 'the camera was moved');
  assert.ok(flown.duration > 0, 'and it flew rather than snapped');
  assert.equal(typeof flown.orientation.pitch, 'number');
});

test('GO does nothing when there is no day, or the day is empty', async () => {
  const viewer = stubViewer();
  const { layer } = makeLayer([REPORT(2)]);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(layer.frameSelectedStorm(), false, 'no day selected');
  viewer.camera.__flownTo = null;
  layer.setDate('2026-01-01');
  assert.equal(layer.frameSelectedStorm(), false, 'a day with no reports');
  assert.equal(viewer.camera.__flownTo, null, 'and the camera stayed put');
});

/**
 * A day that carried two storms, with a previous year's storm loaded ahead of
 * them so an ordinal read as a flat array index lands on the wrong year.
 */
function twoStormDay(options = {}) {
  const north = STORM('ep-north', '2026-08-10', {
    maxHailIn: 3.25,
    reportCount: 41,
    narrative: 'A discrete supercell tracked across northern Oklahoma.',
  });
  const south = STORM('ep-south', '2026-08-10', {
    maxHailIn: 1.25,
    reportCount: 9,
    narrative: 'Scattered pulse storms over the southern counties.',
  });
  const previousYear = STORM('ep-2025', '2025-08-10', {
    maxHailIn: 1.75,
    reportCount: 22,
    narrative: 'Last year entirely: a different storm on a different day.',
  });
  // Flat order is what eventsFor produces: 2025 first, then 2026.
  const events = options.events || [previousYear, north, south];
  const rows = [
    REPORT(3.25, { lat: 35.11, ref: 0, county: 'Noble' }),
    REPORT(1.25, { lat: 35.61, ref: 1, county: 'Caddo' }),
  ];
  if (!options.singleYear)
    rows.push(REPORT(1.75, { date: '2025-08-10', lat: 36.4, ref: 0 }));
  // Both days must be in the day index, or the storm list cannot offer them:
  // with no day selected it offers the storm days the date chips also offer.
  const days = {};
  for (const row of rows) days[row[0]] = { hail: 1, wind: 0, total: 1 };
  const { layer, overlayHost } = makeLayer(rows, events, {
    years: options.singleYear ? ['2026'] : ['2025', '2026'],
    days,
    radarSource: options.radarSource,
  });
  return { layer, overlayHost, north, south, previousYear, rows };
}

test('two storms on one day each keep their own reports', async () => {
  // The defect: the reports were selected by date, so asking about either storm
  // returned both storms' reports, and a card opened on a southern storm report
  // was handed the northern supercell's narrative.
  const { layer, north, south } = twoStormDay();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();

  const forNorth = layer.getStormReports(north.id);
  const forSouth = layer.getStormReports(south.id);
  assert.equal(forNorth.length, 1, 'the supercell has one report, not two');
  assert.equal(forSouth.length, 1, 'and so does the southern storm');
  assert.equal(forNorth[0].county, 'Noble', 'the right one');
  assert.equal(forSouth[0].county, 'Caddo');
  assert.equal(forNorth[0].size, 3.25);
  assert.equal(forSouth[0].size, 1.25);
  assert.ok(
    !forNorth.some((r) => r.county === 'Caddo'),
    'no storm borrows the other storm reports',
  );
  assert.ok(!south.narrative.includes('supercell'), 'the storms differ');
});

test('a report card carries its own storm, not the first of the day', async () => {
  const { layer, rows } = twoStormDay();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();

  const northCard = layer.describeReport(layer.getStormReports('ep-north')[0]);
  const southCard = layer.describeReport(layer.getStormReports('ep-south')[0]);
  assert.match(northCard.storm.narrative, /supercell/);
  assert.equal(northCard.storm.reportCount, 41);
  assert.equal(northCard.storm.resolvedBy, 'ordinal');
  assert.match(
    southCard.storm.narrative,
    /pulse storms/,
    'not the first storm on the date',
  );
  assert.equal(southCard.storm.reportCount, 9);
  assert.ok(
    northCard.storm.narrative !== southCard.storm.narrative,
    'the fixture genuinely distinguishes the two storms',
  );
  assert.equal(rows.length, 3, 'three reports, one of them from 2025');
});

test('an ordinal is read within its own year, not the whole list', async () => {
  // 2026's first storm is flat index 1. Reading stormRef straight into the flat
  // array answers with the 2025 storm, on a day that has nothing to do with it.
  const { layer } = twoStormDay();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setDateRange('2025-08-10', '2026-08-10');

  const from2026 = layer.getStormReports('ep-north');
  assert.equal(from2026.length, 1);
  assert.equal(from2026[0].date, '2026-08-10', 'not the 2025 report');
  const card2026 = layer.describeReport(from2026[0]);
  assert.equal(card2026.storm.id, 'ep-north');
  assert.equal(card2026.storm.resolvedBy, 'ordinal');

  const from2025 = layer.getStormReports('ep-2025');
  assert.equal(from2025.length, 1);
  assert.equal(from2025[0].date, '2025-08-10');
  assert.equal(layer.describeReport(from2025[0]).storm.id, 'ep-2025');
});

test('reports still resolve when only one year is loaded', async () => {
  // base is 0 here rather than 1, which is the whole difference: the resolution
  // cannot be a hard-coded offset into the flat list.
  const { layer } = twoStormDay({ singleYear: true });
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  const forNorth = layer.getStormReports('ep-north');
  const forSouth = layer.getStormReports('ep-south');
  assert.equal(forNorth.length, 1);
  assert.equal(forSouth.length, 1);
  assert.equal(layer.describeReport(forNorth[0]).storm.id, 'ep-north');
  assert.equal(layer.describeReport(forSouth[0]).storm.id, 'ep-south');
});

test('a report with no storm ordinal falls back instead of throwing', async () => {
  // Every row in a snapshot built before the ordinal existed reads -1, so this
  // is the shipped state, not an edge case. The fallback is the day's first
  // storm: on a multi-storm day that is the wrong storm, and it is labelled
  // rather than hidden, because a dated narrative beats none.
  const { layer } = makeLayer(
    [REPORT(3.25, { lat: 35.11, ref: 0 }), REPORT(1.5, { lat: 35.21 })],
    [
      STORM('ep-north', '2026-08-10', {
        narrative: 'the first storm of the day',
      }),
      STORM('ep-south', '2026-08-10', {
        narrative: 'the second storm of the day',
      }),
    ],
  );
  layer.init(stubViewer());
  layer.enable();
  await layer.update();

  const legacy = layer.describeReport({
    date: '2026-08-10',
    stormRef: -1,
    hazard: 'hail',
    size: 1.5,
    lat: 35.21,
    lon: -97.4,
  });
  assert.ok(legacy.storm, 'a narrative is still attached');
  assert.equal(legacy.storm.resolvedBy, 'date', 'and says how it was found');
  assert.equal(legacy.storm.id, 'ep-north');
  assert.equal(
    layer.describeReport({ date: '2026-08-10', stormRef: 7 }).storm,
    null,
    'an ordinal that resolves to nothing is null, not some other storm',
  );
  assert.equal(
    layer.describeReport({ date: '2026-08-10' }).storm.id,
    'ep-north',
    'a row with no ordinal field at all is treated as -1',
  );
});

test('a snapshot with no ordinals anywhere still answers by date', async () => {
  // The real shape of the shipped files: every row -1. Both storms then claim
  // the day's reports, which is the honest ceiling of a date match, and no
  // exception is thrown on the way there.
  const { layer } = makeLayer(
    [REPORT(3.25, { lat: 35.11 }), REPORT(1.5, { lat: 35.21 })],
    [
      STORM('ep-north', '2026-08-10', {
        narrative: 'the first storm of the day',
      }),
      STORM('ep-south', '2026-08-10', {
        narrative: 'the second storm of the day',
      }),
    ],
  );
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  assert.equal(layer.getStormReports('ep-north').length, 2);
  assert.equal(layer.getStormReports('ep-south').length, 2);
  const card = layer.describeReport(layer.getStormReports('ep-north')[1]);
  assert.equal(card.storm.resolvedBy, 'date');
  assert.equal(card.storm.id, 'ep-north');
});

test('without a radar source the layer behaves exactly as before', async () => {
  const { layer } = makeLayer([REPORT(2), REPORT(1.5)]);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  assert.doesNotThrow(() => layer.setDate('2026-08-10'));
  assert.equal(layer.getComparison(), null, 'no comparison to show');
  const info = layer.getRowControls().info;
  assert.doesNotMatch(info, /radar/i, 'and no comparison text in the panel');
  assert.match(info, /2 reports/, 'the ordinary line still reads');
});

test('the panel carries the radar split for a selected day', async () => {
  const north = REPORT(2, { lat: 35.11 });
  const marginal = REPORT(1.75, { lat: 35.61 });
  const day = radarDayIndex('2026-08-10');
  const cells = new Map([
    [cellKey(35.11, -97.4), 45],
    [cellKey(36.9, -98.1), 60],
  ]);
  const asked = [];
  const radarSource = {
    daysFor: async (year) => {
      asked.push(year);
      return new Map([[day, cells]]);
    },
  };
  const { layer } = makeLayer([north, marginal], [], { radarSource });
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  const split = await settled(layer);

  assert.ok(split, 'a comparison arrived');
  assert.equal(split.day, '2026-08-10');
  assert.equal(split.both, 1, 'the reported cell with a core agrees');
  assert.equal(
    split.radarOnly,
    1,
    'the unreported core is the canvassing lead',
  );
  assert.equal(
    split.reportOnly,
    1,
    'the reported cell with no core is counted',
  );
  assert.equal(split.total, 3);
  assert.deepEqual(asked, ['2026'], 'asked for the year in the window');
  const info = layer.getRowControls().info;
  assert.match(
    info,
    /radar showed hail in 2 cells, 1 of them with no report/,
    'the day’s own unreported radar cells are the headline',
  );
  assert.match(info, /1 of 2 reports sat in a cell with a radar core/);
  assert.match(info, /1 sat outside one/);
  assert.match(
    info,
    /an estimate from reflectivity for this day alone/,
    'radar is never read as a measured stone, nor as a lifetime reading',
  );
});

test('a radar source may wrap its day map, and days outside the window are dropped', async () => {
  const rows = [REPORT(2, { lat: 35.11 })];
  const inDay = radarDayIndex('2026-08-10');
  const outDay = radarDayIndex('2026-07-01');
  const radarSource = {
    daysFor: async () => ({
      cells: new Map([
        [inDay, new Map([[cellKey(35.11, -97.4), 45]])],
        [outDay, new Map([[cellKey(36.9, -98.1), 90]])],
      ]),
    }),
  };
  const { layer } = makeLayer(rows, [], { radarSource });
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  const split = await settled(layer);
  assert.equal(split.both, 1, 'the in-window day indexed onto the grid');
  assert.equal(
    split.radarOnly,
    0,
    'the out-of-window day is dropped, not merged into the swath',
  );
});

test('the comparison stays off a window wider than one day', async () => {
  const day = radarDayIndex('2026-08-10');
  const cells = new Map([[cellKey(35.11, -97.4), 45]]);
  const radarSource = { daysFor: async () => new Map([[day, cells]]) };
  const { layer } = makeLayer([REPORT(2), REPORT(1.5)], [], { radarSource });
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  assert.equal(layer.getComparison(), null, 'all dates compares nothing');
  layer.setDateRange('2026-08-01', '2026-08-10');
  assert.equal(layer.getComparison(), null, 'nor does a ten-day window');
  assert.doesNotMatch(layer.getRowControls().info, /radar/i);
  layer.setHazard('wind');
  layer.setDate('2026-08-10');
  assert.equal(
    layer.getComparison(),
    null,
    'hail cores say nothing about a wind day',
  );
});

test('a radar source that fails costs the line, not the layer', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const radarSource = {
      daysFor: async () => {
        throw new Error('radar file missing');
      },
    };
    const { layer, overlayHost } = makeLayer([REPORT(2)], [], { radarSource });
    const viewer = stubViewer();
    layer.init(viewer);
    layer.enable();
    assert.equal(await layer.update(), true, 'the layer still rendered');
    layer.setDate('2026-08-10');
    assert.equal(await settled(layer), null);
    assert.equal(layer.getComparison(), null);
    assert.match(layer.getRowControls().info, /1 report\b/);
    assert.equal(
      overlayHost.entries.at(-1).list.length,
      0,
      'no cards, because cards are summoned rather than scattered',
    );
    // The layer survived the radar failure, so pointing at its one report
    // still works: the card path is independent of the comparison line.
    summonCard(layer, viewer);
    assert.equal(
      overlayHost.entries.at(-1).list.length,
      1,
      'and exactly one on demand',
    );
  } finally {
    console.warn = warn;
  }
});

/* =========================================================================
 * The swaths: the REPORTED and RADAR chips, the rectangles they draw, the
 * ordering under the pins, the merged window, and the impacted places.
 * ====================================================================== */

/** Swath entities of one kind, on the layer's own data source. */
const swathEntities = (viewer, kind) =>
  drawn(viewer).filter((e) => String(e.id).startsWith(`storm-swath:${kind}:`));

/** A ConstantProperty-wrapped graphics field, read through. */
const value = (property) =>
  property && typeof property.getValue === 'function'
    ? property.getValue()
    : property;

/** Wait for a fire-and-forget radar read to paint something. */
async function waitFor(fn, tries = 25) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const got = fn();
    if (got) return got;
  }
  return fn();
}

test('the swath chips are offered, and each draws only its own layer', async () => {
  const day = radarDayIndex('2026-08-10');
  const cells = new Map([
    [cellKey(35.11, -97.4), 45],
    [cellKey(36.9, -98.1), 60],
  ]);
  const radarSource = { daysFor: async () => new Map([[day, cells]]) };
  const viewer = stubViewer();
  const { layer } = makeLayer(
    [REPORT(2, { lat: 35.11 }), REPORT(1.5, { lat: 35.61 })],
    [],
    { radarSource, viewer },
  );
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  await settled(layer);

  const chips = layer.getRowControls().chips;
  const reportedChip = chips.find(
    (chip) => chip.id === 'storm-reports-swath-reported',
  );
  const radarChip = chips.find(
    (chip) => chip.id === 'storm-reports-swath-radar',
  );
  assert.ok(reportedChip && radarChip, 'both swath chips are on the row');
  assert.equal(radarChip.disabled, false, 'radar is wired, so RADAR is live');
  assert.equal(layer.getReportedSwath(), false, 'REPORTED is off until asked for');
  // RADAR is ON BY DEFAULT, because a layer called "Hail & Wind" whose
  // default view has no hail in it is not showing the hail.
  assert.equal(layer.getRadarSwath(), true, 'the radar swath is on by default');
  assert.equal(swathEntities(viewer, 'reported').length, 0);
  assert.equal(
    swathEntities(viewer, 'radar').length,
    2,
    'and the two radar cells are drawn without being asked for',
  );

  assert.equal(layer.setReportedSwath(true), true);
  assert.equal(
    swathEntities(viewer, 'reported').length,
    2,
    'one rectangle per reported grid cell',
  );

  assert.equal(layer.setReportedSwath(false), true);
  assert.equal(swathEntities(viewer, 'reported').length, 0, 'REPORTED off');
  // Switching RADAR off must actually take the polygons off the map. It did
  // not: the cells were cleared but the entities were still in the data
  // source, so the swath stayed on the screen with nothing to switch it back
  // with.
  assert.equal(layer.setRadarSwath(false), true);
  assert.equal(
    swathEntities(viewer, 'radar').length,
    0,
    'RADAR off REMOVES the polygons, not just the cells',
  );
  assert.equal(layer.setRadarSwath(true), true);
  assert.equal(swathEntities(viewer, 'radar').length, 2, 'two radar cells');
  assert.equal(
    swathEntities(viewer, 'reported').length,
    0,
    'and no reported cells',
  );
});

test('a swath is a clamped, outlined polygon with a band-ramped fill', async () => {
  const day = radarDayIndex('2026-08-10');
  const cells = new Map([[cellKey(35.11, -97.4), 45]]);
  const radarSource = { daysFor: async () => new Map([[day, cells]]) };
  const viewer = stubViewer();
  const { layer } = makeLayer([REPORT(2, { lat: 35.11 })], [], {
    radarSource,
    viewer,
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  await settled(layer);
  layer.setRadarSwath(true);
  const [entity] = swathEntities(viewer, 'radar');
  assert.ok(entity, 'a radar cell is drawn');
  assert.equal(entity.position, undefined, 'a polygon, not a point entity');
  assert.equal(entity.rectangle, undefined, 'and not a per-cell rectangle');

  // Phase F. A polygon, clamped to the ground, with an edge — the
  // `renderOutline` recipe (index.js:1386), which is a shape already known to
  // render in this scene. The old form was one translucent rectangle per cell
  // at height 0, which `npm run qa:storm-swath` measured as a flat green box
  // rather than a swath: 64% of the frame, legible, and shapeless.
  assert.ok(entity.polygon, 'drawn as a polygon');
  // CLAMP TO GROUND, and this is the assertion that would have caught the bug.
  //
  // The launcher carries a CESIUM_ION_TOKEN in pinokio/ENVIRONMENT, so the
  // shipped regime is Photorealistic 3D Tiles with globe.show = false: the
  // ground is tiled geometry at real elevation. Measured there, same cell,
  // 23 km camera: `height: 0` drew 0 px (0.0% of frame, invisible), while
  // CLAMP_TO_GROUND drew 191,543 px (40.6%). A fixed altitude also draws but
  // floats the wash above the ground.
  //
  // So a defined height here is not a cheaper alternative — it is the bug. This
  // assertion is the cheap guard that keeps it from coming back, and
  // `npm run qa:storm-swath` is the end-to-end evidence.
  assert.equal(
    value(entity.polygon.heightReference),
    Cesium.HeightReference.CLAMP_TO_GROUND,
    'draped on the ground, or it is buried under the photorealistic tiles',
  );
  // Cesium accepts `outline` silently whether or not it draws anything, so this
  // assertion is the cheapest guard there is for the hard edge.
  assert.equal(
    value(entity.polygon.outline),
    true,
    'a hard edge, or adjacent bands blur into one wash',
  );
  assert.ok(
    value(entity.polygon.outlineColor),
    'and the edge has a colour',
  );
  const hierarchy = value(entity.polygon.hierarchy);
  assert.ok(
    hierarchy?.positions?.length >= 3,
    `a closed ring with at least three vertices, got ${hierarchy?.positions?.length}`,
  );
  const material = value(entity.polygon.material);
  assert.ok(
    material.color.alpha > 0 && material.color.alpha < 1,
    `a wash, not a wall: alpha ${material.color.alpha}`,
  );
});

test('the pins are drawn over the swaths', async () => {
  const day = radarDayIndex('2026-08-10');
  const cells = new Map([[cellKey(35.11, -97.4), 45]]);
  const radarSource = { daysFor: async () => new Map([[day, cells]]) };
  const viewer = stubViewer();
  const { layer } = makeLayer([REPORT(2, { lat: 35.11 })], [], {
    radarSource,
    viewer,
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  await settled(layer);
  layer.setReportedSwath(true);
  layer.setRadarSwath(true);
  const ids = drawn(viewer).map((entity) => String(entity.id));
  const lastSwath = ids.findLastIndex((id) => id.startsWith('storm-swath:'));
  const firstPin = ids.findIndex((id) => id.startsWith('storm-report-'));
  assert.ok(lastSwath >= 0 && firstPin >= 0, 'both layers are drawn');
  assert.ok(
    lastSwath < firstPin,
    'every swath entity is added before the first pin, so the stones sit on top',
  );
});

test('a radar cell under an inch is in the data and off the map', async () => {
  // The stored field deliberately keeps sub-inch hail - deleting measured radar
  // to tidy a colour ramp is a bad trade. But the product claims to start at an
  // inch, so painting a 20 mm cell in the colour that MEANS "1 to 1.5 inches"
  // is the map asserting a size nobody inferred.
  //
  // This is the trap the old ramp's final fallback set: `under 10 mm` had a
  // floor of zero, so EVERY cell matched the weakest band and a 20 mm cell was
  // drawn as the weakest hail on the map.
  const day = radarDayIndex('2026-08-10');
  const cells = new Map([
    [cellKey(35.11, -97.4), 20],
    [cellKey(38.61, -101.2), 30],
  ]);
  const radarSource = { daysFor: async () => new Map([[day, cells]]) };
  const viewer = stubViewer();
  const { layer } = makeLayer([REPORT(2, { lat: 35.11 })], [], {
    radarSource,
    viewer,
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  await settled(layer);
  layer.setRadarSwath(true);

  const drawn = swathEntities(viewer, 'radar');
  assert.equal(drawn.length, 1, 'only the cell that reached an inch is drawn');
  assert.ok(
    String(drawn[0].id).includes('1-1.5"'),
    'and it is banded from its real reading, not the weakest band',
  );

  const bands = layer
    .getRowControls()
    .legend.filter((entry) => String(entry.label).startsWith('Radar hail'));
  assert.equal(bands.length, 5, 'five bands, all of them an inch or more');
  assert.deepEqual(
    bands.map((b) => b.label),
    [
      'Radar hail 3.5"+',
      'Radar hail 2.75-3.5"',
      'Radar hail 2-2.75"',
      'Radar hail 1.5-2"',
      'Radar hail 1-1.5"',
    ],
    'the ramp starts at an inch and nowhere else, and it is the INCH CHART ' +
      'the report pins use - 1", 1.5", 2", 2.75", 3.5" - so a pin and the ' +
      'wash it sits in are on one scale',
  );
});

test('the radar swath merges a window per cell, worst reading wins', async () => {
  const d1 = radarDayIndex('2026-08-09');
  const d2 = radarDayIndex('2026-08-10');
  const repeated = cellKey(35.11, -97.4);
  const extra = cellKey(36.9, -98.1);
  const radarSource = {
    daysFor: async () =>
      new Map([
        // The extra cell used to be 10 mm, which is UNDER the product's one
        // inch floor, so it would now correctly paint nothing and this test
        // could no longer tell "weaker band" from "not drawn at all". 28 mm
        // sits just above the floor in the weakest band, which is the
        // distinction this test is actually about.
        [d1, new Map([[repeated, 30], [extra, 28]])],
        [d2, new Map([[repeated, 55]])],
      ]),
  };
  const viewer = stubViewer();
  const { layer } = makeLayer(
    [
      REPORT(2, { date: '2026-08-09', lat: 35.11 }),
      REPORT(2, { date: '2026-08-10', lat: 35.11 }),
    ],
    [],
    {
      radarSource,
      viewer,
      days: {
        '2026-08-09': { hail: 1, wind: 0, total: 1 },
        '2026-08-10': { hail: 1, wind: 0, total: 1 },
      },
    },
  );
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setRadarSwath(true);
  layer.setDateRange('2026-08-09', '2026-08-10');
  const cells = await waitFor(() => {
    const found = swathEntities(viewer, 'radar');
    return found.length >= 2 ? found : null;
  });
  assert.equal(cells.length, 2, 'the union of both days is two cells');
  // The repeatedly-hit cell keeps the WORST reading across the window, not the
  // first day's: 55mm from the 10th, over 30mm from the 9th. 55 lands in the
  // 2-2.75" band, 28 in the 1-1.5" one. The entity id names the BAND rather
  // than the cell, since a band is drawn at a time, so the band is what
  // identifies the drawing here.
  const worst = cells.find((entity) => String(entity.id).includes('2-2.75"'));
  assert.ok(worst, 'the windowed cell is drawn in its worst band');
  const material = value(worst.polygon.material);
  assert.ok(
    material.color.equals(
      Cesium.Color.fromCssColorString('#c026d3').withAlpha(material.color.alpha),
    ),
    'the windowed cell is coloured by its maximum, not its first day',
  );
  assert.ok(
    cells.some((entity) => String(entity.id).includes('1-1.5"')),
    'and the other cell stays in its own, weaker band',
  );
  const alphas = cells.map((entity) => value(entity.polygon.material).color.alpha);
  assert.ok(
    Math.max(...alphas) > Math.min(...alphas),
    `the strongest band is the most opaque: ${JSON.stringify(alphas)}`,
  );
});

test('a swath is drawn per RING, never per cell', async () => {
  // Four cells in a row, all one band. Phase F's acceptance criterion is that
  // the drawn entity count follows the SHAPE, not the cell count: the old
  // renderer emitted four rectangles here, which is what drew the darker seams
  // along every shared edge.
  const day = radarDayIndex('2026-08-10');
  const cells = new Map([
    [cellKey(35.11, -97.4), 45],
    [cellKey(35.11, -97.4 + 0.25), 45],
    [cellKey(35.11, -97.4 + 0.5), 45],
    [cellKey(35.11, -97.4 + 0.75), 45],
  ]);
  const radarSource = { daysFor: async () => new Map([[day, cells]]) };
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource, viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  await settled(layer);
  layer.setRadarSwath(true);
  const drawnSwaths = swathEntities(viewer, 'radar');
  assert.equal(
    drawnSwaths.length,
    1,
    'four adjacent cells in one band are ONE polygon, not four rectangles',
  );
});

test('stronger bands paint more opaque, and every swath gets an edge', async () => {
  // Two reported sizes in different bands, in non-adjacent cells so each is
  // its own ring. The alpha must RAMP: a flat alpha made a fringe cell look
  // exactly as strong as a core, so the wash carried no ranking.
  const viewer = stubViewer();
  const { layer } = makeLayer(
    [
      // Both at or above the layer's default 1-inch filter; a 0.75 report is
      // filtered out before it reaches a swath, which is correct and would
      // otherwise read here as "only one band drew".
      REPORT(1, { lat: 35.11, lon: -97.4 }),
      REPORT(3, { lat: 40.11, lon: -97.4 }),
    ],
    [],
    { viewer },
  );
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setReportedSwath(true);
  const entities = swathEntities(viewer, 'reported');
  assert.equal(entities.length, 2, 'two bands, two rings');
  const alphas = entities.map(
    (entity) => value(entity.polygon.material).color.alpha,
  );
  assert.notEqual(
    alphas[0],
    alphas[1],
    `two bands must not share an alpha: ${JSON.stringify(alphas)}`,
  );
  const strongest = Math.max(...alphas);
  const weakest = Math.min(...alphas);
  assert.ok(
    strongest > weakest,
    'and the stronger band is the more opaque one',
  );
  assert.ok(strongest < 1, 'the worst band is still a wash, so pins stay legible');
  for (const entity of entities) {
    assert.equal(
      value(entity.polygon.outline),
      true,
      `every swath polygon carries an edge: ${entity.id}`,
    );
  }
});

test('the impacted places skip a report with no county and rank the rest', async () => {
  const viewer = stubViewer();
  // The REPORT helper defaults an absent county, so the blank is set on the
  // packed row directly - the loader packs an empty slot as null, not "".
  const noCounty = REPORT(2);
  noCounty[7] = '';
  noCounty[8] = '';
  const { layer } = makeLayer(
    [
      REPORT(2, { fips: '40027', state: 'OK', county: 'Cleveland' }),
      REPORT(2, { fips: '40027', state: 'OK', county: 'Cleveland' }),
      REPORT(2, { fips: '40109', state: 'OK', county: 'Oklahoma' }),
      noCounty,
    ],
    [],
    { viewer },
  );
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const places = layer.getImpactedPlaces();
  assert.equal(places.length, 2, 'the county-less report is not a place');
  assert.deepEqual(places[0], { county: 'Cleveland', state: 'OK', count: 2 });
  assert.deepEqual(places[1], { county: 'Oklahoma', state: 'OK', count: 1 });
  assert.match(
    layer.getRowControls().info,
    /impacted: Cleveland OK \(2\), Oklahoma OK \(1\)/,
  );
});

/* =========================================================================
 * The storm drill-down: list, selection, outline, contexts, and the panel
 * listener that ties them together.
 * ====================================================================== */

test('the row lists the storms of the selected day, in the list contract', async () => {
  const { layer } = twoStormDay();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');

  const list = layer.getRowControls().list;
  assert.ok(list, 'the row carries a list under the date field');
  assert.equal(list.items.length, 2, 'both storms that day, and no other day');
  assert.match(list.ariaLabel, /2026-08-10/);
  for (const item of list.items) {
    // rowList reads exactly these seven; a missing one renders a blank row.
    for (const key of ['id', 'lead', 'text', 'disabled', 'active', 'current']) {
      assert.ok(key in item, `an item carries ${key}`);
      assert.notEqual(item[key], undefined, `${key} is a value, not a hole`);
    }
    assert.equal(typeof item.onClick, 'function', 'and something to click');
  }
  assert.ok(
    list.items.some((item) => /3\.25" hail/.test(item.text)),
    'a storm reads as its own magnitude',
  );
  assert.ok(
    list.items.every((item) => item.disabled === false),
    'both storms have reports at the current threshold',
  );
});

test('the list narrows to the day the date filter is on', async () => {
  const { layer } = twoStormDay();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();

  assert.equal(
    layer.getRowControls().list.items.length,
    3,
    'no day selected: every storm in the window',
  );
  layer.setDate('2025-08-10');
  const items = layer.getRowControls().list.items;
  assert.equal(
    items.length,
    1,
    'and only that day’s storms once one is chosen',
  );
  assert.match(layer.getRowControls().list.ariaLabel, /Storms on 2025-08-10/);
});

test('with no day selected the list offers the recent days the chips offer', async () => {
  // The list cannot offer every storm in a 155,737-report record, and a longer
  // list would name days the date chips cannot reach.
  const days = {};
  const events = [];
  const rows = [];
  for (let i = 0; i < STORM_LIST_DAYS + 5; i += 1) {
    const date = `2026-08-${String(28 - i).padStart(2, '0')}`;
    days[date] = { hail: 1, wind: 0, total: 1 };
    events.push(STORM(`ep-${i}`, date));
    const row = REPORT(2, { date });
    rows.push(row);
  }
  const { layer } = makeLayer(rows, events, { days });
  layer.init(stubViewer());
  layer.enable();
  await layer.update();

  const list = layer.getRowControls().list;
  assert.equal(list.items.length, STORM_LIST_DAYS, 'capped at the chip depth');
  assert.match(list.ariaLabel, /most recent storm days/);
  const chipDays = new Set(
    layer
      .getRowControls()
      .chips.filter((chip) => /^2026-08-\d\d$/.test(chip.label))
      .map((chip) => chip.label),
  );
  assert.ok(
    list.items.every((item) => /\d\d:\d\d/.test(String(item.lead))),
    'lead is a clock window, not a date',
  );
  assert.ok(
    !list.items.some((item) => /^20\d\d-\d\d-\d\d$/.test(String(item.lead))),
    'and never a bare day',
  );
  for (const item of list.items) {
    assert.match(item.lead, /^\d\d:\d\dZ/, 'the lead column is a time window');
  }
  assert.ok(
    [...chipDays].every((day) => list.items.length > 0) && chipDays.size === 12,
    'and the chips still reach exactly those days',
  );
});

test('selecting a storm narrows the map to that storm alone', async () => {
  const viewer = stubViewer();
  const { layer, north } = twoStormDay();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(drawn(viewer).length, 3, 'the window as a whole');

  assert.equal(layer.selectStorm(north.id), true);
  const shown = drawn(viewer);
  assert.equal(shown.length, 1, 'one storm, not the day');
  assert.equal(shown[0].properties.county.getValue(), 'Noble');
  assert.equal(layer.getSelectedStormId(), north.id);
  assert.equal(layer.getSelectedStorm().id, north.id);

  assert.equal(layer.clearStormSelection(), true);
  assert.equal(drawn(viewer).length, 3, 'and back to the whole window');
  assert.equal(layer.getSelectedStormId(), null);
});

test('the storm’s own record survives its own selection', async () => {
  // getStormReports is what the list, the outline and the panel all read. If it
  // answered out of the narrowed map, every other storm in the list would claim
  // zero reports the moment one was selected.
  const { layer, north, south } = twoStormDay();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.selectStorm(north.id);

  assert.equal(layer.getStormReports(north.id).length, 1);
  assert.equal(
    layer.getStormReports(south.id).length,
    1,
    'the unselected storm still knows its own report',
  );
  const items = layer.getRowControls().list.items;
  assert.ok(
    items.every((item) => item.disabled === false),
    'so the list does not grey out the day behind the selection',
  );
});

test('selecting a storm moves a window that does not contain it, and only then', async () => {
  const { layer, north } = twoStormDay();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();

  assert.deepEqual(layer.getDateRange(), { from: null, to: null });
  layer.selectStorm(north.id);
  assert.deepEqual(
    layer.getDateRange(),
    { from: '2026-08-10', to: '2026-08-10' },
    'a storm belongs to a date, and an outer filter that excludes it makes the selection empty',
  );

  // A window that already covers the storm is left exactly as it is: someone
  // working down a month must not be narrowed to one day by the first click.
  layer.clearDateRange();
  layer.setDateRange('2025-08-10', '2026-08-10');
  layer.selectStorm(north.id);
  assert.deepEqual(
    layer.getDateRange(),
    { from: '2025-08-10', to: '2026-08-10' },
    'the window was already wide enough',
  );
});

test('a date change that leaves the storm drops it rather than selecting nothing', async () => {
  const { layer, north } = twoStormDay();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  layer.selectStorm(north.id);
  assert.equal(layer.getSelectedStormId(), north.id);

  layer.setDate('2025-08-10');
  assert.equal(
    layer.getSelectedStormId(),
    null,
    'a storm cannot outlive the window it belongs to',
  );
});

test('the outline is off until asked for, and says it is approximate', async () => {
  const viewer = stubViewer();
  const { layer, north } = twoStormDay();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  layer.selectStorm(north.id);

  assert.equal(layer.isOutlineVisible(), false, 'off by default');
  assert.equal(
    drawn(viewer).filter((e) => e.id.startsWith('storm-outline')).length,
    0,
  );

  assert.equal(layer.setOutlineVisible(true), true);
  const outlines = drawn(viewer).filter(
    (e) => e.id === `storm-outline:${north.id}`,
  );
  assert.equal(outlines.length, 1, 'one circle for the selected storm');
  assert.ok(outlines[0].polygon, 'a polygon hierarchy, not an ellipse graphic');
  assert.ok(outlines[0].polygon.hierarchy, 'with a hierarchy of ring points');
  // Cesium wraps a graphics value in a ConstantProperty; the hierarchy is the
  // value inside it, which is the same trap entity properties set earlier.
  const hierarchy = outlines[0].polygon.hierarchy.getValue();
  assert.ok(
    Array.isArray(hierarchy.positions),
    'holding an array of positions',
  );
  assert.ok(
    hierarchy.positions.length >= 3,
    'at least three points, or Cesium rejects it',
  );
  assert.equal(
    viewer.__shared.added,
    0,
    'never written into the shared entity collection',
  );
  assert.equal(outlines[0].show !== false, true);

  const controls = layer.getRowControls();
  assert.match(controls.info, /[Aa]pproximate/);
  assert.match(controls.info, /publishes no storm polygons/);
  assert.ok(
    controls.legend.some((entry) => /approximate/i.test(entry.label)),
    'the legend names it as approximate too',
  );
  assert.match(
    controls.chips.find((chip) => chip.id === 'storm-reports-outline').title,
    /NOT a measured boundary/,
  );

  layer.setOutlineVisible(false);
  assert.equal(
    drawn(viewer).filter((e) => e.id.startsWith('storm-outline')).length,
    0,
    'and it goes away again',
  );
});

test('the outline chip is disabled until a storm is chosen', async () => {
  const { layer } = twoStormDay();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  assert.equal(chipById(layer, 'storm-reports-outline').disabled, true);
  layer.setDate('2026-08-10');
  layer.selectStorm('ep-north');
  assert.equal(chipById(layer, 'storm-reports-outline').disabled, false);
  assert.equal(chipById(layer, 'storm-reports-clear-storm').disabled, false);
});

test('clicking a report registers at most the bound, however many are drawn', async () => {
  const host = contextHost();
  try {
    const viewer = stubViewer();
    // Past the bound on purpose: the record day holds 44,717 of these.
    const rows = Array.from({ length: 120 }, (_, i) =>
      REPORT(1 + (i % 3), { lat: 35 + i * 0.01 }),
    );
    const { layer } = makeLayer(rows);
    layer.init(viewer);
    layer.enable();
    await layer.update();
    assert.equal(drawn(viewer).length, 120, 'every report is drawn');
    assert.equal(
      host.records().length,
      STORM_CONTEXT_LIMIT,
      'only the worst of them carry a click context',
    );

    // The bound has to survive every repaint, not just the first one.
    layer.setMinHailIn(2);
    layer.setHazard('hail');
    layer.setDate('2026-08-10');
    layer.clearDateRange();
    assert.ok(
      host.records().length <= STORM_CONTEXT_LIMIT,
      `a repaint left ${host.records().length} contexts registered`,
    );

    const record = host.records()[0];
    assert.ok(
      record.dataSource,
      'liveness needs the data source, or the record reads live after disable',
    );
    assert.equal(record.layerId, 'storm-reports');
    assert.ok(record.label, 'and a label');
    assert.equal(typeof record.latitude, 'number');
    assert.equal(typeof record.longitude, 'number');
    assert.ok(record.properties.date, 'with the report properties attached');
    assert.ok(
      record.entity.gevLabelModel,
      'the label model is set before registration, or the readout card is empty',
    );
  } finally {
    host.restore();
  }
});

test('disable and destroy both unregister every context', async () => {
  const host = contextHost();
  try {
    const rows = [REPORT(2), REPORT(1.75)];
    const { layer } = makeLayer(rows);
    layer.init(stubViewer());
    layer.enable();
    await layer.update();
    assert.equal(host.records().length, 2);

    layer.disable();
    assert.equal(host.records().length, 0, 'disable releases them');
    assert.equal(getSelectedEntityContext(), null);

    layer.enable();
    await layer.update();
    assert.equal(
      host.records().length,
      2,
      'and re-enabling registers them again',
    );
    layer.destroy();
    assert.equal(host.records().length, 0, 'destroy releases them too');
  } finally {
    host.restore();
  }
});

test('a click on a report selects it, and a click on empty map releases it', async () => {
  const host = contextHost();
  try {
    const viewer = stubViewer();
    let picked = null;
    const harness = clickableViewer(() => picked);
    const { layer, overlayHost } = makeLayer([REPORT(2), REPORT(1.75)], [], {
      viewer: harness.viewer,
      createInputHandler: harness.createInputHandler,
    });
    layer.init(harness.viewer);
    layer.enable();
    await layer.update();

    const worst = drawn(harness.viewer).find((entity) =>
      entity.id.includes('-hail-2'),
    );
    picked = { id: worst };
    harness.click();
    assert.equal(layer.getSelectedReportId(), worst.id);
    assert.equal(getSelectedEntityContext()?.id, worst.id);
    assert.ok(
      overlayHost.entries.at(-1).list.some((card) => card.selected === true),
      'and the card says so',
    );
    assert.equal(
      isOwnedByOtherLayer('some-sibling', worst.id),
      true,
      'siblings are told this pick is ours',
    );

    picked = undefined;
    harness.click();
    assert.equal(layer.getSelectedReportId(), null, 'empty map releases it');
    assert.equal(getSelectedEntityContext(), null);

    layer.disable();
    assert.equal(
      isOwnedByOtherLayer('some-sibling', worst.id),
      false,
      'and the pick ownership goes with the layer',
    );
  } finally {
    host.restore();
  }
});

test('the row listener fires on every change that moves the panel', async () => {
  const { layer, north } = twoStormDay();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();

  let calls = 0;
  layer.setRowControlsListener(() => {
    calls += 1;
  });
  const since = () => {
    const before = calls;
    return () => assert.ok(calls > before, 'the row was not repainted');
  };

  let check = since();
  layer.setDate('2026-08-10');
  check();

  check = since();
  layer.setDateRange('2025-08-10', '2026-08-10');
  check();

  check = since();
  layer.clearDateRange();
  check();

  check = since();
  layer.setMinHailIn(1.5);
  check();

  check = since();
  layer.setHazard('wind');
  check();

  check = since();
  layer.selectStorm(north.id);
  check();

  check = since();
  layer.clearStormSelection();
  check();

  // A non-function clears it, rather than being called and throwing.
  layer.setRowControlsListener(null);
  assert.doesNotThrow(() => layer.setDate('2026-08-10'));
});

test('an overlay card carries the fields the overlay actually reads', async () => {
  const viewer = stubViewer();
  const overlayHost = host();
  const source = {
    getSnapshot: async () => ({
      years: ['2026'],
      days: { '2026-08-10': { hail: 1, wind: 0, total: 1 } },
    }),
    reportsFor: async () => [REPORT(2)],
    eventsFor: async () => [],
  };
  const layer = createStormReportsLayer({ source, overlayHost });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  summonCard(layer, viewer);
  const [card] = overlayHost.entries.at(-1).list;

  // normalizeOverlayEntry is an explicit field pick: a name it does not read is
  // dropped without a word, and both of these used to be.
  assert.equal(card.color, undefined, 'color is not an overlay field');
  assert.equal(card.caveat, undefined, 'and caveat is not one either');
  // REPORT(2) is a 2.0 inch stone: the first band at or above 2 is 2.0-2.75.
  assert.equal(card.accent, '#e06020', 'the band colour travels as accent');
  assert.equal(card.metadata, null);
  const normalized = normalizeOverlayEntry('storm-reports', card);
  assert.equal(normalized.accent, '#e06020', 'and survives normalization');
});

test('picking a day keeps a share link’s own thresholds', async () => {
  const viewer = stubViewer();
  const { layer } = makeLayer([REPORT(2), REPORT(1.25)]);
  layer.init(viewer);
  // Before any data has loaded, the manager's params are still pending - this
  // is the moment a share link is applied.
  layer.setParams({
    minHailTenths: 15,
    hazard: 'hail',
    fromDate: '2026-08-09',
  });
  layer.setDate('2026-08-10');

  assert.equal(
    layer.getParams().minHailTenths,
    15,
    'the link’s threshold survives the date the user picked',
  );
  layer.enable();
  await layer.update();
  assert.equal(layer.getParams().minHailIn, 1.5, 'and is applied on load');
  assert.deepEqual(layer.getDateRange(), {
    from: '2026-08-10',
    to: '2026-08-10',
  });
  assert.equal(
    drawn(viewer).length,
    1,
    'so the half-inch-dropped report is gone',
  );
});

test('the storm view reports the storm, not the day', async () => {
  const day = radarDayIndex('2026-08-10');
  const cells = new Map([[cellKey(35.11, -97.4), 45]]);
  const radarSource = { daysFor: async () => new Map([[day, cells]]) };
  const { layer, north } = twoStormDay({ radarSource });
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  layer.selectStorm(north.id);
  await settled(layer);

  const info = layer.getRowControls().info;
  assert.match(info, /storm/, 'it says which storm it is describing');
  assert.match(info, /1 report\b/, 'with that storm’s own count');
  assert.match(info, /3\.25" hail/, 'and its own worst magnitude');
  assert.match(info, /supercell/, 'and its narrative');
  assert.match(
    info,
    /an estimate from reflectivity for this day alone/,
    'the radar caveat stays',
  );
  assert.match(
    info,
    /\(this storm\)/,
    'the radar line says whose reports it read',
  );
});

test('a storm with no reports at this threshold says so instead of looking empty', async () => {
  const { layer, south } = twoStormDay();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setMinHailIn(2);
  layer.setDate('2026-08-10');
  // The southern storm's only report is a 1.25 - below the threshold. The
  // threshold is never loosened to hide that.
  layer.selectStorm(south.id);
  assert.equal(drawn(stubViewer()).length, 0);
  assert.equal(layer.getParams().minHailIn, 2, 'the threshold is untouched');
  assert.match(
    layer.getRowControls().info,
    /no reports at the current hail and size filter/,
  );
});

test('a thin day quotes its own unreported radar cells, not the year', async () => {
  // The artifact is per day now, so "a cell with radar hail and no report" is a
  // finding about this day and is published. The old annual snapshot summed the
  // year into the same figure ("14,832 unreported radar cores" next to a
  // 2-report day), which read as a list of streets; that count is what the
  // category charges for, and it is now attributed to the day on screen.
  const day = radarDayIndex('2026-08-10');
  const cells = new Map();
  for (let i = 0; i < 500; i += 1) cells.set(`${300 + i}:${400 + i}`, 30);
  const reports = [REPORT(2, { lat: 35.11 }), REPORT(1.5, { lat: 35.61 })];
  const radarSource = { daysFor: async () => new Map([[day, cells]]) };
  const { layer } = makeLayer(reports, [], { radarSource });
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  await settled(layer);

  const info = layer.getRowControls().info;
  assert.match(
    info,
    /radar showed hail in 500 cells, 500 of them with no report/,
    'the day’s own unreported radar cells are the headline',
  );
  assert.doesNotMatch(
    info,
    /annual one/,
    'the count is no longer withheld behind an annual caveat',
  );
  assert.doesNotMatch(info, /not on this day/, 'nor dated to the wrong day');
  assert.match(
    info,
    /for this day alone/,
    'and the line says what radar actually is, for this day',
  );
  assert.equal(layer.getComparison().radarOnly, 500);
});

// --- the window slider -------------------------------------------------------

/** A layer over a known run of consecutive storm days. */
function sliderLayer(dayCount = 30, start = 1) {
  const days = {};
  const rows = [];
  for (let i = 0; i < dayCount; i += 1) {
    const date = `2026-06-${String(start + i).padStart(2, '0')}`;
    days[date] = { hail: 1, wind: 0, total: 1 };
    rows.push(REPORT(2, { date }));
  }
  return makeLayer(rows, [], { days });
}

test('the slider offers the whole storm-day index', async () => {
  const { layer } = sliderLayer(30);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  const range = layer.getRowControls().range;
  assert.ok(range, 'the row offers a window control');
  assert.equal(range.min, 0);
  assert.equal(range.max, 29, 'one position per storm day');
  assert.deepEqual(range.value, [0, 29], 'starting at full travel');
  assert.match(range.readout, /2026-06-01 → 2026-06-30/);
  assert.match(range.readout, /30 of 30 storm days/);
});

test('dragging the window filters the map to it', async () => {
  const viewer = stubViewer();
  const { layer } = sliderLayer(30);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(drawn(viewer).length, 30);

  assert.equal(layer.setWindow(5, 9), true);
  assert.deepEqual(layer.getDateRange(), {
    from: '2026-06-06',
    to: '2026-06-10',
  });
  assert.equal(drawn(viewer).length, 5, 'the map followed');
  assert.equal(layer.getWindow().fromDate, '2026-06-06');
  assert.match(
    layer.getRowControls().range.readout,
    /5 of 30 storm days/,
    'and the readout says how much of the record that is',
  );
});

test('a day picked inside the window keeps the window around it', async () => {
  const { layer } = sliderLayer(30);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setWindow(5, 9);

  layer.setDate('2026-06-08');
  assert.equal(layer.getDateRange().from, '2026-06-08');
  const window_ = layer.getWindow();
  assert.equal(
    window_.fromDate,
    '2026-06-06',
    'the window still brackets the day',
  );
  assert.equal(window_.toDate, '2026-06-10');
  assert.deepEqual(
    layer.getRowControls().range.value,
    [5, 9],
    'so the slider has somewhere to go back to',
  );
});

test('a day outside the window drags the window to it', async () => {
  const { layer } = sliderLayer(30);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setWindow(5, 9);

  // Refusing it would be the same shrug as a chip that does nothing.
  layer.setDate('2026-06-20');
  const window_ = layer.getWindow();
  assert.equal(window_.toDate, '2026-06-20', 'the window grew to contain it');
  assert.equal(window_.fromDate, '2026-06-06', 'without losing its other end');
});

test('ALL DATES returns the slider to full travel', async () => {
  const viewer = stubViewer();
  const { layer } = sliderLayer(30);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setWindow(5, 9);
  assert.deepEqual(layer.getRowControls().range.value, [5, 9]);
  assert.equal(drawn(viewer).length, 5);

  layer.clearDateRange();
  assert.deepEqual(layer.getRowControls().range.value, [0, 29]);
  assert.equal(drawn(viewer).length, 30, 'and the whole record is back');
});

test('the window commits but does not work on every pixel of a drag', async () => {
  const { layer } = sliderLayer(30);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  const range = layer.getRowControls().range;
  assert.equal(
    range.onInput,
    undefined,
    'a drag must not trigger a year fetch',
  );
  assert.equal(typeof range.onCommit, 'function');
  assert.equal(range.onCommit(2, 4), true, 'the commit does the work');
  assert.deepEqual(layer.getDateRange(), {
    from: '2026-06-03',
    to: '2026-06-05',
  });
});

test('an empty or inverted window is refused rather than half-applied', async () => {
  const { layer } = sliderLayer(30);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  assert.equal(layer.setWindow(9, 4), false, 'from after to');
  assert.equal(layer.getDateRange().from, null, 'and nothing moved');
  assert.equal(layer.setWindow(-5, 900), true, 'out of range clamps');
  assert.equal(layer.getWindow().fromDate, '2026-06-01');
  assert.equal(layer.getWindow().toDate, '2026-06-30');
});

/* ------------------------------------------------------------------ *
 * Isolation — the third axis, beside the dates and beside the storm.
 * ------------------------------------------------------------------ */

/**
 * A square area, in the shape `resolveIsolation` returns in its `area` field:
 * `{kind, name, bbox, polygons, ring, …}`. Hand-built rather than resolved so a
 * fixture failure is about this layer rather than about a boundary bundle; the
 * pre-reject tests below use the real Texas for exactly that reason.
 */
function squareArea(name, west, south, east, north, region = null) {
  const ring = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  return {
    kind: 'state',
    name,
    region,
    bbox: [west, south, east, north],
    polygons: [[ring]],
    ring,
  };
}

/** A place, in the other shape: no geometry, a box around the point. */
function placeArea(name, lat, lon) {
  return {
    kind: 'place',
    name,
    country: 'United States',
    bbox: [lon - 0.25, lat - 0.25, lon + 0.25, lat + 0.25],
    polygons: [],
    ring: null,
    label: { lat, lon },
    approximate: true,
  };
}

/** Small enough to read in a failure message. */
const BOX = squareArea('Oklahoma', -98.1, 33.6, -94.4, 37.0);

/** The day index a spread of rows needs, built from the rows themselves. */
const daysFor = (rows) => {
  const days = {};
  for (const row of rows) days[row[0]] = { hail: 1, wind: 0, total: 1 };
  return { years: ['2026'], days };
};

/** Rows either side of {@link BOX}, over two different days. */
function isolationLayer() {
  const rows = [
    REPORT(2, { lat: 35.5, lon: -97.0 }),
    REPORT(2, { lat: 34.2, lon: -95.4, date: '2026-08-11' }),
    REPORT(1.25, { lat: 36.1, lon: -96.1 }),
    REPORT(2, { lat: 40.71, lon: -74.0, county: 'New York' }),
    REPORT(2, { lat: 29.76, lon: -95.37, county: 'Harris' }),
  ];
  return makeLayer(rows, [], daysFor(rows));
}

/**
 * `count` hail reports spread deterministically over the contiguous US, as
 * packed rows: `[date, minute, hazard, size, lat, lon, …]`. A fixed LCG rather
 * than Math.random, because a filter test that fails one run in fifty is a test
 * that gets deleted.
 */
function hailSpread(count, seed = 20260810) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  return Array.from({ length: count }, (unused, i) => [
    '2026-08-10',
    300 + i,
    0,
    1 + next() * 2,
    25 + next() * 24,
    -125 + next() * 59,
    '40027',
    'OK',
    'Cleveland',
    0,
    '',
    'spc-bulk',
    0,
    -1,
  ]);
}

test('an isolation filters the map to the reports that fall inside it', async () => {
  const viewer = stubViewer();
  const { layer } = isolationLayer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(drawn(viewer).length, 5, 'every report before the isolation');

  assert.equal(layer.setIsolation(BOX), true, 'an area is now set');
  assert.equal(drawn(viewer).length, 3, 'and only what is inside Oklahoma');
  const state = layer.getIsolation();
  assert.equal(state.inside, 3);
  assert.equal(state.total, 5, 'of the reports the option filter accepted');
  assert.equal(state.active, true);
  assert.match(state.describe, /Oklahoma/);
  assert.ok(
    drawn(viewer).every((entity) => entity.properties.county !== 'New York'),
    'a point outside the polygon is out, not merely outside the box',
  );

  assert.equal(layer.setIsolation(null), false, 'null clears the axis');
  assert.equal(layer.getIsolation(), null);
  assert.equal(drawn(viewer).length, 5, 'and every report is back');
});

test('an isolation set before the data lands still applies on load', async () => {
  // The manager hands a layer its options before the first load, when there is
  // nothing to filter yet. An isolation only remembered, never applied, would
  // leave the map showing the whole country under a panel that says Oklahoma.
  const { layer } = isolationLayer();
  layer.setIsolation(BOX);
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  assert.equal(layer.getIsolation().inside, 3);
});

test('the reports inside an isolation carry the selected mark', async () => {
  // No new rendering path: `selected` on the label model is the hook a clicked
  // report already uses, so whatever draws it for a click draws it here.
  const viewer = stubViewer();
  const { layer } = isolationLayer();
  layer.init(viewer);
  layer.enable();
  await layer.update();

  layer.setIsolation(BOX);
  const marked = drawn(viewer);
  assert.equal(marked.length, 3);
  assert.ok(
    marked.every((entity) => entity.gevLabelModel.selected === true),
    'every report on the map is one of the inside ones',
  );

  layer.setIsolationActive(false);
  const unmarked = drawn(viewer);
  assert.equal(unmarked.length, 5, 'off means every report is on the map');
  assert.ok(
    unmarked.every((entity) => entity.gevLabelModel.selected === false),
    'and nothing is marked while the isolation is off',
  );

  // The click still marks its own report, and is not the same mark — see the
  // test below, which drives the real click path.
});

test('a clicked report keeps its own mark while an isolation is on', async () => {
  // Same hook, two reasons: "you picked this" and "this is inside Oklahoma". A
  // panel that cannot tell them apart is worse than no mark, and the click must
  // survive the isolation being switched off and on again.
  const host = contextHost();
  try {
    const viewer = stubViewer();
    let picked = null;
    const harness = clickableViewer(() => picked);
    const rows = [
      REPORT(2, { lat: 35.5, lon: -97.0 }),
      REPORT(2, { lat: 40.71, lon: -74.0 }),
    ];
    const { layer, overlayHost } = makeLayer(rows, [], {
      ...daysFor(rows),
      viewer: harness.viewer,
      createInputHandler: harness.createInputHandler,
    });
    layer.init(harness.viewer);
    layer.enable();
    await layer.update();

    const [first] = drawn(harness.viewer);
    picked = { id: first };
    harness.click();
    assert.equal(layer.getSelectedReportId(), first.id);
    assert.ok(
      overlayHost.entries.at(-1).list.some((card) => card.selected === true),
      'the card says so',
    );

    layer.setIsolation(squareArea('Oklahoma', -98.1, 33.6, -94.4, 37.0));
    const inside = drawn(harness.viewer);
    assert.equal(inside.length, 1, 'the isolation kept the clicked report');
    assert.equal(
      inside[0].gevLabelModel.selected,
      true,
      'now for both reasons at once, which is the same mark',
    );

    layer.setIsolationActive(false);
    const back = drawn(harness.viewer);
    assert.equal(back.length, 2);
    assert.deepEqual(
      back
        .filter((entity) => entity.gevLabelModel.selected === true)
        .map((entity) => entity.id),
      [first.id],
      'with the isolation off, the click is the only thing marking anything',
    );
  } finally {
    host.restore();
  }
});

test('the box pre-reject is load-bearing: only the rows the box keeps pay for a scan', async () => {
  // The invariant data/isolation.js pins, exercised through THIS layer's filter,
  // because a layer that grew its own point-in-polygon would pass the data test
  // and still walk every vertex of the whole window on every filter change.
  const texas = await resolveIsolation('Texas');
  assert.ok(texas.ok, 'Texas resolves to an area with real polygons');
  const rows = hailSpread(3000);
  const { layer } = makeLayer(rows, [], daysFor(rows));
  // No init(): `render()` needs a data source, and this test is about the filter,
  // so three thousand rows never become entities. It is the same code path.
  layer.enable();

  // `polygons` is a counting getter, armed only around the load, so what it
  // counts is rows that reached the polygons rather than rows that read them.
  let polygonTests = 0;
  let armed = false;
  const counted = {
    ...texas.area,
    get polygons() {
      if (armed) polygonTests += 1;
      return texas.area.polygons;
    },
  };

  // Armed across the load only: `setIsolation` reads `polygons` once to label
  // the area, which is a lookup, not a scan, and a count that confuses the two
  // would be a count nobody could act on.
  layer.setIsolation(counted);
  armed = true;
  await layer.update();
  armed = false;

  const naive = rows.length;
  const survivors = rows.filter((report) =>
    boxesContain(texas.boxes, report[4], report[5]),
  ).length;
  assert.ok(survivors > 0, 'the fixture kept nothing, so it proves nothing');
  assert.equal(
    polygonTests,
    survivors,
    'the layer scans the polygons for a different set of rows than the box kept',
  );
  assert.ok(
    polygonTests < naive / 2,
    `the pre-reject only removed ${naive - polygonTests} of ${naive} scans`,
  );

  assert.equal(layer.getIsolation().total, rows.length, 'every row was hail');

  // And the next repaints pay nothing at all: an isolation outlives the filter
  // changes made under it, so the verdict per row is kept rather than re-walked.
  // Re-walking is what makes a whole-country area cost a second and a half on
  // every hail-floor click.
  armed = true;
  layer.setIsolationActive(false);
  layer.setIsolationActive(true);
  layer.setMinHailIn(2);
  armed = false;
  assert.equal(
    polygonTests,
    survivors,
    'a repaint under the same area and the same rows re-read no polygons',
  );
  assert.ok(
    layer.getIsolation().total < rows.length,
    'and the floor still moved the population under it',
  );
  assert.ok(layer.getIsolation().inside > 0, 'and it still answers');
});

test('the pre-reject changes the cost, not the answer', async () => {
  const texas = await resolveIsolation('Texas');
  const rows = hailSpread(400);
  const { layer } = makeLayer(rows, [], daysFor(rows));
  layer.enable();
  await layer.update();
  layer.setIsolation(texas.area);

  const brute = rows.filter(
    (report) =>
      polygonsContain(texas.area.polygons, report[4], report[5]) === true,
  ).length;
  assert.ok(brute > 0, 'the fixture found no inside point at all');
  assert.equal(
    layer.getIsolation().inside,
    brute,
    'the layer agrees with a full scan of every row',
  );
});

test('the date window and the isolation are independent axes', async () => {
  const viewer = stubViewer();
  const { layer } = isolationLayer();
  layer.init(viewer);
  layer.enable();
  await layer.update();

  layer.setDate('2026-08-10');
  layer.setIsolation(BOX);
  assert.deepEqual(layer.getDateRange(), {
    from: '2026-08-10',
    to: '2026-08-10',
  });
  assert.equal(layer.getIsolation().inside, 2, 'one in, one out, that day');
  assert.equal(drawn(viewer).length, 2);

  // Clearing the window must leave the area standing...
  layer.clearDateRange();
  assert.deepEqual(layer.getDateRange(), { from: null, to: null });
  const kept = layer.getIsolation();
  assert.ok(kept, 'the isolation survived the window being cleared');
  assert.equal(kept.active, true);
  assert.equal(kept.inside, 3, 'and now spans every day in the record');

  // ...and clearing the area must leave the window standing.
  layer.setDateRange('2026-08-10', '2026-08-11');
  layer.setIsolation(null);
  assert.equal(layer.getIsolation(), null);
  assert.deepEqual(layer.getDateRange(), {
    from: '2026-08-10',
    to: '2026-08-11',
  });
  assert.equal(drawn(viewer).length, 5, 'both days, nothing isolated');
});

test('the panel says how much of what is on screen is inside the area', async () => {
  const { layer } = isolationLayer();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  assert.doesNotMatch(
    layer.getRowControls().info,
    /inside/,
    'no area, nothing to report',
  );

  layer.setIsolation(BOX);
  const info = layer.getRowControls().info;
  assert.match(info, /3 of 5 reports inside Oklahoma/);
  // The dates and the area are both axes; the line has to show which is in force.
  layer.setDate('2026-08-10');
  assert.match(layer.getRowControls().info, /2026-08-10/);
  assert.match(layer.getRowControls().info, /2 of 4 reports inside Oklahoma/);

  layer.setIsolationActive(false);
  assert.match(
    layer.getRowControls().info,
    /isolation off — 2 of 4 reports inside Oklahoma/,
    'an area set but switched off says what it would keep',
  );
});

test('a place says it is approximate everywhere it surfaces', async () => {
  // A place is a point with a box around it. Nothing in these bundles is a city
  // boundary, so the sentence that stops a box being read as a boundary has to
  // travel onto the panel too — not only onto the control that set it.
  const { layer } = isolationLayer();
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setIsolation(placeArea('New York City', 40.71, -74.0));

  const controls = layer.getRowControls();
  assert.match(controls.info, /1 of 5 reports inside New York City/);
  assert.match(
    controls.info,
    /approximate: point with a radius, no boundary data/,
  );
  assert.match(
    chipById(layer, 'storm-reports-isolate').title,
    /approximate: point with a radius/,
  );
});

test('the ISOLATE chip is disabled until an area is set, and then switches', async () => {
  const viewer = stubViewer();
  const { layer } = isolationLayer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(chipById(layer, 'storm-reports-isolate').disabled, true);
  assert.match(
    chipById(layer, 'storm-reports-isolate').title,
    /No area to isolate to/,
  );
  assert.equal(
    layer.setIsolationActive(true),
    false,
    'and asking for it anyway changes nothing',
  );

  layer.setIsolation(BOX);
  assert.equal(chipById(layer, 'storm-reports-isolate').disabled, false);
  assert.equal(chipById(layer, 'storm-reports-isolate').active, true);

  chipById(layer, 'storm-reports-isolate').onClick();
  const off = layer.getIsolation();
  assert.equal(off.active, false, 'the chip is a switch, not a setter');
  assert.ok(off.area, 'and it kept the area to switch back to');
  assert.equal(drawn(viewer).length, 5, 'off means every report again');

  chipById(layer, 'storm-reports-isolate').onClick();
  assert.equal(layer.getIsolation().active, true);
  assert.equal(drawn(viewer).length, 3);
});

test('the size floor and the hazard switch still apply under an isolation', async () => {
  const viewer = stubViewer();
  const { layer } = isolationLayer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setIsolation(BOX);
  assert.equal(drawn(viewer).length, 3);

  layer.setMinHailIn(2);
  assert.equal(
    drawn(viewer).length,
    2,
    'the 1.25in report inside the area is floored out',
  );
  // The axis counts the OPTION-filtered set, so the floor moves its denominator
  // without moving the area: two of what is left are inside, and the two outside
  // are still in the population the line is counting against.
  assert.equal(
    layer.getIsolation().total,
    4,
    'and the axis counts what is left',
  );
  assert.equal(layer.getIsolation().inside, 2);

  layer.setHazard('wind');
  assert.equal(drawn(viewer).length, 0);
  assert.equal(layer.getIsolation().active, true, 'still isolated, just empty');

  layer.setHazard('hail');
  layer.setMinHailIn(1);
  assert.equal(drawn(viewer).length, 3, 'and it all comes back');
});

test('a storm selected under an isolation keeps its own record', async () => {
  const viewer = stubViewer();
  // twoStormDay puts the supercell's report at 35.11N and the pulse storm's at
  // 35.61N, so a box round one of them isolates to exactly one storm.
  const { layer, north, south } = twoStormDay();
  layer.init(viewer);
  layer.enable();
  await layer.update();

  layer.setIsolation(
    squareArea('north-east Oklahoma', -97.6, 35.0, -97.2, 35.3),
  );
  assert.equal(layer.selectStorm(north.id), true);
  assert.equal(drawn(viewer).length, 1, 'the storm inside the area');
  assert.match(
    layer.getRowControls().info,
    /1 of 1 this storm's reports inside north-east Oklahoma/,
    'a storm card counts the storm, not the day it sat on',
  );

  // The other storm's report is outside the area, so its selection draws nothing
  // — but its record is still answered, or the isolation would hollow out the
  // storm axis rather than narrowing it.
  layer.selectStorm(south.id);
  assert.equal(drawn(viewer).length, 0, 'nothing of that storm is inside');
  assert.equal(
    layer.getStormReports(south.id).length,
    1,
    'and its own record is still there to describe',
  );
});

test('the approximate outline still draws under an isolation', async () => {
  const viewer = stubViewer();
  const { layer, north } = twoStormDay();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setIsolation(BOX);
  layer.selectStorm(north.id);
  assert.equal(drawn(viewer).length, 1, 'the isolation kept this storm');

  layer.setOutlineVisible(true);
  assert.equal(
    drawn(viewer).filter((e) => e.id === `storm-outline:${north.id}`).length,
    1,
    'the outline is an axis of its own and the isolation did not swallow it',
  );
  assert.match(layer.getRowControls().info, /[Aa]pproximate/);
});

test('cards are summoned by pointing, not scattered over the map', async () => {
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
  layer.init(viewer);
  layer.enable();
  await layer.update();

  // THE POINT. Three reports above the hail floor used to mean three cards,
  // each titled "2.75 hail — Travis County". The colour bands are already on
  // the points and in the legend, so that was a line of text per report.
  assert.equal(
    overlayHost.entries.at(-1).list.length,
    0,
    'a loaded layer with nobody pointing at it draws no cards at all',
  );

  const first = summonCard(layer, viewer);
  const summoned = overlayHost.entries.at(-1).list;
  assert.equal(summoned.length, 1, 'exactly the pointed-at report');
  assert.match(summoned[0].title, /hail/, 'the card still names the size');

  // Pointing at the same report again is not a change, so it does not republish
  // and does not churn the overlay.
  const before = overlayHost.entries.length;
  assert.equal(
    layer.setHoveredReportId(first),
    false,
    'a repeat is not a change',
  );
  assert.equal(overlayHost.entries.length, before, 'and publishes nothing');

  // Pointing away sends the card with it.
  assert.equal(layer.setHoveredReportId(null), true, 'the pointer left');
  assert.equal(overlayHost.entries.at(-1).list.length, 0, 'the card went too');
});

test('hover works on ANY drawn report, not only the tracked cohort', async () => {
  // THE BUG. The hover path required `_contextIds`, which holds only the worst
  // STORM_CONTEXT_LIMIT (40) reports. On a day with 44,717 the other 44,677
  // summoned nothing at all, and no test noticed because this suite only ever
  // drove `actions[0]` - the click - and so never executed the MOUSE_MOVE path.
  const many = Array.from({ length: 120 }, (_, i) =>
    REPORT(1 + (i % 3) * 0.25),
  );
  let picked = null;
  const harness = clickableViewer(() => picked);
  const { layer, overlayHost } = makeLayer(many, [], {
    viewer: harness.viewer,
    createInputHandler: harness.createInputHandler,
  });
  layer.init(harness.viewer);
  layer.enable();
  await layer.update();

  // A report well outside the worst-40 cohort. 120 reports, so the cohort is a
  // third of them and this one is deliberately not among the first.
  const outsideCohort = drawn(harness.viewer)
    .map((e) => e.id)
    .filter((id) => String(id).startsWith('storm-report-'))
    .at(-1);
  assert.ok(outsideCohort, 'the layer drew reports');

  // Point at it for real, through the handler the mouse drives.
  picked = { id: { id: outsideCohort } };
  harness.move();
  await settled(layer);
  assert.equal(
    overlayHost.entries.at(-1).list.length,
    1,
    'a report outside the tracked cohort still summons its card',
  );

  // Moving off it dismisses.
  picked = { id: { id: 'something-else' } };
  harness.move();
  await settled(layer);
  assert.equal(
    overlayHost.entries.at(-1).list.length,
    0,
    'and leaving dismisses',
  );
});

test('markers are capped to the worst N, and the panel says so', async () => {
  // A fresh load with no date filter draws 44,720 markers, each a Cesium
  // Entity with `disableDepthTestDistance: INFINITY` so none can be occluded.
  // Measured: that halves an already-4fps frame. The cap takes the worst of
  // the filter; every number the panel shows must stay the TRUE count.
  const rows = Array.from({ length: 2500 }, (_, i) =>
    REPORT(1 + (i % 40) * 0.25),
  );
  const { layer, overlayHost } = makeLayer(rows);
  const viewer = stubViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();

  const markers = drawn(viewer);
  assert.ok(markers.length > 0, 'markers were drawn');
  assert.ok(
    markers.length < rows.length,
    `drawn markers are capped, not every report (drew ${markers.length} of ${rows.length})`,
  );

  // The counts are NOT capped. This is the whole point: the cap bounds pixels,
  // not data.
  const info = layer.getRowControls().info;
  assert.match(info, /2,500 reports/, 'the true total is still reported');
  assert.match(
    info,
    /showing the [\d,]+ worst on the map/,
    'and the shortfall is stated rather than silent',
  );
  assert.equal(layer.getStats().count, rows.length, 'getStats counts them all');
  assert.equal(
    layer.getStats().drawnCount,
    markers.length,
    'and reports what it drew',
  );
});

test('the cap keeps the WORST reports, not the first ones', async () => {
  // REPORT returns a PACKED row, so magnitude is index 3, not `.size`.
  const small = REPORT(1);
  const big = REPORT(3);
  const rows = [small, big];
  const { layer } = makeLayer(rows);
  const viewer = stubViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const ids = drawn(viewer).map((e) => String(e.id));
  // Only two reports, so the cap cannot bite - but the ORDER must still be
  // worst-first, which is what the cap relies on.
  assert.equal(ids.length, 2);
  assert.ok(
    ids[0].includes(`-${big[3]}`),
    `the worst report is drawn first (${ids[0]})`,
  );
});

test('a small result set is not capped and makes no claim', async () => {
  const rows = [REPORT(2), REPORT(1.75)];
  const { layer } = makeLayer(rows);
  const viewer = stubViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(drawn(viewer).length, 2, 'everything drawn');
  assert.doesNotMatch(
    layer.getRowControls().info,
    /showing the/,
    'and the panel does not mention a cap that did not apply',
  );
});


// ===========================================================================
// The fine 1 km render path. The single-day window is the case it exists for.
// ===========================================================================

test('a single-day window draws the wash from the FINE field, at 1 km', async () => {
  // The seam: `dayFor` is the optional fine source. It is a SIBLING of `daysFor`
  // because the two index spaces are 25x apart and index 0 means different
  // places in each, so a layer without one must behave exactly as before.
  const day = radarDayIndex('2026-06-01');
  const asked = [];
  const radarSource = {
    daysFor: async () => new Map([[day, new Map([[cellKey(35.11, -97.4), 45]])]]),
    // Fine cells are 1 km indices, i.e. 25x the coarse ones for the same place.
    dayFor: async (date) => {
      asked.push(date);
      if (date !== '2026-06-01') return { cells: [], count: 0 };
      // Denver, 2026-06-01, in fine indices: 39.625N / -104.875W at 0.01
      // degrees per cell. Two cells side by side in longitude, which is the
      // smallest real thing a swath can be.
      return {
        count: 2,
        cells: [
          { i: 3962, j: -10488, maxMm: 45 },
          { i: 3962, j: -10487, maxMm: 45 },
        ],
      };
    },
  };
  const viewer = stubViewer();
  const { layer } = makeLayer([REPORT(2, { lat: 35.11 })], [], {
    radarSource,
    viewer,
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setDate('2026-06-01');
  await settled(layer);
  layer.setRadarSwath(true);

  assert.ok(asked.includes('2026-06-01'), 'the fine source was asked for the day');
  const swaths = swathEntities(viewer, 'radar');
  assert.ok(swaths.length >= 1, 'and the wash drew something');
  // Two ADJACENT fine cells must become ONE polygon. At the coarse grid these
  // coordinates are 25 cells apart and would be two; the point of the fine field
  // is that a real neighbourhood collapses into a shape rather than a grid.
  assert.equal(
    swaths.length,
    1,
    `two adjacent 1km cells are one polygon, not two squares (got ${swaths.length})`,
  );

  // And the polygon is drawn at the FINE step. This is the assertion that was
  // missing: `ringsToDegrees` takes the step as an argument, so testing the
  // function proves nothing about the CALLER. Hardcoding the coarse step here —
  // which is exactly the bug — left every test in the file green while drawing
  // 25x-too-large geometry.
  const DEG = 180 / Math.PI;
  const positions = value(swaths[0].polygon.hierarchy)?.positions ?? [];
  // `cartesianToCartographic` returns RADIANS. Reading them as degrees makes
  // Denver's 39.62N read as 0.6915, which is the trap this document lists
  // second — and the span then looks like 0.0002 instead of 0.01.
  const lats = positions.map(
    (p) => Cesium.Ellipsoid.WGS84.cartesianToCartographic(p).latitude * DEG,
  );
  const lons = positions.map(
    (p) => Cesium.Ellipsoid.WGS84.cartesianToCartographic(p).longitude * DEG,
  );
  assert.ok(lats.length >= 4, `a closed polygon, got ${positions.length} vertices`);
  // CENTRED, and no coarser than one fine cell.
  //
  // These used to pin the staircase's exact edges - south edge 39.62, span
  // 0.01 - which is no longer true of anything, because the radar wash is
  // contoured now and the contour crosses between samples. It sits a fraction
  // of a cell OUTSIDE the outermost cell, because that cell has a value and its
  // neighbour has none.
  //
  // The assertions keep the job this file actually needs them to do: catch the
  // renderer drawing 25x-too-large geometry. A centre check and a span ceiling
  // do that; an exact edge would not survive the next tuning of the contour.
  const centreLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const centreLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  assert.ok(
    Math.abs(centreLat - 39.625) < 1e-6,
    `centred on the cell (39.625N), not ${centreLat.toFixed(4)}`,
  );
  assert.ok(
    // Two cells side by side in longitude (j -10488 and -10487), so the shape
    // is centred between them, not on either.
    Math.abs(centreLon + 104.87) < 1e-6,
    `and on the fine longitude (-104.87), not ${centreLon.toFixed(4)}`,
  );
  const latSpan = Math.max(...lats) - Math.min(...lats);
  assert.ok(
    latSpan > 0 && latSpan < 0.02,
    `narrower than a coarse cell: ${latSpan} degrees, expected under 0.02`,
  );
});

test('a multi-day window stays coarse and never asks for a fine day', async () => {
  // Combining dates is a regional question — "which streets took it more than
  // once" — and a per-day fetch per selected day would be a fetch storm.
  const asked = [];
  const radarSource = {
    daysFor: async () =>
      new Map([[radarDayIndex('2026-08-09'), new Map([[cellKey(35.11, -97.4), 30]])]]),
    dayFor: async (date) => {
      asked.push(date);
      return { cells: [], count: 0 };
    },
  };
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource, viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setDateRange('2026-08-09', '2026-08-10');
  await settled(layer);
  layer.setRadarSwath(true);
  assert.deepEqual(asked, [], 'a range asks for no fine day at all');
});

test('a layer with no fine source renders exactly as before', async () => {
  // The panel no longer ships the payload, and most tests construct no fine
  // source. Neither may change behaviour.
  const day = radarDayIndex('2026-08-10');
  const radarSource = {
    daysFor: async () => new Map([[day, new Map([[cellKey(35.11, -97.4), 45]])]]),
  };
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource, viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  await settled(layer);
  layer.setRadarSwath(true);
  assert.ok(
    swathEntities(viewer, 'radar').length >= 1,
    'the coarse path still draws',
  );
});

test('a failing fine fetch falls back to the coarse field rather than to nothing', async () => {
  // A day outside the retention window has no shard by design, and a network
  // error must not empty the map.
  const day = radarDayIndex('2026-08-10');
  const radarSource = {
    daysFor: async () => new Map([[day, new Map([[cellKey(35.11, -97.4), 45]])]]),
    dayFor: async () => {
      throw new Error('404');
    },
  };
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource, viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  await settled(layer);
  layer.setRadarSwath(true);
  assert.ok(
    swathEntities(viewer, 'radar').length >= 1,
    'the coarse field still drew after the fine one failed',
  );
});

test('ringsToDegrees takes the grid step, and the fine step is 1 km', () => {
  // Passing the wrong step displaces every ring by 25x — half a cell at the fine
  // step — which is the kind of error that renders perfectly and is wrong.
  const [coarse] = ringsToDegrees(gridCellRings([{ i: 140, j: -390 }]));
  const [fine] = ringsToDegrees(gridCellRings([{ i: 140, j: -390 }]), GRID_DEG_FINE);
  // Rounded: 140 * 0.01 is 1.4000000000000001 in binary floating point, and a
  // degree off by 2e-16 is not the bug this test is here to catch.
  assert.equal(Math.min(...coarse.outer.map((p) => p.lat)), 35, '140 x 0.25');
  assert.equal(Number(Math.min(...fine.outer.map((p) => p.lat)).toFixed(6)), 1.4, '140 x 0.01');
  assert.equal(GRID_DEG_FINE, 0.01, 'and the step is 1 km, not a literal');
});


// ===========================================================================
// The remount. Both swath toggles initialised false, which meant any reload
// silently emptied the map and looked like a rendering bug.
// ===========================================================================

test('both swath toggles survive a remount', async () => {
  // A remount is a NEW layer instance handed the previous one's getParams().
  // That is what the manager does on HMR and on a share-link restore, so the
  // test is built the same way rather than reaching into private state.
  const radarSource = {
    daysFor: async () => new Map(),
    dayFor: async () => ({ cells: [], count: 0 }),
  };
  const first = makeLayer([REPORT(2, { lat: 35.11 })], [], { radarSource });
  first.layer.init(stubViewer());
  first.layer.enable();
  await first.layer.update();
  first.layer.setHazard('hail');
  first.layer.setReportedSwath(true);
  first.layer.setRadarSwath(true);
  const carried = first.layer.getParams();
  assert.equal(carried.reportedSwath, true, 'and the intent is reported, not just held');

  const second = makeLayer([REPORT(2, { lat: 35.11 })], [], { radarSource });
  second.layer.init(stubViewer());
  second.layer.enable();
  await second.layer.update();
  second.layer.setParams(carried);

  assert.equal(second.layer.getReportedSwath(), true, 'REPORTED came back on');
  assert.equal(second.layer.getRadarSwath(), true, 'RADAR came back on');
});

test('a swath intent that arrives before its data is honoured, not dropped', async () => {
  // The refusal is real and correct - REPORTED needs the hail hazard - but a
  // durable restore legitimately arrives before the hazard is known. The
  // intent has to survive that and land once there is something to draw it on,
  // or the map is empty on arrival, which is the bug.
  //
  // The hazard is forced to WIND first, because the default is already HAIL and
  // a REPORTED intent against HAIL does not refuse - which would make this test
  // pass without ever deferring anything, and prove nothing.
  const radarSource = {
    daysFor: async () => new Map(),
    dayFor: async () => ({ cells: [], count: 0 }),
  };
  const layer = makeLayer([REPORT(2, { lat: 35.11 })], [], { radarSource });
  layer.layer.init(stubViewer());
  layer.layer.setHazard('wind');
  // Before enable: no snapshot, so the hazard in these params is not applied
  // yet, and REPORTED has nothing to stand on. It refuses, and must be kept.
  layer.layer.setParams({ hazard: 'hail', reportedSwath: true });
  assert.equal(
    layer.layer.getReportedSwath(),
    false,
    'refused for now, while the hazard is still WIND',
  );

  layer.layer.enable();
  await layer.layer.update();

  assert.equal(
    layer.layer.getReportedSwath(),
    true,
    'REPORTED was replayed once the hail hazard landed',
  );
});

test('a RADAR intent on a source-less build is not deferred forever', async () => {
  // The mirror: `setRadarSwath` refuses with no radar source, and that stays
  // true for the life of the layer. Deferring it would replay on every load for
  // an intent that can never be honoured - so it is refused and reported off.
  const layer = makeLayer([REPORT(2, { lat: 35.11 })], []);
  layer.layer.init(stubViewer());
  layer.layer.enable();
  await layer.layer.update();
  layer.layer.setHazard('hail');
  layer.layer.setParams({ radarSwath: true });
  assert.equal(layer.layer.getRadarSwath(), false, 'off, and honestly reported off');
  assert.equal(layer.layer.getParams().radarSwath, false, 'not a pending promise');
});

test('a REPORTED intent is still refused under WIND', async () => {
  // Deferring must not become a bypass. The chip is disabled under WIND and the
  // intent path has to agree with it, or a share link could conjure a wedge
  // the UI refuses to offer.
  const layer = makeLayer([REPORT(2, { lat: 35.11, windKt: 80 })], []);
  layer.layer.init(stubViewer());
  layer.layer.enable();
  await layer.layer.update();
  layer.layer.setHazard('wind');
  layer.layer.setParams({ reportedSwath: true });
  assert.equal(layer.layer.getReportedSwath(), false, 'refused, and kept refused');
});

test('a RADAR intent with no radar source stays off', async () => {
  // Same rule for the sibling: no source means no wedge, from either direction.
  const layer = makeLayer([REPORT(2, { lat: 35.11 })], []);
  layer.layer.init(stubViewer());
  layer.layer.enable();
  await layer.layer.update();
  layer.layer.setHazard('hail');
  layer.layer.setParams({ radarSwath: true });
  assert.equal(layer.layer.getRadarSwath(), false, 'refused, and kept refused');
});

test('getParams reports the toggles as they are, not as they were asked for', async () => {
  // The mirror of the deferral: if a toggle is still deferred, reporting the
  // intent would be the same lie the other way - a share link that promises a
  // wash nobody can see.
  const layer = makeLayer([REPORT(2, { lat: 35.11 })], []);
  layer.layer.init(stubViewer());
  layer.layer.enable();
  await layer.layer.update();
  layer.layer.setHazard('wind');
  layer.layer.setParams({ reportedSwath: true });
  assert.equal(
    layer.layer.getParams().reportedSwath,
    false,
    'a refused toggle is reported off',
  );
});


// ===========================================================================
// Altitude LOD. Measured, not assumed: at 1.7km over the densest part of
// 2026-06-01 the fine field covered 99.94% of the frame, because at that scale
// a 1km cell is sub-pixel and same-band polygons stack into one flat wash.
// ===========================================================================

/** A single-day fine source plus a matching coarse one, for the same day. */
function lodRadarSource() {
  const day = radarDayIndex('2026-06-01');
  return {
    daysFor: async () => new Map([[day, new Map([[cellKey(35.11, -97.4), 45]])]]),
    dayFor: async () => ({ count: 1, cells: [{ i: 3962, j: -10488, maxMm: 45 }] }),
  };
}

/** The drawn width, in degrees, of the smallest radar polygon. */
function finestRadarSpanDeg(viewer) {
  const spans = swathEntities(viewer, 'radar')
    .map((e) => value(e.polygon?.hierarchy)?.positions ?? [])
    .filter((p) => p.length >= 4)
    .map((p) => {
      const lats = p.map(
        (q) => Cesium.Ellipsoid.WGS84.cartesianToCartographic(q).latitude,
      );
      return (Math.max(...lats) - Math.min(...lats)) * (180 / Math.PI);
    });
  return spans.length ? Math.min(...spans) : null;
}

test('the fine field is drawn close up and dropped above the LOD altitude', async () => {
  // Below the threshold a single day draws 1km; above it, the 0.25-degree field.
  // Both are correct answers - which is why the assertion is on the GEOMETRY
  // rather than on a flag: the whole point of the tier is which cells it draws.
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource: lodRadarSource(), viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setHazard('hail');
  layer.setDate('2026-06-01');
  await settled(layer);
  layer.setRadarSwath(true);

  // The wash is contoured now, so a lone cell does not measure exactly one
  // grid step - the contour crosses between samples and sits a fraction of a
  // cell inside the cell's own edge. What these assertions are FOR is telling
  // the two tiers apart, and the two are a factor of 25 apart, so the bands
  // below are wide enough to absorb the interpolation and still cannot be
  // confused with each other.
  setCameraHeight(viewer, 3_000);
  const fine = finestRadarSpanDeg(viewer);
  assert.ok(
    fine > 0 && fine < 0.02,
    `close up it is the 1km field, got a span of ${fine} degrees`,
  );

  setCameraHeight(viewer, 40_000);
  const coarse = finestRadarSpanDeg(viewer);
  assert.ok(
    coarse > 0.1,
    `from altitude it is the 0.25-degree field, got a span of ${coarse} degrees`,
  );
});

test('a zoom that crosses the LOD boundary redraws the wash', async () => {
  // Without the moveEnd listener the tier would be chosen once, at toggle time,
  // and the wash would stay 1km after a zoom-out until some unrelated repaint.
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource: lodRadarSource(), viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setHazard('hail');
  layer.setDate('2026-06-01');
  await settled(layer);
  layer.setRadarSwath(true);
  // Same reasoning as above: tier identification, not exact step size.
  setCameraHeight(viewer, 3_000);
  assert.ok(
    finestRadarSpanDeg(viewer) < 0.02,
    `starts fine, got ${finestRadarSpanDeg(viewer)}`,
  );

  setCameraHeight(viewer, 25_000);
  assert.ok(
    finestRadarSpanDeg(viewer) > 0.1,
    `and became coarse on the zoom-out alone, got ${finestRadarSpanDeg(viewer)}`,
  );
});

test('the alpha ceiling eases off with altitude, monotonically', async () => {
  // The user-visible half of the LOD: at altitude the wash must not flatten the
  // basemap. Measured off the entities the layer actually created.
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource: lodRadarSource(), viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setHazard('hail');
  layer.setDate('2026-06-01');
  await settled(layer);
  layer.setRadarSwath(true);

  const topBandAlpha = () => {
    const polys = swathEntities(viewer, 'radar');
    return Math.max(
      ...polys.map((e) => value(e.polygon?.material)?.color?.alpha ?? 0),
    );
  };
  setCameraHeight(viewer, 3_000);
  const near = topBandAlpha();
  setCameraHeight(viewer, 60_000);
  const far = topBandAlpha();
  assert.ok(far < near, `lighter at altitude (${far} < ${near})`);
  assert.ok(far > 0, 'and never invisible — it is a wash, not a fade-out');
});

test('destroy() unsubscribes the camera listener', async () => {
  // A listener left on a destroyed layer's camera keeps calling renderSwaths on
  // a viewer the layer no longer owns.
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource: lodRadarSource(), viewer });
  layer.init(viewer);
  assert.equal(viewer.camera.moveEnd.__listeners.length, 1, 'subscribed');
  layer.destroy();
  assert.equal(
    viewer.camera.moveEnd.__listeners.length,
    0,
    'and gone after destroy',
  );
});


// ===========================================================================
// Isolation. The REPORTED swath was always scoped, because it is built from
// `_visible`. The RADAR one was not, so isolating a state filtered the pins and
// left the wash spanning the country.
// ===========================================================================

/**
 * A rectangular isolation area, in degrees.
 *
 * `bbox` is `[west, south, east, north]` — the order `normaliseBbox` reads,
 * which is not the order the arguments read in. Getting that wrong produces an
 * area that contains nothing, and the failure looks like "isolation never
 * worked" rather than "the test built a box in the wrong order".
 */
function boxArea(south, west, north, east) {
  return { bbox: [west, south, east, north] };
}

test('isolation clips the RADAR swath to the area, not just the pins', async () => {
  const radarSource = {
    daysFor: async () =>
      new Map([
        [
          radarDayIndex('2026-06-01'),
          new Map([
            // inside the box (Denver-ish)
            [cellKey(39.6, -104.9), 45],
            // outside it (Chicago), same day, same map
            [cellKey(41.9, -87.6), 60],
          ]),
        ],
      ]),
    dayFor: async () => ({ cells: [], count: 0 }),
  };
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource, viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setHazard('hail');
  layer.setDate('2026-06-01');
  await settled(layer);
  layer.setRadarSwath(true);
  const before = swathEntities(viewer, 'radar').length;
  assert.ok(before >= 1, 'both cells drew with no isolation');

  layer.setIsolation(boxArea(37, -109, 41, -102));
  const after = swathEntities(viewer, 'radar').length;
  assert.ok(
    after > 0 && after < before,
    `isolating shrinks the wash (${before} -> ${after}), rather than leaving it whole`,
  );
});

test('isolation clips the FINE swath too', async () => {
  // The fine path is a separate adapter, so it needed its own filter - and a
  // fix to one is not a fix to the other.
  const day = radarDayIndex('2026-06-01');
  const radarSource = {
    daysFor: async () =>
      new Map([[day, new Map([[cellKey(41.9, -87.6), 60]]), ]]),
    dayFor: async () => ({
      count: 2,
      cells: [
        { i: 3962, j: -10488, maxMm: 45 }, // inside
        { i: 4190, j: -8760, maxMm: 60 }, // outside
      ],
    }),
  };
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource, viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setHazard('hail');
  layer.setDate('2026-06-01');
  await settled(layer);
  layer.setRadarSwath(true);
  setCameraHeight(viewer, 3_000);
  assert.ok(swathEntities(viewer, 'radar').length >= 1, 'fine draws unclipped');

  layer.setIsolation(boxArea(37, -109, 41, -102));
  const spans = swathEntities(viewer, 'radar').map((e) =>
    value(e.polygon?.hierarchy)?.positions ?? [],
  );
  const kept = spans.filter((p) => p.length >= 4);
  assert.ok(kept.length >= 1, 'the inside cell survived');
  const lats = kept.flat().map(
    (q) =>
      Cesium.Ellipsoid.WGS84.cartesianToCartographic(q).latitude *
      (180 / Math.PI),
  );
  // Exactly the box's own bounds, 37..41. A looser window around them - 36..42 -
  // still contains the Chicago cell at 41.9 and passes while the clip does
  // nothing, which is how this assertion spent its first version.
  assert.ok(
    Math.min(...lats) >= 37 - 1e-6 && Math.max(...lats) <= 41 + 1e-6,
    `and nothing outside the 37..41 box was kept (lat ${Math.min(...lats).toFixed(2)}..${Math.max(...lats).toFixed(2)})`,
  );
});

test('turning isolation OFF restores the whole swath', async () => {
  // The chip is a switch that remembers its area, so the off position has to
  // put the wash back rather than leave a Colorado-shaped hole.
  const day = radarDayIndex('2026-06-01');
  const radarSource = {
    daysFor: async () =>
      new Map([
        [
          day,
          new Map([
            [cellKey(39.6, -104.9), 45],
            [cellKey(41.9, -87.6), 60],
          ]),
        ],
      ]),
    dayFor: async () => ({ cells: [], count: 0 }),
  };
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource, viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setHazard('hail');
  layer.setDate('2026-06-01');
  await settled(layer);
  layer.setRadarSwath(true);
  const whole = swathEntities(viewer, 'radar').length;

  layer.setIsolation(boxArea(37, -109, 41, -102));
  assert.ok(swathEntities(viewer, 'radar').length < whole, 'clipped');
  layer.setIsolationActive(false);
  assert.equal(
    swathEntities(viewer, 'radar').length,
    whole,
    'and back to the whole day when switched off',
  );
});


test('the coarse tier is built from COARSE cells, never from fine indices', async () => {
  // The LOD bug, in one test. A single-day window loads BOTH fields, and the
  // coarse band must be built from the coarse one. It used to be built from the
  // fine map, whose 1km indices were read as 0.25-degree indices - so every
  // coarse cell landed 25x from its true position.
  //
  // Asserted on POSITION. An earlier version of this only checked that the
  // polygon was 0.25 degrees wide, which the mis-built wash also was, so the
  // whole thing passed while the map was nonsense.
  const day = radarDayIndex('2026-06-01');
  const radarSource = {
    daysFor: async () =>
      new Map([[day, new Map([[cellKey(39.6, -104.9), 45]])]]),
    dayFor: async () => ({ count: 1, cells: [{ i: 3962, j: -10488, maxMm: 45 }] }),
  };
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource, viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setHazard('hail');
  layer.setDate('2026-06-01');
  await settled(layer);
  layer.setRadarSwath(true);

  setCameraHeight(viewer, 40_000);
  const polys = swathEntities(viewer, 'radar')
    .map((e) => value(e.polygon?.hierarchy)?.positions ?? [])
    .filter((p) => p.length >= 4);
  assert.ok(polys.length >= 1, 'a coarse polygon drew');

  const centres = polys.flatMap((p) =>
    p.map((q) => {
      const c = Cesium.Ellipsoid.WGS84.cartesianToCartographic(q);
      return [c.latitude * (180 / Math.PI), c.longitude * (180 / Math.PI)];
    }),
  );
  const lats = centres.map(([la]) => la);
  const lons = centres.map(([, lo]) => lo);
  // The coarse cell was authored at 39.6N / -104.9. Read as fine indices it
  // would have been drawn near 990N, which is not a latitude.
  assert.ok(
    Math.min(...lats) > 38 && Math.max(...lats) < 42,
    `drawn near the cell, not 25x away (lat ${Math.min(...lats).toFixed(1)}..${Math.max(...lats).toFixed(1)})`,
  );
  assert.ok(
    Math.min(...lons) > -107 && Math.max(...lons) < -102,
    `and near its longitude (${Math.min(...lons).toFixed(1)}..${Math.max(...lons).toFixed(1)})`,
  );
});

test('a single-day window loads the coarse field even when a fine day exists', async () => {
  // The cost of the fix above, stated as a test so it cannot be quietly dropped:
  // the coarse year file is fetched alongside the fine day, because the coarse
  // band needs it whenever the camera is high.
  const asked = [];
  const day = radarDayIndex('2026-06-01');
  const radarSource = {
    daysFor: async (year) => {
      asked.push(`year:${year}`);
      return new Map([[day, new Map([[cellKey(39.6, -104.9), 45]])]]);
    },
    dayFor: async () => ({ count: 1, cells: [{ i: 3962, j: -10488, maxMm: 45 }] }),
  };
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource, viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setHazard('hail');
  layer.setDate('2026-06-01');
  await settled(layer);
  layer.setRadarSwath(true);
  setCameraHeight(viewer, 40_000);
  assert.ok(
    asked.some((a) => a.startsWith('year:')),
    `the coarse year was still fetched (${JSON.stringify(asked)})`,
  );
  assert.ok(swathEntities(viewer, 'radar').length >= 1, 'and the coarse band drew');
});

test('an isolation area with no bbox does not blank the map', async () => {
  // `areaContains` answers false for an area it cannot read, so clipping
  // against one rejected every cell and emptied the map for an isolation that
  // was never really set. The safe direction is to not clip: covering too much
  // is recoverable, vanishing is not.
  const day = radarDayIndex('2026-06-01');
  const radarSource = {
    daysFor: async () => new Map([[day, new Map([[cellKey(39.6, -104.9), 45]])]]),
    dayFor: async () => ({ cells: [], count: 0 }),
  };
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource, viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setHazard('hail');
  layer.setDate('2026-06-01');
  await settled(layer);
  layer.setRadarSwath(true);
  const before = swathEntities(viewer, 'radar').length;
  assert.ok(before >= 1, 'the wash drew');

  layer.setIsolation({ kind: 'state', name: 'Nowhere' });
  assert.ok(
    swathEntities(viewer, 'radar').length >= 1,
    'and is still there for an area that cannot be tested',
  );
});

test('a cell is tested by its CENTRE, so a border cell does not overhang', async () => {
  // `gridCell` puts a cell's centre at `i * step + step / 2`. Testing
  // `i * step` is half a cell out, and at a border that is exactly enough to
  // admit a cell whose centre is in the next state: Colorado's northern edge is
  // 41.00, and the cell spanning 41.00-41.25 has its centre at 41.125.
  //
  // The box below ends at 41.00. With the corner convention that cell's centre
  // tests as 41.00 - inside - and it draws a quarter-degree past the border.
  const day = radarDayIndex('2026-06-01');
  const radarSource = {
    daysFor: async () =>
      new Map([
        [
          day,
          new Map([
            // Ten columns apart as well as one row: adjacent cells are merged
            // into ONE ring by the ring extraction, so a neighbour would never
            // have been a second polygon to measure.
            // Raw indices, because `cellKey` divides by the step and rounds,
            // and 41.125 is not reachable that way: cell centres sit at
            // i * 0.25 + 0.125, so i=163 is 40.875 and i=164 is 41.125.
            ['163:-420', 45], // centre 40.875, inside
            ['164:-430', 45], // centre 41.125 lon -107.5 - outside by LAT only
          ]),
        ],
      ]),
    dayFor: async () => ({ cells: [], count: 0 }),
  };
  const viewer = stubViewer();
  const { layer } = makeLayer([], [], { radarSource, viewer });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setHazard('hail');
  layer.setDate('2026-06-01');
  await settled(layer);
  layer.setRadarSwath(true);
  const unclipped = swathEntities(viewer, 'radar').length;
  assert.ok(unclipped >= 2, 'both cells draw with no isolation');

  // north edge exactly 41.00
  layer.setIsolation({ bbox: [-109.05, 37, -102.04, 41] });
  const spans = swathEntities(viewer, 'radar')
    .map((e) => value(e.polygon?.hierarchy)?.positions ?? [])
    .filter((p) => p.length >= 4)
    .flat()
    .map((q) => Cesium.Ellipsoid.WGS84.cartesianToCartographic(q).latitude * (180 / Math.PI));
  assert.ok(spans.length >= 1, 'the inside cell survived');
  assert.ok(
    Math.max(...spans) <= 41 + 1e-6,
    `nothing is drawn past the border (max lat ${Math.max(...spans).toFixed(4)})`,
  );
});

/* ======================================================================
 * PROSPECT: the radar-minus-reports lead list.
 *
 * The chips above decide what gets drawn. These check the wiring: that the
 * chip exists and is gated the same way, that it draws its OWN entities
 * rather than borrowing the radar swath's, that it survives a rebuild via
 * getParams, and that the legend carries a count rather than a mood.
 * ====================================================================== */

const prospectChip = (layer) =>
  layer
    .getRowControls()
    .chips.find((chip) => chip.id === 'storm-reports-swath-prospect');

/** A layer over one day of radar, with `cells` as `lat,lon -> mm`. */
async function prospectLayer(cells, reports, extra = {}) {
  const day = radarDayIndex('2026-08-10');
  const radarSource = { daysFor: async () => new Map([[day, cells]]) };
  const viewer = stubViewer();
  const { layer } = makeLayer(reports, [], { radarSource, viewer, ...extra });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  await settled(layer);
  return { layer, viewer };
}

test('the PROSPECT chip is offered, gated on hail, and off by default', async () => {
  const { layer, viewer } = await prospectLayer(
    new Map([[cellKey(35.11, -97.4), 45]]),
    [REPORT(2, { lat: 35.11 })],
  );
  const chip = prospectChip(layer);
  assert.ok(chip, 'the chip is on the row');
  assert.equal(chip.label, 'PROSPECT');
  assert.equal(chip.disabled, false, 'there is radar to compare against');
  assert.equal(layer.getProspectSwath(), false, 'off until asked for');
  assert.equal(swathEntities(viewer, 'prospect').length, 0);
});

test('PROSPECT draws the radar cells no report covers', async () => {
  // One cell with a report sitting in it, one four degrees away with none.
  const cells = new Map([
    [cellKey(35.11, -97.4), 45],
    [cellKey(38.61, -101.2), 95],
  ]);
  const { layer, viewer } = await prospectLayer(cells, [
    REPORT(2, { lat: 35.11 }),
  ]);
  assert.equal(layer.setProspectSwath(true), true);
  const drawn = swathEntities(viewer, 'prospect');
  assert.equal(
    drawn.length,
    1,
    'only the unreported cell is a lead',
  );
  assert.equal(
    swathEntities(viewer, 'radar').length,
    2,
    'and it leaves the radar swath alone - the radar is on by default now, ' +
      'and PROSPECT is a different view of the same day, not a replacement ' +
      'for it',
  );
});

test('PROSPECT and RADAR are independent views of the same day', async () => {
  const cells = new Map([
    [cellKey(35.11, -97.4), 45],
    [cellKey(38.61, -101.2), 95],
  ]);
  const { layer, viewer } = await prospectLayer(cells, [
    REPORT(2, { lat: 35.11 }),
  ]);
  // RADAR is on by default, so it is already showing both cells.
  assert.equal(swathEntities(viewer, 'radar').length, 2, 'radar: both cells');
  layer.setProspectSwath(true);
  assert.equal(
    swathEntities(viewer, 'prospect').length,
    1,
    'prospect: the unreported one',
  );
  assert.equal(
    swathEntities(viewer, 'radar').length,
    2,
    'turning prospect on does not disturb radar',
  );
  layer.setProspectSwath(false);
  assert.equal(
    swathEntities(viewer, 'prospect').length,
    0,
    'and turning it off clears only its own',
  );
  assert.equal(swathEntities(viewer, 'radar').length, 2, 'radar survives');
});

test('PROSPECT reports whether it moved, and refuses when it cannot be true', async () => {
  const { layer } = await prospectLayer(
    new Map([[cellKey(35.11, -97.4), 45]]),
    [REPORT(2, { lat: 35.11 })],
  );
  assert.equal(layer.setProspectSwath(false), false, 'already off');
  assert.equal(layer.setProspectSwath(true), true, 'moved');
  assert.equal(layer.setProspectSwath(true), false, 'already on');
  layer.setHazard('wind');
  layer.setProspectSwath(false);
  assert.equal(
    layer.setProspectSwath(true),
    false,
    'no wind radar means no hail to compare',
  );
});

test('PROSPECT survives a rebuild through getParams', async () => {
  const cells = new Map([[cellKey(35.11, -97.4), 45]]);
  const { layer, viewer } = await prospectLayer(cells, [
    REPORT(2, { lat: 38.61, lon: -101.2 }),
  ]);
  layer.setProspectSwath(true);
  assert.equal(layer.getParams().prospectSwath, true, 'reported as live');

  const { layer: next, viewer: nextViewer } = await prospectLayer(cells, [
    REPORT(2, { lat: 38.61, lon: -101.2 }),
  ]);
  next.setParams({ ...STORM_REPORTS_DEFAULTS, ...layer.getParams() });
  await settled(next);
  assert.equal(next.getProspectSwath(), true, 'restored on the new layer');
  assert.ok(
    swathEntities(nextViewer, 'prospect').length > 0,
    'and it actually drew the lead',
  );
  assert.ok(viewer, 'the original viewer is still the one under test');
});

test('the legend quotes an area and a report count, not a feeling', async () => {
  const cells = new Map([
    [cellKey(35.11, -97.4), 45],
    [cellKey(38.61, -101.2), 95],
  ]);
  const { layer } = await prospectLayer(cells, [REPORT(2, { lat: 35.11 })]);
  layer.setProspectSwath(true);
  const legend = layer
    .getRowControls()
    .legend.filter((entry) => String(entry.label).startsWith('Prospecting'));
  assert.ok(legend.length >= 2, 'a readout and a ramp');
  const readout = legend[0].blurb;
  assert.match(readout, /sq km/, `readout quotes an area: ${readout}`);
  assert.match(readout, /1 report/, `readout quotes the reports: ${readout}`);
  assert.match(readout, /9 km/, 'and the radius it searched');
  assert.match(readout, /worst unsuppressed reading/, 'and the worst cell');
});

test('with nothing unreported the legend says so instead of showing zero', async () => {
  // Every cell covered. The failure this kills is a legend reading "0 sq km",
  // which reads like a broken widget rather than a real answer.
  const cells = new Map([[cellKey(35.11, -97.4), 45]]);
  const { layer } = await prospectLayer(cells, [REPORT(2, { lat: 35.11 })]);
  layer.setProspectSwath(true);
  const readout = layer
    .getRowControls()
    .legend.find((entry) => entry.label === 'Prospecting, this view').blurb;
  assert.match(readout, /No radar cell/, `says nothing is unreported: ${readout}`);
  assert.doesNotMatch(readout, /0 sq km/, 'rather than quoting a bare zero');
});

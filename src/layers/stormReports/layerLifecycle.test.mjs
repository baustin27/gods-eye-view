import assert from 'node:assert/strict';
import test from 'node:test';

import { gridCell } from '../../data/stormCrossReference.js';
import {
  HAIL_FLOOR_IN,
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
    camera: {
      __flownTo: null,
      flyTo(options) {
        this.__flownTo = options;
        return options;
      },
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

function makeLayer(rows, events = [], options = {}) {
  const source = {
    getSnapshot: async () => ({
      years: options.years || ['2026'],
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
  const layer = createStormReportsLayer({
    source,
    overlayHost,
    radarSource: options.radarSource,
  });
  layer._testReports = rows;
  layer._testEvents = events;
  return { layer, overlayHost };
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
  const { layer, overlayHost } = makeLayer(rows, events, {
    years: options.singleYear ? ['2026'] : ['2025', '2026'],
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
  const cells = new Map([
    [cellKey(35.11, -97.4), { mx: 45, cores: 12 }],
    [cellKey(36.9, -98.1), { mx: 60, cores: 3 }],
  ]);
  const asked = [];
  const radarSource = {
    cellsFor: async (years) => {
      asked.push(years);
      return { cells };
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
  assert.deepEqual(asked, [['2026']], 'asked for the years in the window');
  const info = layer.getRowControls().info;
  assert.match(info, /1 unreported radar core,/);
  assert.match(info, /1 confirmed/);
  assert.match(
    info,
    /estimate, not a measured stone/,
    'radar hail is never read as a measured stone',
  );
});

test('a radar source may hand back the builder GeoJSONL', async () => {
  const rows = [REPORT(2, { lat: 35.11 })];
  const line = (i, j, mx) =>
    JSON.stringify({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { i, j, d: 0.25, mx, cp: 5, dy: 1 },
    });
  const radarSource = {
    cellsFor: async () => ({
      cells: [line(140, -390, 45), line(200, -384, 60)].join('\n'),
    }),
  };
  const { layer } = makeLayer(rows, [], { radarSource });
  layer.init(stubViewer());
  layer.enable();
  await layer.update();
  layer.setDate('2026-08-10');
  const split = await settled(layer);
  assert.equal(split.both, 1, 'the text form indexes onto the same grid keys');
  assert.equal(split.radarOnly, 1);
});

test('the comparison stays off a window wider than one day', async () => {
  const cells = new Map([[cellKey(35.11, -97.4), { mx: 45, cores: 12 }]]);
  const radarSource = { cellsFor: async () => ({ cells }) };
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
      cellsFor: async () => {
        throw new Error('radar file missing');
      },
    };
    const { layer, overlayHost } = makeLayer([REPORT(2)], [], { radarSource });
    layer.init(stubViewer());
    layer.enable();
    assert.equal(await layer.update(), true, 'the layer still rendered');
    layer.setDate('2026-08-10');
    assert.equal(await settled(layer), null);
    assert.equal(layer.getComparison(), null);
    assert.match(layer.getRowControls().info, /1 report\b/);
    assert.equal(
      overlayHost.entries.at(-1).list.length,
      1,
      'cards still there',
    );
  } finally {
    console.warn = warn;
  }
});

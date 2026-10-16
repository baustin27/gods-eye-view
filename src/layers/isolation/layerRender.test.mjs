// Isolation mode: the layer's rendering and lifecycle, against a stub that can
// fail.
//
// THE STUB IS THE POINT. Every layer in this repo has shipped a defect no test
// caught because the test stubbed the broken thing. So this stub has three
// deliberate teeth, and the first test below proves each one bites:
//
//   1. `viewer.entities.add` is COUNTED. The layer must never write there — the
//      shared collection is emptied by whichever layer rendered last, and a scrim
//      that vanishes on the next repaint reads as "isolation stopped working".
//   2. `viewer.dataSources` is a real registry, so `destroy` can be checked to
//      actually remove what `init` added.
//   3. `camera.flyTo` records its options, so a frame that flies to the wrong
//      place or with a NaN duration fails here.
//
// Real Cesium is used for `CustomDataSource`, `Entity` and `Rectangle` — they
// construct cleanly under node and it is the geometry that has to be right.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as Cesium from 'cesium';

import { createIsolationLayer, ISOLATION_LAYER_ID } from './index.js';
import { framingForBoxes } from './model.js';

// A state, with the geometry a real boundary carries. Without polygons
// `describeIsolation` calls it approximate, which is correct for a place and
// wrong for a state — so the fixture has them.
const TEXAS = {
  kind: 'state',
  name: 'Texas',
  region: 'United States',
  bbox: [-106.6, 25.8, -93.5, 36.5],
  polygons: [
    [
      [-106.6, 25.8],
      [-93.5, 25.8],
      [-93.5, 36.5],
      [-106.6, 36.5],
      [-106.6, 25.8],
    ],
  ],
};
/** A city: a point with a radius, and no boundary anywhere in the data. */
const AUSTIN = {
  kind: 'place',
  name: 'Austin',
  bbox: [-97.9931, 30.0172, -97.4931, 30.5172],
};
const UNITED_STATES = {
  kind: 'country',
  name: 'United States of America',
  bbox: [-187.5, 18.9, -67.0, 71.4],
};

/**
 * A viewer with the two seams a layer actually uses, plus the shared entity
 * collection this layer is forbidden to touch.
 */
function stubViewer() {
  const sources = [];
  const shared = { added: 0 };
  return {
    __shared: shared,
    __sources: sources,
    dataSources: {
      add(source) {
        sources.push(source);
        return source;
      },
      remove(source) {
        const index = sources.indexOf(source);
        if (index >= 0) sources.splice(index, 1);
        return index >= 0;
      },
    },
    entities: {
      add() {
        shared.added += 1;
        return undefined;
      },
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
  };
}

/** A recording overlay host that rejects anything but an array of entries. */
function recordingHost() {
  const entries = [];
  const visible = [];
  return {
    entries,
    visible,
    setEntries(id, list, options) {
      if (!Array.isArray(list))
        throw new TypeError('overlay entries must be an array');
      entries.push({ id, list, options });
    },
    setVisible(id, on) {
      visible.push({ id, on });
    },
    clearSource(id) {
      for (let index = entries.length - 1; index >= 0; index -= 1)
        if (entries[index].id === id) entries.splice(index, 1);
    },
    last(id) {
      return entries.filter((entry) => entry.id === id).at(-1)?.list ?? [];
    },
  };
}

function setup({ host = recordingHost(), viewer = stubViewer() } = {}) {
  const layer = createIsolationLayer({ overlayHost: host });
  return { layer, host, viewer };
}

/** Entities the layer currently holds on its OWN data source. */
function drawn(viewer) {
  return viewer.__sources.flatMap((source) => source.entities.values ?? []);
}

const scrims = (viewer) =>
  drawn(viewer).filter((entity) => entity.id.startsWith('isolation-scrim:'));
const boxes = (viewer) =>
  drawn(viewer).filter((entity) => entity.id.startsWith('isolation-box:'));

/**
 * Rectangle degrees, read back off a Cesium `Rectangle`.
 *
 * An Entity stores `rectangle` as a `RectangleGraphics`, so the shape lives
 * inside the `coordinates` ConstantProperty — the same trap the outline tests in
 * the storm layer were bitten by.
 */
function rectOf(entity) {
  const rectangle = entity.rectangle.coordinates.getValue();
  assert.ok(rectangle, `${entity.id} has a Rectangle, not an absent shape`);
  // Rounded: degrees through radians and back is float arithmetic, and
  // -93.49999999999999 is -93.5.
  return [rectangle.west, rectangle.south, rectangle.east, rectangle.north].map(
    (radians) => Number(((radians * 180) / Math.PI).toFixed(6)),
  );
}

/** A ConstantProperty-wrapped graphics field, read through. */
const value = (property) =>
  property && typeof property.getValue === 'function'
    ? property.getValue()
    : property;

const coversRect = ([west, south, east, north], rect) =>
  west <= rect[0] + 1e-9 &&
  south <= rect[1] + 1e-9 &&
  east >= rect[2] - 1e-9 &&
  north >= rect[3] - 1e-9;

const coversPoint = ([west, south, east, north], lat, lon) =>
  lat >= south && lat <= north && lon >= west && lon <= east;

// ---------------------------------------------------------------------------

test('the stub would catch a layer writing to viewer.entities', () => {
  // If this test ever stops throwing, every `__shared.added === 0` assertion
  // below has become decoration.
  const viewer = stubViewer();
  assert.equal(viewer.__shared.added, 0);
  viewer.entities.add({ id: 'leaked' });
  assert.equal(viewer.__shared.added, 1, 'the stub counts shared writes');
  // And the data source registry is real enough for destroy to be checked.
  const { layer } = setup({ viewer });
  layer.init(viewer);
  assert.equal(viewer.__sources.length, 1);
  layer.destroy();
  assert.equal(viewer.__sources.length, 0, 'destroy removes what init added');
});

test('the layer speaks the lifecycle protocol the manager drives', () => {
  const { layer } = setup();
  for (const method of ['init', 'enable', 'disable', 'update', 'destroy'])
    assert.equal(typeof layer[method], 'function', `${method} must exist`);
  assert.equal(
    layer.setEnabled,
    undefined,
    'setEnabled is not the protocol and would silently do nothing',
  );
  assert.equal(layer.id, ISOLATION_LAYER_ID);
  assert.equal(typeof layer.name, 'string');
  assert.equal(typeof layer.icon, 'string');
  assert.equal(typeof layer.source, 'string');
  assert.equal(layer.updateInterval, 0, 'nothing here expires');
});

test('the first enable renders and reports the change', async () => {
  // The manager REJECTS an enable whose update returns false, and it does so
  // with a generic message. An isolation with nothing isolated yet is the state
  // every enable starts in, so this must be true with no area set.
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  assert.equal(
    await layer.update(),
    true,
    'the manager rejects a false return while enabling',
  );
  assert.equal(viewer.__sources.length, 1, 'one data source, added on init');
  assert.equal(drawn(viewer).length, 0, 'nothing to draw with no isolation');
});

test('update before enable does nothing and says so', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.setIsolation(TEXAS);
  assert.equal(
    await layer.update(),
    false,
    'a disabled layer does nothing, however much it has to draw',
  );
});

test('a second update with nothing changed reports no change', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(TEXAS);
  assert.equal(await layer.update(), true);
  assert.equal(await layer.update(), false);
});

test('entities land on the layer data source, never the shared collection', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(TEXAS);
  await layer.update();
  assert.equal(
    viewer.__shared.added,
    0,
    'never written into the shared entity collection',
  );
  assert.equal(viewer.__sources.length, 1);
  assert.equal(boxes(viewer).length, 1, 'one box for a mid-world isolation');
  assert.equal(scrims(viewer).length, 4, 'north, south, west of, east of');
});

test('the drawn box is the area bounding box, drawn to scale', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(TEXAS);
  await layer.update();
  const [entity] = boxes(viewer);
  assert.deepEqual(rectOf(entity), TEXAS.bbox);
  // The frame is a polyline, because Cesium silently drops
  // `rectangle.outline` on ground-clamped geometry and reports nothing. A
  // regression to `rectangle.outline` would draw nothing and pass a naive
  // "is there a rectangle" check, so this asserts the mechanism explicitly.
  const frame = value(entity.polyline);
  assert.ok(frame, 'the frame is drawn as a polyline');
  assert.equal(value(frame.width) > 0, true, 'a visible frame width');
  assert.ok(value(frame.material), 'a colour for the frame');
  assert.equal(value(frame.clampToGround), true, 'the frame follows terrain');
  // Five positions, and the fifth repeats the first: an unclosed frame draws
  // three sides of a box, which reads as a rendering fault.
  const positions = frame.positions.getValue
    ? frame.positions.getValue(0)
    : frame.positions;
  assert.equal(positions.length, 5, 'four corners plus the repeated first');
  for (const [i, p] of positions.entries()) {
    assert.ok(
      [p.x, p.y, p.z].every(Number.isFinite),
      `position ${i} is a real cartesian`,
    );
  }
  assert.deepEqual(
    [positions[4].x, positions[4].y, positions[4].z],
    [positions[0].x, positions[0].y, positions[0].z],
    'the frame closes',
  );
  assert.ok(
    Number.isFinite(value(entity.rectangle.material).color.alpha),
    'a translucent fill, not an opaque one',
  );
  assert.equal(entity.properties.isolation.getValue(), true);
});

test('a split isolation draws both boxes and leaves the seam lit', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(UNITED_STATES);
  await layer.update();
  assert.equal(viewer.__shared.added, 0);
  assert.equal(boxes(viewer).length, 2, 'the Aleutians and the mainland');
  const scrim = scrims(viewer).map(rectOf);
  assert.equal(scrim.length, 3, 'the complement of the PAIR, not of each box');
  for (const lat of [20, 52, 70]) {
    assert.ok(
      !scrim.some((rect) => coversPoint(rect, lat, 175)),
      `the Aleutian sliver at ${lat}N 175E must stay lit`,
    );
    assert.ok(
      !scrim.some((rect) => coversPoint(rect, lat, -179)),
      `the seam at ${lat}N 179W must stay lit`,
    );
    assert.ok(
      scrim.some((rect) => coversPoint(rect, lat, 100)),
      `the mid-Pacific at ${lat}N 100E must be dimmed`,
    );
  }
  // And the box that is drawn really is where the filter says the area is.
  assert.deepEqual(
    boxes(viewer)
      .map(rectOf)
      .sort((a, b) => a[0] - b[0]),
    [
      [-180, 18.9, -67.0, 71.4],
      [172.5, 18.9, 180, 71.4],
    ],
  );
});

test('the scrim is dark, translucent, and clamped to the ground', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(TEXAS);
  await layer.update();
  const [entity] = scrims(viewer);
  assert.equal(entity.position, undefined, 'a rectangle, not a point entity');
  assert.equal(
    value(entity.rectangle.heightReference),
    Cesium.HeightReference.CLAMP_TO_GROUND,
    'clamped to the ground, so the imagery is dimmed rather than covered',
  );
  const colour = value(entity.rectangle.material).color;
  assert.ok(colour, 'a material, or the scrim dims nothing');
  assert.ok(colour.alpha > 0 && colour.alpha < 1, `alpha ${colour.alpha}`);
  // Dark, so the rest of the world recedes rather than turning grey.
  assert.ok(
    colour.red + colour.green + colour.blue < 0.5,
    'a dark scrim, not a grey one',
  );
});

test('DIM off keeps the box and drops the scrim', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(TEXAS);
  await layer.update();
  assert.equal(scrims(viewer).length, 4);
  assert.equal(layer.isDimmed(), true);
  assert.equal(layer.setDimmed(false), false);
  assert.equal(scrims(viewer).length, 0, 'the scrim is gone');
  assert.equal(boxes(viewer).length, 1, 'the box stays');
  assert.equal(layer.setDimmed(true), true);
  assert.equal(scrims(viewer).length, 4);
  assert.equal(
    layer.setDimmed(true),
    true,
    'setting the same value is a no-op',
  );
});

test('setIsolation before init is safe and draws when init arrives', () => {
  // The caller that resolves a name may hand the layer its area before the
  // manager has finished constructing the catalog.
  const viewer = stubViewer();
  const { layer } = setup({ viewer });
  assert.equal(layer.getIsolation(), null);
  assert.equal(layer.setIsolation(TEXAS), true);
  assert.equal(layer.getIsolation(), TEXAS);
  assert.deepEqual(layer.getBoxes(), [TEXAS.bbox]);
  assert.equal(drawn(viewer).length, 0, 'no data source yet, so nothing drawn');
  layer.init(viewer);
  assert.equal(drawn(viewer).length, 5, '4 scrim + 1 box, drawn on init');
  assert.equal(viewer.__shared.added, 0);
});

test('setIsolation before init does not throw for a bare or missing area', () => {
  const viewer = stubViewer();
  const { layer } = setup({ viewer });
  for (const value of [null, undefined, 42, 'Texas', {}, { bbox: [] }]) {
    assert.doesNotThrow(() => layer.setIsolation(value));
    assert.equal(layer.getIsolation(), null, `${String(value)} is not an area`);
  }
  assert.equal(layer.setIsolation(TEXAS), true);
  assert.equal(
    layer.setIsolation(TEXAS),
    false,
    'the same area is not a change',
  );
});

test('an area with no usable geometry clears rather than dimming the world', async () => {
  // A place with no position, an empty result, a malformed bbox. Dimming
  // everything outside nothing would black out the globe and read as a fault.
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(TEXAS);
  await layer.update();
  assert.equal(drawn(viewer).length, 5);
  for (const area of [
    null,
    {},
    { bbox: [] },
    { bbox: [Number.NaN, 0, 1, 1] },
  ]) {
    layer.setIsolation(area);
    assert.equal(layer.getIsolation(), null);
    assert.deepEqual(layer.getBoxes(), []);
    assert.equal(drawn(viewer).length, 0, 'nothing left on the map');
    assert.equal(layer.getScrimRectangles().length, 0);
    assert.equal(
      viewer.__shared.added,
      0,
      'clearing must not write to the shared collection either',
    );
  }
  // Still a valid on-state, so a cleared isolation does not fail an enable.
  layer.setIsolation(TEXAS);
  assert.equal(await layer.update(), true);
});

test('a second init is refused rather than leaking a data source', () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  assert.throws(() => layer.init(viewer), /already initialized/);
  assert.equal(viewer.__sources.length, 1);
});

test('disabling empties the map and re-enabling puts the box back', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(TEXAS);
  await layer.update();
  layer.disable();
  assert.equal(drawn(viewer).length, 0, 'the scrim does not linger while off');
  assert.equal(viewer.__sources[0].show, false, 'its data source is hidden');
  // Isolation is a person's choice, not loaded data: disabling the mode does not
  // forget what they picked.
  assert.equal(layer.getIsolation(), TEXAS);
  assert.equal(await layer.update(), false);
  layer.enable();
  assert.equal(viewer.__sources[0].show, true);
  assert.equal(await layer.update(), true, 're-enabling draws again');
  assert.equal(drawn(viewer).length, 5);
  assert.equal(layer.setIsolation(null), true, 'the box can still be dropped');
});

test('destroy removes the data source and forgets the viewer', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(TEXAS);
  await layer.update();
  layer.destroy();
  assert.equal(viewer.__sources.length, 0, 'the data source is gone');
  assert.equal(viewer.__shared.added, 0);
  assert.equal(layer.getIsolation(), null);
  assert.equal(layer.frameIsolation(), false, 'no camera to move');
  // And a destroy with no init at all must not throw.
  const other = setup().layer;
  assert.doesNotThrow(() => other.destroy());
});

test('frameIsolation flies to the framed box and refuses nothing', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  assert.equal(layer.frameIsolation(), false, 'no isolation, no move');
  assert.equal(viewer.camera.__flownTo, null);
  layer.setIsolation(TEXAS);
  await layer.update();
  assert.equal(layer.frameIsolation(3), true);
  const flight = viewer.camera.__flownTo;
  assert.ok(flight, 'the camera was flown');
  assert.equal(flight.duration, 3);
  assert.ok(Number.isFinite(flight.destination.x), 'a finite destination');
  assert.ok(Number.isFinite(flight.destination.y));
  assert.ok(Number.isFinite(flight.destination.z));
  assert.deepEqual(flight.orientation, {
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  });
  const framed = framingForBoxes(layer.getBoxes());
  assert.ok(
    flight.destination instanceof Cesium.Cartesian3,
    'a Cartesian3, which is what flyTo takes',
  );
  assert.ok(
    flight.destination.equals(
      Cesium.Cartesian3.fromDegrees(framed.lon, framed.lat, framed.altitudeM),
    ),
    'the destination is the framing the model computed, not a guess',
  );
  assert.ok(layer.getFraming());
  assert.equal(layer.getFraming().lat, framed.lat);
  assert.equal(layer.getFraming().altitudeM, framed.altitudeM);
});

test('a frame duration a panel chip made up cannot take the camera down', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(TEXAS);
  await layer.update();
  for (const duration of [Number.NaN, -1, 1e9, 'two']) {
    assert.equal(layer.frameIsolation(duration), true, `duration ${duration}`);
    assert.ok(Number.isFinite(viewer.camera.__flownTo.duration));
    assert.ok(viewer.camera.__flownTo.duration >= 0);
    assert.ok(viewer.camera.__flownTo.duration <= 10);
  }
  assert.equal(layer.frameIsolation(), true, 'no duration means the default');
  assert.equal(viewer.camera.__flownTo.duration, 2);
});

test('a split isolation frames its mainland and says so in the row', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(UNITED_STATES);
  await layer.update();
  assert.equal(layer.frameIsolation(), true);
  const frame = framingForBoxes(layer.getBoxes());
  assert.equal(frame.index, 1, 'the mainland, not the Aleutians');
  const controls = layer.getRowControls();
  assert.match(controls.info, /antimeridian/);
  assert.match(controls.info, /United States/);
  assert.match(controls.legend[0].title, /not its boundary/);
});

test('the row controls are the panel shape, not a bare array', () => {
  // The panel reads `controls.chips` and `controls.legend`. Returning an array
  // means every control is silently discarded and the row renders empty.
  const { layer } = setup();
  const controls = layer.getRowControls();
  assert.ok(!Array.isArray(controls));
  assert.equal(typeof controls.info, 'string');
  assert.ok(Array.isArray(controls.chips));
  assert.ok(Array.isArray(controls.legend));
  assert.ok(
    !controls.readout,
    'a truthy readout hides the chips and shows a count instead',
  );
  // With nothing isolated every action is disabled, and the line says so.
  assert.ok(controls.chips.every((chip) => chip.disabled));
  assert.match(controls.info, /No isolation/);
});

test('the row controls re-read the layer state, and the listener is told', () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(TEXAS);
  const chips = new Map(layer.getRowControls().chips.map((c) => [c.id, c]));
  assert.equal(chips.get('isolation-frame').disabled, false);
  assert.equal(chips.get('isolation-clear').disabled, false);
  assert.equal(chips.get('isolation-dim').active, true);

  let repaints = 0;
  layer.setRowControlsListener(() => {
    repaints += 1;
  });
  // The chips act on the layer through the same API the panel drives.
  chips.get('isolation-frame').onClick();
  assert.ok(viewer.camera.__flownTo, 'FRAME moves the camera');
  chips.get('isolation-dim').onClick();
  assert.equal(layer.isDimmed(), false);
  assert.equal(scrims(viewer).length, 0);
  chips.get('isolation-clear').onClick();
  assert.equal(layer.getIsolation(), null);
  assert.equal(drawn(viewer).length, 0);
  assert.ok(repaints > 0, 'the row is told to re-read its controls');
  // A listener of the wrong shape is dropped rather than called.
  layer.setRowControlsListener('nope');
  assert.doesNotThrow(() => layer.setDimmed(true));
});

test('getBoxes hands out a copy, so a caller cannot corrupt the layer', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(TEXAS);
  await layer.update();
  const boxes1 = layer.getBoxes();
  boxes1[0][0] = 42;
  assert.deepEqual(layer.getBoxes(), [TEXAS.bbox]);
  const scrim = layer.getScrimRectangles();
  scrim[0][0] = 42;
  assert.notEqual(layer.getScrimRectangles()[0][0], 42);
});

test('the overlay label is published, and cleared with the isolation', () => {
  const host = recordingHost();
  const viewer = stubViewer();
  const { layer } = setup({ host, viewer });
  layer.init(viewer);
  assert.deepEqual(host.last(ISOLATION_LAYER_ID), [], 'nothing to label yet');
  layer.enable();
  layer.setIsolation(TEXAS);
  const entries = host.last(ISOLATION_LAYER_ID);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'isolation-area');
  assert.equal(entries[0].title, 'Texas, United States');
  assert.ok(entries[0].details.includes('Bounding box, not a boundary'));
  assert.ok(Number.isFinite(entries[0].position.x));
  layer.setIsolation(null);
  assert.deepEqual(host.last(ISOLATION_LAYER_ID), []);
});

test('a place is labelled as a point with a radius, in its own words', () => {
  // The single most important honesty claim on this layer: a city drawn as a box
  // is not a city boundary, and the label must say so rather than let the shape
  // speak for itself. It has to appear everywhere the name does — the panel row,
  // the stats, and the card on the globe — because each is read on its own.
  const host = recordingHost();
  const viewer = stubViewer();
  const { layer } = setup({ host, viewer });
  layer.init(viewer);
  layer.enable();
  layer.setIsolation(AUSTIN);
  const caveats = /approximate: point with a radius, no boundary data/;
  assert.match(layer.getRowControls().info, caveats);
  assert.match(layer.getStats().label, caveats);
  assert.match(host.last(ISOLATION_LAYER_ID)[0].title, caveats);
  // It is still drawn — an approximate box beats no isolation at all.
  assert.equal(boxes(viewer).length, 1);
  assert.equal(layer.getRowControls().info.includes('Austin'), true);
});

test('the layer is complete without an overlay host', () => {
  // An optional dependency that throws for its absence is a hard one.
  const viewer = stubViewer();
  const layer = createIsolationLayer();
  assert.doesNotThrow(() => layer.init(viewer));
  assert.doesNotThrow(() => layer.enable());
  assert.doesNotThrow(() => layer.setIsolation(UNITED_STATES));
  assert.doesNotThrow(() => layer.frameIsolation());
  assert.equal(drawn(viewer).length, 5);
  assert.equal(layer.getStats().scrimRectangles, 3);
  assert.doesNotThrow(() => layer.destroy());
});

test('getStats describes the on-screen state', async () => {
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  assert.equal(layer.getStats().isolated, false);
  layer.setIsolation(UNITED_STATES);
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.enabled, true);
  assert.equal(stats.isolated, true);
  assert.equal(stats.boxes, 2);
  assert.equal(stats.scrimRectangles, 3);
  assert.equal(stats.dimmed, true);
  assert.match(stats.label, /United States/);
  assert.ok(Number.isFinite(stats.lastUpdate));
});

test('every scrim rectangle the layer draws contains no part of the isolation', async () => {
  // The layer must not be able to draw a scrim that overlaps its own box, which
  // is what a per-box complement would do to the Aleutians.
  const { layer, viewer } = setup();
  layer.init(viewer);
  layer.enable();
  for (const area of [TEXAS, UNITED_STATES]) {
    layer.setIsolation(area);
    await layer.update();
    const drawnBoxes = boxes(viewer).map(rectOf);
    const drawnScrim = scrims(viewer).map(rectOf);
    for (const box of drawnBoxes)
      for (const rect of drawnScrim)
        assert.equal(
          coversRect(box, rect),
          false,
          `scrim ${rect} overlaps isolation box ${box}`,
        );
  }
});

test('SHARE: a share link carries the area as the text it was named by', async () => {
  test('SHARE: a named area round-trips through getParams/setParams', async () => {
    const layer = createIsolationLayer();
    layer.init(stubViewer());
    const first = await layer.setIsolationText('Texas');
    assert.equal(first.ok, true);

    // The link carries a name, never a polygon.
    assert.deepEqual(layer.getParams(), { area: 'Texas' });

    // A link handed to a fresh layer resolves to the same boxes.
    const opened = createIsolationLayer();
    opened.init(stubViewer());
    opened.setParams({ area: 'Texas' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened.getBoxes(), layer.getBoxes());
  });

  test('SHARE: an unknown name is reported and leaves the current isolation alone', async () => {
    const layer = createIsolationLayer();
    layer.init(stubViewer());
    await layer.setIsolationText('Texas');
    const before = layer.getBoxes();

    const miss = await layer.setIsolationText('qqqzzz nowhere at all');
    assert.equal(miss.ok, false);
    assert.ok(miss.reason, 'a miss must carry a reason the panel can show');
    // Not a throw, and not a silent clear.
    assert.deepEqual(layer.getBoxes(), before);
  });

  test('SHARE: clearing the isolation clears the name a link would read', async () => {
    const layer = createIsolationLayer();
    layer.init(stubViewer());
    await layer.setIsolationText('Texas');
    layer.clearIsolation();
    assert.deepEqual(layer.getParams(), {});
    assert.equal(layer.getIsolationText(), null);
  });

  test('SHARE: a link that arrives before the scene resolves on init', async () => {
    const layer = createIsolationLayer();
    // No init() yet — this is the order a share link takes.
    layer.setParams({ area: 'Texas' });
    assert.deepEqual(
      layer.getParams(),
      {},
      'not resolved yet, so not encoded yet',
    );

    layer.init(stubViewer());
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      layer.getBoxes().length,
      'the pending area resolved once the scene existed',
    );
    assert.deepEqual(layer.getParams(), { area: 'Texas' });
  });
});

test('a rejected name is reported in the panel and the next good name clears it', async () => {
  const layer = createIsolationLayer();
  layer.init(stubViewer());

  // A miss leaves the info line saying so, rather than the ordinary
  // "no isolation" text that would hide the fact nothing happened.
  const miss = await layer.getRowControls().field.onCommit('qqqzzz nowhere');
  assert.equal(miss.ok, false);
  assert.match(layer.getRowControls().info, /Could not find "qqqzzz nowhere"/);

  // A hit must not leave the previous rejection sitting on screen.
  const hit = await layer.getRowControls().field.onCommit('Texas');
  assert.equal(hit.ok, true);
  assert.doesNotMatch(layer.getRowControls().info, /Could not find/);
  assert.match(layer.getRowControls().info, /Texas/);
});

test('the area field is the only way to start an isolation, and the chips wait for it', async () => {
  const layer = createIsolationLayer();
  layer.init(stubViewer());
  const before = layer.getRowControls();
  assert.ok(
    before.field,
    'without a field the row offers no way to name an area',
  );
  // Every chip is inert with no area: they are controls ON an isolation, not
  // ways to create one.
  for (const chip of before.chips) assert.equal(chip.disabled, true, chip.id);

  await layer.getRowControls().field.onCommit('Texas');
  const after = layer.getRowControls();
  assert.equal(
    after.chips.find((c) => c.id === 'isolation-clear').disabled,
    false,
  );
  assert.equal(
    after.chips.find((c) => c.id === 'isolation-frame').disabled,
    false,
  );
  // The field keeps the name, so the panel shows what the person typed.
  assert.equal(after.field.value, 'Texas');
});

describe_area_wiring: {
  // A listener that subscribes is told the current area immediately, so it
  // never has to ask separately and cannot miss an area set before it arrived.
  test('a subscriber is told the current area on subscribe', async () => {
    const layer = createIsolationLayer();
    layer.init(stubViewer());
    const seen = [];
    layer.onAreaChange((area) => seen.push(area));
    assert.equal(seen.length, 1);
    assert.equal(seen[0], null, 'no area yet');
  });

  test('subscribers hear about a change and not about a repeat', async () => {
    const layer = createIsolationLayer();
    layer.init(stubViewer());
    const seen = [];
    layer.onAreaChange((area) => seen.push(area?.kind ?? null));

    await layer.setIsolationText('Texas');
    assert.deepEqual(seen, [null, 'state']);
    // The same area again must not re-filter a layer with 44,717 rows behind it.
    await layer.setIsolationText('Texas');
    assert.equal(seen.length, 2, 'a repeat is not a change');
  });

  test('one throwing subscriber does not stop the others or the isolation', async () => {
    const layer = createIsolationLayer();
    layer.init(stubViewer());
    const seen = [];
    layer.onAreaChange(() => {
      throw new Error('subscriber is broken');
    });
    layer.onAreaChange((area) => seen.push(area));
    const changed = await layer.setIsolationText('Texas');
    assert.equal(changed.ok, true);
    assert.equal(
      seen[0],
      null,
      'the healthy subscriber saw the empty area first',
    );
    assert.equal(seen.length, 2, 'and still heard the change');
    assert.equal(
      seen[1],
      layer.getIsolation(),
      'with the very area the layer holds',
    );
    assert.ok(layer.getBoxes().length, 'the dimming still exists');
  });

  test('unsubscribing stops the notifications, and destroy drops every subscriber', async () => {
    const layer = createIsolationLayer();
    layer.init(stubViewer());
    let count = 0;
    const off = layer.onAreaChange(() => {
      count += 1;
    });
    await layer.setIsolationText('Texas');
    const afterFirst = count;
    off();
    await layer.setIsolationText('California');
    assert.equal(count, afterFirst, 'an unsubscribed listener stays quiet');

    let afterDestroy = 0;
    layer.onAreaChange(() => {
      afterDestroy += 1;
    });
    const before = afterDestroy;
    layer.destroy();
    // A destroyed isolation must not push a final "no isolation" into layers
    // that have outlived it.
    assert.equal(afterDestroy, before, 'destroy notifies nobody');
    assert.equal(layer.getIsolation(), null, 'and keeps no area');
  });
}

test('blurring the field does not destroy a live isolation', async () => {
  const layer = createIsolationLayer();
  layer.init(stubViewer());
  await layer.setIsolationText('Denver');
  const boxes = layer.getBoxes();
  assert.ok(boxes.length, 'set up: an isolation exists');

  // The panel commits on blur. A blur is what clicking a chip does, so an empty
  // commit arriving right after a good one must not read as "clear".
  const result = await layer.getRowControls().field.onCommit('');
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true, 'nothing was asked for');
  assert.deepEqual(layer.getBoxes(), boxes, 'the isolation survived the blur');
  assert.equal(layer.getIsolation().name, 'Denver');

  // Clearing is still possible, and still explicit.
  layer.clearIsolation();
  assert.equal(layer.getIsolation(), null);
});

/**
 * A stand-in for the real layer-state manager, tracking only what SOLO uses.
 * `programmatic` is the load-bearing part: `isExplicitLayerStateOrigin` persists
 * only `user`, `voice` and `tool`, so anything else cannot overwrite the layer
 * set the person actually chose.
 */
function fakeManager(enabled) {
  const state = new Set(enabled);
  const calls = [];
  return {
    calls,
    state,
    getEnabledLayerIds: () => new Set(state),
    async clearSelectedLayers({ origin } = {}) {
      calls.push(['clear', origin]);
      const cleared = [...state];
      for (const id of cleared) state.delete(id);
      return { targetIds: cleared, clearedIds: cleared, notClearedIds: [] };
    },
    async setEnabled(id, on, { origin } = {}) {
      calls.push(['set', id, on, origin]);
      if (on) state.add(id);
      else state.delete(id);
      return true;
    },
    // `restoreEnabledLayerIds` is AUTHORITATIVE in the real manager: it sets
    // every layer it does not exclude to `target.has(id)`. The fake has to
    // behave the same way or it will happily pass a restore that switches the
    // lens off on the way back out.
    async restoreEnabledLayerIds(ids, { origin, excludeLayerIds } = {}) {
      calls.push(['restore', [...ids], origin]);
      const target = new Set(ids);
      const excluded = new Set(excludeLayerIds || []);
      for (const id of state.keys()) {
        if (excluded.has(id)) continue;
        if (target.has(id)) state.add(id);
        else state.delete(id);
      }
      for (const id of target) if (!excluded.has(id)) state.add(id);
      return true;
    },
  };
}

test('SOLO parks every other layer and puts them all back, programmatically', async () => {
  const m = fakeManager([
    'isolation',
    'storms',
    'traffic',
    'cctv',
    'satellites',
  ]);
  const layer = createIsolationLayer();
  layer.init(stubViewer());
  layer.attachDataManager(m);
  await layer.setIsolationText('Denver');

  const on = await layer.setSolo(true);
  assert.equal(on.ok, true);
  assert.equal(m.calls[0][1], 'programmatic', 'the clear is not persisted');
  assert.equal(layer.isSolo(), true);

  const off = await layer.setSolo(false);

  // Isolation is never parked: taking the lens off must not take away the
  // ability to take it off.
  const restoreCall = m.calls.find((c) => c[0] === 'restore');
  assert.ok(restoreCall, 'a snapshot was restored from');
  assert.equal(
    restoreCall[1].includes('isolation'),
    false,
    'isolation is not in its own snapshot',
  );
  assert.equal(off.ok, true);
  assert.equal(off.restored, 4, 'four layers came back');
  assert.equal(restoreCall[1].length, 4);
  for (const id of ['storms', 'traffic', 'cctv', 'satellites'])
    assert.equal(m.state.has(id), true, `${id} is back`);
  // The lens itself is excluded from the restore, not merely absent from the
  // snapshot: an authoritative restore would otherwise switch it OFF.
  assert.equal(
    m.state.has('isolation'),
    true,
    'isolation was not switched off',
  );
});

test('SOLO refuses to engage without a manager rather than pretending', async () => {
  const layer = createIsolationLayer();
  layer.init(stubViewer());
  await layer.setIsolationText('Denver');
  const result = await layer.setSolo(true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-manager');
  const solo = layer
    .getRowControls()
    .chips.find((c) => c.id === 'isolation-solo');
  assert.equal(solo.disabled, true, 'and the chip is inert, not misleading');
});

test('clearing the area releases SOLO, because parked layers are worse than SOLO', async () => {
  const manager = fakeManager(['isolation', 'storms', 'traffic']);
  const layer = createIsolationLayer();
  layer.init(stubViewer());
  layer.attachDataManager(manager);
  await layer.setIsolationText('Denver');
  await layer.setSolo(true);
  assert.equal(manager.state.has('traffic'), false, 'parked');

  layer.clearIsolation();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.state.has('traffic'), true, 'put back on the way out');
  assert.equal(manager.state.has('storms'), true);
  assert.equal(layer.isSolo(), false);
});

test('SOLO leaves the lens itself on, because the lens clears itself', async () => {
  const m = fakeManager(['isolation', 'storms', 'traffic', 'cctv']);
  const layer = createIsolationLayer();
  layer.init(stubViewer());
  layer.attachDataManager(m);
  await layer.setIsolationText('Denver');

  const result = await layer.setSolo(true);
  assert.equal(result.ok, true);
  // The guard used to be "if isolation was not cleared, re-enable it", which is
  // backwards: clearSelectedLayers takes everything including the caller, so
  // that branch never ran and the lens ended up the one light left off.
  assert.equal(
    m.state.has('isolation'),
    true,
    'isolation is still on - it is what turned the lights off',
  );
  assert.equal(m.state.has('traffic'), false, 'while the others are parked');
  assert.equal(result.off, 3, 'three parked, not counting isolation');
});

test('the same name committed twice resolves once, not twice', async () => {
  // Enter and blur BOTH commit. Two resolutions meant two fresh area objects,
  // two identity-changes, and two full re-filters of the storm layer's rows.
  const layer = createIsolationLayer();
  layer.init(stubViewer());
  const changes = [];
  layer.onAreaChange((area) => changes.push(area?.name ?? null));

  const [a, b] = await Promise.all([
    layer.setIsolationText('Denver'),
    layer.setIsolationText('Denver'),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.area, b.area, 'the second caller joined the first resolution');
  assert.deepEqual(changes, [null, 'Denver'], 'one change, announced once');
});

test('Escape cancels a resolution that has not landed yet', async () => {
  const layer = createIsolationLayer();
  layer.init(stubViewer());
  await layer.setIsolationText('Texas');

  const inFlight = layer.setIsolationText('California');
  // Escape before the promise settles.
  assert.equal(
    layer.cancelPendingIsolationText(),
    true,
    'something was cancelled',
  );
  const result = await inFlight;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'superseded');
  // The previous isolation is untouched: cancel is not clear.
  assert.equal(layer.getIsolation().name, 'Texas');
});

test('a newer commit supersedes an older one still in flight', async () => {
  const layer = createIsolationLayer();
  layer.init(stubViewer());
  const slow = layer.setIsolationText('California');
  const fast = await layer.setIsolationText('Denver');
  assert.equal(fast.area.name, 'Denver');
  assert.equal(
    (await slow).reason,
    'superseded',
    'the stale one applied nothing',
  );
  assert.equal(layer.getIsolation().name, 'Denver');
});

test('cancelling when nothing is in flight is a no-op, not a surprise', () => {
  const layer = createIsolationLayer();
  layer.init(stubViewer());
  assert.equal(layer.cancelPendingIsolationText(), false);
});

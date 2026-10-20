import assert from 'node:assert/strict';
import test from 'node:test';

import { subDailyFrameTimes } from '../../data/subDailyRadar.js';
import { createStormReportsLayer } from './index.js';

/**
 * The timeline: a day of hail split into six-hour frames.
 *
 * The daily field is a MAXIMUM over the day, so it says where the biggest
 * hail fell and nothing about when. The frames are the day's hail in pieces,
 * and they are what lets the storm be replayed.
 */

function stubViewer() {
  return {
    entities: { add: () => {}, removeAll: () => {}, values: [] },
    dataSources: { add: () => {}, removeAll: () => {} },
    camera: {
      moveEnd: { addEventListener: () => {} },
      position: { getValue: () => undefined },
      height: 400,
    },
    clock: { currentTime: { getValue: () => undefined } },
    scene: { globe: { show: true }, canvas: {} },
    screenSpaceEventHandler: { setInputAction: () => {} },
    dataSourceDisplay: {},
  };
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

/** A layer with a radar source that has frames for the day. */
function makeLayer(radarSource) {
  const layer = createStormReportsLayer({
    source: {
      getSnapshot: () => ({
        earliest: '2026-01-01',
        latest: '2026-08-10',
      }),
      reportsFor: async () => [],
      eventsFor: async () => [],
    },
    overlayHost: host(),
    radarSource,
    // Cesium's own input handler needs a DOM, and this test is about the
    // timeline rather than about picking.
    createInputHandler: () => ({
      setInputAction: () => {},
      destroy: () => {},
    }),
  });
  layer.init(stubViewer());
  layer.enable();
  return layer;
}

/** The frames of a day, as the loader returns them. */
function frameCells(...indices) {
  return indices.map((index) => ({ i: index, j: index, maxMm: 30 }));
}

test('a single-day window asks for the day frames', async () => {
  const asked = [];
  const radarSource = {
    daysFor: async () => new Map(),
    dayFor: async () => ({ cells: [] }),
    subDayFor: async (date) => {
      asked.push(date);
      return { frameCount: 4, frames: frameCells(1, 2, 3, 4) };
    },
  };
  const layer = makeLayer(radarSource);
  layer.setDate('2026-08-10');
  await layer.update();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(asked, ['2026-08-10'], 'the day was asked for once');
});

test('the frame chips carry the hours the frames end at', async () => {
  const radarSource = {
    daysFor: async () => new Map(),
    dayFor: async () => ({ cells: [] }),
    subDayFor: async () => ({ frameCount: 4, frames: frameCells(1, 2, 3, 4) }),
  };
  const layer = makeLayer(radarSource);
  layer.setDate('2026-08-10');
  await layer.update();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const chips = layer.getRowControls().chips || [];
  const frameChips = chips.filter((chip) =>
    /^storm-reports-frame-\d+$/.test(chip.id || ''),
  );
  assert.equal(frameChips.length, 4, 'four frame chips');
  assert.deepEqual(
    frameChips.map((chip) => chip.label),
    ['06Z', '12Z', '18Z', '00Z'],
    'the hours the frames end at, in order',
  );

  // The chip hours and the shard's own frame times must agree: the shard
  // holds the four frames that tile the same 24 hours the daily field covers.
  const hours = subDailyFrameTimes('2026-08-10').map((time) =>
    time.slice(11, 13),
  );
  assert.deepEqual(
    frameChips.map((chip) => chip.label.slice(0, 2)),
    hours,
    'the chips agree with the shard',
  );
});

test('a frame can be chosen and put back', async () => {
  const radarSource = {
    daysFor: async () => new Map(),
    dayFor: async () => ({ cells: [] }),
    subDayFor: async () => ({ frameCount: 4, frames: frameCells(1, 2, 3, 4) }),
  };
  const layer = makeLayer(radarSource);
  layer.setDate('2026-08-10');
  await layer.update();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(layer.setRadarFrame(1), true, 'frame 1 was selected');
  assert.equal(layer.setRadarFrame(1), false, 'selecting it again moved nothing');
  assert.equal(layer.setRadarFrame(99), false, 'a frame that is not there');
  assert.equal(layer.setRadarFrame(1.5), false, 'a frame that is not a whole one');
  assert.equal(layer.setRadarFrame(null), true, 'back to the whole day');
  assert.equal(layer.setRadarFrame(null), false, 'already the whole day');
});

test('a layer with no frames offers no timeline', async () => {
  const radarSource = {
    daysFor: async () => new Map(),
    dayFor: async () => ({ cells: [] }),
  };
  const layer = makeLayer(radarSource);
  layer.setDate('2026-08-10');
  await layer.update();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const chips = layer.getRowControls().chips || [];
  assert.equal(
    chips.filter((chip) => chip.id?.startsWith('storm-reports-frame-')).length,
    0,
    'no frame chips',
  );
  assert.equal(layer.setRadarFrame(0), false, 'and no frame can be chosen');
});

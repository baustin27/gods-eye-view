/**
 * apps/hail-desk/src/ui/stormTimeline.test.mjs
 *
 * Unit tests for the Hail Desk storm timeline histogram aggregation and
 * sub-daily radar scrubber module.
 *
 * Comments explain WHY: Hail timeline calculations feed directly into canvasser
 * territory planning and seasonal budgeting. If storm counts are misaggregated,
 * peak hail sizes underreported, or radar frames unable to progress cleanly,
 * users lose the ability to isolate severe weather events.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUBDAILY_FRAMES,
  SUBDAILY_FRAME_LABELS,
  nextSubdailyFrame,
  prevSubdailyFrame,
  aggregateStormsByMonth,
  formatMonthLabel,
  createTimelineModel,
} from './stormTimeline.js';

/* ======================================================================
 * SUBDAILY RADAR FRAMES & SCRUBBER PROGRESSION
 * ====================================================================== */

test('SUBDAILY_FRAMES exports the canonical 5 radar frames', () => {
  assert.deepEqual(SUBDAILY_FRAMES, ['DAY', '06Z', '12Z', '18Z', '00Z']);
  assert.ok(Object.isFrozen(SUBDAILY_FRAMES), 'frame list must be immutable');
});

test('SUBDAILY_FRAME_LABELS provides human-readable context for each frame', () => {
  for (const frame of SUBDAILY_FRAMES) {
    assert.ok(
      typeof SUBDAILY_FRAME_LABELS[frame] === 'string' && SUBDAILY_FRAME_LABELS[frame].length > 0,
      `missing label description for frame ${frame}`,
    );
  }
});

test('nextSubdailyFrame progresses linearly through standard frames', () => {
  assert.equal(nextSubdailyFrame('DAY'), '06Z');
  assert.equal(nextSubdailyFrame('06Z'), '12Z');
  assert.equal(nextSubdailyFrame('12Z'), '18Z');
  assert.equal(nextSubdailyFrame('18Z'), '00Z');
});

test('nextSubdailyFrame wraps circularly from the last frame back to DAY', () => {
  // Scrubber controls must wrap around rather than halting at boundary limits
  assert.equal(nextSubdailyFrame('00Z'), 'DAY');
});

test('nextSubdailyFrame handles lowercase and whitespace in frame keys', () => {
  assert.equal(nextSubdailyFrame('day'), '06Z');
  assert.equal(nextSubdailyFrame(' 18z '), '00Z');
});

test('nextSubdailyFrame safely defaults on null, undefined, or unrecognized frames', () => {
  // If no frame is selected (null/undefined in URL state), next frame should be '06Z'
  assert.equal(nextSubdailyFrame(null), '06Z');
  assert.equal(nextSubdailyFrame(undefined), '06Z');
  assert.equal(nextSubdailyFrame(''), '06Z');

  // Completely invalid strings fall back to the safe baseline 'DAY'
  assert.equal(nextSubdailyFrame('INVALID_FRAME'), 'DAY');
});

test('prevSubdailyFrame steps backwards circularly', () => {
  assert.equal(prevSubdailyFrame('DAY'), '00Z');
  assert.equal(prevSubdailyFrame('00Z'), '18Z');
  assert.equal(prevSubdailyFrame('18Z'), '12Z');
  assert.equal(prevSubdailyFrame('12Z'), '06Z');
  assert.equal(prevSubdailyFrame('06Z'), 'DAY');
});

/* ======================================================================
 * MONTHLY STORM AGGREGATION
 * ====================================================================== */

test('aggregateStormsByMonth returns empty array for empty or invalid inputs', () => {
  assert.deepEqual(aggregateStormsByMonth([]), []);
  assert.deepEqual(aggregateStormsByMonth(null), []);
  assert.deepEqual(aggregateStormsByMonth(undefined), []);
  assert.deepEqual(aggregateStormsByMonth('not-an-array'), []);
});

test('aggregateStormsByMonth correctly aggregates single month with multiple storms', () => {
  const storms = [
    { d: '2024-06-01', houses: 1200, maxHail: 1.5 },
    { d: '2024-06-15', houses: 3400, maxHail: 2.75 },
    { d: '2024-06-28', houses: 800, maxHail: 1.0 },
  ];

  const summaries = aggregateStormsByMonth(storms);
  assert.equal(summaries.length, 1);

  const june = summaries[0];
  // Verify strict enumerable shape
  assert.deepEqual(june, {
    month: '2024-06',
    count: 3,
    houses: 5400, // 1200 + 3400 + 800
    maxHail: 2.75, // peak preserved from 2024-06-15
  });

  // Verify non-enumerable convenience aliases
  assert.equal(june.stormCount, 3);
  assert.equal(june.totalHouses, 5400);
  assert.equal(june.peakHail, 2.75);
});

test('aggregateStormsByMonth preserves peak hailstone size even on small-footprint storms', () => {
  // A localized supercell with massive 4.0" hail over 50 houses must retain its
  // 4.0" peak, even when followed by a widespread 1.25" storm touching 20,000 houses.
  const storms = [
    { d: '2023-05-10', houses: 50, maxHail: 4.0 },
    { d: '2023-05-22', houses: 20000, maxHail: 1.25 },
  ];

  const [may] = aggregateStormsByMonth(storms);
  assert.equal(may.month, '2023-05');
  assert.equal(may.count, 2);
  assert.equal(may.houses, 20050);
  assert.equal(may.maxHail, 4.0, 'must preserve highest recorded hailstone size');
});

test('aggregateStormsByMonth outputs sorted chronological array across years', () => {
  // Input in deliberately jumbled chronological order
  const storms = [
    { d: '2024-07-04', houses: 500, maxHail: 1.75 },
    { d: '2022-05-19', houses: 1200, maxHail: 2.0 },
    { d: '2023-06-12', houses: 8000, maxHail: 2.5 },
    { d: '2022-05-20', houses: 300, maxHail: 1.25 },
    { d: '2024-04-10', houses: 1500, maxHail: 1.5 },
  ];

  const summaries = aggregateStormsByMonth(storms);
  const months = summaries.map((s) => s.month);

  // Must be strictly chronological ascending
  assert.deepEqual(months, ['2022-05', '2023-06', '2024-04', '2024-07']);

  // Check 2022-05 combined
  const may2022 = summaries[0];
  assert.equal(may2022.month, '2022-05');
  assert.equal(may2022.count, 2);
  assert.equal(may2022.houses, 1500);
  assert.equal(may2022.maxHail, 2.0);
});

test('aggregateStormsByMonth accepts alternative date and metric field names', () => {
  // In desk data models, rows might carry 'date' instead of 'd', or 'units'/'largest'
  const storms = [
    { date: '2024-08-01', housesInReach: 900, peakHail: 2.25 },
    { day: '2024-08-15', units: 1100, largest: 1.75 },
  ];

  const [august] = aggregateStormsByMonth(storms);
  assert.equal(august.month, '2024-08');
  assert.equal(august.count, 2);
  assert.equal(august.houses, 2000);
  assert.equal(august.maxHail, 2.25);
});

test('aggregateStormsByMonth handles null, missing, or negative values safely', () => {
  const storms = [
    { d: '2024-09-01', houses: null, maxHail: null },
    { d: '2024-09-10', houses: undefined, maxHail: undefined },
    { d: '2024-09-20', houses: -50, maxHail: -1 },
    { d: '2024-09-25', houses: 100, maxHail: 1.25 },
  ];

  const [september] = aggregateStormsByMonth(storms);
  assert.equal(september.month, '2024-09');
  assert.equal(september.count, 4);
  assert.equal(september.houses, 100);
  assert.equal(september.maxHail, 1.25);
});

/* ======================================================================
 * FORMATTING & TIMELINE MODEL
 * ====================================================================== */

test('formatMonthLabel formats YYYY-MM into abbreviated title', () => {
  assert.equal(formatMonthLabel('2024-06'), 'Jun 2024');
  assert.equal(formatMonthLabel('2021-01'), 'Jan 2021');
  assert.equal(formatMonthLabel('2023-12'), 'Dec 2023');
  assert.equal(formatMonthLabel('invalid-date'), 'invalid-date');
});

test('createTimelineModel calculates global scaling metrics for UI histograms', () => {
  const storms = [
    { d: '2024-05-01', houses: 5000, maxHail: 1.75 },
    { d: '2024-05-15', houses: 3000, maxHail: 2.0 },
    { d: '2024-06-10', houses: 12000, maxHail: 2.5 },
  ];

  const model = createTimelineModel(storms);
  assert.equal(model.months.length, 2);
  assert.equal(model.totalStorms, 3);
  assert.equal(model.totalHouses, 20000);
  assert.equal(model.peakHail, 2.5);
  assert.equal(model.maxMonthlyHouses, 12000, 'June has highest house reach');
  assert.equal(model.maxMonthlyCount, 2, 'May has most storms');
});

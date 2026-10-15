import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStormEvents,
  cellKey,
  indexNceiEvents,
  joinNcei,
  parseNceiDateTime,
  parseNceiMoney,
} from './storm-ncei-join.mjs';

const NCEI_HEADER_ROW = {
  EVENT_TYPE: 'Hail',
  EPISODE_ID: '200143',
  EVENT_ID: '100001',
  BEGIN_DATE_TIME: '07-APR-25 14:02:00',
  END_DATE_TIME: '07-APR-25 14:09:00',
  BEGIN_LAT: '35.1',
  BEGIN_LON: '-97.4',
  DAMAGE_PROPERTY: '1.00K',
  EPISODE_NARRATIVE: 'Hail up to baseball size near Norman.',
};

test('NCEI money is abbreviated, and an absent figure is zero not NaN', () => {
  assert.equal(parseNceiMoney('1.00K'), 1000);
  assert.equal(parseNceiMoney('2.5M'), 2_500_000);
  assert.equal(parseNceiMoney('500'), 500);
  assert.equal(parseNceiMoney('$1,000'), 1000);
  assert.equal(parseNceiMoney(''), 0);
  assert.equal(parseNceiMoney(undefined), 0);
  assert.equal(parseNceiMoney('nonsense'), 0);
});

test('a two-digit NCEI year is this century, not 1925', () => {
  const parsed = parseNceiDateTime('31-MAR-25 11:04:00');
  assert.deepEqual(parsed, { iso: '2025-03-31', minute: 664 });
  assert.equal(parseNceiDateTime('07-APR-25 14:02:00').iso, '2025-04-07');
  assert.equal(parseNceiDateTime(''), null);
  assert.equal(parseNceiDateTime('not a date'), null);
  assert.equal(parseNceiDateTime('07-FOO-25 14:02:00'), null);
});

test('both sources round coordinates to two decimals, so cells line up', () => {
  assert.equal(cellKey(37.57, -84.3), cellKey(37.5749, -84.3011));
  assert.notEqual(cellKey(37.57, -84.3), cellKey(37.67, -84.3));
});

test('only hail and wind events are indexed, so floods never borrow a narrative', () => {
  const { events } = indexNceiEvents([
    NCEI_HEADER_ROW,
    { ...NCEI_HEADER_ROW, EVENT_TYPE: 'Flash Flood' },
    { ...NCEI_HEADER_ROW, EVENT_TYPE: 'Drought' },
    { ...NCEI_HEADER_ROW, EVENT_TYPE: 'Thunderstorm Wind' },
  ]);
  assert.deepEqual([...new Set(events.map((e) => e.hazard))].sort(), [
    'hail',
    'wind',
  ]);
});

test('an episode accumulates its events and keeps the first narrative it sees', () => {
  const { episodes } = indexNceiEvents([
    NCEI_HEADER_ROW,
    {
      ...NCEI_HEADER_ROW,
      EVENT_ID: '100002',
      DAMAGE_PROPERTY: '2.00K',
      EPISODE_NARRATIVE: '',
    },
    {
      ...NCEI_HEADER_ROW,
      EVENT_ID: '100003',
      EPISODE_ID: '200144',
      EPISODE_NARRATIVE: 'A separate storm.',
    },
  ]);
  const episode = episodes.get('200143');
  assert.equal(episode.eventCount, 2);
  assert.equal(episode.damage, 3000);
  assert.equal(
    episode.narrative,
    'Hail up to baseball size near Norman.',
    'the empty narrative must not overwrite the real one',
  );
  assert.equal(episodes.get('200144').eventCount, 1);
});

const report = (over = {}) => ({
  id: 'r',
  date: '2025-04-07',
  minute: 14 * 60 + 5,
  hazard: 'hail',
  size: 2.0,
  lat: 35.1,
  lon: -97.4,
  loss: 0,
  comment: null,
  countyFips: null,
  county: null,
  state: 'OK',
  sources: ['spc-bulk'],
  ...over,
});

test('a report matches its episode on day, cell and hazard', () => {
  const { events } = indexNceiEvents([NCEI_HEADER_ROW]);
  const reports = [report()];
  const result = joinNcei(reports, events);
  assert.equal(result.matched, 1);
  assert.equal(result.unmatched, 0);
  assert.equal(reports[0].episodeId, '200143');
  assert.deepEqual(reports[0].sources, ['spc-bulk', 'ncei']);
  assert.equal(reports[0].comment, 'Hail up to baseball size near Norman.');
});

test('a report with no NCEI counterpart is reported, not silently dropped', () => {
  const { events } = indexNceiEvents([NCEI_HEADER_ROW]);
  const reports = [report(), report({ lat: 40.0, lon: -100.0 })];
  const result = joinNcei(reports, events);
  assert.equal(result.matched, 1);
  assert.equal(result.unmatched, 1);
  assert.equal(reports[1].episodeId, undefined, 'it stays unattributed');
});

test('hail never joins to a wind event at the same place and minute', () => {
  const { events } = indexNceiEvents([
    { ...NCEI_HEADER_ROW, EVENT_TYPE: 'Thunderstorm Wind' },
  ]);
  const reports = [report({ hazard: 'hail' })];
  assert.equal(joinNcei(reports, events).matched, 0);
});

test('a report hours away from the event is not attributed to it', () => {
  const { events } = indexNceiEvents([NCEI_HEADER_ROW]);
  // The event is at 14:02. 13:00 is 62 minutes away: outside the 60-minute
  // default, comfortably inside a 120-minute one.
  assert.equal(joinNcei([report({ minute: 13 * 60 })], events).matched, 0);
  assert.equal(
    joinNcei([report({ minute: 13 * 60 })], events, { timeWindowMinutes: 120 })
      .matched,
    1,
    'the window is a parameter, not a constant',
  );
});

test('a storm keeps its identity source so inferred is never shown as observed', () => {
  const { episodes, events } = indexNceiEvents([
    NCEI_HEADER_ROW,
    { ...NCEI_HEADER_ROW, EVENT_ID: '100009', BEGIN_LAT: '36.0' },
  ]);
  const reports = [report(), report({ id: 'r2', lat: 36.0, lon: -97.4 })];
  joinNcei(reports, events);
  const storms = buildStormEvents(reports, episodes);
  assert.equal(storms.length, 1);
  assert.equal(storms[0].identitySource, 'ncei');
  assert.equal(storms[0].maxHailIn, 2.0);
  assert.equal(storms[0].reportCount, 2);
  assert.equal(storms[0].damage, 2000);
});

test('a storm with only wind reports reports wind and no hail', () => {
  const { episodes, events } = indexNceiEvents([
    { ...NCEI_HEADER_ROW, EVENT_TYPE: 'Strong Wind' },
  ]);
  const reports = [report({ hazard: 'wind', size: 70 })];
  joinNcei(reports, events);
  const [storm] = buildStormEvents(reports, episodes);
  assert.equal(storm.maxWindKt, 70);
  assert.equal(storm.maxHailIn, null, 'no hail is claimed from a wind storm');
  assert.deepEqual(storm.hazards, ['wind']);
});

test('a storm spans its reports and reports how long it lasted', () => {
  const { episodes, events } = indexNceiEvents([NCEI_HEADER_ROW]);
  const reports = [
    report({ id: 'a', minute: 13 * 60 + 10 }),
    report({ id: 'b', minute: 14 * 60 + 50 }),
  ];
  joinNcei(reports, events);
  const [storm] = buildStormEvents(reports, episodes);
  assert.equal(storm.beginMinute, 13 * 60 + 10);
  assert.equal(storm.endMinute, 14 * 60 + 50);
  assert.equal(storm.durationMinutes, 100);
});

test('storms come back in timeline order', () => {
  const { episodes, events } = indexNceiEvents([
    NCEI_HEADER_ROW,
    {
      ...NCEI_HEADER_ROW,
      EPISODE_ID: '200144',
      BEGIN_DATE_TIME: '05-JUN-25 09:00:00',
      BEGIN_LAT: '40.0',
    },
  ]);
  const reports = [
    report(),
    // The second storm is on a different day, so the report must carry that
    // day too — otherwise the join correctly refuses it on date alone.
    report({ id: 'r2', lat: 40.0, date: '2025-06-05', minute: 9 * 60 + 10 }),
  ];
  joinNcei(reports, events);
  const storms = buildStormEvents(reports, episodes);
  assert.deepEqual(
    storms.map((s) => s.id),
    ['200143', '200144'],
  );
});

test('counties are collected once per storm, not once per report', () => {
  const { episodes, events } = indexNceiEvents([NCEI_HEADER_ROW]);
  const reports = [
    report({ id: 'a', countyFips: '40027' }),
    report({ id: 'b', countyFips: '40027' }),
    report({ id: 'c', countyFips: '40109', state: 'OK' }),
  ];
  joinNcei(reports, events);
  const [storm] = buildStormEvents(reports, episodes);
  assert.deepEqual(storm.counties, ['40027', '40109']);
});

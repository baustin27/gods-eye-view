import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_GAP_MINUTES,
  DEFAULT_MAX_SPAN_KM,
  clusterReports,
  haversineKm,
  scoreAgainstEpisodes,
  summarizeCluster,
} from './storm-cluster.mjs';

const at = (date, minute, lat, lon, over = {}) => ({
  id: `${date}-${minute}-${lat}-${lon}`,
  date,
  minute,
  lat,
  lon,
  hazard: 'hail',
  size: 1.5,
  countyFips: null,
  county: null,
  state: null,
  loss: 0,
  comment: null,
  sources: ['spc-bulk'],
  ...over,
});

test('distance is sane enough to gate on', () => {
  assert.ok(haversineKm(39.74, -104.99, 39.74, -104.99) < 0.01);
  const denverToBoulder = haversineKm(39.74, -104.99, 40.015, -105.27);
  assert.ok(
    denverToBoulder > 35 && denverToBoulder < 45,
    `~${denverToBoulder.toFixed(0)}km`,
  );
});

test('reports near each other in space and time form one storm', () => {
  const { clusters, stats } = clusterReports([
    at('2026-08-10', 600, 35.0, -97.0),
    at('2026-08-10', 620, 35.3, -97.1),
    at('2026-08-10', 640, 35.6, -97.2),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(stats.clusters, 1);
  assert.equal(stats.largest, 3);
});

test('a chain of near-neighbours does not become one storm', () => {
  // This is the failure that motivated complete linkage. Each report is within
  // the span of the one before it, so single linkage welds them into a single
  // cluster spanning ~150km - far more ground than one storm swept.
  const reports = [];
  for (let i = 0; i < 12; i += 1) {
    reports.push(at('2026-08-10', 600, 35.0 + i * 0.2, -97.0));
  }
  const { clusters } = clusterReports(reports, {
    maxSpanKm: DEFAULT_MAX_SPAN_KM,
    maxGapMinutes: DEFAULT_MAX_GAP_MINUTES,
  });
  assert.ok(
    clusters.length > 1,
    'a 132km-wide line is not a single 100km storm',
  );
});

test('assignment is greedy: a report joins the first cluster that can take it', () => {
  // Documents the real behaviour rather than an aspiration. Reports are
  // considered in time order, so a pair 100 minutes apart at the same place
  // joins the earlier storm rather than starting one of its own — both sit
  // inside the time window and a few kilometres apart.
  //
  // This is why the spatial bound is the real control, not the merge guard: at
  // 100km two storms an hour apart are genuinely too close to tell apart, and
  // claiming otherwise would be a fiction.
  const pair = [
    at('2026-08-10', 600, 35.0, -97.0),
    at('2026-08-10', 610, 35.02, -97.0),
    at('2026-08-10', 700, 35.01, -97.0),
    at('2026-08-10', 710, 35.03, -97.0),
  ];
  assert.equal(clusterReports(pair).clusters.length, 1);

  // Narrowing the time window is the lever that actually separates them.
  assert.equal(
    clusterReports(pair, { maxGapMinutes: 60 }).clusters.length,
    2,
    'outside the window they are two storms',
  );
});

test('a day boundary is a hard stop', () => {
  const { clusters } = clusterReports([
    at('2026-08-10', 1430, 35.0, -97.0),
    at('2026-08-11', 20, 35.0, -97.0),
  ]);
  assert.equal(clusters.length, 2, 'midnight is not the middle of one storm');
});

test('reports further apart in time than the window stay apart', () => {
  const { clusters } = clusterReports([
    at('2026-08-10', 600, 35.0, -97.0),
    at('2026-08-10', 600 + DEFAULT_MAX_GAP_MINUTES + 30, 35.0, -97.0),
  ]);
  assert.equal(clusters.length, 2);
});

test('every report lands in exactly one cluster', () => {
  const reports = [
    at('2026-08-10', 600, 35.0, -97.0),
    at('2026-08-10', 610, 35.1, -97.0),
    at('2026-08-10', 900, 40.0, -100.0),
    at('2026-08-11', 60, 28.0, -82.0),
  ];
  const { clusters, stats } = clusterReports(reports);
  assert.equal(stats.reports, reports.length);
  assert.equal(
    clusters.flat().length,
    reports.length,
    'nothing is lost or doubled',
  );
});

test('clustering is order-independent', () => {
  const reports = [
    at('2026-08-10', 600, 35.0, -97.0),
    at('2026-08-10', 620, 35.2, -97.1),
    at('2026-08-10', 630, 40.0, -100.0),
  ];
  const forward = clusterReports(reports)
    .clusters.map((c) => c.length)
    .sort();
  const backward = clusterReports([...reports].reverse())
    .clusters.map((c) => c.length)
    .sort();
  assert.deepEqual(forward, backward);
});

test('a clustered storm carries the same shape as a real one, marked as inferred', () => {
  const cluster = [
    at('2026-08-10', 600, 35.0, -97.0, {
      size: 1.75,
      countyFips: '40027',
      state: 'OK',
    }),
    at('2026-08-10', 640, 35.4, -97.1, {
      hazard: 'wind',
      size: 62,
      countyFips: '40109',
      loss: 25000,
    }),
  ];
  const storm = summarizeCluster(cluster, 'c');
  assert.equal(storm.identitySource, 'clustered');
  assert.equal(storm.date, '2026-08-10');
  assert.equal(storm.maxHailIn, 1.75);
  assert.equal(storm.maxWindKt, 62);
  assert.deepEqual(storm.hazards, ['hail', 'wind']);
  assert.deepEqual(storm.counties, ['40027', '40109']);
  assert.equal(storm.damage, 25000);
  assert.equal(storm.durationMinutes, 40);
  assert.equal(storm.narrative, null, 'inferred storms carry no narrative');
  assert.ok(
    storm.id.startsWith('c-'),
    'clustered ids cannot collide with real ones',
  );
});

test('a singleton storm still summarises rather than vanishing', () => {
  const storm = summarizeCluster([at('2026-08-10', 600, 35.0, -97.0)], 'c');
  assert.equal(storm.reportCount, 1);
  assert.equal(storm.maxHailIn, 1.5);
});

test('scoring reports both failure directions, not just one', () => {
  const reports = [
    { ...at('2026-08-10', 600, 35.0, -97.0), episodeId: 'E1' },
    { ...at('2026-08-10', 610, 35.05, -97.0), episodeId: 'E1' },
    { ...at('2026-08-10', 620, 35.1, -97.0), episodeId: 'E2' },
    { ...at('2026-08-10', 900, 40.0, -100.0), episodeId: 'E3' },
  ];
  const { clusters } = clusterReports(reports);
  const clusterOf = new Map();
  clusters.forEach((cluster, label) => {
    for (const report of cluster) clusterOf.set(reports.indexOf(report), label);
  });
  const score = scoreAgainstEpisodes(clusterOf, reports);
  assert.equal(score.episodes, 3);
  assert.ok(score.mergeRate >= 0 && score.mergeRate <= 1);
  assert.ok(score.splitRate >= 0 && score.splitRate <= 1);
  assert.equal(score.worstMerges.length > 0, true);
});

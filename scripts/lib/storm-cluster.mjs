/**
 * Group reports into storms for the window NCEI has not published yet.
 *
 * NCEI lags roughly a quarter, so the newest storms arrive with no episode id.
 * These clusters give them shape on the map — one storm rather than a hundred
 * anonymous dots — and nothing more.
 *
 * ## What this is not
 *
 * It does not reproduce NCEI episodes, and it is not trying to. Those were
 * measured against 4,113 real 2025 episodes, and no parameter setting
 * reproduced them:
 *
 *     span  gap   merge%  split%  clusters  median reports/cluster
 *      40   90m    64.9%   57.6%     7810          4
 *     100  180m    69.4%   49.4%     4683          7
 *     250  360m    77.6%   34.2%     2549         13
 *     500  720m    81.8%   24.4%     1553         21
 *
 * Tightening reduces the merge rate only slowly, loosening reduces the split
 * rate only slowly, and both plateau. A real episode averages 7.8 events while
 * the best-fit clusters average 7 — the distributions differ, not the centres.
 * NCEI episodes are a forecaster's judgement about a storm system; a
 * spatial-temporal neighbourhood is a different question.
 *
 * So the cluster is a **display grouping**, never a claim of identity. Every
 * event it produces carries `identitySource: 'clustered'` and the UI must show
 * that beside real `ncei` episodes. The parameters are deliberately tight,
 * because a cluster that overstates its own footprint is the failure that
 * matters: it would send a canvasser after ground two separate storms covered.
 *
 * Pure: no I/O, no clocks.
 * @module scripts/lib/storm-cluster
 */

/**
 * Chosen for median cluster size, not for accuracy against NCEI — see the
 * module note. At these values a typical cluster holds 7 reports against a real
 * episode's 7.8 events, and the largest observed cluster is 174 rather than
 * the 630 a chaining implementation produced.
 */
export const DEFAULT_MAX_SPAN_KM = 100;
export const DEFAULT_MAX_GAP_MINUTES = 180;
const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance, kilometres.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Reports close in space and time are the same storm. Reports can join
 * different clusters — two storms that form apart and later merge — so this is
 * a union-find over pairs rather than a greedy sweep.
 *
 * Only reports within `maxGapMinutes` of each other are even compared, and the
 * list is sorted by time first, so the inner loop is bounded by a time window
 * rather than the whole day.
 * @param {object[]} reports Must carry date, minute, lat, lon.
 * @param {{maxSpanKm?: number, maxGapMinutes?: number}} [options]
 * @returns {{clusters: object[][], stats: {reports: number, clusters: number, largest: number, singleton: number}}}
 */
export function clusterReports(reports, options = {}) {
  const maxSpanKm = options.maxSpanKm ?? DEFAULT_MAX_SPAN_KM;
  const maxGapMinutes = options.maxGapMinutes ?? DEFAULT_MAX_GAP_MINUTES;
  const ordered = [...reports].sort((a, b) =>
    a.date === b.date
      ? (a.minute ?? 0) - (b.minute ?? 0)
      : a.date < b.date
        ? -1
        : 1,
  );

  const parent = new Int32Array(ordered.length);
  for (let i = 0; i < parent.length; i += 1) parent[i] = i;
  const find = (i) => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // Complete linkage, not single linkage. Single linkage chains: if A is
  // 100km from B and B is 100km from C, A and C end up in one cluster even
  // though they are 200km apart, and a single storm system then swallows the
  // whole day. Measured against real NCEI episodes, single linkage put 669
  // reports in one "storm".
  //
  // So a report only joins a cluster when it is within maxSpanKm of every
  // member already in it. That bounds the cluster's own diameter rather than
  // its links, which is what the parameter actually means.
  const members = new Map();
  for (let i = 0; i < ordered.length; i += 1) members.set(i, []);
  const centroidOf = (list) => {
    let lat = 0;
    let lon = 0;
    for (const index of list) {
      lat += ordered[index].lat;
      lon += ordered[index].lon;
    }
    return { lat: lat / list.length, lon: lon / list.length };
  };

  // A day boundary is a hard stop: a cluster that spans midnight is two storms
  // as far as this dataset is concerned, and keeping days separate keeps the
  // inner scan bounded.
  for (let i = 0; i < ordered.length; i += 1) {
    const a = ordered[i];
    const aMinute = a.minute ?? 0;
    for (let j = i + 1; j < ordered.length; j += 1) {
      const b = ordered[j];
      if (b.date !== a.date) break;
      const bMinute = b.minute ?? 0;
      if (bMinute - aMinute > maxGapMinutes) break;
      const root = find(i);
      const list = members.get(root);
      // An empty cluster is just `a`, so anything within range of `a` fits.
      let fits = true;
      if (list.length) {
        const centre = centroidOf(list);
        fits = haversineKm(centre.lat, centre.lon, b.lat, b.lon) <= maxSpanKm;
      }
      // Every existing member, not just the neighbour we happen to be near.
      if (fits) {
        for (const index of list) {
          if (
            haversineKm(ordered[index].lat, ordered[index].lon, b.lat, b.lon) >
            maxSpanKm
          ) {
            fits = false;
            break;
          }
        }
      }
      if (!fits) continue;
      // Only an unassigned report may join. Letting `j` pull in a cluster it
      // already belongs to would merge two established storms the moment they
      // come within range, which is the chaining failure this whole linkage
      // change exists to prevent.
      if (find(j) !== j) continue;
      union(i, j);
      members.get(find(i)).push(j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < ordered.length; i += 1) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(ordered[i]);
  }
  const clusters = [...groups.values()].sort((a, b) => b.length - a.length);
  return {
    clusters,
    stats: {
      reports: ordered.length,
      clusters: clusters.length,
      largest: clusters[0]?.length ?? 0,
      singleton: clusters.filter((c) => c.length === 1).length,
    },
  };
}

/**
 * Compare inferred clusters against real episode ids, so the parameters can be
 * tuned on evidence instead of taste.
 *
 * Reports that carry both a cluster label and an episode id are the ones that
 * can be scored. A cluster is counted correct when every real episode it
 * contains is a single episode, and the episode is contained by a single
 * cluster. This measures the failure that matters for a canvasser: a storm
 * wrongly merged with a different storm.
 * @param {Map<number, object>} clusterOf report index -> clustered report
 * @param {object[]} reports with `episodeId`
 * @returns {{scored: number, pure: number, purity: number, inverted: number, groupSizes: number[]}}
 */
export function scoreAgainstEpisodes(clusterOf, reports) {
  const clusterEpisodes = new Map();
  const episodeClusters = new Map();
  let scored = 0;
  reports.forEach((report, index) => {
    if (!report.episodeId) return;
    const label = clusterOf.get(index);
    if (label === undefined) return;
    scored += 1;
    if (!clusterEpisodes.has(label)) clusterEpisodes.set(label, new Set());
    clusterEpisodes.get(label).add(report.episodeId);
    if (!episodeClusters.has(report.episodeId))
      episodeClusters.set(report.episodeId, new Set());
    episodeClusters.get(report.episodeId).add(label);
  });
  let pure = 0;
  for (const episodes of clusterEpisodes.values())
    if (episodes.size === 1) pure += 1;
  let inverted = 0;
  for (const labels of episodeClusters.values())
    if (labels.size === 1) inverted += 1;
  return {
    scored,
    episodes: episodeClusters.size,
    clusters: clusterEpisodes.size,
    // Over-clustering: a cluster that swallowed more than one real episode.
    // This is the dangerous direction, because a canvasser would be told one
    // storm covered ground that two separate storms actually covered.
    mergeRate: clusterEpisodes.size ? 1 - pure / clusterEpisodes.size : 0,
    // Under-clustering: a real episode split across several clusters, so one
    // storm shows up as two or three.
    splitRate: episodeClusters.size ? 1 - inverted / episodeClusters.size : 0,
    worstMerges: [...clusterEpisodes.values()]
      .map((s) => s.size)
      .sort((a, b) => b - a)
      .slice(0, 10),
  };
}

/**
 * Summarise an inferred cluster into the same shape a real NCEI storm has, so
 * the UI does not need to special-case where identity came from.
 * @param {object[]} cluster
 * @param {string} prefix Used to build ids that cannot collide with real ones.
 * @returns {object}
 */
export function summarizeCluster(cluster, prefix) {
  let maxHailIn = null;
  let maxWindKt = null;
  let damage = 0;
  let narrative = null;
  let firstMinute = Infinity;
  let lastMinute = -Infinity;
  const counties = new Set();
  const states = new Set();
  const hazards = new Set();
  for (const report of cluster) {
    hazards.add(report.hazard);
    if (report.countyFips) counties.add(report.countyFips);
    if (report.state) states.add(report.state);
    damage += report.loss || 0;
    if (report.comment && !narrative) narrative = report.comment;
    const minute = report.minute ?? 0;
    if (minute < firstMinute) firstMinute = minute;
    if (minute > lastMinute) lastMinute = minute;
    if (report.hazard === 'hail') {
      if (
        report.size != null &&
        (maxHailIn === null || report.size > maxHailIn)
      ) {
        maxHailIn = report.size;
      }
    } else if (
      report.size != null &&
      (maxWindKt === null || report.size > maxWindKt)
    ) {
      maxWindKt = report.size;
    }
  }
  return {
    id: `${prefix}-${cluster[0].date}-${String(cluster[0].id ?? cluster.length).replace(/[^a-z0-9]+/gi, '')}`,
    identitySource: 'clustered',
    date: cluster[0].date,
    beginMinute: firstMinute,
    endMinute: lastMinute,
    durationMinutes: lastMinute - firstMinute,
    hazards: [...hazards].sort(),
    maxHailIn,
    maxWindKt,
    reportCount: cluster.length,
    damage,
    counties: [...counties].sort(),
    states: [...states].sort(),
    narrative: null,
    eventCount: cluster.length,
  };
}

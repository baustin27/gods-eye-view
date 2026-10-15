/**
 * Runtime loader for the report-level storm snapshot.
 *
 * The snapshot is split into one gzipped file per year plus a day index, so
 * asking for a single date costs one year's payload rather than the whole
 * 155,737-report record. The index is the only thing loaded up front, and it is
 * small enough to keep: 1,571 days of counts, about 11 KB compressed.
 *
 * Loading is lazy and memoised. A year already in memory is served from cache;
 * a year requested twice while the first load is still in flight joins that
 * load rather than starting a second.
 *
 * @module data/stormReports
 */

/** Where the snapshot lives, relative to the module. */
const BASE = new URL('./local_data/storm/', import.meta.url);

const indexPromise = new Map();
const reportYears = new Map();
const eventYears = new Map();

/**
 * Fetch and inflate one gzipped JSON file.
 * @param {string} file
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}
 */
async function loadGzJson(file, signal) {
  const response = await fetch(new URL(file, BASE), { signal });
  if (!response.ok)
    throw new Error(`Storm snapshot: ${file} returned ${response.status}`);
  if (!response.body)
    throw new Error(`Storm snapshot: ${file} returned no body`);
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

/**
 * Load a payload once. Concurrent callers share the in-flight promise so a
 * second request for the same year during the first load does not refetch.
 * @template T
 * @param {Map<string, Promise<T>>} cache
 * @param {string} key
 * @param {() => Promise<T>} load
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
function once(cache, key, load, signal) {
  let pending = cache.get(key);
  if (!pending) {
    pending = load();
    cache.set(key, pending);
    // A failed load must not poison the cache for the next attempt.
    pending.catch(() => cache.delete(key));
  }
  return pending;
}

/**
 * The day index: every storm day on record with its report counts, plus which
 * years hold data. Cheap enough to load at startup and the reason the timeline
 * can be built before any year payload is touched.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{years: Record<string, number>, days: Record<string, {hail: number, wind: number, total: number}>}>}
 */
export function loadStormIndex(signal) {
  return once(
    indexPromise,
    'index',
    () => loadGzJson('storm_report_index.json.gz', signal),
    signal,
  );
}

/**
 * One year of reports.
 * @param {string|number} year
 * @param {AbortSignal} [signal]
 * @returns {Promise<{reports: Array[], count: number, hazards: {hail: number, wind: number}}>}
 */
export function loadStormReports(year, signal) {
  const key = String(year);
  return once(
    reportYears,
    key,
    () => loadGzJson(`storm_reports_${key}.json.gz`, signal),
    signal,
  );
}

/**
 * One year of storm events. A year with no file yet resolves to an empty list
 * rather than throwing, because the newest year is legitimately absent while
 * NCEI catches up.
 * @param {string|number} year
 * @param {AbortSignal} [signal]
 * @returns {Promise<{events: object[], count: number}>}
 */
export function loadStormEvents(year, signal) {
  const key = String(year);
  return once(
    eventYears,
    key,
    async () => {
      try {
        return await loadGzJson(`storm_events_${key}.json.gz`, signal);
      } catch (error) {
        if (error?.message?.includes('404')) return { events: [], count: 0 };
        throw error;
      }
    },
    signal,
  );
}

/**
 * Expand a packed report back into named fields.
 *
 * The wire format is a tuple rather than an object because a hundred thousand
 * rows a year is the difference between 1.1 MB and roughly four times that, and
 * the key names would be repeated on every single row.
 * @param {Array} packed
 * @returns {object}
 */
export function unpackReport(packed) {
  const [
    date,
    minute,
    hazard,
    size,
    lat,
    lon,
    countyFips,
    state,
    county,
    loss,
    comment,
    sources,
    trace,
  ] = packed;
  return {
    id: `${date}-${hazard}-${lat}-${lon}-${minute}`,
    date,
    minute: minute < 0 ? null : minute,
    hazard: hazard === 0 ? 'hail' : 'wind',
    size: size || null,
    lat,
    lon,
    countyFips: countyFips || null,
    state: state || null,
    county: county || null,
    loss: loss || 0,
    trace: Boolean(trace),
    sources: String(sources || '')
      .split(',')
      .filter(Boolean),
    comment: comment || null,
  };
}

/** The unit a magnitude is in, so a wind speed is never read as inches. */
export const MAGNITUDE_UNITS = Object.freeze({ hail: 'in', wind: 'kt' });

/**
 * Filter a year's reports down to what a canvassing question needs.
 *
 * Every threshold is a parameter so the map can be re-filtered as the user
 * tightens or loosens it, and so a rebuild is not required to answer a
 * different question. Nothing is capped here — the full range ships and the UI
 * narrows it.
 *
 * @param {Array} packed Packed rows from {@link loadStormReports}.
 * @param {{hazard?: 'hail'|'wind', minSize?: number, from?: string, to?: string,
 *          countyFips?: string[], states?: string[]}} [filter]
 * @returns {object[]} Named reports.
 */
export function filterReports(packed, filter = {}) {
  const { hazard, minSize, from, to, countyFips, states } = filter;
  const countySet = countyFips?.length ? new Set(countyFips) : null;
  const stateSet = states?.length ? new Set(states) : null;
  const out = [];
  for (const row of packed) {
    const [date, , hazardCode, size, , , fips, state] = row;
    if (hazard && (hazardCode === 0 ? 'hail' : 'wind') !== hazard) continue;
    if (minSize !== undefined && (!size || size < minSize)) continue;
    if (from && date < from) continue;
    if (to && date > to) continue;
    if (countySet && !(fips && countySet.has(fips))) continue;
    if (stateSet && !(state && stateSet.has(state))) continue;
    out.push(unpackReport(row));
  }
  return out;
}

/**
 * Every storm day in a range, largest first — the "when did it hit" answer.
 * @param {{days: Record<string, {hail: number, wind: number, total: number}>}} index
 * @param {{from?: string, to?: string, hazard?: 'hail'|'wind', minReports?: number}} [range]
 * @returns {Array<{date: string, hail: number, wind: number, total: number}>}
 */
export function stormDays(index, range = {}) {
  const { from, to, hazard, minReports = 1 } = range;
  const out = [];
  for (const [date, counts] of Object.entries(index?.days || {})) {
    if (from && date < from) continue;
    if (to && date > to) continue;
    const total =
      hazard === 'hail'
        ? counts.hail
        : hazard === 'wind'
          ? counts.wind
          : counts.total;
    if (total < minReports) continue;
    out.push({
      date,
      hail: counts.hail,
      wind: counts.wind,
      total: counts.total,
    });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}

/**
 * The largest storms in a set, which is the list a roofer works down.
 * @param {object[]} events
 * @param {{minHailIn?: number, minWindKt?: number, limit?: number}} [options]
 * @returns {object[]}
 */
export function rankStorms(events, options = {}) {
  const { minHailIn = 0, minWindKt = 0, limit = 50 } = options;
  return events
    .filter(
      (e) => (e.maxHailIn ?? 0) >= minHailIn && (e.maxWindKt ?? 0) >= minWindKt,
    )
    .sort((a, b) => {
      const byHail = (b.maxHailIn ?? 0) - (a.maxHailIn ?? 0);
      if (byHail !== 0) return byHail;
      return (b.maxWindKt ?? 0) - (a.maxWindKt ?? 0);
    })
    .slice(0, limit);
}

/**
 * Drop every cached year payload, keeping the index. Used when the data scope
 * changes and the whole set has to be re-derived.
 */
export function clearStormReportCache() {
  reportYears.clear();
  eventYears.clear();
}

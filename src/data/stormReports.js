/**
 * Runtime loader for the report-level storm snapshot.
 *
 * The snapshot is split into one gzipped file per year plus a day index, so
 * asking for a single date costs one year's payload rather than the whole
 * 155,737-report record. The index is the only thing loaded up front, and it is
 * small enough to keep: 1,571 days of counts, about 11 KB compressed.
 *
 * The radar cores split the same way, one gzipped file per year, and are loaded
 * the same lazy way: {@link loadRadarForYear} costs one year's 130-175 kB rather
 * than the 3.6 MB combined file, whose per-cell statistics span all six years
 * and so cannot answer a single storm day.
 *
 * Loading is lazy and memoised. A year already in memory is served from cache;
 * a year requested twice while the first load is still in flight joins that
 * load rather than starting a second.
 *
 * @module data/stormReports
 */

import {
  inflateBytes,
  inflateBytesUint8Array,
} from './stormReports.inflateHelper.js';
import {
  FINE_DAY_HEADER_BYTES,
  FINE_DAY_MAGIC,
  FINE_DAY_RECORD_BYTES,
  RADAR_FINE_GRID,
  RADAR_GRID,
  RADAR_PER_DAY_MM_SCALE,
  RADAR_RETAIN_MM_FINE,
} from './stormDatasets.js';

/**
 * Where the snapshot lives, relative to this module.
 *
 * Built by string surgery on `import.meta.url` rather than
 * `new URL('./local_data/storm/', import.meta.url)`. Vite rewrites that form
 * as an asset reference and drops the trailing slash; with no slash, `storm`
 * reads as a filename and gets replaced by whatever follows it, so every
 * request went to `/src/data/local_data/<file>` instead of
 * `/src/data/local_data/storm/<file>` and came back as the app's HTML shell.
 *
 * The sibling loaders in stormDatasets.js get away with the same rewrite
 * because each of them names a real file rather than a directory.
 */
const BASE = `${import.meta.url.replace(/[^/]*$/, '')}local_data/storm/`;

const indexPromise = new Map();
const reportYears = new Map();
const eventYears = new Map();
const radarYears = new Map();
// The per-day field gets its own cache rather than sharing `radarYears`. The two
// loaders key on the same year and would collide on it: whichever loaded first
// would answer for both, and the caller that expected `Map<'i:j', {mx, cores}>`
// would be handed `Map<dayIndex, Map<'i:j', number>>` — no error, just a layer
// that draws nothing and a reader with no reason to look further.
const radarDayYears = new Map();
/**
 * The FINE 1 km field's cache: `Map<isoDate, Promise<cells>>`.
 *
 * Its own Map for the same reason `radarDayYears` has one — two year-keyed
 * loaders sharing a cache answer each other's callers with the wrong shape and
 * no error, which is a tested invariant rather than a style note. Here the keys
 * are DATES, which collide with nothing today, but the isolation is what makes
 * adding them safe rather than lucky.
 *
 * Bounded, unlike every other cache in this module. Those hold build artifacts
 * that are immutable and few; this one holds up to `FINE_DAY_CACHE_ENTRIES`
 * days of ~10k cells each, and an unbounded map over a browsing session would
 * grow without limit. Eviction is oldest-first insertion order, which is also
 * least-recently-written, and is good enough: the loader is only ever asked for
 * a date the user is looking at.
 */
const fineDayCache = new Map();
/** How many days of fine field to hold. ~10k cells a day, so this is ~100k. */
export const FINE_DAY_CACHE_ENTRIES = 12;

/**
 * A snapshot fetch that never answers must fail, not park. An unbounded fetch
 * leaves the layer's enable promise pending forever, which the lifecycle then
 * reports as an uncertain layer with no cause anywhere.
 */
const LOAD_TIMEOUT_MS = 20000;

/**
 * Fetch one snapshot file as bytes, with the timeout and the error wording shared.
 *
 * The byte half of {@link loadSnapshotText}, for the one payload that is not
 * text: the per-day radar artifact is `uint16` triples, and the shared part of
 * this file — the 20s cap, the abort plumbing, and above all the exact wording of
 * a 404, which the year loaders key their empty-result path on — has to be the
 * *same* wording here, or one of them silently stops recognising its own 404.
 *
 * @param {string} file
 * @param {AbortSignal} [signal]
 * @returns {Promise<Uint8Array>}
 */
async function fetchSnapshotBytes(file, signal) {
  const timeout = AbortSignal.timeout(LOAD_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const url = new URL(file, BASE);
  let response;
  try {
    response = await fetch(url, { signal: combined });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted)
      throw new Error(
        `Storm snapshot: ${file} timed out after ${LOAD_TIMEOUT_MS}ms`,
      );
    throw new Error(
      `Storm snapshot: ${file} failed — ${error?.message || error}`,
    );
  }
  if (!response.ok)
    throw new Error(
      `Storm snapshot: ${file} returned ${response.status} at ${url.href}`,
    );
  if (!response.body)
    throw new Error(`Storm snapshot: ${file} returned no body`);
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new Error(
      `Storm snapshot: ${file} at ${url.href} could not be read — ${error?.message || error}`,
    );
  }
}

/**
 * Fetch one snapshot file, with the timeout and the error wording both shared.
 *
 * Split out of {@link loadGzJson} because the radar snapshots are GeoJSONL, not
 * JSON: they need the same fetch, the same 20s cap and the same gzip sniff, but
 * parsing a hundred thousand newline-delimited objects is not `JSON.parse` of
 * one big document.
 *
 * @param {string} file
 * @param {AbortSignal} [signal]
 * @returns {Promise<{url: string, text: string}>}
 */
async function loadSnapshotText(file, signal) {
  const timeout = AbortSignal.timeout(LOAD_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const url = new URL(file, BASE);
  let response;
  try {
    response = await fetch(url, { signal: combined });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted)
      throw new Error(
        `Storm snapshot: ${file} timed out after ${LOAD_TIMEOUT_MS}ms`,
      );
    throw new Error(
      `Storm snapshot: ${file} failed — ${error?.message || error}`,
    );
  }
  if (!response.ok)
    throw new Error(
      `Storm snapshot: ${file} returned ${response.status} at ${url.href}`,
    );
  if (!response.body)
    throw new Error(`Storm snapshot: ${file} returned no body`);
  try {
    return { url: url.href, text: await inflateMaybeAlreadyInflated(response) };
  } catch (error) {
    throw new Error(
      `Storm snapshot: ${file} at ${url.href} could not be read — ${error?.message || error}`,
    );
  }
}

/**
 * Fetch and inflate one gzipped JSON file.
 * @param {string} file
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}
 */
async function loadGzJson(file, signal) {
  const { url, text } = await loadSnapshotText(file, signal);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Storm snapshot: ${file} at ${url} could not be read — ${error?.message || error}`,
    );
  }
}

/**
 * Read a `.gz` payload that may or may not have been inflated for us already.
 *
 * The dev server serves these with `Content-Encoding: gzip`, and `fetch`
 * honours that automatically — by the time we see the bytes they are plain
 * JSON, and piping them through DecompressionStream fails. The same file over a
 * server that serves it as an opaque binary comes through still compressed.
 *
 * Rather than pick a side, look for the gzip magic number and inflate only if
 * the payload really is compressed. Guessing wrong in either direction used to
 * surface as "Failed to fetch", which names the network when the fault was the
 * decoder.
 */
async function inflateMaybeAlreadyInflated(response) {
  return inflateBytes(new Uint8Array(await response.arrayBuffer()));
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
 * @typedef {Object} RadarCell
 * @property {number} mx    Peak hail millimetres this cell recorded.
 * @property {number} cores Count of 1km cores at or above the 25mm threshold.
 * @property {number} days  Distinct hail days the cell saw.
 * @property {number} y0    First year the cell appears in.
 * @property {number} y1    Last year the cell appears in.
 */

/**
 * Read one year of GeoJSONL radar cores into the cell lookup the rest of the
 * radar pipeline uses.
 *
 * Keys are `i:j`, floored grid indices, exactly as
 * `data/stormCrossReference.indexRadarCells` keys them — a report attributes to
 * a cell through the same `i:j`, and the two only join if the strings are
 * identical. This does not call that function because it summarises `days` as a
 * single maximum across the payload; a year-scoped caller needs each cell's own
 * count.
 *
 * A line that will not parse is skipped rather than thrown on. The dev server
 * answers a missing asset with the app's HTML shell and a 200, so "this year
 * has no file" arrives as a payload of unparseable text, and treating that as a
 * hard error would mean the newest year breaks the layer until a build produces
 * it.
 *
 * @param {string} text GeoJSONL, one Feature per line.
 * @returns {Map<string, RadarCell>}
 */
export function indexRadarYear(text) {
  const cells = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let feature;
    try {
      feature = JSON.parse(line);
    } catch {
      continue;
    }
    const p = feature?.properties;
    if (!p || p.i === undefined || p.j === undefined) continue;
    cells.set(`${p.i}:${p.j}`, {
      mx: Number(p.mx) || 0,
      cores: Number(p.cp) || 0,
      days: Number(p.dy) || 0,
      y0: Number(p.y0) || 0,
      y1: Number(p.y1) || 0,
    });
  }
  return cells;
}

/**
 * One year of radar hail cores, keyed `i:j`.
 *
 * Lazy and memoised the same way the year report loaders are: a year already in
 * memory costs nothing, and a year requested twice while the first load is in
 * flight joins that load rather than starting a second.
 *
 * Year-scoped on purpose. The combined `storm_radar_hail.geojsonl` covers
 * 2021-2026 in one 3.6 MB file, and in it a cell's `mx`/`cp`/`dy` are
 * lifetime aggregates across all six years — so it cannot answer "was there a
 * core in this cell on the day this report was filed". A single year is
 * 130-175 kB and its statistics belong to that year alone.
 *
 * The returned map is the cached instance, shared with every other caller.
 * Treat it as read-only; a caller that needs to edit cells must copy it first.
 *
 * A year with no file resolves to an empty map rather than throwing, for the
 * same reason {@link loadStormEvents} does.
 *
 * @param {string|number} year
 * @param {AbortSignal} [signal]
 * @returns {Promise<Map<string, RadarCell>>}
 */
export function loadRadarForYear(year, signal) {
  const key = String(year);
  return once(
    radarYears,
    key,
    async () => {
      try {
        const { text } = await loadSnapshotText(
          `storm_radar_hail_${key}.geojsonl.gz`,
          signal,
        );
        return indexRadarYear(text);
      } catch (error) {
        if (error?.message?.includes('404')) return new Map();
        throw error;
      }
    },
    signal,
  );
}

/**
 * Several years of radar cores in one map.
 *
 * Merging is by `i:j`, and a cell in two year files is one cell holding two
 * years of hail: `mx` takes the larger peak, and `cp`/`dy` add. That double
 * count is real and is the reason this is a separate function rather than a
 * default — for a caller comparing reports against radar on one storm day it
 * does not matter, because a single day's reports only ever join cells whose
 * year they belong to and the day-level peak is the one the file reports. For a
 * caller asking "how bad was this cell over 2021-2026" it matters a great deal,
 * and that question should be answered by the combined file, not by summing the
 * year files here.
 *
 * @param {Array<string|number>} years
 * @param {AbortSignal} [signal]
 * @returns {Promise<Map<string, RadarCell>>}
 */
export async function loadRadarForYears(years, signal) {
  const wanted = [...new Set(years.map(String))].sort();
  const merged = new Map();
  for (const year of wanted) {
    const cells = await loadRadarForYear(year, signal);
    for (const [key, cell] of cells) {
      const seen = merged.get(key);
      if (!seen) {
        merged.set(key, { ...cell });
        continue;
      }
      merged.set(key, {
        mx: Math.max(seen.mx, cell.mx),
        cores: seen.cores + cell.cores,
        days: seen.days + cell.days,
        y0: Math.min(seen.y0, cell.y0),
        y1: Math.max(seen.y1, cell.y1),
      });
    }
  }
  return merged;
}

/**
 * Expand a packed report back into named fields.
 *
 * The wire format is a tuple rather than an object because a hundred thousand
 * rows a year is the difference between 1.1 MB and roughly four times that, and
 * the key names would be repeated on every single row.
 *
 * `stormRef` is the row's ordinal into that year's `storm_events_<year>`
 * `events` array, or -1 when the report belongs to no storm. It is an integer
 * rather than an episode id because the id is 25 characters and repeating it on
 * every row costs more than the ordinal it resolves to.
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
    stormRef,
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
    // A row packed before the ordinal existed reads as undefined, and an
    // absent ordinal means the same thing as -1: it belongs to no storm.
    stormRef: Number.isInteger(stormRef) ? stormRef : -1,
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
  radarYears.clear();
  radarDayYears.clear();
  fineDayCache.clear();
}

/** Bytes per per-day record: `u16 cellIndex, u16 dayIndex, u16 maxMm × scale`. */
const PER_DAY_RECORD_BYTES = 6;

/**
 * Flat cell index back to the `i:j` key every other radar lookup uses.
 *
 * The artifact stores a position, not a key, so this is where the encoding
 * becomes a joinable value. Row-major over the retained domain — the inverse of
 * `cellIndex` in `scripts/build-storm-radar-snapshots.mjs`.
 *
 * @param {number} index
 * @returns {string}
 */
export function radarCellKey(index) {
  const row = Math.floor(index / RADAR_GRID.columns) + RADAR_GRID.rowBase;
  const col = (index % RADAR_GRID.columns) + RADAR_GRID.colBase;
  return `${row}:${col}`;
}

/**
 * One year of the per-day radar field, decoded.
 *
 * Fetches `storm_radar_hail_perday_<year>.bin.gz` and returns
 * `Map<dayIndex, Map<'i:j', maxMm>>` — the day's per-cell peaks, keyed the same
 * `i:j` way as {@link indexRadarYear}, so it joins with the climatology and with
 * `crossReference` without a second convention.
 *
 * The payload is binary and comes through
 * {@link module:data/stormReports.inflateHelper.inflateBytesUint8Array}, never the
 * text path: `TextDecoder` turns every `uint16` into a wrong number without
 * raising anything.
 *
 * A year with no usable payload resolves to an empty map rather than throwing,
 * for two reasons. A missing file is normal — the newest year may not have been
 * built yet. And a *present but wrong* payload is also normal in one deployment:
 * a production `vite build` copies none of the storm `.gz` payloads into
 * `dist/`, so the same request that returns the file from the dev server returns
 * the app's HTML shell from a static host — with a 200, because of the SPA
 * fallback. Keying the empty result on "this is not a per-day payload" rather
 * than on the status code is what makes that degrade to an empty swath instead
 * of throwing inside a layer enable.
 *
 * Memoised through {@link once}, so a second request for a year already in
 * flight joins it rather than refetching.
 *
 * @param {string|number} year
 * @param {AbortSignal} [signal]
 * @returns {Promise<Map<number, Map<string, number>>>}
 */
export function loadRadarDaysForYear(year, signal) {
  const key = String(year);
  return once(
    radarDayYears,
    key,
    async () => {
      let payload;
      try {
        payload = await inflateBytesUint8Array(
          await fetchSnapshotBytes(
            `storm_radar_hail_perday_${key}.bin.gz`,
            signal,
          ),
        );
      } catch (error) {
        if (error?.message?.includes('404')) return new Map();
        throw error;
      }
      return indexRadarDays(payload);
    },
    signal,
  );
}

/**
 * The filename one day's fine shard is published under.
 * @param {string} date ISO `YYYY-MM-DD`.
 * @returns {string}
 */
export function fineDayFileName(date) {
  return `storm_radar_hail_fine_${date.replaceAll('-', '')}.bin.gz`.replace(
    /(\d{4})(\d{2})(\d{2})/,
    '$1-$2-$3',
  );
}

/**
 * Decode ONE fine day shard.
 *
 * Split out from the loader for the same reason {@link indexRadarDays} is: the
 * decoding has to be testable without a fetch, and the "is this actually a fine
 * payload?" decision has exactly one home.
 *
 * That decision is a LENGTH check, and it is load-bearing. A production build
 * that did not copy the shards, served by a static host's SPA fallback, answers
 * with the HTML shell and a **200**. Decoded as binary that is not a whole
 * number of records, so it refuses — rather than producing a day of plausible
 * numbers, which is the failure mode this whole loader shape exists to avoid.
 *
 * @param {Uint8Array} bytes
 * @returns {{cells: Array<{i: number, j: number, maxMm: number}>, count: number}}
 *   `cells` is sorted by index, i.e. geographically, so a renderer can walk it.
 */
export function indexFineDay(bytes) {
  const empty = { cells: [], count: 0 };
  if (
    !bytes?.length ||
    bytes.length < FINE_DAY_HEADER_BYTES ||
    (bytes.length - FINE_DAY_HEADER_BYTES) % FINE_DAY_RECORD_BYTES !== 0
  ) {
    return empty;
  }
  // The magic is checked BEFORE any decoding. The coarse artifact has the same
  // six-byte record width, so a swapped payload would otherwise decode into tens
  // of thousands of in-bounds indices and place hail in the wrong counties with
  // nothing reporting an error anywhere.
  for (let at = 0; at < FINE_DAY_HEADER_BYTES; at += 1) {
    if (bytes[at] !== FINE_DAY_MAGIC[at]) return empty;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { columns, colBase, rowBase, cellCount } = RADAR_FINE_GRID;
  const cells = [];
  for (
    let at = FINE_DAY_HEADER_BYTES;
    at < bytes.length;
    at += FINE_DAY_RECORD_BYTES
  ) {
    const index = view.getUint32(at, true);
    // A 32-bit read can yield anything. An index outside the retained space is
    // refused per-record rather than allowed to wrap into a real cell.
    if (index >= cellCount) continue;
    cells.push({
      i: Math.floor(index / columns) + rowBase,
      j: (index % columns) + colBase,
      maxMm: view.getUint16(at + 4, true) / RADAR_PER_DAY_MM_SCALE,
    });
  }
  return { cells, count: cells.length };
}

/**
 * Load ONE calendar day's fine 1 km field.
 *
 * Per day, where the coarse loader is per year. The measured reason: a per-year
 * fine blob is ~85 MB to draw one neighbourhood's worth of detail, and a
 * per-day shard is 28 KB. The consumer asks about a date, so the fetch is that
 * date and nothing else.
 *
 * Degrades to an empty day in the two documented ways the coarse loader does —
 * a 404, or a payload that is not a fine payload — because a missing artifact
 * must never fail a layer enable. There is also a third, specific to the fine
 * family: a day outside the retention window has no shard by design, so the
 * roll-off pruning in the builder is not an error to report.
 *
 * @param {string} date ISO `YYYY-MM-DD`.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{cells: Array<{i: number, j: number, maxMm: number}>, count: number}>}
 */
export function loadFineRadarDay(date, signal) {
  const key = String(date);
  const pending = once(
    fineDayCache,
    key,
    async () => {
      let payload;
      try {
        payload = await inflateBytesUint8Array(
          await fetchSnapshotBytes(fineDayFileName(key), signal),
        );
      } catch (error) {
        if (error?.message?.includes('404')) return { cells: [], count: 0 };
        throw error;
      }
      return indexFineDay(payload);
    },
    signal,
  );
  // Oldest-first eviction, after the load resolves so a rejected entry is
  // already gone and does not occupy a slot.
  return pending.then((result) => {
    while (fineDayCache.size > FINE_DAY_CACHE_ENTRIES) {
      const oldest = fineDayCache.keys().next().value;
      if (oldest === key) break;
      fineDayCache.delete(oldest);
    }
    return result;
  });
}

/** How many fine days are held. Reported rather than asserted, for diagnostics. */
export function fineRadarCacheSize() {
  return fineDayCache.size;
}

/** Drop the fine cache. Paired with {@link clearStormReportCache}. */
export function clearFineRadarCache() {
  fineDayCache.clear();
}

/**
 * Decode a per-day payload into days of cells.
 *
 * Split out from the loader so the decoding is testable without a fetch, and so
 * the "is this actually a per-day payload?" decision has one place. A payload
 * that is empty or not a whole number of records is not one — that is the HTML
 * shell, and decoding it would produce a day of nonsense rather than nothing.
 *
 * @param {Uint8Array} bytes Decompressed payload.
 * @returns {Map<number, Map<string, number>>}
 */
export function indexRadarDays(bytes) {
  const days = new Map();
  if (!bytes?.length || bytes.length % PER_DAY_RECORD_BYTES !== 0) {
    return days;
  }
  // `Uint8Array` has no `readUInt16LE` — that is a `Buffer` method, and calling
  // it on the array a `fetch` hands back throws. `DataView` is the portable read.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length; at += PER_DAY_RECORD_BYTES) {
    const dayIndex = view.getUint16(at + 2, true);
    let cells = days.get(dayIndex);
    if (!cells) {
      cells = new Map();
      days.set(dayIndex, cells);
    }
    cells.set(
      radarCellKey(view.getUint16(at, true)),
      view.getUint16(at + 4, true) / RADAR_PER_DAY_MM_SCALE,
    );
  }
  return days;
}

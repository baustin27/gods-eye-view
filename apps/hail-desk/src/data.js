/**
 * The desk's data layer.
 *
 * Two tables, and the CITY one is the point:
 *
 *   - CITIES: 32,607 Census places - city, town, village, CDP - with the hail
 *     that actually fell in each, counted from the individual reports. A
 *     canvasser works in a town, and this is the row that says what happened
 *     in it.
 *   - COUNTIES: the coarser market view, with the shared core's score.
 *
 * The scores and the window counts are COMPUTED HERE, at query time, by the
 * shared core - the same `stormScoring.js` the globe uses. Nothing about how a
 * place or a county is counted is reimplemented here, because a second
 * implementation is a second answer to the same question, and the two would
 * drift the first time either was tuned.
 */

import {
  decodeYearBuckets,
  scoreCounties,
  windowCellCounts,
} from '../../../src/data/stormScoring.js';

/**
 * The gzip-decoded artifact.
 *
 * The desk's payload is gzipped like every other committed artifact, and the
 * browser inflates it with `DecompressionStream` - the same primitive the
 * storm loader uses, so there is one decompression path in the project.
 *
 * @param {string} url
 * @returns {Promise<object>}
 */
export async function loadGzippedJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Hail Desk data: HTTP ${response.status} for ${url}`);
  }
  // A server that answers a missing artifact with the app shell returns 200
  // and HTML. The magic number catches that, where a status check would not.
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) {
    throw new Error(
      `Hail Desk data: ${url} did not arrive gzipped (the server may have ` +
        'answered with the app shell).',
    );
  }
  const stream = new Blob([bytes]).stream().pipeThrough(
    new DecompressionStream('gzip'),
  );
  return JSON.parse(await new Response(stream).text());
}

/**
 * The CITY table, indexed for window queries.
 *
 * The per-year rows are the point: a window is a sum over the years inside it,
 * and because the tallies are per year that sum is EXACT rather than a share
 * of a multi-year average. A window of one year answers with that year.
 *
 * @param {object} payload the cities artifact
 * @returns {{cities: Array<object>, byYear: Map<string, Array<object>>}}
 */
export function indexCities(payload) {
  const cities = payload.cities || [];
  const byYear = new Map();
  for (const row of payload.cityYears || []) {
    if (!byYear.has(row.geoid)) byYear.set(row.geoid, []);
    byYear.get(row.geoid).push(row);
  }
  for (const rows of byYear.values()) rows.sort((a, b) => a.y - b.y);
  // The STORMS: one row per place per DAY. A market table says "this town has
  // been hit"; a work list says "this town was hit on the ninth of June, by
  // stones this big". The second question needs the day, and 46,379
  // place-days is small enough to ship whole.
  const byDay = new Map();
  for (const row of payload.cityDays || []) {
    if (!byDay.has(row.geoid)) byDay.set(row.geoid, []);
    byDay.get(row.geoid).push(row);
  }
  for (const rows of byDay.values()) {
    rows.sort((a, b) => b.n1 - a.n1 || b.max - a.max || a.d.localeCompare(b.d));
  }
  return { cities, byYear, byDay };
}

/**
 * The storms that hit a place, worst first, inside the selected window.
 *
 * "Worst" is the number of severe reports, then the largest stone - so a day
 * with one 3-inch stone in it is not ranked below a day with eight 1-inch
 * stones, and a day with a single trace is not in the list at all.
 *
 * The WINDOW is applied here and not by the caller, because the list is a
 * different grain from the table: a place's storm days are its own rows, and a
 * table filtered to 2024-2026 that then opened a list showing 1987 is a filter
 * that does not filter.
 *
 * @param {object} index
 * @param {string} geoid
 * @param {object} [filters] `{fromYear, toYear}`
 * @returns {Array<object>}
 */
export function cityStorms(index, geoid, filters = {}) {
  const { fromYear, toYear } = filters;
  return (index.byDay.get(String(geoid)) || []).filter((row) => {
    if (row.n <= 0) return false;
    // The YEAR, not the date: '2025-01-18' > '2025' as strings, which
    // silently drops the last year of every window.
    const year = row.d.slice(0, 4);
    if (fromYear && year < String(fromYear)) return false;
    if (toYear && year > String(toYear)) return false;
    return true;
  });
}

/**
 * The cities matching the current filters, with the window's hail counted.
 *
 * @param {{cities: Array<object>, byYear: Map<string, Array<object>>}} index
 * @param {object} filters
 * @returns {Array<object>}
 */
export function queryCities(index, filters) {
  const { fromYear, toYear, state, minHailTenths, q } = filters;
  const minHail = (minHailTenths || 0) / 10;
  const wanted = String(state || '').trim().toUpperCase();
  const needle = String(q || '').trim().toLowerCase();

  const out = [];
  for (const city of index.cities) {
    if (wanted && String(city.st || '').toUpperCase() !== wanted) continue;
    if (needle) {
      const haystack = `${city.name} ${city.full} ${city.st}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    const rows = index.byYear.get(city.id);
    if (!rows || !rows.length) continue;
    let hail = 0;
    let severe = 0;
    let big = 0;
    let severe15 = 0;
    let max = 0;
    let wind = 0;
    let maxWind = 0;
    let years = 0;
    for (const row of rows) {
      if (row.y < fromYear || row.y > toYear) continue;
      years += 1;
      hail += row.n;
      severe += row.n1;
      severe15 += row.n15;
      big += row.n2;
      if (row.max > max) max = row.max;
      wind += row.wind;
      if (row.wmax > maxWind) maxWind = row.wmax;
    }
    if (!years) continue;
    // The threshold is on the hail that actually fell in the window, not on a
    // lifetime maximum. A county that had one softball in 1993 and nothing
    // since is not a market, and filtering on a lifetime figure keeps it in the
    // list for ever.
    if (minHail > 0 && max < minHail) continue;
    out.push({
      ...city,
      hail,
      severe,
      severe15,
      big,
      max,
      wind,
      maxWind,
      years,
    });
  }
  return out;
}

/**
 * The swaths: how many houses were under the hail, per place per day.
 *
 * Indexed by `place:day` because that is the question the drill-down asks:
 * "this storm hit this town - how many roofs were under it".
 *
 * The rows only exist from 2024-01-01, which is where the 1 km radar field
 * starts. A storm before that has no number here, and the desk says so rather
 * than showing a zero.
 *
 * @param {object} payload the swaths artifact
 * @returns {{byPlaceDay: Map<string, {tracts: number, houses: number, maxMm: number}>,
 *   firstDay: string}}
 */
export function indexSwaths(payload) {
  const byPlaceDay = new Map();
  const byPlace = new Map();
  let firstDay = null;
  for (const row of payload.rows || []) {
    const key = `${row.k}:${row.d}`;
    let entry = byPlaceDay.get(key);
    if (!entry) {
      entry = { tracts: 0, houses: 0, maxMm: 0 };
      byPlaceDay.set(key, entry);
      if (!byPlace.has(row.k)) byPlace.set(row.k, new Map());
      byPlace.get(row.k).set(row.d, entry);
    }
    entry.tracts += 1;
    entry.houses += row.u || 0;
    if (row.m > entry.maxMm) entry.maxMm = row.m;
    if (firstDay === null || row.d < firstDay) firstDay = row.d;
  }
  return { byPlaceDay, byPlace, firstDay };
}

/**
 * The days the RADAR reached a place, with the houses under it.
 *
 * This is the other half of the picture and it is the half that matters. A
 * report says somebody measured a stone. The radar says hail fell. Where the
 * two DISAGREE - the radar reached a town and nobody called it in - is the
 * canvassing thesis, and it is invisible in a table of reports.
 *
 * @param {object} index
 * @param {string} placeGeoid
 * @param {object} [filters] `{fromYear, toYear}`
 * @returns {Array<{d: string, tracts: number, houses: number, maxMm: number}>}
 */
export function radarDays(index, placeGeoid, filters = {}) {
  const { fromYear, toYear } = filters;
  const days = index.byPlace.get(String(placeGeoid));
  if (!days) return [];
  const out = [];
  for (const [day, entry] of days) {
    // The YEAR, not the date. '2025-01-18' <= '2025' is FALSE as strings, so
    // comparing the whole date against a bare year silently drops the last
    // year of every window - and a window that quietly loses its final year
    // looks exactly like a window that works.
    const year = day.slice(0, 4);
    if (fromYear && year < String(fromYear)) continue;
    if (toYear && year > String(toYear)) continue;
    out.push({ d: day, ...entry });
  }
  out.sort((a, b) => b.houses - a.houses || a.d.localeCompare(b.d));
  return out;
}

/**
 * The houses under a storm in a place, or null when the radar does not reach
 * back that far.
 * @param {object} index
 * @param {string} placeGeoid
 * @param {string} day
 * @returns {{tracts: number, houses: number, maxMm: number}|null}
 */
export function swathFor(index, placeGeoid, day) {
  return index.byPlaceDay.get(`${placeGeoid}:${day}`) || null;
}

/**
 * The county rows matching the filters, with the shared core's score.
 *
 * The score is computed over the SAME window the table filters on, so a row's
 * score and its counts always describe the same period.
 *
 * @param {Array<object>} rows
 * @param {object} filters
 * @returns {Array<object>}
 */
export function queryCounties(rows, filters) {
  const { fromYear, toYear, state, minHailTenths, q } = filters;
  const minHail = (minHailTenths || 0) / 10;
  const period = { fromYear, toYear };

  const scored = scoreCounties(rows, { fromYear, toYear });
  const scoredByFips = new Map(scored.map((row) => [row.fips, row]));

  const wanted = String(state || '').trim().toUpperCase();
  const needle = String(q || '').trim().toLowerCase();

  const out = [];
  for (const row of rows) {
    const score = scoredByFips.get(row.fips);
    if (!score) continue;
    if (wanted && String(score.st || '').toUpperCase() !== wanted) continue;
    // The per-year tallies have to be a Map for the window arithmetic to be
    // EXACT rather than apportioned from the decade histogram. If they are not
    // one, `windowCellCounts` falls back to spreading a decade's count across
    // the window - which returns a plausible number and is wrong. A 2000-2001
    // window answers 12 events from the tallies and 1.7 from the histogram.
    if (!(row.years instanceof Map)) {
      row.years = decodeYearBuckets(row.ye);
    }
    const counts = windowCellCounts(row, period);
    // `scoreCounties` RENAMES the fields: the snapshot's `hx` arrives as
    // `maxHailIn`. Reading `hx` off the scored row gets undefined, and
    // undefined reads as zero - so every county looked like it had never seen
    // hail and the table came up EMPTY, with no error anywhere.
    const maxHail = Number(score.maxHailIn) || 0;
    if (minHail > 0 && maxHail < minHail) continue;
    if (needle) {
      const haystack = `${row.name} ${row.st}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    out.push({ ...row, ...score, window: counts, maxHailIn: maxHail });
  }
  return out;
}

/**
 * The years the data actually covers, so the range control cannot offer a
 * window that predates the record.
 *
 * @param {Array<object>} rows
 * @returns {{min: number, max: number}}
 */
export function yearBounds(rows) {
  let min = Infinity;
  let max = 0;
  for (const row of rows) {
    const first = Number(row.y0);
    const last = Number(row.y1);
    if (Number.isFinite(first) && first > 0) min = Math.min(min, first);
    if (Number.isFinite(last) && last > 0) max = Math.max(max, last);
  }
  if (!Number.isFinite(min)) min = 1955;
  return { min, max: max || new Date().getFullYear() };
}

/**
 * The years the CITY rows cover.
 * @param {{cities: Array<object>, byYear: Map<string, Array<object>>}} index
 * @returns {{min: number, max: number}}
 */
export function cityYearBounds(index) {
  let min = Infinity;
  let max = 0;
  for (const rows of index.byYear.values()) {
    for (const row of rows) {
      if (row.y < min) min = row.y;
      if (row.y > max) max = row.y;
    }
  }
  return { min: Number.isFinite(min) ? min : 1955, max: max || new Date().getFullYear() };
}

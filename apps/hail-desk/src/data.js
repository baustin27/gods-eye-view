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
  return { cities, byYear };
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

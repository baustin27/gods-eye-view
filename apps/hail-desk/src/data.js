/**
 * The desk's data layer.
 *
 * The scores and the window counts are COMPUTED HERE, at query time, by the
 * shared core - the same `stormScoring.js` the globe uses. Nothing about how a
 * county is scored is reimplemented here, because a second implementation of a
 * score is a second answer to the same question, and the two would drift the
 * first time either was tuned.
 *
 * What this module DOES own is the shape the desk needs: one row per county,
 * with the window's counts beside the lifetime facts, and the housing units
 * joined on.
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
 * @returns {Promise<{meta: object, rows: Array<object>}>}
 */
export async function loadDeskData(url) {
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
  const payload = JSON.parse(await new Response(stream).text());
  const rows = (payload.rows || []).map((row) => ({
    ...row,
    // The per-year tallies have to be a Map for the core's window arithmetic.
    // The artifact carries them as a flat array because a Map does not survive
    // JSON, and this is the one place that has to know it.
    years: decodeYearBuckets(row.ye),
  }));
  return { meta: payload.meta || {}, rows };
}

/**
 * The counties matching the current filters, with their window numbers.
 *
 * The window counts come from the core's own `windowCellCounts`, which reads
 * the per-year tallies EXACTLY when they are present and only apportions the
 * decade histogram when they are not. A window of one year therefore answers
 * with that year's reports and not with a fraction of a 71-year average, which
 * is the difference between a usable number and a plausible one.
 *
 * @param {Array<object>} rows
 * @param {object} filters
 * @returns {Array<object>} rows for the table, with `window` attached
 */
export function queryCounties(rows, filters) {
  const { fromYear, toYear, state, minHailTenths, q } = filters;
  const minHail = (minHailTenths || 0) / 10;
  const period = { fromYear, toYear };

  // The score is computed over the SAME window the table filters on, so a row's
  // score and its counts always describe the same period.
  const scored = scoreCounties(rows, { fromYear, toYear });

  const wanted = String(state || '').trim().toUpperCase();
  const needle = String(q || '').trim().toLowerCase();

  // The score and the window counts are computed on DIFFERENT inputs, and
  // that is not an accident to be tidied away:
  //
  //   - `scoreCounties` takes the snapshot rows and returns a SCORED row: a
  //     new object with the score, the band, and a handful of renamed fields.
  //     It does not carry `units`, `population` or `reportedLoss`, because
  //     scoring has no opinion about them.
  //   - `windowCellCounts` needs the per-year tallies, which live on the
  //     SNAPSHOT row as a Map. The scored row has no Map, so asking it for
  //     window counts returns zero for every county - silently, because a
  //     missing histogram is a legitimate state for the fallback to be in.
  //
  // So the counts are computed on the snapshot row and the score is MERGED
  // onto it. Reading either from the wrong one produces a table that looks
  // plausible and is wrong in a way nothing flags: every county at zero
  // events, and every dollar column empty.
  const scoredByFips = new Map(scored.map((row) => [row.fips, row]));

  const out = [];
  for (const row of rows) {
    const score = scoredByFips.get(row.fips);
    if (!score) continue;
    // The per-year tallies have to be a Map for the window arithmetic to be
    // EXACT rather than apportioned from the decade histogram. If they are not
    // one, `windowCellCounts` falls back to spreading a decade's count across
    // the window - which returns a plausible number and is wrong. A 2000-2001
    // window answers 12 events from the tallies and 1.7 from the histogram,
    // and the difference between them is the difference between the number
    // that was measured and a fraction of an average.
    if (!(row.years instanceof Map)) {
      row.years = decodeYearBuckets(row.ye);
    }
    if (wanted && String(score.st || '').toUpperCase() !== wanted) continue;
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

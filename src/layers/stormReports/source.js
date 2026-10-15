/**
 * Source for the report-level storm layer.
 *
 * Wraps `data/stormReports` as a snapshot source so the layer treats reports
 * the same way every other layer treats its data: `getSnapshot()` returns rows,
 * and the layer decides what to draw. Keeping the load here rather than in the
 * layer means the year files are fetched once even if two layers ask.
 *
 * @module layers/stormReports/source
 */

import {
  loadStormEvents,
  loadStormIndex,
  loadStormReports,
  stormDays,
} from '../../data/stormReports.js';

const reportsByYear = new Map();
const eventsByYear = new Map();
const indexPromise = new Map();

/**
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{years: string[], days: object, earliest: string|null, latest: string|null}>}
 */
export async function getSnapshot({ signal } = {}) {
  let index = indexPromise.get('index');
  if (!index) {
    index = loadStormIndex(signal);
    indexPromise.set('index', index);
    // A failed load must not poison the cache; the next enable retries.
    index.catch(() => indexPromise.delete('index'));
  }
  const loaded = await index;
  const years = Object.keys(loaded.years).sort();
  return {
    years,
    days: loaded.days,
    earliest: years[0] ? `${years[0]}-01-01` : null,
    latest: days(loaded).length ? days(loaded)[0].date : null,
  };
}

/** Storm days from a snapshot, newest first. */
export function days(snapshot) {
  return stormDays(snapshot);
}

/**
 * Reports for a set of years, in one pass.
 * @param {string[]} years
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array>} Packed rows, concatenated in year order.
 */
export async function reportsFor(years, signal) {
  const wanted = [...new Set(years)].sort();
  const rows = [];
  for (const year of wanted) {
    let payload = reportsByYear.get(year);
    if (!payload) {
      payload = loadStormReports(year, signal);
      reportsByYear.set(year, payload);
      payload.catch(() => reportsByYear.delete(year));
    }
    const { reports } = await payload;
    rows.push(...reports);
  }
  return rows;
}

/**
 * Storm events for a set of years. A year with no file resolves empty rather
 * than throwing, because the newest year is legitimately absent while NCEI
 * catches up.
 * @param {string[]} years
 * @param {AbortSignal} [signal]
 * @returns {Promise<object[]>}
 */
export async function eventsFor(years, signal) {
  const wanted = [...new Set(years)].sort();
  const events = [];
  for (const year of wanted) {
    let payload = eventsByYear.get(year);
    if (!payload) {
      payload = loadStormEvents(year, signal);
      eventsByYear.set(year, payload);
      payload.catch(() => eventsByYear.delete(year));
    }
    const { events: list } = await payload;
    events.push(...list);
  }
  return events;
}

/** Drop every cached year, keeping the index. */
export function clearCache() {
  reportsByYear.clear();
  eventsByYear.clear();
}

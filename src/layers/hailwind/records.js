/**
 * Validation for the bundled storm snapshot.
 *
 * The snapshot is a build artefact, so its shape is known — but a validation
 * step still earns its place: it is the only thing standing between a malformed
 * snapshot and 12,119 nonsense rectangles on the globe, and it keeps NaN out of
 * the scoring math where it would silently poison a ranking.
 *
 * Unlike the earthquake feed validator, a single bad record does not invalidate
 * the whole snapshot. These files are large and statically versioned, so the
 * useful behaviour is to drop the offender and report how many were dropped.
 *
 * @module layers/hailwind/records
 */

import {
  toCellRecord,
  toCountyRecord,
  toEventRecord,
  parseGeoJsonLines,
} from '../../data/stormDatasets.js';

/** A cell whose grid index is missing cannot be joined to a county. */
function validCell(record) {
  return (
    Number.isFinite(record.i) &&
    Number.isFinite(record.j) &&
    Number.isFinite(record.lat) &&
    Number.isFinite(record.lon) &&
    Math.abs(record.lat) <= 90 &&
    Math.abs(record.lon) <= 180 &&
    Number.isFinite(record.hailCount) &&
    Number.isFinite(record.windCount)
  );
}

/** An event without a year or a coordinate cannot be placed in a time window. */
function validEvent(record) {
  return (
    Number.isFinite(record.year) &&
    record.year >= 1900 &&
    record.year <= 2100 &&
    Number.isFinite(record.lat) &&
    Number.isFinite(record.lon) &&
    (record.hazard === 'hail' || record.hazard === 'wind')
  );
}

/** Counties need a FIPS key to join; geometry is required for area selection. */
function validCounty(record) {
  return /^\d{5}$/.test(String(record.fips || '')) && Boolean(record.geometry);
}

/**
 * Normalise a raw dataset into the validated shape the layer and scoring engine
 * consume.
 *
 * @param {object|null} raw Output of `loadStormDataset`.
 * @returns {{ok:boolean, reason?:string, dataset?:object}}
 */
export function normalizeStormDataset(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'storm snapshot unavailable' };
  }
  if (!Array.isArray(raw.cells) || raw.cells.length === 0) {
    return { ok: false, reason: 'storm snapshot contains no grid cells' };
  }

  const cells = raw.cells.filter(validCell);
  const significantEvents = Array.isArray(raw.significantEvents)
    ? raw.significantEvents.filter(validEvent)
    : [];
  const counties = Array.isArray(raw.counties)
    ? raw.counties.filter(validCounty)
    : [];
  const coarseCells = Array.isArray(raw.coarseCells)
    ? raw.coarseCells.filter(validCell)
    : [];

  if (cells.length === 0) {
    return {
      ok: false,
      reason: 'storm snapshot contained no usable grid cells',
    };
  }

  const dropped = {
    cells: raw.cells.length - cells.length,
    events: (raw.significantEvents?.length || 0) - significantEvents.length,
    counties: (raw.counties?.length || 0) - counties.length,
  };

  const latestYear = cells.reduce(
    (max, c) => Math.max(max, c.lastYear || 0),
    0,
  );
  const earliestYear = cells.reduce(
    (min, c) =>
      Number.isFinite(c.firstYear) ? Math.min(min, c.firstYear) : min,
    Number.POSITIVE_INFINITY,
  );

  return {
    ok: true,
    dataset: {
      ...raw,
      cells,
      coarseCells,
      significantEvents,
      counties,
      latestYear,
      earliestYear: Number.isFinite(earliestYear) ? earliestYear : null,
      dropped,
    },
  };
}

/**
 * Parse and validate GeoJSONL text directly. Used by the unit tests so they can
 * exercise the validator without a network fetch.
 *
 * @param {{cellsText?:string, eventsText?:string, countiesText?:string}} parts
 * @returns {object} Normalized dataset (or a reason string when empty).
 */
export function normalizeStormText({
  cellsText,
  eventsText,
  countiesText,
} = {}) {
  const cells = parseGeoJsonLines(cellsText || '')
    .features.map(toCellRecord)
    .filter(Boolean);
  const significantEvents = parseGeoJsonLines(eventsText || '')
    .features.map(toEventRecord)
    .filter(Boolean);
  const counties = parseGeoJsonLines(countiesText || '')
    .features.map(toCountyRecord)
    .filter(Boolean);
  return normalizeStormDataset({
    cells,
    significantEvents,
    counties,
    coarseCells: [],
    countiesByCell: new Map(),
    countiesByFips: new Map(),
    meta: null,
    stats: {},
  });
}

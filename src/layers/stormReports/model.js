/**
 * Geometry and colour for the report-level storm layer.
 *
 * Kept pure and separate from the layer so the sizing and banding rules can be
 * tested against known reports without a viewer.
 *
 * The size bands are the claim the layer makes, so they are stated once here
 * and exported for the card and the legend to read rather than restated.
 * @module layers/storm-reports/model
 */

/** Hail diameter bands, in inches. The first band a size falls into wins. */
export const HAIL_BANDS = Object.freeze([
  Object.freeze({
    id: 'trace',
    min: 0,
    max: 0.75,
    label: 'under 0.75"',
    color: '#8c8c8c',
  }),
  Object.freeze({
    id: 'small',
    min: 0.75,
    max: 1.0,
    label: '0.75–1.0"',
    color: '#4a90d9',
  }),
  Object.freeze({
    id: 'moderate',
    min: 1.0,
    max: 1.5,
    label: '1.0–1.5"',
    color: '#2fa84f',
  }),
  Object.freeze({
    id: 'large',
    min: 1.5,
    max: 2.0,
    label: '1.5–2.0"',
    color: '#e0a020',
  }),
  Object.freeze({
    id: 'severe',
    min: 2.0,
    max: 2.75,
    label: '2.0–2.75"',
    color: '#e06020',
  }),
  Object.freeze({
    id: 'extreme',
    min: 2.75,
    max: Infinity,
    label: 'over 2.75"',
    color: '#c81e1e',
  }),
]);

/** Wind bands, in knots. */
export const WIND_BANDS = Object.freeze([
  Object.freeze({
    id: 'strong',
    min: 0,
    max: 50,
    label: 'under 50 kt',
    color: '#4a90d9',
  }),
  Object.freeze({
    id: 'damaging',
    min: 50,
    max: 58,
    label: '50–58 kt',
    color: '#2fa84f',
  }),
  Object.freeze({
    id: 'severe',
    min: 58,
    max: 65,
    label: '58–65 kt',
    color: '#e0a020',
  }),
  Object.freeze({
    id: 'destructive',
    min: 65,
    max: 75,
    label: '65–75 kt',
    color: '#e06020',
  }),
  Object.freeze({
    id: 'extreme',
    min: 75,
    max: Infinity,
    label: 'over 75 kt',
    color: '#c81e1e',
  }),
]);

/**
 * The band a magnitude falls into.
 * @param {number|null} size
 * @param {ReadonlyArray<{min: number, max: number}>} bands
 * @returns {object|null} Null when the magnitude is missing, so an absent
 *   measurement is never drawn as though it were a small one.
 */
export function bandFor(size, bands) {
  if (size === null || size === undefined || !Number.isFinite(size))
    return null;
  for (const band of bands) {
    if (size >= band.min && size < band.max) return band;
  }
  return bands[bands.length - 1] || null;
}

/** Hail band for a report. */
export function hailBand(size) {
  return bandFor(size, HAIL_BANDS);
}

/** Wind band for a report. */
export function windBand(size) {
  return bandFor(size, WIND_BANDS);
}

/**
 * Point radius, in metres, for a report.
 *
 * Scaled by magnitude so the worst hail is visible without zooming, and capped
 * so a national view is not a wall of discs. The cap matters: at 155,737
 * reports an uncapped radius turns the map into a solid sheet.
 * @param {number|null} size
 * @param {'hail'|'wind'} hazard
 * @returns {number}
 */
export function radiusMetres(size, hazard) {
  const bands = hazard === 'hail' ? HAIL_BANDS : WIND_BANDS;
  const band = bandFor(size, bands);
  if (!band) return 400;
  const index = bands.indexOf(band);
  const floor = 400;
  const step = 900;
  return Math.min(floor + index * step, 7000);
}

/**
 * Whether a report survives the user's filter.
 *
 * Every threshold is inclusive at the bottom so "over 1 inch" means what it
 * says.
 * @param {object} report
 * @param {{hazard?: string|null, minSize?: number, from?: string|null, to?: string|null,
 *          countyFips?: string[]|null, states?: string[]|null, radiusKm?: number,
 *          center?: {lat: number, lon: number}|null}} filter
 * @returns {boolean}
 */
export function matchesFilter(report, filter = {}) {
  const { hazard, minSize, from, to, countyFips, states, radiusKm, center } =
    filter;
  if (hazard && report.hazard !== hazard) return false;
  if (Number.isFinite(minSize)) {
    if (report.size === null || report.size < minSize) return false;
  }
  if (from && report.date < from) return false;
  if (to && report.date > to) return false;
  if (countyFips?.length && !report.countyFips) return false;
  if (countyFips?.length && !countyFips.includes(report.countyFips))
    return false;
  if (states?.length && !states.includes(report.state)) return false;
  if (Number.isFinite(radiusKm) && center) {
    const km = haversineKm(center.lat, center.lon, report.lat, report.lon);
    if (km > radiusKm) return false;
  }
  return true;
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in kilometres. */
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
 * The worst reports for a list, which is the list a canvasser works down.
 * @param {object[]} reports
 * @param {'hail'|'wind'} hazard
 * @param {number} [limit]
 * @returns {object[]}
 */
export function worstFirst(reports, hazard, limit = 25) {
  return [...reports]
    .filter((r) => r.hazard === hazard)
    .sort((a, b) => (b.size ?? -1) - (a.size ?? -1))
    .slice(0, limit);
}

/**
 * One line describing a report's magnitude, in the unit that hazard uses.
 * @param {object} report
 * @returns {string}
 */
export function magnitudeLabel(report) {
  if (report.size === null) return report.trace ? 'trace' : 'not measured';
  return report.hazard === 'hail'
    ? `${trimInches(report.size)} hail`
    : `${report.size} kt wind`;
}

/** `1.75` reads as `1.75"`, `1.5` as `1.5"` rather than `1.50"`. */
export function trimInches(value) {
  return String(Number(value.toFixed(2)));
}

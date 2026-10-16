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

/**
 * Month names the typed date field accepts. Indexed from 1 so the parser can
 * take a word straight to a number.
 */
const MONTHS = Object.freeze({
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
});

/** Calendar days in a 1-indexed month, leap years included. */
const MONTH_LENGTHS = Object.freeze([
  31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
]);

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Real date, or null. Feb 30 is not a date and must not become Mar 2. */
function buildDate(year, month, day) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  )
    return null;
  if (year < 1900 || year > 2999) return null;
  if (month < 1 || month > 12) return null;
  const length =
    month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1];
  if (day < 1 || day > length) return null;
  return { year, month, day };
}

const pad = (n) => String(n).padStart(2, '0');

/** @param {{year:number,month:number,day:number}} parts */
function formatDate(parts) {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * Read a date the way someone would say or type it.
 *
 * Accepts `2026-08-11`, `8/11/2026`, `Aug 11 2026`, `11 Aug 2026` and `Aug 11`,
 * with or without a trailing year. A bare `Aug 11` means the most recent one
 * that has already happened, which is the reading a person checking last
 * month's hail wants. Numeric forms are month/day/year, US convention —
 * `8/11/2026` is 11 August, and `13/11/2026` is the 13th of November because no
 * month is ever 13.
 *
 * Returns null rather than guessing when the text is not a date. Nothing is
 * worse than a storm view silently showing the wrong day.
 *
 * @param {string} raw
 * @param {{today?: string}} [options] `today` is 'YYYY-MM-DD', defaults to now.
 * @returns {string|null} 'YYYY-MM-DD'
 */
export function parseStormDate(raw, options = {}) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase().replace(/,/g, ' ');
  if (!text) return null;

  const today = parseIsoToday(options.today);
  if (!today) return null;

  let parts = parseIsoForm(text);
  if (!parts) parts = parseNumericForm(text);
  if (!parts) parts = parseWordForm(text);
  if (!parts) return null;

  // "Aug 11" with no year: the most recent one that has already happened.
  // Only this year and last are tried; a bare month/day cannot sensibly mean
  // a date further back than that.
  const todayIso = formatDate(today);
  if (parts.year === null) {
    for (let year = today.year; year >= today.year - 1; year--) {
      const candidate = buildDate(year, parts.month, parts.day);
      if (!candidate) continue;
      const iso = formatDate(candidate);
      if (iso <= todayIso) return iso;
    }
    return null;
  }

  const built = buildDate(parts.year, parts.month, parts.day);
  return built ? formatDate(built) : null;
}

function parseIsoToday(value) {
  const source = value ?? formatDateFromNow();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(source).trim());
  if (!match) return null;
  const parts = buildDate(+match[1], +match[2], +match[3]);
  return parts ? { ...parts } : null;
}

function formatDateFromNow() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `2026-08-11` */
function parseIsoForm(text) {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (!match) return null;
  return { year: +match[1], month: +match[2], day: +match[3] };
}

/** `8/11/2026`, `08-11-26` */
function parseNumericForm(text) {
  const match = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/.exec(text);
  if (!match) return null;
  let first = +match[1];
  let second = +match[2];
  const rawYear = match[3];
  // 13 cannot be a month, so the order has to be day/month.
  if (first > 12 && second <= 12) [first, second] = [second, first];
  const year =
    rawYear === undefined ? null : +rawYear + (rawYear.length === 2 ? 2000 : 0);
  return { year, month: first, day: second };
}

/** `aug 11 2026`, `11 aug 2026`, `august 11th` */
function parseWordForm(text) {
  const tokens = text.split(/[\s/]+/).filter(Boolean);
  let month = null;
  let day = null;
  let year = null;
  for (const token of tokens) {
    const digits = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(token);
    if (digits) {
      if (day === null) day = +digits[1];
      else if (year === null) year = +digits[1] + (digits[1] < 100 ? 2000 : 0);
      continue;
    }
    const yearToken = /^(\d{4})$/.exec(token);
    if (yearToken) {
      year = +yearToken[1];
      continue;
    }
    const named = MONTHS[token.replace(/\.$/, '')];
    if (named !== undefined) month = named;
  }
  if (month === null || day === null) return null;
  return { year, month, day };
}

/**
 * Where to put the camera so a day's reports are all in view.
 *
 * Pure, so the arithmetic is testable without a viewer. Altitude is derived
 * from the spread rather than fixed, because a hail cell covering forty miles
 * and one covering four need very different altitudes - and a fixed altitude
 * either crops the big ones or strands the viewer in the sky over a small one.
 *
 * @param {Array<{lat:number,lon:number}>} reports
 * @returns {{lat:number, lon:number, altitudeM:number, radiusKm:number}|null}
 */
export function framingFor(reports) {
  const points = (reports || []).filter(
    (r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lon),
  );
  if (!points.length) return null;
  if (points.length === 1) {
    return {
      lat: points[0].lat,
      lon: points[0].lon,
      radiusKm: 0,
      altitudeM: MIN_FRAME_ALTITUDE_M,
    };
  }
  const lat = points.reduce((sum, r) => sum + r.lat, 0) / points.length;
  const lon = points.reduce((sum, r) => sum + r.lon, 0) / points.length;
  // Measure from the centre so the frame covers the whole spread, not just
  // half of it: averaging two edges would halve the radius we need.
  const radiusKm = Math.max(
    ...points.map((r) => haversineKm(lat, lon, r.lat, r.lon)),
  );
  return {
    lat,
    lon,
    radiusKm,
    altitudeM: frameAltitude(radiusKm),
  };
}

/* -------------------------------------------------------------------------
 * The approximate storm outline.
 *
 * NCEI's Storm Events Database publishes no polygons. A storm event row
 * carries a time window, counties, states, hazards and the magnitudes people
 * reported - and no geometry of any kind. So the only outline this layer can
 * draw is a circle drawn around the places reports came FROM, and that circle
 * is not where hail fell: it is a guess at the outer bound of where enough
 * people were watching for anything to be measured.
 *
 * It therefore ships off, behind a toggle, and says so in its own words
 * wherever it is drawn.
 * ---------------------------------------------------------------------- */

/** Ring resolution. Enough to read as a circle at any usable zoom. */
export const OUTLINE_POINT_COUNT = 64;

/**
 * A one-report storm would otherwise frame a zero-radius ring: three identical
 * points is not a polygon, and Cesium rejects it. County-scale is the smallest
 * honest circle - it is roughly what one reporting location speaks for.
 */
export const MIN_OUTLINE_RADIUS_KM = 8;

/**
 * The widest circle drawn. Beyond this the reports are not one storm's core,
 * they are the day's footprint, and a ring over a third of a state reads as a
 * measurement when it is nothing of the kind.
 */
export const MAX_OUTLINE_RADIUS_KM = 400;

/**
 * The wording that travels with every approximate outline.
 *
 * Read by the panel info line and the legend. It is a claim about what the
 * shape is NOT, which is the part a reader has to be told: the record has no
 * polygons, so this circle is an inference about where reports came from, not a
 * boundary of where weather happened.
 */
export const OUTLINE_CAVEAT =
  'Approximate outline: a circle around where people reported, not a measured ' +
  'storm boundary. NCEI publishes no storm polygons - only times, counties and ' +
  'states - so the edge is inferred from report locations and the hail may have ' +
  'fallen well outside it.';

/**
 * The point a bearing and distance lands on, by the great-circle formula.
 *
 * Exported because the ring generator's accuracy is a testable claim and not a
 * detail worth hiding.
 *
 * @param {number} lat Degrees.
 * @param {number} lon Degrees.
 * @param {number} bearingRad Clockwise from north.
 * @param {number} distanceKm
 * @returns {{lon: number, lat: number}}
 */
export function destinationPointKm(lat, lon, bearingRad, distanceKm) {
  const toRad = Math.PI / 180;
  const angular = distanceKm / EARTH_RADIUS_KM;
  const lat1 = lat * toRad;
  const lon1 = lon * toRad;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinLat2 =
    Math.sin(lat1) * Math.cos(angular) +
    cosLat1 * Math.sin(angular) * Math.cos(bearingRad);
  const lat2 = Math.asin(Math.min(1, Math.max(-1, sinLat2)));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(angular) * cosLat1,
      Math.cos(angular) - sinLat1 * sinLat2,
    );
  // Wrapped into [-180, 180] so a ring that crosses the antimeridian is still
  // one ring and never a vertex at 540 degrees.
  const lonDeg = (lon2 * 180) / Math.PI;
  const wrapped = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  return { lon: wrapped, lat: (lat2 * 180) / Math.PI };
}

/**
 * The ring points of the approximate outline for a framing.
 *
 * Clamps the radius to the county-scale floor and the regional ceiling, walks
 * one full turn in equal bearings, and DROPS any point that is not finite -
 * Cesium turns one non-finite coordinate into a NaN vertex, and a single NaN
 * vertex makes the whole polygon's centre NaN, which surfaces as "origin has a
 * NaN component" and takes the shape with it.
 *
 * Pure, so the geometry is testable without a viewer.
 *
 * @param {{lat: number, lon: number, radiusKm?: number}|null} frame
 * @param {{count?: number}} [options]
 * @returns {Array<{lon: number, lat: number}>} `[{lon, lat}]` in ring order.
 */
export function outlineRing(frame, { count = OUTLINE_POINT_COUNT } = {}) {
  if (!frame || !Number.isFinite(frame.lat) || !Number.isFinite(frame.lon))
    return [];
  const steps =
    Number.isInteger(count) && count >= 3 ? count : OUTLINE_POINT_COUNT;
  const measured = Number.isFinite(frame.radiusKm) ? frame.radiusKm : 0;
  const radiusKm = Math.min(
    Math.max(
      measured > 0 ? measured : MIN_OUTLINE_RADIUS_KM,
      MIN_OUTLINE_RADIUS_KM,
    ),
    MAX_OUTLINE_RADIUS_KM,
  );
  const points = [];
  for (let step = 0; step < steps; step += 1) {
    const bearing = (step / steps) * 2 * Math.PI;
    const point = destinationPointKm(frame.lat, frame.lon, bearing, radiusKm);
    if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) continue;
    points.push(point);
  }
  return points;
}

/** Minutes past midnight UTC, as `HH:MMZ`, or null when unreadable. */
export function stormMinuteLabel(minute) {
  if (!Number.isFinite(minute) || minute < 0 || minute >= 24 * 60) return null;
  const hours = Math.floor(minute / 60);
  const rest = Math.floor(minute % 60);
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}Z`;
}

/**
 * A storm's time window, as `HH:MMZ-HH:MMZ`, or just the start when there is
 * no end. The events table carries begin and end minutes for most storms and
 * not for the rest, so both readings have to be honest.
 */
export function stormTimeRange(storm) {
  const begin = stormMinuteLabel(storm?.beginMinute);
  if (!begin) return null;
  const end = stormMinuteLabel(storm?.endMinute);
  return end && end !== begin ? `${begin}-${end}` : begin;
}

/** Where a storm was reported, in one line, at two counties' worth of names. */
export function stormPlaces(storm, limit = 2) {
  const counties = (storm?.counties || []).filter(Boolean);
  const states = (storm?.states || []).filter(Boolean);
  const shown = counties.slice(0, limit);
  if (counties.length > limit) shown.push(`+${counties.length - limit} more`);
  const parts = [shown.join(', '), states.join(' ')].filter(Boolean);
  return parts.join(' · ') || null;
}

/**
 * The worst magnitude a storm is known to have carried.
 *
 * A zero or absent magnitude is a storm where nobody measured that hazard, not
 * a storm that measured zero, so it is left out and the hazards it did carry
 * are named instead.
 */
export function stormMagnitude(storm) {
  const bits = [];
  if (Number.isFinite(storm?.maxHailIn) && storm.maxHailIn > 0)
    bits.push(`${trimInches(storm.maxHailIn)}\" hail`);
  if (Number.isFinite(storm?.maxWindKt) && storm.maxWindKt > 0)
    bits.push(`${storm.maxWindKt} kt wind`);
  if (bits.length) return bits.join(' / ');
  const hazards = (storm?.hazards || []).filter(Boolean);
  return hazards.length ? hazards.join(' + ') : null;
}

/**
 * One line describing a storm, for the storm list and the panel alike.
 *
 * `reportCount` is passed in rather than read from the storm because the storm
 * row's own count is NCEI's total for the event, while the line has to describe
 * what is actually in view under the current hazard and size filter. When the
 * two disagree the visible number is the honest one.
 *
 * @param {object} storm
 * @param {number|null} [reportCount] Reports currently in view.
 * @returns {string}
 */
export function stormHeadline(storm, reportCount = null) {
  const count =
    Number.isInteger(reportCount) && reportCount >= 0
      ? reportCount
      : Number.isInteger(storm?.reportCount)
        ? storm.reportCount
        : 0;
  const parts = [`${count} report${count === 1 ? '' : 's'}`];
  const magnitude = stormMagnitude(storm);
  if (magnitude) parts.push(magnitude);
  const places = stormPlaces(storm);
  if (places) parts.push(places);
  return parts.join(' · ');
}

/** Closer than this loses the county context; higher and the reports are dots. */
export const MIN_FRAME_ALTITUDE_M = 60_000;
export const MAX_FRAME_ALTITUDE_M = 1_500_000;

/**
 * Altitude that frames a radius, clamped to something usable at both ends.
 * @param {number} radiusKm
 * @returns {number} metres
 */
export function frameAltitude(radiusKm) {
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) return MIN_FRAME_ALTITUDE_M;
  const wanted = radiusKm * 1000 * 2.6;
  return Math.min(
    MAX_FRAME_ALTITUDE_M,
    Math.max(MIN_FRAME_ALTITUDE_M, Math.round(wanted)),
  );
}

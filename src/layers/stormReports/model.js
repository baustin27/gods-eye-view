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

// The grid helper is imported, not re-derived: a report and a radar cell have
// to land on the same `i:j` or nothing downstream can join them, and rounding
// here versus flooring there is exactly that bug. See `stormCrossReference`.
import {
  GRID_DEG,
  RADAR_IMPLAUSIBLE_MM,
  gridCell,
} from '../../data/stormCrossReference.js';

/**
 * The fine 1 km grid step, re-exported so the renderer takes its step from a
 * named constant rather than a literal. Mirrors the builder's CELL_DEG_FINE and
 * the loader's RADAR_FINE_GRID.deg.
 */
export const GRID_DEG_FINE = 0.01;

/**
 * The MID grid step, in degrees.
 *
 * Between the 1 km field and the 0.25 degree one. The 0.25 degree cell is
 * 27.8 km, and at the altitudes where a person decides "did this storm hit
 * my county" it is a quarter of the frame - so the storm reads as a grid of
 * squares rather than as a storm. A 5 km cell is a twelfth of that, and it is
 * built by pooling the 1 km field, so it is the same hail, coarsened.
 */
export const GRID_DEG_MID = 0.05;

/**
 * The inch thresholds the prospecting view starts from.
 *
 * One inch is 25.4 mm exactly. NOT 25: `RADAR_RAMP_MM` bands at 25 because it
 * is a round number for a colour ramp, and borrowing that 25 here would start
 * the prospecting a millimetre under the product's stated floor and quietly
 * count a quarter-inch stone as "nobody reported a big one".
 */
export const PROSPECT_MM_FLOOR = 25.4;

/** The report size that counts as someone standing in the cell. */
export const PROSPECT_IN_FLOOR = 1;

/**
 * How far from a report a radar cell still counts as unclaimed.
 *
 * Nine kilometres is a township, which is the distance a hailstone is treated as
 * having travelled in the storm that dropped it - so "nobody reported within a
 * township of here" is a claim about the hail, not an accident of where the
 * reporter happened to be standing. Exposed as a parameter rather than a literal
 * so it can be tuned against the same data that tests it.
 */
export const PROSPECT_RADIUS_KM = 9;

/**
 * The prospecting ramp: cold, on purpose.
 *
 * `RADAR_RAMP_MM` runs green to red because a radar cell is a claim about how
 * bad the hail was. This view is a claim about a *gap*, and painting it in the
 * same hot colours would read as "worse hail" rather than "nobody said
 * anything" - which is the opposite of what the user is being told. Cold, and
 * the worst band is fuchsia because the most valuable lead IS the extreme cell
 * nobody reported.
 */
export const PROSPECT_BANDS = Object.freeze([
  Object.freeze({
    min: 88.9,
    color: '#f0abfc',
    label: '3.5"+ probed, nobody reported',
  }),
  Object.freeze({
    min: 38.1,
    color: '#22d3ee',
    label: '1.5-3.5" probed, nobody reported',
  }),
  Object.freeze({
    min: PROSPECT_MM_FLOOR,
    color: '#7dd3fc',
    label: '1-1.5" probed, nobody reported',
  }),
]);

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
 * The US hail-size chart: the measured size and the object it is compared to.
 *
 * This is the vocabulary the category uses — "2.5" (tennis ball)", "Hen Egg
 * (2.00 in.)" — and it is US customary through and through. The four the plan
 * names out (quarter, golf ball, tennis ball, hen egg) sit here as ordinary
 * entries; the rest are the peers that fill the chart so no band is left
 * without one. Only the listed sizes have a nickname: a 1.1" stone is nearer a
 * golf ball than anything else, but nobody measured "1.1 inches of golf ball",
 * so the honest answer is no nickname at all rather than a rounded guess.
 */
export const HAIL_NICKNAMES = Object.freeze([
  Object.freeze({ inches: 0.25, object: 'pea' }),
  Object.freeze({ inches: 0.5, object: 'marble' }),
  Object.freeze({ inches: 0.75, object: 'dime' }),
  Object.freeze({ inches: 0.875, object: 'nickel' }),
  Object.freeze({ inches: 1.0, object: 'quarter' }),
  Object.freeze({ inches: 1.25, object: 'half dollar' }),
  Object.freeze({ inches: 1.5, object: 'walnut' }),
  Object.freeze({ inches: 1.75, object: 'golf ball' }),
  Object.freeze({ inches: 2.0, object: 'hen egg' }),
  Object.freeze({ inches: 2.5, object: 'tennis ball' }),
  Object.freeze({ inches: 2.75, object: 'baseball' }),
  Object.freeze({ inches: 3.0, object: 'tea cup' }),
  Object.freeze({ inches: 4.0, object: 'grapefruit' }),
  Object.freeze({ inches: 4.5, object: 'softball' }),
]);

/** Sizes within this of a chart entry are that entry. Measured, not guessed. */
const NICKNAME_TOLERANCE_IN = 0.001;

/**
 * The object a measured hail size is compared to, or null.
 *
 * The chart is inches. A caller who hands in millimetres — the radar field is
 * in mm, the report record is in inches — is telling us the number is not on
 * this chart, so they get no nickname rather than a foreign one: 25 mm is a hen
 * egg in Denver and a large grape in Toulouse, and a table that answers "tennis
 * ball" for a metric reading is lying about both. Convert to inches yourself
 * only if a US object is what you actually want to show.
 *
 * @param {number|null} size
 * @param {{unit?: string}} [options] Only `'in'` (the default) is nicknamed.
 * @returns {string|null}
 */
export function hailNickname(size, { unit = 'in' } = {}) {
  if (unit !== 'in') return null;
  const inches = Number(size);
  if (!Number.isFinite(inches)) return null;
  const entry = HAIL_NICKNAMES.find(
    (candidate) => Math.abs(candidate.inches - inches) <= NICKNAME_TOLERANCE_IN,
  );
  return entry ? entry.object : null;
}

/**
 * A measured size rendered the way the category renders it: `2.5" (tennis
 * ball)`, or the bare measurement when the size is not on the chart.
 *
 * Formatting goes through {@link trimInches}, which owns inch text here, so
 * `2.0` reads as `2"` and not `2.00"`.
 *
 * @param {number|null} size
 * @param {{unit?: string}} [options] Passed to {@link hailNickname}. Anything
 *   but `'in'` (the default) returns null: an inch-formatted label for a
 *   millimetre reading is a lie with a different noun.
 * @returns {string|null} Null when the size is not a number, or not inches.
 */
export function hailSizeLabel(size, options = {}) {
  if ((options.unit ?? 'in') !== 'in') return null;
  if (size === null || size === undefined) return null;
  const inches = Number(size);
  if (!Number.isFinite(inches)) return null;
  const text = `${trimInches(inches)}"`;
  const object = hailNickname(inches, options);
  return object ? `${text} (${object})` : text;
}

/**
 * The peer object the legend shows for a whole band.
 *
 * A band claims a range, and a range has no single size to nickname, so this
 * picks the chart entry at the band's lower edge — the smallest stone the band
 * promises. That is what keeps the remaining bands, the ones with no headline
 * object, from being drawn as bare numbers.
 *
 * @param {{min: number, max: number}|null} band From {@link HAIL_BANDS}.
 * @returns {string|null}
 */
export function bandHailNickname(band) {
  // `max` is `Infinity` on the top band, so it is finite only in spirit; test
  // the type, not finiteness.
  if (!band || !Number.isFinite(band.min) || typeof band.max !== 'number')
    return null;
  const entry =
    HAIL_NICKNAMES.find(
      (candidate) =>
        candidate.inches >= band.min && candidate.inches < band.max,
    ) || HAIL_NICKNAMES[HAIL_NICKNAMES.length - 1];
  return entry ? entry.object : null;
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
 * The one line the panel reads for an isolation: how much of what is on screen
 * falls inside the area.
 *
 * `describe` is handed in rather than computed here, so the label — and the
 * "approximate: point with a radius, no boundary data" that a place carries and
 * a state does not — is stated in exactly one place in this app
 * (`describeIsolation`). A layer that re-derived it would eventually drop that
 * half-sentence, which is the half that keeps a city box from being read as a
 * city boundary.
 *
 * An area with the isolation switched off still gets a line, because "off" is
 * only legible when the panel also says what turning it on would do. A control
 * that silently does nothing is this layer's recurring failure; an axis whose
 * state is unstated is the same defect wearing a different hat.
 *
 * @param {string} describe `describeIsolation`'s own label
 * @param {{inside: number, total: number, active: boolean, subject?: string}} counts
 *   `inside` of `total` `subject` are inside the area
 * @returns {string}
 */
export function isolationLine(
  describe,
  { inside, total, active, subject = 'reports' } = {},
) {
  const kept = Number.isFinite(inside) ? inside : 0;
  const of = Number.isFinite(total) ? total : kept;
  const stem = `${kept} of ${of} ${subject} inside ${describe}`;
  return active ? stem : `isolation off — ${stem}`;
}

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

/* -------------------------------------------------------------------------
 * The swaths.
 *
 * The category draws size-banded polygon swaths and puts the report pins on
 * top of them. These two builders are that wash. They stay pure so the banding
 * and the date join are testable without a viewer — a swath that quietly falls
 * back to "all days" is the lifetime bug this whole layer exists to avoid, and
 * a viewer is the worst place to try to catch it.
 * ---------------------------------------------------------------------- */

/**
 * Group grid cells into contiguous per-band rings, ready to draw as polygons.
 *
 * WHY THIS EXISTS. The swaths were drawn as one translucent rectangle per
 * 0.25-degree cell at a uniform alpha. Measured on the running app
 * (`npm run qa:storm-swath`, camera 23.8 km over one drawn cell): the wash
 * covers 64% of the frame and has a mean colour difference of ΔE 21 against the
 * basemap, so it is neither buried nor invisible — it is a flat GREEN BOX.
 * Neighbouring translucent rectangles also double-blend along shared edges,
 * which draws a lattice of darker seams over the storm. The category this
 * copies draws contiguous colour-banded POLYGONS with hard edges, so the cells
 * have to be joined before they can be drawn that way.
 *
 * HOW. Marching squares on the integer lattice, edge by edge:
 *
 *   - a cell's edge is a boundary edge exactly when the neighbour across it is
 *     not in the set;
 *   - edges are emitted with a consistent winding, so the interior is always on
 *     the same side and the rings come out closed;
 *   - because holes are traced by the same rule, they come out with the OPPOSITE
 *     winding automatically — no containment test, which is where a hand-rolled
 *     version usually goes wrong;
 *   - outer rings are the positively-wound ones, by signed area.
 *
 * Pure, node-testable, no Cesium — the same rule D1 set for the swath model.
 * Deterministic: cells are visited in sorted order and rings are emitted in a
 * fixed sequence, so two runs produce identical geometry and a test can assert
 * exact vertex lists.
 *
 * @param {Array<{i: number, j: number}>} cells Grid cells, in any order.
 * @returns {Array<{outer: Array<[number, number]>, holes: Array<Array<[number, number]>>}>}
 *   One entry per disjoint landmass, in CELL-CORNER indices (not centres), so
 *   the renderer can multiply by the grid step and hand the result to
 *   `PolygonHierarchy` without re-deriving an offset.
 */
export function gridCellRings(cells) {
  const occupied = new Set();
  for (const cell of cells || []) {
    const i = Number(cell?.i);
    const j = Number(cell?.j);
    if (!Number.isInteger(i) || !Number.isInteger(j)) continue;
    occupied.add(`${i}:${j}`);
  }
  if (!occupied.size) return [];
  const has = (i, j) => occupied.has(`${i}:${j}`);

  // Every boundary edge as a directed segment, keyed by its start point so the
  // chaining below is a map walk rather than a search.
  const edges = new Map();
  const push = (from, to) => {
    const key = `${from[0]},${from[1]}`;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push(to);
  };

  // Sorted, so the ring order and the winding are reproducible run to run.
  const sorted = [...occupied].sort((a, b) => {
    const [ai, aj] = a.split(':').map(Number);
    const [bi, bj] = b.split(':').map(Number);
    return ai - bi || aj - bj;
  });

  for (const key of sorted) {
    const [i, j] = key.split(':').map(Number);
    // The four corners of this cell, in counter-clockwise order in (i, j).
    const sw = [i, j];
    const se = [i + 1, j];
    const ne = [i + 1, j + 1];
    const nw = [i, j + 1];
    // Interior on the left of travel: south edge runs west->east, east edge
    // south->north, north edge east->west, west edge north->south.
    if (!has(i, j - 1)) push(sw, se);
    if (!has(i + 1, j)) push(se, ne);
    if (!has(i, j + 1)) push(ne, nw);
    if (!has(i - 1, j)) push(nw, sw);
  }

  // Chain the segments into closed rings.
  const rings = [];
  while (edges.size) {
    const [startKey] = edges.keys();
    const start = startKey.split(',').map(Number);
    const ring = [start];
    let current = start;
    // The budget is fixed BEFORE walking. Reading `edges.size` as the bound is
    // a trap: keys are deleted as they are consumed, so the ceiling drops
    // mid-ring and truncates it — which is exactly what it did here, closing a
    // 2x2 block after 6 of its 8 vertices.
    const budget = edges.size + 1;
    // Every vertex has as many outgoing edges as incoming ones, so this always
    // closes; the guard defends against a malformed input, not a branch a
    // correct set can reach.
    for (let guard = 0; guard < budget; guard += 1) {
      const key = `${current[0]},${current[1]}`;
      const outs = edges.get(key);
      if (!outs || !outs.length) break;
      const next = outs.shift();
      if (!outs.length) edges.delete(key);
      if (next[0] === start[0] && next[1] === start[1]) break;
      ring.push(next);
      current = next;
    }
    if (ring.length >= 4) rings.push(ring);
  }

  const signedArea = (ring) => {
    let sum = 0;
    for (let n = 0; n < ring.length; n += 1) {
      const [x1, y1] = ring[n];
      const [x2, y2] = ring[(n + 1) % ring.length];
      sum += x1 * y2 - x2 * y1;
    }
    return sum / 2;
  };

  /**
   * Drop vertices that sit in the middle of a straight run.
   *
   * The edge walk naturally emits one vertex per lattice step, so a 4x4 block
   * arrives as sixteen corners when four describe it. They are harmless to
   * Cesium but they are not canonical: two cells sets that draw the same shape
   * would carry different vertex lists, and the drawing budget grows with the
   * cell count instead of with the shape. Collapsing collinear runs makes the
   * ring a function of the SHAPE, which is also what makes it assertable.
   */
  const dropCollinear = (ring) => {
    if (ring.length < 4) return ring;
    const out = [];
    for (let n = 0; n < ring.length; n += 1) {
      const prev = ring[(n - 1 + ring.length) % ring.length];
      const here = ring[n];
      const next = ring[(n + 1) % ring.length];
      const cross =
        (here[0] - prev[0]) * (next[1] - prev[1]) -
        (here[1] - prev[1]) * (next[0] - prev[0]);
      if (cross !== 0) out.push(here);
    }
    return out.length >= 4 ? out : ring;
  };

  // Positive winding is land, negative is a hole inside it.
  const outers = rings.map(dropCollinear).filter((r) => signedArea(r) > 0);
  const holes = rings.map(dropCollinear).filter((r) => signedArea(r) < 0);
  if (!outers.length) return [];

  // A hole belongs to the outer ring that CONTAINS it. With cell-corner rings
  // that is decided by a point-in-polygon test on the hole's first vertex.
  const contains = (outer, point) => {
    const [px, py] = point;
    let inside = false;
    for (let n = 0, m = outer.length - 1; n < outer.length; m = n, n += 1) {
      const [xi, yi] = outer[n];
      const [xj, yj] = outer[m];
      const straddles = yi > py !== yj > py;
      if (
        straddles &&
        px < ((xj - xi) * (py - yi)) / (yj - yi || Number.EPSILON) + xi
      ) {
        inside = !inside;
      }
    }
    return inside;
  };

  return outers.map((outer) => ({
    outer,
    holes: holes.filter((hole) => contains(outer, hole[0])),
  }));
}

/**
 * The same rings, as `{lat, lon}` positions ready for a `PolygonHierarchy`.
 *
 * Cell corners in degrees, using the SAME step the cell indices were built
 * with. Kept separate from {@link gridCellRings} so the index arithmetic stays
 * testable without trigonometry or a viewer.
 *
 * `deg` is the grid step the ring's indices were built on: 0.25 for the
 * published field, 0.01 for the fine 1 km one. It is a parameter rather than a
 * second function because the arithmetic is identical and the RISK is not —
 * passing the wrong step displaces every ring by 25x, which is a quarter of a
 * cell at the coarse step and half a cell at the fine one. Both callers pass a
 * named constant rather than a literal.
 *
 * @param {Array<{outer: Array<[number, number]>, holes: Array<Array<[number, number]>>}>} rings
 * @param {number} [deg] grid step in degrees, default {@link GRID_DEG}
 * @returns {Array<{outer: Array<{lat: number, lon: number}>,
 *   holes: Array<Array<{lat: number, lon: number}>>}>}
 */
export function ringsToDegrees(rings, deg = GRID_DEG) {
  return (rings || []).map((ring) => ({
    outer: ring.outer.map(([i, j]) => ({
      lat: i * deg,
      lon: j * deg,
    })),
    holes: (ring.holes || []).map((hole) =>
      hole.map(([i, j]) => ({ lat: i * deg, lon: j * deg })),
    ),
  }));
}

/**
 * The centre and the rectangle of a grid cell.
 *
 * Both come from the same floored index the join uses, never from rounding a
 * coordinate: the centre is `index * step + step / 2`, which is the cell the
 * index names.
 *
 * @param {number} i Row index (latitude).
 * @param {number} j Column index (longitude).
 * @returns {{lat: number, lon: number,
 *   bounds: {west: number, south: number, east: number, north: number}}}
 */
function cellGeometry(i, j) {
  return {
    lat: i * GRID_DEG + GRID_DEG / 2,
    lon: j * GRID_DEG + GRID_DEG / 2,
    // Ordered as Cesium's `Rectangle.fromDegrees` takes them, so the renderer
    // does not have to reorder the numbers and cannot reorder them wrongly.
    bounds: {
      west: j * GRID_DEG,
      south: i * GRID_DEG,
      east: (j + 1) * GRID_DEG,
      north: (i + 1) * GRID_DEG,
    },
  };
}

/**
 * The REPORTED swath: cells painted by the largest hail measured in them.
 *
 * Every cell is a stone somebody reported. A cell with no report is not drawn
 * at all — that is the whole contract of the REPORTED layer — which is why
 * `hailFloor` exists: a trace of 0.01" is a measurement, but painting the map
 * for it would say hail fell where nothing was ever seen.
 *
 * The key is the canonical `i:j`, so these cells join the radar field and the
 * cross-reference and nothing else.
 *
 * @param {Array<{hazard: string, size: number|null, lat: number, lon: number}>} reports
 * @param {{hailFloor?: number}} [options] Smallest measured hail, in inches,
 *   that may paint. Default 0 keeps every measured stone; to match the
 *   category's lowest band, pass 0.75.
 * @returns {Array<{key: string, i: number, j: number, peak: number,
 *   count: number, band: object|null, lat: number, lon: number,
 *   bounds: {west: number, south: number, east: number, north: number}}>}
 *   Worst first, so a renderer that stops early stops on the strong cells.
 */
export function reportedSwathCells(reports, { hailFloor = 0 } = {}) {
  const floor = Number.isFinite(hailFloor) ? hailFloor : 0;
  const cells = new Map();
  for (const report of reports || []) {
    if (!report || report.hazard !== 'hail') continue;
    if (!Number.isFinite(report.size) || report.size < floor) continue;
    if (!Number.isFinite(report.lat) || !Number.isFinite(report.lon)) continue;
    const i = gridCell(report.lat);
    const j = gridCell(report.lon);
    const key = `${i}:${j}`;
    const cell = cells.get(key);
    if (cell) {
      cell.count += 1;
      // The largest stone wins the cell's colour: a cell is a claim about the
      // worst hail in it, not about whichever report arrived first.
      if (report.size > cell.peak) cell.peak = report.size;
      continue;
    }
    cells.set(key, {
      key,
      i,
      j,
      peak: report.size,
      count: 1,
      ...cellGeometry(i, j),
    });
  }
  return [...cells.values()]
    .map((cell) => ({ ...cell, band: hailBand(cell.peak) }))
    .sort((a, b) => b.peak - a.peak || (a.key < b.key ? -1 : 1));
}

/**
 * The band a radar reading paints in the prospecting view, or null under an inch.
 * @param {number} peakMm
 * @returns {object|null}
 */
export function prospectBand(peakMm) {
  if (!Number.isFinite(peakMm) || peakMm < PROSPECT_MM_FLOOR) return null;
  for (const band of PROSPECT_BANDS) if (peakMm >= band.min) return band;
  return PROSPECT_BANDS[PROSPECT_BANDS.length - 1];
}

/**
 * Great-circle distance in kilometres. See {@link prospectSwathCells}.
 * @returns {number}
 */
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Radar cells that cleared the hail threshold, where nobody reported hail.
 *
 * This is the whole prospecting view and it needs no demographic data: the
 * radar says hail fell, the reports say where people were, and the difference is
 * a lead. Every input already ships with this layer - the radar field and the
 * human reports - so this is a comparison between two things already measured,
 * not a model of a third thing nobody counted.
 *
 * Two floors, deliberately different, and conflating them is the bug this
 * function exists to avoid:
 * - `thresholdMm` on the RADAR side, because the radar measures a millimetre
 *   column and 25.4 mm IS one inch;
 * - `thresholdIn` on the REPORT side, because a report is a diameter someone
 *   held in their hand and 1.0" is a diameter anyone would have bothered to
 *   report. Asking a radar cell to beat 1 inch as a millimetre column would
 *   throw away every cell between 25.4 and 38.1 mm - which is most of them.
 *
 * A cell is claimed by ANY qualifying report within `radiusKm` of its CENTRE,
 * and the test is against the radar reading, never against the report's own
 * cell. Substituting one for the other would make a report exactly one cell
 * wide - 25 miles across - so a township of storm with one hailstone logged in
 * its corner would still paint as "unsuppressed" everywhere else.
 *
 * @param {Array<object>} radarCells swath cells from `radarSwathCells`
 * @param {Array<object>} reports decoded reports; only hail at or above
 *   `thresholdIn` with a position can claim a cell
 * @param {object} [options]
 * @param {number} [options.thresholdMm] radar floor, in millimetres
 * @param {number} [options.thresholdIn] report floor, in inches
 * @param {number} [options.radiusKm] claiming radius around a cell's centre
 * @param {number} [options.stepDeg] the grid the cells are indexed on
 * @returns {Array<object>} the unclaimed cells, worst first, banded
 */
export function prospectSwathCells(radarCells, reports, options = {}) {
  const {
    thresholdMm = PROSPECT_MM_FLOOR,
    thresholdIn = PROSPECT_IN_FLOOR,
    radiusKm = PROSPECT_RADIUS_KM,
    stepDeg = GRID_DEG,
  } = options;
  if (!Array.isArray(radarCells) || !radarCells.length) return [];
  const claims = [];
  for (const report of reports || []) {
    if (!report || report.hazard !== 'hail') continue;
    if (!Number.isFinite(report.size) || report.size < thresholdIn) continue;
    if (!Number.isFinite(report.lat) || !Number.isFinite(report.lon)) continue;
    claims.push([report.lat, report.lon]);
  }
  const unclaimed = [];
  for (const cell of radarCells) {
    // An implausible reading is greyed everywhere else on the strength of
    // "somebody measured that". Nobody measured it, so it is not evidence that
    // hail fell, and painting it as a lead would be the whole failure this view
    // is most vulnerable to.
    if (!cell || cell.implausible) continue;
    const peakMm = Number(cell.peakMm);
    if (!Number.isFinite(peakMm) || peakMm < thresholdMm) continue;
    const lat = cell.i * stepDeg + stepDeg / 2;
    const lon = cell.j * stepDeg + stepDeg / 2;
    // Reject on the bounding box before paying for the haversine. Over a
    // multi-day window this loop is cells x claims - 5,000 x 5,000 - and
    // almost every pair is thousands of kilometres apart, so the cheap reject
    // is what keeps the chip from costing a second on every publish. The box
    // is derived from the radius itself, so it can only ever be wrong by the
    // curvature a great circle adds, which makes it conservative: it admits a
    // few extra pairs, it never discards a real one.
    const latSpan = radiusKm / 111.32;
    const lonSpan =
      radiusKm / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
    let claimed = false;
    for (const [claimLat, claimLon] of claims) {
      if (Math.abs(claimLat - lat) > latSpan) continue;
      if (Math.abs(claimLon - lon) > lonSpan) continue;
      if (distanceKm(lat, lon, claimLat, claimLon) <= radiusKm) {
        claimed = true;
        break;
      }
    }
    if (claimed) continue;
    unclaimed.push({ ...cell, lat, lon, band: prospectBand(peakMm) });
  }
  return unclaimed.sort(
    (a, b) => b.peakMm - a.peakMm || (a.key < b.key ? -1 : 1),
  );
}

/**
 * The approximate area, in square kilometres, of a set of grid cells.
 *
 * Latitude is not cosmetic here: a one-degree cell at 25 degrees north is
 * about 1,030 km square and at 45 it is about 790, so a flat sum overstates a
 * national view by around a quarter and understates the tropics by the same.
 * Labelled approximate everywhere it surfaces, because the cell is a tile, not
 * a survey.
 * @param {Array<object>} cells
 * @param {number} stepDeg
 * @returns {number}
 */
export function gridAreaKm2(cells, stepDeg) {
  const kmPerDeg = 111.32;
  let total = 0;
  for (const cell of cells || []) {
    const lat = cell.lat;
    if (!Number.isFinite(lat)) continue;
    total +=
      stepDeg * kmPerDeg * stepDeg * kmPerDeg * Math.cos((lat * Math.PI) / 180);
  }
  return total;
}

/**
 * The cells a decoded radar structure holds for one calendar day, or null.
 *
 * Accepts `toRadarDays`'s `{date, cells: Map<'i:j', number>}` and a Map keyed
 * by date to one of those. A bare cell map names no calendar day, so it can
 * never match the day being drawn and yields nothing: a swath has to know which
 * day it is, or it is a lifetime fallback wearing a per-day label.
 *
 * @param {object|Map} radarDays
 * @param {string|null} date
 * @returns {Map<string, number>|null}
 */
function radarCellsFor(radarDays, date) {
  if (radarDays instanceof Map) {
    const day = radarDays.get(date);
    if (day === undefined) return null;
    return day instanceof Map ? day : (day?.cells ?? null);
  }
  if (!radarDays || typeof radarDays !== 'object') return null;
  if (radarDays.date !== date) return null;
  return radarDays.cells instanceof Map ? radarDays.cells : null;
}

/**
 * The RADAR swath for one day: cells coloured by that day's peak radar hail.
 *
 * `radarDays` is the decoded day the loader produces, passed in as a plain
 * structure rather than imported, so this model owns no loader. `date` is the
 * calendar day it must be: a structure whose date does not match draws nothing,
 * because the failure this guards is a swath that silently sums every day in the
 * archive and reads as one storm.
 *
 * Cells at or above `implausibleMm` are flagged, not dropped. Dropping them
 * would leave holes in the grid, and a hole reads as "no hail here" when the
 * truth is "the estimate here is not believable". The renderer styles them
 * apart.
 *
 * @param {object|Map} radarDays `{date, cells: Map<'i:j', number>}`, or a Map
 *   from date to such a day.
 * @param {{date?: string|null, implausibleMm?: number}} [options] `date` is the
 *   day this swath describes; `implausibleMm` defaults to
 *   {@link RADAR_IMPLAUSIBLE_MM}.
 * @returns {Array<{key: string, i: number, j: number, peakMm: number,
 *   implausible: boolean, lat: number, lon: number,
 *   bounds: {west: number, south: number, east: number, north: number}}>}
 *   Worst first.
 */
/**
 * Pool a set of fine cells into a coarser grid, keeping the MAXIMUM.
 *
 * MAXIMUM and not the mean, and the reason is the field's own meaning: a
 * cell's value is the biggest hail that fell in it, so the biggest hail in
 * five cells is the biggest hail in the cell they become. Averaging would
 * answer a different question - how much hail fell on average - and would
 * dissolve the cores the bands are drawn from.
 *
 * The pooling is by `floor(i / factor)`, which is correct for negative
 * indices too: the fine cell `-1` spans [-0.01, 0) and the cell `-5` spans
 * [-0.05, -0.04), and a floor puts each of them where it belongs.
 *
 * @param {Array<{i: number, j: number, maxMm?: number, peakMm?: number}>} cells
 * @param {number} [factor] how many fine cells to a side
 * @returns {Array<{key: string, i: number, j: number, maxMm: number}>}
 */
export function downsampleMaxCells(cells, factor = 5) {
  const out = new Map();
  for (const cell of cells || []) {
    const i = Number(cell?.i);
    const j = Number(cell?.j);
    const mm = Number(cell?.maxMm ?? cell?.peakMm);
    if (!Number.isInteger(i) || !Number.isInteger(j) || !Number.isFinite(mm)) {
      continue;
    }
    const row = Math.floor(i / factor);
    const column = Math.floor(j / factor);
    const key = `${row}:${column}`;
    const held = out.get(key);
    // The field is `maxMm`, because that is what the fine path reads: a
    // pooled cell that carried `peakMm` would arrive as a reading of zero and
    // the mid tier would draw nothing at all.
    if (!held || mm > held.maxMm) {
      out.set(key, { key, i: row, j: column, maxMm: mm });
    }
  }
  return [...out.values()];
}

export function radarSwathCells(
  radarDays,
  { date = null, implausibleMm = RADAR_IMPLAUSIBLE_MM } = {},
) {
  // Fall back to the structure's own date only when the caller did not name a
  // day; a bare cell map has none, so it never matches and draws nothing.
  const wanted =
    date ?? (radarDays && !(radarDays instanceof Map) ? radarDays.date : null);
  const cells = wanted ? radarCellsFor(radarDays, wanted) : null;
  if (!cells) return [];
  const threshold = Number.isFinite(implausibleMm)
    ? implausibleMm
    : RADAR_IMPLAUSIBLE_MM;
  const out = [];
  for (const [key, value] of cells) {
    const peakMm = Number(value);
    if (!Number.isFinite(peakMm)) continue;
    const [i, j] = String(key).split(':').map(Number);
    if (!Number.isInteger(i) || !Number.isInteger(j)) continue;
    out.push({
      key,
      i,
      j,
      peakMm,
      implausible: peakMm >= threshold,
      ...cellGeometry(i, j),
    });
  }
  return out.sort((a, b) => b.peakMm - a.peakMm || (a.key < b.key ? -1 : 1));
}

/* -------------------------------------------------------------------------
 * Iso-contouring the radar field.
 *
 * WHY THIS EXISTS. `gridCellRings` asks a yes/no question per cell - is it in
 * the set - and traces the boundary of that set, so the edge steps from corner
 * to corner and a 25-mile storm comes out as a staircase. Every commercial map
 * in this space draws concentric smooth rings instead, because the smooth line
 * is what the eye reads as a storm.
 *
 * So this asks a different question: where does the field CROSS a value. The
 * answer is a real line between cells, found by linear interpolation, which is
 * also more honest than the staircase - the staircase is a statement about the
 * sampling grid, and a storm that fell between two cells has an edge that
 * genuinely is between them.
 *
 * THE HONEST LIMIT, which belongs next to the drawing and not only here: the
 * value per cell is `maxMm`, the MAXIMUM over that cell's 1 km cores, not a
 * mean. Interpolating a maximum gives a smooth envelope around the worst hail,
 * not the extent of the worst hail. It traces a storm's SHAPE faithfully and
 * its EDGE optimistically. The legend says so; see `CONTOUR_CAVEAT`.
 * ---------------------------------------------------------------------- */

/** The caveat a contour-derived swath must carry wherever it is explained. */
export const CONTOUR_CAVEAT =
  'Edge interpolated between radar cells, not measured. The stored value per ' +
  'cell is the largest hail in that cell, so the line traces the shape of the ' +
  'storm and may sit outside the true edge of the worst hail.';

/**
 * How far a contour vertex is rounded when segments are chained.
 *
 * Two adjacent squares compute their shared crossing point from opposite
 * directions - one walks a->b, the other c->d - so the two floats differ in the
 * last bits. Chaining on exact equality would drop the ring on every shared
 * edge. 1e-9 of a cell is a nanometre and rounds away nothing that matters.
 */
const CHAIN_EPSILON = 1e-9;

/** The key two vertices share, for chaining segments into rings. */
function chainKey(y, x) {
  return `${Math.round(y / CHAIN_EPSILON)}:${Math.round(x / CHAIN_EPSILON)}`;
}

/**
 * The four squares a sample belongs to, as offsets to that square's LOWER-LEFT
 * corner, in (i, j).
 *
 * A sample at (si, sj) is the lower-left of one square, the lower-right of
 * another, the upper-right of a third and the upper-left of the fourth, so two
 * of these offsets are negative. Taking only the positive pair - which is the
 * obvious thing to type - enumerates the squares where the sample is a lower or
 * left corner and silently drops the other half, and a boundary drawn from half
 * its squares is an open polyline, not a closed shape.
 */
const SQUARE_OFFSETS = Object.freeze([
  [0, 0],
  [0, -1],
  [-1, -1],
  [-1, 0],
]);

/**
 * The rings at a given value in a gridded field, in degrees.
 *
 * @param {Array<{i: number, j: number, v?: number, peakMm?: number}>} cells
 *   cells carrying their index and the value to contour
 * @param {number} isoValue the level to draw, in the same units as `v`
 * @param {number} [deg] the grid step in degrees
 * @returns {Array<{outer: Array<{lat: number, lon: number}>,
 *   holes: Array<Array<{lat: number, lon: number}>>}>}
 */
export function contourRings(cells, isoValue, deg = GRID_DEG) {
  if (!Array.isArray(cells) || !cells.length) return [];
  if (!Number.isFinite(isoValue)) return [];

  // One value per sample, keeping the larger where two cells collide. A
  // missing sample reads as 0, which is correct rather than merely convenient:
  // the field IS below the iso value out there, and treating absence as "at the
  // threshold" would make every empty region exactly borderline.
  const value = new Map();
  for (const cell of cells) {
    const i = Number(cell?.i);
    const j = Number(cell?.j);
    if (!Number.isInteger(i) || !Number.isInteger(j)) continue;
    const v = Number(cell.v ?? cell.peakMm);
    if (!Number.isFinite(v)) continue;
    const key = `${i}:${j}`;
    const held = value.get(key);
    if (held === undefined || v > held) value.set(key, v);
  }
  if (!value.size) return [];
  const at = (i, j) => value.get(`${i}:${j}`) ?? 0;

  /** Segments in grid space, each oriented so the inside is on the LEFT. */
  const segments = [];

  /**
   * Emit one segment, keeping the higher side on the left.
   *
   * Deriving the winding from the geometry instead of hand-writing a sixteen
   * row case table is the whole point: the table version is where marching
   * squares implementations get their inverted rings, and a hole that arrives
   * wound the right way round renders as a filled disc.
   */
  const emit = (from, to, inside) => {
    if (!from || !to || !inside) return;
    const midY = (from[0] + to[0]) / 2;
    const midX = (from[1] + to[1]) / 2;
    const dirY = to[0] - from[0];
    const dirX = to[1] - from[1];
    // Cross product in (x, y) order, because that is the order the sign
    // convention is defined in: positive means `to` lies to the LEFT of the
    // direction of travel. Written as (dirX * toY - dirY * toX) - the other way
    // round is the negation of this, which inverts every ring while still
    // producing closed loops, so the shape looks fine until a hole arrives.
    const cross = dirX * (inside[0] - midY) - dirY * (inside[1] - midX);
    segments.push(cross < 0 ? { from: to, to: from } : { from, to });
  };

  // Every square that TOUCHES a sample, deduplicated.
  //
  // Walking the samples and visiting each one's four squares instead looks
  // equivalent and is not: a square in the middle of a storm has four samples
  // on it, so it gets visited four times and each of its boundary segments is
  // emitted four times. Chaining then produces four overlapping rings at the
  // same place, and the shape renders as a mess of coincident outlines - which
  // looked exactly like "the contour found nothing" when it was really "the
  // contour found everything, four times".
  const squares = new Set();
  for (const key of value.keys()) {
    const [si, sj] = key.split(':').map(Number);
    for (const [di, dj] of SQUARE_OFFSETS) squares.add(`${si + di}:${sj + dj}`);
  }
  for (const square of squares) {
    const [i0, j0] = square.split(':').map(Number);
    {
      // Corners in (y, x): a bottom-left, b bottom-right, c top-right, d top-left.
      const aV = at(i0, j0);
      const bV = at(i0, j0 + 1);
      const cV = at(i0 + 1, j0 + 1);
      const dV = at(i0 + 1, j0);
      if (aV < isoValue && bV < isoValue && cV < isoValue && dV < isoValue)
        continue;

      // Where a value crosses the level along an edge, linearly interpolated.
      const along = (v0, v1) => {
        const span = v1 - v0;
        if (span === 0) return isoValue >= v1 ? 0.5 : 0;
        const t = (isoValue - v0) / span;
        return t < 0 ? 0 : t > 1 ? 1 : t;
      };
      const ab = [i0, j0 + along(aV, bV)];
      const bc = [i0 + along(bV, cV), j0 + 1];
      const cd = [i0 + 1, j0 + 1 - along(cV, dV)];
      const da = [i0 + 1 - along(dV, aV), j0];

      const insideA = aV >= isoValue;
      const insideB = bV >= isoValue;
      const insideC = cV >= isoValue;
      const insideD = dV >= isoValue;
      // The mean of a known-inside sample and the known outside one, used only
      // as a stable "which side is this" anchor for the winding.
      // A REAL interior sample, not one of the crossing points. A crossing
      // point lies ON the boundary, so using one as the reference for "which
      // side is inside" gives a cross product of zero and the winding silently
      // defaults to whatever order the two crossings happened to be pushed in -
      // which is consistent within a square and inconsistent between them, so
      // the segments do not chain.
      const anchor = insideA
        ? [i0, j0]
        : insideB
          ? [i0, j0 + 1]
          : insideC
            ? [i0 + 1, j0 + 1]
            : [i0 + 1, j0];
      const crossings = [];
      if (insideA !== insideB) crossings.push([ab, insideA]);
      if (insideB !== insideC) crossings.push([bc, insideB]);
      if (insideC !== insideD) crossings.push([cd, insideC]);
      if (insideD !== insideA) crossings.push([da, insideD]);

      if (crossings.length === 2) {
        emit(crossings[0][0], crossings[1][0], anchor);
        continue;
      }
      if (crossings.length !== 4) continue;

      // SADDLE: two inside corners diagonal from each other. Which pair the
      // contour joins is decided by the field at the square's centre, which is
      // the asymptotic decider. Getting this wrong closes a hole or opens one
      // that is not there, so it is not a corner case - a ring-shaped storm
      // passes straight through here.
      const centreInside = (aV + bV + cV + dV) / 4 >= isoValue;
      const opposite = insideA !== insideB && insideB !== insideC;
      // `opposite` true means the inside corners are a diagonal pair.
      const wrapInside = opposite ? !centreInside : centreInside;
      const anchorB = insideB ? [i0, j0 + 1] : anchor;
      const anchorC = insideC ? [i0 + 1, j0 + 1] : anchor;
      const anchorD = insideD ? [i0 + 1, j0] : anchor;
      // When the inside regions are joined, each inside corner gets its own
      // short segment around it; when they are cut apart, the contour wraps the
      // two OUTSIDE corners instead.
      if (wrapInside) {
        // Each inside corner gets a short segment hugging it.
        if (insideA) emit(ab, da, anchor);
        if (insideC) emit(bc, cd, anchorC);
        if (insideB) emit(ab, bc, anchorB);
        if (insideD) emit(cd, da, anchorD);
      } else {
        // The two inside corners are split apart, so the contour wraps each
        // OUTSIDE corner instead.
        emit(ab, bc, insideB ? [i0, j0 + 1] : anchorB);
        emit(cd, da, insideD ? [i0 + 1, j0] : anchorD);
      }
    }
  }
  if (!segments.length) return [];

  const rings = chainSegments(segments);
  if (!rings.length) return [];

  // Signed area decides outer from hole: the winding rule puts both on the same
  // side, so outers come out positive and holes negative.
  const outers = [];
  const holes = [];
  for (const ring of rings) {
    (ring.area >= 0 ? outers : holes).push(ring);
  }
  holes.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

  return outers.map((outer) => ({
    outer: outer.pts.map(([y, x]) => ({
      lat: y * deg + deg / 2,
      lon: x * deg + deg / 2,
    })),
    holes: holes
      // One VERTEX of the hole, not the whole vertex list. Passing the array
      // destructures its first two elements - two points - and reads them as a
      // coordinate pair, so the containment test is arithmetic on arrays: it
      // silently returned false and every hole was dropped, which renders an
      // annulus as a filled disc.
      .filter(
        (hole) => hole.pts.length && pointInRingGrid(hole.pts[0], outer.pts),
      )
      .map((hole) =>
        hole.pts.map(([y, x]) => ({
          lat: y * deg + deg / 2,
          lon: x * deg + deg / 2,
        })),
      ),
  }));
}

/** Follow segments end to end until they close or run out. */
function chainSegments(segments) {
  const byStart = new Map();
  const used = new Set();
  for (let index = 0; index < segments.length; index += 1) {
    const key = chainKey(segments[index].from[0], segments[index].from[1]);
    if (!byStart.has(key)) byStart.set(key, []);
    byStart.get(key).push(index);
  }
  const rings = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (used.has(index)) continue;
    const pts = [];
    let current = index;
    const startKey = chainKey(
      segments[current].from[0],
      segments[current].from[1],
    );
    while (current !== undefined && !used.has(current)) {
      used.add(current);
      const segment = segments[current];
      pts.push(segment.from, segment.to);
      const nextKey = chainKey(segment.to[0], segment.to[1]);
      if (nextKey === startKey) break;
      const candidates = byStart.get(nextKey) || [];
      current = candidates.find((candidate) => !used.has(candidate));
    }
    if (pts.length < 3) continue;
    const deduped = pts.filter(
      (point, at) =>
        at === 0 ||
        chainKey(point[0], point[1]) !==
          chainKey(pts[at - 1][0], pts[at - 1][1]),
    );
    if (deduped.length < 3) continue;
    // Drop vertices that lie on the straight line between their neighbours.
    //
    // A contour crosses every grid EDGE, so a run of six cells along the bottom
    // of a storm yields six vertices where four would describe the same line.
    // Measured on a real day that is the difference between 3,584 vertices and
    // 9,949 for the same shapes: the staircase looked cheaper only because it
    // collapsed straight runs, and none of that work is done for free by Cesium.
    const simplified = dropCollinear(deduped);
    if (simplified.length < 3) continue;
    const area = signedArea(simplified);
    // ZERO AREA IS NOT A BUG. A cell reading exactly the level - 25.4 mm, one
    // inch - has its crossing at the sample itself, so the set "at or above an
    // inch" around it has no area, and a ring with no area is not a shape. The
    // staircase drew a whole 1 km cell for it, which OVERSTATES the region: a
    // cell that is exactly on the line contributes nothing to the region above
    // it. 54 of 9,613 cells on 2024-04-26 read exactly 25.4, so this is 1.45%
    // of a day disappearing, and it is disappearing for the right reason.
    if (area === 0) continue;
    rings.push({ pts: simplified, area });
  }
  return rings;
}

/**
 * Drop vertices that sit on the straight line between their neighbours.
 *
 * Keeps the first and last vertices so the ring still reads as closed, and
 * never returns fewer than a triangle, because Cesium rejects a polygon with
 * fewer than three positions and a two-point "ring" is a line segment.
 * @param {Array<[number, number]>} pts a closed ring, last point repeating the
 *   first
 * @returns {Array<[number, number]>}
 */
function dropCollinear(pts) {
  const last = pts.length - 1;
  const closed = pts[0][0] === pts[last][0] && pts[0][1] === pts[last][1];
  const body = closed ? pts.slice(0, last) : pts;
  if (body.length < 3) return pts;
  const kept = [];
  for (let at = 0; at < body.length; at += 1) {
    const previous = body[(at - 1 + body.length) % body.length];
    const point = body[at];
    const next = body[(at + 1) % body.length];
    const cross =
      (point[0] - previous[0]) * (next[1] - point[1]) -
      (point[1] - previous[1]) * (next[0] - point[0]);
    // Scaled to the ring's own size so "nearly straight" means nearly straight
    // at 1 km and at 25 miles alike, rather than a tolerance tuned for one grid.
    const scale =
      Math.abs(point[0] - previous[0]) + Math.abs(point[1] - previous[1]) + 1;
    if (Math.abs(cross) > 1e-9 * scale) kept.push(point);
  }
  if (kept.length < 3) return pts;
  return closed ? [...kept, kept[0]] : kept;
}

/** Twice the signed area, in grid units. Positive is counter-clockwise. */
function signedArea(pts) {
  let total = 0;
  for (let at = 0; at < pts.length; at += 1) {
    const [y0, x0] = pts[at];
    const [y1, x1] = pts[(at + 1) % pts.length];
    total += x0 * y1 - x1 * y0;
  }
  return total / 2;
}

/**
 * Whether a point is inside a ring, on the grid's own coordinates.
 *
 * @param {[number, number]} point one [y, x] vertex, NOT a list of them
 * @param {Array<[number, number]>} ring
 */
function pointInRingGrid(point, ring) {
  const [py, px] = point;
  let inside = false;
  for (
    let at = 0, previous = ring.length - 1;
    at < ring.length;
    previous = at++
  ) {
    const [y0, x0] = ring[previous];
    const [y1, x1] = ring[at];
    if (y0 > py !== y1 > py) {
      const cross = ((x1 - x0) * (py - y0)) / (y1 - y0) + x0;
      if (px < cross) inside = !inside;
    }
  }
  return inside;
}

/**
 * The address lookup.
 *
 * THE DESK CAN FIND A PLACE BY NAME. It could not find an ADDRESS, and an
 * address is what a canvasser has: they are standing on a doorstep with a
 * number and a street, and the question is what fell on it.
 *
 * The answer is assembled from four things the repo already holds:
 *
 *   - the TIGER EDGES address ranges, which say which house numbers are on
 *     which street and where that street is;
 *   - the 1 km MRMS field, which says where hail fell on which day;
 *   - the swaths artifact, which says which tracts the radar reached on which
 *     day and how much of the tract was under the hail;
 *   - the report archive, which says what was measured, by whom, and when.
 *
 * THE GEOCODE IS A MATCH, NOT A LOOKUP. A house number is an interval on a
 * street, not a point, so the answer is a point on the segment and an
 * interpolation of where in the range the number falls. There is no national
 * address database here to look it up in, and the segments are the data this
 * repo already has.
 *
 * The days are then the EXACT ones: the tract says which days to look at, and
 * the fine field says whether the cell under the address itself was over the
 * threshold that day. That distinction is the whole product in the rural
 * case: a tract can be four thousand square kilometres, and the hail can
 * have crossed one cell of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { decodeRing, pointInRing } from '../../src/data/adminBoundaries.js';
import { indexFineDay } from '../../src/data/stormReports.js';
import { RADAR_FINE_GRID } from '../../src/data/stormDatasets.js';
import { countyEdges } from './tigerStreets.js';
import { countyTractIndex } from './deskTracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const STORM_DIR = path.join(REPO, 'src/data/local_data/storm');
const COUNTIES_FILE = path.join(
  REPO,
  'src/data/local_data/us_census_counties/counties.json',
);
const SWATHS_FILE = path.join(
  REPO,
  'apps/hail-desk/public/data/swaths.json.gz',
);
const CITIES_FILE = path.join(
  REPO,
  'apps/hail-desk/public/data/cities.json.gz',
);
const COUNTIES_FILE_ARTIFACT = path.join(
  REPO,
  'apps/hail-desk/public/data/counties.json.gz',
);

/** The hail the product draws, in millimetres. */
const HAIL_THRESHOLD_MM = 25.4;

/** How close a report has to be to count as "at this address". */
const REPORT_RADIUS_KM = 5;

/** The number of address matches to return. */
const MAX_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// The pieces that are read once and kept.
// ---------------------------------------------------------------------------

let counties = null;
let swaths = null;
let places = null;
let countySizes = null;
const fineDays = new Map();

/**
 * The places, by name, with their centres.
 *
 * Only the name and the centre are kept: the artifact is 32,607 places and
 * the join needs a place's coordinates to find the county it sits in.
 *
 * @returns {Map<string, {lat: number, lon: number}>}
 */
function placeIndex() {
  if (places) return places;
  const payload = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(CITIES_FILE)).toString('utf8'),
  );
  places = new Map();
  for (const place of payload.cities || []) {
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) continue;
    for (const name of [place.full, place.name]) {
      if (!name) continue;
      places.set(String(name).toLowerCase(), { lat: place.lat, lon: place.lon });
    }
  }
  return places;
}

/**
 * The counties, with their rings decoded.
 *
 * @returns {Array<object>} each with `geoid`, `st`, `name` and `rings`
 */
function countyIndex() {
  if (counties) return counties;
  const pack = JSON.parse(fs.readFileSync(COUNTIES_FILE, 'utf8'));
  const decimals = pack.meta?.decimals ?? 4;
  counties = (pack.features || [])
    .map((feature) => ({
      geoid: String(feature.geoid),
      st: String(feature.st || ''),
      name: String(feature.full || feature.name || ''),
      rings: (feature.polygons || []).map((polygon) =>
        polygon.map((ring) => decodeRing(ring, feature.d ?? decimals)),
      ),
    }))
    .filter((county) => county.rings.length);
  return counties;
}

/**
 * The swaths, indexed by tract and by day.
 *
 * @returns {{byTract: Map<string, Array<object>>, byDay: Map<string, object>}}
 */
function swathIndex() {
  if (swaths) return swaths;
  const payload = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(SWATHS_FILE)).toString('utf8'),
  );
  const byTract = new Map();
  const byDay = new Map();
  for (const row of payload.rows || []) {
    const tract = String(row.g);
    if (!byTract.has(tract)) byTract.set(tract, []);
    byTract.get(tract).push(row);
    if (!byDay.has(row.d)) byDay.set(row.d, { houses: 0, units: 0, tracts: 0 });
    const day = byDay.get(row.d);
    day.houses += row.h ?? row.u ?? 0;
    day.units += row.u ?? 0;
    day.tracts += 1;
  }
  swaths = { byTract, byDay };
  return swaths;
}

/**
 * One day's fine 1 km field, decoded, kept.
 *
 * @param {string} day ISO `YYYY-MM-DD`
 * @returns {Array<object>|null} the cells
 */
function fineDay(day) {
  if (fineDays.has(day)) return fineDays.get(day);
  const file = path.join(STORM_DIR, `storm_radar_hail_fine_${day}.bin.gz`);
  let cells = null;
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(file));
    cells = indexFineDay(new Uint8Array(raw)).cells;
  } catch {
    // A day with no shard is a day outside the retention window, and the
    // answer is "no shard for that day", not an error.
    cells = null;
  }
  fineDays.set(day, cells);
  return cells;
}

// ---------------------------------------------------------------------------
// The geocode.
// ---------------------------------------------------------------------------

/**
 * Pull a house number and a street out of a query.
 *
 * A person types "123 Main St, Colorado Springs" or "123 Main St" with a
 * place already chosen in the desk. The number is the first thing that looks
 * like one; the street is what is left of the first clause.
 *
 * @param {string} query
 * @returns {{number: number|null, street: string, place: string}}
 */
export function parseAddressQuery(query) {
  const text = String(query || '').trim();
  if (!text) return { number: null, street: '', place: '' };
  const [head, ...rest] = text.split(',');
  const first = head.trim();
  const place = rest.join(',').trim();
  const match = first.match(/^\s*(\d+)\s+(.*)$/);
  if (!match) return { number: null, street: first, place };
  return { number: Number(match[1]), street: match[2].trim(), place };
}

/**
 * The county a place sits in.
 *
 * The place's CENTROID is the test, and a place that straddles a county
 * line is resolved to the one that holds its centre - which is the county a
 * canvasser knocking there would be knocking in.
 *
 * @param {string} place the place's name
 * @param {string} state the two-letter postal code
 * @returns {object|null} the county
 */
export function countyForPlace(place, state) {
  const name = String(place || '').trim().toLowerCase();
  if (!name) return biggestCounty(state);
  const centre = placeIndex().get(name);
  if (!centre) return null;
  // The place's CENTROID decides, and the county's own boundary is the test.
  // A place that straddles a county line is resolved to the one holding its
  // centre, which is the county a canvasser knocking there is knocking in.
  for (const county of countyIndex()) {
    if (county.st !== state) continue;
    for (const part of county.rings) {
      const [outer, ...holes] = part;
      if (!outer || !pointInRing(outer, centre.lat, centre.lon)) continue;
      if (holes.some((hole) => pointInRing(hole, centre.lat, centre.lon))) continue;
      return county;
    }
  }
  return null;
}

/**
 * The biggest county in a state, by its housing units.
 *
 * The fallback when the query names no place: the address is looked up in the
 * county that holds most of the state's people, which is the county a
 * canvasser is most likely to mean.
 *
 * @param {string} state the two-letter postal code
 * @returns {object|null} the county
 */
function biggestCounty(state) {
  if (!countySizes) {
    countySizes = new Map();
    try {
      const payload = JSON.parse(
        zlib.gunzipSync(fs.readFileSync(COUNTIES_FILE_ARTIFACT)).toString('utf8'),
      );
      for (const row of payload.rows || []) {
        countySizes.set(String(row.fips), {
          st: String(row.st || ''),
          units: Number(row.units) || 0,
        });
      }
    } catch {
      countySizes = new Map();
    }
  }
  let best = null;
  for (const [fips, info] of countySizes) {
    if (info.st !== state) continue;
    if (!best || info.units > best.units) best = { fips, units: info.units };
  }
  if (!best) return null;
  const found = countyIndex().find(
    (county) => county.geoid === best.fips,
  );
  return found || null;
}

/**
 * The names of the county's streets, lower-cased.
 *
 * @param {string} state the two-digit FIPS
 * @param {string} county the three-digit FIPS
 * @returns {Promise<Set<string>>}
 */
async function streetNames(state, county) {
  const edges = await countyEdges(state, county);
  return new Set(edges.map((edge) => String(edge.name || '').toLowerCase()));
}

/**
 * The point on a street that a house number falls at.
 *
 * The range is an interval of house numbers along the segment, and the
 * fraction of the segment is the fraction of the range. The distance is
 * measured along the segment, not in vertices, because a street with a
 * hundred short edges and a street with four long ones are both streets.
 *
 * @param {Array<number>} points flat [lon, lat, ...]
 * @param {number} fraction 0 to 1
 * @returns {{lon: number, lat: number}|null}
 */
export function pointAlongSegment(points, fraction) {
  if (!Array.isArray(points) || points.length < 4) return null;
  const metres = 111320;
  const segments = [];
  let total = 0;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const dx =
      (points[i + 2] - points[i]) * metres * Math.cos((points[i + 1] * Math.PI) / 180);
    const dy = (points[i + 3] - points[i + 1]) * metres;
    const length = Math.hypot(dx, dy);
    segments.push(length);
    total += length;
  }
  if (!total) return null;
  let target = Math.max(0, Math.min(1, fraction)) * total;
  for (let i = 0; i < segments.length; i += 1) {
    if (target <= segments[i] || i === segments.length - 1) {
      const within = segments[i] ? target / segments[i] : 0;
      const at = i * 2;
      return {
        lon: points[at] + (points[at + 2] - points[at]) * within,
        lat: points[at + 1] + (points[at + 3] - points[at + 1]) * within,
      };
    }
    target -= segments[i];
  }
  return null;
}

/**
 * The candidate points for a house number and a street.
 *
 * @param {object} input
 * @param {string} input.state the two-digit FIPS
 * @param {string} input.county the three-digit FIPS
 * @param {number} input.number the house number
 * @param {string} input.street the street name
 * @returns {Promise<Array<object>>} the candidates, the best first
 */
export async function geocodeAddress({ state, county, number, street }) {
  const edges = await countyEdges(state, county);
  const wanted = String(street || '').trim().toLowerCase();
  if (!wanted) return [];
  const candidates = [];
  for (const edge of edges) {
    const name = String(edge.name || '').toLowerCase();
    if (!name) continue;
    // An exact name, or a name that ENDS with the wanted one - so "Main St"
    // finds "N Main St" and "E Main St", which are different streets, and
    // they come back as separate candidates rather than one wrong answer.
    if (name !== wanted && !name.endsWith(` ${wanted}`)) continue;
    if (number !== null && number < edge.from) continue;
    if (number !== null && number > edge.to) continue;
    const span = edge.to - edge.from;
    const fraction = number !== null && span > 0 ? (number - edge.from) / span : 0.5;
    const point = pointAlongSegment(edge.points, fraction);
    if (!point) continue;
    candidates.push({
      number,
      street: edge.name,
      side: edge.side,
      zip: edge.zip,
      from: edge.from,
      to: edge.to,
      addresses: edge.addresses,
      lon: point.lon,
      lat: point.lat,
    });
  }
  candidates.sort(
    (a, b) =>
      a.street.length - b.street.length ||
      b.addresses - a.addresses ||
      a.from - b.from,
  );
  return candidates.slice(0, MAX_CANDIDATES);
}

// ---------------------------------------------------------------------------
// What fell on it.
// ---------------------------------------------------------------------------

/**
 * The tract a point is in.
 *
 * The county's tracts, with their rings, and a point-in-polygon over them.
 * The county is known - the address named a place, and the place named a
 * county - so this is a handful of rings rather than a national search.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} state the two-digit FIPS
 * @param {string} county the three-digit FIPS
 * @returns {Promise<object|null>} the tract
 */
export async function tractAtPoint(lat, lon, state, county) {
  const index = await countyTractIndex(state, county);
  for (const tract of index.tracts) {
    for (const part of tract.parts || []) {
      const [outer, ...holes] = part;
      if (!outer || !pointInRing(outer, lat, lon)) continue;
      if (holes.some((hole) => pointInRing(hole, lat, lon))) continue;
      return tract;
    }
  }
  return null;
}

/**
 * The days the hail was over a point, and what was reported near it.
 *
 * @param {object} input
 * @param {number} input.lat
 * @param {number} input.lon
 * @param {string} input.tract the tract's GEOID
 * @returns {Promise<object>} the days, the reports and the totals
 */
export async function stormsAtPoint({ lat, lon, tract }) {
  const index = swathIndex();
  const rows = (index.byTract.get(String(tract)) || []).sort((a, b) =>
    b.d.localeCompare(a.d),
  );
  const days = [];
  let houses = 0;
  let units = 0;
  for (const row of rows) {
    const cells = fineDay(row.d);
    // The EXACT test: the cell under the point, on this day. The tract says
    // which days to look at; the cell says whether the hail was over the
    // address or merely over the tract.
    let over = false;
    let maxMm = 0;
    if (cells) {
      // The cell under the address, from the grid's own constants, so the
      // test is the same arithmetic the shard was written with. The row and
      // column are ABSOLUTE - the row base is where the retained window
      // starts, not an offset to be subtracted.
      const i = Math.floor(lat / RADAR_FINE_GRID.deg);
      const j = Math.floor(lon / RADAR_FINE_GRID.deg);
      for (const candidate of cells) {
        if (candidate.i !== i || candidate.j !== j) continue;
        over = candidate.maxMm >= HAIL_THRESHOLD_MM;
        maxMm = Math.max(maxMm, candidate.maxMm);
        break;
      }
    }
    houses += row.h ?? row.u ?? 0;
    units += row.u ?? 0;
    days.push({
      day: row.d,
      over,
      maxMm: Math.round(maxMm * 10) / 10,
      houses: row.h ?? row.u ?? 0,
      units: row.u ?? 0,
      share: row.s ?? null,
    });
  }
  return { days, houses, units, reports: await reportsNear(lat, lon) };
}

/**
 * The reports filed near a point.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<Array<object>>}
 */
async function reportsNear(lat, lon) {
  const out = [];
  const years = fs
    .readdirSync(STORM_DIR)
    .filter((name) => /^storm_reports_\d{4}\.json\.gz$/.test(name))
    .sort();
  for (const name of years) {
    const payload = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(STORM_DIR, name))).toString('utf8'),
    );
    for (const row of payload.reports || []) {
      const [date, , hazard, magnitude, rlat, rlon] = row;
      // HAIL IS ZERO and wind is one, which is the opposite of what the
      // artifact's own `hazards` counts look like at a glance.
      if (Number(hazard) !== 0) continue;
      if (!Number.isFinite(rlat) || !Number.isFinite(rlon)) continue;
      const km = haversineKm(lat, lon, rlat, rlon);
      if (km > REPORT_RADIUS_KM) continue;
      out.push({
        date,
        magnitude: Number(magnitude) || 0,
        lat: rlat,
        lon: rlon,
        km: Math.round(km * 10) / 10,
        state: row[7] || '',
        fips: row[6] || '',
        comment: String(row[10] || '').slice(0, 240),
      });
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || b.magnitude - a.magnitude);
  return out.slice(0, 50);
}

/**
 * The answer to an address.
 *
 * @param {object} query
 * @param {string} [query.q] the address, e.g. `123 Main St, Colorado Springs`
 * @param {string} [query.place] the place, when the query does not name it
 * @param {string} [query.state] the state, postal code or FIPS
 * @param {string} [query.county] the county FIPS
 * @returns {Promise<object>} the candidates and the storms over the best one
 */
export async function addressPayload(query = {}) {
  const parsed = parseAddressQuery(query.q || '');
  const place = query.place || parsed.place;
  const rawState = String(query.state || '').trim();
  // The desk's filters carry the POSTAL code and the tile routes carry the
  // FIPS, so both are accepted here - and the two are told apart by whether
  // they are digits, because '08' is a FIPS and 'CO' is a postal code, and
  // treating '08' as a postal code finds no place for it.
  const postal = /^[A-Za-z]{2}$/.test(rawState) ? rawState.toUpperCase() : '';
  const fips = /^\d{2}$/.test(rawState) ? rawState : '';
  let state = fips;
  let county = String(query.county || '').trim();

  if (!state && postal) {
    const found = countyForPlace(place, postal);
    if (found) {
      state = found.geoid.slice(0, 2);
      if (!county) county = found.geoid.slice(2, 5);
    }
  }
  if (!state || !county) {
    return {
      ok: false,
      error:
        'an address needs a county: name a place with it, as in ' +
        '"123 Main St, Colorado Springs"',
    };
  }
  if (parsed.number === null) {
    return { ok: false, error: 'an address needs a house number' };
  }
  const candidates = await geocodeAddress({
    state,
    county,
    number: parsed.number,
    street: parsed.street,
  });
  if (!candidates.length) {
    // TWO DIFFERENT FAILURES, and they are told apart: the street is not
    // there, or the street is there and the number is not on it. "No street
    // matches" when the street does match is a message that sends the reader
    // looking in the wrong place.
    const streets = await streetNames(state, county);
    const streetIsThere = streets.has(parsed.street.trim().toLowerCase());
    return {
      ok: false,
      error: streetIsThere
        ? `the street is there, but no house number ${parsed.number} is on it in county ${state}${county}`
        : `no street in county ${state}${county} matches "${parsed.street}"`,
    };
  }
  const best = candidates[0];
  const tract = await tractAtPoint(best.lat, best.lon, state, county);
  const storms = tract
    ? await stormsAtPoint({ lat: best.lat, lon: best.lon, tract: tract.geoid })
    : { days: [], houses: 0, units: 0, reports: [] };
  return {
    ok: true,
    query: { q: query.q || '', place, state, county },
    address: best,
    candidates,
    tract: tract
      ? { geoid: tract.geoid, name: tract.name, units: tract.units }
      : null,
    days: storms.days,
    houses: storms.houses,
    units: storms.units,
    reports: storms.reports,
  };
}

/**
 * The distance between two points, in kilometres.
 *
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

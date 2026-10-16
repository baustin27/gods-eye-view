/**
 * Bundled populated places — Natural Earth `ne_10m_populated_places_simple` —
 * so "isolate to Denver" resolves a city with no network lookup, and "cities
 * in Oklahoma" can offer what is inside a box.
 *
 * Data: `local_data/natural_earth/places.json`, public domain, built by
 * `scripts/build-admin-packs.mjs --only places` (provenance in that folder's
 * README). One row per place: a point, a population, a country, a region.
 *
 * A CITY HAS NO BOUNDARY HERE, and this module will not pretend otherwise. The
 * source dataset carries no city geometry of any kind — no polygon, no
 * radius, nothing that says where the city ends and the countryside begins.
 * Isolating to a city therefore means drawing a box scaled by population around
 * the point (`placeBox`), and EVERY box from here is an APPROXIMATION: a guess
 * at how far out to frame a camera, not a boundary anyone surveyed. A city's
 * real extent depends on which definition you pick (city proper, metro area,
 * commuting shed) and nothing in this data picks one. Results say so rather
 * than leaving a caller to assume an outline: `boundary` is always `null`, and
 * the estimated `approxRadiusKm` travels with the box `bbox`.
 *
 * PURE data module — no Cesium, no DOM, node-testable. The pack is loaded
 * through `loadBundledJson` on the first lookup that needs it (never at app
 * start), indexed once by normalized name and kept; a failed load is retried
 * later rather than cached (`createRetryableLoader`). Names normalize exactly
 * as administrative names do (`normalizeAdminName`), so "Québec", "QUEBEC" and
 * "Tây Ninh" match the way the boundary packs match, and a place is one name
 * that many people type several ways — Natural Earth calls the largest US city
 * "New York", so "New York City" finds it too.
 *
 * Two entry points:
 *   - `findPlace(query, { near, minPopulation })` — name-only. Duplicates are
 *     settled by a country/region qualifier, then by the camera (`near`), then
 *     by population: "Springfield, Illinois", then Springfield MA vs IL by the
 *     camera, then the largest of whatever is left. Returns `null` on a miss,
 *     and `null` rather than a throw if the pack itself failed to load — a
 *     caller asking "where is X" should hear "no", not crash.
 *   - `placesForBox(bbox, { minPopulation, limit })` — every place inside
 *     `[west, south, east, north]`, largest first. This is what offers
 *     "cities in this state".
 */

import { normalizeAdminName } from './adminBoundaries.js';
import { loadBundledJson } from './bundledJson.js';
import { createRetryableLoader } from './retryableLoad.js';

const PACK_URL = new URL(
  './local_data/natural_earth/places.json',
  import.meta.url,
);

/** Test seam: count pack loads (the lazy-loading contract). */
export const packLoads = { places: 0 };

/**
 * Box half-width from a population, in km: 8 km per 100,000 people, damped by
 * the 0.35 power (a city 10× larger is not 10× further across), clamped to
 * 5–120 km. A 788,000-person city gets ~16 km and Tokyo ~62 km, which frames
 * the camera about right — and which is exactly why it must not be mistaken for
 * the city's edge. Pure guesswork from a population figure.
 */
export function approxRadiusKm(population) {
  const people = Number.isFinite(population) && population > 0 ? population : 0;
  return Math.min(120, Math.max(5, 8 * (people / 100_000) ** 0.35));
}

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Degrees of latitude for `km`; longitude degrees shrink toward the poles. */
function kmToLatDeg(km) {
  return km / 111.32;
}

function kmToLonDeg(km, lat) {
  const width = Math.cos(toRad(Math.max(-89.9, Math.min(89.9, lat))));
  return width > 1e-6 ? km / (111.32 * width) : 180;
}

/**
 * An approximate `[west, south, east, north]` box around a place — the only
 * shape this data can support. `radiusKm` overrides the population estimate;
 * the box is not clamped to the antimeridian, so a box drawn across it reads as
 * a near-world-spanning box rather than a small one.
 */
export function placeBox(place, { radiusKm } = {}) {
  const lat = Number(place?.lat) || 0;
  const lon = Number(place?.lon) || 0;
  const km = Number.isFinite(radiusKm)
    ? radiusKm
    : approxRadiusKm(place?.population);
  return [
    lon - kmToLonDeg(km, lat),
    Math.max(-90, lat - kmToLatDeg(km)),
    lon + kmToLonDeg(km, lat),
    Math.min(90, lat + kmToLatDeg(km)),
  ];
}

/** Initials of a multi-word name: "New York" → "ny", "Hong Kong" → "hk". */
function initials(key) {
  return key
    .split(' ')
    .filter(Boolean)
    .map((word) => word[0])
    .join('');
}

function addEntry(index, key, entry) {
  if (!key) return;
  const list = index.get(key);
  if (!list) index.set(key, [entry]);
  else if (!list.includes(entry)) list.push(entry);
}

const loadPlaces = createRetryableLoader(async () => {
  packLoads.places += 1;
  const pack = await loadBundledJson(PACK_URL);
  const index = new Map();
  const features = [];
  for (const feature of pack.features || []) {
    if (!Number.isFinite(feature?.lat) || !Number.isFinite(feature?.lon))
      continue;
    const entry = {
      kind: 'place',
      feature,
      country: normalizeAdminName(feature.country),
      region: normalizeAdminName(feature.region),
      iso: String(feature.iso || '').toLowerCase(),
      iso2: String(feature.iso2 || '').toLowerCase(),
      adm1: String(feature.adm1code || '').toLowerCase(),
    };
    addEntry(index, normalizeAdminName(feature.name), entry);
    features.push(entry);
  }
  return { index, features };
});

/**
 * Split an ask into the name and whatever places it: "Denver, Colorado" names
 * Denver and says Colorado. Only the comma split — a place ask carries no
 * admin wording worth parsing ("County of X" is not a city).
 *
 * @param {string} query
 * @returns {{name: string, aliases: string[],
 *   qualifiers: {raw: string, key: string}[]}|null} `null` when there is no
 *   name to look up.
 */
export function parsePlaceQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) return null;
  const segments = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!segments.length) return null;
  const name = normalizeAdminName(segments[0]);
  if (!name) return null;
  // "New York City" is a place Natural Earth calls "New York"; "Oklahoma City"
  // is a place it calls "Oklahoma City", so the bare name is only ever a second
  // try. The name that is really a country's capital ("Georgia") is no more or
  // less a city than any other, so no bare-name guard here.
  const aliases = [];
  const stripped = name.replace(/ city$/, '').trim();
  if (stripped && stripped !== name) aliases.push(stripped);
  return {
    name,
    aliases,
    qualifiers: segments
      .slice(1)
      .map((part) => ({ raw: part, key: normalizeAdminName(part) }))
      .filter((q) => q.key),
  };
}

/**
 * Whether a qualifier places the entry. Every qualifier has to agree, or the
 * ask names somewhere else ("Springfield, Illinois" is not "Springfield,
 * Ohio"). A country or region NAME matches in any case; a CODE — the country's
 * `USA`/`US`, or the subdivision code the pack carries (`MO`, `ON`, `BY`) —
 * matches only when it is written as a code, in capitals, because "Springfield,
 * Missouri" and "Springfield, MO" are the same ask and "springfield, mo" is a
 * lowercase word nobody means as Alabama.
 *
 * A capitalised code that the pack has no code for still matches a country or
 * region by its opening letters or its initials ("Denver, NY" for New York),
 * because a typed ask arrives abbreviated far more often than a spoken one.
 */
function qualifierMatches(entry, qualifier) {
  const { raw, key } = qualifier;
  if (entry.country === key || entry.region === key) return true;
  if (!/^[A-Z]{2,3}\.?$/.test(raw)) return false;
  if (entry.iso === key || entry.iso2 === key || entry.adm1 === key)
    return true;
  return [entry.country, entry.region].some(
    (name) => name && (name.startsWith(key) || initials(name) === key),
  );
}

/**
 * Rank one name's candidates: match tier first, then the camera, then
 * population. Without `near` the camera cannot break a tie, so the largest
 * city of the name wins — the same order the boundary packs fall back to.
 */
function rank(candidates, near) {
  const hasNear = Number.isFinite(near?.lat) && Number.isFinite(near?.lon);
  const scored = candidates.map(({ entry, tier }) => ({
    entry,
    tier,
    distanceKm: hasNear
      ? haversineKm(near.lat, near.lon, entry.feature.lat, entry.feature.lon)
      : 0,
  }));
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      (hasNear
        ? a.distanceKm - b.distanceKm
        : b.entry.feature.population - a.entry.feature.population) ||
      b.entry.feature.population - a.entry.feature.population ||
      a.entry.feature.id.localeCompare(b.entry.feature.id),
  );
  return scored;
}

function toPlace(entry, candidates) {
  const { feature } = entry;
  return {
    name: feature.name,
    lat: feature.lat,
    lon: feature.lon,
    population: feature.population,
    country: feature.country,
    region: feature.region,
    scale: feature.scale,
    kind: 'place',
    id: feature.id,
    iso: feature.iso,
    iso2: feature.iso2,
    adm1code: feature.adm1code || null,
    // Never an outline: see the module docstring. Callers that need a shape
    // must ask `placeBox`, and must present it as an estimate.
    boundary: null,
    approxRadiusKm: approxRadiusKm(feature.population),
    bbox: placeBox(feature),
    candidates,
  };
}

/**
 * Resolve a populated place from the ask's words alone.
 *
 * @param {string} query e.g. "Denver", "Denver, Colorado", "Denver, CO",
 *   "Oklahoma City", "New York City", "Springfield, Illinois"
 * @param {{near?: {lat:number, lon:number}|null, minPopulation?: number}} [options]
 *   `near` is the camera's view centre — the tie-break between same-named
 *   places; `minPopulation` drops places below a floor before ranking (the
 *   pack's own floor is 5,000).
 * @returns {Promise<Place|null>} `null` on a miss, or if the pack failed to load.
 *
 * @typedef {{name:string, lat:number, lon:number, population:number,
 *   country:string|null, region:string|null, scale:number|null,
 *   kind:'place', id:string, iso:string|null, iso2:string|null,
 *   adm1code:string|null, boundary:null, approxRadiusKm:number, bbox:number[],
 *   candidates:number}} Place
 */
export async function findPlace(
  query,
  { near = null, minPopulation = 0 } = {},
) {
  const parsed = parsePlaceQuery(query);
  if (!parsed) return null;
  let index;
  try {
    ({ index } = await loadPlaces());
  } catch {
    // A pack that will not load is a miss, not a crash: callers are voice and
    // analyst paths that already treat a null as "no such place".
    return null;
  }
  const floor = Number.isFinite(minPopulation) ? minPopulation : 0;
  const candidates = [];
  const seen = new Set();
  // Exact name first (tier 0), then the "New York City" → "New York" spelling.
  for (const [key, tier] of [
    [parsed.name, 0],
    ...parsed.aliases.map((alias) => [alias, 1]),
  ]) {
    for (const entry of index.get(key) || []) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      candidates.push({ entry, tier });
    }
  }
  const eligible = candidates.filter(
    ({ entry }) =>
      entry.feature.population >= floor &&
      parsed.qualifiers.every((q) => qualifierMatches(entry, q)),
  );
  if (!eligible.length) return null;
  const ranked = rank(eligible, near);
  return toPlace(ranked[0].entry, eligible.length);
}

/**
 * Every place inside a box, largest first — what offers "cities in this
 * state". The box is `[west, south, east, north]`, the convention
 * `adminBoundaries` reports, and it is read as a span rather than two corners:
 * longitudes are compared as an offset from `west`, so a box that crosses the
 * antimeridian (Alaska, Chukotka) works instead of coming out empty.
 *
 * @param {number[]} bbox `[west, south, east, north]` in degrees
 * @param {{minPopulation?: number, limit?: number}} [options] `limit` of 0
 *   (the default) returns every place in the box.
 * @returns {Promise<Place[]>} largest population first; empty on a bad box or a
 *   pack that failed to load.
 */
export async function placesForBox(
  bbox,
  { minPopulation = 0, limit = 0 } = {},
) {
  const [west, south, east, north] = Array.isArray(bbox) ? bbox : [];
  if (![west, south, east, north].every(Number.isFinite)) return [];
  if (north < south) return [];
  const width = east - west;
  if (width < 0) return [];
  let features;
  try {
    ({ features } = await loadPlaces());
  } catch {
    return [];
  }
  const floor = Number.isFinite(minPopulation) ? minPopulation : 0;
  const inside = features.filter(({ feature }) => {
    if (feature.lat < south || feature.lat > north) return false;
    if (feature.population < floor) return false;
    // Distance east of `west`, wrapped into [0, 360), so the box is a span and
    // not two corners: a point 350° east of `west` is 10° short of coming back
    // round, which is what makes a box across the antimeridian (Alaska,
    // Chukotka) work instead of coming out empty.
    const offset = (((feature.lon - west) % 360) + 360) % 360;
    return offset <= width;
  });
  inside.sort(
    (a, b) =>
      b.feature.population - a.feature.population ||
      a.feature.name.localeCompare(b.feature.name) ||
      a.feature.id.localeCompare(b.feature.id),
  );
  const chosen = limit > 0 ? inside.slice(0, limit) : inside;
  // `candidates` counts the places in the box, not the places returned, so a
  // caller that asked for 5 of 12 can say so.
  return chosen.map((entry) => toPlace(entry, inside.length));
}

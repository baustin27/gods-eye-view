/**
 * The map's geography, on the server.
 *
 * TWO THINGS THE DESK'S MAP WAS MISSING, and they are the two things that
 * make a map a map:
 *
 *   - WHERE THE TILE IS. The street and tract tiles were cut from a county
 *     the CLIENT chose, which meant the map could only ever show one
 *     county's streets: pan across a county line and the roads stopped,
 *     with nothing to say why. The county is a fact about the tile, not a
 *     thing a client should have to know, so the server works it out from
 *     the tile's own geography.
 *
 *   - WHERE THE CITY IS. The desk had the Census places as dots and no
 *     outline for any of them, so "which city is this" was a question the
 *     map could not answer. The places pack has the boundaries; they are
 *     drawn now.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeRing, pointInRing } from '../../src/data/adminBoundaries.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const COUNTIES_FILE = path.join(
  REPO,
  'src/data/local_data/us_census_counties/counties.json',
);
const PLACES_FILE = path.join(
  REPO,
  'src/data/local_data/us_census_places/places.json',
);

/** The counties, indexed, once. */
let counties = null;
/** The places, by state, once. */
let places = null;

/**
 * The counties, with their bounds.
 *
 * The bounds are computed once and kept, because the lookup is "which county
 * is this tile in" and that is asked for every tile of every pan - a linear
 * scan over 3,235 counties with a box test each is fine, and a point-in-
 * polygon over all of them is not.
 *
 * @returns {Array<object>}
 */
function countyIndex() {
  if (counties) return counties;
  counties = [];
  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(COUNTIES_FILE, 'utf8'));
  } catch {
    return counties;
  }
  const decimals = pack.meta?.decimals ?? 4;
  for (const feature of pack.features || []) {
    const rings = (feature.polygons || []).map((polygon) =>
      polygon.map((ring) => decodeRing(ring, feature.d ?? decimals)),
    );
    if (!rings.length) continue;
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const polygon of rings) {
      for (const ring of polygon) {
        for (const [lon, lat] of ring) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
    }
    counties.push({
      geoid: String(feature.geoid || ''),
      st: String(feature.st || ''),
      name: String(feature.full || feature.name || ''),
      rings,
      minLon,
      minLat,
      maxLon,
      maxLat,
    });
  }
  return counties;
}

/**
 * The county a point is in.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {object|null} the county, with its FIPS in `geoid`
 */
export function countyAtPoint(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const county of countyIndex()) {
    if (lon < county.minLon || lon > county.maxLon) continue;
    if (lat < county.minLat || lat > county.maxLat) continue;
    for (const polygon of county.rings) {
      const [outer, ...holes] = polygon;
      if (!outer || !pointInRing(outer, lat, lon)) continue;
      if (holes.some((hole) => pointInRing(hole, lat, lon))) continue;
      return county;
    }
  }
  return null;
}

/**
 * The county a tile is in, by the tile's own geography.
 *
 * The tile's CENTRE, not its corner: a tile on a county line covers both
 * counties, and the centre is the one that decides which county's index is
 * worth building.
 *
 * @param {number} z the zoom
 * @param {number} x the tile column
 * @param {number} y the tile row
 * @returns {object|null} the county
 */
export function countyForTile(z, x, y) {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  // The Mercator inverse of the tile's middle row, in degrees.
  const mid = (y + 0.5) / n;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * mid))) * 180) / Math.PI;
  return countyAtPoint(lat, (west + east) / 2);
}

/**
 * The places of one state, with their boundaries.
 *
 * A state is a few hundred places and the whole country is 32,607, so this
 * is served a state at a time - which is also how the desk uses it, because
 * the desk works one state at a time.
 *
 * @param {string} state the two-letter postal code
 * @returns {Array<object>} each with `name`, `id`, `lat`, `lon` and `rings`
 */
export function placesForState(state) {
  const code = String(state || '')
    .trim()
    .toUpperCase();
  if (!code) return [];
  if (!places) {
    places = new Map();
    let pack;
    try {
      pack = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
    } catch {
      return [];
    }
    const decimals = pack.meta?.decimals ?? 4;
    for (const feature of pack.features || []) {
      const st = String(feature.st || '').toUpperCase();
      if (!st) continue;
      if (!places.has(st)) places.set(st, []);
      const rings = (feature.polygons || [])
        .map((polygon) =>
          polygon.map((ring) => decodeRing(ring, feature.d ?? decimals)),
        )
        .filter((polygon) => polygon.some((ring) => ring.length >= 3));
      const lat = Number(feature.lat);
      const lon = Number(feature.lon);
      places.get(st).push({
        id: String(feature.id || feature.geoid || ''),
        name: String(feature.full || feature.name || ''),
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
        rings,
      });
    }
  }
  return places.get(code) || [];
}

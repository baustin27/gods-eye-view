/**
 * Census tracts, on the server.
 *
 * The desk's server needs the tract BOUNDARY for one thing: to say which
 * streets are inside a tract, so that a canvasser can narrow from a town to
 * a neighbourhood to a street. The boundary is the whole of that job, and
 * the boundary is what the Census publishes.
 *
 * WHY IT IS LOADED HERE AND NOT IN THE BROWSER. The tracts pack is 29.7 MB
 * of JSON and the desk is a table of places and a knock list; it has no
 * business holding the geometry of every tract in the country. The server
 * loads it once, lazily, the first time a request names a tract, and keeps
 * it. The load is about a sixth of a second and a hundred megabytes, which
 * is a trade worth making once rather than on every request.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeRing, pointInRing } from '../../src/data/adminBoundaries.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TRACTS_FILE = path.join(
  REPO,
  'src/data/local_data/us_census_tracts/tracts.json',
);

/** The loaded pack, once. */
let index = null;
/** The promise of the load, so two requests do not load it twice. */
let pending = null;

/**
 * The tracts, indexed by GEOID.
 *
 * @returns {Promise<Map<string, object>>}
 */
export async function loadTracts() {
  if (index) return index;
  if (pending) return pending;
  pending = (async () => {
    const pack = JSON.parse(fs.readFileSync(TRACTS_FILE, 'utf8'));
    const decimals = pack.meta?.decimals ?? 4;
    const byGeoid = new Map();
    for (const feature of pack.features || []) {
      const rings = (feature.polygons || []).map((polygon) =>
        polygon.map((ring) => decodeRing(ring, feature.d ?? decimals)),
      );
      if (!rings.length) continue;
      let minLat = Infinity;
      let minLon = Infinity;
      let maxLat = -Infinity;
      let maxLon = -Infinity;
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
      byGeoid.set(feature.geoid, {
        geoid: feature.geoid,
        name: feature.name,
        rings,
        minLat,
        minLon,
        maxLat,
        maxLon,
      });
    }
    index = byGeoid;
    return byGeoid;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/**
 * Whether a point is inside a tract.
 *
 * A tract's rings are its outer boundary and then its holes, so a point in a
 * hole is not in the tract. The box test first is not an optimisation only:
 * the rings of a rural tract can be thousands of vertices, and most points
 * are nowhere near it.
 *
 * @param {object} tract from {@link loadTracts}
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function tractContains(tract, lat, lon) {
  if (!tract) return false;
  if (lat < tract.minLat || lat > tract.maxLat) return false;
  if (lon < tract.minLon || lon > tract.maxLon) return false;
  for (const polygon of tract.rings) {
    const [outer, ...holes] = polygon;
    if (!pointInRing(outer, lat, lon)) continue;
    if (holes.some((hole) => pointInRing(hole, lat, lon))) continue;
    return true;
  }
  return false;
}

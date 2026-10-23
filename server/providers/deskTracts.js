/**
 * Census tract tiles - the shapes under the hail, at street zoom.
 *
 * THE QUESTION. The desk's map draws the streets of a county, and the
 * question a canvasser asks of a street is "how many HOUSES are on it". The
 * Census counts housing units by tract, so the tract is the level at which
 * the number exists, and the map needs the tract's OUTLINE to put the number
 * on the ground.
 *
 * WHY A TILE AND NOT THE PACK. The tracts pack is 29.7 MB of JSON and the
 * browser cannot hold it, let alone draw it. It is cut into tiles here, the
 * same way the streets are, and the browser asks for the tiles it can see.
 *
 * MEASURED, on this pack. The county index - the parse of the twenty nine
 * megabytes, Denver's 178 tracts and the housing-unit artifact - takes 279
 * milliseconds, once. A tile over downtown Denver is 13 rings and 434 bytes
 * at z14, and 2 rings and 92 bytes at z18, and the whole county at z10 is
 * 175 rings and 6.4 kilobytes. The tile is small because a tract is small
 * and because the boundary is simplified, and a client that draws a ring
 * per tract is drawing a few hundred bytes.
 *
 * WHY NOT `loadTracts()`. That loader decodes EVERY tract in the country -
 * 3.7 million vertices, in arrays of pairs - and a tile server needs one
 * county's geometry, which for Denver is 178 tracts and 1,786 vertices. The
 * pack is parsed here per county and thrown away, and what is kept is the
 * county: a few hundred kilobytes, built once, keyed by the pack's mtime
 * and size so a rebuilt pack drops the index instead of serving stale
 * boundaries.
 *
 * THE IDENTITY QUESTION. A tile's ring has to name its tract, and the
 * client cannot know the county's tract list - so the list is fetched ONCE
 * per county, from `/api/desk/tracts/{state}/{county}/index`, and cached.
 * The tile then carries an INDEX into that list, in the u32 field the
 * street tiles use for the edge index, which is the whole of what a tract
 * tile needs from a format it shares with the street tiles.
 *
 * THE HOUSING UNITS TRAVEL WITH THE IDENTITY, and not in the tile. The
 * record has room for exactly one number, and the brief for the tile is
 * that the number is the tract's index. The count is a property of the
 * TRACT, not of the ring, so it sits in the county's tract list beside the
 * GEOID and the name - and the client reads it there. A tile that carried
 * the count as well would carry it once per ring, for a number that is the
 * same on every ring of the same tract.
 *
 * THE FORMAT IS `GEVS`, THE STREET TILES' FORMAT, and not a second one. A
 * tract boundary is a closed polyline in tile-local units, which is what a
 * GEVS feature is, and a second format would mean a second decoder in the
 * browser for one extra field that the index already carries. What the
 * client does with the rings is its own: the rings of one tract are
 * consecutive and share an index, and it fills them with the even-odd rule,
 * which punches a hole without the tile having to say which ring is one.
 *
 * THE GEOMETRY IS THE CENSUS'S, AT 500k. These are the cartographic
 * boundaries, which the Census simplifies - a ring here can be tens of
 * metres from the true boundary of a tract. That is the trade the desk
 * makes: a drawn boundary a canvasser argues with is worth less than one
 * that is right on the ground, and the number is what the canvasser acts on.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { decodeRing } from '../../src/data/adminBoundaries.js';
import { GEVS_EXTENT, encodeStreetTile } from '../../src/data/streetTile.js';
import {
  lonLatToTileLocal,
  tileBounds,
} from '../../src/layers/streetLevel/tileMath.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TRACTS_FILE = path.join(
  REPO,
  'src/data/local_data/us_census_tracts/tracts.json',
);
const HOUSING_FILE = path.join(
  REPO,
  'src/data/local_data/housing_units/housing_units_tract.json.gz',
);

/** The county indexes, by key. */
const countyIndexes = new Map();

/** The housing-unit counts, by tract GEOID. */
let housing = null;
/** The promise of that load, so two requests do not read it twice. */
let housingPending = null;

/**
 * The mtime and size of a file, or null when it is not there.
 *
 * A STAT and not a read: the cache is checked before the twenty nine
 * megabytes are parsed, which is the difference between a tile request that
 * takes a fifth of a second and one that takes a second.
 *
 * @param {string} file
 * @returns {{mtimeMs: number, size: number}|null}
 */
function statOf(file) {
  try {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * The housing-unit counts, by tract GEOID, read ONCE.
 *
 * The artifact is a megabyte and a half of gzipped JSON with 85,381 rows,
 * and it is read on the first tract request and never again. It is keyed by
 * its own mtime and size, so a rebuilt artifact is read again rather than
 * served from a stale count.
 *
 * A MISSING artifact is an absence and not a failure: the boundaries are
 * still worth drawing, and the count is reported as "no estimate" rather
 * than as zero, because a zero is a number and an absence is not.
 *
 * @returns {Promise<Map<string, {units: number|null, moe: number|null,
 *   population: number|null}>>}
 */
export async function housingUnitCounts() {
  const stat = statOf(HOUSING_FILE);
  if (!stat) return new Map();
  const key = `${stat.mtimeMs}:${stat.size}`;
  if (housing?.key === key) return housing.byGeoid;
  if (housingPending?.key === key) return housingPending.promise;

  const promise = (async () => {
    const raw = zlib.gunzipSync(fs.readFileSync(HOUSING_FILE));
    const pack = JSON.parse(raw.toString('utf8'));
    const byGeoid = new Map();
    for (const row of pack.rows || []) {
      const id = String(row?.id || '');
      if (!id) continue;
      byGeoid.set(id, {
        units: Number.isFinite(row.units) ? row.units : null,
        moe: Number.isFinite(row.moe) ? row.moe : null,
        population: Number.isFinite(row.population) ? row.population : null,
      });
    }
    housing = { key, byGeoid };
    return byGeoid;
  })();
  housingPending = { key, promise };
  try {
    return await promise;
  } finally {
    housingPending = null;
  }
}

/**
 * The signed area of a ring, in square degrees.
 *
 * The shoelace formula. It is used to tell a shape from a SLIVER: a ring
 * that has been clipped away to a line has no area, and a line is not a
 * polygon a client can fill.
 *
 * @param {Array<[number, number]>} ring
 * @returns {number}
 */
export function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}

/**
 * A ring with its duplicate points taken out.
 *
 * Consecutive duplicates are dropped, and so is the closing point - the one
 * that repeats the first - because the ring is closed by the caller and a
 * closed ring twice over makes the clipping arithmetic ambiguous.
 *
 * @param {Array<[number, number]>} points
 * @returns {Array<[number, number]>}
 */
function dedupeRing(points) {
  const out = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    out.push(point);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) out.pop();
    else break;
  }
  return out;
}

/**
 * Clip a closed polygon against one half-plane.
 *
 * Sutherland-Hodgman: the polygon is walked once, and every edge that
 * crosses the line contributes the point where it crosses. What comes out is
 * the part of the polygon inside the half-plane.
 *
 * @param {Array<[number, number]>} points the polygon, open
 * @param {(point: [number, number]) => boolean} inside
 * @param {(a: [number, number], b: [number, number]) => [number, number]}
 *   cross the line between two points
 * @returns {Array<[number, number]>}
 */
function clipHalfPlane(points, inside, cross) {
  const out = [];
  const count = points.length;
  for (let i = 0; i < count; i += 1) {
    const current = points[i];
    const previous = points[(i + count - 1) % count];
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside) {
      if (!previousInside) out.push(cross(previous, current));
      out.push(current);
    } else if (previousInside) {
      out.push(cross(previous, current));
    }
  }
  return out;
}

/**
 * Where a segment crosses a line of longitude.
 *
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @param {number} lon
 * @returns {[number, number]}
 */
function crossAtLon(a, b, lon) {
  const dx = b[0] - a[0];
  if (!dx) return [lon, a[1]];
  const t = (lon - a[0]) / dx;
  return [lon, a[1] + t * (b[1] - a[1])];
}

/**
 * Where a segment crosses a line of latitude.
 *
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @param {number} lat
 * @returns {[number, number]}
 */
function crossAtLat(a, b, lat) {
  const dy = b[1] - a[1];
  if (!dy) return [a[0], lat];
  const t = (lat - a[1]) / dy;
  return [a[0] + t * (b[0] - a[0]), lat];
}

/**
 * Clip a ring to a rectangle, and return the part that is inside it.
 *
 * THE CLIP IS IN LON/LAT, and not in tile-local units. A tile's bounds are a
 * rectangle in longitude and latitude, and the projection of that rectangle
 * is the tile square - so clipping in one and projecting afterwards is the
 * same answer with fewer moving parts, and it keeps the arithmetic in
 * degrees, where the numbers are the numbers the Census published.
 *
 * A ring that is entirely outside the rectangle, or that is clipped away to
 * nothing, is not a shape and comes back as null.
 *
 * @param {Array<[number, number]>} ring an open ring of [lon, lat]
 * @param {{west: number, south: number, east: number, north: number}} bounds
 * @returns {Array<[number, number]>|null} the clipped ring, open
 */
export function clipRingToBounds(ring, bounds) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let points = dedupeRing(ring.map((point) => [point[0], point[1]]));
  if (points.length < 3) return null;

  points = clipHalfPlane(
    points,
    (point) => point[0] >= bounds.west,
    (a, b) => crossAtLon(a, b, bounds.west),
  );
  points = clipHalfPlane(
    points,
    (point) => point[0] <= bounds.east,
    (a, b) => crossAtLon(a, b, bounds.east),
  );
  points = clipHalfPlane(
    points,
    (point) => point[1] >= bounds.south,
    (a, b) => crossAtLat(a, b, bounds.south),
  );
  points = clipHalfPlane(
    points,
    (point) => point[1] <= bounds.north,
    (a, b) => crossAtLat(a, b, bounds.north),
  );

  points = dedupeRing(points);
  if (points.length < 3) return null;
  // A ring with no area is a line, and a line cannot be filled.
  if (!ringArea(points)) return null;
  return points;
}

/**
 * The index for one county, parsed once.
 *
 * @param {string} state two-digit state FIPS
 * @param {string} county three-digit county FIPS
 * @returns {Promise<{key: string, tracts: Array<object>, built: boolean}>}
 *   `built` says whether THIS call parsed the county - false means the index
 *   was already in memory, which is what the cache header reports.
 */
export async function countyTractIndex(state, county) {
  const st = String(state || '').trim();
  const co = String(county || '').trim();
  if (!/^\d{2}$/.test(st) || !/^\d{3}$/.test(co)) {
    throw new Error('state and county are required');
  }
  const stat = statOf(TRACTS_FILE);
  if (!stat) throw new Error('the census tract pack is not available');
  const prefix = `${st}${co}`;
  const key = `${prefix}:${stat.mtimeMs}:${stat.size}`;
  const cached = countyIndexes.get(key);
  if (cached) return { ...cached, built: false };

  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(TRACTS_FILE, 'utf8'));
  } catch {
    // The message is fixed because the raw one carries the server's paths.
    throw new Error('the census tract pack could not be read');
  }
  const decimals = pack.meta?.decimals ?? 4;
  const units = await housingUnitCounts();

  const tracts = [];
  for (const feature of pack.features || []) {
    const geoid = String(feature.geoid || '');
    if (!geoid.startsWith(prefix)) continue;
    const parts = [];
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const polygon of feature.polygons || []) {
      const rings = polygon.map((ring) =>
        decodeRing(ring, feature.d ?? decimals),
      );
      if (!rings.length) continue;
      for (const ring of rings) {
        for (const [lon, lat] of ring) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
      parts.push(rings);
    }
    if (!parts.length) continue;
    const count = units.get(geoid);
    tracts.push({
      geoid,
      name: feature.name || '',
      parts,
      minLon,
      minLat,
      maxLon,
      maxLat,
      units: count?.units ?? null,
      moe: count?.moe ?? null,
      population: count?.population ?? null,
    });
  }

  // The order is the GEOID order, and it is FIXED: the index in a tile is a
  // number into this list, so the list and the tile must agree. Sorting by
  // GEOID is the one order that does not move when the pack is rebuilt.
  tracts.sort((a, b) => (a.geoid < b.geoid ? -1 : a.geoid > b.geoid ? 1 : 0));
  tracts.forEach((tract, index) => {
    tract.index = index;
  });

  const built = { key, tracts };
  // The old index is dropped when the pack changed, so there is never more
  // than one county's geometry in memory per county.
  for (const existing of countyIndexes.keys()) {
    if (existing.startsWith(`${prefix}:`)) countyIndexes.delete(existing);
  }
  countyIndexes.set(key, built);
  return { ...built, built: true };
}

/**
 * The county's tract list, as the client sees it.
 *
 * This is what turns a tile's index back into a tract: the GEOID, the name
 * and the housing-unit count, in the order the tiles index into.
 *
 * @param {string} state two-digit state FIPS
 * @param {string} county three-digit county FIPS
 * @param {{tracts: Array<object>}} index
 * @returns {{state: string, county: string, count: number, tracts: Array<object>}}
 */
export function tractListBody(state, county, index) {
  return {
    state: String(state),
    county: String(county),
    count: index.tracts.length,
    tracts: index.tracts.map((tract) => ({
      index: tract.index,
      geoid: tract.geoid,
      name: tract.name,
      bounds: {
        west: tract.minLon,
        south: tract.minLat,
        east: tract.maxLon,
        north: tract.maxLat,
      },
      units: tract.units,
      moe: tract.moe,
      population: tract.population,
    })),
  };
}

/** One tract's complete, unclipped outline for selection and map focus. */
export async function tractGeometry(state, county, geoid) {
  if (!String(geoid).startsWith(`${state}${county}`)) {
    const error = new Error('the tract does not belong to this county');
    error.status = 404;
    throw error;
  }
  const index = await countyTractIndex(state, county);
  const tract = index.tracts.find((entry) => entry.geoid === geoid);
  if (!tract) {
    const error = new Error('the tract outline is not available');
    error.status = 404;
    throw error;
  }
  return {
    geoid: tract.geoid,
    bounds: {
      west: tract.minLon,
      south: tract.minLat,
      east: tract.maxLon,
      north: tract.maxLat,
    },
    polygons: tract.parts,
  };
}

/**
 * One tract tile: the tracts that TOUCH it, and their rings.
 *
 * A tract touches the tile when its BOUNDS overlap the tile's. The bounds
 * are a box and the tract is not, so a tract can pass the test and still
 * miss the tile - and then the clipping leaves nothing, and the tract is
 * dropped. That is the right way round: the cheap test throws away most of
 * the county, and the clipping throws away the rest.
 *
 * The rings are written in the street tile's format, so a feature's index
 * is the tract's index in the county's tract list.
 *
 * @param {string} state two-digit state FIPS
 * @param {string} county three-digit county FIPS
 * @param {number} z the zoom
 * @param {number} x the tile column
 * @param {number} y the tile row
 * @returns {Promise<{bytes: Uint8Array, count: number, cache: string}>}
 */
export async function tractTile(state, county, z, x, y) {
  const index = await countyTractIndex(state, county);
  const bounds = tileBounds(x, y, z);
  const lines = [];

  for (const tract of index.tracts) {
    if (tract.maxLon < bounds.west || tract.minLon > bounds.east) continue;
    if (tract.maxLat < bounds.south || tract.minLat > bounds.north) continue;

    for (const part of tract.parts) {
      for (const ring of part) {
        const clipped = clipRingToBounds(ring, bounds);
        if (!clipped) continue;
        const points = clipped.map(([lon, lat]) =>
          lonLatToTileLocal(lon, lat, GEVS_EXTENT, x, y, z),
        );
        // The ring is closed in TILE-LOCAL units, so the point that closes it
        // is the same point the client reads back.
        points.push([points[0][0], points[0][1]]);
        lines.push({ edgeIndex: tract.index, points });
      }
    }
  }

  const bytes = encodeStreetTile({
    zoom: z,
    westLon: bounds.west,
    southLat: bounds.south,
    lines,
  });
  return {
    bytes,
    count: lines.length,
    // WHERE THE ANSWER CAME FROM: the county's index was already in memory,
    // or this request built it. The tile route sends this as `X-Gev-Cache`.
    cache: index.built ? 'index' : 'memory',
  };
}

/** Drop the cached county indexes and the housing-unit counts. For tests. */
export function _resetTractIndexesForTest() {
  countyIndexes.clear();
  housing = null;
  housingPending = null;
}

/**
 * Street tiles, cut from the Census TIGER EDGES files.
 *
 * THE PROBLEM. A county's street centrelines are tens of megabytes of
 * coordinates - El Paso County is 17,205 edges and Denver is 88,524 - and a
 * phone cannot be sent all of them, and a browser cannot draw them. A tile is
 * the answer: the county is cut into Web Mercator tiles, the browser asks for
 * the ones it can see, and the server sends back only those.
 *
 * THE SOURCE IS THE RAW EDGES RECORDS, and that is not a detail.
 * `countyEdges()` returns one object per STREET SIDE and drops every edge
 * whose side has no address range - which on Douglas County is 2,468 of the
 * 6,671 named centrelines, so 63% of the county's streets. A map built from
 * it has holes. The map's source is one line per NAMED record, whether or
 * not anybody has a house number for it.
 *
 * PARSE ONCE. Reading and parsing the county's EDGES archive is the
 * expensive part - twenty seven megabytes for Denver - and it is cached per
 * county, keyed by the archive's mtime and size, so a re-downloaded archive
 * drops the index rather than serving stale streets.
 *
 * The format is GEVS, in `src/data/streetTile.js`, because the server writes
 * it and the browser reads it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { GEVS_EXTENT, encodeStreetTile } from '../../src/data/streetTile.js';
import {
  lonLatToTileLocal,
  tileBounds,
} from '../../src/layers/streetLevel/tileMath.js';
import { countyEdgeRecords, countyEdgesPath } from './tigerStreets.js';

/**
 * The zooms the desk's map asks for.
 *
 * Fourteen is the county overview, sixteen is a city, and eighteen is a
 * street. The tiles are cut from a 1 km-ish source, so there is nothing to
 * gain above eighteen.
 */
export const STREET_TILE_ZOOMS = Object.freeze([12, 13, 14, 15, 16, 17, 18]);

/** The county indexes, by key. */
const indexes = new Map();

/**
 * The index for one county, parsed once.
 *
 * @param {string} state two-digit state FIPS
 * @param {string} county three-digit county FIPS
 * @returns {Promise<{key: string, lines: Array<object>}>}
 */
export async function countyIndex(state, county) {
  // The key is the archive's mtime and size, and finding those is a STAT -
  // not a parse. So the cache is checked BEFORE the twenty seven megabytes are
  // read, which is the difference between a tile request that takes six
  // hundred milliseconds and one that takes five.
  const file = await countyEdgesPath(state, county);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }
  const key = `${state}${county}:${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`;
  const cached = indexes.get(key);
  if (cached) return cached;

  const { rows, shapes } = await countyEdgeRecords(state, county);

  const lines = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const name = row.FULLNAME;
    if (!name) continue;
    const record = shapes.records[index];
    if (!record) continue;
    const points = record.parts.length ? record.parts[0] : [];
    if (!points || points.length < 4) continue;
    // The bounding box, computed ONCE here rather than per tile request.
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (let p = 0; p + 1 < points.length; p += 2) {
      const lon = points[p];
      const lat = points[p + 1];
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    lines.push({
      index,
      name,
      west,
      south,
      east,
      north,
      points,
    });
  }

  const built = { key, lines, file };
  // The old index is dropped when the archive changed, and the new one takes
  // its place, so there is never more than one county's geometry in memory
  // per county.
  for (const [existing, value] of indexes) {
    if (existing.startsWith(`${state}${county}:`)) indexes.delete(existing);
  }
  indexes.set(key, built);
  return built;
}

/**
 * Clip a segment to a rectangle, and return the part that is inside.
 *
 * Liang-Barsky: the segment is a parametric line from P0 to P1, and the
 * rectangle gives a range of `t` that is inside. The result is the piece of
 * the segment between the two ends of that range.
 *
 * @param {number[]} p0 [x0, y0]
 * @param {number[]} p1 [x1, y1]
 * @param {number} minX
 * @param {number} minY
 * @param {number} maxX
 * @param {number} maxY
 * @returns {number[]|null} the clipped segment, or null
 */
function clipSegment(p0, p1, minX, minY, maxX, maxY) {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  let t0 = 0;
  let t1 = 1;
  const edges = [
    [-dx, p0[0] - minX],
    [dx, maxX - p0[0]],
    [-dy, p0[1] - minY],
    [dy, maxY - p0[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [p0[0] + t0 * dx, p0[1] + t0 * dy, p0[0] + t1 * dx, p0[1] + t1 * dy];
}

/**
 * One street tile.
 *
 * @param {string} state two-digit state FIPS
 * @param {string} county three-digit county FIPS
 * @param {number} z the zoom
 * @param {number} x the tile column
 * @param {number} y the tile row
 * @returns {Promise<{bytes: Uint8Array, count: number}>}
 */
export async function streetTile(state, county, z, x, y) {
  const index = await countyIndex(state, county);
  const bounds = tileBounds(x, y, z);
  const lines = [];

  for (const line of index.lines) {
    if (line.east < bounds.west || line.west > bounds.east) continue;
    if (line.north < bounds.south || line.south > bounds.north) continue;

    // The line is projected into TILE-LOCAL units, where the tile is the
    // extent square, and then clipped to it.
    const local = [];
    for (let p = 0; p + 1 < line.points.length; p += 2) {
      const [px, py] = lonLatToTileLocal(
        line.points[p],
        line.points[p + 1],
        GEVS_EXTENT,
        x,
        y,
        z,
      );
      local.push([px, py]);
    }
    if (local.length < 2) continue;

    // The clipped polyline. A line that crosses the tile comes out as a run of
    // segments, and the run is joined so the street is drawn as one path.
    const kept = [];
    for (let i = 1; i < local.length; i += 1) {
      const clipped = clipSegment(
        local[i - 1],
        local[i],
        0,
        0,
        GEVS_EXTENT,
        GEVS_EXTENT,
      );
      if (!clipped) continue;
      const start = [clipped[0], clipped[1]];
      const end = [clipped[2], clipped[3]];
      if (!kept.length) kept.push(start);
      kept.push(end);
    }
    if (kept.length < 2) continue;
    lines.push({ edgeIndex: line.index, points: kept });
  }

  const bytes = encodeStreetTile({
    zoom: z,
    westLon: bounds.west,
    southLat: bounds.south,
    lines,
  });
  return { bytes, count: lines.length };
}

/**
 * The zoom levels a map at this viewport should ask for.
 *
 * @param {number} width the viewport's width in pixels
 * @param {number} height the viewport's height in pixels
 * @returns {number}
 */
export function zoomForViewport(width, height) {
  // The tile is 256 pixels and the map is `size` pixels across, so the zoom is
  // the log of how many tiles fit across.
  const size = Math.max(1, Math.min(width, height));
  return Math.max(
    12,
    Math.min(18, Math.round(Math.log2((size / 256) * 2 ** 16))),
  );
}

/** Drop the cached county indexes. For tests. */
export function _resetTileIndexesForTest() {
  indexes.clear();
}

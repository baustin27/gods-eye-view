/**
 * Putting the radar over the tracts.
 *
 * The only way to say "houses in the swath" honestly is to lay the 1 km radar
 * field over a boundary that is FINER than the answer. At county level the
 * cell grid is 28 by 21 kilometres and three quarters of US counties are two
 * to four cells wide, so a county-level number is a total with a decimal
 * point on it. At tract level the radar cell is smaller than the tract, and
 * the number is a number of doors.
 *
 * Two independent things have to be true for this to work and both are here:
 *
 *   - the radar. The 1 km MRMS MESH field, one shard per calendar day, for
 *     2024-01-01 to 2026-10-15. It is a sibling of the 0.25-degree field and
 *     NOT a mode of it: the two index spaces are 25x apart in each axis and
 *     index 0 means a different place in each, so a decoder shared between
 *     them returns plausible numbers for cells that are not there.
 *
 *   - the geography. Census tracts, which the ACS publishes a housing count
 *     for, keyed by the same eleven-digit GEOID.
 *
 * WHAT THIS DOES NOT SAY. A tract that the radar reached is a tract to work,
 * and every house in it is a candidate - but the radar cannot say the hail
 * fell on that particular roof, and neither can anything else in public
 * data. A report is a stone somebody measured; the radar is where hail fell.
 * The number is a canvass universe, and it is labelled as one.
 */

import { decodeRing } from './adminBoundaries.js';

/**
 * The samples taken per radar cell.
 *
 * The CENTRE plus the four CORNERS. The centre alone would put every cell in
 * exactly one tract, so a cell straddling a boundary would give all of its
 * hail to one side and none to the other. The corners split it.
 */
const CORNER_OFFSETS = Object.freeze([
  [0, 0],
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
]);

/**
 * The area of one radar cell, in square kilometres, at a given latitude.
 *
 * A radar cell is a 0.01-degree square, so its area shrinks towards the
 * poles: 1.24 km2 on the equator and 0.86 km2 at 49 degrees north. A share
 * computed with the cell area from the wrong latitude is wrong by the same
 * factor, and the factor is 15 percent - which is a bigger error than the
 * thing being measured.
 *
 * @param {number} lat the latitude, in degrees
 * @param {number} stepDeg the cell size, in degrees
 * @returns {number} the cell's area, in square kilometres
 */
export function cellAreaKm2(lat, stepDeg = 0.01) {
  const degreesToKm = 111.32;
  const side = stepDeg * degreesToKm;
  return side * side * Math.cos((lat * Math.PI) / 180);
}

/**
 * The area of a set of polygons, in square kilometres.
 *
 * The shoelace on a local equirectangular projection, which is exact enough
 * at the size of a tract: the error goes as the square of the tract's own
 * size over the radius of the earth, and a hundred-kilometre tract is a
 * tenth of a percent out.
 *
 * @param {Array<Array<Array<number>>>} polygons the polygons, as
 *   `[outer, ...holes]` of rings, each ring a list of [lon, lat]
 * @returns {number} the area, in square kilometres
 */
export function ringAreaKm2(polygons) {
  let total = 0;
  for (const polygon of polygons || []) {
    for (const ring of polygon || []) {
      if (!ring || ring.length < 3) continue;
      const lat0 = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
      const perDegree = 111320 * Math.cos((lat0 * Math.PI) / 180);
      let twice = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [x0, y0] = ring[j];
        const [x1, y1] = ring[i];
        twice += x0 * perDegree * y1 * 111320 - x1 * perDegree * y0 * 111320;
      }
      total += Math.abs(twice / 2) / 1e6;
    }
  }
  return total;
}

/**
 * The decoded tract boundaries, indexed for point-in-polygon.
 *
 * @param {Array<object>} features the tracts pack's features
 * @param {number} decimals the pack's decimals
 * @returns {{byGeoid: Map<string, object>, grid: Map<string, Array<object>>}}
 */
export function indexTracts(features, decimals = 4) {
  const byGeoid = new Map();
  const grid = new Map();
  for (const feature of features || []) {
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
    const entry = {
      geoid: feature.geoid,
      rings,
      minLat,
      minLon,
      maxLat,
      maxLon,
      // THE TRACT'S OWN LAND AREA, in square kilometres.
      //
      // The Census publishes it (ALAND, in square metres) and it is the
      // denominator a share of the tract has to use: the houses are on the
      // land, and the ring we simplified carries whatever water the tract
      // has in it plus its own simplification error - 8 percent of the
      // country's tracts are more than a tenth over the Census's own figure
      // because of the first of those.
      //
      // A tract with no published area falls back to its own ring, which is
      // worse, and is better than nothing.
      areaKm2: feature.aland ? feature.aland / 1e6 : ringAreaKm2(rings),
    };
    byGeoid.set(feature.geoid, entry);
    for (let lat = Math.floor(minLat); lat <= Math.floor(maxLat); lat += 1) {
      for (let lon = Math.floor(minLon); lon <= Math.floor(maxLon); lon += 1) {
        const key = `${lat}:${lon}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(entry);
      }
    }
  }
  return { byGeoid, grid };
}

/** The tract containing this point, or null. */
function tractAt(index, lat, lon) {
  const candidates = index.grid.get(`${Math.floor(lat)}:${Math.floor(lon)}`);
  if (!candidates) return null;
  for (const tract of candidates) {
    if (lat < tract.minLat || lat > tract.maxLat) continue;
    if (lon < tract.minLon || lon > tract.maxLon) continue;
    for (const polygon of tract.rings) {
      const [outer, ...holes] = polygon;
      if (!pointInRing(outer, lat, lon)) continue;
      if (holes.some((hole) => pointInRing(hole, lat, lon))) continue;
      return tract.geoid;
    }
  }
  return null;
}

/**
 * The tracts the radar reached, and how hard.
 *
 * @param {object} index from {@link indexTracts}
 * @param {Array<object>} cells fine radar cells: `{i, j, maxMm}` on the
 *   0.01-degree grid
 * @param {object} options
 * @param {number} options.thresholdMm the hail size that counts as a hit
 * @param {number} options.stepDeg the radar cell size in degrees
 * AND HOW MUCH OF EACH TRACT WAS UNDER THE HAIL, which is the number that
 * makes a house count a claim rather than a total.
 *
 * The cell test takes FIVE samples of every cell - its centre and its four
 * corners - and the samples that land inside a tract are a measure of how
 * much of that cell the tract holds. A tract that took all five of a cell's
 * samples took the cell; a tract that took one took a corner of it. So the
 * share of a tract under the hail is the samples it took, times the cell's
 * area, over the tract's area.
 *
 * The share is capped at one, and a tract SMALLER THAN ONE CELL that the hail
 * reached is counted whole: the 1 km field cannot say whether it covered
 * that tract or clipped its edge, and a number that pretends to know is
 * worse than the conservative one.
 *
 * @returns {Map<string, {geoid: string, maxMm: number, cells: number,
 *   samples: number, share: number}>}
 */
export function tractsReached(
  index,
  cells,
  { thresholdMm = 25.4, stepDeg = 0.01 } = {},
) {
  const out = new Map();
  for (const cell of cells || []) {
    if (!Number.isFinite(cell?.maxMm)) continue;
    if (cell.maxMm < thresholdMm) continue;
    const centreLat = cell.i * stepDeg + stepDeg / 2;
    const centreLon = cell.j * stepDeg + stepDeg / 2;
    for (const [dLat, dLon] of CORNER_OFFSETS) {
      const lat = centreLat + dLat * stepDeg;
      const lon = centreLon + dLon * stepDeg;
      const geoid = tractAt(index, lat, lon);
      if (!geoid) continue;
      let row = out.get(geoid);
      if (!row) {
        row = { geoid, maxMm: 0, cells: 0, samples: 0, lastCell: null };
        out.set(geoid, row);
      }
      row.samples += 1;
      if (cell.maxMm > row.maxMm) row.maxMm = cell.maxMm;
      // A cell counts ONCE per tract, however many of its samples land there.
      // All the samples of a cell are consecutive, so remembering the last cell
      // is enough to avoid counting it twice.
      const cellKey = `${cell.i}:${cell.j}`;
      if (row.lastCell !== cellKey) {
        row.cells += 1;
        row.lastCell = cellKey;
      }
    }
  }
  // The share, for each tract the hail reached.
  for (const row of out.values()) {
    row.share = shareOfTract(
      index.byGeoid.get(row.geoid),
      row.samples,
      stepDeg,
    );
  }
  return out;
}

/**
 * The share of a tract that was under the hail.
 *
 * @param {object} tract the indexed tract
 * @param {number} samples the cell samples that landed inside it
 * @param {number} stepDeg the radar cell size in degrees
 * @returns {number} the share, from 0 to 1
 */
export function shareOfTract(tract, samples, stepDeg = 0.01) {
  const area = tract?.areaKm2;
  if (!Number.isFinite(area) || area <= 0) return 1;
  const cell = cellAreaKm2((tract.minLat + tract.maxLat) / 2, stepDeg);
  if (!Number.isFinite(cell) || cell <= 0) return 1;
  // A tract smaller than one cell is either wholly under the hail or not in
  // it at all, as far as a 1 km field is concerned.
  if (area <= cell) return 1;
  // Each of the five samples stands for a fifth of the cell's area, and the
  // samples that landed inside are the part of the cell the tract holds.
  const covered = (samples * cell) / CORNER_OFFSETS.length;
  return Math.max(0, Math.min(1, covered / area));
}

/**
 * A ray cast, in the same form as the admin boundaries use.
 *
 * Deliberately a COPY rather than an import: `adminBoundaries.js` is a browser
 * module that reaches for bundled JSON, and the desk must be able to use this
 * without dragging that in. The two are the same algorithm and the same
 * argument order - ring points are [lon, lat] and the point is (lat, lon) -
 * and the copied comment is the reason that order is not accidental.
 */
function pointInRing(ring, lat, lon) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

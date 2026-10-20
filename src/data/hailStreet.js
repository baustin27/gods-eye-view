/**
 * Which streets were under the hail.
 *
 * The knock list needs one number that the street file does not have: not how
 * many addresses a street carries, but how many of them were UNDER the storm.
 * A street list sorted by address count is a list of long streets. A street
 * list sorted by what fell on it is a work list.
 *
 * WHERE THE HAIL FELL IS KNOWN EXACTLY. The 1 km MRMS MESH field is a grid, one
 * cell per 0.01 degrees, and a cell is either over the threshold or it is not.
 * So the honest join is not street-to-tract - the tract is an averaging
 * container and joining to it throws away the boundary between two streets
 * that both sit inside one hit tract - it is street-to-CELL. The radar cell is
 * smaller than a census tract and usually smaller than a city block, which is
 * the finest thing anybody can say about where hail fell.
 *
 * WHAT THE NUMBER IS. A street edge is a LINE, and a hail cell is an AREA, so
 * the line is partly in and partly out. The number reported is the share of
 * the edge's LENGTH that lay in a cell over the threshold, times the addresses
 * in the edge's range:
 *
 *     addresses under the hail = addresses in the range x share of the edge
 *                                 that was under the hail
 *
 * A street edge crossing a hit cell for a tenth of its length gives a tenth of
 * its addresses. That is what the arithmetic says, and it is the only version
 * of the number that is not a claim the radar cannot support.
 *
 * WHAT THE NUMBER IS NOT. It is not a claim that those roofs were damaged.
 * The radar is sound about WHERE hail fell and unsound about how big each
 * stone was; the reports are the opposite. So this is a canvass universe: the
 * addresses on a street that were under hail on a day, ranked so that the
 * canvasser starts where the hail was.
 */

import { RADAR_FINE_GRID } from './stormDatasets.js';

/** The fine grid's cell size in degrees. 0.01 degrees is about a kilometre. */
export const FINE_CELL_DEG = RADAR_FINE_GRID.deg;

/**
 * The metres in one degree of latitude, and in one degree of longitude at the
 * equator.
 *
 * Longitude degrees are shorter away from the equator, so the longitude scale
 * is multiplied by the cosine of the latitude. Skipping that is a mistake that
 * is invisible at Denver and visible in Florida: a degree of longitude there is
 * 93 km, not 111, and a street measured 20% long would carry 20% too many
 * addresses under the hail.
 */
const METRES_PER_DEG_LAT = 110574;
const METRES_PER_DEG_LON_EQUATOR = 111320;

/**
 * The default spacing of the samples along an edge.
 *
 * 60 metres. A radar cell is about 1.1 km north-south and 0.85 km east-west
 * at mid-latitude, so 60 m resolves a cell boundary to within about a
 * sixteenth of a cell. Finer than this costs time and buys nothing: the
 * number is already an estimate of a share, and it is reported as one.
 */
export const DEFAULT_SAMPLE_METRES = 60;

/**
 * The bias applied when deciding which cell a point is in.
 *
 * A tenth of a MILLIMETRE of latitude, in degrees: 1e-9. It exists because
 * 0.01 is not a number a double can hold exactly, so dividing a latitude by it
 * is not exact either. At 38.83 degrees - Colorado Springs - the division
 * returns 3882.9999999999995, and taking the floor of that puts the point in
 * the row BELOW the one it is in, one row north of where the hail was.
 *
 * That is not a rounding curiosity. It moved every street in the county one
 * cell off the hail, and the knock list came back with nothing under it and
 * no error anywhere: the arithmetic was exact, and it was exactly wrong.
 *
 * The bias is a thousand times the largest error the division can carry at
 * these magnitudes (about 2e-12) and a hundred thousand times smaller than
 * the cell itself, so it moves only points that are within a tenth of a
 * millimetre of a boundary.
 */
const CELL_EPSILON = 1e-9;

/**
 * The index of the fine grid cell that contains this point.
 *
 * The cell (i, j) covers latitudes [i*deg, (i+1)*deg) and longitudes
 * [j*deg, (j+1)*deg), which is the convention the fine shard's own centre
 * convention implies: a cell's centre is (i*deg + deg/2, j*deg + deg/2).
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {number} the cell index, or -1 when the point is off the grid
 */
export function fineCellIndexAt(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return -1;
  const i = Math.floor(lat / FINE_CELL_DEG + CELL_EPSILON);
  const j = Math.floor(lon / FINE_CELL_DEG + CELL_EPSILON);
  if (
    i < RADAR_FINE_GRID.rowBase ||
    i >= RADAR_FINE_GRID.rowBase + RADAR_FINE_GRID.rows ||
    j < RADAR_FINE_GRID.colBase ||
    j >= RADAR_FINE_GRID.colBase + RADAR_FINE_GRID.columns
  ) {
    return -1;
  }
  return (i - RADAR_FINE_GRID.rowBase) * RADAR_FINE_GRID.columns +
    (j - RADAR_FINE_GRID.colBase);
}

/**
 * The length of one leg of a polyline, in metres.
 *
 * @param {Array<number>} points flat [lon, lat, lon, lat, ...]
 * @param {number} from the index of the first vertex
 * @returns {number}
 */
function legMetres(points, from) {
  const lon1 = points[from * 2];
  const lat1 = points[from * 2 + 1];
  const lon2 = points[from * 2 + 2];
  const lat2 = points[from * 2 + 3];
  const midLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const dx = (lon2 - lon1) * METRES_PER_DEG_LON_EQUATOR * Math.cos(midLat);
  const dy = (lat2 - lat1) * METRES_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/**
 * The length of a polyline, in metres.
 *
 * @param {Array<number>} points flat [lon, lat, lon, lat, ...]
 * @returns {number}
 */
export function polylineLengthMetres(points) {
  if (!Array.isArray(points) || points.length < 4) return 0;
  let total = 0;
  for (let i = 0; i + 3 < points.length; i += 2) {
    total += legMetres(points, i / 2);
  }
  return total;
}

/**
 * The share of a street edge that was under the hail.
 *
 * The edge is walked at a fixed spacing and each sample is looked up in the
 * set of cells that were over the threshold. The share is the fraction of
 * samples that landed in one of them.
 *
 * Sampling rather than exact clipping is a deliberate choice. Exact clipping
 * against the cell squares would be more precise, but it is a different
 * function of the same geometry, and the difference between "17% of this
 * street" and "18% of this street" is not worth a second geometry engine in
 * the path of a knock list. What matters is that the number is a share of a
 * LENGTH rather than a flag, so that a street half in the hail and half out
 * of it does not come back as a full street.
 *
 * @param {Array<number>} points flat [lon, lat, lon, lat, ...]
 * @param {Set<number>} hitCells the fine grid indices that were over the
 *   threshold that day
 * @param {object} [options]
 * @param {number} [options.sampleMetres] the spacing of the samples
 * @returns {{fraction: number, metres: number, samples: number}}
 */
export function hailFraction(points, hitCells, options = {}) {
  const sampleMetres = options.sampleMetres || DEFAULT_SAMPLE_METRES;
  const empty = { fraction: 0, metres: 0, samples: 0 };
  if (!Array.isArray(points) || points.length < 4) return empty;
  if (!hitCells || hitCells.size === 0) return empty;

  const vertexCount = Math.floor(points.length / 2);
  const cumulative = new Float64Array(vertexCount);
  for (let i = 1; i < vertexCount; i += 1) {
    cumulative[i] = cumulative[i - 1] + legMetres(points, i - 1);
  }
  const total = cumulative[vertexCount - 1];
  if (!(total > 0)) return empty;

  const steps = Math.max(1, Math.ceil(total / sampleMetres));
  let hits = 0;
  let cursor = 0;
  for (let k = 0; k <= steps; k += 1) {
    const distance = (k / steps) * total;
    while (cursor + 1 < vertexCount - 1 && cumulative[cursor + 1] < distance) {
      cursor += 1;
    }
    const legStart = cumulative[cursor];
    const legLength = cumulative[cursor + 1] - legStart;
    const t = legLength > 0 ? (distance - legStart) / legLength : 0;
    const lon =
      points[cursor * 2] + (points[cursor * 2 + 2] - points[cursor * 2]) * t;
    const lat =
      points[cursor * 2 + 1] +
      (points[cursor * 2 + 3] - points[cursor * 2 + 1]) * t;
    const index = fineCellIndexAt(lat, lon);
    if (index >= 0 && hitCells.has(index)) hits += 1;
  }
  const fraction = hits / (steps + 1);
  return {
    fraction,
    metres: fraction * total,
    samples: steps + 1,
  };
}

/**
 * The set of fine grid cells that were over the threshold on a day.
 *
 * @param {Array<{i: number, j: number, maxMm: number}>} cells the day's cells
 * @param {number} thresholdMm
 * @returns {Set<number>}
 */
export function hitCellSet(cells, thresholdMm) {
  const out = new Set();
  for (const cell of cells || []) {
    if (!Number.isFinite(cell?.maxMm)) continue;
    if (cell.maxMm < thresholdMm) continue;
    const index =
      (cell.i - RADAR_FINE_GRID.rowBase) * RADAR_FINE_GRID.columns +
      (cell.j - RADAR_FINE_GRID.colBase);
    if (index < 0 || index >= RADAR_FINE_GRID.cellCount) continue;
    out.add(index);
  }
  return out;
}

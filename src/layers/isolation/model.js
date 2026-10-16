/**
 * Isolation mode — the pure geometry half: what gets dimmed, and where the
 * camera goes.
 *
 * `src/data/isolation.js` answers "which named place is this" and hands back one
 * or two antimeridian-safe boxes. This module turns those boxes into the two
 * things the layer actually draws and moves:
 *
 *   1. `scrimRectangles(boxes)` — the rectangles that dim everything OUTSIDE the
 *      isolation, as `[west, south, east, north]` quadruples.
 *   2. `framingForBoxes(boxes)` — a camera centre and altitude that fit the
 *      isolation, so `flyTo` is arithmetic a test can check.
 *
 * WHY THE SCRIM IS NOT "FOUR RECTANGLES PER BOX". The obvious construction is
 * the complement of a box drawn as north / south / west / east. That is right
 * for a box that sits in the middle of the world, and wrong the moment the
 * isolation straddles the antimeridian. `normaliseBbox` splits the United States
 * into `[172.5, 18.9, 180, 71.4]` (the Aleutians) and `[-180, 18.9, -67.0, 71.4]`
 * (everything else), and the complement of the PAIR is not the complement of
 * either part: it must leave the Aleutian sliver AND the seam undimmed. Taking
 * each box on its own would paint a scrim straight over the Aleutians — which is
 * the exact thing the split exists to prevent.
 *
 * So the complement is computed as a set, not per box: every box edge becomes a
 * grid line, each cell of the resulting grid is wholly inside or wholly outside
 * every box (no edge crosses a cell interior), and the outside cells are merged
 * into the fewest rectangles by extending each horizontal run downward while the
 * identical run below it is still free. Worked example, United States:
 *
 *   longitude lines  -180, -67.0, 172.5, 180
 *   latitude  lines   -90, 18.9, 71.4, 90
 *   outside cells     the whole top row, the whole bottom row, and the middle
 *                     band from -67.0 to 172.5
 *   result            3 rectangles — and the Aleutian sliver at 172.5..180 is
 *                     not covered by any of them.
 *
 * PURE module — no Cesium, no DOM, node-testable.
 *
 * @module layers/isolation/model
 */

import { normaliseBbox } from '../../data/isolation.js';

/** The whole world, as a rectangle's worth of edges. */
export const WORLD_WEST = -180;
export const WORLD_EAST = 180;
export const WORLD_SOUTH = -90;
export const WORLD_NORTH = 90;

/** Kilometres per degree of latitude. Mean radius, the usual compromise. */
const KM_PER_DEGREE = 111.32;

/**
 * Lower than this a camera is inside the county being isolated, and the scrim's
 * own edge is off-screen; higher than this and a place is framed from orbit.
 */
export const MIN_FRAME_ALTITUDE_M = 120_000;

/**
 * Ceiling for a country-scale isolation.
 *
 * Eight million metres is a little over one Earth radius, which is where the
 * curvature stops being a detail and the far limb of the globe comes into frame.
 */
export const MAX_FRAME_ALTITUDE_M = 8_000_000;

/**
 * Altitude as a multiple of the framed radius.
 *
 * 1.7, not a guess: Cesium's default field of view is 60°, so a camera looking
 * straight down sees a ground half-extent of about `h · tan(30°) = 0.577h`. A
 * radius `R` therefore needs `h ≈ R / 0.577 ≈ 1.73R`, and 1.7 leaves a few per
 * cent of margin. A tighter factor crops the corners off the continent; a
 * looser one puts the island in the middle of an ocean.
 */
export const FRAME_ALTITUDE_FACTOR = 1.7;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * A candidate box reduced to a drawable `[west, south, east, north]`, or null.
 *
 * Defensive on purpose: `scrimRectangles` is handed whatever a caller resolved,
 * and a NaN edge in the grid silently produces a scrim that dims everything or
 * nothing. A box that cannot be drawn is dropped rather than clamped into a lie.
 *
 * @param {number[]} box
 * @returns {number[]|null}
 */
function cleanBox(box) {
  if (!Array.isArray(box) || box.length < 4) return null;
  const west = Number(box[0]);
  const south = Number(box[1]);
  const east = Number(box[2]);
  const north = Number(box[3]);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  const out = [
    clamp(Math.min(west, east), WORLD_WEST, WORLD_EAST),
    clamp(Math.min(south, north), WORLD_SOUTH, WORLD_NORTH),
    clamp(Math.max(west, east), WORLD_WEST, WORLD_EAST),
    clamp(Math.max(south, north), WORLD_SOUTH, WORLD_NORTH),
  ];
  // Zero extent is a line, not an area: it has no interior to keep undimmed, so
  // drawing a scrim around it would dim the world for nothing.
  if (out[2] <= out[0] || out[3] <= out[1]) return null;
  return out;
}

/**
 * The boxes for an isolation, antimeridian-safe.
 *
 * Accepts an area, a `{ area }` wrapper as `resolveIsolation` returns it, or a
 * bare bbox. Normalisation is delegated to `data/isolation.js` so this layer and
 * the filter always agree about which boxes an isolation is — a second opinion
 * here would be how a point ends up inside the filter and outside the box on
 * screen.
 *
 * @param {object|number[]} area
 * @returns {number[][]} zero, one or two `[west, south, east, north]` boxes
 */
export function isolationBoxes(area) {
  const unit = Array.isArray(area)
    ? area
    : Array.isArray(area?.bbox)
      ? area.bbox
      : Array.isArray(area?.area?.bbox)
        ? area.area.bbox
        : null;
  if (!unit) return [];
  return normaliseBbox(unit).map(cleanBox).filter(Boolean);
}

/** Sorted, de-duplicated edges. Exact equality is right: the values came from
 *  the same boxes, so equal means equal. */
function gridLines(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Merged, sorted, non-overlapping `[west, east]` intervals. */
function unionIntervals(intervals) {
  const merged = [];
  for (const [west, east] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    // `<=` rather than `<`: two boxes that merely touch have no gap between
    // them, and leaving a zero-width gap here would emit a degenerate rectangle.
    if (last && west <= last[1]) last[1] = Math.max(last[1], east);
    else merged.push([west, east]);
  }
  return merged;
}

/** The part of the world an interval set leaves over. */
function complement(intervals) {
  const open = [];
  let cursor = WORLD_WEST;
  for (const [west, east] of intervals) {
    if (west > cursor) open.push([cursor, west]);
    cursor = Math.max(cursor, east);
  }
  if (cursor < WORLD_EAST) open.push([cursor, WORLD_EAST]);
  return open;
}

/** A stable identity for an interval set, so equal bands can be merged. */
const intervalKey = (intervals) =>
  intervals.map(([west, east]) => `${west}:${east}`).join('|');

/**
 * The rectangles that dim everything OUTSIDE an isolation.
 *
 * Two claims, both testable, and the second is the one a naive four-rectangles-
 * per-box construction fails: every point inside an isolation box is covered by
 * NO scrim rectangle, and every point outside every box is covered by at least
 * one. Holding both across a seam is why this slices by latitude and unions
 * longitudes per band instead of complementing boxes one at a time.
 *
 * Output shape is the canonical one a reader would draw by hand: a full-width
 * band above the isolation, a full-width band below it, and the leftover
 * longitude bands between. Bands whose longitude complement is identical are
 * merged back together, which is what turns the caps into two rectangles and
 * leaves a seam-straddling pair at three.
 *
 * @param {number[][]} boxes one or two `[west, south, east, north]` boxes, as
 *   `normaliseBbox` returns them
 * @returns {number[][]} `[west, south, east, north]` quads covering the
 *   complement, in a stable order; empty when there is no isolation or the
 *   isolation is the whole world
 */
export function scrimRectangles(boxes) {
  const inside = (Array.isArray(boxes) ? boxes : [])
    .map(cleanBox)
    .filter(Boolean);
  if (!inside.length) return [];
  const lats = gridLines([
    WORLD_SOUTH,
    WORLD_NORTH,
    ...inside.flatMap((box) => [box[1], box[3]]),
  ]);
  // Every box edge is a latitude band edge, so a band's midpoint cannot land on
  // one: the midpoint answers for the whole band, exactly.
  const bands = [];
  for (let index = 0; index < lats.length - 1; index += 1) {
    const south = lats[index];
    const north = lats[index + 1];
    const lat = (south + north) / 2;
    bands.push({
      south,
      north,
      open: complement(
        unionIntervals(
          inside
            .filter((box) => lat >= box[1] && lat <= box[3])
            .map((box) => [box[0], box[2]]),
        ),
      ),
    });
  }
  const merged = [];
  for (const band of bands) {
    const last = merged.at(-1);
    if (last && intervalKey(last.open) === intervalKey(band.open))
      last.north = band.north;
    else merged.push({ south: band.south, north: band.north, open: band.open });
  }
  return merged.flatMap((band) =>
    band.open.map(([west, east]) => [west, band.south, east, band.north]),
  );
}

/**
 * Altitude that frames a radius, clamped to something usable at both ends.
 * @param {number} radiusKm
 * @returns {number} metres
 */
export function frameAltitude(radiusKm) {
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) return MIN_FRAME_ALTITUDE_M;
  return Math.min(
    MAX_FRAME_ALTITUDE_M,
    Math.max(
      MIN_FRAME_ALTITUDE_M,
      Math.round(radiusKm * 1000 * FRAME_ALTITUDE_FACTOR),
    ),
  );
}

/**
 * Where to put the camera so an isolation fits the view.
 *
 * Frames the LARGEST box, not the union. For a split isolation the union is an
 * arc running to the seam — framing it for the United States means a camera high
 * enough to see the Aleutians, with the mainland a small shape in the middle of
 * an ocean. The mainland is the part somebody meant, and the layer says which
 * box it framed so the panel can offer the other.
 *
 * Pure, so the arithmetic is testable without a viewer.
 *
 * @param {number[][]} boxes
 * @returns {{lat: number, lon: number, radiusKm: number, altitudeM: number,
 *            box: number[], index: number}|null}
 */
export function framingForBoxes(boxes) {
  const clean = (Array.isArray(boxes) ? boxes : [])
    .map(cleanBox)
    .filter(Boolean);
  if (!clean.length) return null;
  let best = 0;
  let bestArea = -1;
  clean.forEach(([west, south, east, north], index) => {
    const area = (east - west) * (north - south);
    if (area > bestArea) {
      bestArea = area;
      best = index;
    }
  });
  const [west, south, east, north] = clean[best];
  const lat = (south + north) / 2;
  const lon = (west + east) / 2;
  // The longitude half-extent narrows with the cosine of the latitude, which is
  // why a box in Alaska reads wider than it looks on a Mercator-ish mental map.
  const halfLatKm = ((north - south) / 2) * KM_PER_DEGREE;
  const halfLonKm =
    ((east - west) / 2) * KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  const radiusKm = Math.hypot(halfLatKm, halfLonKm);
  return {
    lat,
    lon,
    radiusKm,
    altitudeM: frameAltitude(radiusKm),
    box: [...clean[best]],
    index: best,
  };
}

/**
 * The one-line note a split isolation has to carry.
 *
 * A viewer seeing an island in the corner and a rectangle over the mainland
 * would otherwise read the map as broken rather than as a shape that crosses the
 * date line.
 *
 * @param {number[][]} boxes
 * @returns {string} '' unless the isolation was split
 */
export function splitNote(boxes) {
  return (Array.isArray(boxes) ? boxes.length : 0) > 1
    ? `${boxes.length} boxes — this area crosses the antimeridian; both parts are drawn and the band between them stays lit.`
    : '';
}

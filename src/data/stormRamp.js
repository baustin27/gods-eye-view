/**
 * THE STORM RAMP: one set of bands, one set of colours, one set of edges.
 *
 * The globe draws a storm, the desk draws a storm, the per-storm artifact
 * draws a storm and the gallery draws a storm. They are four pictures of the
 * same weather, and a person who sees the violet on the globe and a
 * different violet on the desk has to work out whether they are looking at
 * the same storm - and they should not have to.
 *
 * So the ramp lives here, once. The thresholds, the colours, the label and
 * the colour of the band's own edge are all in the same record, because the
 * edge is part of the band: a band's outline is the NEXT HOTTER band's
 * colour, which is the only way to draw a stack of translucent bands and
 * still see where one ends and the next begins.
 *
 * The order is ASCENDING, coldest first, because that is the order a ramp is
 * read in and the order the bands are sorted into. The globe wants the
 * hottest first, and reverses it where it needs to.
 *
 * The thresholds are in MILLIMETRES, and one inch is 25.4 millimetres
 * exactly. Not 25: a ramp that bands at 25 starts a millimetre under the
 * product's stated floor, and the quarter-inch stone it then paints in the
 * colour that means "one to one and a half inches" is a size nobody
 * inferred.
 */

/** The radar's floor: an inch, exactly. */
export const STORM_FLOOR_MM = 25.4;

/**
 * The ramp, coldest band first.
 *
 * @type {ReadonlyArray<Readonly<{min: number, color: string, outline: string, label: string}>>}
 */
export const STORM_RAMP = Object.freeze([
  Object.freeze({
    min: STORM_FLOOR_MM,
    color: '#6d28d9',
    outline: '#9333ea',
    label: '1-1.5"',
  }),
  Object.freeze({
    min: 38.1,
    color: '#9333ea',
    outline: '#c026d3',
    label: '1.5-2"',
  }),
  Object.freeze({
    min: 50.8,
    color: '#c026d3',
    outline: '#e879f9',
    label: '2-2.75"',
  }),
  Object.freeze({
    min: 69.85,
    color: '#e879f9',
    outline: '#fdf4ff',
    label: '2.75-3.5"',
  }),
  Object.freeze({
    min: 88.9,
    color: '#fdf4ff',
    outline: '#ffffff',
    label: '3.5"+',
  }),
]);

/**
 * The ramp, hottest band first.
 *
 * The globe walks the bands from the top down, and the desk's painter wants
 * the coldest first, so both orders come from the one list.
 *
 * @returns {ReadonlyArray<object>} a new array, hottest first
 */
export function stormRampDescending() {
  return [...STORM_RAMP].reverse();
}

/**
 * The colour of a reading in millimetres, or null when it is under the
 * floor.
 *
 * A reading under the floor has NO colour, on purpose: the old fallback
 * returned the coldest band's colour, so every sub-inch cell was painted in
 * the colour that MEANS "one to one and a half inches" - the map asserting a
 * size nobody inferred.
 *
 * @param {number} mm
 * @returns {string|null}
 */
export function stormColorFor(mm) {
  if (!Number.isFinite(mm)) return null;
  // The HOTTEST band the reading falls into, not the first one it clears: a
  // 100 mm reading is in the 3.5-inch band, and the coldest band it also
  // clears is not the band that says how big the hail was.
  let color = null;
  for (const step of STORM_RAMP) {
    if (mm >= step.min) color = step.color;
  }
  return color;
}

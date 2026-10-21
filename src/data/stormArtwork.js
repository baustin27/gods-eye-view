/**
 * The storm artwork: one storm, drawn.
 *
 * THE SAME PAINTER DRAWS THE GALLERY AND THE ARTIFACT. The gallery is a
 * page you look at to choose a treatment; the artifact is the PNG you attach
 * to a claim. They have to be the same picture, or the picture a person
 * approves is not the picture that goes out.
 *
 * The artifact is the thing the competitors sell. HailTrace charges $229 for
 * one storm, one state, and Hail Recon charges $1,999 a year for the same
 * thing. What they sell is a PICTURE of a swath with a count of the affected
 * structures on it. This is that picture, and it is drawn from the data
 * rather than from a raster somebody prepared.
 *
 * And it carries its sources on it, which is the difference: the bands are
 * thresholds over the 1 km MRMS MESH field, the house counts are ACS B25001,
 * and the date and the sources are ON THE PICTURE. A picture that says where
 * its numbers came from can be attached to a claim. A picture that does not
 * is an opinion.
 *
 * The geometry is the repo's own: `contourRings` for the bands, and the same
 * annular construction the globe uses, so the bands share one interpolated
 * line and tile exactly.
 */

import { contourRings } from '../layers/stormReports/model.js';
import { STORM_RAMP } from './stormRamp.js';

/**
 * The bands, in the order they are drawn.
 *
 * THE RAMP IS IN ONE PLACE. The globe draws a storm, the desk draws a storm,
 * the artifact draws a storm and the gallery draws a storm, and they are
 * four pictures of the same weather. `src/data/stormRamp.js` holds the
 * thresholds, the colours and the labels, so the four cannot drift apart.
 */
export const ARTWORK_BANDS = STORM_RAMP;

/** The grid step of the fine field, in degrees. */
const FINE_DEG = 0.01;

/**
 * Whether a point is inside a ring, in degrees.
 *
 * @param {{lat: number, lon: number}} point
 * @param {Array<{lat: number, lon: number}>} ring
 * @returns {boolean}
 */
export function pointInRingDegrees(point, ring) {
  let inside = false;
  for (
    let at = 0, prev = ring.length - 1;
    at < ring.length;
    prev = at, at += 1
  ) {
    const y0 = ring[prev].lat;
    const x0 = ring[prev].lon;
    const y1 = ring[at].lat;
    const x1 = ring[at].lon;
    if (y0 > point.lat !== y1 > point.lat) {
      const cross = ((x1 - x0) * (point.lat - y0)) / (y1 - y0) + x0;
      if (point.lon < cross) inside = !inside;
    }
  }
  return inside;
}

/**
 * The bands of a storm, as rings.
 *
 * The bands are ANNULAR: the whole field is contoured once per level and each
 * band is the region between two levels, so the bands share one interpolated
 * line and tile exactly. A level with no cells in its range is skipped,
 * because the band at a level is the region BETWEEN that level and the next
 * one up - the fringe - and a level with no cells in it has an empty fringe.
 *
 * @param {Array<{i: number, j: number, maxMm: number}>} cells
 * @returns {Array<{band: object, outer: Array<object>, holes: Array<Array<object>>}>}
 */
export function artworkBands(cells) {
  const field = (cells || []).map((cell) => ({
    i: cell.i,
    j: cell.j,
    v: cell.maxMm,
  }));
  const ascending = [...ARTWORK_BANDS].sort((a, b) => a.min - b.min);
  const counts = new Array(ascending.length).fill(0);
  for (const cell of field) {
    for (let k = 0; k < ascending.length; k += 1) {
      const next = k + 1 < ascending.length ? ascending[k + 1].min : Infinity;
      if (cell.v >= ascending[k].min && cell.v < next) {
        counts[k] += 1;
        break;
      }
    }
  }
  const contours = ascending.map((band) =>
    contourRings(field, band.min - 0.01, FINE_DEG),
  );
  const out = [];
  for (let k = 0; k < ascending.length; k += 1) {
    if (!counts[k]) continue;
    const band = ascending[k];
    const hotter = contours[k + 1] || [];
    for (const ring of contours[k]) {
      const holes = [...(ring.holes || [])];
      for (const hotterRing of hotter) {
        if (
          hotterRing.outer?.length &&
          pointInRingDegrees(hotterRing.outer[0], ring.outer)
        ) {
          holes.push(hotterRing.outer);
        }
      }
      out.push({ band, outer: ring.outer, holes });
    }
  }
  return out;
}

/**
 * The bounds of a set of GRID CELLS, with a little air around them.
 *
 * The cells carry their position as grid indices, so the bounds are computed
 * from the indices and not from a latitude and a longitude.
 *
 * @param {Array<{i: number, j: number}>} cells
 * @returns {{west: number, south: number, east: number, north: number}|null}
 */
export function artworkBounds(cells) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const cell of cells || []) {
    const lon = cell.j * FINE_DEG;
    const lat = cell.i * FINE_DEG;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (!Number.isFinite(west)) return null;
  const padLon = Math.max(0.05, (east - west) * 0.04);
  const padLat = Math.max(0.05, (north - south) * 0.04);
  return {
    west: west - padLon,
    south: south - padLat,
    east: east + padLon,
    north: north + padLat,
  };
}

/**
 * The bounds of a set of PLACES, with a little air around them.
 *
 * The places carry a latitude and a longitude, and the picture is of the
 * places, so these are the bounds the picture is framed by. They are NOT the
 * same thing as {@link artworkBounds}, which takes grid indices: mixing the two
 * puts the frame in the middle of the Atlantic.
 *
 * @param {Array<{lat: number, lon: number}>} places
 * @returns {{west: number, south: number, east: number, north: number}|null}
 */
export function artworkPlaceBounds(places) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const place of places || []) {
    if (!Number.isFinite(place?.lon) || !Number.isFinite(place?.lat)) continue;
    if (place.lon < west) west = place.lon;
    if (place.lon > east) east = place.lon;
    if (place.lat < south) south = place.lat;
    if (place.lat > north) north = place.lat;
  }
  if (!Number.isFinite(west)) return null;
  const padLon = Math.max(0.08, (east - west) * 0.25);
  const padLat = Math.max(0.08, (north - south) * 0.25);
  return {
    west: west - padLon,
    south: south - padLat,
    east: east + padLon,
    north: north + padLat,
  };
}

/**
 * An SVG path from an outer ring and its holes.
 *
 * @param {Array<{lat: number, lon: number}>} outer
 * @param {Array<Array<{lat: number, lon: number}>>} holes
 * @param {(point: object) => [number, number]} project
 * @returns {string}
 */
function pathOf(outer, holes, project) {
  const one = (ring) =>
    ring
      .map((point, index) => {
        const [x, y] = project(point);
        return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join('') + 'Z';
  return one(outer) + holes.map(one).join('');
}

/**
 * Escape the characters that would break the XML.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The storm's picture, as an SVG.
 *
 * @param {object} input
 * @param {Array<object>} input.cells the day's fine cells
 * @param {string} input.day the day, ISO
 * @param {Array<object>} [input.places] the places it reached
 * @param {number} [input.maxMm] the largest reading that day
 * @param {number} [input.width]
 * @param {number} [input.height]
 * @returns {string} the SVG
 */
export function stormArtwork(input) {
  const width = input.width ?? 1200;
  const height = input.height ?? 820;
  const panelWidth = 320;
  const mapWidth = width - panelWidth;
  const places = (input.places || []).slice(0, 13);
  // The picture is of the PLACES, so the bounds come from them. The field
  // holds every cell in the country, and a picture of one state's storm drawn
  // on the whole country is a picture of the country with a state on it.
  // The frame is the PLACES, so a picture of one state's storm is a picture of
  // that state and not of the country with a state on it.
  const placeBounds = places.length
    ? artworkPlaceBounds(places)
    : artworkBounds(input.cells);
  // The cells inside it, and then the frame is tightened to the HAIL and the
  // places together - so the storm fills the picture instead of floating in
  // the middle of the state.
  const cells = (input.cells || []).filter((cell) => {
    if (!placeBounds) return false;
    const lon = cell.j * FINE_DEG;
    const lat = cell.i * FINE_DEG;
    return (
      lon >= placeBounds.west &&
      lon <= placeBounds.east &&
      lat >= placeBounds.south &&
      lat <= placeBounds.north
    );
  });
  const hailBounds = artworkBounds(cells);
  const bounds =
    hailBounds && placeBounds
      ? {
          west: Math.min(hailBounds.west, placeBounds.west),
          south: Math.min(hailBounds.south, placeBounds.south),
          east: Math.max(hailBounds.east, placeBounds.east),
          north: Math.max(hailBounds.north, placeBounds.north),
        }
      : placeBounds;
  const bands = bounds ? artworkBands(cells) : [];

  const project = bounds
    ? (point) => [
        ((point.lon - bounds.west) / (bounds.east - bounds.west)) * mapWidth,
        ((bounds.north - point.lat) / (bounds.north - bounds.south)) * height,
      ]
    : () => [0, 0];

  const drawn = bands
    .map(
      (band) =>
        `<path d="${pathOf(band.outer, band.holes, project)}" fill="${
          band.band.color
        }" fill-opacity="0.88" fill-rule="evenodd" stroke="${
          band.band.color
        }" stroke-width="1.2" stroke-opacity="0.9"/>`,
    )
    .join('');

  const dots = places
    .map((place) => {
      if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) {
        return '';
      }
      const [x, y] = project({ lat: place.lat, lon: place.lon });
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="#3ad6c8" stroke="#0a0e13" stroke-width="1"/>`;
    })
    .join('');

  const houses = (input.places || []).reduce(
    (total, place) => total + (Number(place.houses) || 0),
    0,
  );

  const legend = [...ARTWORK_BANDS]
    .reverse()
    .map(
      (band, index) =>
        `<g transform="translate(${(index % 2) * 150}, ${Math.floor(index / 2) * 24})">` +
        `<rect x="0" y="0" width="14" height="14" rx="2" fill="${band.color}"/>` +
        `<text x="22" y="12" fill="#dce6f0" font-family="monospace" font-size="13">${band.label}</text>` +
        '</g>',
    )
    .join('');

  const placeRows = places
    .map(
      (place, index) =>
        `<text x="0" y="${index * 19}" fill="#8ea3b8" font-family="monospace" font-size="12">` +
        `${index + 1}. ${escapeXml(place.name || '')}${
          place.st ? `, ${escapeXml(place.st)}` : ''
        } — ${(Number(place.houses) || 0).toLocaleString()} houses</text>`,
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#0a0e13"/>
  <rect width="${mapWidth}" height="${height}" fill="#05080b"/>
  ${drawn}
  ${dots}
  <rect x="${mapWidth}" width="${panelWidth}" height="${height}" fill="#10161d"/>
  <g transform="translate(${mapWidth},0)">
  <text x="20" y="34" fill="#3ad6c8" font-family="monospace" font-size="15" letter-spacing="2">HAIL DESK</text>
  <text x="20" y="66" fill="#dce6f0" font-family="monospace" font-size="20">${escapeXml(input.day || '')}</text>
  <text x="20" y="92" fill="#8ea3b8" font-family="monospace" font-size="12">${(Number(input.maxMm) || 0).toFixed(0)} mm — the largest reading that day</text>
  <text x="20" y="112" fill="#8ea3b8" font-family="monospace" font-size="12">${houses.toLocaleString()} houses in ${places.length} places</text>
  <g transform="translate(20,150)">
    <text x="0" y="0" fill="#8ea3b8" font-family="monospace" font-size="12" letter-spacing="1">RADAR BANDS</text>
    <g transform="translate(0,16)">${legend}</g>
  </g>
  <g transform="translate(20,268)">
    <text x="0" y="0" fill="#8ea3b8" font-family="monospace" font-size="12" letter-spacing="1">PLACES</text>
    <g transform="translate(0,22)">${placeRows}</g>
  </g>
  <g transform="translate(20,${height - 96})">
    <text x="0" y="0" fill="#5d7085" font-family="monospace" font-size="10">Radar: NOAA/NSSL MRMS MESH, 1 km</text>
    <text x="0" y="16" fill="#5d7085" font-family="monospace" font-size="10">Houses: US Census ACS 5-year B25001</text>
    <text x="0" y="40" fill="#5d7085" font-family="monospace" font-size="10">A band is the ground over the threshold,</text>
    <text x="0" y="56" fill="#5d7085" font-family="monospace" font-size="10">not a claim that any roof was damaged.</text>
  </g>
  </g>
</svg>`;
}

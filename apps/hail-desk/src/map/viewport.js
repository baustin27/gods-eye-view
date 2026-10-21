/**
 * The map viewport: where the map is looking, and what that means in pixels.
 *
 * The projection is Web Mercator, the same one every tile server speaks, and
 * the same one the street tiles are cut in. The arithmetic is here rather
 * than in the tile maths because the map needs the FORWARD projection at
 * every zoom the camera moves through, and it needs it fast.
 *
 * The world is a square of tiles at the current zoom: `2^z` columns and rows
 * of 256 pixels. A view is a centre, a zoom and a size, and everything else
 * - which tiles to fetch, where a place goes on the screen - follows from
 * those three.
 */

/** The pixels across one tile. */
export const TILE_SIZE = 256;

/** The furthest the map zooms out, and in. */
export const MIN_ZOOM = 4;
export const MAX_ZOOM = 18;

/** The latitude Web Mercator cannot reach. */
const MERCATOR_LAT_LIMIT = 85.05112878;

function clampLat(lat) {
  return Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat));
}

function clampZoom(zoom) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/**
 * The world's pixel coordinates of a point, at a zoom.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {number} zoom
 * @returns {{x: number, y: number}}
 */
export function worldPixels(lon, lat, zoom) {
  const n = 2 ** zoom;
  const latRad = (clampLat(lat) * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n * TILE_SIZE,
    y:
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      n *
      TILE_SIZE,
  };
}

/**
 * The point at a world pixel, at a zoom.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} zoom
 * @returns {{lon: number, lat: number}}
 */
export function worldPoint(x, y, zoom) {
  const n = 2 ** zoom;
  const lon = (x / (n * TILE_SIZE)) * 360 - 180;
  const n2 = Math.PI - (2 * Math.PI * y) / (n * TILE_SIZE);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n2) - Math.exp(-n2)));
  return { lon, lat };
}

/**
 * A viewport: a centre, a zoom, and a size.
 *
 * @param {object} [options]
 * @param {{lon: number, lat: number}} [options.centre]
 * @param {number} [options.zoom]
 * @param {number} [options.width]
 * @param {number} [options.height]
 */
export function createViewport(options = {}) {
  return {
    centre: {
      lon: options.centre?.lon ?? -104.76,
      lat: options.centre?.lat ?? 38.85,
    },
    zoom: clampZoom(options.zoom ?? 11),
    width: options.width ?? 800,
    height: options.height ?? 600,
  };
}

/**
 * Where a point lands on the screen.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {object} viewport
 * @returns {{x: number, y: number}}
 */
export function project(lon, lat, viewport) {
  const world = worldPixels(lon, lat, viewport.zoom);
  const centre = worldPixels(
    viewport.centre.lon,
    viewport.centre.lat,
    viewport.zoom,
  );
  return {
    x: world.x - centre.x + viewport.width / 2,
    y: world.y - centre.y + viewport.height / 2,
  };
}

/**
 * The point under a screen pixel.
 *
 * @param {number} x
 * @param {number} y
 * @param {object} viewport
 * @returns {{lon: number, lat: number}}
 */
export function unproject(x, y, viewport) {
  const centre = worldPixels(
    viewport.centre.lon,
    viewport.centre.lat,
    viewport.zoom,
  );
  const world = {
    x: x - viewport.width / 2 + centre.x,
    y: y - viewport.height / 2 + centre.y,
  };
  return worldPoint(world.x, world.y, viewport.zoom);
}

/**
 * Where a tile's top-left corner lands on the screen.
 *
 * @param {{z: number, x: number, y: number}} tile
 * @param {object} viewport
 * @param {number} size the tile's size in pixels
 * @returns {{x: number, y: number}}
 */
export function viewportPixel(tile, viewport, size) {
  const scale = 2 ** (viewport.zoom - tile.z);
  const worldX = tile.x * size * scale;
  const worldY = tile.y * size * scale;
  const centreWorld = worldPixels(
    viewport.centre.lon,
    viewport.centre.lat,
    viewport.zoom,
  );
  return {
    x: worldX - centreWorld.x + viewport.width / 2,
    y: worldY - centreWorld.y + viewport.height / 2,
  };
}

/**
 * The tiles the viewport can see.
 *
 * @param {object} viewport
 * @returns {Array<{z: number, x: number, y: number}>}
 */
export function visibleTiles(viewport) {
  const n = 2 ** viewport.zoom;
  const topLeft = unproject(0, 0, viewport);
  const bottomRight = unproject(viewport.width, viewport.height, viewport);
  const firstX = Math.floor(
    ((topLeft.lon + 180) / 360) * n,
  );
  const lastX = Math.floor(((bottomRight.lon + 180) / 360) * n);
  const firstY = Math.floor(
    ((1 -
      Math.log(
        Math.tan((clampLat(topLeft.lat) * Math.PI) / 180) +
          1 / Math.cos((clampLat(topLeft.lat) * Math.PI) / 180),
      ) / Math.PI) /
      2) *
      n,
  );
  const lastY = Math.floor(
    ((1 -
      Math.log(
        Math.tan((clampLat(bottomRight.lat) * Math.PI) / 180) +
          1 / Math.cos((clampLat(bottomRight.lat) * Math.PI) / 180),
      ) / Math.PI) /
      2) *
      n,
  );
  const tiles = [];
  for (let y = Math.max(0, firstY); y <= Math.min(n - 1, lastY); y += 1) {
    for (let x = Math.max(0, firstX); x <= Math.min(n - 1, lastX); x += 1) {
      tiles.push({ z: viewport.zoom, x, y });
    }
  }
  return tiles;
}

/**
 * Move the centre by a screen-pixel offset.
 *
 * @param {object} viewport
 * @param {number} dx
 * @param {number} dy
 * @returns {object} a new viewport
 */
export function panBy(viewport, dx, dy) {
  const centre = worldPixels(
    viewport.centre.lon,
    viewport.centre.lat,
    viewport.zoom,
  );
  const moved = worldPoint(centre.x - dx, centre.y - dy, viewport.zoom);
  return { ...viewport, centre: moved };
}

/**
 * Zoom, keeping the point under the cursor where it is.
 *
 * @param {object} viewport
 * @param {number} zoom
 * @param {number} x the cursor's screen x
 * @param {number} y the cursor's screen y
 * @returns {object} a new viewport
 */
export function zoomAround(viewport, zoom, x, y) {
  const next = clampZoom(zoom);
  if (next === viewport.zoom) return viewport;
  const under = unproject(x, y, viewport);
  const world = worldPixels(under.lon, under.lat, next);
  const centreWorld = worldPixels(
    viewport.centre.lon,
    viewport.centre.lat,
    next,
  );
  const centre = worldPoint(
    centreWorld.x + (x - viewport.width / 2),
    centreWorld.y + (y - viewport.height / 2),
    next,
  );
  return { ...viewport, zoom: next, centre };
}

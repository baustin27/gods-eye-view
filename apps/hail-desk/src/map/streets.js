/**
 * The street tiles, and the strokes they become.
 *
 * A tile is fetched from the desk's own API - `/api/desk/tiles/...` - in the
 * GEVS format the server writes and this reads. The lines come back in
 * TILE-LOCAL units, where the tile is the extent square, and they are
 * converted to screen pixels here.
 *
 * The tile is fetched at the VIEWPORT's zoom, so a tile's pixel origin is
 * simply where the tile's top-left corner is on the screen, and a tile-local
 * unit is a sixteenth of a pixel.
 */

import {
  GEVS_EXTENT,
  decodeStreetTile,
} from '../../../../src/data/streetTile.js';
import { TILE_SIZE, viewportPixel } from './viewport.js';

/**
 * A cache of decoded street tiles.
 */
export function createStreetCache(limit = 60) {
  const entries = new Map();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * Load and decode one street tile.
 *
 * @param {{z: number, x: number, y: number}} tile
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<Array<{edgeIndex: number, points: Array<[number, number]>}>}
 */
export async function loadStreetTile(
  tile,
  { state, county, fetchImpl = globalThis.fetch } = {},
) {
  // The county and the state are IN the path: a tile is a county's streets
  // cut up, so the request has to say which county.
  if (!state || !county) return [];
  const url = `/api/desk/tiles/${state}/${county}/${tile.z}/${tile.x}/${tile.y}`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.gev.street-tile' },
  });
  if (!response.ok) return [];
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) return [];
  return decodeStreetTile(bytes).lines;
}

/**
 * The street painter.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createStreetPainter({ fetchImpl = globalThis.fetch } = {}) {
  const cache = createStreetCache();
  const pending = new Map();

  /**
   * Draw the streets, once they are in.
   *
   * @param {CanvasRenderingContext2D} ctx
   @param {object} viewport
   */
  async function draw(ctx, viewport, tiles, options = {}) {
    const { state, county } = options;
    const scale = TILE_SIZE / GEVS_EXTENT;
    ctx.lineWidth = options.lineWidth ?? 1;
    ctx.strokeStyle = options.strokeStyle ?? 'rgba(120, 190, 255, 0.55)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const tile of tiles) {
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      let lines = cache.get(key);
      if (!lines) {
        if (!pending.has(key)) {
          pending.set(
            key,
            loadStreetTile(tile, { state, county, fetchImpl })
              .then((loaded) => {
                cache.set(key, loaded);
                pending.delete(key);
                return loaded;
              })
              .catch(() => {
                pending.delete(key);
                return [];
              }),
          );
        }
        lines = await pending.get(key);
      }
      if (!lines || !lines.length) continue;
      const origin = viewportPixel(tile, viewport, TILE_SIZE);
      ctx.beginPath();
      for (const line of lines) {
        for (let i = 0; i < line.points.length; i += 1) {
          const [lx, ly] = line.points[i];
          const x = origin.x + lx * scale;
          const y = origin.y + ly * scale;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
  }

  return { draw, cache };
}

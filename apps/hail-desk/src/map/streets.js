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
  { fetchImpl = globalThis.fetch } = {},
) {
  // The county is NOT in the path. The county is a fact about the tile, and
  // the server has the boundaries to work it out with - so the map can pan
  // across a county line and keep its roads, instead of losing them at the
  // line with nothing to say why.
  const url = `/api/desk/tiles/${tile.z}/${tile.x}/${tile.y}`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.gev.street-tile' },
  });
  // A 204 is an empty tile: there are no streets in it, and that is an
  // answer. Any other failure THROWS, so the painter remembers the tile as
  // failed instead of asking for it again on every frame - a county whose
  // data is not here answered 404 sixty times a second and took the
  // browser's renderer down.
  if (response.status === 204) return [];
  if (!response.ok) {
    throw new Error(`street tile ${response.status} for ${url}`);
  }
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
export function createStreetPainter({
  fetchImpl = globalThis.fetch,
  onTile,
} = {}) {
  const cache = createStreetCache();
  const pending = new Map();
  // The tiles that FAILED, so they are not asked for again on every frame.
  //
  // A county whose data is not here answers 404, and a painter that forgets
  // that asks again on the next frame, and the next, and the next - a
  // request flood that took the browser's renderer down. A tile that is not
  // there is not going to be there.
  const failed = new Map();
  const FAILED_TTL_MS = 60_000;

  /**
   * Draw the streets, once they are in.
   *
   * SYNCHRONOUS, for the same reason the basemap is.
   *
   * @param {CanvasRenderingContext2D} ctx
   @param {object} viewport
   */
  function draw(ctx, viewport, tiles, options = {}) {
    const scale = TILE_SIZE / GEVS_EXTENT;
    ctx.lineWidth = options.lineWidth ?? 1;
    // THE STREETS FADE WITH THE ZOOM.
    //
    // A city grid at state zoom is a solid block of blue, and a solid block
    // of blue is not a map - it is a rectangle of noise drawn where the
    // county is. At street level the same lines are the thing a person is
    // looking for, so they are at full strength there.
    const zoom = viewport.zoom ?? 11;
    const fade = Math.max(0.12, Math.min(0.55, 0.12 + (zoom - 8) * 0.055));
    ctx.strokeStyle =
      options.strokeStyle ??
      `rgba(120, 190, 255, ${fade.toFixed(3)})`;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const tile of tiles) {
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      const lines = cache.get(key);
      if (!lines) {
        const dead = failed.get(key);
        if (dead !== undefined) {
          if (Date.now() - dead < FAILED_TTL_MS) continue;
          failed.delete(key);
        }
        // The same rule as the basemap: fetch in the background, draw what is
        // here. Awaiting the tiles emptied the map on every pan.
        if (!pending.has(key)) {
          pending.set(
            key,
            loadStreetTile(tile, { fetchImpl })
              .then((loaded) => {
                cache.set(key, loaded);
                pending.delete(key);
                if (loaded) onTile?.();
                return loaded;
              })
              .catch(() => {
                failed.set(key, Date.now());
                pending.delete(key);
                return [];
              }),
          );
        }
        continue;
      }
      if (!lines.length) continue;
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

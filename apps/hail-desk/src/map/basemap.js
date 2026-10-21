/**
 * The basemap: Esri's World Imagery, as raster tiles on a canvas.
 *
 * WHY ESRI AND NOT OSM. The OSMF tile usage policy forbids offline use of
 * the public tile servers and requires an identifying User-Agent - and a
 * browser cannot set its own, so the tiles come back `x-blocked: Access
 * denied`. Esri's public World Imagery endpoint needs no key, no referer and
 * no user agent, and it sends `Access-Control-Allow-Origin: *`.
 *
 * WHY `crossOrigin` IS SET BEFORE `src`. A canvas that has drawn a cross
 * origin image is TAINTED, and every read of its pixels throws a
 * SecurityError. The desk's map composites the swath over the imagery and
 * exports an image of the result, so it reads pixels - and an untainted
 * canvas needs the image to be fetched with CORS from the start. Setting the
 * attribute AFTER the `src` is the classic way to get this wrong, because the
 * fetch has already started.
 *
 * The attribution is not optional: Esri's service requires it, and it is
 * drawn on the map rather than hidden behind a toggle.
 */

/** The tile URL template. Note the ORDER: the REST path is level/row/column. */
import { viewportPixel } from './viewport.js';

export const ESRI_WORLD_IMAGERY =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

/** The credit the service requires. */
export const ESRI_ATTRIBUTION =
  'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

/**
 * A cache of loaded tiles.
 *
 * The tiles are small - 256 pixels of JPEG, a few tens of kilobytes - and a
 * pan across a county touches a dozen of them, so a map that fetched them
 * again on every frame would be unusable.
 */
export function createTileCache(limit = 240) {
  const entries = new Map();
  // A tile that FAILED is remembered as a failure, with a time, so it is not
  // asked for again on every frame. A tile that is not there is asked for
  // again and again, and a server that is slow to refuse is a server the map
  // hammers for the whole session.
  const failures = new Map();
  const FAILURE_TTL_MS = 30_000;
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) {
        const failed = failures.get(key);
        if (failed !== undefined) {
          if (Date.now() - failed < FAILURE_TTL_MS) return null;
          failures.delete(key);
        }
        return null;
      }
      // Re-insert, so the Map's insertion order is the recency order.
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      failures.delete(key);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
    },
    /** Remember that a tile could not be had. */
    fail(key) {
      if (!entries.has(key)) failures.set(key, Date.now());
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * Load one basemap tile.
 *
 * @param {{z: number, x: number, y: number}} tile
 * @param {object} [options]
 * @param {typeof Image} [options.ImageImpl]
 * @returns {Promise<HTMLImageElement|null>} null when the tile is not there
 */
export function loadBasemapTile(tile, { ImageImpl = globalThis.Image } = {}) {
  const url = ESRI_WORLD_IMAGERY.replace(
    '{z}',
    String(tile.z),
  )
    .replace('{y}', String(tile.y))
    .replace('{x}', String(tile.x));
  return new Promise((resolve) => {
    const image = new ImageImpl();
    // BEFORE the src. See the file's note: this is what keeps the canvas
    // untainted, and every pixel read of a tainted canvas throws.
    image.crossOrigin = 'anonymous';
    image.referrerPolicy = 'no-referrer';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/**
 * The basemap painter.
 *
 * @param {object} [options]
 * @param {typeof Image} [options.ImageImpl]
 */
export function createBasemap({ ImageImpl = globalThis.Image, onTile } = {}) {
  const cache = createTileCache();
  const pending = new Map();

  /**
   * Draw the basemap under everything else.
   *
   * SYNCHRONOUS, and that is the whole point of it: the cached tiles are
   * drawn immediately and the missing ones are fetched in the background, so
   * the frame on screen never goes blank.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} viewport
   @param {import('./viewport.js').visibleTiles} tiles
   */
  function draw(ctx, viewport, tiles) {
    const size = 256;
    for (const tile of tiles) {
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      const image = cache.get(key);
      if (!image) {
        // Start the fetch and CARRY ON. The tile arrives later and asks for a
        // redraw. Awaiting it here meant the canvas was cleared and left
        // BLANK until the network came back, so every pan emptied the map and
        // refilled it a moment later, and dragging felt like dragging a hole.
        if (!pending.has(key)) {
          pending.set(
            key,
            loadBasemapTile(tile, { ImageImpl }).then((loaded) => {
              if (loaded) cache.set(key, loaded);
              else cache.fail(key);
              pending.delete(key);
              if (loaded) onTile?.();
              return loaded;
            }),
          );
        }
        continue;
      }
      const origin = viewportPixel(tile, viewport, size);
      ctx.drawImage(image, origin.x, origin.y, size, size);
    }
  }

  return { draw, cache };
}



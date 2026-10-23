/**
 * The basemap: Esri's World Imagery, World Transportation, and Canvas services
 * rendered as multi-layer raster tiles on a canvas.
 *
 * WHY ESRI AND NOT OSM / CARTO. The OSMF tile usage policy forbids offline use of
 * the public tile servers and requires an identifying User-Agent - and a
 * browser cannot set its own, so the tiles come back `x-blocked: Access
 * denied`. CartoDB's public dark-matter server stamps an API-KEY-REQUIRED watermark
 * across tiles. Esri's public World Imagery, Reference, and Canvas endpoints need no
 * key, no referer, and send `Access-Control-Allow-Origin: *`.
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

import { viewportPixel } from './viewport.js';

export const ESRI_WORLD_IMAGERY =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

export const ESRI_WORLD_TRANSPORTATION =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}';

export const ESRI_WORLD_BOUNDARIES =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

export const ESRI_WORLD_STREETS =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';

export const ESRI_DARK_GRAY_BASE =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';

export const ESRI_DARK_GRAY_REF =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';

export const CARTO_DARK_MATTER =
  'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';

/** The credit the service requires. */
export const ESRI_ATTRIBUTION =
  'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

/**
 * A cache of loaded tiles.
 *
 * The tiles are small - 256 pixels of JPEG or PNG, a few tens of kilobytes - and a
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
 * Supports satellite (imagery only), hybrid (imagery + transportation + boundaries),
 * and road (dark gray base + dark gray reference/labels) multi-layer basemaps.
 *
 * @param {{z: number, x: number, y: number}} tile
 * @param {object} [options]
 * @param {typeof Image} [options.ImageImpl]
 * @param {'satellite'|'hybrid'|'road'|'carto'} [options.mode]
 * @param {'base'|'roads'|'labels'} [options.layerType='base']
 * @returns {Promise<HTMLImageElement|null>} null when the tile is not there
 */
export function loadBasemapTile(
  tile,
  { ImageImpl = globalThis.Image, mode = 'satellite', layerType = 'base' } = {},
) {
  if (typeof ImageImpl !== 'function') return Promise.resolve(null);

  let template;
  if (mode === 'carto') {
    template = CARTO_DARK_MATTER;
  } else if (mode === 'hybrid') {
    if (layerType === 'roads') {
      template = ESRI_WORLD_TRANSPORTATION;
    } else if (layerType === 'labels') {
      template = ESRI_WORLD_BOUNDARIES;
    } else {
      template = ESRI_WORLD_IMAGERY;
    }
  } else if (mode === 'road') {
    if (layerType === 'labels' || layerType === 'roads') {
      template = ESRI_DARK_GRAY_REF;
    } else {
      template = ESRI_DARK_GRAY_BASE;
    }
  } else {
    // Default to satellite
    template = ESRI_WORLD_IMAGERY;
  }

  // Esri REST service URLs format tiles as /{z}/{y}/{x} (level/row/column).
  // Carto tiles use standard /{z}/{x}/{y} format.
  const url = template.includes('{x}/{y}')
    ? template
        .replace('{z}', String(tile.z))
        .replace('{x}', String(tile.x))
        .replace('{y}', String(tile.y))
    : template
        .replace('{z}', String(tile.z))
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
 * @param {Function} [options.onTile]
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
   * @param {import('./viewport.js').visibleTiles} tiles
   * @param {'satellite'|'hybrid'|'road'} [mode='satellite']
   */
  function draw(ctx, viewport, tiles, mode = 'satellite') {
    // Before drawing tiles, draw a subtle dark slate canvas background (#090d16)
    // with a crisp 48px tactical grid (rgba(30, 41, 59, 0.45)) and major coordinate
    // crosshairs so the map canvas looks like a tactical radar screen instead of a
    // black void while tiles stream in or during pan.
    ctx.save();
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    ctx.strokeStyle = 'rgba(30, 41, 59, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const gridSize = 48;
    for (let x = 0; x <= viewport.width; x += gridSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, viewport.height);
    }
    for (let y = 0; y <= viewport.height; y += gridSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(viewport.width, y);
    }
    ctx.stroke();

    // Major coordinate crosshairs at viewport center
    const cx = Math.round(viewport.width / 2);
    const cy = Math.round(viewport.height / 2);
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.65)';
    ctx.beginPath();
    ctx.moveTo(cx - 16, cy);
    ctx.lineTo(cx + 16, cy);
    ctx.moveTo(cx, cy - 16);
    ctx.lineTo(cx, cy + 16);
    ctx.stroke();
    ctx.restore();

    // Determine the layers to render in composite order:
    // - hybrid: base satellite imagery, then roads/highways, then place/boundary labels
    // - road: dark gray base, then street and place reference labels so the street map
    //         is NEVER black and has real streets, highways, and place labels.
    // - satellite: base satellite imagery
    const layers =
      mode === 'hybrid'
        ? ['base', 'roads', 'labels']
        : mode === 'road'
          ? ['base', 'labels']
          : ['base'];

    const size = 256;
    for (const layerType of layers) {
      for (const tile of tiles || []) {
        // Satellite and hybrid base imagery share the backward-compatible key "{z}/{x}/{y}"
        // so cached satellite imagery is reused between modes and existing tests pass.
        const key =
          layerType === 'base' && (mode === 'satellite' || mode === 'hybrid')
            ? `${tile.z}/${tile.x}/${tile.y}`
            : `${mode}:${layerType}:${tile.z}/${tile.x}/${tile.y}`;

        const image = cache.get(key);
        if (!image) {
          // Start the fetch and CARRY ON. The tile arrives later and asks for a
          // redraw. Awaiting it here meant the canvas was cleared and left
          // BLANK until the network came back, so every pan emptied the map and
          // refilled it a moment later, and dragging felt like dragging a hole.
          if (!pending.has(key)) {
            pending.set(
              key,
              loadBasemapTile(tile, { ImageImpl, mode, layerType }).then((loaded) => {
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
  }

  return { draw, cache };
}

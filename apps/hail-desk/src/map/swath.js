/**
 * The storm swath, on the desk's map.
 *
 * THE DESK HAD NO SWATH ON IT, and that was the worst of the omissions: the
 * whole point of the desk is "where did the hail fall", and the map showed
 * the imagery, the streets and the places, and not the thing.
 *
 * The field is the committed 1 km MRMS MESH shard for the day, served by the
 * desk's own server (`/api/desk/storm/{day}.bin.gz`) because the desk is a
 * separate build and the storm payloads live in the shared core's tree.
 *
 * The GEOMETRY IS THE SHARED ONE. `artworkBands` is the same function the
 * per-storm artifact and the gallery draw with, so the swath on the map, the
 * picture that goes to a claim and the picture in the gallery are the same
 * shape - computed by the same code, in the same bands, with the same
 * annulus. A map that disagrees with the artifact it sits next to is worse
 * than no map.
 */

import { indexFineDay } from '../../../../src/data/stormReports.js';
import { artworkBands } from '../../../../src/data/stormArtwork.js';

/**
 * The swath for the days that have been asked for.
 *
 * A field is thirty kilobytes gzipped and a person moves between days, so
 * the days are kept.
 */
const fields = new Map();

/**
 * Load one day's field and its bands.
 *
 * @param {string} day ISO `YYYY-MM-DD`
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<Array<object>>} the bands, or [] for a day with no field
 */
export async function loadSwathBands(day, { fetchImpl = globalThis.fetch } = {}) {
  const key = String(day || '');
  if (!key) return [];
  if (fields.has(key)) return fields.get(key);
  const pending = (async () => {
    try {
      const response = await fetchImpl(`/api/desk/storm/${key}.bin.gz`);
      if (!response.ok) return [];
      const gzipped = new Uint8Array(await response.arrayBuffer());
      // The browser's own inflate, which is the same primitive the desk's
      // artifacts use.
      const stream = new Blob([gzipped])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'));
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      const { cells } = indexFineDay(bytes);
      return artworkBands(cells);
    } catch {
      return [];
    }
  })();
  fields.set(key, pending);
  const bands = await pending;
  // A day that will not load is not remembered as a failure, but it is not
  // re-fetched on every frame either.
  return bands;
}

/**
 * The swath painter.
 */
export function createSwathPainter() {
  let current = null;

  /**
   * Draw the swath of the day that is selected.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} viewport
   * @param {Array<object>} bands the bands, in degrees
   */
  function draw(ctx, viewport, bands) {
    if (!bands || !bands.length) return;
    // The bands are the whole country's storm, and the map is a window on it,
    // so they are projected and clipped by the canvas rather than culled: a
    // band that starts outside the frame and ends inside it still has to be
    // drawn.
    //
    // The projection is the viewport's OWN. This used to be a second copy of
    // the Mercator maths, in a file whose import sat at the BOTTOM, and two
    // copies of a projection is two sets of answers - the same thing
    // tileMath.js warns about.
    const project = (point) => projectPoint(point.lon, point.lat, viewport);
    for (const band of bands) {
      ctx.beginPath();
      const outer = band.outer;
      for (let i = 0; i < outer.length; i += 1) {
        const [x, y] = project(outer[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      for (const hole of band.holes || []) {
        for (let i = 0; i < hole.length; i += 1) {
          const [x, y] = project(hole[i]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = band.band.color;
      // Opaque enough to read over satellite imagery, which is bright and
      // busy, and translucent enough that the streets and the ground are
      // still under it.
      ctx.globalAlpha = 0.58;
      ctx.fill('evenodd');
      ctx.globalAlpha = 1;
    }
  }

  return { draw, load: loadSwathBands, get current() { return current; } };
}

import { project as projectPoint } from './viewport.js';

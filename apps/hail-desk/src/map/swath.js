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
import { indexSubDailyDay } from '../../../../src/data/subDailyRadar.js';
import { inflateBytesUint8Array } from '../../../../src/data/stormReports.inflateHelper.js';
import { artworkBands } from '../../../../src/data/stormArtwork.js';

/**
 * The swath for the days that have been asked for.
 *
 * A field is thirty kilobytes gzipped and a person moves between days, so
 * the days are kept.
 */
const fields = new Map();

/** The frames, kept the same way the days are: a person moves between them. */
const frameBands = new Map();

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
 * The bands of ONE FRAME of a day, from the sub-daily shard.
 *
 * The desk drew a whole day as if a storm were eighteen hours of weather.
 * It was not: a storm is an hour of weather, and the sub-daily shards say
 * which hour. The frames of the shard that covers a day are the six-hourly
 * windows ending at 06Z, 12Z, 18Z and 00Z.
 *
 * @param {string} day the shard's day
 * @param {number} frame the frame index, 0 to 3
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<Array<object>>} the bands, or [] for a day with no shard
 */
export async function loadFrameBands(
  day,
  frame,
  { fetchImpl = globalThis.fetch } = {},
) {
  const key = `${day}:${frame}`;
  if (frameBands.has(key)) return frameBands.get(key);
  const pending = (async () => {
    try {
      const response = await fetchImpl(`/api/desk/subdaily/${day}.bin.gz`);
      if (!response.ok) return [];
      // The shared inflate helper, which looks at the magic before it
      // inflates: a server that answers a `.gz` with `Content-Encoding:
      // gzip` has already decompressed the body, and inflating it again
      // fails in a way that reads as an absent shard rather than a broken
      // one.
      const bytes = await inflateBytesUint8Array(
        new Uint8Array(await response.arrayBuffer()),
      );
      const { frames } = indexSubDailyDay(bytes);
      return artworkBands(frames[frame] || []);
    } catch {
      return [];
    }
  })();
  frameBands.set(key, pending);
  return pending;
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
   * @param {((point: {lon: number, lat: number}) => {x: number, y: number})} [projectFn]
   */
  function draw(ctx, viewport, bands, projectFn) {
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
    // The viewport's projection returns a POINT, not a pair of numbers, so
    // it is read as a point here. Reading it as a pair is the kind of
    // mistake that draws nothing at all and says nothing about why.
    const project = projectFn || ((point) => projectPoint(point.lon, point.lat, viewport));
    for (const band of bands) {
      ctx.beginPath();
      const outer = band.outer;
      for (let i = 0; i < outer.length; i += 1) {
        const { x, y } = project(outer[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      for (const hole of band.holes || []) {
        for (let i = 0; i < hole.length; i += 1) {
          const { x, y } = project(hole[i]);
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
      // The band's own edge, in the NEXT HOTTER band's colour. That is the
      // only way to draw a stack of translucent bands and still see where
      // one ends and the next begins - and it is the same edge the globe
      // draws, because the ramp is in one place.
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = band.band.outline || 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  return { draw, load: loadSwathBands, get current() { return current; } };
}

import { project as projectPoint } from './viewport.js';

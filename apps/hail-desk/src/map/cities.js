/**
 * The city lines.
 *
 * THE DESK HAD THE CITIES AS DOTS and no outline for any of them, so "which
 * city am I looking at" was a question the map could not answer — and a
 * canvasser working a storm that stopped on a city line has no way to see
 * where the line is.
 *
 * The boundaries are the Census places, from the pack the repo already
 * ships, served a state at a time by the desk's own API. They are drawn
 * under the hail, because a city line is a reference and the hail is the
 * subject.
 *
 * They are SIMPLIFIED, like every other boundary here, and a place that is
 * a few hundred metres of generalised line is a place you can see the edge
 * of and not one you can survey a property line from.
 */

import { project } from './viewport.js';

/**
 * The city painter.
 */
export function createCityPainter() {
  /**
   * Draw the city outlines.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} viewport
   * @param {Array<Array<Array<number>>>} outlines the rings, as [lon, lat]
   * @param {((lon: number, lat: number) => {x: number, y: number})} [projectFn]
   */
  function draw(ctx, viewport, outlines, projectFn) {
    if (!Array.isArray(outlines) || !outlines.length) return;
    const proj = projectFn || ((lon, lat) => project(lon, lat, viewport));
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 214, 102, 0.5)';
    ctx.lineWidth = 1;
    for (const rings of outlines) {
      for (const ring of rings) {
        if (!ring || ring.length < 3) continue;
        ctx.beginPath();
        for (let i = 0; i < ring.length; i += 1) {
          const [lon, lat] = ring[i];
          const point = proj(lon, lat);
          if (i === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  return { draw };
}

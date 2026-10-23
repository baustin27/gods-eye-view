import { pointInRing } from '../../../../src/data/stormScoring.js';
import { tileBounds } from '../../../../src/layers/streetLevel/tileMath.js';
import { project } from './viewport.js';

/** Cover the basemap outside the selected state, including while its outline loads. */
export function drawOutsideState(ctx, viewport, polygons, color = '#05080b', projectFn) {
  const proj = projectFn || ((lon, lat) => project(lon, lat, viewport));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, viewport.width, viewport.height);
  for (const polygon of polygons || []) {
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      ring.forEach(([lon, lat], index) => {
        const point = proj(lon, lat);
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
    }
  }
  ctx.fillStyle = color;
  ctx.fill('evenodd');
  ctx.restore();
}

/**
 * One clip wraps every geographic layer, including raster imagery. An empty
 * path deliberately hides everything while a newly selected state loads;
 * showing the previous state's tiles during that wait would break isolation.
 */
export function clipToState(ctx, viewport, polygons, projectFn) {
  const proj = projectFn || ((lon, lat) => project(lon, lat, viewport));
  ctx.beginPath();
  for (const polygon of polygons || []) {
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      ring.forEach(([lon, lat], index) => {
        const point = proj(lon, lat);
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
    }
  }
  ctx.clip('evenodd');
}

/** Segment/rectangle intersection, including a boundary-only touch. */
function crossesBox(a, b, box) {
  let low = 0;
  let high = 1;
  for (const [axis, min, max] of [
    [0, box.west, box.east],
    [1, box.south, box.north],
  ]) {
    const delta = b[axis] - a[axis];
    if (!delta) {
      if (a[axis] < min || a[axis] > max) return false;
      continue;
    }
    const first = (min - a[axis]) / delta;
    const last = (max - a[axis]) / delta;
    low = Math.max(low, Math.min(first, last));
    high = Math.min(high, Math.max(first, last));
    if (low > high) return false;
  }
  return true;
}

/** Keep boundary tiles, but never request tiles wholly outside the state. */
export function tilesInState(tiles, polygons) {
  return tiles.filter((tile) => {
    const box = tileBounds(tile.x, tile.y, tile.z);
    const corners = [
      [box.west, box.south],
      [box.east, box.south],
      [box.east, box.north],
      [box.west, box.north],
    ];
    return (polygons || []).some(([outer, ...holes]) => {
      if (!outer?.length) return false;
      if (
        corners.some(
          ([lon, lat]) =>
            pointInRing(outer, lon, lat) &&
            !holes.some((hole) => pointInRing(hole, lon, lat)),
        )
      )
        return true;
      return [outer, ...holes].some((ring) =>
        ring.some((point, index) =>
          crossesBox(point, ring[(index + 1) % ring.length], box),
        ),
      );
    });
  });
}

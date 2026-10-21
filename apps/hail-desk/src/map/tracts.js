/**
 * The census tracts, as a choropleth of the houses.
 *
 * THE SWATH SAYS WHERE THE HAIL FELL. This says where the HOUSES ARE. Those
 * are two different questions and the product is the answer to both: a storm
 * over open country is a storm nobody can sell to, and a town that was not
 * hit is a town that was not hit.
 *
 * The two are drawn on top of each other, and the two colours are kept
 * apart on purpose. The hail is violet, because that is the globe's ramp and
 * the gallery's ramp and the artifact's ramp - one storm, one colour, three
 * pictures. The houses are CYAN, because cyan is not violet and because
 * cyan is not the desert: an amber choropleth over Arizona's tan desert is
 * the same colour as the ground it is supposed to be standing on.
 *
 * The FILLS go under the swath and the OUTLINES go over it. A fill under a
 * translucent swath is dimmed by it and hard to read; an outline over it is
 * the neighbourhood boundaries, which is what a person zooming in is
 * actually looking for.
 *
 * The tract tiles are the street tiles' format - a feature is a closed ring,
 * and its index is the tract's index in the county's list - so the same
 * decoder reads both. The list itself is fetched ONCE per county and cached,
 * because a tile carries an index into it and not the list: a county has
 * hundreds of tracts, and a tile at every zoom of every pan would pay for all
 * of it again and again.
 */

import {
  GEVS_EXTENT,
  decodeStreetTile,
} from '../../../../src/data/streetTile.js';
import { TILE_SIZE, viewportPixel } from './viewport.js';

/**
 * The biggest number of housing units a tract in the data has.
 *
 * The ramp is logarithmic, so the scale is pinned at the top of the range
 * rather than at the largest number seen: a ramp that rescales with the
 * data is a ramp that changes meaning every time the map moves, and two
 * maps of two storms are then not comparable.
 */
const MAX_TRACT_UNITS = 5000;

/**
 * The amber, and how much of it.
 *
 * @param {number|null} units the tract's housing units
 * @returns {string} an rgba colour
 */
export function tractFill(units) {
  if (units === null || units === undefined || !Number.isFinite(units)) {
    // A tract with no units in it still has a boundary and a shape. It is
    // drawn, and it is drawn quietly.
    return 'rgba(34, 211, 238, 0.05)';
  }
  const t = Math.min(
    1,
    Math.max(0, Math.log10(1 + units) / Math.log10(1 + MAX_TRACT_UNITS)),
  );
  return `rgba(34, 211, 238, ${(0.05 + t * 0.28).toFixed(3)})`;
}

/**
 * The tract painter.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {Function} [options.onTile] called when a tile arrives
 */
export function createTractPainter({ fetchImpl = globalThis.fetch, onTile } = {}) {
  /** The decoded rings, by tile. */
  const cache = new Map();
  /** The tiles being fetched. */
  const pending = new Map();
  /** The county's tract list, by county. */
  const indexes = new Map();
  /** The tiles that FAILED, so they are not asked for again on every frame. */
  const failed = new Map();
  const FAILED_TTL_MS = 60_000;

  /**
   * The county's tract list: the index, the GEOID, the name and the housing
   * units of every tract in the county.
   *
   * @param {string} state
   * @param {string} county
   * @returns {Promise<Array<object>|null>}
   */
  function loadIndex(state, county) {
    const key = `${state}/${county}`;
    if (indexes.has(key)) return indexes.get(key);
    const promise = (async () => {
      try {
        const response = await fetchImpl(
          `/api/desk/tracts/${state}/${county}/index`,
        );
        if (!response.ok) return null;
        const body = await response.json();
        return Array.isArray(body?.tracts) ? body.tracts : null;
      } catch {
        return null;
      }
    })();
    indexes.set(key, promise);
    return promise;
  }

  /**
   * Load and decode one tract tile.
   *
   * @param {{z: number, x: number, y: number}} tile
   * @param {{state: string, county: string}} options
   * @returns {Promise<Array<object>>}
   */
  async function loadTractTile(tile, { state, county }) {
    const response = await fetchImpl(
      `/api/desk/tracts/${state}/${county}/${tile.z}/${tile.x}/${tile.y}`,
      { headers: { accept: 'application/vnd.gev.tract-tile' } },
    );
    // A 204 is an empty tile - there are no tracts in it, and that is an
    // answer. Any other failure THROWS, so the painter remembers the tile
    // as failed: a county whose data is not here answered 404 sixty times a
    // second and took the browser's renderer down.
    if (response.status === 204) return [];
    if (!response.ok) {
      throw new Error(
        `tract tile ${response.status} for ${state}/${county}/${tile.z}/${tile.x}/${tile.y}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) return [];
    return decodeStreetTile(bytes).lines;
  }

  /**
   * Draw the tracts.
   *
   * SYNCHRONOUS, for the same reason the basemap and the streets are: the
   * tiles that are here are drawn, and the ones that are not are fetched in
   * the background. Awaiting them emptied the map on every pan.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} viewport
   * @param {Array<{z: number, x: number, y: number}>} tiles
   * @param {object} options
   * @param {string} options.state
   * @param {string} options.county
   * @param {'fill'|'outline'} [options.mode]
   */
  function draw(ctx, viewport, tiles, options = {}) {
    const { state, county, mode = 'fill' } = options;
    if (!state || !county) return;
    const scale = TILE_SIZE / GEVS_EXTENT;
    for (const tile of tiles) {
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      let rings = cache.get(key);
      if (!rings) {
        // A tile that is not there is not going to be there, and asking for
        // it again on every frame is a request flood that takes the browser
        // down.
        const dead = failed.get(key);
        if (dead !== undefined) {
          if (Date.now() - dead < FAILED_TTL_MS) continue;
          failed.delete(key);
        }
        if (!pending.has(key)) {
          pending.set(
            key,
            loadTractTile(tile, { state, county })
              .then((loaded) => {
                cache.set(key, loaded);
                pending.delete(key);
                if (loaded.length) onTile?.();
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
      if (!rings.length) continue;
      const origin = viewportPixel(tile, viewport, TILE_SIZE);
      for (const ring of rings) {
        if (!ring.points || ring.points.length < 3) continue;
        ctx.beginPath();
        for (let i = 0; i < ring.points.length; i += 1) {
          const [lx, ly] = ring.points[i];
          const x = origin.x + lx * scale;
          const y = origin.y + ly * scale;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        if (mode === 'outline') {
          ctx.strokeStyle = 'rgba(165, 243, 252, 0.45)';
          ctx.lineWidth = 0.75;
          ctx.stroke();
        } else {
          ctx.fillStyle = tractFill(unitsFor(ring.edgeIndex));
          // The even-odd rule, because the Census does not say which ring of
          // a tract is a hole: the holes are punched out by the rule, and a
          // flag that is not in the data cannot be invented.
          ctx.fill('evenodd');
        }
      }
    }
  }

  /**
   * The housing units of a tract, by its index in the county's list.
   *
   * @param {number} edgeIndex
   * @returns {number|null}
   */
  function unitsFor(edgeIndex) {
    const list = indexLists.get(currentKey);
    if (!list) return null;
    const tract = list[edgeIndex];
    return tract ? tract.units ?? null : null;
  }

  /** The tract lists, by county, resolved. */
  const indexLists = new Map();
  /** The county being drawn. */
  let currentKey = '';

  /**
   * Start the county's list, and redraw when it lands.
   *
   * The list is needed for the COLOUR of the fills, so the first paint of a
   * county is quiet and the second one has the houses in it.
   */
  function useCounty(state, county) {
    const key = `${state}/${county}`;
    currentKey = key;
    loadIndex(state, county).then((list) => {
      if (list) {
        indexLists.set(key, list);
        onTile?.();
      }
    });
  }

  return { draw, useCounty, loadIndex };
}

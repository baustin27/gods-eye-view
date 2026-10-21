/**
 * The desk's map pane.
 *
 * A CANVAS, not a mapping library. The desk is a table of places with a
 * knock list attached, and the map is here to answer "where is that" and to
 * let a person click a place off the map. A mapping library would be a
 * megabyte of JavaScript and a fight about the coordinate system; a canvas
 * with Web Mercator in it is a few hundred lines and no dependencies.
 *
 * What it draws, in order:
 *
 *   1. Esri's World Imagery, so there is a picture of the ground.
 *   2. The county's streets, from the desk's own tile API, in the same Web
 *      Mercator the tiles are cut in.
 *   3. The PLACES, as dots, coloured by the number of severe reports in
 *      them - which is the number the table is sorted by, so the map and the
 *      table always agree about which places are the market.
 *
 * The desk is Cesium-free by contract, and this keeps it that way: the
 * shared code it uses (`src/data/streetTile.js`, `src/layers/streetLevel/
 * tileMath.js`) is pure, and the map is the desk's own.
 */

import {
  createViewport,
  panBy,
  project,
  unproject,
  visibleTiles,
  zoomAround,
} from './viewport.js';
import { createBasemap, ESRI_ATTRIBUTION } from './basemap.js';
import { createStreetPainter } from './streets.js';
import { createSwathPainter } from './swath.js';

/**
 * The map pane.
 *
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {object} [options.viewport]
 * @param {(place: object) => void} [options.onPick] called with the place
 *   under a click
 * @param {() => Array<object>} [options.places] the places to draw
 * @param {() => object} [options.scope] `{state, county}` for the street tiles
 */
export function createMapPane(options) {
  const { canvas } = options;
  const ctx = canvas.getContext('2d');
  // The basemap asks for a redraw when a tile arrives, so the map fills in
  // rather than sitting half empty.
  // The redraw is COALESCED into one animation frame.
  //
  // A pointermove fires sixty times a second and a redraw is not free, so
  // every move used to queue another full draw and the queue ran away from
  // the pointer. One frame is all a person can see anyway.
  let frame = null;
  let drawing = false;

  const basemap = createBasemap({ onTile: () => scheduleDraw() });
  const streets = createStreetPainter({ onTile: () => scheduleDraw() });
  const swath = createSwathPainter();
  let viewport = options.viewport || createViewport();
  let dragging = null;
  let moved = 0;

  function resize() {
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    viewport = { ...viewport, width: rect.width, height: rect.height };
  }

  /**
   * Draw everything.
   *
   * SYNCHRONOUS, because the tiles draw what is cached and fetch the rest in
   * the background. An awaited draw left the canvas blank between the clear
   * and the tiles arriving, which is what made the map feel broken.
   */
  function draw() {
    if (drawing) return;
    drawing = true;
    try {
      const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, viewport.width, viewport.height);
      ctx.fillStyle = '#05080b';
      ctx.fillRect(0, 0, viewport.width, viewport.height);

      const tiles = visibleTiles(viewport);
      basemap.draw(ctx, viewport, tiles);

      const scope = options.scope?.() || {};
      if (scope.state && scope.county) {
        streets.draw(ctx, viewport, tiles, {
          state: scope.state,
          county: scope.county,
        });
      }

      const bands = options.swath?.();
      if (bands && bands.length) swath.draw(ctx, viewport, bands);
      drawPlaces();
      drawAttribution();
    } finally {
      drawing = false;
    }
  }

  /**
   * Draw on the next frame, at most once.
   */
  function scheduleDraw() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      draw();
    });
  }

  /**
   * The places, as dots, sized and coloured by their severe reports.
   */
  function drawPlaces() {
    const rows = options.places?.() || [];
    if (!rows.length) return;
    const worst = rows.reduce(
      (max, row) => Math.max(max, Number(row.severe) || 0),
      0,
    );
    for (const row of rows) {
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
      const { x, y } = project(row.lon, row.lat, viewport);
      if (x < -20 || y < -20 || x > viewport.width + 20 || y > viewport.height + 20) {
        continue;
      }
      const share = worst > 0 ? (Number(row.severe) || 0) / worst : 0;
      const radius = 2.5 + share * 4.5;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(61, 214, 200, ${0.45 + share * 0.55})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(10, 14, 19, 0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /**
   * The credit, on the map, because the service requires it and a credit
   * behind a toggle is not a credit.
   */
  function drawAttribution() {
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(220, 230, 240, 0.75)';
    ctx.fillText(ESRI_ATTRIBUTION, viewport.width - 8, viewport.height - 8);
  }

  /**
   * The place under a screen pixel, if there is one.
   */
  function pick(x, y) {
    const rows = options.places?.() || [];
    let best = null;
    let bestDistance = Infinity;
    for (const row of rows) {
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
      const point = project(row.lon, row.lat, viewport);
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < 12 && distance < bestDistance) {
        bestDistance = distance;
        best = row;
      }
    }
    return best;
  }

  // The interaction: drag to pan, the wheel to zoom, a click to pick.
  canvas.addEventListener('pointerdown', (event) => {
    dragging = { x: event.offsetX, y: event.offsetY };
    moved = 0;
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.offsetX - dragging.x;
    const dy = event.offsetY - dragging.y;
    moved += Math.abs(dx) + Math.abs(dy);
    dragging = { x: event.offsetX, y: event.offsetY };
    viewport = panBy(viewport, dx, dy);
    scheduleDraw();
  });
  canvas.addEventListener('pointerup', (event) => {
    const wasDragging = dragging;
    dragging = null;
    canvas.releasePointerCapture?.(event.pointerId);
    // A CLICK and a DRAG are told apart by how far the pointer moved. Without
    // that, every pan ends by opening a place.
    if (!wasDragging || moved < 4) {
      const row = pick(event.offsetX, event.offsetY);
      if (row) options.onPick?.(row);
    }
  });
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.25 : 0.8;
      viewport = zoomAround(
        viewport,
        viewport.zoom + Math.log2(factor),
        event.offsetX,
        event.offsetY,
      );
      scheduleDraw();
    },
    { passive: false },
  );

  resize();
  void draw();

  return {
    get viewport() {
      return viewport;
    },
    /**
     * Load a day's swath and redraw with it.
     *
     * @param {string} day ISO
     * @returns {Promise<Array<object>>} the bands
     */
    async showSwath(day) {
      const bands = await swath.load(day);
      scheduleDraw();
      return bands;
    },
    /**
     * Fit the map to the places being shown.
     *
     * Without this the map sits wherever it was left, and the default view -
     * every place with hail in the country - would show one street corner.
     * The zoom is chosen so the places fit with a margin, and never goes
     * further in than a city, because a map of six thousand places at street
     * level is a map of nothing.
     *
     * @param {Array<object>} rows
     */
    fitTo(rows) {
      const placed = (rows || []).filter(
        (row) => Number.isFinite(row.lat) && Number.isFinite(row.lon),
      );
      if (!placed.length) return;
      let west = Infinity;
      let south = Infinity;
      let east = -Infinity;
      let north = -Infinity;
      for (const row of placed) {
        if (row.lon < west) west = row.lon;
        if (row.lon > east) east = row.lon;
        if (row.lat < south) south = row.lat;
        if (row.lat > north) north = row.lat;
      }
      const centre = { lon: (west + east) / 2, lat: (south + north) / 2 };
      const lonSpan = Math.max(0.01, east - west);
      const latSpan = Math.max(0.01, north - south);
      const byWidth = Math.log2((360 * (viewport.width || 800)) / (256 * lonSpan));
      const byHeight = Math.log2(
        (360 * (viewport.height || 600)) / (256 * latSpan * 1.3),
      );
      const zoom = Math.max(
        3,
        Math.min(14, Math.floor(Math.min(byWidth, byHeight))),
      );
      viewport = { ...viewport, centre, zoom };
    },
    /** Move the map to a place. */
    goTo(lon, lat, zoom) {
      viewport = {
        ...viewport,
        centre: { lon, lat },
        zoom: zoom ?? viewport.zoom,
      };
      void draw();
    },
    draw,
    resize,
    /** The point under a screen pixel, for the address lookup later. */
    unproject,
  };
}

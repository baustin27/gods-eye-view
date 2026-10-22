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
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  createViewport,
  panBy,
  project,
  unproject,
  visibleTiles,
  zoomAround,
} from './viewport.js';
import { createBasemap, ESRI_ATTRIBUTION } from './basemap.js';
import { createStreetPainter } from './streets.js';
import { createTractPainter } from './tracts.js';
import { createCityPainter } from './cities.js';
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
 * @param {() => object} [options.scope] `{state, county}` for the overlay scope
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
  const tracts = createTractPainter({
    onTile: () => scheduleDraw(),
  });
  const cities = createCityPainter();
  const streets = createStreetPainter({ onTile: () => scheduleDraw() });
  const swath = createSwathPainter();
  let viewport = options.viewport || createViewport();
  let dragging = null;
  let moved = 0;

  // The device pixel ratio the BACKING STORE was made at. It is read once,
  // here, and the draw uses the same one - reading it twice means the store
  // and the drawing disagree the moment the window moves to a monitor with a
  // different scale, and the map is drawn at the wrong size.
  let pixelRatio = Math.max(1, globalThis.devicePixelRatio || 1);

  function resize() {
    pixelRatio = Math.max(1, globalThis.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * pixelRatio);
    canvas.height = Math.round(rect.height * pixelRatio);
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
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
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      ctx.clearRect(0, 0, viewport.width, viewport.height);
      ctx.fillStyle = '#05080b';
      ctx.fillRect(0, 0, viewport.width, viewport.height);

      const tiles = visibleTiles(viewport);
      basemap.draw(ctx, viewport, tiles);

      const scope = options.scope?.() || {};
      const inScope = Boolean(scope.state && scope.county);
      if (inScope) {
        // The houses, UNDER the hail. The fills are dimmed by the swath and
        // that is the right way round: the hail is the subject.
        tracts.draw(ctx, viewport, tiles, { mode: 'fill' });
        streets.draw(ctx, viewport, tiles);
      }

      // THE CITY LINES, over the imagery and under the hail. A canvasser
      // working a storm that stopped on a city line has to be able to SEE
      // the line: a dot for a city does not say where the city ends.
      cities.draw(ctx, viewport, options.cityOutlines?.());

      // THE STATE LINE, under the hail. It is a frame for the storm: a storm
      // that crossed a state line is a storm in two markets, and the map
      // cannot say that without the line on it.
      drawStateBoundary(ctx, viewport, options.stateBoundary?.());

      const bands = options.swath?.();
      if (bands && bands.length) swath.draw(ctx, viewport, bands);
      if (inScope) {
        // The neighbourhood boundaries, OVER the hail: a person zooming in
        // is looking for the edges of the place they are going to work.
        tracts.draw(ctx, viewport, tiles, { ...scope, mode: 'outline' });
      }
      drawPlaces();
      drawAttribution();
      drawScaleBar();
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
    for (const row of rows) {
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
      const { x, y } = project(row.lon, row.lat, viewport);
      if (x < -20 || y < -20 || x > viewport.width + 20 || y > viewport.height + 20) {
        continue;
      }
      const radius = dotRadius(row);
      // The share is the same one the radius uses, so a dot's SIZE and its
      // OPACITY agree.
      const worst = options.worstSevere?.() || 1;
      const share = worst > 0 ? (Number(row.severe) || 0) / worst : 0;
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
   * The state outline, as a line.
   *
   * The rings come from the Natural Earth admin-1 pack, decoded on the
   * server, so what arrives here is points. They are projected with the
   * viewport's own projection, so the line lands on the same pixels as the
   * imagery under it.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} viewport
   * @param {Array<Array<Array<number>>>} rings the rings, as [lon, lat]
   */
  function drawStateBoundary(ctx, viewport, rings) {
    if (!Array.isArray(rings) || !rings.length) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(165, 243, 252, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    for (const polygon of rings) {
      for (const ring of polygon) {
        if (!ring || ring.length < 2) continue;
        ctx.beginPath();
        for (let i = 0; i < ring.length; i += 1) {
          const [lon, lat] = ring[i];
          const point = project(lon, lat, viewport);
          if (i === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * THE SCALE BAR, and the zoom.
   *
   * A map with no scale is a picture. The bar is a round number of metres -
   * 10, 25, 50, 100, 200, 500, 1, 2, 5, 10, 25, 50, 100 km - chosen so it is
   * between sixty and a hundred and forty pixels wide, because a bar of
   * nine pixels cannot be read and a bar of nine hundred covers the map.
   *
   * The metres per pixel are taken at the CENTRE's latitude, because the
   * scale of a Mercator map is the scale at its middle: at the top of the
   * frame it is a different number, and a bar that is right in the middle
   * and wrong at the edges is a bar nobody can trust.
   */
  function drawScaleBar() {
    const lat = viewport.centre.lat;
    const metresPerPixel =
      (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** viewport.zoom;
    if (!Number.isFinite(metresPerPixel) || metresPerPixel <= 0) return;
    const steps = [
      10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 25000, 50000,
      100000, 250000, 500000, 1000000,
    ];
    let metres = steps[0];
    for (const step of steps) {
      if (step / metresPerPixel <= 140) metres = step;
    }
    const pixels = metres / metresPerPixel;
    const label =
      metres >= 1000 ? `${(metres / 1000).toLocaleString()} km` : `${metres} m`;
    const x = viewport.width - 16 - pixels;
    // ABOVE the attribution, not on it. The attribution is the service's
    // credit and it is long, and a scale bar drawn across it is a scale bar
    // nobody can read.
    const y = viewport.height - 48;
    ctx.strokeStyle = 'rgba(10, 14, 19, 0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + pixels, y);
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + 4);
    ctx.moveTo(x + pixels, y - 4);
    ctx.lineTo(x + pixels, y + 4);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(220, 230, 240, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + pixels, y);
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + 4);
    ctx.moveTo(x + pixels, y - 4);
    ctx.lineTo(x + pixels, y + 4);
    ctx.stroke();
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(10, 14, 19, 0.9)';
    const textWidth = ctx.measureText(label).width;
    ctx.fillRect(x + pixels / 2 - textWidth / 2 - 3, y - 17, textWidth + 6, 13);
    ctx.fillStyle = 'rgba(220, 230, 240, 0.95)';
    ctx.fillText(label, x + pixels / 2, y - 6);
    // The zoom, beside the scale: the number a person compares with the
    // others.
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(220, 230, 240, 0.8)';
    ctx.fillText(`Z${viewport.zoom}`, viewport.width - 8, y - 6);
    ctx.textAlign = 'left';
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
  /**
   * The radius a place's dot is drawn at.
   *
   * By RANK and not by the filtered worst, so the dots do not all resize
   * every time the list is filtered, and one outlier does not flatten the
   * rest of them.
   */
  function dotRadius(row) {
    const worst = options.worstSevere?.() || 1;
    const share = worst > 0 ? (Number(row.severe) || 0) / worst : 0;
    const base = 2.5 + Math.sqrt(Math.max(0, share)) * 5;
    return base * Math.max(0.6, Math.min(2, 2 ** (viewport.zoom - 10) / 2));
  }

  function pick(x, y) {
    const rows = options.places?.() || [];
    let best = null;
    let bestDistance = Infinity;
    for (const row of rows) {
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
      const point = project(row.lon, row.lat, viewport);
      const distance = Math.hypot(point.x - x, point.y - y);
      // The hit radius is the radius the dot was DRAWN at, plus a little. A
      // fixed twelve pixels against dots of two and a half to seven means
      // clicking bare ground a foot from a dot opens that place.
      const radius = dotRadius(row) + 5;
      if (distance < radius && distance < bestDistance) {
        bestDistance = distance;
        best = row;
      }
    }
    return best;
  }

  // The interaction: drag to pan, the wheel to zoom, a click to pick.
  canvas.addEventListener('pointerdown', (event) => {
    // Only the primary button drags. A right-drag used to pan the map and a
    // right-click used to open a place, which is not a thing anybody wants.
    if (event.button !== 0) return;
    dragging = { x: event.offsetX, y: event.offsetY };
    moved = 0;
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.offsetX - dragging.x;
    const dy = event.offsetY - dragging.y;
    moved = Math.max(moved, Math.hypot(dx, dy));
    dragging = { x: event.offsetX, y: event.offsetY };
    viewport = panBy(viewport, dx, dy);
    scheduleDraw();
  });
  // THE KEYBOARD. The map is a picture with no keyboard, and a picture with
  // no keyboard is a picture a person cannot read alone.
  canvas.addEventListener('keydown', (event) => {
    const step = 90;
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft':
        viewport = panBy(viewport, -step, 0);
        break;
      case 'ArrowRight':
        viewport = panBy(viewport, step, 0);
        break;
      case 'ArrowUp':
        viewport = panBy(viewport, 0, -step);
        break;
      case 'ArrowDown':
        viewport = panBy(viewport, 0, step);
        break;
      case '+':
      case '=':
        zoomAroundAtCentre(1);
        break;
      case '-':
      case '_':
        zoomAroundAtCentre(-1);
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      scheduleDraw();
    }
  });

  /**
   * Zoom one level, about the middle of the frame.
   *
   * @param {number} levels
   */
  function zoomAroundAtCentre(levels) {
    const next = clampZoom(viewport.zoom + levels);
    if (next === viewport.zoom) return;
    viewport = { ...viewport, zoom: next };
    zoomTarget = next;
  }

  canvas.addEventListener('pointercancel', () => {
    // A drag that is cancelled - a second finger, a system gesture - must
    // LET GO, or the map stays latched to the pointer.
    dragging = null;
  });
  canvas.addEventListener('pointerup', (event) => {
    const wasDragging = dragging;
    dragging = null;
    canvas.releasePointerCapture?.(event.pointerId);
    // A CLICK and a DRAG are told apart by how far the pointer moved FROM
    // WHERE IT WENT DOWN, not by the sum of the deltas - two pixels of
    // movement is a click, and a slow drag is a thousand pixels of deltas
    // that never add up to much.
    if (!wasDragging || moved < 5) {
      const row = pick(event.offsetX, event.offsetY);
      if (row) options.onPick?.(row);
    }
  });
  // The wheel keeps a FRACTIONAL target and commits a WHOLE number.
  //
  // The fraction is what makes a notch feel like a notch: a mouse wheel sends
  // several events for one gesture and each one adds to the target. The
  // COMMITTED zoom is a whole number, because a fractional one breaks the
  // tile index - the tile server is asked for a level it does not have, and
  // Esri truncates it rather than refusing, so the imagery lands a continent
  // away from where it belongs.
  let zoomTarget = viewport.zoom;
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.3 : 1 / 1.3;
      zoomTarget = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, zoomTarget + Math.log2(factor)),
      );
      viewport = zoomAround(
        viewport,
        Math.round(zoomTarget),
        event.offsetX,
        event.offsetY,
      );
      scheduleDraw();
    },
    { passive: false },
  );

  resize();
  // The desk had NO window-resize listener anywhere, so after a resize the
  // backing store and the viewport were stale: the bitmap was CSS-stretched
  // and blurry, and the projection used the old size. The observer catches the
  // window, the panel and the browser's zoom all at once.
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      resize();
      scheduleDraw();
    });
    observer.observe(canvas);
  }
  void draw();

  /**
   * Fit the map to a box of degrees.
   *
   * The HEIGHT has to account for the Mercator stretch. A degree of latitude
   * is 1/cos(lat) times as many pixels as a degree of longitude - 1.28x at
   * Colorado - so fitting on the latitude alone can be a whole level too tight
   * and the places overflow the frame.
   *
   * @param {number} west
   * @param {number} south
   * @param {number} east
   * @param {number} north
   */
  function fitBounds(west, south, east, north) {
    if (![west, south, east, north].every(Number.isFinite)) return;
    if (east <= west || north <= south) return;
    const centre = { lon: (west + east) / 2, lat: (south + north) / 2 };
    const lonSpan = Math.max(0.01, east - west);
    const latSpan = Math.max(0.01, north - south);
    const stretch = Math.max(0.2, Math.cos((centre.lat * Math.PI) / 180));
    const byWidth = Math.log2((360 * (viewport.width || 800)) / (256 * lonSpan));
    const byHeight = Math.log2(
      (360 * (viewport.height || 600) * stretch) / (256 * latSpan * 1.3),
    );
    const zoom = clampZoom(Math.floor(Math.min(byWidth, byHeight)));
    viewport = { ...viewport, centre, zoom };
    zoomTarget = zoom;
  }

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
      fitBounds(west, south, east, north);
    },
    /**
     * Fit the map to a box, in degrees.
     *
     * The storm view needs this: the map is fitted to the SWATH, not to the
     * places, because the swath is the map now - a storm that fell over open
     * country has no places in it and is still worth looking at.
     *
     * @param {number} west
     * @param {number} south
     * @param {number} east
     * @param {number} north
     */
    fitBounds,
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

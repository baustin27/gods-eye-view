/**
 * The desk's map pane.
 *
 * MapLibre owns the familiar labeled basemap, camera and gestures. The clear
 * canvas above it owns the desk's storm, tract, street and place overlays.
 *
 * What it draws, in order:
 *
 *   1. OpenFreeMap's labeled OpenStreetMap basemap (or Esri imagery).
 *   2. The county's streets and tracts, from the desk's tile APIs.
 *   3. The PLACES, as dots, coloured by the number of severe reports in
 *      them - which is the number the table is sorted by, so the map and the
 *      table always agree about which places are the market.
 *
 * The desk is Cesium-free by contract, and this keeps it that way: the
 * shared code it uses (`src/data/streetTile.js`, `src/layers/streetLevel/
 * tileMath.js`) is pure, and the map is the desk's own.
 */

import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
if (typeof window !== 'undefined') {
  import('maplibre-gl/dist/maplibre-gl.css').catch(() => {});
}
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
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
import { pointInRingDegrees } from '../../../../src/data/stormArtwork.js';
import {
  CARTO_DARK_MATTER,
  ESRI_ATTRIBUTION,
  ESRI_DARK_GRAY_BASE,
  ESRI_DARK_GRAY_REF,
  ESRI_WORLD_BOUNDARIES,
  ESRI_WORLD_IMAGERY,
  ESRI_WORLD_STREETS,
  ESRI_WORLD_TRANSPORTATION,
  createBasemap,
} from './basemap.js';
import { createStreetPainter } from './streets.js';
import { createTractPainter } from './tracts.js';
import { createCityPainter } from './cities.js';
import { createSwathPainter } from './swath.js';
import { clipToState, drawOutsideState, tilesInState } from './isolation.js';
import { swathBandsToGeoJson, stateOutlineToMaskGeoJson } from './maplibreData.js';

setWorkerUrl(mapLibreWorkerUrl);

/**
 * The map pane.
 *
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {HTMLElement} options.mapContainer
 * @param {object} [options.viewport]
 * @param {(place: object) => void} [options.onPick] called with the place
 *   under a click
 * @param {() => Array<object>} [options.places] the places to draw
 * @param {() => object} [options.scope] `{state, county}` for the overlay scope
 */
export function createMapPane(options) {
  const { canvas, mapContainer } = options;
  if (mapContainer && mapContainer.style) {
    mapContainer.style.width = '100%';
    mapContainer.style.height = '100%';
  }
  const ctx = canvas.getContext('2d');
  let frame = null;
  let drawing = false;

  const tracts = createTractPainter({
    onTile: () => scheduleDraw(),
  });
  const cities = createCityPainter();
  const streets = createStreetPainter({ onTile: () => scheduleDraw() });
  const swath = createSwathPainter();
  let viewport = options.viewport || createViewport();
  let focusedStreet = null;
  let focusedTractId = null;
  let focusedTractPolygons = null;
  let pixelRatio = Math.max(1, globalThis.devicePixelRatio || 1);
  let basemapMode = options.basemap?.() || 'hybrid';
  if (basemapMode !== 'satellite' && basemapMode !== 'road') {
    basemapMode = 'hybrid';
  }
  let isolationBoundsKey = '';
  let map = null;
  let dragging = null;
  let moved = 0;
  let zoomTarget = viewport.zoom;
  const fallbackBasemap = createBasemap({ onTile: () => scheduleDraw() });

  // Esri multi-layer raster style:
  // - esri-satellite: World Imagery
  // - esri-transportation: Highways and roads overlay
  // - esri-labels: Administrative boundaries and place names
  // - esri-dark: World Dark Gray Base canvas
  // - esri-dark-ref: World Dark Gray Reference street and city labels
  const esriRasterStyle = {
    version: 8,
    sources: {
      'esri-satellite': {
        type: 'raster',
        tiles: [ESRI_WORLD_IMAGERY],
        tileSize: 256,
        attribution: ESRI_ATTRIBUTION,
      },
      'esri-transportation': {
        type: 'raster',
        tiles: [ESRI_WORLD_TRANSPORTATION],
        tileSize: 256,
      },
      'esri-labels': {
        type: 'raster',
        tiles: [ESRI_WORLD_BOUNDARIES],
        tileSize: 256,
      },
      'esri-dark': {
        type: 'raster',
        tiles: [ESRI_DARK_GRAY_BASE],
        tileSize: 256,
        attribution: ESRI_ATTRIBUTION,
      },
      'esri-dark-ref': {
        type: 'raster',
        tiles: [ESRI_DARK_GRAY_REF],
        tileSize: 256,
      },
      'desk-isolation-mask': {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      },
      'desk-swaths': {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      },
    },
    layers: [
      { id: 'desk-background', type: 'background', paint: { 'background-color': '#0b1220' } },
      {
        id: 'esri-dark',
        type: 'raster',
        source: 'esri-dark',
        paint: { 'raster-fade-duration': 0 },
        layout: { visibility: 'none' },
      },
      {
        id: 'esri-satellite',
        type: 'raster',
        source: 'esri-satellite',
        paint: { 'raster-fade-duration': 0 },
        layout: { visibility: 'visible' },
      },
      {
        id: 'esri-dark-ref',
        type: 'raster',
        source: 'esri-dark-ref',
        paint: { 'raster-fade-duration': 0 },
        layout: { visibility: 'none' },
      },
      {
        id: 'esri-transportation',
        type: 'raster',
        source: 'esri-transportation',
        paint: { 'raster-fade-duration': 0 },
        layout: { visibility: 'visible' },
      },
      {
        id: 'desk-isolation-mask-layer',
        type: 'fill',
        source: 'desk-isolation-mask',
        paint: {
          'fill-color': '#05080b',
          'fill-opacity': 0.94,
        },
      },
      {
        id: 'desk-swaths-fill',
        type: 'fill',
        source: 'desk-swaths',
        paint: {
          'fill-color': ['coalesce', ['get', 'color'], '#6d28d9'],
          'fill-opacity': 0.50,
        },
      },
      {
        id: 'desk-swaths-outline',
        type: 'line',
        source: 'desk-swaths',
        paint: {
          'line-color': ['coalesce', ['get', 'outline'], '#fdf4ff'],
          'line-width': 1.5,
          'line-opacity': 0.88,
        },
      },
      {
        id: 'esri-labels',
        type: 'raster',
        source: 'esri-labels',
        paint: { 'raster-fade-duration': 0 },
        layout: { visibility: 'visible' },
      },
    ],
  };

  try {
    map = new MapLibreMap({
      container: mapContainer,
      style: esriRasterStyle,
      center: [viewport.centre.lon, viewport.centre.lat],
      zoom: viewport.zoom,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxPitch: 0,
      pitchWithRotate: false,
      dragRotate: false,
      attributionControl: false,
      fadeDuration: 0,
      renderWorldCopies: true,
    });
    mapContainer.setAttribute(
      'aria-label',
      'Tactical basemap. Drag or use arrow keys to pan; scroll or use plus and minus to zoom.',
    );
    mapContainer._maplibre = map;
  } catch (error) {
    // WebGL2 is unavailable in some headless and older browsers. Keep the
    // desk usable there with its raster base instead of leaving a blank pane.
    mapContainer.replaceChildren();
    mapContainer.hidden = true;
    canvas.parentElement?.classList.add('map-fallback');
    options.onFallback?.(error);
  }

  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined' && mapContainer) {
    resizeObserver = new ResizeObserver(() => {
      resize();
      map?.resize();
      scheduleDraw();
    });
    resizeObserver.observe(mapContainer);
  }

  function syncViewport() {
    if (!map) return;
    const centre = map.getCenter();
    viewport = {
      ...viewport,
      centre: { lon: centre.lng, lat: centre.lat },
      zoom: map.getZoom() + 1,
    };
  }

  function projectPoint(lon, lat) {
    if (map) {
      const p = map.project([lon, lat]);
      return { x: p.x, y: p.y };
    }
    return project(lon, lat, viewport);
  }

  let lastSwathBands = null;
  let pendingSwathBands = null;
  function updateMaplibreSwath(bands) {
    if (!map) return;
    pendingSwathBands = bands;
    const source = map.getSource('desk-swaths');
    if (!source) return;
    if (bands === lastSwathBands) return;
    lastSwathBands = bands;
    source.setData(swathBandsToGeoJson(bands || []));
  }

  let isResizing = false;
  function resize() {
    if (isResizing) return;
    isResizing = true;
    try {
      pixelRatio = Math.max(1, globalThis.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * pixelRatio);
      canvas.height = Math.round(rect.height * pixelRatio);
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      viewport = { ...viewport, width: rect.width, height: rect.height };
      map?.resize();
      syncViewport();
    } finally {
      isResizing = false;
    }
  }

  function isolationBounds() {
    const polygons = options.isolated?.() ? options.stateBoundary?.() : null;
    if (!polygons?.length) return null;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (const [lon, lat] of ring) {
          west = Math.min(west, lon);
          east = Math.max(east, lon);
          south = Math.min(south, lat);
          north = Math.max(north, lat);
        }
      }
    }
    return Number.isFinite(west) ? { west, south, east, north } : null;
  }

  let lastMaskBoundary = undefined;
  function updateIsolationBounds() {
    if (!map) return;
    const currentPolys = options.isolated?.() ? options.stateBoundary?.() : null;
    if (currentPolys !== lastMaskBoundary) {
      const maskSource = map.getSource('desk-isolation-mask');
      if (maskSource) {
        lastMaskBoundary = currentPolys;
        maskSource.setData(stateOutlineToMaskGeoJson(currentPolys));
      }
    }
    const bounds = isolationBounds();
    const key = bounds
      ? `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`
      : '';
    if (key === isolationBoundsKey) return;
    isolationBoundsKey = key;
    map.setMaxBounds(
      bounds
        ? [[bounds.west, bounds.south], [bounds.east, bounds.north]]
        : null,
    );
  }

  function setBasemap(mode) {
    if (mode === 'satellite') {
      basemapMode = 'satellite';
    } else if (mode === 'road') {
      basemapMode = 'road';
    } else {
      basemapMode = 'hybrid';
    }

    if (!map) {
      options.onBasemapChange?.(basemapMode);
      scheduleDraw();
      return;
    }
    if (!map.isStyleLoaded()) {
      map.once('load', () => setBasemap(basemapMode));
      return;
    }

    const setVisibility = (layerId, visible) => {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
      }
    };

    if (basemapMode === 'hybrid') {
      setVisibility('esri-satellite', true);
      setVisibility('esri-transportation', true);
      setVisibility('esri-labels', true);
      setVisibility('esri-dark', false);
      setVisibility('esri-dark-ref', false);
    } else if (basemapMode === 'road') {
      setVisibility('esri-dark', true);
      setVisibility('esri-dark-ref', true);
      setVisibility('esri-transportation', true);
      setVisibility('esri-satellite', false);
      setVisibility('esri-labels', false);
    } else if (basemapMode === 'satellite') {
      setVisibility('esri-satellite', true);
      setVisibility('esri-transportation', false);
      setVisibility('esri-labels', false);
      setVisibility('esri-dark', false);
      setVisibility('esri-dark-ref', false);
    }

    setVisibility('desk-swaths-fill', true);
    setVisibility('desk-swaths-outline', true);
    setVisibility('desk-isolation-mask-layer', true);

    options.onBasemapChange?.(basemapMode);
    scheduleDraw();
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

      const isolated = options.isolated?.();
      const boundary = options.stateBoundary?.();
      const selectedTract = options.focusedTract?.() || null;
      if (selectedTract !== focusedTractId) {
        focusedTractId = selectedTract;
        focusedTractPolygons = null;
      }
      updateIsolationBounds();
      const tileViewport = { ...viewport, zoom: Math.floor(clampZoom(viewport.zoom)) };
      const visible = visibleTiles(tileViewport);
      const tiles = isolated ? tilesInState(visible, boundary) : visible;
      if (isolated) drawOutsideState(ctx, viewport, boundary, '#05080b', (lon, lat) => projectPoint(lon, lat));
      ctx.save();
      try {
        if (isolated) clipToState(ctx, viewport, boundary, (lon, lat) => projectPoint(lon, lat));

        // Always draw the raster basemap when MapLibre is absent or still loading,
        // ensuring the map canvas NEVER appears black in headless Chrome or while
        // vector tiles are in flight.
        // WHY ONLY WHEN THERE IS NO MAPLIBRE. This canvas sits ABOVE the
        // MapLibre canvas, and the fallback paints an opaque slate fill. It
        // used to run whenever `map.loaded()` was false - which is true during
        // every zoom while tiles stream in - so the real imagery was painted
        // over with black and fractional-zoom raster tiles: the map seemed to
        // "split apart" on every wheel tick. MapLibre keeps parent tiles on
        // screen while children load; the overlay must never hide them.
        const needsRasterBase = !map;
        if (needsRasterBase) {
          fallbackBasemap.draw(ctx, viewport, tiles, basemapMode);
        }

        const scope = options.scope?.() || {};
        const inScope = Boolean(scope.state && scope.county);
        const showTracts = options.showTracts?.() !== false;
        const showStreets = options.showStreets?.() !== false;

        // Census tracts: draw clean boundary outlines when enabled, in scope, and zoomed to neighborhood level (zoom >= 13)
        if (showTracts && inScope && viewport.zoom >= 13) {
          tracts.draw(ctx, viewport, tiles, {
            mode: 'outline',
            highlightedGeoid: options.focusedTract?.(),
          });
        }

        // Draw tract summary preview rings if provided
        const previewRings = options.tractsPreview?.();
        if (showTracts && Array.isArray(previewRings) && previewRings.length) {
          drawTractsPreview(previewRings);
        }

        // Streets: draw when enabled and at zoom >= 12
        if (showStreets && viewport.zoom >= 12) {
          streets.draw(ctx, viewport, tiles);
        }

        // THE CITY LINES, over the imagery and under the hail. A canvasser
        // working a storm that stopped on a city line has to be able to SEE
        // the line: a dot for a city does not say where the city ends.
        cities.draw(ctx, viewport, options.cityOutlines?.(), (lon, lat) => projectPoint(lon, lat));

        // THE STATE LINE, under the hail. It is a frame for the storm: a storm
        // that crossed a state line is a storm in two markets, and the map
        // cannot say that without the line on it.
        drawStateBoundary(ctx, viewport, boundary);

        const bands = options.swath?.();
        if (bands && bands.length) {
          if (!map) {
            swath.draw(ctx, viewport, bands);
          } else {
            updateMaplibreSwath(bands);
          }
          if (options.swathGrid?.()) {
            drawSwathTractGrid(bands);
          }
        } else if (map) {
          updateMaplibreSwath([]);
        }

        if (focusedTractPolygons) drawFocusedTract(focusedTractPolygons);
        if (focusedStreet) drawFocusedStreet(focusedStreet);
        drawPlaces();
        drawKnockPins();
      } finally {
        ctx.restore();
      }
      drawScaleBar();
    } finally {
      drawing = false;
    }
  }

  function drawFocusedStreet(points) {
    if (!Array.isArray(points) || points.length < 2) return;
    const isFlat = typeof points[0] === 'number';
    if (isFlat && points.length < 4) return;

    ctx.save();
    ctx.beginPath();
    if (isFlat) {
      for (let i = 0; i + 1 < points.length; i += 2) {
        const point = projectPoint(points[i], points[i + 1]);
        if (i === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
    } else {
      points.forEach((pt, i) => {
        const lon = pt.lon ?? pt[0];
        const lat = pt.lat ?? pt[1];
        const point = projectPoint(lon, lat);
        if (i === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Glowing cyan under-casing (#38bdf8)
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
    ctx.lineWidth = 8;
    ctx.stroke();

    // Dark isolation casing
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(10, 14, 19, 0.95)';
    ctx.lineWidth = 5;
    ctx.stroke();

    // Crisp glowing amber core line (#fbbf24)
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }

  function drawFocusedTract(polygons) {
    ctx.save();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = 'rgba(10, 14, 19, 0.95)';
    ctx.shadowBlur = 4;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        if (ring.length < 3) continue;
        ctx.beginPath();
        ring.forEach(([lon, lat], index) => {
          const point = projectPoint(lon, lat);
          if (index === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        });
        ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Draw tract summary preview rings.
   *
   * WHY: When exploring regional markets before high-res tract geometry tiles
   * stream in, drawing tract summary rings gives immediate spatial clarity
   * of neighborhood bounds.
   */
  function drawTractsPreview(preview) {
    if (!Array.isArray(preview) || !preview.length) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.65)';
    ctx.fillStyle = 'rgba(34, 211, 238, 0.12)';
    ctx.lineWidth = 1.5;
    for (const item of preview) {
      if (!item) continue;
      const rings = Array.isArray(item)
        ? (Array.isArray(item[0]) && typeof item[0][0] === 'number'
            ? [item]
            : (Array.isArray(item[0]) ? item : [item]))
        : (item.rings || (item.outer ? [item.outer] : (item.coordinates ? item.coordinates : [])));

      for (const ring of rings) {
        if (!Array.isArray(ring) || ring.length < 3) continue;
        ctx.beginPath();
        for (let i = 0; i < ring.length; i++) {
          const pt = ring[i];
          const lon = pt.lon ?? pt[0];
          const lat = pt.lat ?? pt[1];
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          const p = projectPoint(lon, lat);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Draw subtle cyan tract grid cells/contours inside the swath.
   *
   * WHY: At regional zoom, individual census tracts are not yet fetched or
   * are too dense to render individually. Rendering a subtle cyan grid
   * inside the hail swath geometry indicates neighborhood parcelation to
   * the operator, confirming that residential exposure analysis is active.
   */
  function drawSwathTractGrid(bands) {
    if (!bands || !bands.length) return;
    ctx.save();
    ctx.beginPath();
    let ringCount = 0;
    for (const band of bands) {
      const outer = band.outer;
      if (!outer || outer.length < 3) continue;
      for (let i = 0; i < outer.length; i++) {
        const pt = outer[i];
        const lon = pt.lon ?? pt[0];
        const lat = pt.lat ?? pt[1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const p = projectPoint(lon, lat);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ringCount++;
      for (const hole of band.holes || []) {
        if (!hole || hole.length < 3) continue;
        for (let i = 0; i < hole.length; i++) {
          const pt = hole[i];
          const lon = pt.lon ?? pt[0];
          const lat = pt.lat ?? pt[1];
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          const p = projectPoint(lon, lat);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      }
    }

    if (ringCount > 0) {
      ctx.clip('evenodd');
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.16)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      const cellSize = 36;
      for (let x = 0; x <= viewport.width; x += cellSize) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, viewport.height);
      }
      for (let y = 0; y <= viewport.height; y += cellSize) {
        ctx.moveTo(0, y);
        ctx.lineTo(viewport.width, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Draw canvassing knock pins.
   *
   * WHY: Door-to-door canvassers and roofing teams track which houses have
   * been inspected, knocked, or need follow-up. Rendering them with tactical
   * radar styling and status colour coding allows instant street-level triage.
   */
  function drawKnockPins() {
    const pins = options.knockPins?.() || [];
    if (!pins.length) return;

    const normal = [];
    const selected = [];
    for (const pin of pins) {
      if (pin.selected || pin.status === 'target' || pin.status === 'selected') {
        selected.push(pin);
      } else {
        normal.push(pin);
      }
    }

    // Unselected pins
    for (const pin of normal) {
      if (!Number.isFinite(pin.lat) || !Number.isFinite(pin.lon)) continue;
      const { x, y } = projectPoint(pin.lon, pin.lat);
      if (x < -20 || y < -20 || x > viewport.width + 20 || y > viewport.height + 20) {
        continue;
      }
      let color = '#64748b';
      let r = 4.5;
      const raw = String(pin.status || '').trim();
      const s = raw.toLowerCase();
      if (
        raw === 'Inspected' ||
        raw === 'Claim Filed' ||
        raw === 'Inspect Set' ||
        s === 'inspected' ||
        s === 'claim filed' ||
        s === 'claim' ||
        s === 'inspect set'
      ) {
        color = '#10b981';
        r = 5;
      } else if (
        raw === 'Knocked' ||
        raw === 'Follow-up' ||
        raw === 'Door Hanger' ||
        s === 'knocked' ||
        s === 'follow-up' ||
        s === 'door hanger'
      ) {
        color = '#f59e0b';
        r = 5;
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Selected pins with glow ring and monospace label
    for (const pin of selected) {
      if (!Number.isFinite(pin.lat) || !Number.isFinite(pin.lon)) continue;
      const { x, y } = projectPoint(pin.lon, pin.lat);
      if (x < -40 || y < -40 || x > viewport.width + 40 || y > viewport.height + 40) {
        continue;
      }
      // Outer translucent pulse ring (r = 13, rgba(6, 182, 212, 0.28))
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(6, 182, 212, 0.28)';
      ctx.fill();

      // Core selected pin: #06b6d4 with white stroke (r = 7)
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#06b6d4';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();

      const label = pin.label ? String(pin.label) : (pin.hailLabel ? String(pin.hailLabel) : '');
      if (label) {
        ctx.save();
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
        const textWidth = ctx.measureText(label).width;
        const lx = x + 12;
        const ly = y;
        ctx.fillStyle = 'rgba(10, 14, 19, 0.88)';
        ctx.fillRect(lx - 2, ly - 7, textWidth + 6, 14);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(label, lx + 1, ly);
        ctx.restore();
      }
    }
  }

  function pickKnockPin(x, y) {
    const pins = options.knockPins?.() || [];
    let best = null;
    let bestDist = Infinity;
    for (const pin of pins) {
      if (!Number.isFinite(pin.lat) || !Number.isFinite(pin.lon)) continue;
      const point = projectPoint(pin.lon, pin.lat);
      const dist = Math.hypot(point.x - x, point.y - y);
      // Generous 18px click radius for quick, forgiving pin selection
      const hitRadius = Math.max(18, (pin.selected ? 13 : 7) + 6);
      if (dist <= hitRadius && dist < bestDist) {
        bestDist = dist;
        best = pin;
      }
    }
    return best;
  }

  /**
   * Draw on the next frame, at most once.
   */
  function scheduleDraw() {
    if (frame !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(() => {
        frame = null;
        draw();
      });
    } else {
      frame = setTimeout(() => {
        frame = null;
        draw();
      }, 0);
    }
  }

  /**
   * The places, as dots, sized and coloured by their severe reports.
   * Top 8 places and severe hail hot spots (>= 1.5") include crisp monospace labels.
   */
  function drawPlaces() {
    if (options.showPlaces?.() === false) return;
    const rows = options.places?.() || [];
    if (!rows.length) return;

    // Identify top 8 places by severe reports
    const sorted = [...rows].sort(
      (a, b) => (Number(b.severe) || 0) - (Number(a.severe) || 0),
    );
    const top8Set = new Set(sorted.slice(0, 8));

    for (const row of rows) {
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
      const { x, y } = projectPoint(row.lon, row.lat);
      if (x < -40 || y < -40 || x > viewport.width + 40 || y > viewport.height + 40) {
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

      const hasLabel = top8Set.has(row) || Number(row.max) >= 1.5;
      if (hasLabel && row.name) {
        ctx.save();
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
        const nameText = String(row.name);
        const maxVal = Number(row.max);
        const hailText = maxVal > 0 ? ` ${maxVal.toFixed(2)}″` : '';
        const nameWidth = ctx.measureText(nameText).width;
        const hailWidth = hailText ? ctx.measureText(hailText).width : 0;
        const totalWidth = nameWidth + hailWidth;
        const lx = x + radius + 4;
        const ly = y;

        ctx.fillStyle = 'rgba(10, 14, 19, 0.85)';
        ctx.fillRect(lx - 2, ly - 6, totalWidth + 4, 12);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(nameText, lx, ly);
        if (hailText) {
          ctx.fillStyle = '#f59e0b';
          ctx.fillText(hailText, lx + nameWidth, ly);
        }
        ctx.restore();
      }
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
          const point = projectPoint(lon, lat);
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
      const point = projectPoint(row.lon, row.lat);
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

  resize();
  if (map) {
    map.on('move', () => {
      syncViewport();
      scheduleDraw();
    });
    map.on('resize', () => {
      syncViewport();
      scheduleDraw();
    });
    map.on('render', () => {
      syncViewport();
      scheduleDraw();
    });
    map.on('styledata', () => {
      if (pendingSwathBands && map.getSource('desk-swaths')) {
        updateMaplibreSwath(pendingSwathBands);
      }
      updateIsolationBounds();
    });
    map.on('load', () => {
      resize();
      syncViewport();
      setBasemap(basemapMode);
      updateIsolationBounds();
      lastSwathBands = null;
      updateMaplibreSwath(options.swath?.() || pendingSwathBands);
      scheduleDraw();
    });
    map.on('click', (event) => {
      const px = event.point ? event.point.x : (event.offsetX ?? 0);
      const py = event.point ? event.point.y : (event.offsetY ?? 0);
      const pin = pickKnockPin(px, py);
      if (pin) {
        options.onKnockPinPick?.(pin);
        return;
      }
      const place = pick(px, py);
      if (place) {
        options.onPick?.(place);
        return;
      }
      const bands = options.swath?.() || [];
      const point = { lon: event.lngLat.lng, lat: event.lngLat.lat };
      const band = [...bands].reverse().find((candidate) =>
        pointInRingDegrees(point, candidate.outer) &&
        !(candidate.holes || []).some((hole) => pointInRingDegrees(point, hole)),
      );
      if (band) options.onSwathPick?.(band);
    });
    map.on('error', (event) => {
      if (event.error) options.onMapError?.(event.error);
    });
  } else {
    let drag = null;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      drag = { x: event.offsetX, y: event.offsetY };
      moved = 0;
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const dx = event.offsetX - drag.x;
      const dy = event.offsetY - drag.y;
      moved = Math.max(moved, Math.hypot(dx, dy));
      drag = { x: event.offsetX, y: event.offsetY };
      viewport = panBy(viewport, dx, dy);
      scheduleDraw();
    });
    canvas.addEventListener('pointerup', (event) => {
      const wasDragging = drag;
      drag = null;
      canvas.releasePointerCapture?.(event.pointerId);
      if (!wasDragging || moved < 5) {
        const pin = pickKnockPin(event.offsetX, event.offsetY);
        if (pin) {
          options.onKnockPinPick?.(pin);
          return;
        }
        const place = pick(event.offsetX, event.offsetY);
        if (place) options.onPick?.(place);
        else {
          const { lon, lat } = unproject(event.offsetX, event.offsetY, viewport);
          const point = { lon, lat };
          const band = [...(options.swath?.() || [])].reverse().find((candidate) =>
            pointInRingDegrees(point, candidate.outer) &&
            !(candidate.holes || []).some((hole) => pointInRingDegrees(point, hole)),
          );
          if (band) options.onSwathPick?.(band);
        }
      }
    });
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      viewport = zoomAround(
        viewport,
        clampZoom(viewport.zoom + (event.deltaY < 0 ? 1 : -1)),
        event.offsetX,
        event.offsetY,
      );
      scheduleDraw();
    }, { passive: false });
    options.onMapError?.(new Error('WebGL2 unavailable; using satellite fallback'));
    void draw();
  }

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
    const minLon = east === west ? west - 0.005 : west;
    const maxLon = east === west ? east + 0.005 : east;
    const minLat = north === south ? south - 0.005 : south;
    const maxLat = north === south ? north + 0.005 : north;
    if (!map) {
      const centre = { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
      const zoom = clampZoom(Math.floor(Math.min(
        Math.log2((360 * viewport.width) / (256 * (maxLon - minLon))),
        Math.log2((360 * viewport.height * Math.cos(centre.lat * Math.PI / 180)) /
          (256 * (maxLat - minLat) * 1.3)),
      )));
      viewport = { ...viewport, centre, zoom };
      zoomTarget = zoom;
      scheduleDraw();
      return;
    }
    map.fitBounds(
      [[minLon, minLat], [maxLon, maxLat]],
      { padding: 48, maxZoom: 17, duration: 650 },
    );
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
      if (map) updateMaplibreSwath(bands);
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
    focusBounds(bounds) {
      if (!bounds) return;
      fitBounds(bounds.west, bounds.south, bounds.east, bounds.north);
    },
    clearFocus() {
      focusedStreet = null;
      scheduleDraw();
    },
    async focusTract(geoid) {
      const id = String(geoid || '');
      if (!/^\d{11}$/.test(id)) return false;
      const response = await fetch(
        `/api/desk/tracts/${id.slice(0, 2)}/${id.slice(2, 5)}/${id}/geometry`,
      );
      if (!response.ok) return false;
      const tract = await response.json();
      if (tract.geoid !== id || !tract.bounds || !tract.polygons?.length) return false;
      if (options.focusedTract?.() !== id) return false;
      focusedTractId = id;
      focusedTractPolygons = tract.polygons;
      focusedStreet = null;
      fitBounds(tract.bounds.west, tract.bounds.south, tract.bounds.east, tract.bounds.north);
      scheduleDraw();
      return true;
    },
    focusStreet(points, bounds) {
      if (!bounds || !Array.isArray(points)) return false;
      focusedStreet = points;
      fitBounds(bounds.west, bounds.south, bounds.east, bounds.north);
      scheduleDraw();
      return true;
    },
    zoomBy(levels) {
      if (map) {
        map.easeTo({ zoom: clampZoom(map.getZoom() + levels), duration: 280 });
      } else {
        viewport = { ...viewport, zoom: clampZoom(viewport.zoom + levels) };
        zoomTarget = viewport.zoom;
        scheduleDraw();
      }
    },
    setBasemap,
    /** Move the map to a place. */
    goTo(lon, lat, zoom = 16) {
      if (map) {
        map.flyTo({ center: [lon, lat], zoom, duration: 800 });
      } else {
        viewport = { ...viewport, centre: { lon, lat }, zoom };
        scheduleDraw();
      }
    },
    draw,
    resize,
    /** The point under a screen pixel, for the address lookup later. */
    unproject(x, y) {
      if (map) {
        const point = map.unproject([x, y]);
        return { lon: point.lng, lat: point.lat };
      }
      return unproject(x, y, viewport);
    },
    /**
     * Reset the camera view to the current storm swath bounds, state bounds, or places.
     */
    resetView() {
      // 1. Try current swath bands
      const bands = options.swath?.() || [];
      if (bands.length) {
        let west = Infinity;
        let south = Infinity;
        let east = -Infinity;
        let north = -Infinity;
        for (const band of bands) {
          for (const pt of band.outer || []) {
            const lon = pt.lon ?? pt[0];
            const lat = pt.lat ?? pt[1];
            if (Number.isFinite(lon) && Number.isFinite(lat)) {
              if (lon < west) west = lon;
              if (lon > east) east = lon;
              if (lat < south) south = lat;
              if (lat > north) north = lat;
            }
          }
        }
        if (Number.isFinite(west)) {
          // Clip swath bounds to state boundary if available so resetView frames the state's storm
          const boundary = options.stateBoundary?.();
          if (Array.isArray(boundary) && boundary.length) {
            let sWest = Infinity;
            let sSouth = Infinity;
            let sEast = -Infinity;
            let sNorth = -Infinity;
            for (const polygon of boundary) {
              for (const ring of polygon) {
                for (const [lon, lat] of ring) {
                  if (Number.isFinite(lon) && Number.isFinite(lat)) {
                    if (lon < sWest) sWest = lon;
                    if (lon > sEast) sEast = lon;
                    if (lat < sSouth) sSouth = lat;
                    if (lat > sNorth) sNorth = lat;
                  }
                }
              }
            }
            if (Number.isFinite(sWest)) {
              const clippedWest = Math.max(west, sWest);
              const clippedEast = Math.min(east, sEast);
              const clippedSouth = Math.max(south, sSouth);
              const clippedNorth = Math.min(north, sNorth);
              if (clippedEast > clippedWest && clippedNorth > clippedSouth) {
                west = clippedWest;
                east = clippedEast;
                south = clippedSouth;
                north = clippedNorth;
              } else {
                west = sWest;
                east = sEast;
                south = sSouth;
                north = sNorth;
              }
            }
          }
          fitBounds(west, south, east, north);
          return;
        }
      }

      // 2. Try state bounds
      const boundary = options.stateBoundary?.();
      if (Array.isArray(boundary) && boundary.length) {
        let west = Infinity;
        let south = Infinity;
        let east = -Infinity;
        let north = -Infinity;
        for (const polygon of boundary) {
          for (const ring of polygon) {
            for (const [lon, lat] of ring) {
              if (Number.isFinite(lon) && Number.isFinite(lat)) {
                if (lon < west) west = lon;
                if (lon > east) east = lon;
                if (lat < south) south = lat;
                if (lat > north) north = lat;
              }
            }
          }
        }
        if (Number.isFinite(west)) {
          fitBounds(west, south, east, north);
          return;
        }
      }

      // 3. Fallback to places
      const rows = options.places?.() || [];
      if (rows.length) {
        const placed = rows.filter(
          (row) => Number.isFinite(row.lat) && Number.isFinite(row.lon),
        );
        if (placed.length) {
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
        }
      }
    },
  };
}

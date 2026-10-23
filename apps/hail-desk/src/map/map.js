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
import 'maplibre-gl/dist/maplibre-gl.css';
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
import { createBasemap, ESRI_ATTRIBUTION } from './basemap.js';
import { createStreetPainter } from './streets.js';
import { createTractPainter } from './tracts.js';
import { createCityPainter } from './cities.js';
import { createSwathPainter } from './swath.js';
import { clipToState, drawOutsideState, tilesInState } from './isolation.js';

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
  let basemapMode = options.basemap?.() === 'satellite' ? 'satellite' : 'road';
  let isolationBoundsKey = '';
  let map = null;
  let dragging = null;
  let moved = 0;
  let zoomTarget = viewport.zoom;
  const fallbackBasemap = createBasemap({ onTile: () => scheduleDraw() });
  try {
    map = new MapLibreMap({
      container: mapContainer,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [viewport.centre.lon, viewport.centre.lat],
      zoom: viewport.zoom,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxPitch: 0,
      pitchWithRotate: false,
      dragRotate: false,
      attributionControl: false,
      renderWorldCopies: false,
    });
    mapContainer.setAttribute(
      'aria-label',
      'Labeled road map. Drag or use arrow keys to pan; scroll or use plus and minus to zoom.',
    );
  } catch (error) {
    // WebGL2 is unavailable in some headless and older browsers. Keep the
    // desk usable there with its raster base instead of leaving a blank pane.
    mapContainer.replaceChildren();
    mapContainer.hidden = true;
    canvas.parentElement?.classList.add('map-fallback');
    options.onFallback?.(error);
  }

  function syncViewport() {
    if (!map) return;
    const centre = map.getCenter();
    viewport = {
      ...viewport,
      centre: { lon: centre.lng, lat: centre.lat },
      zoom: map.getZoom(),
    };
  }

  function resize() {
    pixelRatio = Math.max(1, globalThis.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * pixelRatio);
    canvas.height = Math.round(rect.height * pixelRatio);
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    viewport = { ...viewport, width: rect.width, height: rect.height };
    syncViewport();
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

  function updateIsolationBounds() {
    if (!map) return;
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

  function ensureSatelliteLayer() {
    if (map.getSource('desk-satellite')) return;
    map.addSource('desk-satellite', {
      type: 'raster',
      tiles: [
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and GIS User Community',
    });
    const firstLabel = map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
    map.addLayer({
      id: 'desk-satellite',
      type: 'raster',
      source: 'desk-satellite',
      layout: { visibility: 'none' },
    }, firstLabel);
  }

  function setBasemap(mode) {
    basemapMode = mode === 'satellite' ? 'satellite' : 'road';
    if (!map) return;
    if (!map.isStyleLoaded()) {
      map.once('load', () => setBasemap(basemapMode));
      return;
    }
    ensureSatelliteLayer();
    map.setLayoutProperty(
      'desk-satellite',
      'visibility',
      basemapMode === 'satellite' ? 'visible' : 'none',
    );
    options.onBasemapChange?.(basemapMode);
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
      if (!map) {
        ctx.fillStyle = '#05080b';
        ctx.fillRect(0, 0, viewport.width, viewport.height);
      }

      const isolated = options.isolated?.();
      const boundary = options.stateBoundary?.();
      const selectedTract = options.focusedTract?.() || null;
      if (selectedTract !== focusedTractId) {
        focusedTractId = selectedTract;
        focusedTractPolygons = null;
      }
      updateIsolationBounds();
      const tileViewport = { ...viewport, zoom: clampZoom(viewport.zoom) };
      const visible = visibleTiles(tileViewport);
      const tiles = isolated ? tilesInState(visible, boundary) : visible;
      if (isolated) drawOutsideState(ctx, viewport, boundary);
      ctx.save();
      try {
        if (isolated) clipToState(ctx, viewport, boundary);
        if (!map) fallbackBasemap.draw(ctx, viewport, tiles);

        const scope = options.scope?.() || {};
        const inScope = Boolean(scope.state && scope.county);
        // Census tracts are neighborhood detail. At regional zoom they
        // collapse into moving cyan blocks; reveal them only when individual
        // neighborhoods have enough screen area to read.
        const neighborhoodZoom = viewport.zoom >= 12;
        const streetZoom = viewport.zoom >= 13;
        if (inScope && neighborhoodZoom) {
          // The houses, UNDER the hail: the hail remains the subject.
          tracts.draw(ctx, viewport, tiles, {
            mode: 'fill',
            highlightedGeoid: options.focusedTract?.(),
          });
        }
        if (inScope && streetZoom) {
          streets.draw(ctx, viewport, tiles);
        }

        // THE CITY LINES, over the imagery and under the hail. A canvasser
        // working a storm that stopped on a city line has to be able to SEE
        // the line: a dot for a city does not say where the city ends.
        cities.draw(ctx, viewport, options.cityOutlines?.());

        // THE STATE LINE, under the hail. It is a frame for the storm: a storm
        // that crossed a state line is a storm in two markets, and the map
        // cannot say that without the line on it.
        drawStateBoundary(ctx, viewport, boundary);

        const bands = options.swath?.();
        if (bands && bands.length) swath.draw(ctx, viewport, bands);
        if (focusedTractPolygons) drawFocusedTract(focusedTractPolygons);
        drawFocusedStreet(focusedStreet);
        drawPlaces();
      } finally {
        ctx.restore();
      }
      drawScaleBar();
    } finally {
      drawing = false;
    }
  }

  function drawFocusedStreet(points) {
    if (!Array.isArray(points) || points.length < 4) return;
    ctx.beginPath();
    for (let i = 0; i + 1 < points.length; i += 2) {
      const point = project(points[i], points[i + 1], viewport);
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.strokeStyle = 'rgba(10, 14, 19, 0.95)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 3;
    ctx.stroke();
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
          const point = project(lon, lat, viewport);
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

  resize();
  if (map) {
    map.on('move', () => {
      syncViewport();
      scheduleDraw();
    });
    map.on('resize', () => {
      resize();
      scheduleDraw();
    });
    map.on('load', () => {
      resize();
      syncViewport();
      setBasemap(basemapMode);
      updateIsolationBounds();
      scheduleDraw();
    });
    map.on('click', (event) => {
      const place = pick(event.point.x, event.point.y);
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
    goTo(lon, lat, zoom) {
      if (map) {
        map.flyTo({ center: [lon, lat], zoom: zoom ?? map.getZoom(), duration: 650 });
      } else {
        viewport = { ...viewport, centre: { lon, lat }, zoom: zoom ?? viewport.zoom };
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
  };
}

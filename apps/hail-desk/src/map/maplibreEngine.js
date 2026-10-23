/**
 * apps/hail-desk/src/map/maplibreEngine.js — native MapLibre GL layer engine for Hail Desk 2.0.
 *
 * Replaces the custom 2D canvas Mercator rendering overlay (`mapCanvas`, `viewport.js`)
 * with 100% native WebGL MapLibre GL sources and layers:
 *   - Swath Fill & Line Contours (`desk-swaths`)
 *   - Census Tract Choropleth & Highlight Outlines (`desk-tracts`)
 *   - Street Centrelines & Focused Casing (`desk-streets`)
 *   - Address Knock Pins & Selected Target (`desk-knock-pins`)
 *   - Market Places Circle Layer (`desk-places`)
 *   - State Isolation Mask & Outline (`desk-isolation-mask`)
 *   - Satellite Raster Layer (`desk-satellite`)
 *
 * Why: Eliminates canvas-to-camera desync lag, custom hit testing math,
 * and high CPU consumption, replacing them with GPU-accelerated vector rendering.
 */

import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import {
  placesToGeoJson,
  stateOutlineToMaskGeoJson,
  swathBandsToGeoJson,
} from './maplibreData.js';

export { placesToGeoJson, stateOutlineToMaskGeoJson, swathBandsToGeoJson };

setWorkerUrl(mapLibreWorkerUrl);

export const DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
export const SATELLITE_TILES = [
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
];

/**
 * Creates an interactive MapLibre GL engine controller.
 *
 * @param {object} options
 * @param {HTMLElement} options.container DOM element
 * @param {string} [options.style] Map style URL
 * @param {[number, number]} [options.center=[-105.0, 39.7]] Default center [lon, lat]
 * @param {number} [options.zoom=7] Default zoom
 * @param {(picked: object) => void} [options.onPick] Pick callback
 * @returns {object} engine interface
 */
export function createMaplibreEngine(options) {
  const {
    container,
    style = DEFAULT_STYLE,
    center = [-105.0, 39.7],
    zoom = 7,
    onPick,
  } = options;

  let map = null;
  let isLoaded = false;
  const queuedUpdates = [];

  try {
    map = new MapLibreMap({
      container,
      style,
      center,
      zoom,
      minZoom: 4,
      maxZoom: 18,
      attributionControl: false,
    });
  } catch (error) {
    console.warn('[MapLibreEngine] WebGL initialization failed:', error);
    return null;
  }

  function runWhenLoaded(fn) {
    if (isLoaded) {
      fn();
    } else {
      queuedUpdates.push(fn);
    }
  }

  map.on('load', () => {
    isLoaded = true;

    // 1. Satellite Raster Source & Layer (inserted beneath labels)
    map.addSource('desk-satellite-source', {
      type: 'raster',
      tiles: SATELLITE_TILES,
      tileSize: 256,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    });

    const firstSymbol = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;

    map.addLayer(
      {
        id: 'desk-satellite-layer',
        type: 'raster',
        source: 'desk-satellite-source',
        layout: { visibility: 'none' },
      },
      firstSymbol,
    );

    // 2. Swaths Source & Layers
    map.addSource('desk-swaths', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer(
      {
        id: 'desk-swath-fill',
        type: 'fill',
        source: 'desk-swaths',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.58,
        },
      },
      firstSymbol,
    );

    map.addLayer(
      {
        id: 'desk-swath-outline',
        type: 'line',
        source: 'desk-swaths',
        paint: {
          'line-color': ['get', 'outline'],
          'line-width': 1.2,
          'line-opacity': 0.85,
        },
      },
      firstSymbol,
    );

    // 3. Tracts Source & Layers
    map.addSource('desk-tracts', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer(
      {
        id: 'desk-tract-fill',
        type: 'fill',
        source: 'desk-tracts',
        minzoom: 11,
        paint: {
          'fill-color': '#0891b2',
          'fill-opacity': ['get', 'alpha'],
        },
      },
      firstSymbol,
    );

    map.addLayer(
      {
        id: 'desk-tract-outline',
        type: 'line',
        source: 'desk-tracts',
        minzoom: 11,
        paint: {
          'line-color': [
            'case',
            ['boolean', ['get', 'highlighted'], false],
            '#fbbf24',
            'rgba(165, 243, 252, 0.45)',
          ],
          'line-width': [
            'case',
            ['boolean', ['get', 'highlighted'], false],
            2.5,
            0.75,
          ],
        },
      },
      firstSymbol,
    );

    // 4. Streets Source & Layer
    map.addSource('desk-streets', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer(
      {
        id: 'desk-street-casing',
        type: 'line',
        source: 'desk-streets',
        minzoom: 12,
        paint: {
          'line-color': 'rgba(10, 14, 19, 0.95)',
          'line-width': ['case', ['boolean', ['get', 'focused'], false], 7, 0],
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      },
      firstSymbol,
    );

    map.addLayer(
      {
        id: 'desk-street-line',
        type: 'line',
        source: 'desk-streets',
        minzoom: 12,
        paint: {
          'line-color': [
            'case',
            ['boolean', ['get', 'focused'], false],
            '#fbbf24',
            'rgba(120, 190, 255, 0.75)',
          ],
          'line-width': [
            'case',
            ['boolean', ['get', 'focused'], false],
            3,
            1.2,
          ],
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      },
      firstSymbol,
    );

    // 5. Knock Pins Source & Layers
    map.addSource('desk-knock-pins', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: 'desk-knock-pins-circle',
      type: 'circle',
      source: 'desk-knock-pins',
      minzoom: 13,
      paint: {
        'circle-radius': ['case', ['boolean', ['get', 'target'], false], 7, 5],
        'circle-color': [
          'match',
          ['get', 'status'],
          'target',
          '#06b6d4',
          'inspected',
          '#10b981',
          'claim',
          '#10b981',
          'knocked',
          '#f59e0b',
          '#64748b',
        ],
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#ffffff',
      },
    });

    // 6. Places Circle Source & Layer
    map.addSource('desk-places', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: 'desk-places-circle',
      type: 'circle',
      source: 'desk-places',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3, 11, 7],
        'circle-color': '#3dd6c8',
        'circle-opacity': ['interpolate', ['linear'], ['get', 'share'], 0, 0.45, 1, 1],
        'circle-stroke-width': 1,
        'circle-stroke-color': 'rgba(10, 14, 19, 0.9)',
      },
    });

    // 7. State Isolation Mask Source & Layer
    map.addSource('desk-isolation-mask', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: 'desk-isolation-mask-layer',
      type: 'fill',
      source: 'desk-isolation-mask',
      paint: {
        'fill-color': '#05080b',
        'fill-opacity': 0.85,
      },
    });

    // Native Picking: Click listener on features
    map.on('click', (e) => {
      if (typeof onPick !== 'function') return;
      const features = map.queryRenderedFeatures(e.point, {
        layers: [
          'desk-knock-pins-circle',
          'desk-places-circle',
          'desk-street-line',
          'desk-tract-fill',
          'desk-swath-fill',
        ],
      });

      if (features.length) {
        const top = features[0];
        onPick({
          layerId: top.layer.id,
          properties: top.properties,
          geometry: top.geometry,
          lngLat: e.lngLat,
        });
      }
    });

    // Pointer cursor updates on hoverable interactive features
    const interactiveLayers = [
      'desk-places-circle',
      'desk-knock-pins-circle',
      'desk-street-line',
      'desk-tract-fill',
    ];
    for (const layerId of interactiveLayers) {
      map.on('mouseenter', layerId, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', layerId, () => {
        map.getCanvas().style.cursor = '';
      });
    }

    // Flush queued updates
    while (queuedUpdates.length) {
      queuedUpdates.shift()();
    }
  });

  return {
    getMap() {
      return map;
    },

    setSwaths(bands) {
      const geojson = swathBandsToGeoJson(bands);
      runWhenLoaded(() => {
        const source = map.getSource('desk-swaths');
        if (source) source.setData(geojson);
      });
    },

    setTracts(geojson) {
      runWhenLoaded(() => {
        const source = map.getSource('desk-tracts');
        if (source) source.setData(geojson || { type: 'FeatureCollection', features: [] });
      });
    },

    setStreets(geojson) {
      runWhenLoaded(() => {
        const source = map.getSource('desk-streets');
        if (source) source.setData(geojson || { type: 'FeatureCollection', features: [] });
      });
    },

    setKnockPins(geojson) {
      runWhenLoaded(() => {
        const source = map.getSource('desk-knock-pins');
        if (source) source.setData(geojson || { type: 'FeatureCollection', features: [] });
      });
    },

    setPlaces(places, worstSevere) {
      const geojson = placesToGeoJson(places, worstSevere);
      runWhenLoaded(() => {
        const source = map.getSource('desk-places');
        if (source) source.setData(geojson);
      });
    },

    setIsolation(polygons, isIsolated) {
      runWhenLoaded(() => {
        const source = map.getSource('desk-isolation-mask');
        if (!source) return;
        if (isIsolated && polygons?.length) {
          source.setData(stateOutlineToMaskGeoJson(polygons));
        } else {
          source.setData({ type: 'FeatureCollection', features: [] });
        }
      });
    },

    setBasemap(mode) {
      runWhenLoaded(() => {
        const isSat = mode === 'satellite';
        map.setLayoutProperty(
          'desk-satellite-layer',
          'visibility',
          isSat ? 'visible' : 'none',
        );
      });
    },

    setDotsVisible(visible) {
      runWhenLoaded(() => {
        map.setLayoutProperty(
          'desk-places-circle',
          'visibility',
          visible ? 'visible' : 'none',
        );
      });
    },

    fitBounds(west, south, east, north, options = {}) {
      if (!Number.isFinite(west) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(north)) {
        return;
      }
      runWhenLoaded(() => {
        map.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          {
            padding: options.padding ?? 48,
            maxZoom: options.maxZoom ?? 16,
            duration: options.duration ?? 650,
          },
        );
      });
    },

    flyTo(lon, lat, zoom) {
      runWhenLoaded(() => {
        map.flyTo({
          center: [lon, lat],
          zoom: zoom ?? map.getZoom(),
          duration: 650,
        });
      });
    },

    destroy() {
      if (map) {
        map.remove();
        map = null;
      }
    },
  };
}

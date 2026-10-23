/**
 * apps/hail-desk/src/map/maplibreData.js — pure GeoJSON transformers for MapLibre GL.
 *
 * Pure functions: No DOM, WebGL, or CSS dependencies.
 * Easily tested in Node.js test runners and used across both runtime and headless test environments.
 */

/**
 * Converts storm artwork bands into a standardized GeoJSON FeatureCollection.
 *
 * @param {Array<object>} bands array of { band: { color, outline, label, min }, outer, holes }
 * @returns {object} GeoJSON FeatureCollection
 */
export function swathBandsToGeoJson(bands) {
  const features = [];
  for (const item of bands || []) {
    if (!item?.outer || item.outer.length < 3) continue;
    const outerRing = item.outer.map((pt) => [pt.lon, pt.lat]);
    // Ensure ring closure
    if (
      outerRing[0][0] !== outerRing[outerRing.length - 1][0] ||
      outerRing[0][1] !== outerRing[outerRing.length - 1][1]
    ) {
      outerRing.push(outerRing[0]);
    }

    const holesRings = (item.holes || []).map((ring) => {
      const h = ring.map((pt) => [pt.lon, pt.lat]);
      if (h[0][0] !== h[h.length - 1][0] || h[0][1] !== h[h.length - 1][1]) {
        h.push(h[0]);
      }
      return h;
    });

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [outerRing, ...holesRings],
      },
      properties: {
        color: item.band?.color || '#6d28d9',
        outline: item.band?.outline || '#9333ea',
        label: item.band?.label || '',
        min: item.band?.min || 25.4,
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

/**
 * Converts place rows into GeoJSON FeatureCollection with severe report sizing.
 *
 * @param {Array<object>} places
 * @param {number} [worstSevere=1]
 * @returns {object} GeoJSON FeatureCollection
 */
export function placesToGeoJson(places, worstSevere = 1) {
  const denom = Math.max(1, worstSevere || 1);
  const features = (places || [])
    .filter((p) => Number.isFinite(p?.lon) && Number.isFinite(p?.lat))
    .map((p) => {
      const severe = Number(p.severe || 0);
      const share = Math.min(1, Math.max(0, severe / denom));
      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [p.lon, p.lat],
        },
        properties: {
          name: p.name || '',
          geoid: p.geoid || '',
          state: p.state || '',
          severe,
          share,
        },
      };
    });

  return { type: 'FeatureCollection', features };
}

/**
 * Creates an inverted polygon mask GeoJSON covering the globe except for the isolated state.
 *
 * @param {Array<Array<Array<[number, number]>>>} polygons state boundary polygons
 * @returns {object} GeoJSON FeatureCollection
 */
export function stateOutlineToMaskGeoJson(polygons) {
  if (!Array.isArray(polygons) || !polygons.length) {
    return { type: 'FeatureCollection', features: [] };
  }

  // World bounding rectangle in EPSG:4326
  const worldOuter = [
    [-180, -85],
    [180, -85],
    [180, 85],
    [-180, 85],
    [-180, -85],
  ];

  // Each polygon in the state becomes a hole in the world mask
  const holes = [];
  for (const poly of polygons) {
    if (Array.isArray(poly) && Array.isArray(poly[0]) && poly[0].length >= 3) {
      const ring = [...poly[0]];
      if (
        ring[0][0] !== ring[ring.length - 1][0] ||
        ring[0][1] !== ring[ring.length - 1][1]
      ) {
        ring.push(ring[0]);
      }
      holes.push(ring);
    }
  }

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [worldOuter, ...holes],
        },
        properties: {},
      },
    ],
  };
}

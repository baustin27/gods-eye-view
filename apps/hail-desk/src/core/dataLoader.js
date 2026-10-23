/**
 * apps/hail-desk/src/core/dataLoader.js — centralized artifact and geometry loader for Hail Desk 2.0.
 *
 * Responsibilities:
 *   1. Transparent caching for large gzipped JSON artifacts (cities, counties, swaths, FEMA).
 *   2. Deduplication of in-flight promises so multiple components requesting the same
 *      dataset simultaneously trigger exactly one HTTP fetch.
 *   3. Clean error reporting when server fails or returns HTML instead of binary data.
 */

import { loadGzippedJson } from '../data.js';

export function createDataLoader(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    baseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/',
  } = options;

  const cache = new Map();
  const inFlight = new Map();

  async function fetchWithDedupe(key, loader) {
    if (cache.has(key)) return cache.get(key);
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
      try {
        const data = await loader();
        cache.set(key, data);
        return data;
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, promise);
    return promise;
  }

  function loadCities() {
    return fetchWithDedupe('cities', () =>
      loadGzippedJson(`${baseUrl}data/cities.json.gz`, fetchImpl),
    );
  }

  function loadCounties() {
    return fetchWithDedupe('counties', () =>
      loadGzippedJson(`${baseUrl}data/counties.json.gz`, fetchImpl),
    );
  }

  function loadSwaths() {
    return fetchWithDedupe('swaths', () =>
      loadGzippedJson(`${baseUrl}data/swaths.json.gz`, fetchImpl),
    );
  }

  function loadFema() {
    return fetchWithDedupe('fema', () =>
      loadGzippedJson(`${baseUrl}data/fema_damage.json.gz`, fetchImpl),
    );
  }

  async function loadStateOutline(postal, signal) {
    const code = String(postal || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return null;

    return fetchWithDedupe(`stateOutline_${code}`, async () => {
      try {
        const response = await fetchImpl(`/api/desk/state?state=${code}`, { signal });
        if (!response.ok) return null;
        const data = await response.json();
        return Array.isArray(data?.polygons) ? data.polygons : null;
      } catch {
        return null;
      }
    });
  }

  async function loadCityOutlines(postal, signal) {
    const code = String(postal || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return [];

    return fetchWithDedupe(`cityOutlines_${code}`, async () => {
      try {
        const response = await fetchImpl(`/api/desk/places?state=${code}`, { signal });
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data?.places) ? data.places : [];
      } catch {
        return [];
      }
    });
  }

  async function loadTractGeometry(state, county, geoid, signal) {
    const key = `tract_${state}_${county}_${geoid}`;
    return fetchWithDedupe(key, async () => {
      try {
        const response = await fetchImpl(
          `/api/desk/tracts/${state}/${county}/${geoid}/geometry`,
          { signal },
        );
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      }
    });
  }

  function clearCache() {
    cache.clear();
    inFlight.clear();
  }

  return {
    loadCities,
    loadCounties,
    loadSwaths,
    loadFema,
    loadStateOutline,
    loadCityOutlines,
    loadTractGeometry,
    clearCache,
  };
}

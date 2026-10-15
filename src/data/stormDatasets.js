// The bundled storm snapshots are US Government public domain (NOAA/NWS SPC and
// US Census Bureau) plus FEMA National Risk Index data, which is free to use
// with the mandated disclaimer published in stormAttribution.js. See
// src/data/local_data/storm/README.md and DATA_SOURCES.md.

import * as stormScoring from './stormScoring.js';

const cellsFineUrl = new URL(
  './local_data/storm/storm_cells_025.geojsonl',
  import.meta.url,
).href;
const cellsCoarseUrl = new URL(
  './local_data/storm/storm_cells_050.geojsonl',
  import.meta.url,
).href;
const eventsUrl = new URL(
  './local_data/storm/storm_events.geojsonl',
  import.meta.url,
).href;
const countiesUrl = new URL(
  './local_data/storm/storm_counties.geojsonl',
  import.meta.url,
).href;
const metaUrl = new URL(
  './local_data/storm/storm-sources.json',
  import.meta.url,
).href;
// Radar is an optional enrichment rather than part of the core dataset: it
// covers 2021 onward only, and it must be possible to run the app from a
// checkout that predates the radar build without the layer failing to load.
const radarUrl = new URL(
  './local_data/storm/storm_radar_hail.geojsonl',
  import.meta.url,
).href;
const radarMetaUrl = new URL(
  './local_data/storm/storm-radar-sources.json',
  import.meta.url,
).href;

/** Grid step, in degrees, of the fine damage-score grid. */
export const STORM_FINE_GRID_DEG = 0.25;
/** Grid step, in degrees, of the coarse recurrence grid. */
export const STORM_COARSE_GRID_DEG = 0.5;

/**
 * Parse a GeoJSONL snapshot into an array of features.
 *
 * Blank lines are tolerated because the writer emits a trailing newline, and a
 * single unparseable line is skipped rather than failing the whole load: these
 * are static, version-controlled assets, so a corrupt line is a bug to surface
 * in the stats rather than a reason to leave the layer permanently empty.
 *
 * @param {string} text
 * @returns {{features: Array<object>, skipped: number}}
 */
export function parseGeoJsonLines(text) {
  const features = [];
  let skipped = 0;
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const feature = JSON.parse(trimmed);
      if (feature && feature.geometry && feature.properties)
        features.push(feature);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { features, skipped };
}

/**
 * Decode the compact per-year tally list into a lookup.
 *
 * The snapshot stores `[year, hail, wind, year, hail, wind, ...]` because a
 * flat triple list is roughly a third smaller than `{ "1998": [2, 1] }` and
 * most cells have only a handful of active years. Decoding here rather than at
 * scoring time keeps the hot path a map read.
 *
 * A malformed list yields an empty map rather than throwing: the decade
 * buckets remain as a fallback, so an old or damaged snapshot degrades to the
 * prorated path instead of rendering nothing.
 *
 * @param {unknown} raw
 * @returns {Map<number, {hail:number, wind:number}>}
 */
export function decodeYearBuckets(raw) {
  const years = new Map();
  if (!Array.isArray(raw)) return years;
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const year = Number(raw[i]);
    const hail = Number(raw[i + 1]);
    const wind = Number(raw[i + 2]);
    if (
      !Number.isFinite(year) ||
      !Number.isFinite(hail) ||
      !Number.isFinite(wind)
    )
      continue;
    years.set(year, { hail, wind });
  }
  return years;
}

/**
 * Normalise one bundled grid point feature into the flat cell shape
 * `stormScoring.js` expects: grid indices for the join key plus a centre for
 * display.
 * @param {object} feature
 * @returns {object|null}
 */
export function toCellRecord(feature) {
  const p = feature?.properties;
  const coords = feature?.geometry?.coordinates;
  if (!p || !Array.isArray(coords) || coords.length < 2) return null;
  const [lon, lat] = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    i: p.i,
    j: p.j,
    d: p.d ?? STORM_FINE_GRID_DEG,
    lat,
    lon,
    hailCount: p.hn ?? 0,
    hailSevere: p.hs ?? 0,
    hailSignificant: p.hg ?? 0,
    maxHailIn: p.hx ?? null,
    windCount: p.wn ?? 0,
    windSevere: p.ws ?? 0,
    windStructural: p.wc ?? 0,
    maxWindKt: p.wx ?? null,
    compoundDays: p.cd ?? 0,
    firstYear: p.y0 ?? null,
    lastYear: p.y1 ?? null,
    reportedLoss: p.pl ?? null,
    injuries: p.in ?? null,
    fatalities: p.ft ?? null,
    decades: p.dc ?? {},
    years: decodeYearBuckets(p.ye),
  };
}

/**
 * Parse optional JSON metadata, returning null rather than throwing.
 * @param {string|null} text
 * @returns {object|null}
 */
export function parseOptionalJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Normalise one bundled radar hail-core feature.
 *
 * The radar snapshot uses the same 0.25 deg index space as `storm_cells_025`,
 * so `i`/`j` are the join key and no coordinate search is needed. Only cells
 * that had at least one hail core on at least one day are present, which keeps
 * the file small and makes an absent cell mean "no radar hail detected" rather
 * than "not yet processed".
 *
 * @param {object} feature
 * @returns {{i:number, j:number, maxHailMm:number, corePoints:number, hailDays:number, firstYear:number, lastYear:number}|null}
 */
export function toRadarRecord(feature) {
  const p = feature?.properties;
  if (!p || !Number.isFinite(p.i) || !Number.isFinite(p.j)) return null;
  return {
    i: p.i,
    j: p.j,
    maxHailMm: p.mx ?? null,
    corePoints: p.cp ?? 0,
    hailDays: p.dy ?? 0,
    firstYear: p.y0 ?? null,
    lastYear: p.y1 ?? null,
  };
}

/**
 * Normalise one bundled significant-event feature.
 *
 * Tracks arrive as a two-point LineString when SPC recorded both an initial and
 * a final location, and as a bare Point otherwise. Callers should not assume a
 * track exists — a missing final location is normal for point reports.
 *
 * @param {object} feature
 * @returns {object|null}
 */
export function toEventRecord(feature) {
  const p = feature?.properties;
  const g = feature?.geometry;
  if (!p || !g) return null;
  const isTrack = g.type === 'LineString' && Array.isArray(g.coordinates);
  const head = isTrack ? g.coordinates[0] : g.coordinates;
  if (!Array.isArray(head) || head.length < 2) return null;
  return {
    id: p.id ?? null,
    hazard: p.t === 'h' || p.t === 'hail' ? 'hail' : 'wind',
    year: p.y ?? null,
    month: p.m ?? null,
    magnitude: p.mag ?? null,
    severity: p.sev ?? null,
    countyFips: p.cf ?? null,
    state: p.st ?? null,
    lat: p.lat ?? head[1],
    lon: p.lon ?? head[0],
    track: isTrack ? g.coordinates : null,
    reportedLoss: p.pl ?? null,
    pathLenKm: p.len ?? null,
    pathWidKm: p.wid ?? null,
  };
}

/**
 * Normalise one bundled county feature, keeping geometry for area selection.
 * @param {object} feature
 * @returns {object|null}
 */
export function toCountyRecord(feature) {
  const p = feature?.properties;
  if (!p || !feature?.geometry) return null;
  return {
    fips: p.fips,
    name: p.name,
    state: p.st,
    stateName: p.stn ?? null,
    geometry: feature.geometry,
    population: p.pop ?? null,
    buildingValue: p.bld ?? null,
    totalEal: p.eal ?? null,
    nriHailEal: p.hEal ?? null,
    nriHailRate: p.hRate ?? null,
    nriHailRating: p.hRating ?? null,
    nriHailRiskRating: p.hRisk ?? null,
    nriHailEvents: p.hEvents ?? null,
    nriHailFrequency: p.hFreq ?? null,
    nriHailLossRatio: p.hLossRatio ?? null,
    nriWindEal: p.wEal ?? null,
    nriWindRate: p.wRate ?? null,
    nriWindRating: p.wRating ?? null,
    nriWindRiskRating: p.wRisk ?? null,
    nriWindEvents: p.wEvents ?? null,
    nriWindFrequency: p.wFreq ?? null,
    nriWindLossRatio: p.wLossRatio ?? null,
    hailCount: p.hn ?? 0,
    hailSevere: p.hs ?? 0,
    hailSignificant: p.hg ?? 0,
    maxHailIn: p.hx ?? null,
    windCount: p.wn ?? 0,
    windSevere: p.ws ?? 0,
    maxWindKt: p.wx ?? null,
    firstYear: p.y0 ?? null,
    lastYear: p.y1 ?? null,
    reportedLoss: p.pl ?? null,
    decades: p.dc ?? {},
    years: decodeYearBuckets(p.ye),
  };
}

/**
 * Load and cache the whole bundled storm dataset.
 *
 * The three snapshots are fetched in parallel and the derived indexes (county
 * per cell, county by FIPS) are built once. Callers await
 * {@link loadStormDataset} and then read from the returned object; there is no
 * cache invalidation because the underlying files are immutable build artefacts
 * addressed by Vite's content hash in production.
 *
 * @param {{signal?: AbortSignal, fetchImpl?: Function}} [options]
 * @returns {Promise<object|null>} Dataset, or null if the snapshot is unavailable.
 */
export async function loadStormDataset({ signal, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  let pending = loadStormDataset.pending;
  if (!pending) {
    pending = (async () => {
      const read = async (url) => {
        signal?.throwIfAborted();
        const response = await doFetch(url, { signal, cache: 'force-cache' });
        if (!response.ok) {
          try {
            await response.body?.cancel();
          } catch {
            /* best effort */
          }
          throw new Error(`HTTP ${response.status} for ${url}`);
        }
        const text = await response.text();
        signal?.throwIfAborted();
        return text;
      };

      // Radar is best-effort. A 404 here means the snapshot was never built, and
      // that must degrade to "no radar evidence" rather than taking down the
      // report-based scoring that the whole layer already depends on.
      const readOptional = async (url) => {
        try {
          return await read(url);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          return null;
        }
      };

      const [
        fineText,
        coarseText,
        eventsText,
        countiesText,
        metaText,
        radarText,
        radarMetaText,
      ] = await Promise.all([
        read(cellsFineUrl),
        read(cellsCoarseUrl),
        read(eventsUrl),
        read(countiesUrl),
        read(metaUrl),
        readOptional(radarUrl),
        readOptional(radarMetaUrl),
      ]);

      const fine = parseGeoJsonLines(fineText);
      const coarse = parseGeoJsonLines(coarseText);
      const events = parseGeoJsonLines(eventsText);
      const counties = parseGeoJsonLines(countiesText);
      const radarFeatures = radarText
        ? parseGeoJsonLines(radarText)
        : { features: [], skipped: 0 };

      const radarByCell = new Map();
      for (const feature of radarFeatures.features) {
        const record = toRadarRecord(feature);
        if (record) radarByCell.set(`${record.i}:${record.j}`, record);
      }

      const cells = fine.features.map(toCellRecord).filter(Boolean);
      const coarseCells = coarse.features.map(toCellRecord).filter(Boolean);
      const significantEvents = events.features
        .map(toEventRecord)
        .filter(Boolean);
      const countyRecords = counties.features
        .map(toCountyRecord)
        .filter(Boolean);

      const { indexCellsToCounties } = stormScoring;
      const countyIndex = indexCellsToCounties(cells, countyRecords);
      const byFips = new Map(countyRecords.map((c) => [c.fips, c]));

      const latestYear = cells.reduce(
        (max, c) => Math.max(max, c.lastYear || 0),
        0,
      );
      const earliestYear = cells.reduce(
        (min, c) => Math.min(min, c.firstYear || latestYear || 0),
        Number.POSITIVE_INFINITY,
      );

      const meta = parseOptionalJson(metaText);

      return {
        cells,
        coarseCells,
        significantEvents,
        counties: countyRecords,
        countiesByCell: countyIndex.byCell,
        countiesByFips: byFips,
        radarByCell,
        radarMeta: parseOptionalJson(radarMetaText),
        latestYear,
        earliestYear: Number.isFinite(earliestYear) ? earliestYear : null,
        meta,
        stats: {
          fineCells: fine.features.length,
          fineCellsSkipped: fine.skipped,
          coarseCells: coarse.features.length,
          events: events.features.length,
          counties: countyRecords.length,
          countiesSkipped: counties.skipped,
          countiesWithoutStormData: countyRecords.filter(
            (c) => !c.decades || Object.keys(c.decades).length === 0,
          ).length,
          cellsWithCounty: countyIndex.matchedCells,
          cellsWithoutCounty: countyIndex.unmatchedCells,
          radarCells: radarByCell.size,
          radarSkipped: radarFeatures.skipped,
          radarHailDays: [...radarByCell.values()].reduce(
            (sum, r) => sum + (r.hailDays || 0),
            0,
          ),
        },
      };
    })().catch((error) => {
      loadStormDataset.pending = null;
      throw error;
    });
    loadStormDataset.pending = pending;
  }
  return pending;
}
loadStormDataset.pending = null;

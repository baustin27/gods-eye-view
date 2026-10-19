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
/**
 * Decode the per-year tallies a snapshot carries.
 *
 * The implementation lives in `stormScoring.js` - pure, zero-import, and
 * importable by a front end that must not pull in this module's artifact URLs.
 * Re-exported here so the existing importers keep working.
 */
export { decodeYearBuckets } from './stormScoring.js';

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
    years: stormScoring.decodeYearBuckets(p.ye),
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
 * First day of the per-day radar artifact's `dayIndex`, mirroring the builder's
 * `DAY_INDEX_EPOCH`. It is fixed to the start of the MRMS archive rather than to
 * the build window so an index means the same calendar day in every build: a
 * window-relative epoch would silently re-date every record the next time the
 * window was extended.
 */
export const RADAR_DAY_INDEX_EPOCH = '2021-01-01';

/**
 * Units per millimetre in the per-day radar artifact, mirroring the builder's
 * `PER_DAY_MM_SCALE`. The builder stores `maxMm x 10` in a `uint16`, so a stored
 * reading is tenths of a millimetre and must be divided by this, not multiplied
 * or written out unchanged.
 */
export const RADAR_PER_DAY_MM_SCALE = 10;

/**
 * The retained index space the per-day radar artifact encodes, mirroring the
 * builder's geometry (`GRID_ROW_BASE`, `GRID_COL_BASE`, `GRID_COLUMNS`, and the
 * 140 x 260 cell count). `cellIndex = (i - rowBase) * columns + (j - colBase)`,
 * row-major. These are load-bearing 16-bit geometry — a one-unit error silently
 * misplaces every cell — so the values are pinned against the sidecar in
 * `stormRadar.test.mjs` rather than trusted here.
 */
export const RADAR_GRID = Object.freeze({
  deg: STORM_FINE_GRID_DEG,
  rowBase: 84,
  colBase: -500,
  rows: 140,
  columns: 260,
  cellCount: 140 * 260,
});

/**
 * The FINE retained index space, mirroring the builder's
 * `GRID_ROW_BASE_FINE` / `GRID_COL_BASE_FINE` / 3500 x 6500.
 *
 * A SIBLING of {@link RADAR_GRID}, not a parameterisation of it. The two grids
 * are 25x apart in each axis and their index 0 means completely different
 * places — Denver is 158:-420 on one and 3962:-10488 on the other — so a payload
 * decoded with the wrong one returns plausible numbers for the wrong cells and
 * throws nowhere. Keeping them separate types is the cheapest guard there is.
 *
 * 22.75 million cells, so the index is a 32-bit read, not a 16-bit one.
 */
export const RADAR_FINE_GRID = Object.freeze({
  deg: 0.01,
  rowBase: 2100,
  colBase: -12500,
  rows: 3500,
  columns: 6500,
  cellCount: 3500 * 6500,
});

/**
 * The fine shard's floor, mirroring the builder's `HAIL_RETAIN_MM_FINE`.
 *
 * 19 mm, not 10: measured across the window that is 245 MB versus 28 MB, and
 * 3,065 versus 979 rings a day. It is three-quarters of an inch — the NWS
 * severe threshold and the lowest band the category draws.
 */
export const RADAR_RETAIN_MM_FINE = 19;

/**
 * The fine shard's record width, mirroring `FINE_DAY_RECORD_BYTES`.
 *
 * `u32 cellIndex, u16 maxMm x RADAR_PER_DAY_MM_SCALE`. The day is NOT in the
 * payload; it is in the filename, so a shard cannot be misread as belonging to
 * another day.
 */
export const FINE_DAY_RECORD_BYTES = 6;

/**
 * Magic at the head of a fine shard, ASCII `FINE`.
 *
 * Not decoration. The coarse per-day artifact has the SAME six-byte record
 * width, so length alone cannot tell the families apart — and a coarse shard
 * handed to the fine decoder reads `u16 index, u16 day, u16 mm` as
 * `u32 index, u16 mm`, turning index 12,000 into 10,825,440 (inside the fine
 * space) and 562 into a plausible 56.2 mm. Hail in the wrong county, no error
 * raised anywhere. A length check catches most coarse shards by luck; this
 * catches all of them.
 */
export const FINE_DAY_MAGIC = Object.freeze([0x46, 0x49, 0x4e, 0x45]);
/** Bytes of magic before the first record. */
export const FINE_DAY_HEADER_BYTES = FINE_DAY_MAGIC.length;

const RADAR_EPOCH_MS = Date.parse(`${RADAR_DAY_INDEX_EPOCH}T00:00:00Z`);
const MS_PER_DAY = 86_400_000;

/**
 * ISO day form of a date-like value: `2026-08-11`, `20260811` or a `Date`.
 * @param {string|Date} date
 * @returns {string|null}
 */
function radarIsoDay(date) {
  if (date instanceof Date) {
    return Number.isNaN(date.getTime())
      ? null
      : date.toISOString().slice(0, 10);
  }
  const text = String(date ?? '').trim();
  if (/^\d{8}$/.test(text))
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return null;
}

/**
 * Days from {@link RADAR_DAY_INDEX_EPOCH} to a calendar date, the index the
 * per-day artifact stores. This is the read side of the builder's `dayIndex`,
 * and the epoch is the part that must match the sidecar: read with a different
 * origin and every date on the map shifts.
 * @param {string|Date} date
 * @returns {number|null} UTC day number, or null for an unreadable date.
 */
export function radarDayIndex(date) {
  const iso = radarIsoDay(date);
  if (!iso) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms - RADAR_EPOCH_MS) / MS_PER_DAY);
}

/**
 * The inverse of {@link radarDayIndex}: the calendar date a stored day index
 * names. `null` for a negative or non-integer index rather than an invented
 * date.
 * @param {number} dayIndex
 * @returns {string|null} ISO day, `YYYY-MM-DD`.
 */
export function radarDateFromDayIndex(dayIndex) {
  if (!Number.isInteger(dayIndex) || dayIndex < 0) return null;
  return new Date(RADAR_EPOCH_MS + dayIndex * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * The calendar year a date names, as a string. The year-scoped radar loaders
 * key on it, and the per-day loader is asked for one year at a time.
 * @param {string|Date} date
 * @returns {string|null}
 */
export function radarYearOf(date) {
  const iso = radarIsoDay(date);
  return iso ? iso.slice(0, 4) : null;
}

/**
 * Decode a flat per-day cell index back to its grid `i`/`j`.
 *
 * The inverse of the builder's `cellIndex`, refusing rather than aliasing: an
 * index outside the retained space would otherwise decode onto a real cell and
 * misplace hail on the map with no error anywhere downstream.
 * @param {number} cellIndex
 * @returns {{i: number, j: number}|null}
 */
export function radarCellFromIndex(cellIndex) {
  if (
    !Number.isInteger(cellIndex) ||
    cellIndex < 0 ||
    cellIndex >= RADAR_GRID.cellCount
  )
    return null;
  return {
    i: Math.floor(cellIndex / RADAR_GRID.columns) + RADAR_GRID.rowBase,
    j: (cellIndex % RADAR_GRID.columns) + RADAR_GRID.colBase,
  };
}

/**
 * Normalise one decoded day of the per-day radar artifact.
 *
 * A sibling of {@link toRadarRecord}, not a change to it: a per-day record is a
 * flat `{cellIndex, dayIndex, tenths}`, not a GeoJSON feature, and the strict
 * feature normaliser would reject it outright. The day index resolves to a real
 * calendar date through the artifact's fixed epoch, and each cell index to its
 * `i:j` grid key, so the result drops straight into
 * `stormCrossReference.indexRadarDays` and the consumers downstream of it.
 *
 * Millimetres are exact. A reading may carry `maxMm` already in millimetres (the
 * form a decoder produces) or `tenthsMm`, the raw `uint16` as stored, which is
 * divided by {@link RADAR_PER_DAY_MM_SCALE}. 14,374 tenths is 1,437.4 mm and
 * 100 tenths is 10 mm — the division, not an approximation of it.
 *
 * Malformed input rejects the whole day, exactly as `toRadarRecord` rejects a
 * feature: a missing or out-of-range cell index, or a non-finite value, returns
 * null rather than silently dropping cells from a swath.
 *
 * @param {number} dayIndex
 * @param {Iterable<{cellIndex?: number, maxMm?: number, tenthsMm?: number}>} readings
 * @returns {{dayIndex: number, date: string, cells: Map<string, number>}|null}
 */
export function toRadarDays(dayIndex, readings) {
  const date = radarDateFromDayIndex(dayIndex);
  if (date === null || readings == null) return null;
  const cells = new Map();
  for (const reading of readings) {
    const cell = radarCellFromIndex(reading?.cellIndex);
    if (!cell) return null;
    let mm;
    if (reading?.tenthsMm !== undefined) {
      const tenths = Number(reading.tenthsMm);
      if (!Number.isFinite(tenths)) return null;
      mm = tenths / RADAR_PER_DAY_MM_SCALE;
    } else {
      mm = Number(reading?.maxMm);
      if (!Number.isFinite(mm)) return null;
    }
    const key = `${cell.i}:${cell.j}`;
    const seen = cells.get(key);
    if (seen === undefined || mm > seen) cells.set(key, mm);
  }
  return { dayIndex, date, cells };
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
    years: stormScoring.decodeYearBuckets(p.ye),
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

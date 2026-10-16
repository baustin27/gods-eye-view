/**
 * Build the radar hail climatology snapshot from NOAA MRMS.
 *
 * Why this exists
 * ---------------
 * The bundled Storm Events snapshot is built from *reports*: point observations
 * of hail that somebody actually saw and filed. MRMS is the complementary
 * record — a national 1 km multi-radar mosaic that measures hail wherever a
 * storm exists, including the many swaths that produced no report at all. The
 * two answer different questions, and the gap between them is the point:
 * a cell that radar shows a strong hail core every June but that never appears
 * in the report record is a reporting gap, not a safe neighbourhood.
 *
 * Data
 * ----
 * `CONUS/MESH_Max_1440min_00.50` — the 24-hour rolling maximum of MRMS Maximum
 * Estimated Size of Hail, one file per day, covering 7000 x 3500 points at 0.01°.
 * Files are GRIB2 with PNG packing (data representation template 5.40), which is
 * what makes this tractable: a full 24.5M-point field arrives as ~0.1-1.5 MB.
 * Keyless — `s3://noaa-mrms-pds` needs no AWS account and charges no egress.
 *
 * Accuracy caveat, carried into the app rather than buried here
 * -------------------------------------------------------------
 * MESH is *estimated* from radar and is known to over-report compared with
 * ground reports (NSSL documents MESH running large relative to SPC reports).
 * It is a good measure of where hail fell and a poor measure of exactly how
 * large each stone was. The app therefore scores this as corroborating
 * evidence, never as a replacement for the report-based hail size.
 *
 * Output
 * ------
 * `storm_radar_hail.geojsonl` — 0.25 deg cells keyed with the same `i`/`j`
 * grid indices as `storm_cells_025.geojsonl`, so the app joins them directly.
 * Statistics there span the whole window.
 * `storm_radar_hail_<year>.geojsonl.gz` plus a `storm-radar-sources_<year>.json`
 * sidecar — the same grid scoped to one calendar year, so a consumer can pull a
 * single year's climatology without inflating the whole archive, and every
 * number in a year file describes only hail that fell in that year. A cell
 * active in several years appears in each of those years' files, once per year;
 * the combined file is the union of those year records merged on `i:j`, so the
 * two can never disagree. Every emitted file is ordered by a total order over the
 * cells, never by insertion order, so two runs over the same window produce
 * byte-identical artefacts.
 *
 * Usage
 *  node scripts/build-storm-radar-snapshots.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                                       [--days N] [--concurrency N] [--refresh]
 *
 * @module scripts/build-storm-radar-snapshots
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  parseGrib2,
  parseGrid,
  parseDataRepresentation,
  decodeValues,
  indexToLonLat,
} from './lib/grib2.mjs';
import {
  fetchBuffer,
  setRefresh,
  writeGeoJsonl,
  step,
} from './lib/storm-fetch.mjs';

const TOOL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const PROJECT_ROOT = path.resolve(process.env.GEV_PROJECT_ROOT || TOOL_ROOT);
const DEFAULT_OUT = path.join(
  PROJECT_ROOT,
  'src',
  'data',
  'local_data',
  'storm',
);

const BUCKET = 'https://noaa-mrms-pds.s3.amazonaws.com';
const PRODUCT = 'CONUS/MESH_Max_1440min_00.50';
const PRODUCT_LABEL = 'MRMS MESH 24-hour maximum';

/**
 * MESH, in millimetres, at or above which a cell counts as having had a hail
 * core on a given day. 25 mm is just under one inch — the point at which hail
 * does damage rather than merely fall, and it sits between MRMS's bias and a
 * genuinely damaging event.
 */
const HAIL_CORE_MM = 25;

/**
 * Minimum hail size in millimetres that the per-day accumulator will retain.
 * Below this floor the per-day artifact discards the cell entirely.
 * This is the lower threshold of the two-threshold split:
 *   HAIL_RETAIN_MM = 10  — per-day accumulator keep floor
 *   HAIL_CORE_MM = 25    — core threshold for per-year & combined GeoJSONL
 * Invariant: the 7 existing artifacts (storm_radar_hail.geojsonl, 6 ×
 * storm_radar_hail_<year>.geojsonl.gz, 7 sidecars) remain byte-identical
 * apart from builtAt; HAIL_CORE_MM's behaviour must not change.
 */
export const HAIL_RETAIN_MM = 10;

/** Pure predicate: returns true if the given hail size mm is at or above the retain floor. */
export function aboveRetainFloor(mm) {
  return mm >= HAIL_RETAIN_MM;
}
/** Grid step of the emitted snapshot, degrees. Must match the report snapshot. */
export const CELL_DEG = 0.25;
/** Number of columns in the emitted snapshot grid, derived from CELL_DEG. */
export const COLUMN_COUNT = Math.round(360 / CELL_DEG);
/** Guard against a pathological day materialising every CONUS cell. */
const MAX_CELLS = 40000;

/**
 * Minimum longitude bound for the CONUS radar domain.
 * MRMS longitudes start at 230°E; after normalisation to −180..180,
 * the grid spans from ~−125° (dateline-adjacent) to ~125°W.
 * Cells west of −125° belong to the Pacific Ocean and are excluded.
 */
export const DOMAIN_MIN_LON = -125;

/**
 * Minimum latitude bound for the CONUS radar domain.
 * The MRMS CONUS reporting envelope extends from 21°N to 56°N;
 * cells south of 21°N are outside the continental United States.
 */
export const DOMAIN_MIN_LAT = 21;

/**
 * Maximum latitude bound for the CONUS radar domain.
 * The MRMS CONUS reporting envelope extends from 21°N to 56°N;
 * cells north of 56°N are outside the continental United States.
 */
export const DOMAIN_MAX_LAT = 56;
/**
 * First day of the MRMS archive for this product. A bare run reproduces the
 * bundled snapshot exactly, so the committed artefact is never the product of
 * "whatever window someone happened to pass".
 */
const ARCHIVE_START = '2021-01-01';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    out: DEFAULT_OUT,
    concurrency: 4,
    refresh: false,
    from: null,
    to: null,
    days: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--refresh') out.refresh = true;
    else if (arg === '--out') out.out = path.resolve(argv[++i]);
    else if (arg === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (arg === '--from') out.from = argv[++i];
    else if (arg === '--to') out.to = argv[++i];
    else if (arg === '--days') out.days = Number(argv[++i]);
  }
  if (!Number.isFinite(out.concurrency) || out.concurrency < 1)
    out.concurrency = 4;
  return out;
}

/** Inclusive list of YYYYMMDD strings between two dates. */
function dateRange(from, to) {
  const days = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    const ymd = cursor.toISOString().slice(0, 10).replaceAll('-', '');
    days.push(ymd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Fetch — or lazily create — the per-year slice of the accumulator.
 *
 * The accumulator is `Map<year, Map<'i:j', cell>>` rather than one flat
 * `Map<'i:j', cell>`, and this is the whole point of the file: a per-year
 * snapshot is only meaningful if a cell's statistics describe the year the
 * consumer asked for. A flat map makes `mx`/`cp`/`dy` lifetime aggregates, so a
 * "2021" file built by filtering that map carries numbers earned in 2024 and
 * omits every cell that merely happened to be active in 2021 — the exact
 * inversion that makes a year file useless for scoring one storm day.
 *
 * Keying on the year of the day being ingested (rather than on a cell's first or
 * last active day) is what lets one cell appear in every year file it was
 * active in, each carrying that year's own numbers.
 *
 * @param {Map<number, Map<string, object>>} cellsByYear Accumulator, mutated in place.
 * @param {string} ymd Day stamp; its year selects the bucket.
 * @returns {{year: number, bucket: Map<string, object>}}
 */
export function yearBucket(cellsByYear, ymd) {
  const year = Number(ymd.slice(0, 4));
  let bucket = cellsByYear.get(year);
  if (!bucket) {
    bucket = new Map();
    cellsByYear.set(year, bucket);
  }
  return { year, bucket };
}

/**
 * Decode one MRMS daily-maximum file into that year's per-cell statistics.
 *
 * @param {Buffer} gzipped Raw `.grib2.gz` bytes.
 * @param {string} ymd Day stamp, for the year bucket and the per-cell day tally.
 * @param {Map<number, Map<string, object>>} cellsByYear Accumulator, mutated in place.
 * @returns {{points: number, maxMm: number|null, cellsTouched: number, year: number}}
 */
export function ingestMeshGz(gzipped, ymd, cellsByYear) {
  const { year, bucket: cells } = yearBucket(cellsByYear, ymd);
  const raw = zlib.gunzipSync(gzipped);
  const message = parseGrib2(raw);
  const packing = parseDataRepresentation(message.sections);
  const grid = parseGrid(message.sections, packing.numberOfValues);
  const values = decodeValues(message.sections, packing, grid);

  let maxMm = null;
  let points = 0;
  for (let i = 0; i < values.length; i += 1) {
    const mm = values[i];
    if (!(mm >= HAIL_CORE_MM)) continue;
    points += 1;
    if (maxMm == null || mm > maxMm) maxMm = mm;
    const { lat, lon } = indexToLonLat(grid, i);
    // Skip the Pacific out-of-grid tail: MRMS longitudes start at 230E so the
    // grid spans the dateline, and cells west of -125 belong to the ocean.
    if (lon < DOMAIN_MIN_LON || lat < DOMAIN_MIN_LAT || lat > DOMAIN_MAX_LAT) continue;
    const key = `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;
    let cell = cells.get(key);
    if (!cell) {
      // Every field here is scoped to `year` alone. `firstYmd`/`lastYmd` can no
      // longer disagree about the year, which is what lets the emitter publish
      // them as `y0`/`y1` without inventing a cross-year span in a per-year file.
      cell = {
        i: Math.floor(lat / CELL_DEG),
        j: Math.floor(lon / CELL_DEG),
        maxMm: null,
        corePoints: 0,
        days: new Set(),
        firstYmd: ymd,
        lastYmd: ymd,
      };
      cells.set(key, cell);
    }
    if (cell.maxMm == null || mm > cell.maxMm) cell.maxMm = mm;
    cell.corePoints += 1;
    cell.days.add(ymd);
    if (ymd < cell.firstYmd) cell.firstYmd = ymd;
    if (ymd > cell.lastYmd) cell.lastYmd = ymd;
  }
  return { points, maxMm, cellsTouched: cells.size, year };
}

/**
 * Fetch one day and fold it into that day's year bucket.
 * @param {string} ymd
 * @param {Map<number, Map<string, object>>} cellsByYear
 * @returns {Promise<{ymd:string, ok:boolean, points:number, error?:string}>}
 */
async function ingestDay(ymd, cellsByYear) {
  const key = `${PRODUCT}/${ymd}/MRMS_MESH_Max_1440min_00.50_${ymd}-000000.grib2.gz`;
  try {
    const body = await fetchBuffer(`${BUCKET}/${key}`);
    const result = ingestMeshGz(body, ymd, cellsByYear);
    return { ymd, ok: true, points: result.points };
  } catch (error) {
    // A missing day (product not produced, outage, or a gap in the archive) is
    // recorded, not fatal: a climatology with holes is still useful, and a hard
    // failure would block the build entirely.
    return { ymd, ok: false, points: 0, error: error.message };
  }
}

/**
 * Run `worker` over `items` with bounded concurrency.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} worker
 */
async function pooled(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Selection and partitioning (pure — no I/O, no clock, no network)
// ---------------------------------------------------------------------------

/**
 * Total order over features: strongest hail first, grid index as the tiebreak.
 *
 * The tiebreak is not cosmetic. `[...cells.values()]` is Map insertion order,
 * which under `pooled()` is whatever finished downloading first — so two runs
 * over the same window produce different line order, and `slice(0, MAX_CELLS)`
 * keeps a different *set* of cells each time. Sorting on `mx` alone would leave
 * exact ties (rounded to 0.1 mm) to that same nondeterministic order, so the
 * `i`/`j` tiebreak is what makes the emitted bytes reproducible.
 *
 * @param {{properties: {mx: number, i: number, j: number}}} a
 * @param {{properties: {mx: number, i: number, j: number}}} b
 * @returns {number}
 */
export function compareBySeverity(a, b) {
  const byPeak = (b?.properties?.mx ?? 0) - (a?.properties?.mx ?? 0);
  if (byPeak) return byPeak;
  // Numeric, not lexical: `i`/`j` are signed grid indices and "-9" sorts after
  // "-10" as a string.
  return (
    (a?.properties?.i ?? 0) - (b?.properties?.i ?? 0) ||
    (a?.properties?.j ?? 0) - (b?.properties?.j ?? 0)
  );
}

/**
 * Rank features by hail severity and apply the MAX_CELLS ceiling.
 *
 * Ranking before slicing is load-bearing. The ceiling exists to keep a
 * pathological window from emitting every CONUS cell, so what it discards must
 * be the *weakest* hail: a cell with a 25 mm core may be dropped while a 200 mm
 * core survives, which inverts the meaning of the artifact it produces. The
 * pre-truncation count comes back with the kept set so the meta sidecar can
 * record that a ceiling was applied at all — otherwise the file on disk is
 * indistinguishable from a window that genuinely held only `maxCells` cells.
 *
 * @param {Array<object>} features
 * @param {number} maxCells
 * @returns {{kept: Array<object>, truncated: boolean, cellsBeforeTruncation: number}}
 */
export function selectKeptCells(features, maxCells) {
  const ranked = [...(features ?? [])].sort(compareBySeverity);
  const cellsBeforeTruncation = ranked.length;
  const truncated = cellsBeforeTruncation > maxCells;
  return {
    kept: truncated ? ranked.slice(0, maxCells) : ranked,
    truncated,
    cellsBeforeTruncation,
  };
}

/**
 * One cell's worth of accumulated statistics, as the emitter sees it.
 * @typedef {Object} RadarCell
 * @property {number} i
 * @property {number} j
 * @property {number|null} maxMm
 * @property {number} corePoints
 * @property {Set<string>} days
 * @property {string} firstYmd
 * @property {string} lastYmd
 */

/**
 * Emit one feature. The property shape (`i j d mx cp dy y0 y1`) is fixed by the
 * consumers — `stormCrossReference.js` and `stormDatasets.js` index on `i:j` and
 * read `mx`/`cp` — so it is built in one place and never varies, whether the
 * feature describes one year or the whole archive.
 *
 * Rounding happens on the way out, not on the way in, so a merged cell's `mx`
 * is the max of its per-year maxima rather than a max taken over already-rounded
 * values. (Rounding is monotone, so the two agree — but only because the raw
 * value is still in hand here.)
 *
 * @param {number} i
 * @param {number} j
 * @param {{mx: number, cp: number, dy: number, y0: number, y1: number}} stats
 * @returns {object}
 */
export function cellFeature(i, j, stats) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [
        Math.round((j * CELL_DEG + CELL_DEG / 2) * 100000) / 100000,
        Math.round((i * CELL_DEG + CELL_DEG / 2) * 100000) / 100000,
      ],
    },
    properties: {
      i,
      j,
      d: CELL_DEG,
      mx: Math.round(stats.mx * 10) / 10,
      cp: stats.cp,
      dy: stats.dy,
      y0: stats.y0,
      y1: stats.y1,
    },
  };
}

/**
 * One accumulator bucket to one year's features, ranked strongest-first.
 *
 * `y0` and `y1` are both the bucket's year. That is not a simplification: the
 * statistics in the feature only describe that year, so claiming the cell was
 * active anywhere else would contradict the numbers printed beside it.
 *
 * @param {number} year
 * @param {Map<string, RadarCell>} bucket
 * @returns {Array<object>}
 */
export function yearFeatures(year, bucket) {
  return [...bucket.values()]
    .map((cell) =>
      cellFeature(cell.i, cell.j, {
        mx: cell.maxMm,
        cp: cell.corePoints,
        dy: cell.days.size,
        y0: year,
        y1: year,
      }),
    )
    .sort(compareBySeverity);
}

/**
 * Every accumulator bucket to per-year feature lists, ascending by year.
 *
 * @param {Map<number, Map<string, RadarCell>>} cellsByYear
 * @returns {Map<number, Array<object>>}
 */
export function featuresByYear(cellsByYear) {
  return new Map(
    [...cellsByYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, bucket]) => [year, yearFeatures(year, bucket)]),
  );
}

/**
 * Fold the per-year features back into one whole-archive snapshot.
 *
 * This is the inverse of the partition, and it is derived *from* the per-year
 * files rather than from a parallel accumulator, so the two can never disagree:
 * `mx` is the strongest year, `cp` and `dy` sum (a distinct hail day falls in
 * exactly one year, so summing per-year day counts reproduces the lifetime
 * count), and `y0`/`y1` widen to the span the cell was active over. The property
 * shape is unchanged, so the combined file reads the same as it always did.
 *
 * Output order follows first appearance across ascending years, which is stable;
 * the caller sorts it through `selectKeptCells` anyway.
 *
 * @param {Map<number, Array<object>>} byYear
 * @returns {Array<object>}
 */
export function mergeYearFeatures(byYear) {
  /** @type {Map<string, {i:number,j:number,mx:number,cp:number,dy:number,y0:number,y1:number}>} */
  const merged = new Map();
  for (const [year, list] of [...(byYear ?? new Map())].sort(
    (a, b) => a[0] - b[0],
  )) {
    for (const feature of list ?? []) {
      const p = feature?.properties;
      if (!p || p.i === undefined || p.j === undefined) continue;
      const key = `${p.i}:${p.j}`;
      const mx = Number(p.mx) || 0;
      const cp = Number(p.cp) || 0;
      const dy = Number(p.dy) || 0;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          i: p.i,
          j: p.j,
          mx,
          cp,
          dy,
          y0: year,
          y1: year,
        });
        continue;
      }
      existing.mx = Math.max(existing.mx, mx);
      existing.cp += cp;
      existing.dy += dy;
      existing.y0 = Math.min(existing.y0, year);
      existing.y1 = Math.max(existing.y1, year);
    }
  }
  return [...merged.values()].map((stats) =>
    cellFeature(stats.i, stats.j, stats),
  );
}

/**
 * Restrict every year's feature list to the cells that survived the combined
 * snapshot's ceiling.
 *
 * Truncation is decided once, globally, on the merged set — `MAX_CELLS` bounds
 * the combined artefact, and re-deciding it per year would either let a year
 * file exceed the ceiling the combined file honours or drop cells the combined
 * file kept. Filtering by kept key keeps the union of the year files an exact
 * partition of the combined file under every regime, truncated or not.
 *
 * @param {Map<number, Array<object>>} byYear
 * @param {Set<string>} keptKeys `i:j` keys present in the combined snapshot.
 * @returns {Map<number, Array<object>>}
 */
export function restrictYearsToKeys(byYear, keptKeys) {
  const out = new Map();
  for (const [year, list] of byYear ?? []) {
    // `list` is already ranked; filtering preserves that total order.
    out.set(
      year,
      (list ?? []).filter((f) =>
        keptKeys.has(`${f.properties.i}:${f.properties.j}`),
      ),
    );
  }
  return out;
}

/**
 * Write a gzipped GeoJSONL snapshot atomically, one feature per line.
 *
 * Mirrors `writeGeoJsonl` from `lib/storm-fetch.mjs` — same tmp-then-rename, so
 * a crashed run cannot leave a half-written artefact that later reads as valid —
 * but the payload goes through `gzipSync` at the level the rest of the storm
 * builders use. `gzipSync` stamps no mtime into the header, which is what makes
 * repeated runs byte-identical rather than merely equal in content.
 *
 * @param {string} file Absolute destination path.
 * @param {Array<object>} features
 * @returns {Promise<number>} Bytes on disk.
 */
export async function writeGeoJsonlGz(file, features) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const chunks = [];
  for (const feature of features) chunks.push(`${JSON.stringify(feature)}\n`);
  await fs.writeFile(tmp, zlib.gzipSync(chunks.join(''), { level: 9 }));
  await fs.rename(tmp, file);
  const { size } = await fs.stat(file);
  return size;
}

/**
 * `20210629` -> `2021-06-29`, the ISO form the `window` field is written in.
 * @param {string} ymd
 * @returns {string}
 */
function isoDay(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/**
 * Assemble the provenance sidecar. One shape for the combined snapshot and for
 * every per-year file, so a consumer that learns to read one has learned them
 * all.
 *
 * @param {object} input
 * @param {string} input.builtAt Injected rather than read from the clock so the
 *   builder's only nondeterministic field is testable in isolation.
 * @param {{from: string, to: string, days: number}} input.window
 * @param {Array<{ymd: string, error: string}>} input.unavailableDays
 * @param {number} input.cellCount
 * @param {number} input.corePointCount
 * @param {boolean} input.truncated
 * @param {number} input.cellsBeforeTruncation
 * @returns {object}
 */
export function radarMeta(input) {
  return {
    version: 1,
    builtAt: input.builtAt,
    builder: 'scripts/build-storm-radar-snapshots.mjs',
    product: PRODUCT,
    productLabel: PRODUCT_LABEL,
    bucket: 's3://noaa-mrms-pds',
    license: 'US Government public domain (NOAA/NWS/NSSL)',
    attribution: 'NOAA/NWS/NSSL — Multi-Radar/Multi-Sensor (MRMS)',
    commercialUse: true,
    requiresKey: false,
    units: 'millimetres',
    hailCoreThresholdMm: HAIL_CORE_MM,
    gridDeg: CELL_DEG,
    window: input.window,
    unavailableDays: input.unavailableDays,
    cellCount: input.cellCount,
    corePointCount: input.corePointCount,
    maxCells: MAX_CELLS,
    truncated: input.truncated,
    cellsBeforeTruncation: input.cellsBeforeTruncation,
    caveat:
      'MESH is a radar estimate and is known to over-report relative to ground reports. Treat it as evidence of where hail fell, not as an exact stone size.',
  };
}

/**
 * Write a sidecar JSON atomically, with the trailing newline the other builders
 * emit so the files stay diff- and prettier-friendly.
 * @param {string} file
 * @param {object} value
 */
export async function writeMetaJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  setRefresh(args.refresh);
  const startedAt = Date.now();

  // Default window: the trailing N days ending yesterday, because the 24-hour
  // maximum file stamped 00:00 UTC covers the preceding day.
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const to = args.to || yesterday.toISOString().slice(0, 10);
  // Precedence is explicit: an explicit --from/--days beats the archive default.
  const from = args.days
    ? new Date(
        new Date(`${to}T00:00:00Z`).getTime() - (args.days - 1) * 86_400_000,
      )
        .toISOString()
        .slice(0, 10)
    : args.from || ARCHIVE_START;
  if (from < ARCHIVE_START) {
    throw new Error(
      `--from ${from} predates the MRMS archive start of ${ARCHIVE_START}`,
    );
  }
  const days = dateRange(from, to);
  step(`MRMS ${PRODUCT_LABEL}: ${days.length} days, ${from} to ${to}`);

  const cellsByYear = new Map();
  /** Distinct cells across all year buckets — a cell active in two years counts twice. */
  const ingestedCells = () => {
    let total = 0;
    for (const bucket of cellsByYear.values()) total += bucket.size;
    return total;
  };
  let done = 0;
  let failed = 0;
  let totalPoints = 0;
  const failures = [];
  // Per-year day tallies, so a year's sidecar can report the window it was
  // built from rather than inheriting the whole run's window.
  const daysByYear = new Map();
  const pointsByYear = new Map();

  await pooled(days, args.concurrency, async (ymd) => {
    const result = await ingestDay(ymd, cellsByYear);
    done += 1;
    const year = Number(ymd.slice(0, 4));
    daysByYear.set(year, (daysByYear.get(year) ?? 0) + 1);
    if (result.ok) {
      totalPoints += result.points;
      pointsByYear.set(year, (pointsByYear.get(year) ?? 0) + result.points);
    } else {
      failed += 1;
      failures.push({ ymd, error: result.error });
    }
    if (done % 5 === 0 || done === days.length) {
      step(
        `  ${done}/${days.length} days · ${ingestedCells().toLocaleString()} cell-years · ${failed} unavailable`,
      );
    }
  });

  if (ingestedCells() === 0) {
    throw new Error(
      'No radar hail cores were ingested. Check the date range — the MRMS archive begins 2020-10-14, and the 24-hour-maximum product is not produced for every day.',
    );
  }

  // Per-year files first: each cell carries only the statistics for the year it
  // was active in, which is the only thing a year-scoped consumer can use. A
  // cell that saw hail in 2021 and 2024 appears in both files, with 2021's peak
  // in one and 2024's in the other.
  const byYear = featuresByYear(cellsByYear);
  // The combined snapshot is then folded back out of those per-year features, so
  // it is a merge of the published partitions rather than a parallel aggregate
  // that could drift from them.
  const { kept, truncated, cellsBeforeTruncation } = selectKeptCells(
    mergeYearFeatures(byYear),
    MAX_CELLS,
  );
  const keptKeys = new Set(
    kept.map((feature) => `${feature.properties.i}:${feature.properties.j}`),
  );
  const publishedByYear = restrictYearsToKeys(byYear, keptKeys);

  const outFile = path.join(args.out, 'storm_radar_hail.geojsonl');
  const bytes = await writeGeoJsonl(outFile, kept);
  step(
    `Wrote storm_radar_hail.geojsonl — ${kept.length.toLocaleString()} cells, ${(bytes / 1e6).toFixed(1)} MB`,
  );
  if (truncated) {
    step(
      `Truncated to MAX_CELLS=${MAX_CELLS} from ${cellsBeforeTruncation.toLocaleString()}, keeping the strongest hail (highest mx first)`,
    );
  }
  step(
    `Radar hail cores ≥${HAIL_CORE_MM}mm: ${totalPoints.toLocaleString()} 1km points over ${days.length} days`,
  );
  if (failures.length) {
    const sample = failures
      .slice(0, 5)
      .map((f) => `${f.ymd} (${f.error})`)
      .join('; ');
    step(`Unavailable days: ${failures.length} — ${sample}`);
  }

  const builtAt = new Date().toISOString();
  await writeMetaJson(
    path.join(args.out, 'storm-radar-sources.json'),
    radarMeta({
      builtAt,
      window: { from, to, days: days.length },
      unavailableDays: failures,
      cellCount: kept.length,
      corePointCount: totalPoints,
      truncated,
      cellsBeforeTruncation,
    }),
  );
  step('Wrote storm-radar-sources.json');

  // Per-year partitions of the *kept* set, so the union of the year files is
  // exactly the combined snapshot and a truncation ceiling is never silently
  // bypassed by a year file. Order is already total within each year.
  for (const [year, list] of publishedByYear) {
    const gzPath = path.join(args.out, `storm_radar_hail_${year}.geojsonl.gz`);
    const gzBytes = await writeGeoJsonlGz(gzPath, list);
    const yearDays = days.filter((ymd) => ymd.slice(0, 4) === String(year));
    await writeMetaJson(
      path.join(args.out, `storm-radar-sources_${year}.json`),
      radarMeta({
        builtAt,
        window: {
          from: yearDays.length ? isoDay(yearDays[0]) : null,
          to: yearDays.length ? isoDay(yearDays[yearDays.length - 1]) : null,
          days: daysByYear.get(year) ?? yearDays.length,
        },
        unavailableDays: failures.filter(
          (f) => f.ymd.slice(0, 4) === String(year),
        ),
        cellCount: list.length,
        corePointCount: pointsByYear.get(year) ?? 0,
        // Truncation is global, not per year: MAX_CELLS bounds the combined
        // snapshot, so a year file reports the same ceiling and pre-truncation
        // count as the combined sidecar rather than an invented local one.
        truncated,
        cellsBeforeTruncation,
      }),
    );
    step(
      `Wrote storm_radar_hail_${year}.geojsonl.gz — ${list.length.toLocaleString()} cells, ${(gzBytes / 1e3).toFixed(1)} kB`,
    );
  }
  step(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `[storm-radar-etl] FAILED: ${error.stack || error.message}\n`,
    );
    process.exitCode = 1;
  });
}

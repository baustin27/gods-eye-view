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
/** Grid step of the emitted snapshot, degrees. Must match the report snapshot. */
const CELL_DEG = 0.25;
/** Guard against a pathological day materialising every CONUS cell. */
const MAX_CELLS = 40000;
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
 * Decode one MRMS daily-maximum file into per-cell statistics.
 *
 * @param {Buffer} gzipped Raw `.grib2.gz` bytes.
 * @param {string} ymd Day stamp, for the per-cell day tally.
 * @param {Map<string, object>} cells Accumulator, mutated in place.
 * @returns {{points: number, maxMm: number|null, cellsTouched: number}}
 */
export function ingestMeshGz(gzipped, ymd, cells) {
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
    if (lon < -125 || lat < 21 || lat > 56) continue;
    const key = `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;
    let cell = cells.get(key);
    if (!cell) {
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
  return { points, maxMm, cellsTouched: cells.size };
}

/**
 * Fetch one day and fold it into the accumulator.
 * @param {string} ymd
 * @param {Map<string, object>} cells
 * @returns {Promise<{ymd:string, ok:boolean, points:number, error?:string}>}
 */
async function ingestDay(ymd, cells) {
  const compact = ymd.slice(2);
  const key = `${PRODUCT}/${ymd}/MRMS_MESH_Max_1440min_00.50_${ymd}-000000.grib2.gz`;
  try {
    const body = await fetchBuffer(`${BUCKET}/${key}`);
    const result = ingestMeshGz(body, ymd, cells);
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

  const cells = new Map();
  let done = 0;
  let failed = 0;
  let totalPoints = 0;
  const failures = [];

  await pooled(days, args.concurrency, async (ymd) => {
    const result = await ingestDay(ymd, cells);
    done += 1;
    if (result.ok) totalPoints += result.points;
    else {
      failed += 1;
      failures.push({ ymd, error: result.error });
    }
    if (done % 5 === 0 || done === days.length) {
      step(
        `  ${done}/${days.length} days · ${cells.size.toLocaleString()} cells · ${failed} unavailable`,
      );
    }
  });

  if (cells.size === 0) {
    throw new Error(
      'No radar hail cores were ingested. Check the date range — the MRMS archive begins 2020-10-14, and the 24-hour-maximum product is not produced for every day.',
    );
  }

  const features = [...cells.values()].map((cell) => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [
        Math.round((cell.j * CELL_DEG + CELL_DEG / 2) * 100000) / 100000,
        Math.round((cell.i * CELL_DEG + CELL_DEG / 2) * 100000) / 100000,
      ],
    },
    properties: {
      i: cell.i,
      j: cell.j,
      d: CELL_DEG,
      mx: Math.round(cell.maxMm * 10) / 10,
      cp: cell.corePoints,
      dy: cell.days.size,
      y0: Number(cell.firstYmd.slice(0, 4)),
      y1: Number(cell.lastYmd.slice(0, 4)),
    },
  }));

  const truncated = features.length > MAX_CELLS;
  const kept = truncated ? features.slice(0, MAX_CELLS) : features;

  const outFile = path.join(args.out, 'storm_radar_hail.geojsonl');
  const bytes = await writeGeoJsonl(outFile, kept);
  step(
    `Wrote storm_radar_hail.geojsonl — ${kept.length.toLocaleString()} cells, ${(bytes / 1e6).toFixed(1)} MB`,
  );
  if (truncated) {
    step(
      `Truncated to MAX_CELLS=${MAX_CELLS} from ${features.length.toLocaleString()}`,
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

  const metaPath = path.join(args.out, 'storm-radar-sources.json');
  await fs.writeFile(
    metaPath,
    `${JSON.stringify(
      {
        version: 1,
        builtAt: new Date().toISOString(),
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
        window: { from, to, days: days.length },
        unavailableDays: failures,
        cellCount: kept.length,
        corePointCount: totalPoints,
        caveat:
          'MESH is a radar estimate and is known to over-report relative to ground reports. Treat it as evidence of where hail fell, not as an exact stone size.',
      },
      null,
      2,
    )}\n`,
  );
  step('Wrote storm-radar-sources.json');
  step(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  process.stderr.write(
    `[storm-radar-etl] FAILED: ${error.stack || error.message}\n`,
  );
  process.exitCode = 1;
});

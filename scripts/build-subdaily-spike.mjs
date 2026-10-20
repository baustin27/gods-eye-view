#!/usr/bin/env node
/**
 * build-subdaily-spike.mjs — how big would a sub-daily hail field be?
 *
 * THE QUESTION. The daily 1 km MRMS field is committed to the repository at
 * 34.6 MB for 1,019 days. A sub-daily field - the same grid, but four times a
 * day or twenty-four times a day - is what a globe timeline needs, and its
 * size is not knowable from the download size. The GRIB2 files are big; the
 * fine artifact is small because most of the grid is below the floor.
 *
 * So the number that decides this is the OUTPUT size: the number of 1 km
 * cells over the floor, summed over a day's frames, times the six bytes a
 * record takes.
 *
 * THE MEASUREMENT. For each sample day, each sub-daily frame is fetched and
 * decoded with the repository's own GRIB2 reader, and the fine cells over the
 * 19 mm floor are counted. The daily product is measured the same way, as the
 * control.
 *
 * Usage:
 *   node scripts/build-subdaily-spike.mjs [--days 2024-07-08,...] [--out <dir>]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  parseGrib2,
  parseDataRepresentation,
  parseGrid,
  decodeValues,
  indexToLonLat,
} from './lib/grib2.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUCKET = 'https://noaa-mrms-pds.s3.amazonaws.com';

const CELL_DEG_FINE = 0.01;
const DOMAIN_MIN_LAT = 21;
const DOMAIN_MAX_LAT = 56;
const DOMAIN_MIN_LON = -125;
const GRID_MAX_LON = -60;
const HAIL_RETAIN_MM_FINE = 19;
/** The product floor - one inch - which the sub-daily field may also use. */
const PRODUCT_FLOOR_MM = 25.4;
const FINE_DAY_RECORD_BYTES = 6;

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = {
    days: ['2024-07-08', '2024-06-12', '2024-05-29', '2024-08-05'],
    out: '',
    products: [
      { name: '1440min', frames: 1, hours: [0] },
      { name: '360min', frames: 4, hours: [0, 6, 12, 18] },
      { name: '60min', frames: 24, hours: Array.from({ length: 24 }, (_, i) => i) },
    ],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days') {
      out.days = String(argv[++i] ?? '')
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
    } else if (arg === '--out') out.out = String(argv[++i] ?? '').trim();
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/build-subdaily-spike.mjs [--days yyyy-mm-dd,...] [--out <dir>]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function step(message) {
  console.log(`[spike] ${message}`);
}

function inDomain(lat, lon) {
  return (
    lat >= DOMAIN_MIN_LAT &&
    lat <= DOMAIN_MAX_LAT &&
    lon >= DOMAIN_MIN_LON &&
    lon <= GRID_MAX_LON
  );
}

/**
 * The fine cells of one frame, over the floor.
 *
 * @param {Buffer} gzipped the raw `.grib2.gz`
 * @returns {{cells: number, maxMm: number}}
 */
function countFineCells(gzipped, into = null, floorMm = HAIL_RETAIN_MM_FINE) {
  const raw = zlib.gunzipSync(gzipped);
  const message = parseGrib2(raw);
  const packing = parseDataRepresentation(message.sections);
  const grid = parseGrid(message.sections, packing.numberOfValues);
  const values = decodeValues(message.sections, packing, grid);
  const cells = into || new Map();
  let maxMm = 0;
  for (let i = 0; i < values.length; i += 1) {
    const mm = values[i];
    if (!(mm >= floorMm)) continue;
    if (mm > maxMm) maxMm = mm;
    const spot = indexToLonLat(grid, i);
    if (!inDomain(spot.lat, spot.lon)) continue;
    const key = `${Math.floor(spot.lat / CELL_DEG_FINE)}:${Math.floor(
      spot.lon / CELL_DEG_FINE,
    )}`;
    const seen = cells.get(key);
    if (seen === undefined || mm > seen) cells.set(key, mm);
  }
  return { cells: cells.size, maxMm };
}

async function fetchFrame(productName, ymd, hour) {
  const product = `MESH_Max_${productName}_00.50`;
  const stamp = `${String(hour).padStart(2, '0')}0000`;
  const key = `CONUS/${product}/${ymd}/MRMS_${product}_${ymd}-${stamp}.grib2.gz`;
  const response = await fetch(`${BUCKET}/${key}`);
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  step(`days: ${args.days.join(', ')}`);
  const results = [];
  for (const day of args.days) {
    const ymd = day.replace(/-/g, '');
    for (const product of args.products) {
      let totalCells = 0;
      let frames = 0;
      let maxMm = 0;
      let bytes = 0;
      // The UNION of the frames' cells: the distinct cells the day's frames
      // touch between them. The SUM of the frames' cells is the size of a
      // per-frame artifact; the UNION is the size of a per-day one, and the
      // two are very different numbers.
      const union = new Map();
      const unionAtProduct = new Map();
      for (const hour of product.hours) {
        const body = await fetchFrame(product.name, ymd, hour);
        if (!body) continue;
        bytes += body.length;
        const { cells, maxMm: frameMax } = countFineCells(body, union);
        countFineCells(body, unionAtProduct, PRODUCT_FLOOR_MM);
        totalCells += cells;
        frames += 1;
        if (frameMax > maxMm) maxMm = frameMax;
      }
      if (!frames) {
        step(`${day} ${product.name}: no frames found`);
        continue;
      }
      const recordBytes = totalCells * FINE_DAY_RECORD_BYTES;
      results.push({
        day,
        product: product.name,
        frames,
        totalCells,
        unionCells: union.size,
        unionCellsAtProductFloor: unionAtProduct.size,
        maxMm,
        rawGzBytes: bytes,
        recordBytes,
      });
      step(
        `${day} ${product.name.padStart(7)}: ${String(frames).padStart(2)} frames, ` +
          `${String(totalCells).padStart(7)} cell records, ` +
          `${String(union.size).padStart(7)} distinct, ` +
          `${(recordBytes / 1024).toFixed(0).padStart(7)} KB of records, ` +
          `${(bytes / 1024).toFixed(0).padStart(6)} KB of GRIB2`,
      );
    }
  }

  // The projection: 1,019 days, from the sample days.
  const days = args.days.length;
  console.log('\n=== PROJECTED OVER THE 1,019-DAY WINDOW ===');
  const summary = [];
  for (const product of args.products) {
    const rows = results.filter((r) => r.product === product.name);
    if (!rows.length) continue;
    const avgCells =
      rows.reduce((sum, r) => sum + r.totalCells, 0) / rows.length;
    const avgUnion =
      rows.reduce((sum, r) => sum + r.unionCells, 0) / rows.length;
    const avgUnionProduct =
      rows.reduce((sum, r) => sum + (r.unionCellsAtProductFloor || 0), 0) /
      rows.length;
    const projectedCells = avgCells * 1019;
    const projectedBytes = projectedCells * FINE_DAY_RECORD_BYTES;
    summary.push({
      product: product.name,
      framesPerDay: rows[0].frames,
      avgCellsPerDay: Math.round(avgCells),
      avgUnionPerDay: Math.round(avgUnion),
      avgUnionAtProductFloor: Math.round(avgUnionProduct),
      projectedMBAtProductFloor:
        (Math.round(avgUnionProduct) * 1019 * FINE_DAY_RECORD_BYTES) /
        1024 /
        1024,
      projectedCells: Math.round(projectedCells),
      projectedMB: projectedBytes / 1024 / 1024,
    });
    console.log(
      `  ${product.name.padStart(7)}  ${String(rows[0].frames).padStart(2)} frames/day  ` +
        `${String(Math.round(avgCells)).padStart(7)} records/day  ` +
        `${String(Math.round(avgUnion)).padStart(7)} distinct/day  ` +
        `-> ${(projectedBytes / 1024 / 1024).toFixed(1).padStart(7)} MB over 1,019 days` +
        `  (${(Math.round(avgUnionProduct) * 1019 * FINE_DAY_RECORD_BYTES / 1024 / 1024).toFixed(1)} MB at the 1" floor)`,
    );
  }
  const daily = summary.find((s) => s.product === '1440min');
  if (daily) {
    console.log('\n=== AGAINST THE COMMITTED DAILY FIELD ===');
    for (const row of summary) {
      console.log(
        `  ${row.product.padStart(7)}  ${(row.projectedMB / daily.projectedMB).toFixed(2)}x the daily field ` +
          `(${daily.projectedMB.toFixed(1)} MB)`,
      );
    }
  }
  if (args.out) {
    const outDir = path.isAbsolute(args.out)
      ? args.out
      : path.join(ROOT, args.out);
    fs.mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, 'subdaily-spike.json');
    fs.writeFileSync(
      target,
      JSON.stringify(
        {
          note:
            'Measured, not estimated from the download size: the number of 1 km ' +
            'cells over the 19 mm floor, summed over a day of frames.',
          retainMm: HAIL_RETAIN_MM_FINE,
          recordBytes: FINE_DAY_RECORD_BYTES,
          days: args.days,
          results,
          projection: summary,
        },
        null,
        2,
      ),
    );
    step(`wrote ${path.relative(ROOT, target)}`);
  }
}

main().catch((error) => {
  console.error(`[spike] failed: ${error.message}`);
  process.exitCode = 1;
});

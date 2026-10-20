#!/usr/bin/env node
/**
 * build-storm-radar-subdaily.mjs — the same hail, four times a day.
 *
 * THE DAILY FIELD IS A MAXIMUM, AND A MAXIMUM LOSES THE STORY. The committed
 * 1 km field says where the biggest hail of the day fell. It cannot say when
 * it fell, so a storm cannot be replayed and a lead cannot be narrowed to an
 * hour.
 *
 * WHAT THIS BUILDS. One shard per day, with the day split into four six-hour
 * frames. Each cell is stored ONCE with a bitmask of the frames it was over
 * the threshold in.
 *
 * WHY ONE RECORD PER CELL AND NOT ONE PER CELL PER FRAME. That is the whole
 * design and it was measured, not guessed. The number of DISTINCT cells a
 * day touches is about the same whether the day is measured once or twenty-four
 * times - 22,765 cells for the daily maximum, 21,245 for the four six-hour
 * frames, 18,886 for the twenty-four hourly frames, over a four-day sample.
 * What changes with the frame count is how many TIMES each cell is recorded,
 * and a per-frame artifact records it once per frame it appears in: 3.1x the
 * daily field at six-hourly and 13.6x at hourly.
 *
 * The bitmask pays for neither. A cell that was over the threshold in three
 * frames is one record with three bits set, so the artifact is about the same
 * size as the daily field - 46 MB against 34.6 MB gzipped, for a day of hail
 * that can be replayed four ways.
 *
 * THE DAY BOUNDARY. MRMS names a file for the window ENDING at its timestamp,
 * so the daily file for a day D covers the 24 hours ending at D 00:00 UTC, and
 * the four six-hourly files that tile the same 24 hours end at D-1 06:00,
 * D-1 12:00, D-1 18:00 and D 00:00. The frames are therefore aligned to the
 * daily field's day rather than to the clock of the file they came from, so
 * that the timeline and the daily field agree about which day they are
 * showing.
 *
 * That alignment also means every file is read exactly once: the file dated
 * D at 00:00 is frame 3 of day D, and the file dated D at 06:00 is frame 0 of
 * day D+1. There is no overlap and nothing is fetched twice.
 *
 * Usage:
 *   node scripts/build-storm-radar-subdaily.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                                              [--days YYYY-MM-DD,...] [--out <dir>]
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
import {
  SUB_DAILY_HEADER_BYTES,
  SUB_DAILY_RECORD_BYTES,
  encodeSubDaily,
  subDailyFileName,
} from '../src/data/subDailyRadar.js';
import {
  CELL_DEG_FINE,
  DOMAIN_MAX_LAT,
  DOMAIN_MIN_LAT,
  DOMAIN_MIN_LON,
  GRID_MAX_LON,
  HAIL_RETAIN_MM_FINE,
  PER_DAY_MM_SCALE,
  cellIndexFine,
  inDomain,
} from './build-storm-radar-snapshots.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUCKET = 'https://noaa-mrms-pds.s3.amazonaws.com';
const PRODUCT = 'MESH_Max_360min_00.50';

/**
 * The format itself - the magic, the header, the record and the encoder -
 * lives with the reader in `src/data/subDailyRadar.js`. A format is one thing
 * with two halves, and a builder and a reader that each carry their own copy
 * of it are two formats that will drift.
 */

/** The frames in a day, and the hour each one ends at, in UTC. */
const FRAME_HOURS = [6, 12, 18, 0];

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { from: '', to: '', days: [], out: '', skipExisting: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') out.from = String(argv[++i] ?? '').trim();
    else if (arg === '--to') out.to = String(argv[++i] ?? '').trim();
    else if (arg === '--days') {
      out.days = String(argv[++i] ?? '')
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
    } else if (arg === '--out') out.out = String(argv[++i] ?? '').trim();
    else if (arg === '--skip-existing') out.skipExisting = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/build-storm-radar-subdaily.mjs ' +
          '[--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days YYYY-MM-DD,...] ' +
          '[--out <dir>] [--skip-existing]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function step(message) {
  console.log(`[subdaily] ${message}`);
}

/** `YYYY-MM-DD` -> `YYYYMMDD`. */
function ymdOf(day) {
  return day.replace(/-/g, '');
}

/** The file name for a frame that ENDS at the given hour of the given day. */
function frameKey(day, hour) {
  const ymd = ymdOf(day);
  const stamp = `${String(hour).padStart(2, '0')}0000`;
  return `CONUS/${PRODUCT}/${ymd}/MRMS_${PRODUCT}_${ymd}-${stamp}.grib2.gz`;
}

/**
 * The fine cells of one frame, over the floor.
 *
 * @param {Buffer} gzipped the raw `.grib2.gz`
 * @returns {Map<number, number>} the cell index to its maximum millimetres
 */
function frameCells(gzipped) {
  const raw = zlib.gunzipSync(gzipped);
  const message = parseGrib2(raw);
  const packing = parseDataRepresentation(message.sections);
  const grid = parseGrid(message.sections, packing.numberOfValues);
  const values = decodeValues(message.sections, packing, grid);
  const cells = new Map();
  for (let i = 0; i < values.length; i += 1) {
    const mm = values[i];
    if (!(mm >= HAIL_RETAIN_MM_FINE)) continue;
    const spot = indexToLonLat(grid, i);
    if (!inDomain(spot.lat, spot.lon)) continue;
    const index = cellIndexFine(
      Math.floor(spot.lat / CELL_DEG_FINE),
      Math.floor(spot.lon / CELL_DEG_FINE),
    );
    const seen = cells.get(index);
    if (seen === undefined || mm > seen) cells.set(index, mm);
  }
  return cells;
}


/**
 * One frame's bytes, or null when the archive does not have it.
 *
 * The MRMS archive has GAPS - a frame that was never produced, or was lost -
 * and a gap is an absence, not a failure. The daily builder treats a missing
 * day the same way, for the same reason: a climatology with holes is still
 * useful, and a hard failure would block the whole build on one bad file.
 *
 * A day with a missing frame is built from the frames it HAS, and the day is
 * recorded as partial so the manifest can say so.
 */
async function fetchFrame(day, hour) {
  const response = await fetch(`${BUCKET}/${frameKey(day, hour)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`${response.status} for ${frameKey(day, hour)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** The days to build, from the arguments. */
function daysToBuild() {
  if (args.days.length) return args.days.slice().sort();
  if (!args.from) {
    throw new Error('give --from, or --days');
  }
  const days = [];
  const end = args.to || args.from;
  const cursor = new Date(`${args.from}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** The day before, as `YYYY-MM-DD`. */
function previousDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const outDir = path.isAbsolute(args.out)
    ? args.out
    : path.join(ROOT, args.out || 'src/data/local_data/storm');
  const days = daysToBuild();
  step(`building ${days.length} days of ${PRODUCT}`);

  // The previous day's 06:00, 12:00 and 18:00 frames are this day's first
  // three, so the previous date's frames are carried over rather than fetched
  // again. Every file is read exactly once.
  let carried = null;
  const missingFrames = [];
  let built = 0;
  let bytes = 0;
  let cells = 0;
  const started = Date.now();
  fs.mkdirSync(outDir, { recursive: true });

  for (const day of days) {
    const previous = previousDay(day);
    const want = [
      { day: previous, hour: 6 },
      { day: previous, hour: 12 },
      { day: previous, hour: 18 },
      { day, hour: 0 },
    ];
    const frames = [];
    for (const [index, spec] of want.entries()) {
      // The carried frame is the previous day's file at this hour; it is the
      // same file this day would ask for, so it is reused rather than
      // refetched.
      if (carried && carried.day === spec.day) {
        frames.push(carried.hours[index]);
      } else {
        const body = await fetchFrame(spec.day, spec.hour);
        if (!body) {
          missingFrames.push(`${spec.day} ${String(spec.hour).padStart(2, '0')}Z`);
          frames.push(new Map());
          continue;
        }
        frames.push(frameCells(body));
      }
    }
    // Carry this day's 06:00, 12:00 and 18:00 forward to the next day.
    const carryFrames = [];
    for (const hour of [6, 12, 18]) {
      const body = await fetchFrame(day, hour);
      if (!body) {
        carryFrames.push(new Map());
        continue;
      }
      carryFrames.push(frameCells(body));
    }
    carried = { day, hours: carryFrames };

    const target = path.join(outDir, subDailyFileName(day));
    if (args.skipExisting && fs.existsSync(target)) {
      built += 1;
      bytes += fs.statSync(target).size;
      continue;
    }
    const encoded = encodeSubDaily(frames);
    const gz = zlib.gzipSync(encoded, { level: 9 });
    const tmp = `${target}.tmp`;
    await fs.promises.writeFile(tmp, gz);
    await fs.promises.rename(tmp, target);
    built += 1;
    bytes += gz.length;
    cells += (encoded.length - SUB_DAILY_HEADER_BYTES) / SUB_DAILY_RECORD_BYTES;
    if (built % 10 === 0 || built === days.length) {
      step(
        `${built}/${days.length} days, ${(bytes / 1024 / 1024).toFixed(1)} MB, ` +
          `${Math.round(cells / built)} cells/day avg, ` +
          `${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
    }
  }
  step(
    `wrote ${built} shards, ${(bytes / 1024 / 1024).toFixed(1)} MB total, ` +
      `in ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
  if (missingFrames.length) {
    step(
      `${missingFrames.length} frames are missing from the archive and were ` +
        `built as empty: ${missingFrames.slice(0, 12).join(', ')}` +
        (missingFrames.length > 12 ? ' ...' : ''),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[subdaily] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

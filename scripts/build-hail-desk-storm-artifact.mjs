#!/usr/bin/env node
/**
 * build-hail-desk-storm-artifact.mjs — one storm, as a picture.
 *
 * WHAT THIS IS. The thing the competitors sell. HailTrace charges $229 for
 * one storm in one state; Hail Recon charges $1,999 a year for the same
 * thing. What they sell is a PICTURE of a swath with a count of the affected
 * structures on it — and this is that picture, drawn from the data rather than
 * from a raster somebody prepared, with its sources printed on it.
 *
 * WHY A HEADLESS BROWSER. The picture is an SVG, and an SVG is not a PNG. A
 * rasteriser would be a new dependency and a new failure mode; a browser is
 * already here, it is what the gallery is drawn in, and it renders the SAME
 * SVG the gallery shows - so the picture that goes out and the picture that
 * was approved are the same picture, because they are the same code.
 *
 * Usage:
 *   node scripts/build-hail-desk-storm-artifact.mjs --day 2025-07-07
 *   node scripts/build-hail-desk-storm-artifact.mjs --day 2025-07-07 --state CO
 *   node scripts/build-hail-desk-storm-artifact.mjs --top 5
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { indexFineDay } from '../src/data/stormReports.js';
import { stormArtwork } from '../src/data/stormArtwork.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STORM_DIR = path.join(ROOT, 'src/data/local_data/storm');
const DESK_DATA = path.join(ROOT, 'apps/hail-desk/public/data');

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { day: '', state: '', top: 1, out: 'apps/hail-desk/public/artifacts' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--day') out.day = String(argv[++i] || '').trim();
    else if (arg === '--state') out.state = String(argv[++i] || '').trim().toUpperCase();
    else if (arg === '--top') out.top = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--out') out.out = String(argv[++i] || '').trim();
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/build-hail-desk-storm-artifact.mjs --day YYYY-MM-DD [--state CO] [--top N] [--out <dir>]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.day) throw new Error('give --day');
  return out;
}

function step(message) {
  console.log(`[artifact] ${message}`);
}

function readGzipJson(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

/**
 * The places a storm reached, with the houses in them.
 *
 * The swaths artifact is the join of the radar field with the tracts and the
 * Census house counts, so it already knows. The places artifact has the
 * names and - since the map work - the centres.
 */
function placesForDay(day, state) {
  const swaths = readGzipJson(path.join(DESK_DATA, 'swaths.json.gz'));
  const cities = readGzipJson(path.join(DESK_DATA, 'cities.json.gz'));
  const byGeoid = new Map((cities.cities || []).map((city) => [city.id, city]));
  const rows = (swaths.rows || []).filter(
    (row) => row.d === day && (!state || byGeoid.get(row.k)?.st === state),
  );
  const byPlace = new Map();
  for (const row of rows) {
    let entry = byPlace.get(row.k);
    if (!entry) {
      const city = byGeoid.get(row.k);
      if (!city) continue;
      entry = {
        name: city.name,
        st: city.st,
        lat: city.lat,
        lon: city.lon,
        houses: 0,
        tracts: 0,
        maxMm: 0,
      };
      byPlace.set(row.k, entry);
    }
    entry.houses += row.u || 0;
    entry.tracts += 1;
    if ((row.m || 0) > entry.maxMm) entry.maxMm = row.m || 0;
  }
  return [...byPlace.values()].sort((a, b) => b.houses - a.houses);
}

async function main() {
  const shard = path.join(
    STORM_DIR,
    `storm_radar_hail_fine_${args.day}.bin.gz`,
  );
  if (!fs.existsSync(shard)) {
    throw new Error(`there is no fine field for ${args.day}`);
  }
  const bytes = new Uint8Array(zlib.gunzipSync(fs.readFileSync(shard)));
  const { cells } = indexFineDay(bytes);
  if (!cells.length) throw new Error(`${args.day} has no hail over the floor`);
  const maxMm = cells.reduce((max, cell) => Math.max(max, cell.maxMm), 0);
  step(`${args.day}: ${cells.length.toLocaleString()} cells, max ${maxMm.toFixed(1)} mm`);

  const places = placesForDay(args.day, args.state);
  step(
    `places: ${places.length}, ${places
      .reduce((total, place) => total + place.houses, 0)
      .toLocaleString()} houses`,
  );

  const svg = stormArtwork({ cells, day: args.day, places, maxMm });

  const puppeteer = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 820, deviceScaleFactor: 2 });
  await page.setContent(
    `<body style="margin:0;background:#0a0e13">${svg}</body>`,
    { waitUntil: 'load' },
  );
  const outDir = path.isAbsolute(args.out)
    ? args.out
    : path.join(ROOT, args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, `${args.day}.png`);
  await page.screenshot({ path: target });
  await browser.close();
  step(
    `wrote ${path.relative(ROOT, target)} — ${(
      fs.statSync(target).size / 1024
    ).toFixed(0)} KB`,
  );
}

main().catch((error) => {
  console.error(`[artifact] failed: ${error.message}`);
  process.exitCode = 1;
});

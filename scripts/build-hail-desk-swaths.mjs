#!/usr/bin/env node
/**
 * build-hail-desk-swaths.mjs — how many roofs were under the hail.
 *
 * The market view says a town was hit. The number a canvasser works from is
 * how many HOUSES were under the hail, and that is a join of two things that
 * are both already here:
 *
 *   - WHERE. The 1 km MRMS MESH field, one shard per calendar day. It is
 *     sound about where hail fell and unsound about how big each stone was.
 *   - HOW MANY. Census tracts, with the ACS 5-year housing count for each
 *     tract, B25001, with its margin of error.
 *
 * Laying the 1 km field over the tracts is the only way to get this honestly.
 * At county level the radar grid is 28 by 21 kilometres and three quarters of
 * US counties are two to four cells wide, so a county-level "houses hit" is a
 * county total with a decimal point on it. At tract level the radar cell is
 * smaller than the tract, and the number is a number of doors.
 *
 * Each radar cell is sampled at its CENTRE and its four CORNERS, so a cell on a
 * tract boundary splits instead of giving all of its hail to one side.
 *
 * The result is a work-list number, and it is labelled as one: a tract the
 * radar reached is a tract to work, and every house in it is a candidate. The
 * radar cannot say the hail fell on that particular roof, and neither can
 * anything else in public data.
 *
 * Output:
 *   <out>/swaths.json.gz   one row per (day, tract): the city it is in, the
 *                           largest reading, and the housing units inside it
 *
 * Usage:
 *   node scripts/build-hail-desk-swaths.mjs [--out <dir>] [--threshold 25.4]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { indexTracts, tractsReached } from '../src/data/tractHail.js';
import { decodeRing, pointInRing } from '../src/data/adminBoundaries.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { out: 'apps/hail-desk/public/data', threshold: 25.4 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out.out = String(argv[++i] ?? '').trim();
    else if (arg === '--threshold') out.threshold = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/build-hail-desk-swaths.mjs [--out <dir>] [--threshold 25.4]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function step(message) {
  console.log(`[swaths] ${message}`);
}

/**
 * A grid index over the PLACE boundaries, so a tract can be placed in its
 * city without testing 32,607 polygons.
 */
function indexPlaces(features, decimals) {
  const grid = new Map();
  for (const feature of features) {
    const rings = (feature.polygons || []).map((polygon) =>
      polygon.map((ring) => decodeRing(ring, feature.d ?? decimals)),
    );
    if (!rings.length) continue;
    let minLat = Infinity;
    let minLon = Infinity;
    let maxLat = -Infinity;
    let maxLon = -Infinity;
    for (const polygon of rings) {
      for (const ring of polygon) {
        for (const [lon, lat] of ring) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
    }
    const entry = { geoid: feature.geoid, rings, minLat, minLon, maxLat, maxLon };
    for (let lat = Math.floor(minLat); lat <= Math.floor(maxLat); lat += 1) {
      for (let lon = Math.floor(minLon); lon <= Math.floor(maxLon); lon += 1) {
        const key = `${lat}:${lon}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(entry);
      }
    }
  }
  return grid;
}

/** The place containing this point, or null. */
function placeAt(grid, lat, lon) {
  const candidates = grid.get(`${Math.floor(lat)}:${Math.floor(lon)}`);
  if (!candidates) return null;
  for (const place of candidates) {
    if (lat < place.minLat || lat > place.maxLat) continue;
    if (lon < place.minLon || lon > place.maxLon) continue;
    for (const polygon of place.rings) {
      const [outer, ...holes] = polygon;
      if (!pointInRing(outer, lat, lon)) continue;
      if (holes.some((hole) => pointInRing(hole, lat, lon))) continue;
      return place.geoid;
    }
  }
  return null;
}

function readGzippedJson(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

async function main() {
  const outDir = path.isAbsolute(args.out)
    ? args.out
    : path.join(ROOT, args.out);
  const threshold = args.threshold;

  step('reading the tracts');
  const tractPack = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'src/data/local_data/us_census_tracts/tracts.json'),
      'utf8',
    ),
  );
  const tractIndex = indexTracts(tractPack.features, tractPack.meta.decimals);
  step(`tracts: ${tractIndex.byGeoid.size}`);

  step('reading the places');
  const placePack = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'src/data/local_data/us_census_places/places.json'),
      'utf8',
    ),
  );
  const placeGrid = indexPlaces(placePack.features, placePack.meta.decimals);
  step(`places: ${placeGrid.size} grid cells`);

  step('reading the housing units');
  const housing = readGzippedJson(
    path.join(
      ROOT,
      'src/data/local_data/housing_units/housing_units_tract.json.gz',
    ),
  );
  const units = new Map(housing.rows.map((row) => [row.id, row.units]));
  step(`tracts with a housing count: ${units.size}`);

  // The tract -> city map, once. A tract's CENTRE decides: a tract that
  // straddles a city line belongs to the city it mostly sits in, which is the
  // city a canvasser would knock in.
  step('placing the tracts in their cities');
  const tractCity = new Map();
  for (const [geoid, tract] of tractIndex.byGeoid) {
    const ring = tract.rings[0]?.[0];
    if (!ring || !ring.length) continue;
    let sumLat = 0;
    let sumLon = 0;
    for (const [lon, lat] of ring) {
      sumLon += lon;
      sumLat += lat;
    }
    const city = placeAt(placeGrid, sumLat / ring.length, sumLon / ring.length);
    if (city) tractCity.set(geoid, city);
  }
  step(`tracts placed in a city: ${tractCity.size}`);

  const stormDir = path.join(ROOT, 'src/data/local_data/storm');
  const shards = fs
    .readdirSync(stormDir)
    .filter((name) => /^storm_radar_hail_fine_\d{4}-\d{2}-\d{2}\.bin\.gz$/.test(name))
    .sort();

  const rows = [];
  let daysWithHail = 0;
  const started = Date.now();
  for (const [index, shard] of shards.entries()) {
    const day = shard.slice('storm_radar_hail_fine_'.length, -'.bin.gz'.length);
    const buf = zlib.gunzipSync(fs.readFileSync(path.join(stormDir, shard)));
    const cells = [];
    for (let at = 4; at + 6 <= buf.length; at += 6) {
      const cellIndex = buf.readUInt32LE(at);
      cells.push({
        i: Math.floor(cellIndex / 6500) + 2100,
        j: (cellIndex % 6500) - 12500,
        maxMm: buf.readUInt16LE(at + 4) / 10,
      });
    }
    const hit = tractsReached(tractIndex, cells, {
      thresholdMm: threshold,
      stepDeg: 0.01,
    });
    if (hit.size) daysWithHail += 1;
    for (const tract of hit.values()) {
      const city = tractCity.get(tract.geoid);
      if (!city) continue;
      rows.push({
        g: tract.geoid,
        k: city,
        d: day,
        m: Math.round(tract.maxMm * 10) / 10,
        c: tract.cells,
        u: units.get(tract.geoid) ?? 0,
      });
    }
    if ((index + 1) % 100 === 0) {
      step(
        `${index + 1}/${shards.length} days, ${rows.length} rows, ` +
          `${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
    }
  }
  rows.sort((a, b) => a.d.localeCompare(b.d) || a.g.localeCompare(b.g));
  step(`rows: ${rows.length} over ${daysWithHail} days with hail`);

  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'swaths.json.gz');
  const json = JSON.stringify({
    meta: {
      title: "God's Eye View - Hail Desk swaths",
      source:
        'NOAA/NSSL MRMS MESH 1 km (2024-01-01 onward) over Census tracts, ' +
        'with ACS 5-year B25001 housing units',
      license:
        'US Government public domain (NOAA, US Census Bureau); ACS subject to ' +
        'the Census citation terms',
      builtAt: new Date().toISOString(),
      thresholdMm: threshold,
      stepDeg: 0.01,
      rows: rows.length,
      daysWithHail,
      note:
        'One row per (day, tract) the radar reached. `u` is the housing units ' +
        'in that tract, `m` the largest radar reading in it, `c` the number of ' +
        '1 km cells of it that were reached, and `k` the city it sits in. A ' +
        'tract the radar reached is a tract to work and every house in it is a ' +
        'candidate: the radar is sound about WHERE hail fell and unsound about ' +
        'how big each stone was.',
    },
    rows,
  });
  fs.writeFileSync(target, zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }));
  step(
    `wrote ${path.relative(ROOT, target)} — ` +
      `${(fs.statSync(target).size / 1024).toFixed(0)} KB`,
  );
}

main().catch((error) => {
  console.error(`[swaths] failed: ${error.message}`);
  process.exitCode = 1;
});

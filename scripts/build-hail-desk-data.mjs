#!/usr/bin/env node
/**
 * build-hail-desk-data.mjs — the compact dataset the Hail Desk reads.
 *
 * WHY A SECOND ARTIFACT. The storm dataset is 78 MB of GeoJSONL and custom
 * binaries, and the globe is built to stream it. A table does not need a
 * globe's data: it needs three,234 counties, their attributes, and their
 * housing units. Shipping 15 MB of cells, events and polygons to render a
 * sortable table is a cost with no return, and it is the reason a business
 * tool bolted onto the globe app would be slow before it was useful.
 *
 * So this builds the slice the desk actually reads, out of the SAME source
 * files, with the SAME decoders, so there is one set of facts and one place
 * they come from. The scoring is NOT copied: the desk imports the shared
 * `stormScoring.js` and computes at query time, exactly as the globe does. This
 * artifact carries facts, not conclusions.
 *
 * THE DECADE HISTOGRAM IS THE TIME SERIES. Each county carries counts per
 * decade, and the shared core's `windowCellCounts` apportions them across a
 * year window. That is why the histogram is shipped rather than a pre-sliced
 * per-year table: one small field lets the desk answer ANY year window, and
 * the apportionment rule lives in one place instead of two.
 *
 * Output:
 *   <out>/counties.json.gz     county facts + housing units, one array
 *   <out>/desk-sources.json     provenance and counts
 *
 * The output lands in `public/` so the bundler copies it VERBATIM. A .gz in
 * the source tree is a thing the bundler wants to transform, and the one
 * transform it would apply is to make it not-a-.gz.
 *
 * Usage:
 *   node scripts/build-hail-desk-data.mjs [--out <dir>] [--states 08,20]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { parseGeoJsonLines } from '../src/data/stormDatasets.js';
import { decodeRing, pointInRing } from '../src/data/adminBoundaries.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The county snapshot the desk's rows come from. */
const COUNTIES_URL = new URL(
  '../src/data/local_data/storm/storm_counties.geojsonl',
  import.meta.url,
);

/**
 * The Census PLACE boundaries: cities, towns, villages and CDPs.
 *
 * A canvasser works in a town, not a county, so the desk's row unit is a
 * place. The GEOID is the seven-digit state+place FIPS, which is exactly the
 * key the ACS housing-unit artifact uses, so a place joins to its housing
 * count with no crosswalk.
 */
const PLACES_PACK = path.join(
  ROOT,
  'src/data/local_data/us_census_places/places.json',
);

/** The report artifacts, one per year. */
const REPORT_FILES = [2021, 2022, 2023, 2024, 2025, 2026];

/** The size bands a desk row counts. The thresholds are the ones the industry
 *  uses: an inch is cosmetic, an inch and a half is a repair, two inches is a
 *  replacement, and three is a catastrophe. */
const HAIL_BANDS = Object.freeze([
  { key: 'n1', min: 1 },
  { key: 'n15', min: 1.5 },
  { key: 'n2', min: 2 },
  { key: 'n3', min: 3 },
]);

/** The housing-unit artifact the desk joins to. */
const HOUSING_DIR = path.join(ROOT, 'src/data/local_data/housing_units');

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { out: 'apps/hail-desk/public/data', states: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out.out = String(argv[++i] ?? '').trim();
    else if (arg === '--states') {
      out.states = String(argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/build-hail-desk-data.mjs [--out <dir>] [--states 08,20]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function step(message) {
  console.log(`[hail-desk] ${message}`);
}

/**
 * The housing-unit counts, keyed by county FIPS.
 *
 * The county FIPS the Census publishes is five digits, and the storm dataset
 * keys counties by the same five digits, so the join is a straight map. The
 * margin of error comes along: it is a property of the estimate, and dropping
 * it at the join would drop it forever.
 */
function readHousingUnits() {
  const file = path.join(HOUSING_DIR, 'housing_units_county.json.gz');
  if (!fs.existsSync(file)) {
    throw new Error(
      `${file} is missing. Run "npm run build:housing-units" first - the desk's ` +
        'housing-unit column comes from there.',
    );
  }
  const payload = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'),
  );
  const byFips = new Map();
  for (const row of payload.rows || []) {
    byFips.set(String(row.id), {
      units: row.units,
      moe: row.moe ?? null,
    });
  }
  // The place table is a different artifact from the county one, and the
  // places are keyed by the SAME seven-digit FIPS the TIGER boundaries use.
  let byPlace = new Map();
  const placeFile = path.join(HOUSING_DIR, 'housing_units_place.json.gz');
  if (fs.existsSync(placeFile)) {
    const places = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(placeFile)).toString('utf8'),
    );
    byPlace = new Map(
      (places.rows || []).map((row) => [
        String(row.id),
        {
          units: row.units,
          moe: row.moe ?? null,
          population: row.population ?? null,
        },
      ]),
    );
  }
  return { byFips, byPlace, meta: payload.meta };
}

/**
 * The county facts the desk needs, carried in the SHORT keys the shared core
 * reads.
 *
 * The snapshot's own properties are already in those keys, so they are carried
 * VERBATIM rather than decoded and re-encoded. Two things fall out of that:
 * the `ye` per-year tallies stay a flat array - which survives JSON, where the
 * decoded Map would not - and the decoding rule stays in one place, in the
 * shared core, instead of being reimplemented here.
 *
 * The geometry is deliberately dropped. The desk's first market is a table,
 * and a county polygon is 25 KB of the county's bytes; shipping 3,234 of them
 * would multiply the artifact by an order of magnitude for a shape nothing
 * draws yet. The map, when it comes, will load boundaries on its own.
 */
function toDeskRow(properties, housing) {
  const row = { ...properties };
  row.units = housing?.units ?? null;
  row.umoe = housing?.moe ?? null;
  return row;
}

/**
 * A grid index over the place boundaries.
 *
 * 155,738 reports against 32,607 places is five billion pair tests, which is
 * not a build. The index buckets places by the one-degree cells their
 * BOUNDING BOX touches - so a place is listed in every cell its box covers, and
 * a report only ever tests the places in its own cell. A city is smaller than
 * a degree almost everywhere, so a cell holds a handful of candidates.
 */
function indexPlaces(features) {
  const grid = new Map();
  for (const feature of features) {
    const rings = feature.rings;
    if (!rings.length) continue;
    let minLat = Infinity;
    let minLon = Infinity;
    let maxLat = -Infinity;
    let maxLon = -Infinity;
    // THREE levels: rings is a list of POLYGONS, a polygon is a list of RINGS,
    // and a ring is a list of [lon, lat] pairs. Iterating one level too few
    // compares an ARRAY against a number, every comparison is false, and the
    // bounding box stays Infinity - which makes the grid silently empty rather
    // than wrong, and placed zero reports without an error.
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

/**
 * The desk's CITY rows: one per place, with the hail that actually fell in it.
 *
 * This is the whole difference between the desk being a browser of a model and
 * a market view. The county table answered "what does the model think of this
 * county, averaged over seventy years"; this answers "how many stones fell in
 * this town, how big, and when".
 */
async function buildCities() {
  if (!fs.existsSync(PLACES_PACK)) {
    throw new Error(
      `${PLACES_PACK} is missing. Run "node scripts/build-admin-packs.mjs --only census-places" first.`,
    );
  }
  step('reading the place boundaries');
  const pack = JSON.parse(fs.readFileSync(PLACES_PACK, 'utf8'));
  const decimals = pack.meta?.decimals ?? 4;
  const features = pack.features
    .map((feature) => ({
      geoid: feature.geoid,
      name: feature.name,
      full: feature.full,
      st: feature.st,
      state: feature.state,
      rings: feature.polygons.map((polygon) =>
        polygon.map((ring) => decodeRing(ring, feature.d ?? decimals)),
      ),
    }))
    .filter((feature) => feature.rings.length);
  step(`places: ${features.length}`);

  const grid = indexPlaces(features);

  step('reading the reports');
  const byPlaceYear = new Map();
  let read = 0;
  let placed = 0;
  for (const year of REPORT_FILES) {
    const file = path.join(
      ROOT,
      'src/data/local_data/storm',
      `storm_reports_${year}.json.gz`,
    );
    if (!fs.existsSync(file)) continue;
    const payload = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'),
    );
    for (const report of payload.reports || []) {
      read += 1;
      const [date, , hazard, size, lat, lon] = report;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const geoid = placeAt(grid, lat, lon);
      if (!geoid) continue;
      placed += 1;
      const yearKey = String(date).slice(0, 4);
      const key = `${geoid}:${yearKey}`;
      let row = byPlaceYear.get(key);
      if (!row) {
        row = {
          geoid,
          y: Number(yearKey),
          n: 0,
          n1: 0,
          n15: 0,
          n2: 0,
          n3: 0,
          max: 0,
          wind: 0,
          wmax: 0,
          loss: 0,
        };
        byPlaceYear.set(key, row);
      }
      if (hazard === 0) {
        row.n += 1;
        for (const band of HAIL_BANDS) if (size >= band.min) row[band.key] += 1;
        if (size > row.max) row.max = size;
        row.loss += Number(report[9]) || 0;
      } else {
        row.wind += 1;
        if (size > row.wmax) row.wmax = size;
      }
    }
  }
  step(`reports: ${read.toLocaleString()} read, ${placed.toLocaleString()} placed in a place`);

  const housing = readHousingUnits();
  const cityRows = features.map((feature) => {
    const units = housing.byPlace.get(feature.geoid);
    return {
      id: feature.geoid,
      name: feature.name,
      full: feature.full,
      st: feature.st,
      state: feature.state,
      units: units?.units ?? null,
      umoe: units?.moe ?? null,
      pop: units?.population ?? null,
    };
  });
  cityRows.sort((a, b) => a.id.localeCompare(b.id));

  const yearRows = [...byPlaceYear.values()].sort(
    (a, b) => a.geoid.localeCompare(b.geoid) || a.y - b.y,
  );
  step(
    `city rows: ${cityRows.length}; place-years: ${yearRows.length}`,
  );
  return { cities: cityRows, cityYears: yearRows };
}

function writeGzipJson(target, payload) {
  const temp = `${target}.tmp`;
  fs.writeFileSync(
    temp,
    zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 }),
  );
  fs.renameSync(temp, target);
  return fs.statSync(target).size;
}

async function main() {
  const outDir = path.isAbsolute(args.out)
    ? args.out
    : path.join(ROOT, args.out);
  step(`out=${args.out}`);

  step('reading the county snapshot');
  const text = fs.readFileSync(COUNTIES_URL, 'utf8');
  const parsed = parseGeoJsonLines(text);
  const records = parsed.features
    .map((feature) => feature?.properties)
    .filter(Boolean);
  step(`counties: ${records.length} (${parsed.skipped || 0} skipped)`);

  step('reading the housing units');
  const housing = readHousingUnits();
  step(`housing units: ${housing.byFips.size} counties`);

  const wanted = args.states ? new Set(args.states) : null;
  const rows = records
    .filter((record) => !wanted || wanted.has(String(record.state)))
    .map((record) => toDeskRow(record, housing.byFips.get(String(record.fips))));

  const withHousing = rows.filter((row) => row.units !== null).length;
  step(
    `rows: ${rows.length} (${withHousing} with housing units, ` +
      `${rows.length - withHousing} without)`,
  );

  if (wanted) {
    for (const state of wanted) {
      const count = rows.filter((row) => row.st === state).length;
      if (!count) {
        throw new Error(
          `no counties for state ${state} - the state column holds a POSTAL code, not an FIPS`,
        );
      }
    }
  }

  const out = {
    meta: {
      title: "God's Eye View - Hail Desk county market",
      source: 'storm_counties.geojsonl (SPC + FEMA NRI) joined to ACS B25001',
      license:
        'US Government public domain (SPC, Census) and FEMA NRI (see DATA_SOURCES.md)',
      builtAt: new Date().toISOString(),
      housingVintage: housing.meta?.vintage ?? null,
      housingVariable: housing.meta?.variable ?? null,
      rows: rows.length,
      note:
        'Short keys, as the shared storm core reads them. The decade ' +
        'histogram (dc) is the time series: the shared core apportions it ' +
        'across a year window. Geometry is not here; this is a table.',
    },
    rows,
  };

  const { cities, cityYears } = await buildCities();

  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'counties.json.gz');
  const bytes = writeGzipJson(target, out);
  step(`wrote ${path.relative(ROOT, target)} — ${(bytes / 1024).toFixed(0)} KB`);

  const cityTarget = path.join(outDir, 'cities.json.gz');
  const cityBytes = writeGzipJson(cityTarget, {
    meta: {
      ...out.meta,
      title: "God's Eye View - Hail Desk city market",
      rows: cities.length,
      note:
        'One row per Census PLACE - city, town, village or CDP - with the ' +
        'hail that actually fell in it, per year. The year rows are the ' +
        'OBSERVED reports, not a model.',
    },
    cities,
    cityYears,
  });
  step(`wrote ${path.relative(ROOT, cityTarget)} — ${(cityBytes / 1024).toFixed(0)} KB`);

  const manifest = {
    title: out.meta.title,
    builtAt: out.meta.builtAt,
    artifacts: {
      'counties.json.gz': {
        bytes,
        rawBytes: fs.statSync(target).size,
        rows: rows.length,
      },
      'cities.json.gz': {
        bytes: cityBytes,
        rows: cities.length,
        placeYears: cityYears.length,
      },
    },
    housing: {
      vintage: housing.meta?.vintage ?? null,
      variable: housing.meta?.variable ?? null,
      countiesWithUnits: withHousing,
    },
  };
  fs.writeFileSync(
    path.join(outDir, 'desk-sources.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  step('done');
}

main().catch((error) => {
  console.error(`[hail-desk] failed: ${error.message}`);
  process.exitCode = 1;
});

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

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The county snapshot the desk's rows come from. */
const COUNTIES_URL = new URL(
  '../src/data/local_data/storm/storm_counties.geojsonl',
  import.meta.url,
);

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
  return { byFips, meta: payload.meta };
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

  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'counties.json.gz');
  const bytes = writeGzipJson(target, out);
  step(`wrote ${path.relative(ROOT, target)} — ${(bytes / 1024).toFixed(0)} KB`);

  const manifest = {
    title: out.meta.title,
    builtAt: out.meta.builtAt,
    artifacts: {
      'counties.json.gz': {
        bytes,
        rawBytes: fs.statSync(target).size,
        rows: rows.length,
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

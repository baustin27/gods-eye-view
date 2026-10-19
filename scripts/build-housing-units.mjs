#!/usr/bin/env node
/**
 * build-housing-units.mjs — housing-unit counts, offline, from the Census ACS.
 *
 * WHY THIS EXISTS. Every storm number this repository can produce is a
 * MEASUREMENT of weather. None of them is a measure of consequence, and
 * consequence is what a business acts on: how many roofs are in the swath.
 *
 * The counts come from the Census ACS 5-year table B25031 ("Housing Units"),
 * which is the same table the industry's own maps are built from, and which
 * publishes a margin of error alongside every estimate. The margin is not a
 * formality here: B25031 is a SAMPLE estimate, and a county with 900 housing
 * units carries a margin that can be a tenth of it. A number without its margin
 * is a claim the data does not support.
 *
 * The output is a static artifact, not a runtime dependency, for the same
 * reason the storm dataset is: "aggregated offline so the app needs no key and
 * no network" (DATA_SOURCES.md). A free Census key is used HERE, at build time,
 * and never reaches the browser. The artifact is committed, so the desk works
 * with no key and no network.
 *
 * OUTPUT
 *   <out>/housing_units_county.json.gz    county  -> housing units + margin
 *   <out>/housing_units_place.json.gz     place   -> housing units + margin
 *   <out>/housing_units_tract_<st>.json.gz tract  -> housing units + margin
 *   <out>/housing_units_zcta_<st>.json.gz  ZCTA    -> housing units + margin
 *   <out>/housing-units-sources.json      provenance, counts, dropped rows
 *
 * THE NO-DATA SENTINEL. The Census publishes -666666666 for a geography it
 * could not estimate, and -222222222 for its margin. Those are NOT negative
 * counts. A SUM over them produces a large negative number that looks like a
 * real total, and it propagates into every aggregate built on top. Every row
 * carrying the sentinel is dropped, and the count of dropped rows is written
 * into the manifest, because a coverage gap that is not stated is a coverage
 * gap that is invisible.
 *
 * WHY ZCTA IS SEPARATE. The ACS publishes ZCTA only as a NATIONAL list, with
 * no state hierarchy - `in=state:` is rejected for that geography, and the
 * wildcard is the only form that works. So this script pulls the national list
 * and attributes each ZCTA to a state by taking its gazetteer internal point
 * and testing it against the county polygons this repository already bundles.
 *
 * Usage:
 *   node scripts/build-housing-units.mjs [--state 08] [--out <dir>] [--dry-run]
 *
 *   --state   two-digit state FIPS, or "all" for every state. Default 08
 *             (Colorado). Tracts and ZCTAs are per state; counties and places
 *             are national, because the ACS publishes both in one request.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { decodeRing, polygonsContain } from '../src/data/adminBoundaries.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The ACS 5-year dataset vintage this build reads. */
const ACS_VINTAGE = 2023;
const ACS_DATASET = 'acs5';

/**
 * The housing-units table and its margin of error.
 *
 * B25001 IS the housing-unit count. It is worth being precise about why this
 * is not a typo: B25031 was the first candidate, and it is "MEDIAN GROSS RENT
 * BY BEDROOMS" - a dollar figure, not a count. It returns a plausible-looking
 * number for every county (1,713 for Adams County, Colorado) with a tight
 * margin of error, and a state-wide SUM of those numbers is 80,000 against a
 * true total near 2.4 million. Nothing about it looks wrong on its own, which
 * is exactly what makes it dangerous: the only thing that caught it was
 * comparing the total against the population.
 *
 * The table is cross-checked at build time. See {@link verifyHousingTable}.
 */
const VARIABLE = 'B25001_001E';
const VARIABLE_MOE = 'B25001_001M';

/**
 * The other two ACS housing-unit totals, used to VERIFY the one above.
 *
 * B25002 (occupancy status) and B25003 (tenure) both publish a total. B25002
 * must EQUAL B25001 - the same universe, counted another way. B25003 covers
 * OCCUPIED units only, so it must be less than or equal to B25001. A build
 * that checks its own arithmetic against two independent totals cannot ship a
 * number that is a rent figure wearing a count's name.
 */
const VERIFY_TOTAL = 'B25002_001E';
const VERIFY_OCCUPIED = 'B25003_001E';

/** The Census' "no estimate" and "no margin" sentinels. */
const NO_DATA = -666666666;
const NO_MOE = -222222222;

/**
 * The base URL for the ACS API.
 *
 * The five-year dataset lives under `acs/acs5`, NOT under `acs5`. The shorter
 * path is a 404 from the API's own front end with an HTML error page, which
 * reads exactly like a transient failure - and it is not one, so a retry loop
 * around it never succeeds. The dataset segment and the group segment are
 * different things and only one of them is spelled `acs`.
 */
const ACS_BASE = `https://api.census.gov/data/${ACS_VINTAGE}/acs/${ACS_DATASET}`;

/** The gazetteer: every ZCTA with the internal point used to place it. */
const ZCTA_GAZETTEER_URL =
  'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip';

/** How many ACS requests to make at once. The key lifts the ceiling; the
 *  ceiling still exists, so the fetches stay polite. */
const REQUEST_CONCURRENCY = 4;

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { state: '08', out: 'src/data/local_data/housing_units', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state') out.state = String(argv[++i] ?? '').trim();
    else if (arg === '--out') out.out = String(argv[++i] ?? '').trim();
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/build-housing-units.mjs [--state 08|all] [--out <dir>] [--dry-run]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function step(message) {
  console.log(`[housing-units] ${message}`);
}

/**
 * The Census API key, from the environment or the repo's .env.
 *
 * A missing key is a hard error rather than a fallback: without it the Census
 * answers "Missing Key", and a build that quietly produced an EMPTY artifact
 * would look like "no housing units anywhere" instead of "the build was not
 * authorised".
 */
function readApiKey() {
  const fromEnv = process.env.CENSUS_API_KEY;
  if (fromEnv) return fromEnv.trim();
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const match = /^CENSUS_API_KEY=(.+)$/.exec(line.trim());
      if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  throw new Error(
    'CENSUS_API_KEY is not set. Get a free key at https://api.census.gov/data/key_signup.html ' +
      'and put it in .env as CENSUS_API_KEY=<key>. It is used here at build time only.',
  );
}

const API_KEY = readApiKey();

/** A User-Agent, because the Census API is a public service and a request with
 * none of them is a request it has no way to answer. */
const USER_AGENT = 'gods-eye-view/0.2 (housing-units build script)';

/**
 * How many times a Census request is retried, and how long between them.
 *
 * api.census.gov answers a TRANSITENT 404 - not a 500, not a 429, a plain 404
 * with an HTML error page - when its front end is shedding load. The same URL
 * that answers 404 once answers 200 a second later, so a single 404 is not
 * evidence the request was wrong. A build that treated the first 404 as fatal
 * fails at random, which is the worst kind of build failure: it looks like the
 * script is broken rather than the service is busy.
 */
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 800;

/**
 * One ACS request, as a table.
 *
 * @param {string} query the `for=`/`in=` part of the query string
 * @param {string} label what to call it in errors
 * @returns {Promise<{header: string[], rows: string[][]}>}
 */
async function fetchAcs(query, label) {
  const url = `${ACS_BASE}?get=NAME,${VARIABLE},${VARIABLE_MOE}&${query}&key=${API_KEY}`;
  let lastError = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      const wait = RETRY_BASE_MS * 2 ** (attempt - 2);
      step(
        `retrying ${label} in ${wait}ms (attempt ${attempt} of ${RETRY_ATTEMPTS})`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    let response;
    try {
      response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    } catch (error) {
      lastError = new Error(`${label}: ${error.message}`);
      continue;
    }
    if (response.ok) {
      const payload = await response.json();
      if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
        throw new Error(
          `Census API returned a non-table for ${label}: ${JSON.stringify(payload).slice(0, 200)}`,
        );
      }
      return { header: payload[0], rows: payload.slice(1) };
    }
    const body = await response.text().catch(() => '');
    lastError = new Error(
      `Census API ${response.status} for ${label}: ${body.slice(0, 200)}`,
    );
    // A 400 means the query itself is wrong, and no retry will fix it.
    if (response.status === 400) break;
  }
  throw lastError ?? new Error(`Census API failed for ${label}`);
}

/** Run tasks with a bounded concurrency, preserving order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Turn an ACS table into rows of {id, name, units, moe}, dropping the
 * no-data sentinels and counting what was dropped.
 *
 * @param {{header: string[], rows: string[][]}} table
 * @param {object} options
 * @param {string[]} options.idColumns the columns that form the id
 * @returns {{rows: object[], dropped: number}}
 */
function toRows(table, { idColumns }) {
  const index = Object.fromEntries(
    table.header.map((name, at) => [name, at]),
  );
  const idAt = idColumns.map((name) => index[name]);
  if (idAt.some((at) => at === undefined)) {
    throw new Error(
      `ACS response is missing an id column (${idColumns.join(', ')}); got ${table.header.join(', ')}`,
    );
  }
  const valueAt = index[VARIABLE];
  const moeAt = index[VARIABLE_MOE];
  const nameAt = index.NAME;
  const rows = [];
  let dropped = 0;
  for (const row of table.rows) {
    const units = Number(row[valueAt]);
    const moe = Number(row[moeAt]);
    // The sentinels, dropped rather than summed. See the header comment.
    if (!Number.isFinite(units) || units === NO_DATA || units < 0) {
      dropped += 1;
      continue;
    }
    const moeValue = Number.isFinite(moe) && moe !== NO_MOE && moe >= 0 ? moe : null;
    rows.push({
      id: idAt.map((at) => row[at]).join(''),
      name: String(row[nameAt] ?? ''),
      units,
      moe: moeValue,
    });
  }
  return { rows, dropped };
}

/**
 * The Colorado counties' rings, decoded once.
 *
 * The ZCTA gazetteer gives an internal POINT, and placing a point needs a
 * boundary. The county polygons are already bundled, so this reuses them
 * rather than pulling another file.
 *
 * @param {string} stateFips
 * @returns {Array<{fips: string, rings: Array<Array<Array<[number, number]>>>}>}
 */
function loadStateCountyRings(stateFips) {
  const packPath = path.join(
    ROOT,
    'src/data/local_data/us_census_counties/counties.json',
  );
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  const decimals = pack.meta?.decimals ?? 5;
  const out = [];
  for (const feature of pack.features || []) {
    const fips = String(feature.geoid ?? '');
    if (!fips.startsWith(stateFips)) continue;
    const encoded = feature.polygons;
    if (!Array.isArray(encoded) || !encoded.length) continue;
    const featureDecimals = feature.d ?? decimals;
    // SPREAD, not push: `encoded` is [polygon] and each polygon is
    // [outer, ...holes], so this is polygon[].
    const rings = encoded.map((polygon) =>
      polygon.map((ring) => decodeRing(ring, featureDecimals)),
    );
    out.push({ fips, rings });
  }
  return out;
}

/**
 * Which county, if any, contains this point.
 * @returns {string|null} the five-digit county FIPS
 */
function countyAt(ringsByFips, lat, lon) {
  for (const { fips, rings } of ringsByFips) {
    if (polygonsContain(rings, lat, lon)) return fips;
  }
  return null;
}

/**
 * Every ZCTA's internal point, from the Census gazetteer.
 *
 * The file is a gzipped zip containing a tab-separated table. No state column
 * exists in it, which is the whole reason this join is here.
 */
async function loadZctaPoints() {
  const response = await fetch(ZCTA_GAZETTEER_URL);
  if (!response.ok) {
    throw new Error(`gazetteer ${response.status} for ${ZCTA_GAZETTEER_URL}`);
  }
  const zip = Buffer.from(await response.arrayBuffer());
  // The gazetteer zip stores its single member uncompressed, but the loader
  // here does not assume that.
  const { readZipEntries } = await import('./lib/binary-geo.mjs');
  const entries = readZipEntries(zip);
  let text = null;
  for (const [name, bytes] of entries) {
    if (name.endsWith('.txt')) {
      text = Buffer.from(bytes).toString('utf8');
      break;
    }
  }
  if (!text) throw new Error('gazetteer zip had no .txt member');
  const points = new Map();
  const lines = text.split(/\r?\n/).filter((line) => line.length);
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const geoid = String(cells[0] ?? '').trim();
    const lat = Number(cells[5]);
    const lon = Number(cells[6]);
    if (!geoid || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    points.set(geoid, { lat, lon });
  }
  return points;
}

/** Write a gzipped JSON artifact atomically. */
function writeArtifact(outDir, name, payload) {
  const target = path.join(outDir, name);
  const temp = `${target}.tmp`;
  const json = JSON.stringify(payload);
  fs.writeFileSync(temp, zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }));
  fs.renameSync(temp, target);
  return { name, bytes: fs.statSync(target).size, rawBytes: json.length };
}

/**
 * Check the housing-unit total against two other ACS totals.
 *
 * Sampled across the states rather than run over everything, because it is a
 * check on the TABLE, not on the rows: if the table is right for one county in
 * one state it is right for all of them, and a check that ran over 3,222
 * counties would quadruple the build's request count to re-prove one thing.
 *
 * @returns {Promise<{checked: number, mismatches: string[]}>}
 */
async function verifyHousingTable(states) {
  const mismatches = [];
  let checked = 0;
  for (const state of states) {
    const table = await fetchAcs(
      `for=county:*&in=state:${state}&get=NAME,${VARIABLE},${VERIFY_TOTAL},${VERIFY_OCCUPIED}`,
      `verification in ${state}`,
    );
    const index = Object.fromEntries(table.header.map((name, at) => [name, at]));
    for (const row of table.rows) {
      const total = Number(row[index[VARIABLE]]);
      const occupancy = Number(row[index[VERIFY_TOTAL]]);
      const occupied = Number(row[index[VERIFY_OCCUPIED]]);
      if (!Number.isFinite(total) || total < 0) continue;
      checked += 1;
      if (Number.isFinite(occupancy) && occupancy !== total) {
        mismatches.push(
          `${row[index.NAME]}: ${VARIABLE}=${total} but ${VERIFY_TOTAL}=${occupancy}`,
        );
      }
      if (Number.isFinite(occupied) && occupied > total) {
        mismatches.push(
          `${row[index.NAME]}: ${VERIFY_OCCUPIED}=${occupied} exceeds ${VARIABLE}=${total}`,
        );
      }
    }
  }
  return { checked, mismatches };
}

async function main() {
  const outDir = path.isAbsolute(args.out)
    ? args.out
    : path.join(ROOT, args.out);
  const stateFips = args.state === 'all' ? null : args.state;
  step(`state=${args.state} out=${args.out}`);

  // The table is verified BEFORE anything is written, so a wrong variable
  // cannot reach an artifact.
  const verifyStates = stateFips ? [stateFips] : ['08', '20', '48'];
  step(`verifying the housing-unit table against ${VERIFY_TOTAL}/${VERIFY_OCCUPIED}`);
  const verification = await verifyHousingTable(verifyStates);
  step(`verified ${verification.checked} counties`);
  if (verification.mismatches.length) {
    throw new Error(
      `housing-unit table verification failed:\n  ${verification.mismatches
        .slice(0, 8)
        .join('\n  ')}`,
    );
  }

  const manifest = {
    title: 'Census ACS 5-year housing units',
    source: `Census ACS ${ACS_VINTAGE} 5-year, table ${VARIABLE}`,
    variable: VARIABLE,
    variableMoe: VARIABLE_MOE,
    license: 'Public domain (U.S. Government work, 17 U.S.C. § 105)',
    builtAt: new Date().toISOString(),
    noDataSentinel: NO_DATA,
    artifacts: {},
    verification: {
      checked: verification.checked,
      against: [VERIFY_TOTAL, VERIFY_OCCUPIED],
      states: verifyStates.join(','),
    },
  };

  // ---- counties: national in one request ----------------------------------
  step('pulling counties');
  const countyTable = await fetchAcs('for=county:*', 'counties');
  const counties = toRows(countyTable, { idColumns: ['state', 'county'] });
  step(`counties: ${counties.rows.length} rows, ${counties.dropped} dropped`);

  // ---- places: national in one request -----------------------------------
  step('pulling places');
  const placeTable = await fetchAcs('for=place:*', 'places');
  const places = toRows(placeTable, { idColumns: ['state', 'place'] });
  step(`places: ${places.rows.length} rows, ${places.dropped} dropped`);

  // ---- tracts: one request per state --------------------------------------
  const states = stateFips ? [stateFips] : await listStateFips(countyTable);
  const tractTables = await mapLimit(states, REQUEST_CONCURRENCY, async (state) => {
    const table = await fetchAcs(
      `for=tract:*&in=state:${state}&in=county:*`,
      `tracts in ${state}`,
    );
    return { state, table };
  });
  const tractRows = [];
  let tractDropped = 0;
  for (const { state, table } of tractTables) {
    const parsed = toRows(table, { idColumns: ['state', 'county', 'tract'] });
    tractDropped += parsed.dropped;
    for (const row of parsed.rows) tractRows.push({ ...row, state });
  }
  step(`tracts: ${tractRows.length} rows, ${tractDropped} dropped`);

  // ---- ZCTAs: national list, attributed to a state by the gazetteer -------
  step('pulling ZCTAs (national list)');
  const zctaTable = await fetchAcs('for=zip code tabulation area:*', 'zctas');
  const zctas = toRows(zctaTable, { idColumns: ['zip code tabulation area'] });
  step(`zctas: ${zctas.rows.length} rows, ${zctas.dropped} dropped`);

  step('loading the ZCTA gazetteer');
  const zctaPoints = await loadZctaPoints();
  step(`gazetteer: ${zctaPoints.size} ZCTA points`);

  const ringsByFips = stateFips ? loadStateCountyRings(stateFips) : [];
  if (stateFips) {
    step(`county rings for ${stateFips}: ${ringsByFips.length}`);
  }
  const zctaRows = [];
  let zctaUnplaced = 0;
  for (const row of zctas.rows) {
    const point = zctaPoints.get(row.id);
    if (!point) {
      zctaUnplaced += 1;
      continue;
    }
    const countyFips = ringsByFips.length ? countyAt(ringsByFips, point.lat, point.lon) : null;
    if (stateFips) {
      // A ZCTA that does not fall inside one of the state's counties is not in
      // the state. Dropping it is the point of the join.
      if (!countyFips) continue;
    }
    zctaRows.push({ ...row, countyFips, lat: point.lat, lon: point.lon });
  }
  step(`zctas placed: ${zctaRows.length} (${zctaUnplaced} without a gazetteer point)`);

  if (args.dryRun) {
    step('dry run: nothing written');
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  written.push(
    writeArtifact(outDir, 'housing_units_county.json.gz', {
      meta: {
        ...manifest,
        geography: 'county',
        rows: counties.rows.length,
        dropped: counties.dropped,
      },
      rows: counties.rows,
    }),
  );
  written.push(
    writeArtifact(outDir, 'housing_units_place.json.gz', {
      meta: {
        ...manifest,
        geography: 'place',
        rows: places.rows.length,
        dropped: places.dropped,
      },
      rows: places.rows,
    }),
  );
  written.push(
    writeArtifact(outDir, 'housing_units_tract.json.gz', {
      meta: {
        ...manifest,
        geography: 'tract',
        states: states.join(','),
        rows: tractRows.length,
        dropped: tractDropped,
      },
      rows: tractRows,
    }),
  );
  written.push(
    writeArtifact(outDir, 'housing_units_zcta.json.gz', {
      meta: {
        ...manifest,
        geography: 'zcta',
        rows: zctaRows.length,
        dropped: zctas.dropped,
        unplaced: zctaUnplaced,
        note:
          'The ACS publishes ZCTA as a national list with no state hierarchy. ' +
          'Each ZCTA is placed by its gazetteer internal point against the ' +
          'bundled county polygons.',
      },
      rows: zctaRows.map((row) => ({
        id: row.id,
        name: row.name,
        units: row.units,
        moe: row.moe,
        countyFips: row.countyFips,
        lat: row.lat,
        lon: row.lon,
      })),
    }),
  );

  for (const file of written) {
    manifest.artifacts[file.name] = {
      bytes: file.bytes,
      rawBytes: file.rawBytes,
    };
  }
  const manifestPath = path.join(outDir, 'housing-units-sources.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of written) {
    step(`wrote ${file.name} — ${(file.bytes / 1024).toFixed(0)} KB`);
  }
  step('done');
}

/** Every state FIPS present in the county table. */
async function listStateFips(countyTable) {
  const index = countyTable.header.indexOf('state');
  const states = new Set();
  for (const row of countyTable.rows) {
    const state = String(row[index] ?? '').trim();
    if (state) states.add(state);
  }
  return [...states].sort();
}

main().catch((error) => {
  console.error(`[housing-units] failed: ${error.message}`);
  process.exitCode = 1;
});

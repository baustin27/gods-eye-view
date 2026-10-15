/**
 * Build the bundled storm snapshots under `src/data/local_data/storm/`.
 *
 * Purpose
 * -------
 * The app needs an offline, zero-key, commercially-clean answer to "where are
 * homes most likely damaged by hail and wind, historically?". This script turns
 * ~1 million raw public records into five small GeoJSONL snapshots the app can
 * load directly, with every source either US-government public domain or
 * explicitly permissive.
 *
 * Inputs (all verified reachable, no API key required)
 *  - SPC Storm Prediction Center severe-weather database, hail + wind CSVs
 *      https://www.spc.noaa.gov/wcm/data/1955-2025_hail.csv.zip
 *      https://www.spc.noaa.gov/wcm/data/1955-2025_wind.csv.zip
 *    US public domain. Hail 1955-2025, wind 1955-2025. `mag` is hail size in
 *    inches and wind speed in knots.
 *  - FEMA National Risk Index v1.20 (December 2025), county layer
 *      ArcGIS FeatureServer, read-only query, no key.
 *    Provides hazard-specific Expected Annual Loss and building value. Free to
 *    use with the mandated "not endorsed by FEMA" disclaimer, which the app
 *    renders verbatim (see src/data/stormAttribution.js).
 *  - US Census Bureau cartographic boundary county polygons (500k)
 *      https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_county_500k.zip
 *    US public domain. Used for area selection and county joins.
 *  - FEMA NRI county geometry, so county polygons and NRI attributes ship as a
 *    single joined file instead of requiring a runtime feature service.
 *
 * Outputs (all public domain / free-to-redistribute with attribution)
 *  - storm_cells_025.geojsonl    fine damage-score grid, 0.25 deg
 *  - storm_cells_050.geojsonl    coarse recurrence grid, 0.5 deg
 *  - storm_events.geojsonl       significant individual events + tracks
 *  - storm_counties.geojsonl     county polygons with NRI + storm aggregates
 *  - storm-sources.json           provenance + build metadata consumed by the app
 *
 * Usage
 *  node scripts/build-storm-snapshots.mjs [--refresh] [--out <dir>]
 *
 * @module scripts/build-storm-snapshots
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntries, readShapefile, readDbf } from './lib/binary-geo.mjs';
import {
  fetchBuffer,
  fetchJson,
  setRefresh,
  parseCsv,
  gridIndex,
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

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Hail damage thresholds, inches. 0.75" is the SPC legacy floor and the
 * de-facto "begins to dent cars" size; 1.00" is SPC's "severe hail" line;
 * 2.00" is "significant hail" and the threshold FEMA's NRI uses for
 * significant events. Both 1.5" (roof shingle damage begins) and 2.0" (glass,
 * skylights, siding) matter for residential damage.
 */
const HAIL = Object.freeze({ severe: 1.0, shingle: 1.5, significant: 2.0 });

/**
 * Wind damage thresholds, knots. 50 kt (~58 mph) is the "damaging wind"
 * report floor and roughly the threshold for twig/small-branch damage.
 * 58 kt (~67 mph) produces widespread tree and roof damage.
 * 75 kt (~86 mph) is where severe structural loss begins.
 */
const WIND = Object.freeze({ damaging: 50, severe: 58, severeStructural: 75 });

/** Only bundle individual events at or above these; the rest live in the grids. */
const EVENT_HAIL_MIN_IN = HAIL.significant; // 2.00 in
const EVENT_WIND_MIN_KT = WIND.severeStructural; // 75 kt

/** Grids, degrees. */
const FINE_DEG = 0.25;
const COARSE_DEG = 0.5;

const NRI_LAYER =
  'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Counties/FeatureServer/0/query';

const NRI_FIELDS = [
  'STATEABBRV',
  'STCOFIPS',
  'COUNTY',
  'COUNTYTYPE',
  'POPULATION',
  'EAL_VALB',
  'EAL_VALT',
  'EAL_VALP',
  'HAIL_EVNTS',
  'HAIL_AFREQ',
  'HAIL_HLRB',
  'HAIL_HLRR',
  'HAIL_EALB',
  'HAIL_ALRB',
  'HAIL_ALRP',
  'HAIL_EALR',
  'HAIL_RISKR',
  'HAIL_RISKS',
  'SWND_EVNTS',
  'SWND_AFREQ',
  'SWND_HLRB',
  'SWND_HLRR',
  'SWND_EALB',
  'SWND_ALRB',
  'SWND_ALRP',
  'SWND_EALR',
  'SWND_RISKR',
  'SWND_RISKS',
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT, refresh: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--refresh') out.refresh = true;
    else if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SPC severe-weather records
// ---------------------------------------------------------------------------

/**
 * Compact an upstream error payload for a log line.
 * @param {unknown} value
 * @returns {string}
 */
function shortJson(value) {
  const text = JSON.stringify(value) || String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Numeric hail size in inches. SPC's database carries measured inches in `mag`
 * but also carries legacy sub-report sizes; anything not a real measurement is
 * treated as unknown (null) rather than zero, because zero is a meaningful and
 * very different claim ("measured, no hail" never occurs in this dataset).
 */
function hailInches(raw) {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Wind gust in knots, or null when the report recorded no usable speed. */
function windKnots(raw) {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Composite one SPC row into the common internal record shape.
 *
 * SPC's county FIPS pair is `f1` (3-digit county) and `stf` (2-digit state).
 * The sibling `f2` column is 0 in practice, so reading state from `f2` with a
 * `??` fallback is a trap: `0` is neither null nor undefined, the fallback
 * never fires, and every key comes out as "00025" instead of "34025". That
 * failure is silent — it just looks like no county ever matches.
 */
function compositeRecord(row, hazard) {
  const lat = Number(row.slat);
  const lon = Number(row.slon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const year = Number(row.yr);
  const month = Number(row.mo);
  if (!Number.isFinite(year) || year < 1950 || year > 2100) return null;

  const county3 = String(row.f1 ?? '')
    .trim()
    .padStart(3, '0');
  const rawState = String(row.stf ?? '').trim();
  const state2 = /^\d{1,2}$/.test(rawState) ? rawState.padStart(2, '0') : '';
  const countyFips =
    /^\d{3}$/.test(county3) && county3 !== '000' && state2.length === 2
      ? state2 + county3
      : null;

  const endLat = Number(row.elat);
  const endLon = Number(row.elon);
  const hasEnd =
    Number.isFinite(endLat) &&
    Number.isFinite(endLon) &&
    (endLat !== 0 || endLon !== 0);

  // `loss` in the SPC database is thousands of dollars, crowd-sourced from NWS.
  const lossK = Number(row.loss);
  const propLoss = Number.isFinite(lossK) && lossK > 0 ? lossK * 1000 : null;

  const mag = hazard === 'hail' ? hailInches(row.mag) : windKnots(row.mag);

  return {
    hazard,
    year,
    month: Number.isFinite(month) ? month : null,
    hour: Number(row.dy) || 0,
    time: row.time || null,
    tz: Number(row.tz) || 0,
    state: row.st || null,
    stateFips: String(row.stf ?? '').padStart(2, '0'),
    countyFips,
    lat,
    lon,
    endLat: hasEnd ? endLat : null,
    endLon: hasEnd ? endLon : null,
    pathLenKm: Number(row.len) > 0 ? Number(row.len) * 1.609 : null,
    pathWidKm: Number(row.wid) > 0 ? Number(row.wid) * 1.609 : null,
    mag,
    // Segment fields. One storm can produce several rows that share an initial
    // point (SPC reports tornado tracks segment by segment, and some multi-county
    // hail and wind events repeat the same start point per segment). Without
    // these, legitimate rows look like duplicates.
    segments: Number(row.ns) > 0 ? Number(row.ns) : 1,
    segment: Number(row.sn) || 1,
    injuries: Number(row.inj) > 0 ? Number(row.inj) : 0,
    fatalities: Number(row.fat) > 0 ? Number(row.fat) : 0,
    propLoss,
  };
}

/**
 * Download and composite one SPC hazard archive.
 * @param {'hail'|'wind'} hazard
 * @returns {Promise<object[]>}
 */
async function loadSpcHazard(hazard) {
  const url = `https://www.spc.noaa.gov/wcm/data/1955-2025_${hazard}.csv.zip`;
  step(`SPC ${hazard}: downloading ${url}`);
  const zip = await fetchBuffer(url);
  const entries = readZipEntries(zip);
  const name = [...entries.keys()].find((k) =>
    k.toLowerCase().endsWith(`${hazard}.csv`),
  );
  if (!name) throw new Error(`No ${hazard} CSV inside ${url}`);
  // readZipEntries already inflates the entry; the inner file is plain CSV.
  const rows = parseCsv(entries.get(name).toString('utf8'));
  const out = [];
  let skipped = 0;
  for (const row of rows) {
    const rec = compositeRecord(row, hazard);
    if (rec) out.push(rec);
    else skipped += 1;
  }
  step(
    `SPC ${hazard}: ${out.length.toLocaleString()} usable records (${skipped.toLocaleString()} dropped), ${rows.length.toLocaleString()} rows parsed`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Grid accumulation
// ---------------------------------------------------------------------------

/**
 * Hail severity 0..1 from measured inches.
 * Uses SPC's own severe (1.0") and significant (2.0") lines as anchors and
 * saturates at 3.0" (grapefruit), beyond which incremental damage per inch
 * flattens sharply because most residential damage has already occurred.
 */
export function hailSeverity(inches) {
  if (inches == null) return 0;
  if (inches < 0.75) return 0;
  if (inches >= 3) return 1;
  if (inches >= 1) return 0.25 + ((inches - 1) / 2) * 0.75;
  return ((inches - 0.75) / 0.25) * 0.25;
}

/**
 * Wind severity 0..1 from knots.
 * 50 kt damaging floor, 75 kt severe structural, saturates at 100 kt.
 */
export function windSeverity(knots) {
  if (knots == null) return 0;
  if (knots < 50) return 0;
  if (knots >= 100) return 1;
  if (knots >= 75) return 0.55 + ((knots - 75) / 25) * 0.45;
  if (knots >= 58) return 0.2 + ((knots - 58) / 17) * 0.35;
  return ((knots - 50) / 8) * 0.2;
}

/**
 * Build the coarse recurrence grid and the fine damage-score grid in one pass.
 *
 * The coarse 0.5 deg grid keeps every report so frequency is honest. The fine
 * 0.25 deg grid keeps every report too, but only materialises cells that saw at
 * least one damage-relevant event, which is what keeps the file small.
 */
function buildGrids(records) {
  const coarse = new Map();
  const fine = new Map();

  for (const rec of records) {
    for (const [deg, store] of [
      [COARSE_DEG, coarse],
      [FINE_DEG, fine],
    ]) {
      const key = `${gridIndex(rec.lat, deg)}:${gridIndex(rec.lon, deg)}`;
      let cell = store.get(key);
      if (!cell) {
        cell = {
          key,
          latCell: gridIndex(rec.lat, deg),
          lonCell: gridIndex(rec.lon, deg),
          hailCount: 0,
          hailSevere: 0,
          hailSignificant: 0,
          hailMaxIn: null,
          hailSeveritySum: 0,
          windCount: 0,
          windSevere: 0,
          windStructural: 0,
          windMaxKt: null,
          windSeveritySum: 0,
          compoundDays: 0,
          firstYear: null,
          lastYear: null,
          propLoss: 0,
          injuries: 0,
          fatalities: 0,
          byDecade: {},
          byYear: {},
        };
        store.set(key, cell);
      }
      const decade = Math.floor(rec.year / 10) * 10;
      const d = (cell.byDecade[decade] ||= {
        h: 0,
        w: 0,
        hMax: 0,
        wMax: 0,
      });
      // Per-year tallies alongside the decade rollup. The decade buckets alone
      // cannot answer "what happened after 2015" without prorating, and
      // prorating assumes events were spread evenly across time — they were
      // not (774 filed reports in the 1950s vs 9,146 in the 2010s). Sparse:
      // only years that actually saw a report are emitted.
      const y = (cell.byYear[rec.year] ||= { h: 0, w: 0, hMax: 0, wMax: 0 });

      if (rec.hazard === 'hail') {
        const sev = hailSeverity(rec.mag);
        cell.hailCount += 1;
        cell.hailSeveritySum += sev;
        if (rec.mag != null) {
          cell.hailMaxIn =
            cell.hailMaxIn == null
              ? rec.mag
              : Math.max(cell.hailMaxIn, rec.mag);
          if (rec.mag >= HAIL.significant) cell.hailSignificant += 1;
          else if (rec.mag >= HAIL.severe) cell.hailSevere += 1;
        }
        d.h += 1;
        y.h += 1;
        if (rec.mag != null) {
          d.hMax = Math.max(d.hMax, rec.mag);
          y.hMax = Math.max(y.hMax, rec.mag);
        }
      } else {
        const sev = windSeverity(rec.mag);
        cell.windCount += 1;
        cell.windSeveritySum += sev;
        if (rec.mag != null) {
          cell.windMaxKt =
            cell.windMaxKt == null
              ? rec.mag
              : Math.max(cell.windMaxKt, rec.mag);
          if (rec.mag >= WIND.severeStructural) cell.windStructural += 1;
          else if (rec.mag >= WIND.severe) cell.windSevere += 1;
        }
        d.w += 1;
        y.w += 1;
        if (rec.mag != null) {
          d.wMax = Math.max(d.wMax, rec.mag);
          y.wMax = Math.max(y.wMax, rec.mag);
        }
      }

      if (rec.propLoss) cell.propLoss += rec.propLoss;
      if (rec.injuries) cell.injuries += rec.injuries;
      if (rec.fatalities) cell.fatalities += rec.fatalities;
      if (cell.firstYear == null || rec.year < cell.firstYear)
        cell.firstYear = rec.year;
      if (cell.lastYear == null || rec.year > cell.lastYear)
        cell.lastYear = rec.year;
    }
  }

  // Compound-event day counting needs the fine grid only; recompute it there so
  // "hail and wind in the same cell on the same day" is a real overlap signal
  // rather than two independent marginals added together.
  const daySeen = new Map();
  for (const rec of records) {
    const key = `${gridIndex(rec.lat, FINE_DEG)}:${gridIndex(rec.lon, FINE_DEG)}`;
    const day = `${key}|${rec.year}-${String(rec.month ?? 1).padStart(2, '0')}-${String(rec.hour ?? 0).padStart(2, '0')}`;
    let set = daySeen.get(key);
    if (!set) {
      set = new Set();
      daySeen.set(key, set);
    }
    set.add(`${day}|${rec.hazard}`);
  }
  for (const [key, set] of daySeen) {
    const cell = fine.get(key);
    if (!cell) continue;
    const days = new Set();
    for (const entry of set) days.add(entry.split('|').slice(0, 2).join('|'));
    cell.compoundDays = days.size;
  }

  return { coarse, fine };
}

/** Round for the snapshot payload so JSON stays compact without losing meaning. */
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);
const r6 = (v) => (v == null ? null : Math.round(v * 1e6) / 1e6);

/** Latitude/longitude of a grid cell centre for a given step. */
function cellCenter(index, deg) {
  return Math.round(index * deg * 100000) / 100000;
}

/** Encode a grid cell as a GeoJSON point feature with a compact property set. */
function cellFeature(cell, deg) {
  const lat = cellCenter(cell.latCell * deg + deg / 2, 1);
  const lon = cellCenter(cell.lonCell * deg + deg / 2, 1);
  // Decade keys are written in full (1950, 1960, …). A two-digit form ("50")
  // is ambiguous with the 2050s, and decoding it with a `+ 2000` heuristic
  // silently maps every pre-2000 bucket to a year outside the record — which
  // throws away roughly a third of the hail history without any visible error.
  const decades = {};
  for (const [decade, d] of Object.entries(cell.byDecade)) {
    decades[decade] = [d.h, d.w];
  }
  // Per-year tallies, as a sparse flat [year, hail, wind, year, ...] triple list.
  //
  // The decade rollup cannot answer "what happened after 2015" without
  // prorating, and prorating assumes reports were spread evenly across time.
  // They were not — 774 filed in the 1950s against 9,146 in the 2010s — so a
  // prorated narrow window is fiction. A triple costs 9 bytes where a
  // `{ "1998": [2,1] }` object costs 14, and years are dense in the middle of
  // the record and absent at both ends, so the sparse form is smaller
  // everywhere. Measured: adding this grows the snapshot 23 MB -> 28 MB (+22%),
  // which buys an exact year filter instead of a scaled estimate.
  const years = [];
  for (const year of Object.keys(cell.byYear || {}).sort((a, b) => a - b)) {
    years.push(Number(year), cell.byYear[year].h, cell.byYear[year].w);
  }
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      i: cell.latCell,
      j: cell.lonCell,
      d: deg,
      hn: cell.hailCount,
      hs: cell.hailSevere,
      hg: cell.hailSignificant,
      hx: r2(cell.hailMaxIn),
      hw: r3(cell.hailSeveritySum),
      wn: cell.windCount,
      ws: cell.windSevere,
      wc: cell.windStructural,
      wx: r2(cell.windMaxKt),
      ww: r3(cell.windSeveritySum),
      cd: cell.compoundDays,
      y0: cell.firstYear,
      y1: cell.lastYear,
      pl: cell.propLoss || undefined,
      in: cell.injuries || undefined,
      ft: cell.fatalities || undefined,
      dc: decades,
      ye: years.length ? years : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// FEMA National Risk Index
// ---------------------------------------------------------------------------

/**
 * Page the NRI county feature service.
 *
 * The service is a published view with `maxRecordCount` 2000 and OData-style
 * `resultOffset` paging. We read attributes only (`returnGeometry=false`) and
 * request exactly the ~28 fields the app uses out of the layer's 467.
 * @returns {Promise<Map<string, object>>} STCOFIPS -> attributes
 */
async function loadNriCounties() {
  step('FEMA NRI: reading county object ids');
  const idParams = new URLSearchParams({
    where: '1=1',
    returnIdsOnly: 'true',
    f: 'json',
  });
  const idPayload = await fetchJson(`${NRI_LAYER}?${idParams}`);
  if (idPayload.error) {
    throw new Error(`NRI id query failed: ${shortJson(idPayload.error)}`);
  }
  const objectIds = (idPayload.objectIds || []).slice().sort((a, b) => a - b);
  if (objectIds.length === 0) throw new Error('NRI returned no object ids');
  step(`  NRI ${objectIds.length.toLocaleString()} county features`);

  const byFips = new Map();
  const collect = (features) => {
    for (const feature of features) {
      const a = feature.attributes || {};
      const fips = String(a.STCOFIPS || '').padStart(5, '0');
      if (fips.length === 5) byFips.set(fips, a);
    }
  };

  // Primary path: one query per state.
  //
  // Offset paging does not work against this published view (it silently
  // re-serves page one, which turns offset paging into an infinite loop), and
  // objectIds chunking has to stay small because the ids go in the query string
  // and an oversized URL 404s. Per-state needs neither: the largest US state
  // has 254 counties, far below the layer's 2000-record page ceiling, so every
  // state returns in exactly one response.
  const states = [
    'AL',
    'AK',
    'AZ',
    'AR',
    'CA',
    'CO',
    'CT',
    'DE',
    'DC',
    'FL',
    'GA',
    'HI',
    'ID',
    'IL',
    'IN',
    'IA',
    'KS',
    'KY',
    'LA',
    'ME',
    'MD',
    'MA',
    'MI',
    'MN',
    'MS',
    'MO',
    'MT',
    'NE',
    'NV',
    'NH',
    'NJ',
    'NM',
    'NY',
    'NC',
    'ND',
    'MP',
    'OH',
    'OK',
    'OR',
    'PA',
    'PR',
    'RI',
    'SC',
    'SD',
    'TN',
    'TX',
    'UT',
    'VT',
    'VA',
    'VI',
    'WA',
    'WV',
    'WI',
    'WY',
  ];
  let stateFailures = 0;
  for (let i = 0; i < states.length; i += 1) {
    const params = new URLSearchParams({
      where: `STATEABBRV='${states[i]}'`,
      outFields: NRI_FIELDS.join(','),
      returnGeometry: 'false',
      f: 'json',
    });
    try {
      // eslint-disable-next-line no-await-in-loop
      const payload = await fetchJson(`${NRI_LAYER}?${params}`);
      if (payload.error) throw new Error(shortJson(payload.error));
      collect(payload.features || []);
    } catch (error) {
      stateFailures += 1;
      step(`  NRI state ${states[i]} failed: ${error.message}`);
    }
  }

  // Fallback for any state that failed: explicit objectIds in small chunks.
  if (stateFailures > 0 && byFips.size < objectIds.length) {
    const have = new Set(byFips.keys());
    const missing = objectIds.filter(
      (id) => !have.has(String(id).padStart(5, '0')),
    );
    step(
      `  NRI recovering ${missing.length.toLocaleString()} features by objectId`,
    );
    const CHUNK = 60;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const params = new URLSearchParams({
        objectIds: missing.slice(i, i + CHUNK).join(','),
        outFields: NRI_FIELDS.join(','),
        returnGeometry: 'false',
        f: 'json',
      });
      try {
        // eslint-disable-next-line no-await-in-loop
        const payload = await fetchJson(`${NRI_LAYER}?${params}`);
        if (payload.error) throw new Error(shortJson(payload.error));
        collect(payload.features || []);
      } catch {
        /* a lost chunk is acceptable; the completeness report records the gap */
      }
    }
  }
  step(`FEMA NRI: ${byFips.size.toLocaleString()} counties`);
  return byFips;
}

/** Round a FEMA currency/rate value for the snapshot. */
function nriRound(a, key, digits) {
  const v = Number(a[key]);
  if (!Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * Normalise the NRI attribute row into the compact county property block the
 * app consumes.
 * @param {object} a Raw ArcGIS attributes.
 * @returns {object}
 */
function countyRisk(a) {
  return {
    pop: Math.round(Number(a.POPULATION) || 0),
    bld: nriRound(a, 'EAL_VALB', 0),
    eal: nriRound(a, 'EAL_VALT', 0),
    // Hail: hazard-specific expected annual loss, per dollar of building value.
    hEal: nriRound(a, 'HAIL_EALB', 0),
    hRate: nriRound(a, 'HAIL_ALRB', 8),
    hRating: a.HAIL_EALR || null,
    hRisk: a.HAIL_RISKR || null,
    hEvents: nriRound(a, 'HAIL_EVNTS', 0),
    hFreq: nriRound(a, 'HAIL_AFREQ', 2),
    hLossRatio: nriRound(a, 'HAIL_HLRB', 6),
    // Strong wind: same field family, SWND_ prefix.
    wEal: nriRound(a, 'SWND_EALB', 0),
    wRate: nriRound(a, 'SWND_ALRB', 8),
    wRating: a.SWND_EALR || null,
    wRisk: a.SWND_RISKR || null,
    wEvents: nriRound(a, 'SWND_EVNTS', 0),
    wFreq: nriRound(a, 'SWND_AFREQ', 2),
    wLossRatio: nriRound(a, 'SWND_HLRB', 6),
  };
}

// ---------------------------------------------------------------------------
// Census county geometry
// ---------------------------------------------------------------------------

/**
 * Load Census cartographic-boundary county polygons, newest vintage available.
 * The boundary file is public domain and carries the five-digit county FIPS in
 * its `GEOID` attribute, which is the join key for both NRI and the SPC storm
 * aggregates.
 * @returns {Promise<Array<{geometry: object|null, properties: object}>>}
 */
async function loadCountyGeometry() {
  const years = ['2025', '2024', '2023'];
  for (const year of years) {
    const url = `https://www2.census.gov/geo/tiger/GENZ${year}/shp/cb_${year}_us_county_500k.zip`;
    try {
      step(`Census TIGER ${year}: downloading county boundaries`);
      // eslint-disable-next-line no-await-in-loop
      const zip = await fetchBuffer(url);
      const entries = readZipEntries(zip);
      const shpName = [...entries.keys()].find((k) => k.endsWith('.shp'));
      const dbfName = [...entries.keys()].find((k) => k.endsWith('.dbf'));
      if (!shpName) throw new Error('no .shp in archive');
      const shape = readShapefile(entries.get(shpName));
      const table = readDbf(entries.get(dbfName));
      step(
        `Census TIGER ${year}: ${shape.records.length.toLocaleString()} polygons, ${table.records.length.toLocaleString()} attribute rows`,
      );
      return shape.records.map((rec, i) => {
        const attrs = table.records[i] || {};
        const geometry = ringGeometry(rec);
        const properties = {
          fips: String(attrs.GEOID || '').padStart(5, '0'),
          name: attrs.NAME || null,
          state: attrs.STUSPS || attrs.STATE || null,
          // `STATE_NAME` is the state ("California"). `NAMELSAD` is the county's
          // own legal name plus its LSAD suffix ("Santa Clara County"), so
          // deriving a state name from it yields the county name again — which
          // is why every state-scoped county search silently matched nothing.
          stateName: attrs.STATE_NAME || null,
        };
        return { geometry, properties };
      });
    } catch (error) {
      step(
        `Census TIGER ${year}: unavailable (${error.message}) — trying older vintage`,
      );
    }
  }
  throw new Error(
    'No Census cartographic-boundary county vintage could be downloaded',
  );
}

/**
 * Drop consecutive duplicate and collinear vertices.
 *
 * Census cartographic-boundary rings are vertex-dense: long straight stretches
 * of a county's survey boundary and every meander of a coastline contribute
 * thousands of points that lie exactly on the segment between their neighbours.
 * Removing them is O(n) and typically collapses a 50,000-vertex coastal ring to
 * a few thousand, which is what makes the simplification step below tractable.
 * @param {number[]} ring Flat [x0,y0,x1,y1,…], implicitly closed.
 * @returns {number[]}
 */
function dropRedundantVertices(ring) {
  const n = ring.length / 2;
  if (n < 4) return ring;
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const x = ring[i * 2];
    const y = ring[i * 2 + 1];
    const last = pts.length;
    if (last >= 2 && pts[last - 2] === x && pts[last - 1] === y) continue;
    pts.push(x, y);
  }
  const m = pts.length / 2;
  if (m < 4) return pts.length ? pts : ring;
  const out = [];
  for (let i = 0; i < m; i += 1) {
    const prev = (i - 1 + m) % m;
    const next = (i + 1) % m;
    const ax = pts[prev * 2];
    const ay = pts[prev * 2 + 1];
    const bx = pts[i * 2];
    const by = pts[i * 2 + 1];
    const cx = pts[next * 2];
    const cy = pts[next * 2 + 1];
    // Cross product: exactly zero means the three vertices are collinear.
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (cross === 0) continue;
    out.push(bx, by);
  }
  return out.length >= 6 ? out : pts;
}

/**
 * Perpendicular distance from point `p` to segment `a`-`b`, in degrees.
 * @param {number[]} p [x,y]
 * @param {number[]} a [x,y]
 * @param {number[]} b [x,y]
 * @returns {number}
 */
function pointSegmentDistance(p, a, b) {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Above this vertex count, skip RDP and stride-sample instead (see simplifyRing). */
const RDP_VERTEX_LIMIT = 8000;
/** Hard ceiling on vertices kept per ring. */
const RING_VERTEX_CAP = 1200;

/**
 * Simplify a closed ring stored flat as [x0,y0,x1,y1,…].
 *
 * Order matters: redundant-vertex removal first (O(n), huge reduction), then
 * Ramer–Douglas–Peucker when the ring is small enough for its worst case to be
 * irrelevant, then a uniform stride sample for the few rings that stay huge.
 *
 * The three-stage shape is deliberate. A textbook RDP on the raw 500k boundary
 * rings is O(n²) worst case; on a 50,000-vertex coastal ring that is minutes of
 * CPU per county and wedges the whole build.
 *
 * @param {number[]} ring
 * @param {number} tolerance Max allowed deviation, in degrees.
 * @returns {number[]}
 */
function simplifyRing(ring, tolerance) {
  const reduced = dropRedundantVertices(ring);
  let n = reduced.length / 2;
  if (n < 5) return reduced;

  if (n > RDP_VERTEX_LIMIT) {
    // Uniform stride sampling, preserving the ring closure. Perceptually this
    // only affects rings whose every segment is already sub-pixel at map scale.
    const stride = Math.ceil(n / RING_VERTEX_CAP);
    const out = [];
    for (let i = 0; i < n; i += stride)
      out.push(reduced[i * 2], reduced[i * 2 + 1]);
    out.push(out[0], out[1]);
    return out;
  }

  // Anchor: the pair of points farthest apart, so the two open arcs between
  // them can be simplified independently. Both arcs are walked modulo n, so it
  // does not matter which of the two indices is lower — walking a decreasing
  // index range would silently collapse that half of the ring to two points.
  const pointAt = (i) => [
    reduced[(((i % n) + n) % n) * 2],
    reduced[(((i % n) + n) % n) * 2 + 1],
  ];
  let bestI = 0;
  let bestJ = 1;
  let bestD = -1;
  const probeStep = Math.max(1, Math.floor(n / 32));
  for (let i = 0; i < n; i += probeStep) {
    for (let j = i + 1; j < n; j += probeStep) {
      const d =
        (reduced[i * 2] - reduced[j * 2]) ** 2 +
        (reduced[i * 2 + 1] - reduced[j * 2 + 1]) ** 2;
      if (d > bestD) {
        bestD = d;
        bestI = i;
        bestJ = j;
      }
    }
  }
  const keep = new Uint8Array(n);
  keep[bestI] = 1;
  keep[bestJ] = 1;
  const simplifyArc = (from, to) => {
    // Iterative RDP over the forward walk from `from` to `to`, inclusive.
    const stack = [[0, (((to - from) % n) + n) % n]];
    while (stack.length) {
      const [lo, hi] = stack.pop();
      if (hi <= lo + 1) continue;
      const a = pointAt(from + lo);
      const b = pointAt(from + hi);
      let maxDist = -1;
      let maxIdx = -1;
      for (let offset = lo + 1; offset < hi; offset += 1) {
        const i = (from + offset) % n;
        const d = pointSegmentDistance(
          [reduced[i * 2], reduced[i * 2 + 1]],
          a,
          b,
        );
        if (d > maxDist) {
          maxDist = d;
          maxIdx = offset;
        }
      }
      if (maxDist > tolerance && maxIdx > 0) {
        keep[(from + maxIdx) % n] = 1;
        stack.push([lo, maxIdx], [maxIdx, hi]);
      }
    }
  };
  simplifyArc(bestI, bestJ);
  simplifyArc(bestJ, bestI);

  const out = [];
  for (let i = 0; i < n; i += 1) {
    if (keep[i]) out.push(reduced[i * 2], reduced[i * 2 + 1]);
  }
  // Re-close the ring.
  out.push(out[0], out[1]);
  return out;
}

/** Round a coordinate pair in place to `digits` decimals. */
function roundRing(ring, digits) {
  const f = 10 ** digits;
  for (let i = 0; i < ring.length; i += 1) {
    ring[i] = Math.round(ring[i] * f) / f;
  }
  // Drop consecutive duplicates introduced by rounding.
  const out = [];
  for (let i = 0; i < ring.length; i += 2) {
    const n = out.length;
    if (n >= 2 && out[n - 2] === ring[i] && out[n - 1] === ring[i + 1])
      continue;
    out.push(ring[i], ring[i + 1]);
  }
  return out;
}

/**
 * Build GeoJSON geometry from a shapefile polygon record.
 *
 * Census county files put outer rings first and island/lake rings afterwards.
 * Emitting a MultiPolygon with one polygon per ring would draw lakes as islands
 * of land, so rings are classified by orientation instead: with the file's
 * clockwise-outer convention, negative signed area separates shells from holes.
 *
 * Geometry is simplified and rounded because the 500k cartographic-boundary file
 * is generous well beyond what a 1 km risk surface needs, and the app ships this
 * snapshot in-repo rather than fetching it.
 */
function ringGeometry(rec, { toleranceDeg = 0.004, digits = 5 } = {}) {
  if (!rec || !Array.isArray(rec.parts) || rec.parts.length === 0) return null;
  const shells = [];
  const holes = [];
  for (const raw of rec.parts) {
    if (raw.length < 6) continue;
    let ring = raw;
    if (toleranceDeg > 0) ring = simplifyRing(ring, toleranceDeg);
    ring = roundRing(ring, digits);
    if (ring.length < 6) continue;
    // Signed shoelace area. A negative value means clockwise, which Census uses
    // for outer rings.
    let area = 0;
    for (let i = 0, n = ring.length / 2; i < n; i += 1) {
      const x1 = ring[i * 2];
      const y1 = ring[i * 2 + 1];
      const j = (i + 1) % n;
      area += x1 * ring[j * 2 + 1] - ring[j * 2] * y1;
    }
    if (Math.abs(area / 2) < 1e-6) continue;
    (area < 0 ? shells : holes).push(ring);
  }
  if (shells.length === 0) return null;
  // Standard GeoJSON nests rings as arrays of [x, y] pairs. Emitting the flat
  // form would be smaller but is not valid GeoJSON, and every consumer here
  // (Cesium's GeoJsonDataSource, and src/data/stormScoring.js polygonCenter)
  // expects the nested form.
  const toPositions = (flat) => {
    const positions = new Array(flat.length / 2);
    for (let i = 0; i < positions.length; i += 1)
      positions[i] = [flat[i * 2], flat[i * 2 + 1]];
    return positions;
  };
  const shellRings = shells.map(toPositions);
  const holeRings = holes.map(toPositions);
  if (shellRings.length === 1 && holeRings.length === 0) {
    return { type: 'Polygon', coordinates: shellRings };
  }
  return {
    type: 'MultiPolygon',
    coordinates: shellRings.map((shell) => [shell, ...holeRings]),
  };
}

// ---------------------------------------------------------------------------
// County storm aggregation
// ---------------------------------------------------------------------------

/**
 * Fold the fine grid into per-county storm statistics by county centroid, then
 * attach NRI risk. Counting by centroid keeps the join O(n) and keeps counties
 * whose storms straddle a boundary from double-counting the whole grid cell.
 */
function countyStormStats(records) {
  const byFips = new Map();
  const perStateSeen = new Map();
  for (const rec of records) {
    if (!rec.countyFips) continue;
    const cell = byFips.get(rec.countyFips) || {
      hailCount: 0,
      hailSevere: 0,
      hailSignificant: 0,
      hailMaxIn: null,
      windCount: 0,
      windSevere: 0,
      windMaxKt: null,
      propLoss: 0,
      firstYear: null,
      lastYear: null,
      byDecade: {},
      byYear: {},
    };
    const decade = Math.floor(rec.year / 10) * 10;
    const d = (cell.byDecade[decade] ||= { h: 0, w: 0 });
    const y = (cell.byYear[rec.year] ||= { h: 0, w: 0 });
    if (rec.hazard === 'hail') {
      cell.hailCount += 1;
      d.h += 1;
      y.h += 1;
      if (rec.mag != null) {
        cell.hailMaxIn =
          cell.hailMaxIn == null ? rec.mag : Math.max(cell.hailMaxIn, rec.mag);
        if (rec.mag >= HAIL.significant) cell.hailSignificant += 1;
        else if (rec.mag >= HAIL.severe) cell.hailSevere += 1;
      }
    } else {
      cell.windCount += 1;
      d.w += 1;
      y.w += 1;
      if (rec.mag != null) {
        cell.windMaxKt =
          cell.windMaxKt == null ? rec.mag : Math.max(cell.windMaxKt, rec.mag);
        if (rec.mag >= WIND.severe) cell.windSevere += 1;
      }
    }
    if (rec.propLoss) cell.propLoss += rec.propLoss;
    if (cell.firstYear == null || rec.year < cell.firstYear)
      cell.firstYear = rec.year;
    if (cell.lastYear == null || rec.year > cell.lastYear)
      cell.lastYear = rec.year;
    perStateSeen.set(rec.countyFips, true);
    byFips.set(rec.countyFips, cell);
  }
  return byFips;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  setRefresh(args.refresh);
  const startedAt = Date.now();
  await fs.mkdir(args.out, { recursive: true });

  const [hail, wind] = await Promise.all([
    loadSpcHazard('hail'),
    loadSpcHazard('wind'),
  ]);
  const records = [...hail, ...wind];
  step(`SPC combined: ${records.length.toLocaleString()} records`);

  step('Building grids');
  const { coarse, fine } = buildGrids(records);
  step(`  coarse ${COARSE_DEG}deg cells: ${coarse.size.toLocaleString()}`);
  step(`  fine   ${FINE_DEG}deg cells: ${fine.size.toLocaleString()}`);

  const fineFeatures = [...fine.values()].map((c) => cellFeature(c, FINE_DEG));
  const coarseFeatures = [...coarse.values()].map((c) =>
    cellFeature(c, COARSE_DEG),
  );
  const fineBytes = await writeGeoJsonl(
    path.join(args.out, 'storm_cells_025.geojsonl'),
    fineFeatures,
  );
  const coarseBytes = await writeGeoJsonl(
    path.join(args.out, 'storm_cells_050.geojsonl'),
    coarseFeatures,
  );
  step(`Wrote storm_cells_025.geojsonl (${(fineBytes / 1e6).toFixed(1)} MB)`);
  step(`Wrote storm_cells_050.geojsonl (${(coarseBytes / 1e6).toFixed(1)} MB)`);

  // Significant individual events, with tracks where SPC recorded an end point.
  // Ids are derived from the report's own coordinates, year and magnitude rather
  // than a running index, so re-running the ETL with one more upstream record
  // does not renumber every later event (index-based ids also make any saved
  // selection or share link point at a different storm after a data refresh).
  const events = records
    .filter(
      (r) =>
        (r.hazard === 'hail' && r.mag != null && r.mag >= EVENT_HAIL_MIN_IN) ||
        (r.hazard === 'wind' && r.mag != null && r.mag >= EVENT_WIND_MIN_KT),
    )
    .map((r) => {
      const stamp = `${r.year}${String(r.month ?? 0).padStart(2, '0')}`;
      const tag = `${r.hazard === 'hail' ? 'H' : 'W'}-${stamp}-`;
      // Include the day, end point, and length so that two co-located reports
      // of the same size in the same month (which do occur — a storm reported
      // twice, or a track and its initial point) still hash apart.
      const material = [
        r.lat.toFixed(3),
        r.lon.toFixed(3),
        (r.mag ?? 0).toFixed(2),
        r.hour,
        r.month,
        (r.endLat ?? 0).toFixed(3),
        (r.endLon ?? 0).toFixed(3),
        (r.pathLenKm ?? 0).toFixed(2),
        r.segments,
        r.segment,
      ].join(',');
      // FNV-1a, 32-bit, rendered base36. Short, stable, and adequate as an
      // identity — collisions across ~38k events are not a practical concern
      // and the coordinates remain in the payload for disambiguation.
      let hash = 0x811c9dc5;
      for (let i = 0; i < material.length; i += 1) {
        hash ^= material.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return {
        id: `${tag}${hash.toString(36)}`,
        type: 'Feature',
        geometry:
          r.endLat != null && r.endLon != null
            ? {
                type: 'LineString',
                coordinates: [
                  [r2(r.lon), r2(r.lat)],
                  [r2(r.endLon), r2(r.endLat)],
                ],
              }
            : { type: 'Point', coordinates: [r2(r.lon), r2(r.lat)] },
        properties: {
          id: `${tag}${hash.toString(36)}`,
          t: r.hazard,
          y: r.year,
          m: r.month,
          mag: r2(r.mag),
          sev: r3(
            r.hazard === 'hail' ? hailSeverity(r.mag) : windSeverity(r.mag),
          ),
          cf: r.countyFips,
          st: r.state,
          lat: r2(r.lat),
          lon: r2(r.lon),
          pl: r.propLoss || undefined,
          len: r2(r.pathLenKm) || undefined,
          wid: r2(r.pathWidKm) || undefined,
        },
      };
    });
  // SPC rounds report coordinates to two decimals (~1 km), so two genuinely
  // distinct reports can collapse onto the same point, size and month — and the
  // published database does contain exact duplicate rows. Keeping them would
  // draw two identical markers in the same place and double-count in the analyst
  // engine, so collapse them and record how many were removed rather than
  // dropping the fact silently.
  const seenEventIds = new Set();
  const uniqueEvents = [];
  let duplicateEvents = 0;
  for (const event of events) {
    if (seenEventIds.has(event.properties.id)) {
      duplicateEvents += 1;
      continue;
    }
    seenEventIds.add(event.properties.id);
    uniqueEvents.push(event);
  }
  if (duplicateEvents > 0) {
    step(`Collapsed ${duplicateEvents} duplicate significant-event rows`);
  }
  const eventBytes = await writeGeoJsonl(
    path.join(args.out, 'storm_events.geojsonl'),
    uniqueEvents,
  );
  step(
    `Wrote storm_events.geojsonl (${uniqueEvents.length.toLocaleString()} events, ${(eventBytes / 1e6).toFixed(1)} MB)`,
  );

  // Counties: Census geometry + NRI risk + observed storm statistics.
  const [counties, nri] = await Promise.all([
    loadCountyGeometry(),
    loadNriCounties(),
  ]);
  const countyStorm = countyStormStats(records);
  const countyFeatures = counties
    .map(({ geometry, properties }) => {
      const risk = nri.get(properties.fips);
      const storm = countyStorm.get(properties.fips);
      const decades = {};
      const years = [];
      if (storm) {
        for (const [decade, d] of Object.entries(storm.byDecade)) {
          decades[decade] = [d.h, d.w];
        }
        for (const year of Object.keys(storm.byYear || {}).sort(
          (a, b) => a - b,
        )) {
          years.push(Number(year), storm.byYear[year].h, storm.byYear[year].w);
        }
      }
      return {
        type: 'Feature',
        geometry,
        properties: {
          fips: properties.fips,
          name: properties.name,
          st: properties.state,
          stn: properties.stateName,
          ...(risk ? countyRisk(risk) : {}),
          ...(storm
            ? {
                hn: storm.hailCount,
                hs: storm.hailSevere,
                hg: storm.hailSignificant,
                hx: r2(storm.hailMaxIn),
                wn: storm.windCount,
                ws: storm.windSevere,
                wx: r2(storm.windMaxKt),
                y0: storm.firstYear,
                y1: storm.lastYear,
                pl: storm.propLoss || undefined,
                dc: decades,
                ye: years.length ? years : undefined,
              }
            : {}),
        },
      };
    })
    .filter((f) => f.geometry);
  const countyBytes = await writeGeoJsonl(
    path.join(args.out, 'storm_counties.geojsonl'),
    countyFeatures,
  );
  step(
    `Wrote storm_counties.geojsonl (${countyFeatures.length.toLocaleString()} counties, ${(countyBytes / 1e6).toFixed(1)} MB)`,
  );

  // Completeness reporting. NCEI warns that Storm Events coverage is not
  // uniform across eras; the app shows this so a flat trend line is never
  // presented as if the record were equally dense in 1957 and 2025.
  const byDecade = {};
  for (const rec of records) {
    const decade = Math.floor(rec.year / 10) * 10;
    const d = (byDecade[decade] ||= {
      hail: 0,
      wind: 0,
      hailMeasured: 0,
      windMeasured: 0,
    });
    d[rec.hazard] += 1;
    if (rec.mag != null)
      d[rec.hazard === 'hail' ? 'hailMeasured' : 'windMeasured'] += 1;
  }

  const meta = {
    version: 1,
    builtAt: new Date().toISOString(),
    builder: 'scripts/build-storm-snapshots.mjs',
    thresholds: {
      HAIL,
      WIND,
      EVENT_HAIL_MIN_IN,
      EVENT_WIND_MIN_KT,
      FINE_DEG,
      COARSE_DEG,
    },
    recordCounts: {
      total: records.length,
      hail: hail.length,
      wind: wind.length,
      hailMeasured: hail.filter((r) => r.mag != null).length,
      windMeasured: wind.filter((r) => r.mag != null).length,
      cellsFine: fineFeatures.length,
      cellsCoarse: coarseFeatures.length,
      significantEvents: uniqueEvents.length,
      duplicateEventsCollapsed: duplicateEvents,
      counties: countyFeatures.length,
      nriCounties: nri.size,
    },
    completeness: byDecade,
    sources: [
      {
        id: 'spc-severe-database',
        name: 'NOAA/NWS Storm Prediction Center Severe Weather Database',
        url: 'https://www.spc.noaa.gov/wcm/',
        coverage: 'hail + wind 1955-2025',
        license: 'US Government public domain',
        attribution: 'NOAA/NWS Storm Prediction Center',
        commercialUse: true,
      },
      {
        id: 'fema-nri',
        name: 'FEMA National Risk Index for Natural Hazards, v1.20 (December 2025)',
        url: 'https://www.fema.gov/flood-maps/products-tools/national-risk-index',
        coverage: 'US counties; hail + strong wind expected annual loss',
        license: 'Free to use with FEMA-mandated disclaimer',
        attribution: 'U.S. Federal Emergency Management Agency (FEMA)',
        commercialUse: true,
        disclaimer:
          "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA. The Federal Government or FEMA cannot vouch for the data or analyses derived from these data after the data have been retrieved from the Agency's website(s).",
      },
      {
        id: 'census-tiger-cb',
        name: 'US Census Bureau cartographic boundary county polygons',
        url: 'https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html',
        coverage: 'US counties and equivalents',
        license: 'US Government public domain',
        attribution: 'U.S. Census Bureau',
        commercialUse: true,
      },
    ],
  };
  await fs.writeFile(
    path.join(args.out, 'storm-sources.json'),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
  step('Wrote storm-sources.json');

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  step(`Done in ${elapsed}s → ${path.relative(PROJECT_ROOT, args.out)}`);
}

main().catch((error) => {
  process.stderr.write(`[storm-etl] FAILED: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});

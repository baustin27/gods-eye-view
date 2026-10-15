#!/usr/bin/env node
/**
 * build-storm-reports.mjs — the report-level hail and wind snapshot.
 *
 * Where `build-storm-snapshots.mjs` answers "where has hail historically
 * damaged homes" with 0.25-degree aggregates, this answers "what fell, where,
 * how big, and on what day" at the level of the individual report. That is the
 * level a roofer canvasses from.
 *
 * Two producers, because no single source covers the window:
 *
 *   2021-<last completed year>   SPC bulk archive, one row per report, with a
 *                                full ISO date and a magnitude already in
 *                                inches or knots.
 *   2015 -> yesterday            SPC per-day CSVs. The archive has no current
 *                                year, so the daily files are the only way to
 *                                reach 2026. Smaller schema, day comes from
 *                                the URL stamp.
 *
 * Output is one packed file per year plus a day index, so opening a single
 * date costs one year of payload instead of the whole record:
 *
 *   <out>/storm_reports_<year>.json.gz
 *   <out>/storm_report_index.json.gz     day -> counts, year -> {file,count}
 *   <out>/storm_report_sources.json       provenance and completeness
 *
 * Usage:
 *   node scripts/build-storm-reports.mjs [--out <dir>] [--from <year>]
 *                                       [--to <year>] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { fetchBuffer, parseCsv } from './lib/storm-fetch.mjs';
import { readZipEntries } from './lib/binary-geo.mjs';
import {
  MAGNITUDE_UNITS,
  STORM_HAZARDS,
  applyCountyFips,
  buildCountyFipsIndex,
  normalizeSpcBulkRow,
  normalizeSpcDailyRow,
  packReport,
  sortReports,
} from './lib/storm-report-normalize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The bulk archive is named for the year it was last cut. */
const SPC_BULK_BASE = 'https://www.spc.noaa.gov/wcm/data';
/** Per-day files exist from 2015 and are the current-year path. */
const SPC_DAILY_BASE = 'https://www.spc.noaa.gov/climo/reports';

/** Days before today are guaranteed published; today may not be. */
const DAILY_LAG_DAYS = 1;

/**
 * How many daily files to request concurrently. SPC publishes to a single
 * government web server; a handful in flight keeps the build quick without
 * hammering it.
 */
const DAILY_CONCURRENCY = 6;

function parseArgs(argv) {
  const args = {
    out: path.join(HERE, '..', 'src', 'data', 'local_data', 'storm'),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--from') args.from = Number(argv[++i]);
    else if (argv[i] === '--to') args.to = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

/**
 * SPC's bulk archive carries an explicit end year in its filename. Probing for
 * it keeps the builder working the year after this file was written instead of
 * silently producing a snapshot that stops at a hardcoded year.
 * @returns {Promise<number|null>} The last year with a published archive.
 */
export async function discoverBulkEndYear() {
  for (let year = new Date().getUTCFullYear(); year >= 2015; year -= 1) {
    const url = `${SPC_BULK_BASE}/1955-${year}_hail.csv.zip`;
    const res = await fetch(url, { method: 'HEAD' });
    if (res.ok) {
      res.body?.cancel?.();
      return year;
    }
  }
  return null;
}

/**
 * Every day a per-day file should exist for. The interval is inclusive of both
 * ends, and stops `DAILY_LAG_DAYS` short of today.
 * @param {number} fromYear
 * @param {number} [toYear]
 * @param {Date} [now]
 * @returns {string[]} ISO days, ascending.
 */
export function dailyDays(
  fromYear,
  toYear = new Date().getUTCFullYear(),
  now = new Date(),
) {
  const last = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - DAILY_LAG_DAYS,
    ),
  );
  const first = new Date(Date.UTC(fromYear, 0, 1));
  if (first > last) return [];
  const days = [];
  for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/** `2025-06-29` -> `250629`, the stamp SPC uses in daily filenames. */
export function dayStamp(iso) {
  const [y, m, d] = iso.split('-');
  return `${y.slice(2)}${m}${d}`;
}

/**
 * Pull the bulk archive and normalise every row inside the window.
 * @param {string} hazard
 * @param {number} fromYear
 * @param {number} toYear
 * @returns {Promise<{reports: object[], archiveRows: number}>}
 */
export async function ingestBulk(hazard, fromYear, toYear) {
  const url = `${SPC_BULK_BASE}/1955-${toYear}_${hazard}.csv.zip`;
  const zip = await fetchBuffer(url);
  const entries = readZipEntries(zip);
  // readZipEntries returns a Map of entry name -> inflated contents.
  const csvName = [...entries.keys()].find((n) =>
    n.toLowerCase().endsWith(`${hazard}.csv`),
  );
  if (!csvName) throw new Error(`No ${hazard} CSV inside ${url}`);
  // readZipEntries already inflates the entry; the inner file is plain CSV.
  const rows = parseCsv(entries.get(csvName).toString('utf8'));
  const reports = [];
  for (const row of rows) {
    const year = Number(row.yr);
    if (!Number.isFinite(year) || year < fromYear || year > toYear) continue;
    const report = normalizeSpcBulkRow(row, hazard);
    if (report) reports.push(report);
  }
  return { reports, archiveRows: rows.length };
}

/**
 * Fetch one per-day file. A 404 is normal — plenty of days have no hail or no
 * wind worth reporting — so it resolves to an empty result rather than failing
 * the build.
 * @param {string} hazard
 * @param {string} isoDay
 * @returns {Promise<object[]>}
 */
export async function ingestDailyOne(hazard, isoDay) {
  const url = `${SPC_DAILY_BASE}/${dayStamp(isoDay)}_rpts_${hazard}.csv`;
  let text;
  try {
    text = (await fetchBuffer(url)).toString('utf8');
  } catch (error) {
    if (error?.status === 404 || error?.message?.includes('404')) return [];
    throw error;
  }
  const rows = parseCsv(text);
  const reports = [];
  for (const row of rows) {
    const report = normalizeSpcDailyRow(row, hazard, isoDay);
    if (report) reports.push(report);
  }
  return reports;
}

/**
 * Walk every day and hazard, yielding progress so a long build is legible.
 * @param {string[]} days
 * @returns {Promise<object[]>}
 */
export async function ingestDaily(days) {
  const reports = [];
  let done = 0;
  for (let i = 0; i < days.length; i += DAILY_CONCURRENCY) {
    const slice = days.slice(i, i + DAILY_CONCURRENCY);
    const batches = await Promise.all(
      slice.flatMap((day) =>
        STORM_HAZARDS.map((hazard) => ingestDailyOne(hazard, day)),
      ),
    );
    for (const batch of batches) reports.push(...batch);
    done += slice.length;
    if (done % 30 === 0 || done === days.length) {
      process.stdout.write(
        `    ${done}/${days.length} days, ${reports.length.toLocaleString()} reports\n`,
      );
    }
  }
  return reports;
}

/**
 * Fold the flat report list into per-year payloads and a day index.
 *
 * The index is what makes the timeline cheap: it answers "what happened on
 * this date" without opening a year file, and says which file to open next.
 * @param {object[]} reports
 * @returns {{years: Map<string, object>, index: object}}
 */
export function assemble(reports) {
  const byYear = new Map();
  const dayIndex = Object.create(null);
  for (const report of reports) {
    const year = report.date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(report);
    const day = (dayIndex[report.date] ||= { hail: 0, wind: 0, total: 0 });
    day[report.hazard] += 1;
    day.total += 1;
  }
  const years = new Map();
  for (const [year, list] of byYear) {
    sortReports(list);
    years.set(year, {
      reports: list.map(packReport),
      count: list.length,
      hazards: {
        hail: list.filter((r) => r.hazard === 'hail').length,
        wind: list.filter((r) => r.hazard === 'wind').length,
      },
    });
  }
  return { years, index: dayIndex };
}

/** Write one gzipped JSON payload. */
function writeJson(file, value) {
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(value), { level: 9 }));
  return fs.statSync(file).size;
}

/**
 * Load the county polygons that ship with the snapshot and index them for the
 * daily-path county lookup. Those files only carry a county *name*, so without
 * this the whole current year would be unfilterable by county.
 * @param {string} outDir Directory holding `storm_counties.geojsonl`.
 * @returns {Promise<Map<string,string>>} Lookup key -> five-digit FIPS.
 */
async function loadCountyIndex(outDir) {
  const file = path.join(outDir, 'storm_counties.geojsonl');
  if (!fs.existsSync(file)) return new Map();
  const counties = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    counties.push(JSON.parse(line));
  }
  return buildCountyFipsIndex(counties);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();

  process.stdout.write('  resolving the source window\n');
  const bulkEnd = (await discoverBulkEndYear()) ?? now.getUTCFullYear() - 1;
  const fromYear = args.from ?? 2021;
  // Anything past the archive end can only come from the daily files, so the
  // daily range starts the year after the archive stops.
  const dailyFrom = Math.max(fromYear, bulkEnd + 1);
  process.stdout.write(
    `    bulk ${fromYear}-${bulkEnd} | daily ${dailyFrom}-${now.toISOString().slice(0, 10)}\n`,
  );

  const reports = [];
  const provenance = {
    builtAt: now.toISOString(),
    hazards: STORM_HAZARDS,
    units: MAGNITUDE_UNITS,
    sources: {},
  };

  for (const hazard of STORM_HAZARDS) {
    process.stdout.write(`  bulk archive: ${hazard}\n`);
    const { reports: bulk, archiveRows } = await ingestBulk(
      hazard,
      fromYear,
      bulkEnd,
    );
    reports.push(...bulk);
    provenance.sources[`spc-bulk-${hazard}`] = {
      url: `${SPC_BULK_BASE}/1955-${bulkEnd}_${hazard}.csv.zip`,
      rows: archiveRows,
      kept: bulk.length,
      window: [fromYear, bulkEnd],
    };
    process.stdout.write(`    ${bulk.length.toLocaleString()} reports\n`);
  }

  const days = dailyDays(dailyFrom);
  if (days.length) {
    process.stdout.write(`  daily files: ${days.length} days\n`);
    const daily = await ingestDaily(days);
    reports.push(...daily);
    provenance.sources['spc-daily'] = {
      base: SPC_DAILY_BASE,
      days: days.length,
      kept: daily.length,
      window: [days[0], days[days.length - 1]],
    };
  }

  // The per-day files carry no county code, so recover it from the county
  // polygons before assembling. Bulk rows already have one and are left alone.
  const countyIndex = await loadCountyIndex(args.out);
  if (countyIndex.size) {
    const fill = applyCountyFips(reports, countyIndex);
    process.stdout.write(
      `  county codes: ${fill.resolved.toLocaleString()} recovered, ` +
        `${fill.zones.toLocaleString()} are multi-county NWS zones, ` +
        `${fill.unresolvable.toLocaleString()} unresolvable\n`,
    );
  }

  process.stdout.write(
    `  assembling ${reports.length.toLocaleString()} reports\n`,
  );
  const { years, index } = assemble(reports);

  if (args.dryRun) {
    process.stdout.write('  dry run — nothing written\n');
    for (const [year, data] of [...years].sort()) {
      process.stdout.write(
        `    ${year}: ${data.count.toLocaleString()} (hail ${data.hazards.hail.toLocaleString()}, wind ${data.hazards.wind.toLocaleString()})\n`,
      );
    }
    return;
  }

  fs.mkdirSync(args.out, { recursive: true });
  for (const [year, data] of [...years].sort()) {
    const file = path.join(args.out, `storm_reports_${year}.json.gz`);
    const bytes = writeJson(file, data);
    process.stdout.write(
      `    ${path.basename(file)}  ${data.count.toLocaleString()} reports  ${(bytes / 1048576).toFixed(1)} MB\n`,
    );
  }
  const indexFile = path.join(args.out, 'storm_report_index.json.gz');
  const indexBytes = writeJson(indexFile, {
    years: Object.fromEntries([...years].map(([y, d]) => [y, d.count])),
    days: index,
  });
  process.stdout.write(
    `    ${path.basename(indexFile)}  ${Object.keys(index).length} days  ${(indexBytes / 1024).toFixed(0)} KB\n`,
  );

  provenance.complete = Object.fromEntries(
    [...years].map(([y, d]) => [y, d.hazards]),
  );
  fs.writeFileSync(
    path.join(args.out, 'storm_report_sources.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  process.stdout.write('  done\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`  build failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

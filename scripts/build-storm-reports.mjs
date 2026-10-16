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
import {
  buildStormEvents,
  indexNceiEvents,
  joinNcei,
} from './lib/storm-ncei-join.mjs';
import {
  DEFAULT_MAX_GAP_MINUTES,
  DEFAULT_MAX_SPAN_KM,
  clusterReports,
  summarizeCluster,
} from './lib/storm-cluster.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The bulk archive is named for the year it was last cut. */
const SPC_BULK_BASE = 'https://www.spc.noaa.gov/wcm/data';
/** Per-day files exist from 2015 and are the current-year path. */
const SPC_DAILY_BASE = 'https://www.spc.noaa.gov/climo/reports';
/** NCEI Storm Events: one gzipped details file per year. */
const NCEI_BASE =
  'https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles';
const NCEI_LISTING = `${NCEI_BASE}/`;

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
    else if (argv[i] === '--no-ncei') args.noNcei = true;
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
 * Claim a unique key for a storm within a set.
 *
 * Two storms can carry the same id: an inferred cluster id is derived from the
 * first report of the cluster, and nothing in that derivation is a guarantee.
 * Rather than let a collision silently point a report at the wrong storm, the
 * second claimant takes a suffixed key.
 * @param {string} base
 * @param {Set<string>} taken
 * @returns {string}
 */
function claimStormKey(base, taken) {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  while (taken.has(`${base}#${n}`)) n += 1;
  const key = `${base}#${n}`;
  taken.add(key);
  return key;
}

/**
 * Index every storm by the year it lands in, and by the key reports carry.
 *
 * The ordinal a report stores is its position in that year's
 * `storm_events_<year>.json.gz` array, so the position can only be known once
 * the storms are final and split by year. Reports therefore never guess it:
 * they carry a stable key (`_stormKey` for an inferred cluster, `episodeId` for
 * an NCEI event) and the integer is resolved here, once.
 * @param {{id: string, date: string}[]} storms
 * @returns {Map<string, Map<string, number>>} year -> storm key -> ordinal.
 */
function buildStormOrdinals(storms) {
  const byYear = new Map();
  const claimed = new Map();
  for (const storm of storms) {
    if (!storm?.id || !storm?.date) continue;
    const year = String(storm.date).slice(0, 4);
    if (!byYear.has(year)) {
      byYear.set(year, new Map());
      claimed.set(year, new Set());
    }
    const byKey = byYear.get(year);
    const keys = claimed.get(year);
    // The ordinal is the position within the year's own array, which is exactly
    // how many storms of that year have been seen so far.
    byKey.set(claimStormKey(String(storm.id), keys), byKey.size);
  }
  return byYear;
}

/**
 * Group the reports NCEI never claimed into inferred storms, and stamp each
 * member with a key that reaches its own cluster.
 *
 * `summarizeCluster` keeps no back-reference to the reports it summarises, so
 * this is the only place where a clustered report can still be tied to its
 * cluster — and it has to happen while the members are in hand. The stamp is a
 * key rather than an ordinal because the ordinal only exists once the storms
 * are split into per-year files, which is later, in {@link assemble}.
 * @param {object[]} orphans Reports with no episode id.
 * @param {Set<string>} [claimedKeys] Ids already in use by the NCEI storms.
 * @returns {{inferred: object[], stats: object}}
 */
export function clusterOrphanReports(orphans, claimedKeys = new Set()) {
  const { clusters, stats } = clusterReports(orphans, {
    maxSpanKm: DEFAULT_MAX_SPAN_KM,
    maxGapMinutes: DEFAULT_MAX_GAP_MINUTES,
  });
  const inferred = [];
  for (const cluster of clusters) {
    if (cluster.length <= 1) continue;
    const storm = summarizeCluster(cluster, 'cl');
    const key = claimStormKey(String(storm.id), claimedKeys);
    for (const member of cluster) member._stormKey = key;
    inferred.push(storm);
  }
  return { inferred, stats };
}

/**
 * Fold the flat report list into per-year payloads and a day index.
 *
 * The index is what makes the timeline cheap: it answers "what happened on
 * this date" without opening a year file, and says which file to open next.
 *
 * `storms` is the finished event list — NCEI first, then the inferred clusters,
 * exactly the order they are later written out in. Every report is stamped with
 * the ordinal of the storm it belongs to so a consumer can go from a report to
 * its storm without matching on date, which is wrong on any day carrying more
 * than one storm. A report that belongs to no storm gets -1.
 * @param {object[]} reports
 * @param {{id: string, date: string}[]} [storms]
 * @returns {{years: Map<string, object>, index: object}}
 */
export function assemble(reports, storms = []) {
  const ordinals = buildStormOrdinals(storms);
  const byYear = new Map();
  const dayIndex = Object.create(null);
  for (const report of reports) {
    const year = report.date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(report);
    const day = (dayIndex[report.date] ||= { hail: 0, wind: 0, total: 0 });
    day[report.hazard] += 1;
    day.total += 1;
    // An NCEI report keys on its episode id, which is the event id. An inferred
    // cluster is not an episode, so it carries its own key. Anything else — a
    // report NCEI never published, or an orphan too small to cluster — belongs
    // to no storm.
    const key = report._stormKey || report.episodeId || null;
    const ref = key ? ordinals.get(year)?.get(key) : undefined;
    report.stormRef = Number.isInteger(ref) ? ref : -1;
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
  let stormEvents = [];
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

  // NCEI carries what SPC cannot: a real episode id, a written narrative on
  // every event, and actual dollar damage. It lags roughly a quarter, so the
  // newest reports stay unattributed until the next quarterly rebuild.
  let nceiSummary = null;
  if (!args.noNcei) {
    const nceiEnd = await discoverNceiEndYear();
    process.stdout.write(`  NCEI storm events: ${fromYear}-${nceiEnd}\n`);
    const allEvents = [];
    const allEpisodes = new Map();
    for (let year = fromYear; year <= nceiEnd; year += 1) {
      const { rows, bytes } = await fetchNceiYear(year);
      const { episodes, events } = indexNceiEvents(rows);
      for (const [id, episode] of episodes) allEpisodes.set(id, episode);
      allEvents.push(...events);
      process.stdout.write(
        `    ${year}: ${events.length.toLocaleString()} events, ${(bytes / 1048576).toFixed(0)} MB\n`,
      );
    }
    const joined = joinNcei(reports, allEvents);
    const storms = buildStormEvents(reports, allEpisodes);
    process.stdout.write(
      `    joined ${joined.matched.toLocaleString()} reports to ` +
        `${joined.episodesUsed.toLocaleString()} episodes, ` +
        `${joined.unmatched.toLocaleString()} unmatched\n`,
    );
    nceiSummary = {
      through: nceiEnd,
      events: allEvents.length,
      joined: joined.matched,
      unmatched: joined.unmatched,
      storms: storms.length,
      narrativeCoverage: storms.length
        ? Number(
            (
              (storms.filter((s) => s.narrative).length / storms.length) *
              100
            ).toFixed(1),
          )
        : 0,
    };
    stormEvents = storms;

    // Whatever NCEI has not published yet still gets grouped, so the newest
    // storms read as storms rather than as loose dots. These carry
    // `identitySource: 'clustered'` and are never presented as observed.
    const orphans = reports.filter((r) => !r.episodeId);
    if (orphans.length) {
      // NCEI's ids are already claimed, so an inferred storm can never take an
      // episode id and send a report to the wrong event.
      const claimedKeys = new Set(stormEvents.map((storm) => storm.id));
      const { inferred, stats } = clusterOrphanReports(orphans, claimedKeys);
      process.stdout.write(
        `    clustered ${orphans.length.toLocaleString()} unattributed reports into ` +
          `${inferred.length.toLocaleString()} inferred storms ` +
          `(largest ${stats.largest}), ${stats.singleton.toLocaleString()} left alone\n`,
      );
      stormEvents = [...stormEvents, ...inferred];
    }
  }

  process.stdout.write(
    `  assembling ${reports.length.toLocaleString()} reports\n`,
  );
  const { years, index } = assemble(reports, stormEvents);

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

  const storms = stormEvents;
  if (storms.length) {
    const byYear = new Map();
    for (const storm of storms) {
      const year = storm.date.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(storm);
    }
    for (const [year, list] of [...byYear].sort()) {
      const file = path.join(args.out, `storm_events_${year}.json.gz`);
      const bytes = writeJson(file, { events: list, count: list.length });
      process.stdout.write(
        `    ${path.basename(file)}  ${list.length.toLocaleString()} storms  ${(bytes / 1024).toFixed(0)} KB\n`,
      );
    }
    if (nceiSummary) provenance.ncei = nceiSummary;
  }

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

/**
 * NCEI publishes one gzipped CSV per year. Unlike the SPC archive the years are
 * independent files, so a rebuild of a single year is cheap.
 * @param {number} year
 * @returns {Promise<{rows: object[], file: string, bytes: number}>}
 */
export async function fetchNceiYear(year) {
  const listing = await (await fetch(NCEI_LISTING)).text();
  const match = new RegExp(
    `(StormEvents_details-ftp_v1\\.0_d${year}_c[0-9]+\\.csv\\.gz)`,
  ).exec(listing);
  if (!match) return { rows: [], file: '', bytes: 0 };
  const name = match[1];
  const file = `${NCEI_BASE}/${name}`;
  const buffer = await fetchBuffer(file);
  const csv = zlib.gunzipSync(buffer).toString('utf8');
  return { rows: parseCsv(csv), file, bytes: buffer.length };
}

/**
 * Discover how far NCEI has published. Its publication lags by roughly a
 * quarter, so the newest snapshot routinely stops months short of today and
 * the recent window has to come from somewhere else.
 * @returns {Promise<number>} The last year with a published details file.
 */
export async function discoverNceiEndYear() {
  const listing = await (await fetch(NCEI_LISTING)).text();
  const years = [
    ...listing.matchAll(/StormEvents_details-ftp_v1\.0_d(\d{4})_c/g),
  ]
    .map((m) => Number(m[1]))
    .filter(Number.isFinite);
  return years.length ? Math.max(...years) : 0;
}

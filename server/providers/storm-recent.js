/**
 * Near-real-time storm reports and realized loss, proxied server-side.
 *
 * Two endpoints, both keyless, both rate-limited and disk-cached:
 *
 *  - `/api/storm-recent`  today's and yesterday's Storm Prediction Center hail
 *    and wind reports. The bundled snapshot ends ~75 days behind, so this is the
 *    only way the layer shows anything for the current season.
 *  - `/api/storm-loss`    FEMA OpenFEMA `HousingAssistanceOwners` v2, reduced to
 *    county totals. This is realized homeowner damage from Individual Assistance
 *    registrations — the only free source that pairs actual post-disaster damage
 *    dollars with a county and ZIP, and it is current where the SBA Disaster Loan
 *    series stops in September 2022.
 *
 * Design notes that follow this repo's house rules:
 *  - No API key, no registration, no egress cost.
 *  - Responses are bounded and capped; nothing upstream is proxied verbatim.
 *  - A last-good response is served during an outage rather than blanking the UI,
 *    and the stale state is visible in the payload.
 *  - Nothing is persisted beyond the gitignored `.gev-cache/` directory.
 *
 * @module server/providers/storm-recent
 */

import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { readResponseTextCapped, coalesceProxyRequest } from './common/http.js';
import { clampInt } from './common/query.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// Match every other disk-caching proxy in this repo (firms, terrain,
// celestrak): the dev/preview server's working directory is the project root.
const CACHE_DIR = path.join(process.cwd(), '.gev-cache');

const RECENT_CACHE_MS = 5 * 60_000;
const RECENT_STALE_MS = 60 * 60_000;
const LOSS_CACHE_MS = 6 * 60 * 60_000;
const LOSS_STALE_MS = 7 * 24 * 60 * 60_000;

const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;

const recentLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 30,
  globalMax: 120,
});
const lossLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 10,
  globalMax: 40,
});

/**
 * Rate limiters are opt-in so a deployer can tighten them without a code
 * change; unset means the documented defaults above.
 * @param {string|undefined} envValue
 */
function makeOptIn(envValue, fallback) {
  const max = Number(envValue);
  if (!Number.isFinite(max) || max <= 0) return fallback;
  return makeRateLimiter({
    windowMs: 60_000,
    max: Math.floor(max),
    globalMax: Math.floor(max) * 20,
  });
}

const recentAllow = makeOptIn(
  process.env.GEV_RATELIMIT_STORM_RECENT_PER_MIN,
  recentLimiter,
);
const lossAllow = makeOptIn(
  process.env.GEV_RATELIMIT_STORM_LOSS_PER_MIN,
  lossLimiter,
);

// ---------------------------------------------------------------------------
// SPC daily storm reports
// ---------------------------------------------------------------------------

/** SPC publishes one CSV per day per hazard. Dates are YYMMDD in UTC. */
function spcReportUrl(ymd, hazard) {
  return `https://www.spc.noaa.gov/climo/reports/${ymd}_rpts_${hazard}.csv`;
}

/** Two-digit-year day stamps for today and yesterday in UTC. */
function recentDayStamps(now = new Date()) {
  const stamps = [];
  for (const daysAgo of [0, 1]) {
    const d = new Date(now.getTime() - daysAgo * 86_400_000);
    const yy = String(d.getUTCFullYear()).slice(-2);
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    stamps.push({ ymd: `${yy}${mm}${dd}`, date: d.toISOString().slice(0, 10) });
  }
  return stamps;
}

/** Conversion from miles per hour to knots. */
const MPH_TO_KNOTS = 1 / 1.15078;

/**
 * Parse one SPC daily storm-report CSV.
 *
 * The published format is a header plus one row per report:
 *
 *   hail: Time,Size,Location,County,State,Lat,Lon,Comments
 *   wind: Time,Speed,Location,County,State,Lat,Lon,Comments
 *
 * Three details are easy to get wrong and each corrupts the numbers:
 *  - there is **no date column**; the day comes from the URL stamp,
 *  - hail `Size` is in **hundredths of an inch** (100 = 1.00"), and
 *  - wind `Speed` is in **mph**, while the rest of this app models wind in
 *    knots, and an unknown value is the literal string `UNK`.
 *
 * @param {string} text Raw CSV body.
 * @param {'hail'|'wind'} hazard
 * @param {string} [date] YYYY-MM-DD, from the requested day.
 * @returns {Array<object>}
 */
export function parseSpcDailyReport(text, hazard, date = null) {
  const lines = String(text)
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase();
  if (!header.includes('lat') || !header.includes('lon')) return [];
  const measureKey = hazard === 'hail' ? 'size' : 'speed';
  if (!header.includes(measureKey)) return [];

  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    if (cells.length < 8) continue;
    const [time, measure, location, county, state, latRaw, lonRaw, ...rest] =
      cells;
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat === 0 && lon === 0) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

    const raw = String(measure ?? '').trim();
    const numeric = Number(raw);
    const known = raw !== '' && Number.isFinite(numeric) && numeric > 0;
    const magnitude = known
      ? hazard === 'hail'
        ? // hundredths of an inch -> inches
          Math.round((numeric / 100) * 100) / 100
        : // mph -> knots
          Math.round(numeric * MPH_TO_KNOTS * 10) / 10
      : null;

    out.push({
      hazard,
      date,
      // SPC writes a four-digit HHMM local time.
      time: /^\d{4}$/.test(time ?? '') ? time : null,
      location: location || null,
      county: county || null,
      state: state || null,
      magnitude,
      magnitudeRaw: raw || null,
      magnitudeUnit: hazard === 'hail' ? 'in' : 'kt',
      lat,
      lon,
      comment: rest.join(',').replaceAll('"', '').trim() || null,
    });
  }
  return out;
}

/**
 * Fetch and merge the recent SPC hail and wind reports.
 * @param {{signal?: AbortSignal}} options
 */
async function fetchRecentReports({ signal } = {}) {
  const days = recentDayStamps();
  const reports = [];
  const fetchedDays = [];
  for (const day of days) {
    let dayOk = false;
    for (const hazard of ['hail', 'wind']) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(spcReportUrl(day.ymd, hazard), {
          signal,
          headers: { 'user-agent': 'gods-eye-view/1.0 (storm proxy)' },
        });
        // A 404 just means SPC has not published that hazard for that day yet,
        // which is normal early in the morning and for quiet weather.
        if (!response.ok) {
          try {
            await response.body?.cancel();
          } catch {
            /* best effort */
          }
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const text = await readResponseTextCapped(response, MAX_UPSTREAM_BYTES);
        // eslint-disable-next-line no-await-in-loop
        const parsed = parseSpcDailyReport(text, hazard, day.date);
        if (parsed.length > 0) {
          reports.push(...parsed);
          dayOk = true;
        }
      } catch {
        /* one missing hazard must not fail the other */
      }
    }
    if (dayOk) fetchedDays.push(day.date);
  }
  if (reports.length === 0 && fetchedDays.length === 0) {
    throw new Error('SPC published no recent hail or wind reports');
  }
  // Bound the payload: a prolific outbreak day can produce hundreds of rows.
  return {
    status: 'ready',
    retrievedAt: new Date().toISOString(),
    source: 'NOAA/NWS Storm Prediction Center daily storm reports',
    fetchedDays,
    counts: {
      total: reports.length,
      hail: reports.filter((r) => r.hazard === 'hail').length,
      wind: reports.filter((r) => r.hazard === 'wind').length,
    },
    reports: reports.slice(0, 2000),
  };
}

// ---------------------------------------------------------------------------
// FEMA OpenFEMA realized loss
// ---------------------------------------------------------------------------

const OPENFEMA_ENDPOINT =
  'https://www.fema.gov/api/open/v2/HousingAssistanceOwners';

/**
 * FEMA returns county names with a type suffix ("Aransas (County)"). Strip it
 * so the value can be compared against the bundled Census county names.
 * @param {string} value
 * @returns {string}
 */
export function normalizeFemaCountyName(value) {
  return String(value || '')
    .replace(
      /\s*\((?:County|Parish|Borough|Census Area|Municipality|City and Borough)\)\s*$/i,
      '',
    )
    .trim();
}

/**
 * Reduce OpenFEMA homeowner-assistance rows to county totals.
 *
 * `totalDamage` is FEMA's verified loss for real property plus personal
 * property, excluding transportation assistance. It is a different (generally
 * lower) estimator than SBA's, so the two series must not be summed together.
 *
 * @param {Array<object>} rows Raw OpenFEMA attributes.
 * @returns {Array<object>}
 */
export function aggregateFemaLossByCounty(rows) {
  const byCounty = new Map();
  for (const row of rows || []) {
    const county = normalizeFemaCountyName(row.county);
    const state = String(row.state || '')
      .trim()
      .toUpperCase();
    if (!county || !state) continue;
    const key = `${state}|${county}`;
    const entry = byCounty.get(key) || {
      state,
      county,
      disasters: new Set(),
      totalDamage: 0,
      repairReplace: 0,
      approvedIhp: 0,
      households: 0,
    };
    entry.disasters.add(String(row.disasterNumber));
    const add = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    };
    entry.totalDamage += add(row.totalDamage);
    entry.repairReplace += add(row.repairReplaceAmount);
    entry.approvedIhp += add(row.totalApprovedIhpAmount);
    entry.households += 1;
    byCounty.set(key, entry);
  }
  return [...byCounty.values()]
    .map((entry) => ({
      state: entry.state,
      county: entry.county,
      disasters: entry.disasters.size,
      households: entry.households,
      totalDamage: Math.round(entry.totalDamage),
      repairReplace: Math.round(entry.repairReplace),
      approvedIhp: Math.round(entry.approvedIhp),
    }))
    .sort((a, b) => b.totalDamage - a.totalDamage);
}

/**
 * Page OpenFEMA to completion and aggregate. OpenFEMA caps a response at
 * 10,000 records via `$top` and requires `$skip` paging beyond that; `$allrecords`
 * exists but FEMA may throttle it under load, so this pages explicitly.
 * @param {{signal?: AbortSignal, fromYear?: number}} options
 */
async function fetchFemaLoss({ signal, fromYear = 2002 } = {}) {
  const rows = [];
  const PAGE = 10_000;
  let skip = 0;
  for (let page = 0; page < 25; page += 1) {
    const params = new URLSearchParams({
      $select:
        'disasterNumber,state,county,zipCode,totalDamage,repairReplaceAmount,totalApprovedIhpAmount',
      $top: String(PAGE),
      $skip: String(skip),
      $format: 'json',
    });
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(`${OPENFEMA_ENDPOINT}?${params}`, {
      signal,
      headers: { 'user-agent': 'gods-eye-view/1.0 (storm loss proxy)' },
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* best effort */
      }
      throw new Error(`OpenFEMA HTTP ${response.status}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const payload = await response.json();
    // OData conventionally returns rows under `value`, but OpenFEMA v2 returns
    // them under the entity name. Accept either, and tolerate a payload that is
    // an error object with a 200 status.
    const batch = Array.isArray(payload)
      ? payload
      : (payload?.value ?? payload?.HousingAssistanceOwners ?? []);
    rows.push(...batch);
    if (batch.length < PAGE) break;
    skip += PAGE;
  }
  if (rows.length === 0)
    throw new Error('OpenFEMA returned no homeowner assistance rows');
  const counties = aggregateFemaLossByCounty(rows);
  return {
    status: 'ready',
    retrievedAt: new Date().toISOString(),
    source: 'FEMA OpenFEMA HousingAssistanceOwners v2 (Individual Assistance)',
    caveat:
      'FEMA verified homeowner damage from Individual Assistance registrations. It is a different, generally lower estimator than SBA disaster loan figures and the two must not be summed. Not official for federal reporting.',
    fromYear,
    recordCount: rows.length,
    countyCount: counties.length,
    counties: counties.slice(0, 5000),
  };
}

// ---------------------------------------------------------------------------
// Cache + middleware
// ---------------------------------------------------------------------------

async function readDisk(name, maxAgeMs) {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, name), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.cachedAt || Date.now() - parsed.cachedAt > maxAgeMs)
      return null;
    return parsed.payload;
  } catch {
    return null;
  }
}

async function writeDisk(name, payload) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(
      path.join(CACHE_DIR, name),
      JSON.stringify({ cachedAt: Date.now(), payload }),
    );
  } catch {
    /* the cache is an optimisation, never a requirement */
  }
}

function install(middlewares) {
  middlewares.use('/api/storm-recent', async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }
    if (!recentAllow(clientKey(req))) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '30',
      });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return;
    }
    const cached = await readDisk('storm-recent.json', RECENT_CACHE_MS);
    if (cached) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120',
        'X-Storm-Recent': 'HIT',
      });
      res.end(JSON.stringify({ ...cached, status: 'cached' }));
      return;
    }
    try {
      const request = coalesceProxyRequest(inFlightRecent, 'recent', () =>
        fetchRecentReports({}),
      );
      const payload = await request.promise;
      await writeDisk('storm-recent.json', payload);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120',
        'X-Storm-Recent': request.shared ? 'INFLIGHT' : 'MISS',
      });
      res.end(JSON.stringify(payload));
    } catch {
      const stale = await readDisk('storm-recent.json', RECENT_STALE_MS);
      if (stale) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Storm-Recent': 'STALE',
        });
        res.end(JSON.stringify({ ...stale, status: 'stale' }));
        return;
      }
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          error: 'Recent storm reports are temporarily unavailable',
        }),
      );
    }
  });

  middlewares.use('/api/storm-loss', async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }
    if (!lossAllow(clientKey(req))) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '60',
      });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return;
    }
    const url = new URL(req.url || '', 'http://localhost');
    const limit = clampInt(url.searchParams.get('limit') || '', 1, 5000, 500);
    const cached = await readDisk('storm-loss.json', LOSS_CACHE_MS);
    if (cached) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
        'X-Storm-Loss': 'HIT',
      });
      res.end(
        JSON.stringify({
          ...cached,
          status: 'cached',
          counties: cached.counties.slice(0, limit),
        }),
      );
      return;
    }
    try {
      const request = coalesceProxyRequest(inFlightLoss, 'loss', () =>
        fetchFemaLoss({}),
      );
      const payload = await request.promise;
      await writeDisk('storm-loss.json', payload);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
        'X-Storm-Loss': request.shared ? 'INFLIGHT' : 'MISS',
      });
      res.end(
        JSON.stringify({
          ...payload,
          counties: payload.counties.slice(0, limit),
        }),
      );
    } catch {
      const stale = await readDisk('storm-loss.json', LOSS_STALE_MS);
      if (stale) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Storm-Loss': 'STALE',
        });
        res.end(
          JSON.stringify({
            ...stale,
            status: 'stale',
            counties: stale.counties.slice(0, limit),
          }),
        );
        return;
      }
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          error: 'Realized loss data is temporarily unavailable',
        }),
      );
    }
  });
}

const inFlightRecent = new Map();
const inFlightLoss = new Map();

/** Register the storm proxies with the dev/preview server. */
export function stormRecentProxy() {
  return {
    name: 'storm-recent-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { fetchRecentReports, fetchFemaLoss };

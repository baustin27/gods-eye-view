import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { filterTrailing24h, parseFirmsCsv } from '../../src/data/firmsCsv.js';
import {
  parseRegionParam,
  regionToFirmsBbox,
  regionToQueryParam,
} from '../../src/data/dataScope.js';

/**
 * NASA FIRMS live active-fire proxy with a memory + disk cache.
 * Upstream: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/world/2
 *
 * Merges three VIIRS NRT sources (NOAA-20, NOAA-21, Suomi-NPP — independent
 * satellites, no cross-source dedup) plus MODIS_NRT (combined Terra+Aqua,
 * ~1 km, numeric 0-100 confidence), fetched sequentially (quota courtesy)
 * with `days=2` (`days=1` means "current UTC day", nearly empty just after
 * 00:00Z) and clamps to the trailing 24 h via src/data/firmsCsv.js. FIRMS
 * quota is 5,000 transactions / 10 min per MAP_KEY, so the cache is the point:
 * TTL 30 min, single-flight refresh, serve-stale-on-failure, and a
 * fresh-enough disk cache (.gev-cache/firms.json) prevents ANY upstream
 * fetch across dev-server restarts. Pattern mirrors celestrakProxy.
 *
 * Routes:
 *   GET /api/firms        → {fetchedAt, stale, ttlMs, sources, count, fires}
 *   GET /api/firms/status → {hasKey, lastFetch, count, stale, ttlMs, transactions}
 *
 * Keyless (no FIRMS_MAP_KEY): /api/firms → 503 {error:'no_key'}; status →
 * {hasKey:false}. Upstream is never touched without a key.
 *
 * @returns {import('vite').Plugin}
 */
export function firmsProxy() {
  const TTL_MS = 30 * 60_000;
  const STATUS_TTL_MS = 5 * 60_000;
  const SOURCES = [
    'VIIRS_NOAA20_NRT',
    'VIIRS_NOAA21_NRT',
    'VIIRS_SNPP_NRT',
    'MODIS_NRT',
  ];
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'firms.json');

  /**
   * Caches are keyed by region. '' is the whole-world entry, which is what
   * global scope asks for and the only one written to disk.
   *
   * A viewport scope produces many keys over a session, so the map is bounded
   * and evicts least-recently-used: an unbounded one would pin every provider
   * response the user ever panned across until the dev server restarted.
   */
  const REGION_CACHE_MAX = 8;
  /** @type {Map<string, {at: number, sources: Array<object>, fires: Array<object>}>} */
  const byRegion = new Map();
  /** @type {Map<string, Promise<{at:number,sources:Array<object>,fires:Array<object>}>>} */
  const inflightByRegion = new Map();
  /** World entry only: the disk cache's whole job is surviving a restart. */
  /** @type {?{at: number, sources: Array<object>, fires: Array<object>}} */
  let diskChecked = false;
  /** @type {?{at: number, transactions: ?{used: number, limit: number}}} mapkey_status cache */
  let statusCache = null;
  /** @type {?Promise<?{used: number, limit: number}>} */
  let statusInflight = null;

  const WORLD_REGION = '';

  function cachedFor(regionKey) {
    return byRegion.get(regionKey) ?? null;
  }

  function rememberRegion(regionKey, entry) {
    byRegion.delete(regionKey);
    byRegion.set(regionKey, entry);
    while (byRegion.size > REGION_CACHE_MAX) {
      const oldest = byRegion.keys().next().value;
      if (oldest === regionKey) break;
      byRegion.delete(oldest);
    }
  }

  const mapKey = () => String(process.env.FIRMS_MAP_KEY || '').trim();

  /**
   * Cache key (`south,west,north,east`) → FIRMS area segment
   * (`west,south,east,north`). Returns '' for a world request.
   */
  function firmsAreaSegment(region) {
    if (!region) return '';
    const parts = region.split(',').map(Number);
    if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return '';
    const [south, west, north, east] = parts;
    return regionToFirmsBbox({ south, west, north, east });
  }

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (
        Number.isFinite(parsed?.at) &&
        Array.isArray(parsed?.sources) &&
        Array.isArray(parsed?.fires)
      ) {
        // The disk file only ever holds the world pull, so stamp its region
        // rather than trusting an absent field.
        byRegion.set(WORLD_REGION, { ...parsed, region: WORLD_REGION });
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[firms-proxy] cache write failed:', err?.message || err);
    }
  }

  /**
   * Fetch + parse one FIRMS source. Throws on HTTP error or a non-CSV body
   * (FIRMS reports errors as HTML/plain text, never CSV). Never log the URL —
   * it embeds the MAP_KEY.
   *
   * `region` is the CACHE KEY form (`south,west,north,east`), not the URL
   * segment: FIRMS orders its area longitude-first and 400s on a
   * latitude-first string, so the reorder happens at the last moment.
   */
  async function fetchSource(key, source, region) {
    const area = firmsAreaSegment(region) || 'world';
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/${area}/2`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = parseFirmsCsv(await res.text());
    if (records === null) throw new Error('non-CSV upstream response');
    return records;
  }

  /**
   * Refresh all sources sequentially (quota courtesy — never in parallel).
   * Partial success (≥1 source ok) still produces a cacheable entry with the
   * failed sources marked ok:false; total failure throws so the caller can
   * serve stale.
   */
  async function refreshUpstream(key, region) {
    const now = Date.now();
    const sources = [];
    const fires = [];
    for (const source of SOURCES) {
      try {
        const records = filterTrailing24h(
          await fetchSource(key, source, region),
          now,
        );
        // NOT fires.push(...records): spread passes each record as an argument,
        // and a world/2 VIIRS pull exceeds V8's argument limit (~125k) at
        // ~131k records — RangeError, and the whole source is silently dropped.
        for (const record of records) fires.push(record);
        sources.push({ source, count: records.length, ok: true });
      } catch (err) {
        console.warn(
          `[firms-proxy] ${source} fetch failed:`,
          err?.message || err,
        );
        sources.push({ source, count: 0, ok: false });
      }
    }
    if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
    // Stamp the region so buildPayload can tell a scoped answer from a world
    // one. Without it every response would echo '' and a client could not
    // tell which box it actually received.
    return { at: now, sources, fires, region };
  }

  /**
   * Cache entry → response payload. Fires are RE-filtered to the trailing
   * 24 h at serve time so a stale cache never serves >24h-old detections.
   */
  function buildPayload(entry, stale) {
    const fires = filterTrailing24h(entry.fires, Date.now());
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      // Echoed so a client can tell a global answer from a scoped one, and so
      // a stale entry served during an upstream failure is not mistaken for the
      // region that was asked for.
      region: entry.region || WORLD_REGION,
      sources: entry.sources,
      count: fires.length,
      fires,
    };
  }

  /** mapkey_status transactions, cached 5 min, best-effort (null on failure). */
  function getTransactions(key) {
    const now = Date.now();
    if (statusCache && now - statusCache.at < STATUS_TTL_MS) {
      return Promise.resolve(statusCache.transactions);
    }
    if (!statusInflight) {
      statusInflight = (async () => {
        try {
          const url = `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          const used = Number(body?.current_transactions);
          const limit = Number(body?.transaction_limit);
          return Number.isFinite(used) && Number.isFinite(limit)
            ? { used, limit }
            : null;
        } catch (err) {
          console.warn(
            '[firms-proxy] mapkey status failed:',
            err?.message || err,
          );
          return null;
        }
      })()
        .then((transactions) => {
          statusCache = { at: Date.now(), transactions };
          return transactions;
        })
        .finally(() => {
          statusInflight = null;
        });
    }
    return statusInflight;
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/firms', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const subPath = String(req.url || '').split('?')[0];
        const regionResult = parseRegionParam(
          req.url
            ? new URL(req.url, 'http://localhost').searchParams.get('bbox')
            : null,
        );
        if (!regionResult.ok) {
          sendJson(400, { error: regionResult.error });
          return;
        }
        // The cache key and the FIRMS area segment are both this 4-decimal
        // query form; '' means the whole-world pull.
        const region = regionToQueryParam(regionResult.region);
        const key = mapKey();
        await readDiskOnce();

        if (subPath === '/status') {
          if (!key) {
            sendJson(200, {
              hasKey: false,
              lastFetch: null,
              count: null,
              stale: false,
              ttlMs: TTL_MS,
              transactions: null,
            });
            return;
          }
          const transactions = await getTransactions(key);
          const world = cachedFor(WORLD_REGION);
          sendJson(200, {
            hasKey: true,
            lastFetch: world ? world.at : null,
            count: world ? world.fires.length : null,
            stale: world ? Date.now() - world.at >= TTL_MS : false,
            ttlMs: TTL_MS,
            transactions,
          });
          return;
        }

        if (!key) {
          sendJson(503, { error: 'no_key' });
          return;
        }

        const entry = cachedFor(region);
        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload(entry, false));
          return;
        }
        // Stale or missing → refresh, single-flight per region (concurrent
        // requests for the same box share one upstream pass; a different box is
        // a different pass, which is the point). Capture the promise from the
        // map BEFORE awaiting: the .finally() deletes it the moment it settles.
        if (!inflightByRegion.has(region)) {
          inflightByRegion.set(
            region,
            refreshUpstream(key, region)
              .then(async (fresh) => {
                rememberRegion(region, fresh);
                // Only the world entry is durable. A viewport region's cache is
                // worthless across a restart — the camera is elsewhere by then.
                if (!region) await writeDisk(fresh);
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[firms-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
                );
                return null;
              })
              .finally(() => {
                inflightByRegion.delete(region);
              }),
          );
        }
        const pending = inflightByRegion.get(region);
        const fresh = await pending;
        if (fresh) {
          sendJson(200, buildPayload(fresh, false));
        } else if (entry) {
          sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
        } else {
          sendJson(502, {
            error: 'firms fetch failed and no cache available',
          });
        }
      } catch (err) {
        console.warn('[firms-proxy] error:', err?.message || err);
        sendJson(500, { error: 'firms proxy error' });
      }
    });
  };
  return {
    name: 'firms-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

/**
 * Network + parsing helpers shared by the snapshot ETL scripts.
 *
 * Every upstream download is cached on disk under `.gev-cache/build/` so a
 * re-run never re-hammers NOAA, Census, or FEMA. Pass `--refresh` to force a
 * fresh copy.
 *
 * @module scripts/lib/storm-fetch
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const PROJECT_ROOT = path.resolve(process.env.GEV_PROJECT_ROOT || TOOL_ROOT);
const CACHE_DIR = path.join(PROJECT_ROOT, '.gev-cache', 'build');
const USER_AGENT =
  'gods-eye-view/1.0 (snapshot ETL; +https://github.com/gods-eye-view)';

let refresh = false;

/** Force every fetch in this process to bypass the on-disk cache. */
export function setRefresh(value) {
  refresh = Boolean(value);
}

function cachePathFor(url) {
  const slug = url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .slice(0, 150);
  return path.join(CACHE_DIR, `${slug}.bin`);
}

/**
 * Fetch a URL through the on-disk build cache.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
export async function fetchBuffer(url) {
  const file = cachePathFor(url);
  if (!refresh) {
    try {
      return await fs.readFile(file);
    } catch {
      /* fall through to network */
    }
  }
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) {
    // Trim the URL: ArcGIS GET queries carry hundreds of objectIds and an
    // untrimmed failure message is unreadable in a log.
    const shown =
      url.length > 300 ? `${url.slice(0, 300)}…[+${url.length - 300}]` : url;
    throw new Error(`HTTP ${res.status} for ${shown}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(file, body);
  return body;
}

/**
 * Fetch and decode a JSON document.
 * @param {string} url
 * @returns {Promise<any>}
 */
export async function fetchJson(url) {
  const body = await fetchBuffer(url);
  return JSON.parse(body.toString('utf8'));
}

/**
 * Poll an async task until it returns a truthy value, with a bounded wait.
 * @template T
 * @param {() => Promise<T|null>} task
 * @param {{attempts?: number, delayMs?: number, label?: string}} [options]
 * @returns {Promise<T>}
 */
export async function retry(
  task,
  { attempts = 5, delayMs = 2000, label = 'task' } = {},
) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const value = await task();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (i < attempts - 1) {
      process.stdout.write(`  … ${label} retry ${i + 1}/${attempts - 1}\n`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError || new Error(`${label} produced no value`);
}

/**
 * Parse one RFC 4180 CSV record, honouring double-quote escaping.
 * @param {string} line
 * @returns {string[]}
 */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parse a CSV text into header-keyed objects. Tolerates CRLF and a trailing
 * newline, and never allocates more than `maxRows` records.
 * @param {string} text
 * @param {number} [maxRows=Infinity]
 * @returns {Array<Object<string,string>>}
 */
export function parseCsv(text, maxRows = Infinity) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length && rows.length < maxRows; i += 1) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length !== header.length) continue;
    const row = {};
    for (let c = 0; c < header.length; c += 1) row[header[c]] = cells[c];
    rows.push(row);
  }
  return rows;
}

/**
 * Round a coordinate to a fixed grid step, returning a stable integer key.
 * Using Math.round on the scaled value keeps neighbouring coordinates in the
 * same bucket even across floating-point noise.
 * @param {number} value
 * @param {number} step
 * @returns {number}
 */
export function gridIndex(value, step) {
  // Floor, not round. The emitted cell centre is `index * step + step / 2`,
  // which only lines up with the value that was bucketed under floor semantics.
  // Rounding shifted every report half a cell (~14 km) north and east of the
  // cell it was attributed to, and disagreed with the radar grid — which floors
  // — by exactly that half cell, so the two could not be joined on `i,j`.
  return Math.floor(value / step);
}

/**
 * Write a GeoJSONL snapshot atomically, one feature per line.
 * @param {string} file Absolute destination path.
 * @param {Array<object>} features
 * @param {(f: object) => object} [serialize]
 */
export async function writeGeoJsonl(file, features, serialize = (f) => f) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const chunks = [];
  for (const feature of features) {
    chunks.push(`${JSON.stringify(serialize(feature))}\n`);
  }
  await fs.writeFile(tmp, chunks.join(''));
  await fs.rename(tmp, file);
  const { size } = await fs.stat(file);
  return size;
}

/**
 * Print a labelled ETL progress line.
 * @param {string} message
 */
export function step(message) {
  process.stdout.write(`[storm-etl] ${message}\n`);
}

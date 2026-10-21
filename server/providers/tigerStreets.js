/**
 * TIGER street addresses, for the Hail Desk's knock list.
 *
 * WHAT THIS IS. The Census Bureau's "Edges" file for a county carries, for
 * every street segment: the street NAME, the house-number range on each side,
 * and the ZIP on each side. That is a knock list - "Federal Blvd 5201-5299,
 * ZIP 80221" - without a single byte of paid data.
 *
 * The separate Address Range File (ADDR) is not needed: the address ranges
 * are already on the edges, per side, with the ZIP. One file per county
 * instead of two, and no join to get wrong.
 *
 * WHAT THIS IS NOT. It is not an owner list. There are no names, no phone
 * numbers, no emails - those are commercial data (Cole Information, OneClick
 * Code) and nothing here pretends otherwise. A canvasser gets a street and a
 * house-number range and knocks on the doors they can see.
 *
 * KEYLESS. The Census publishes these files on a public bucket with no
 * account and no key. The first request for a county downloads it; after
 * that it is served from disk.
 *
 * Routes:
 *   GET /api/desk/streets?state=08&county=031&zip=80202
 *     → {state, county, zip, count, houses, streets}
 *
 * THE GEOMETRY. The EDGES file also carries the LINE each edge describes, in
 * the `.shp` inside the same zip. It is read here rather than fetched
 * separately because it is what turns "how many addresses on this street" into
 * "how many of them were under the hail" - a street is a line and a hail cell
 * is an area, and without the line the two cannot be compared.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** Where the downloaded county files live. */
const CACHE_DIR = process.env.GEV_TIGER_CACHE
  ? path.resolve(process.env.GEV_TIGER_CACHE)
  : path.join(REPO, '.gev-cache', 'tiger');

/** The vintage of the TIGER line files. */
const TIGER_YEAR = 2024;

/**
 * How long a cached county file is trusted.
 *
 * A TIGER vintage is immutable - the 2024 files for a county are replaced
 * when a new vintage is published, not edited in place - so the cache can
 * live for the life of the process. The year is part of the filename, so a
 * new vintage is a new file and the old one simply stops being asked for.
 */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The number of house numbers a range implies.
 *
 * The range is inclusive at both ends, and the parity of the endpoints says
 * which side of the street the numbers sit on: an even-to-odd range is one
 * side, an odd-to-even range is the other. So the count is the number of
 * ADDRESSES in the range, not of households.
 *
 * It is NOT the number of houses on that street, and the difference is not
 * small. A TIGER edge's range runs the whole stretch of line the edge covers,
 * which can be several blocks, so summing a street's segment ranges
 * over-counts, and an edge that crosses a ZIP boundary keeps the range it
 * had. Measured against the Census on Denver's 80207: the ranges sum to
 * 105,959 addresses against an ACS count of 9,291 HOUSING UNITS.
 *
 * So this number is reported as what it is - the addresses in this range -
 * and the number of HOUSES in a ZIP comes from the Census, which is the only
 * source of it. The two are never added together.
 */
function addressCount(from, to) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.floor((b - a) / 2) + 1;
}

/**
 * The cached EDGES file for a county, downloaded if it is not there.
 * @param {string} state two-digit state FIPS
 * @param {string} county three-digit county FIPS
 * @returns {Promise<string>} the path to the zip
 */
export async function countyEdgesPath(state, county) {
  const name = `tl_${TIGER_YEAR}_${state}${county}_edges.zip`;
  const file = path.join(CACHE_DIR, name);
  const stat = (() => {
    try {
      return fs.statSync(file);
    } catch {
      return null;
    }
  })();
  if (stat && Date.now() - stat.mtimeMs < CACHE_TTL_MS) return file;
  await fs.promises.mkdir(CACHE_DIR, { recursive: true });
  const url = `https://www2.census.gov/geo/tiger/TIGER${TIGER_YEAR}/EDGES/${name}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`TIGER EDGES ${response.status} for ${name}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const temp = `${file}.tmp`;
  await fs.promises.writeFile(temp, bytes);
  await fs.promises.rename(temp, file);
  return file;
}

/**
 * Parse a DBF into plain objects.
 *
 * Deliberately small and local: the repo's own readers live under
 * `scripts/lib`, and a server provider importing build tooling is the wrong
 * dependency direction. The format is fixed-width and the fields are ASCII.
 */
function parseDbf(buffer) {
  const recordCount = buffer.readInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  for (let at = 32; buffer[at] !== 0x0d; at += 32) {
    fields.push({
      name: buffer.toString('latin1', at, at + 11).replace(/\0.*$/, ''),
      length: buffer[at + 16],
    });
  }
  const rows = [];
  for (let r = 0; r < recordCount; r += 1) {
    let at = headerLength + r * recordLength + 1;
    const row = {};
    for (const field of fields) {
      row[field.name] = buffer.toString('utf8', at, at + field.length).trim();
      at += field.length;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The streets of one county, with their address ranges and ZIPs.
 *
 * @param {string} state two-digit state FIPS
 * @param {string} county three-digit county FIPS
 * @param {string} [zip] only this ZIP, if given
 * @returns {Promise<Array<object>>}
 */
export async function countyStreets(state, county, zip) {
  const streets = await countyEdges(state, county, zip);
  // The geometry is for the server's own arithmetic and is not sent to the
  // browser: a county's edges are hundreds of thousands of coordinates, and
  // the client has no use for them.
  return streets.map(({ points, ...rest }) => rest);
}

/**
 * The streets of one county, WITH the line each one describes.
 *
 * The `.shp` and the `.dbf` inside the EDGES zip hold one record per edge in
 * the SAME order, and the join between them is by position - there is no key
 * to join on. That makes the record counts a load-bearing check rather than a
 * formality: if the two files disagree about how many edges they have, every
 * street after the divergence is attached to the wrong line, and the hail
 * lands on the wrong streets with nothing reporting an error.
 *
 * @param {string} state two-digit state FIPS
 * @param {string} county three-digit county FIPS
 * @param {string} [zip] only this ZIP, if given
 * @returns {Promise<Array<object>>} each with a `points` flat [lon, lat, ...]
 */
/**
 * The county's EDGES records and their geometry, parsed.
 *
 * This is the HALF of {@link countyEdges} that does the expensive work, and
 * it is exported because the desk's MAP needs it for a different reason than
 * the knock list does.
 *
 * `countyEdges()` returns one object per street SIDE and drops every edge
 * whose side has no address range - which on Douglas County is 2,468 of the
 * 6,671 named centrelines, so 63% of the county's streets are missing from
 * it. A map of a county with 63% of its streets missing is not a map, so the
 * map is cut from THESE records: one line per named centreline, whether or
 * not anybody has a house number for it.
 *
 * @param {string} state two-digit state FIPS
 * @param {string} county three-digit county FIPS
 * @returns {Promise<{rows: Array<object>, shapes: object, file: string,
 *   mtimeMs: number, size: number}>}
 */
export async function countyEdgeRecords(state, county) {
  const file = await countyEdgesPath(state, county);
  const { readZipEntries, readShapefile } = await import(
    path.join(REPO, 'scripts/lib/binary-geo.mjs')
  );
  let entries = readZipEntries(fs.readFileSync(file));
  if (!entries || !entries.size) throw new Error('TIGER EDGES file is empty');
  const member = [...entries.keys()].find((name) =>
    name.endsWith('_edges.dbf'),
  );
  if (!member) throw new Error(`TIGER EDGES for ${state}${county} has no dbf`);
  let rows;
  try {
    rows = parseDbf(entries.get(member));
  } catch (error) {
    // A download interrupted half way leaves a TRUNCATED zip, and a truncated
    // zip reads as an empty one rather than as an error. So the cached file is
    // thrown away and fetched again, once, before the failure is reported.
    await fs.promises.rm(file, { force: true });
    const refetched = await countyEdgesPath(state, county);
    entries = readZipEntries(fs.readFileSync(refetched));
    const freshMember = [...entries.keys()].find((name) =>
      name.endsWith('_edges.dbf'),
    );
    if (!freshMember)
      throw new Error(`TIGER EDGES for ${state}${county} has no dbf`);
    rows = parseDbf(entries.get(freshMember));
  }

  // The geometry. The `.shp` is read from the same archive, and the two files
  // are read from the SAME buffer so that a retry cannot mix a fresh `.shp`
  // with a stale `.dbf`.
  const shpMember = [...entries.keys()].find((name) =>
    name.endsWith('_edges.shp'),
  );
  let shapes = { records: [] };
  if (shpMember) {
    try {
      shapes = readShapefile(entries.get(shpMember));
    } catch {
      shapes = { records: [] };
    }
  }
  if (shapes.records.length && shapes.records.length !== rows.length) {
    throw new Error(
      `TIGER EDGES for ${state}${county} has ${rows.length} attribute rows ` +
        `and ${shapes.records.length} shapes; they cannot be joined.`,
    );
  }
  // The archive's mtime and size are the INDEX KEY: a re-downloaded archive -
  // which happens when a truncated one is thrown away and fetched again -
  // changes them, and a tile index built from the old one would be serving
  // streets that are no longer there.
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }
  return {
    rows,
    shapes,
    file,
    mtimeMs: stat?.mtimeMs ?? 0,
    size: stat?.size ?? 0,
  };
}

export async function countyEdges(state, county, zip) {
  const { rows, shapes } = await countyEdgeRecords(state, county);
  const wanted = String(zip || '').trim();
  const streets = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const name = row.FULLNAME;
    if (!name) continue;
    const points = shapes.records.length
      ? edgePoints(shapes.records[index])
      : [];
    for (const side of ['L', 'R']) {
      const from = row[`${side}FROMADD`];
      const to = row[`${side}TOADD`];
      // ZIPL and ZIPR, NOT LIP and RIP. The side prefix goes on the FRONT of
      // ZIP and on the BACK of FROMADD - so the two are spelled differently,
      // which is exactly the kind of thing that returns zero streets and
      // looks like an empty county.
      const rowZip = row[`ZIP${side}`];
      if (!from || !to) continue;
      if (wanted && rowZip !== wanted) continue;
      const count = addressCount(from, to);
      if (!count) continue;
      streets.push({
        name,
        from: Number(from),
        to: Number(to),
        zip: rowZip,
        side,
        addresses: count,
        points,
      });
    }
  }
  streets.sort(
    (a, b) =>
      b.addresses - a.addresses ||
      a.name.localeCompare(b.name) ||
      a.from - b.from,
  );
  return streets;
}

/**
 * The vertices of one edge, as a flat [lon, lat, ...] list.
 *
 * An edge is normally a single part. The few with more are joined end to
 * end, and the shared vertex between two parts is dropped once so the line
 * does not double back on itself at the join.
 *
 * @param {{parts: number[][]}} record
 * @returns {number[]}
 */
function edgePoints(record) {
  const parts = record?.parts || [];
  if (!parts.length) return [];
  const out = [];
  for (const part of parts) {
    if (!part || part.length < 4) continue;
    const start = out.length ? 2 : 0;
    for (let at = start; at < part.length; at += 2) {
      out.push(part[at], part[at + 1]);
    }
  }
  return out;
}

/**
 * The Vite plugin that serves the street list.
 *
 * The same payload the desk's own server answers with, so the app sees one
 * shape in development and in the built app. The handler is imported lazily
 * because the hail join pulls in the storm loader, and the plugin is loaded
 * by the globe's dev server too - which has no business paying for it.
 *
 * @returns {import('vite').Plugin}
 */
export function tigerStreetsPlugin() {
  return {
    name: 'gev-desk-streets',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/desk/streets')) return next();
        try {
          const url = new URL(req.url, 'http://localhost');
          const { streetsPayload } = await import('./hailStreets.js');
          const payload = await streetsPayload({
            state: url.searchParams.get('state') || '',
            county: url.searchParams.get('county') || '',
            zip: url.searchParams.get('zip') || '',
            day: url.searchParams.get('day') || '',
            thresholdMm: url.searchParams.get('thresholdMm') || '',
            tract: url.searchParams.get('tract') || '',
          });
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(payload));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    },
  };
}

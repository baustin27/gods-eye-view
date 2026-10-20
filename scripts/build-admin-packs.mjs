#!/usr/bin/env node
/**
 * Build the bundled administrative-boundary packs read by
 * `src/data/adminBoundaries.js`, and the populated-places point pack read by
 * `src/data/places.js`:
 *
 *   src/data/local_data/natural_earth/states_provinces.json
 *     Natural Earth 10m admin-1 states and provinces (public domain).
 *   src/data/local_data/us_census_counties/counties.json
 *     US Census Bureau cartographic boundary counties (public domain).
 *   src/data/local_data/natural_earth/places.json
 *     Natural Earth 10m populated places — points, not outlines (public domain).
 *
 * Every source is pinned by URL and SHA-256, so a rerun reproduces the packs
 * byte for byte. Downloads are cached outside the repository (default: the
 * system temp directory) and are never committed. `ne_10m_populated_places`
 * is read twice by the same run — once to mark ambiguous state names, once to
 * build the place pack — and the second read is a local cache hit.
 *
 * Usage:
 *   node scripts/build-admin-packs.mjs [--cache <dir>] [--only countries|admin1|counties|places]
 *
 * The provenance READMEs beside each pack record these parameters.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { normalizeAdminName } from '../src/data/adminBoundaries.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NE_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const NE_BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_COMMIT}/geojson`;

export const SOURCES = Object.freeze({
  countries: {
    url: `${NE_BASE}/ne_10m_admin_0_countries.geojson`,
    sha256: '239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255',
  },
  mapUnits: {
    url: `${NE_BASE}/ne_10m_admin_0_map_units.geojson`,
    sha256: '57da82be755f4afccd8f3b14251bb2752f5df1395f47d2d86f817470c4a48862',
  },
  admin1: {
    url: `${NE_BASE}/ne_10m_admin_1_states_provinces.geojson`,
    sha256: '22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5',
  },
  places: {
    url: `${NE_BASE}/ne_10m_populated_places_simple.geojson`,
    sha256: 'fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f',
  },
  counties: {
    url: 'https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_county_5m.zip',
    sha256: 'faec522080681e79be5be435c981009a77891206ff8a7f1d142f3bf5da9ebd74',
  },
  // Census PLACE boundaries: cities, towns and CDPs. They are what a
  // canvasser works in - "the town" is the unit of a day - and the globe used
  // to approximate a city with a 0.25-degree BOX because no city boundary
  // shipped with these bundles. It now can be exact.
  censusPlaces: {
    url: 'https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_place_500k.zip',
    sha256: '27562072c8e7890cafa6b3ac7a44e5e394b34da210501b48500052bc56b8a18d',
  },
});

/**
 * Pack parameters. The Douglas-Peucker tolerance scales with the unit's size
 * (`toleranceFactor` × √area, clamped to `[minToleranceDeg, maxToleranceDeg]`)
 * because a unit is viewed at a zoom that fits it: Texas keeps ~2 km detail,
 * Bavaria ~1 km, Travis County ~150 m. Parts smaller than `minPartKm2` or than
 * `minPartShare` of the largest part are dropped (the largest part always
 * stays); holes under `minHoleKm2` are dropped.
 */
export const PARAMS = Object.freeze({
  countries: {
    toleranceFactor: 0.004,
    minToleranceDeg: 0.005,
    maxToleranceDeg: 0.02,
    decimals: 3,
    minPartKm2: 20,
    minPartShare: 0.00003,
    minHoleKm2: 20,
  },
  admin1: {
    toleranceFactor: 0.004,
    minToleranceDeg: 0.005,
    maxToleranceDeg: 0.02,
    decimals: 3,
    minPartKm2: 20,
    minPartShare: 0.0003,
    minHoleKm2: 20,
  },
  counties: {
    toleranceFactor: 0.003,
    minToleranceDeg: 0.0005,
    maxToleranceDeg: 0.01,
    decimals: 4,
    minPartKm2: 1,
    minPartShare: 0.001,
    minHoleKm2: 1,
  },
  // City and town boundaries. Finer than the counties on purpose: a place is
  // a neighbourhood, not a region, and the whole point of having a boundary
  // rather than a box is that the edge lands on the edge of the town.
  // `minPartKm2` is a square kilometre because a CDP can be a hamlet.
  censusPlaces: {
    toleranceFactor: 0.002,
    minToleranceDeg: 0.0002,
    maxToleranceDeg: 0.006,
    decimals: 4,
    minPartKm2: 0.15,
    minPartShare: 0.001,
    minHoleKm2: 0.15,
  },
  // A bare admin-1 name is marked ambiguous — the resolver then lets a
  // geocoder decide — when it is also a country, the name of a city of at
  // least `insideMinPopulation` inside the unit's box ("New York", "Madrid"),
  // or the name of a city of at least `elsewhereMinPopulation` outside it
  // ("Santa Fe", "Victoria"). A unit no larger than `cityStateMaxKm2` whose
  // own city lies inside is the city itself (Berlin, Vienna, Paris): it is
  // marked `cityState` and may be named alone however small.
  ambiguity: {
    insideMinPopulation: 200_000,
    elsewhereMinPopulation: 50_000,
    cityStateMaxKm2: 1_000,
  },
  // A point pack, so none of the geometry rules apply. Natural Earth's
  // `ne_10m_populated_places_simple` holds 7,342 rows spanning megacities down
  // to single-farm settlements, and two rows whose `pop_max` is Natural Earth's
  // `-99` "population unknown" sentinel. `minPopulation` drops the small end —
  // a few hundred people is a village, not somewhere anyone isolates to —
  // while keeping every county seat of a small county, so a rural map is not
  // left empty: at 5,000 the pack holds 6,488 of the 7,340 real rows and 668
  // of the 769 US ones. A national capital is kept however small
  // (`keepNationalCapitals`): Vatican City has 832 people in this data and is
  // still a place people name. `decimals` rounds the point (3 ≈ 110 m, far
  // finer than any city isolation).
  places: {
    minPopulation: 5_000,
    keepNationalCapitals: true,
    decimals: 3,
  },
});

const args = process.argv.slice(2);
const cacheDir = path.resolve(
  args.includes('--cache')
    ? args[args.indexOf('--cache') + 1]
    : path.join(os.tmpdir(), 'gev-admin-packs'),
);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

async function fetchPinned(name) {
  const { url, sha256 } = SOURCES[name];
  const file = path.join(cacheDir, path.basename(new URL(url).pathname));
  let bytes = await readFile(file).catch(() => null);
  if (!bytes) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, bytes);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256)
    throw new Error(
      `${name}: SHA-256 ${digest} does not match the pinned ${sha256}`,
    );
  return { bytes, digest };
}

// ── geometry ────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** Spherical ring area (km²); matches src/data/naturalEarthRegions.js. */
function ringAreaKm2(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % n];
    sum +=
      toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/** Signed planar (shoelace) area: positive counter-clockwise in lon/lat. */
function signedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return sum / 2;
}

function segDist(p, a, b) {
  let [x, y] = p;
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x -= x2;
      y -= y2;
      return Math.hypot(x, y);
    }
    if (t > 0) {
      x -= x1 + dx * t;
      y -= y1 + dy * t;
      return Math.hypot(x, y);
    }
  }
  return Math.hypot(x - x1, y - y1);
}

/** Iterative Douglas-Peucker over an open point list. */
function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDist(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tolerance && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Simplify a closed ring to an OPEN rounded ring. The ring is split at its
 * farthest vertex from the start so Douglas-Peucker has two anchored halves
 * (a closed ring has no chord to measure against). Returns null when fewer
 * than four distinct vertices survive.
 */
function simplifyRing(ring, tolerance, decimals) {
  let open = ring.slice();
  const first = open[0];
  const last = open[open.length - 1];
  if (open.length > 1 && first[0] === last[0] && first[1] === last[1])
    open = open.slice(0, -1);
  if (open.length < 4) return null;
  let far = 1;
  let farDist = -1;
  for (let i = 1; i < open.length; i++) {
    const d = Math.hypot(open[i][0] - first[0], open[i][1] - first[1]);
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  const a = douglasPeucker(open.slice(0, far + 1), tolerance);
  const b = douglasPeucker([...open.slice(far), first], tolerance);
  const simplified = [...a, ...b.slice(1, -1)];
  const factor = 10 ** decimals;
  const out = [];
  for (const [lon, lat] of simplified) {
    const p = [
      Math.round(lon * factor) / factor,
      Math.round(lat * factor) / factor,
    ];
    const prev = out[out.length - 1];
    if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
    out.push(p);
  }
  while (
    out.length > 1 &&
    out[0][0] === out[out.length - 1][0] &&
    out[0][1] === out[out.length - 1][1]
  )
    out.pop();
  return out.length >= 4 ? out : null;
}

/**
 * Simplify polygons ([outer, ...holes][]): drop parts and holes under the
 * area floors (the largest part always stays), orient outers
 * counter-clockwise and holes clockwise, sort parts by area descending.
 */
function simplifyPolygons(polygons, params, tolerance, decimals) {
  const parts = [];
  for (const poly of polygons) {
    const outer = simplifyRing(poly[0], tolerance, decimals);
    if (!outer) continue;
    const area = ringAreaKm2(outer);
    if (signedArea(outer) < 0) outer.reverse();
    const holes = [];
    for (const hole of poly.slice(1)) {
      const ring = simplifyRing(hole, tolerance, decimals);
      if (!ring || ringAreaKm2(ring) < params.minHoleKm2) continue;
      if (signedArea(ring) > 0) ring.reverse();
      holes.push(ring);
    }
    parts.push({ rings: [outer, ...holes], area });
  }
  parts.sort((x, y) => y.area - x.area);
  const floor = Math.max(
    params.minPartKm2,
    (parts[0]?.area || 0) * params.minPartShare,
  );
  return parts
    .filter((part, index) => index === 0 || part.area >= floor)
    .map((part) => part.rings);
}

/**
 * Simplify one unit at its size-scaled tolerance. A unit too small to
 * survive the pack precision (a Maldives atoll) is kept at one more decimal
 * and a fifth of the minimum tolerance, or failing that unsimplified at two
 * more decimals; the caller records `d`.
 */
function simplifyUnit(polygons, params) {
  const sourceArea = polygons.reduce(
    (sum, poly) => sum + ringAreaKm2(poly[0]),
    0,
  );
  const tolerance = Math.min(
    params.maxToleranceDeg,
    Math.max(
      params.minToleranceDeg,
      (params.toleranceFactor * Math.sqrt(sourceArea)) / 111.32,
    ),
  );
  const coarse = simplifyPolygons(polygons, params, tolerance, params.decimals);
  if (coarse.length) return { polygons: coarse, decimals: params.decimals };
  const fine = simplifyPolygons(
    polygons,
    params,
    params.minToleranceDeg / 5,
    params.decimals + 1,
  );
  if (fine.length) return { polygons: fine, decimals: params.decimals + 1 };
  // Smaller still (Vatican City): the source ring as drawn.
  const exact = simplifyPolygons(polygons, params, 0, params.decimals + 2);
  return { polygons: exact, decimals: params.decimals + 2 };
}

/**
 * Encode a rounded open ring as integers in units of 10^-decimals degrees:
 * the first vertex absolute, every later vertex as a delta from the previous
 * one — [lon0, lat0, dLon1, dLat1, …]. Decoded by `decodeRing` in
 * src/data/adminBoundaries.js.
 */
function encodeRing(ring, decimals) {
  const factor = 10 ** decimals;
  const out = [];
  let px = 0;
  let py = 0;
  for (const [lon, lat] of ring) {
    const x = Math.round(lon * factor);
    const y = Math.round(lat * factor);
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out;
}

function encodeUnit({ polygons, decimals }) {
  return polygons.map((poly) => poly.map((ring) => encodeRing(ring, decimals)));
}

function geojsonPolygons(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function bboxOf(polygons) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of polygons)
    for (const [lon, lat] of poly[0]) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  return [w, s, e, n];
}

// ── zip / shapefile / dbf ───────────────────────────────────────────────

/** Read named entries from a zip archive (stored or deflated). */
function unzip(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('zip: bad central directory entry');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataStart =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(dataStart, dataStart + compressed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`zip: unsupported method ${method} for ${name}`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Polygon records (shape type 5) as arrays of closed [lon, lat] rings. */
function readShp(buffer) {
  const shapes = [];
  let offset = 100;
  while (offset < buffer.length) {
    const length = buffer.readInt32BE(offset + 4) * 2;
    const content = offset + 8;
    const type = buffer.readInt32LE(content);
    const rings = [];
    if (type === 5) {
      const numParts = buffer.readInt32LE(content + 36);
      const numPoints = buffer.readInt32LE(content + 40);
      const partsAt = content + 44;
      const pointsAt = partsAt + numParts * 4;
      for (let p = 0; p < numParts; p++) {
        const start = buffer.readInt32LE(partsAt + p * 4);
        const end =
          p + 1 < numParts
            ? buffer.readInt32LE(partsAt + (p + 1) * 4)
            : numPoints;
        const ring = [];
        for (let i = start; i < end; i++)
          ring.push([
            buffer.readDoubleLE(pointsAt + i * 16),
            buffer.readDoubleLE(pointsAt + i * 16 + 8),
          ]);
        rings.push(ring);
      }
    } else if (type !== 0) {
      throw new Error(`shp: unsupported shape type ${type}`);
    }
    shapes.push(rings);
    offset = content + length;
  }
  return shapes;
}

/** dBASE records as plain objects (character and numeric fields). */
function readDbf(buffer) {
  const count = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  for (let at = 32; buffer[at] !== 0x0d; at += 32) {
    fields.push({
      name: buffer.toString('latin1', at, at + 11).replace(/\0.*$/, ''),
      length: buffer[at + 16],
    });
  }
  const records = [];
  for (let r = 0; r < count; r++) {
    let at = headerLength + r * recordLength + 1;
    const record = {};
    for (const field of fields) {
      record[field.name] = buffer
        .toString('utf8', at, at + field.length)
        .trim();
      at += field.length;
    }
    records.push(record);
  }
  return records;
}

/** Group shapefile rings into polygons: clockwise outers, holes assigned by containment. */
function shpPolygons(rings) {
  const outers = [];
  const holes = [];
  for (const ring of rings) {
    if (ring.length < 4) continue;
    (signedArea(ring) < 0 ? outers : holes).push(ring);
  }
  const polygons = outers.map((outer) => [outer]);
  for (const hole of holes) {
    const [x, y] = hole[0];
    const owner = polygons.find(([outer]) => pointInRing(outer, x, y));
    if (owner) owner.push(hole);
    else polygons.push([hole.slice().reverse()]);
  }
  return polygons;
}

function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// ── packs ────────────────────────────────────────────────────────────────

const LATIN = /^[\p{Script=Latin}\p{N}\s.,'’()\-/&]+$/u;

function uniqueNames(values, exclude) {
  const seen = new Set(exclude.map(normalizeAdminName));
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    const key = normalizeAdminName(text);
    if (!text || !key || seen.has(key) || !LATIN.test(text)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

async function buildCountries() {
  const source = await fetchPinned('countries');
  const mapUnits = await fetchPinned('mapUnits');
  const params = PARAMS.countries;
  const features = [];
  for (const { properties: p, geometry } of JSON.parse(source.bytes).features) {
    const unit = simplifyUnit(geojsonPolygons(geometry), params);
    if (!unit.polygons.length) continue;
    const name = p.ADMIN || p.NAME_EN || p.NAME;
    features.push({
      name,
      alt: uniqueNames(
        [p.NAME, p.NAME_LONG, p.NAME_EN, p.FORMAL_EN, p.BRK_NAME].filter(
          Boolean,
        ),
        [name],
      ),
      country: name,
      iso: p.ADM0_A3,
      iso2: p.ISO_A2_EH || p.ISO_A2,
      type: 'Country',
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  }
  for (const { properties: p, geometry } of JSON.parse(mapUnits.bytes)
    .features) {
    if (p.ADM0_A3 !== 'GBR') continue;
    const unit = simplifyUnit(geojsonPolygons(geometry), params);
    features.push({
      name: p.GEOUNIT,
      country: p.ADMIN,
      iso: p.GU_A3,
      iso2: 'GB',
      type: 'Constituent country',
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  }
  features.sort((a, b) => a.name.localeCompare(b.name));
  return {
    meta: {
      title: 'Natural Earth admin-0 countries',
      mapUnits: SOURCES.mapUnits,
      source: 'ne_10m_admin_0_countries',
      url: SOURCES.countries.url,
      sha256: source.digest,
      commit: NE_COMMIT,
      license:
        'Public domain (https://www.naturalearthdata.com/about/terms-of-use/)',
      decimals: params.decimals,
      curation: params,
      script: 'scripts/build-admin-packs.mjs',
    },
    features,
  };
}

async function buildAdmin1() {
  const params = PARAMS.admin1;
  const source = await fetchPinned('admin1');
  const places = await fetchPinned('places');
  const collection = JSON.parse(source.bytes.toString('utf8'));
  const { ambiguity } = PARAMS;
  const cities = JSON.parse(places.bytes.toString('utf8'))
    .features.map((f) => f.properties)
    .filter((p) => p.pop_max >= ambiguity.elsewhereMinPopulation)
    .map((p) => ({
      keys: new Set([p.name, p.nameascii].map(normalizeAdminName)),
      lon: p.longitude,
      lat: p.latitude,
      population: p.pop_max,
      country: p.adm0name,
    }));
  const countryNames = new Set();
  for (const { properties: p } of collection.features)
    for (const name of [p.admin, p.geonunit])
      if (name) countryNames.add(normalizeAdminName(name));

  const features = [];
  for (const { properties: p, geometry } of collection.features) {
    const name = String(p.name || '').trim();
    if (!name) continue;
    const unit = simplifyUnit(geojsonPolygons(geometry), params);
    if (!unit.polygons.length) continue;
    const nameEn =
      p.name_en && normalizeAdminName(p.name_en) !== normalizeAdminName(name)
        ? String(p.name_en).trim()
        : null;
    const alt = uniqueNames(
      String(p.name_alt || '').split('|'),
      [name, nameEn].filter(Boolean),
    );
    const bbox = bboxOf(unit.polygons);
    const areaKm2 = unit.polygons.reduce(
      (sum, poly) => sum + ringAreaKm2(poly[0]),
      0,
    );
    const keys = new Set(
      [name, nameEn, ...alt].filter(Boolean).map(normalizeAdminName),
    );
    const amb = [];
    const ambAbroad = [];
    let cityState = false;
    const inBox = (c) =>
      c.lon >= bbox[0] &&
      c.lon <= bbox[2] &&
      c.lat >= bbox[1] &&
      c.lat <= bbox[3];
    for (const key of keys) {
      const namesakes = cities.filter((c) => c.keys.has(key));
      const ownCity = namesakes.some(
        (c) => inBox(c) && c.population >= ambiguity.insideMinPopulation,
      );
      const cityInside = ownCity && areaKm2 > ambiguity.cityStateMaxKm2;
      if (ownCity && !cityInside) cityState = true;
      const elsewhere = namesakes.filter((c) => !inBox(c));
      if (
        countryNames.has(key) ||
        cityInside ||
        elsewhere.some((c) => c.country === p.admin)
      )
        amb.push(key);
      // Only abroad: "Victoria, Australia" settles it; "Victoria" alone not.
      else if (elsewhere.length) ambAbroad.push(key);
    }
    const postal = String(p.postal || '').trim();
    features.push({
      name,
      ...(nameEn ? { nameEn } : {}),
      ...(alt.length ? { alt } : {}),
      ...(/^[A-Z]{2}$/.test(postal) ? { postal } : {}),
      type: p.type_en || p.type || null,
      ...(Number.isFinite(p.min_label) ? { rank: p.min_label } : {}),
      country: p.admin,
      iso2: p.iso_a2 && p.iso_a2 !== '-99' ? p.iso_a2 : null,
      iso: p.iso_3166_2 && !p.iso_3166_2.includes('~') ? p.iso_3166_2 : null,
      ...(amb.length ? { amb: amb.sort() } : {}),
      ...(ambAbroad.length ? { ambAbroad: ambAbroad.sort() } : {}),
      ...(cityState ? { cityState } : {}),
      ...(Number.isFinite(p.longitude) && Number.isFinite(p.latitude)
        ? {
            label: [
              Math.round(p.longitude * 1000) / 1000,
              Math.round(p.latitude * 1000) / 1000,
            ],
          }
        : {}),
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  }
  features.sort(
    (a, b) =>
      a.country.localeCompare(b.country) ||
      a.name.localeCompare(b.name) ||
      (a.iso || '').localeCompare(b.iso || ''),
  );
  return {
    meta: {
      title: 'Natural Earth admin-1 states and provinces',
      source: 'ne_10m_admin_1_states_provinces',
      url: SOURCES.admin1.url,
      sha256: source.digest,
      ambiguitySource: SOURCES.places.url,
      ambiguitySha256: places.digest,
      commit: NE_COMMIT,
      license:
        'Public domain (https://www.naturalearthdata.com/about/terms-of-use/)',
      schema:
        'features[]: name, nameEn?, alt?[], postal?, type, rank? (min_label: the zoom at which Natural Earth labels the unit; lower is more prominent), country, iso2, iso (ISO 3166-2), amb?[] (normalized names that are also a country or a city — alone or with the country named), ambAbroad?[] (names shared only with a city in another country — ambiguous alone, settled by naming the country), cityState? (the unit is its own city), label? [lon, lat] label point, d? (decimals when not meta.decimals), polygons[][ring] (first ring outer, rest holes; each ring open and encoded as integers in 10^-d degrees, first vertex absolute then [dLon, dLat] deltas)',
      decimals: params.decimals,
      curation: { ...params, ambiguity },
      script: 'scripts/build-admin-packs.mjs',
    },
    features,
  };
}

async function buildPlaces() {
  const params = PARAMS.places;
  const source = await fetchPinned('places');
  // Every Springfield in this data is in the United States, so a qualifier is
  // the only thing that settles the name other than the camera. The
  // subdivision codes come from the admin-1 source, which is already pinned,
  // already cached and already fetched by this script's admin1 pass.
  const admin1 = await fetchPinned('admin1');
  const codes = subdivisionCodes(admin1.bytes);
  const factor = 10 ** params.decimals;
  const features = [];
  for (const { properties: p } of JSON.parse(source.bytes.toString('utf8'))
    .features) {
    // `-99` is Natural Earth's "population unknown" sentinel, not a number.
    const population =
      Number.isFinite(p.pop_max) && p.pop_max > 0 ? p.pop_max : 0;
    const capital = params.keepNationalCapitals && p.adm0cap === 1;
    if (population < params.minPopulation && !capital) continue;
    // Natural Earth writes some names with an invisible left-to-right mark.
    const name = String(p.name || '')
      .replace(/[\u200e\u200f\u00ad]/g, '')
      .trim();
    if (!name || !Number.isFinite(p.longitude) || !Number.isFinite(p.latitude))
      continue;
    const adm1code = codes.get(
      `${normalizeAdminName(p.adm0name)}/${normalizeAdminName(p.adm1name)}`,
    );
    features.push({
      name,
      lat: Math.round(p.latitude * factor) / factor,
      lon: Math.round(p.longitude * factor) / factor,
      population,
      country: p.adm0name || null,
      region: p.adm1name || null,
      scale: Number.isFinite(p.scalerank) ? p.scalerank : null,
      iso: p.adm0_a3 || null,
      iso2: p.iso_a2 || null,
      ...(adm1code ? { adm1code } : {}),
      id: '',
    });
  }
  features.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      (a.country || '').localeCompare(b.country || '') ||
      (a.region || '').localeCompare(b.region || ''),
  );
  assignPlaceIds(features);
  return {
    meta: {
      title: 'Natural Earth populated places',
      source: 'ne_10m_populated_places_simple',
      url: SOURCES.places.url,
      sha256: source.digest,
      subdivisionSource: SOURCES.admin1.url,
      subdivisionSha256: admin1.digest,
      commit: NE_COMMIT,
      license:
        'Public domain (https://www.naturalearthdata.com/about/terms-of-use/)',
      schema:
        "features[]: name, lat, lon, population (pop_max, the row's largest published figure; 0 where the source is unknown), country (adm0name), region (adm1name, null where the source has none), scale (scalerank: Natural Earth's label prominence for the place, lower is more prominent), iso (ISO 3166-1 alpha-3), iso2, adm1code? (the subdivision's two-letter code from the admin-1 source: 'MO', 'ON', 'BY'; absent where the source has no code for the region), id",
      // A city has no boundary in this dataset, and the pack does not invent
      // one: it holds a point and a population. Anything drawn around a place
      // from it is an approximation — see src/data/places.js.
      approximate:
        'A POINT, NOT AN OUTLINE. ne_10m_populated_places_simple carries no city geometry, so this pack cannot say where a city ends. Isolating to a city means a box scaled by population around this point; that box is an estimate, not a boundary.',
      decimals: params.decimals,
      curation: params,
      script: 'scripts/build-admin-packs.mjs',
    },
    features,
  };
}

/**
 * Two-letter subdivision codes keyed by "country/region", from the admin-1
 * source, so a place can carry the code its own people write ("Springfield, MO"
 * and not only "Springfield, Missouri"). Only the ISO 3166-2 / postal shape is
 * taken, and the first code wins where a region name repeats in a country.
 */
function subdivisionCodes(bytes) {
  const codes = new Map();
  for (const { properties: p } of JSON.parse(bytes.toString('utf8')).features) {
    const postal = String(p.postal || '').trim();
    if (!/^[A-Z]{2}$/.test(postal)) continue;
    for (const name of [p.name, p.name_en]) {
      if (!name) continue;
      const key = `${normalizeAdminName(p.admin)}/${normalizeAdminName(name)}`;
      if (!codes.has(key)) codes.set(key, postal);
    }
  }
  return codes;
}

/**
 * A stable, readable id per place: `denver-usa`, then `salem-usa-oregon` for a
 * second Salem in the same country, then a counter for what is left. Readable
 * because an id is something a URL, a saved view or a log line carries.
 */
function assignPlaceIds(features) {
  const taken = new Set();
  const slug = (value) => normalizeAdminName(value).replace(/\s+/g, '-');
  for (const feature of features) {
    const base = [slug(feature.name), slug(feature.iso || feature.country)]
      .filter(Boolean)
      .join('-');
    const spaced = [base, slug(feature.region)].filter(Boolean).join('-');
    let id = base;
    if (taken.has(id)) id = spaced;
    // `taken.size` strictly grows, so the last resort cannot collide either.
    if (taken.has(id)) id = `${spaced}-${taken.size}`;
    feature.id = id;
    taken.add(id);
  }
}

async function buildCounties() {
  const params = PARAMS.counties;
  const source = await fetchPinned('counties');
  const files = unzip(source.bytes);
  const base = path.basename(new URL(SOURCES.counties.url).pathname, '.zip');
  const shapes = readShp(files.get(`${base}.shp`));
  const records = readDbf(files.get(`${base}.dbf`));
  if (shapes.length !== records.length)
    throw new Error('counties: shp/dbf record counts differ');
  const features = [];
  records.forEach((record, index) => {
    const unit = simplifyUnit(shpPolygons(shapes[index]), params);
    if (!unit.polygons.length) return;
    const lsad = record.NAMELSAD.startsWith(record.NAME)
      ? record.NAMELSAD.slice(record.NAME.length).trim()
      : '';
    features.push({
      name: record.NAME,
      full: record.NAMELSAD,
      ...(lsad ? { lsad } : {}),
      state: record.STATE_NAME,
      st: record.STUSPS,
      geoid: record.GEOID,
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  });
  features.sort((a, b) => a.geoid.localeCompare(b.geoid));
  return {
    meta: {
      title: 'US Census Bureau cartographic boundary counties',
      source: base,
      url: SOURCES.counties.url,
      sha256: source.digest,
      license: 'Public domain (U.S. Government work, 17 U.S.C. § 105)',
      schema:
        'features[]: name, full (NAMELSAD), lsad? (County, Parish, Borough, …), state, st (USPS), geoid, d? (decimals when not meta.decimals), polygons[][ring] (first ring outer, rest holes; each ring open and encoded as integers in 10^-d degrees, first vertex absolute then [dLon, dLat] deltas)',
      decimals: params.decimals,
      curation: params,
      script: 'scripts/build-admin-packs.mjs',
    },
    features,
  };
}

/**
 * The Census PLACE boundaries: cities, towns, villages and CDPs.
 *
 * The GEOID is the seven-digit state+place FIPS, which is the SAME key the
 * ACS housing-unit artifact is keyed by, so a place joins to its housing
 * count with no crosswalk at all.
 */
async function buildCensusPlaces() {
  const params = PARAMS.censusPlaces;
  const source = await fetchPinned('censusPlaces');
  const files = unzip(source.bytes);
  const base = path.basename(
    new URL(SOURCES.censusPlaces.url).pathname,
    '.zip',
  );
  const shapes = readShp(files.get(`${base}.shp`));
  const records = readDbf(files.get(`${base}.dbf`));
  if (shapes.length !== records.length)
    throw new Error('census places: shp/dbf record counts differ');
  const features = [];
  records.forEach((record, index) => {
    const unit = simplifyUnit(shpPolygons(shapes[index]), params);
    if (!unit.polygons.length) return;
    const lsad = record.NAMELSAD.startsWith(record.NAME)
      ? record.NAMELSAD.slice(record.NAME.length).trim()
      : '';
    features.push({
      name: record.NAME,
      full: record.NAMELSAD,
      ...(lsad ? { lsad } : {}),
      state: record.STATE_NAME,
      st: record.STUSPS,
      geoid: record.GEOID,
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  });
  features.sort((a, b) => a.geoid.localeCompare(b.geoid));
  return {
    meta: {
      title: 'US Census Bureau cartographic boundary places',
      source: base,
      url: SOURCES.censusPlaces.url,
      sha256: source.digest,
      license: 'Public domain (U.S. Government work, 17 U.S.C. § 105)',
      schema:
        'features[]: name, full (NAMELSAD), lsad? (City, town, CDP, …), state, st (USPS), geoid (7-digit state+place FIPS, the key the ACS housing-unit artifact uses), d? (decimals when not meta.decimals), polygons[][ring] (first ring outer, rest holes; each ring open and encoded as integers in 10^-d degrees, first vertex absolute then [dLon, dLat] deltas)',
      decimals: params.decimals,
      curation: params,
      script: 'scripts/build-admin-packs.mjs',
    },
    features,
  };
}

/** Parts and vertices of an outline pack, for the build log. */
function outlineSummary(pack) {
  const parts = pack.features.reduce((n, f) => n + f.polygons.length, 0);
  const vertices = pack.features.reduce(
    (n, f) => n + f.polygons.flat().reduce((m, ring) => m + ring.length / 2, 0),
    0,
  );
  return `${pack.features.length} features, ${parts} parts, ${vertices} vertices`;
}

/** People covered and the largest settlement, for a point pack. */
function pointSummary(pack) {
  const people = pack.features.reduce((n, f) => n + f.population, 0);
  const largest = pack.features.reduce(
    (best, f) => (f.population > (best?.population ?? -1) ? f : best),
    null,
  );
  return `${pack.features.length} places, ${people.toLocaleString('en-US')} people at or above the floor, largest ${largest.name} (${largest.population.toLocaleString('en-US')})`;
}

async function writePack(relative, pack, summarize = outlineSummary) {
  const file = path.join(ROOT, relative);
  await mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(pack) + '\n';
  await writeFile(file, text);
  console.log(
    `${relative}: ${summarize(pack)}, ${Buffer.byteLength(text)} bytes`,
  );
}

if (!only || only === 'census-places')
  await writePack(
    'src/data/local_data/us_census_places/places.json',
    await buildCensusPlaces(),
  );

if (!only || only === 'countries')
  await writePack(
    'src/data/local_data/natural_earth/countries.json',
    await buildCountries(),
  );
if (!only || only === 'admin1')
  await writePack(
    'src/data/local_data/natural_earth/states_provinces.json',
    await buildAdmin1(),
  );
if (!only || only === 'places')
  await writePack(
    'src/data/local_data/natural_earth/places.json',
    await buildPlaces(),
    pointSummary,
  );
if (!only || only === 'counties')
  await writePack(
    'src/data/local_data/us_census_counties/counties.json',
    await buildCounties(),
  );

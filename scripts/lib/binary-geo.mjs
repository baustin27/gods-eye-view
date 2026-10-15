/**
 * Dependency-free readers for the binary formats the public-domain storm and
 * geography sources publish: ZIP archives (SPC report zips, Census cartographic
 * boundary zips), ESRI shapefiles (`.shp`), and dBASE attribute tables (`.dbf`).
 *
 * These live in `scripts/`, not in the app. The app never ships them: the ETL
 * collapses every upstream row into the bundled GeoJSONL snapshots under
 * `src/data/local_data/storm/`, so runtime needs no binary parsing at all.
 *
 * Format references (all public specifications):
 *  - PKZIP APPNOTE.TXT / central directory
 *  - ESRI Shapefile Technical Description (July 1998)
 *  - dBASE III+ / Visual FoxPro 9 table structure
 *
 * @module scripts/lib/binary-geo
 */

import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;

/**
 * Locate the end-of-central-directory record, tolerating a trailing comment.
 * @param {Buffer} buf
 * @returns {number} Offset of the EOCD signature, or -1 when absent.
 */
function findEocd(buf) {
  const maxComment = 0xffff;
  const start = Math.max(0, buf.length - EOCD_MIN_SIZE - maxComment);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * Read every local file header in a ZIP archive and inflate its payload.
 * Only stored (0) and deflated (8) entries are supported, which covers every
 * archive this ETL consumes.
 * @param {Buffer} buf Raw .zip bytes.
 * @returns {Map<string, Buffer>} Entry name -> decompressed bytes.
 */
export function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < EOCD_MIN_SIZE)
    throw new TypeError('readZipEntries requires a ZIP buffer');

  const eocd = findEocd(buf);
  if (eocd < 0)
    throw new Error('Not a ZIP archive (no end-of-central-directory)');

  let entryCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64 upgrade path — Census boundary archives exceed the 32-bit limits.
  const locatorAt = eocd - 20;
  if (
    locatorAt >= 0 &&
    buf.readUInt32LE(locatorAt) === ZIP64_EOCD_LOCATOR_SIGNATURE
  ) {
    const z64 = Number(buf.readBigUInt64LE(locatorAt + 8));
    if (
      z64 >= 0 &&
      z64 + 56 <= buf.length &&
      buf.readUInt32LE(z64) === ZIP64_EOCD_SIGNATURE
    ) {
      entryCount = Number(buf.readBigUInt64LE(z64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }

  const out = new Map();
  let p = cdOffset;
  for (let n = 0; n < entryCount; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;

    // Local header repeats the name/extra lengths; data starts past them.
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, zlib.inflateRawSync(raw));
    else
      throw new Error(
        `Unsupported ZIP compression method ${method} for ${name}`,
      );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shapefile
// ---------------------------------------------------------------------------

export const SHAPE_POINT = 1;
export const SHAPE_POLYLINE = 3;
export const SHAPE_POLYGON = 5;
export const SHAPE_MULTIPOINT = 8;
export const SHAPE_MULTIPATCH = 31;

/**
 * Parse an ESRI shapefile into plain geometry records.
 *
 * Only the shapes Census cartographic boundary files actually use are decoded:
 * point, polyline, polygon, multipoint, and multipatch (which carries the
 * island rings as standard parts). Rings are returned as flat [x0,y0,x1,y1,…]
 * arrays because that is what GeoJSON polygon coordinates want, and it keeps
 * 11.7 MB of TIGER counties well under a few megabytes of JSON.
 *
 * @param {Buffer} buf Raw .shp bytes.
 * @returns {{shapeType: number, bbox: number[], records: Array<{bbox: number[], parts: number[][]}>}}
 */
export function readShapefile(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 100) {
    throw new TypeError('readShapefile requires a .shp buffer');
  }
  if (buf.readInt32BE(0) !== 9994)
    throw new Error('Bad shapefile magic (9994)');

  const shapeType = buf.readInt32LE(32);
  const bbox = [
    buf.readDoubleLE(36),
    buf.readDoubleLE(44),
    buf.readDoubleLE(52),
    buf.readDoubleLE(60),
  ];

  const records = [];
  let offset = 100;
  while (offset + 8 <= buf.length) {
    const contentWords = buf.readInt32BE(offset + 4);
    const contentLength = contentWords * 2;
    if (contentLength < 4) break;
    const start = offset + 8;
    const end = start + contentLength;
    if (end > buf.length) break;

    const recType = buf.readInt32LE(start);
    if (recType === 0) {
      records.push({ bbox: null, parts: [] });
    } else if (recType === SHAPE_POINT || recType === 11) {
      const x = buf.readDoubleLE(start + 4);
      const y = buf.readDoubleLE(start + 12);
      records.push({ bbox: [x, y, x, y], parts: [[x, y]] });
    } else if (
      recType === SHAPE_POLYLINE ||
      recType === SHAPE_POLYGON ||
      recType === 13 ||
      recType === 15 ||
      recType === 23 ||
      recType === 25 ||
      recType === SHAPE_MULTIPATCH
    ) {
      const recBbox = [
        buf.readDoubleLE(start + 4),
        buf.readDoubleLE(start + 12),
        buf.readDoubleLE(start + 20),
        buf.readDoubleLE(start + 28),
      ];
      const numParts = buf.readInt32LE(start + 36);
      const numPoints = buf.readInt32LE(start + 40);
      const partIndexes = [];
      for (let i = 0; i < numParts; i += 1) {
        partIndexes.push(buf.readInt32LE(start + 44 + i * 4));
      }
      const ptStart = start + 44 + numParts * 4;
      const xs = new Float64Array(numPoints);
      const ys = new Float64Array(numPoints);
      for (let i = 0; i < numPoints; i += 1) {
        xs[i] = buf.readDoubleLE(ptStart + i * 16);
        ys[i] = buf.readDoubleLE(ptStart + i * 16 + 8);
      }
      const parts = [];
      for (let i = 0; i < numParts; i += 1) {
        const from = partIndexes[i];
        const to = i + 1 < numParts ? partIndexes[i + 1] : numPoints;
        const flat = new Array((to - from) * 2);
        for (let j = from; j < to; j += 1) {
          flat[(j - from) * 2] = xs[j];
          flat[(j - from) * 2 + 1] = ys[j];
        }
        if (flat.length >= 4) parts.push(flat);
      }
      records.push({ bbox: recBbox, parts });
    } else if (
      recType === SHAPE_MULTIPOINT ||
      recType === 18 ||
      recType === 28
    ) {
      const numPoints = buf.readInt32LE(start + 36);
      const ptStart = start + 40;
      const flat = new Array(numPoints * 2);
      for (let i = 0; i < numPoints; i += 1) {
        flat[i * 2] = buf.readDoubleLE(ptStart + i * 16);
        flat[i * 2 + 1] = buf.readDoubleLE(ptStart + i * 16 + 8);
      }
      records.push({
        bbox: [
          buf.readDoubleLE(start + 4),
          buf.readDoubleLE(start + 12),
          buf.readDoubleLE(start + 20),
          buf.readDoubleLE(start + 28),
        ],
        parts: flat.length >= 2 ? [flat] : [],
      });
    } else {
      // Unknown geometry type: keep the record slot so attribute rows stay aligned.
      records.push({ bbox: null, parts: [] });
    }
    offset = end;
  }
  return { shapeType, bbox, records };
}

// ---------------------------------------------------------------------------
// dBASE (.dbf)
// ---------------------------------------------------------------------------

/**
 * Parse a dBASE attribute table into a header list and row objects.
 * @param {Buffer} buf Raw .dbf bytes.
 * @returns {{fields: string[], records: Array<Object>}}
 */
export function readDbf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) {
    throw new TypeError('readDbf requires a .dbf buffer');
  }
  const recordCount = buf.readInt32LE(4);
  const headerLength = buf.readInt16LE(8);
  const recordLength = buf.readInt16LE(10);

  const fields = [];
  const offsets = [];
  for (let p = 32; p + 32 <= headerLength - 1; p += 32) {
    const nameBytes = buf.subarray(p, p + 11);
    const zero = nameBytes.indexOf(0);
    const name = nameBytes.toString('latin1', 0, zero < 0 ? 11 : zero);
    if (!name) break;
    fields.push(name);
    offsets.push({
      name,
      type: String.fromCharCode(buf.readUInt8(p + 11)),
      length: buf.readUInt8(p + 16),
      decimals: buf.readUInt8(p + 17),
    });
  }
  // Field byte offsets are cumulative within the fixed-width record, whose
  // first byte is the deletion flag.
  let cursor = 1;
  for (const f of offsets) {
    f.offset = cursor;
    cursor += f.length;
  }

  const records = [];
  for (let r = 0; r < recordCount; r += 1) {
    const base = headerLength + r * recordLength;
    if (base + 1 + recordLength > buf.length) break;
    if (buf.readUInt8(base) === 0x2a) continue; // deleted
    const row = {};
    for (const f of offsets) {
      const start = base + f.offset;
      const raw = buf.toString('latin1', start, start + f.length).trim();
      if (f.type === 'N' || f.type === 'F') {
        row[f.name] = raw === '' ? null : Number(raw);
      } else {
        row[f.name] = raw === '' ? null : raw;
      }
    }
    records.push(row);
  }
  return { fields, records };
}

/**
 * Read a `.shp` + `.dbf` pair from the same archive into joined GeoJSON
 * features.
 * @param {Map<string, Buffer>} entries Archive entries keyed by file name.
 * @param {{shp: string, dbf: string, propertyKeys?: string[]}} spec
 * @returns {Array<{geometry: object|null, properties: object}>}
 */
export function readShapefileSet(entries, { shp, dbf, propertyKeys }) {
  const shpBuf = entries.get(shp);
  const dbfBuf = entries.get(dbf);
  if (!shpBuf) throw new Error(`Shapefile ${shp} missing from archive`);
  const shape = readShapefile(shpBuf);
  const table = dbfBuf ? readDbf(dbfBuf) : { fields: [], records: [] };

  return shape.records.map((rec, i) => {
    const attributes = table.records[i] || {};
    const properties = {};
    for (const [k, v] of Object.entries(attributes)) {
      if (!propertyKeys || propertyKeys.includes(k)) properties[k] = v;
    }
    if (properties.NAME) properties.NAME = properties.NAME;
    return { geometry: shapeToGeometry(rec), properties };
  });
}

/**
 * Convert one decoded shapefile record to GeoJSON geometry.
 * @param {{parts: number[][]}} rec
 * @returns {object|null}
 */
export function shapeToGeometry(rec) {
  if (!rec || !Array.isArray(rec.parts) || rec.parts.length === 0) return null;
  if (rec.parts.length === 1 && rec.parts[0].length === 2) {
    return { type: 'Point', coordinates: rec.parts[0] };
  }
  if (rec.parts.every((p) => p.length === 2)) {
    return { type: 'MultiPoint', coordinates: rec.parts };
  }
  return { type: 'MultiPolygon', coordinates: rec.parts.map((ring) => [ring]) };
}

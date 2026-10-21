/**
 * The GEVS street tile - the format the desk's map reads.
 *
 * WHY NOT MVT. The repository has `@mapbox/vector-tile`, which DECODES
 * vector tiles, and no encoder. `pbf` v5 can write, so MVT was possible
 * without a new dependency - and it would have bought a protobuf envelope, a
 * tags table and a decode path for a format with exactly one producer and
 * one consumer. A tile here is a list of polylines, and a tile format for
 * that does not need a feature model.
 *
 * WHY DELTA AND VARINT. A street's vertices are consecutive points a few
 * metres apart, so the difference between them is a small number, and a
 * varint of a zigzagged delta is one or two bytes. Fixed-width 32-bit
 * coordinates would be eight bytes a point, and JSON would be more than
 * twenty - four to six times the size, and a `JSON.parse` on the main thread
 * for every tile.
 *
 * MEASURED. On the cached Douglas County file - 17,205 edges, 245,363
 * points, 14.26 points a record - a tile costs about twenty bytes a
 * feature, or about 1.2 MB for a whole county at one zoom.
 *
 * The format is PURE and lives here rather than in the server, because the
 * server writes it and the browser reads it, and a format with two copies
 * is two formats that will drift.
 *
 * AND THE CENSUS TRACTS ARE IN IT TOO. The desk's map draws the streets of
 * a county and the tract boundaries over them, and a tract boundary is a
 * RING - a closed polyline - in the same tile-local units. So the tracts are
 * written in this format and not in a second one: a feature is a polyline
 * with an index, and the index means "this street" in a street tile and
 * "this tract" in a tract tile. The client tells them apart by the route
 * that served them, and a client that decodes the wrong one gets rings
 * where it wanted streets - which it draws as lines.
 *
 * A tract's rings are emitted in order, one tract after another, and the
 * rings of one tract share an index. A client fills a tract's rings
 * together with the even-odd rule, and a hole is punched by that rule
 * rather than by a flag: the Census does not say which ring is a hole, and
 * the rule does not need to be told.
 */

/** Magic at the head of a tile: ASCII `GEVS`. */
export const GEVS_MAGIC = Object.freeze([0x47, 0x45, 0x56, 0x53]);

/** The version this module reads and writes. */
export const GEVS_VERSION = 1;

/** The header length, in bytes. */
export const GEVS_HEADER_BYTES = 32;

/**
 * The fixed part of one street record, in bytes.
 *
 * The point count, the edge index and the first point. Everything after it
 * is a varint delta, and its length depends on the geometry - so the size of
 * a record is not a constant, only its floor is.
 */
export const GEVS_RECORD_BYTES = 14;

/**
 * The tile's extent, in units across.
 *
 * Twelve bits: 4096 units across a 256 pixel tile is sixteen units a pixel,
 * which is enough to place a point to a sixteenth of a pixel and leaves the
 * headroom for the y axis to grow if the format ever needs it.
 */
export const GEVS_EXTENT_SHIFT = 12;
export const GEVS_EXTENT = 1 << GEVS_EXTENT_SHIFT;

/** The edge index that means "this line has no edge behind it". */
export const GEVS_NO_EDGE = 0xffffffff;

/**
 * Zigzag a signed integer so that small magnitudes stay small.
 *
 * A delta of -1 becomes 1 and a delta of 1 becomes 2, so the varint of a
 * delta is one byte for anything under a magnitude of 64.
 *
 * @param {number} value
 * @returns {number}
 */
export function zigzag(value) {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

/**
 * Undo {@link zigzag}.
 *
 * @param {number} value
 * @returns {number}
 */
export function unzigzag(value) {
  return (value >>> 1) ^ -(value & 1);
}

/**
 * Write a varint into a buffer, and say how many bytes it took.
 *
 * LEB128: seven bits per byte, with the high bit set on every byte but the
 * last.
 *
 * @param {Uint8Array} buffer
 * @param {number} at the offset to write at
 * @param {number} value a non-negative integer
 * @returns {number} the bytes written
 */
export function writeVarint(buffer, at, value) {
  let remaining = value >>> 0;
  let offset = at;
  for (;;) {
    const byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) {
      buffer[offset] = byte | 0x80;
      offset += 1;
    } else {
      buffer[offset] = byte;
      offset += 1;
      break;
    }
  }
  return offset - at;
}

/**
 * Read a varint from a buffer.
 *
 * @param {Uint8Array} buffer
 * @param {number} at the offset to read at
 * @returns {{value: number, next: number}} the value and where the next one is
 */
export function readVarint(buffer, at) {
  let value = 0;
  let shift = 0;
  let offset = at;
  for (;;) {
    if (offset >= buffer.length) {
      throw new RangeError('the varint ran off the end of the tile');
    }
    const byte = buffer[offset];
    offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new RangeError('the varint is longer than 32 bits');
  }
  return { value: value >>> 0, next: offset };
}

/**
 * Encode a tile.
 *
 * @param {object} tile
 * @param {number} tile.zoom
 * @param {number} tile.westLon the tile's west edge, in degrees
 * @param {number} tile.southLat the tile's south edge, in degrees
 * @param {Array<{edgeIndex?: number, points: Array<[number, number]>}>} tile.lines
 *   the polylines, in TILE-LOCAL units, y growing DOWN
 * @returns {Uint8Array}
 */
export function encodeStreetTile(tile) {
  const lines = (tile?.lines || []).filter(
    (line) => Array.isArray(line?.points) && line.points.length >= 2,
  );
  // The geometry is built FIRST and measured exactly, because its length goes
  // in the header and the header is written first. An upper bound would pad
  // every tile with zeros and put a length in the header that is not the
  // length of anything.
  const geometry = [];
  for (const line of lines) {
    const feature = [];
    const featureView = new DataView(new ArrayBuffer(GEVS_RECORD_BYTES));
    featureView.setUint16(0, line.points.length, true);
    featureView.setUint32(2, line.edgeIndex ?? GEVS_NO_EDGE, true);
    featureView.setInt32(6, Math.round(line.points[0][0]), true);
    featureView.setInt32(10, Math.round(line.points[0][1]), true);
    for (let i = 0; i < GEVS_RECORD_BYTES; i += 1)
      feature.push(featureView.getUint8(i));
    let x = Math.round(line.points[0][0]);
    let y = Math.round(line.points[0][1]);
    for (let i = 1; i < line.points.length; i += 1) {
      const nx = Math.round(line.points[i][0]);
      const ny = Math.round(line.points[i][1]);
      const scratch = new Uint8Array(10);
      let at = 0;
      at += writeVarint(scratch, at, zigzag(nx - x));
      at += writeVarint(scratch, at, zigzag(ny - y));
      for (let b = 0; b < at; b += 1) feature.push(scratch[b]);
      x = nx;
      y = ny;
    }
    for (const byte of feature) geometry.push(byte);
  }
  const geometryBytes = geometry.length;
  const buffer = new Uint8Array(GEVS_HEADER_BYTES + geometryBytes);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < 4; i += 1) buffer[i] = GEVS_MAGIC[i];
  view.setUint8(4, GEVS_VERSION);
  view.setUint8(5, GEVS_EXTENT_SHIFT);
  view.setUint16(6, lines.length, true);
  view.setUint32(8, geometryBytes, true);
  view.setUint8(12, tile?.zoom ?? 0);
  view.setFloat64(16, tile?.westLon ?? 0, true);
  view.setFloat64(24, tile?.southLat ?? 0, true);
  buffer.set(geometry, GEVS_HEADER_BYTES);
  return buffer;
}

/**
 * Decode a tile.
 *
 * A tile that is not a tile - a truncated file, an HTML shell, a coarse
 * payload handed to the wrong decoder - decodes to NOTHING rather than to
 * nonsense. The magic and the length are checked, and the version is
 * refused if it is not one this module knows.
 *
 * @param {Uint8Array} bytes
 * @returns {{zoom: number, westLon: number, southLat: number,
 *   lines: Array<{edgeIndex: number, points: Array<[number, number]>}>}}
 */
export function decodeStreetTile(bytes) {
  const empty = { zoom: 0, westLon: 0, southLat: 0, lines: [] };
  if (!bytes || bytes.length < GEVS_HEADER_BYTES) return empty;
  for (let i = 0; i < 4; i += 1) {
    if (bytes[i] !== GEVS_MAGIC[i]) return empty;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  if (version !== GEVS_VERSION) return empty;
  const featureCount = view.getUint16(6, true);
  const geometryBytes = view.getUint32(8, true);
  if (GEVS_HEADER_BYTES + geometryBytes > bytes.length) return empty;

  const lines = [];
  let at = GEVS_HEADER_BYTES;
  for (let n = 0; n < featureCount; n += 1) {
    if (at + GEVS_RECORD_BYTES > bytes.length) return empty;
    const pointCount = view.getUint16(at, true);
    at += 2;
    const edgeIndex = view.getUint32(at, true);
    at += 4;
    let x = view.getInt32(at, true);
    at += 4;
    let y = view.getInt32(at, true);
    at += 4;
    if (pointCount < 2) return empty;
    const points = [[x, y]];
    for (let i = 1; i < pointCount; i += 1) {
      const dx = readVarint(bytes, at);
      at = dx.next;
      const dy = readVarint(bytes, at);
      at = dy.next;
      x += unzigzag(dx.value);
      y += unzigzag(dy.value);
      points.push([x, y]);
    }
    lines.push({ edgeIndex, points });
  }
  return {
    zoom: view.getUint8(12),
    westLon: view.getFloat64(16, true),
    southLat: view.getFloat64(24, true),
    lines,
  };
}

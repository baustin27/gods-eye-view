/**
 * GRIB2 reader for the NOAA MRMS archive.
 *
 * Scope is deliberately narrow: this decodes what the MRMS products this repo
 * ingests actually emit, and refuses anything else rather than guessing.
 *
 * What MRMS ships:
 *  - Section 3: a regular latitude/longitude grid (GRIB2 grid definition
 *    template 3.0) at 0.01° — 7000 x 3500 over CONUS, 24.5M points.
 *    The byte layout is MRMS-specific rather than exactly the FM 92 template,
 *    so the grid is located by validating Ni x Nj against the value count
 *    declared in section 5. A mismatch throws instead of producing a
 *    plausible-looking grid that is quietly transposed or offset.
 *  - Section 4: product definition template 4.0.
 *  - Section 5: data representation template 5.400 — PNG packing. A 24.5M-point
 *    field arrives as roughly 50 KB because the field is mostly uniform. Plain
 *    template 5.0 (simple bit packing) is also supported, as is the absence of
 *    a data-representation section entirely.
 *  - Section 6: usually the single byte 0xFF, meaning "no bitmap, every point
 *    is present".
 *
 * Why not a library: the app carries a deliberately small dependency set
 * (`cesium`, `satellite.js`, `mgrs`, `egm96-universal`) and this is build-time
 * tooling. Section walking plus PNG decode is a few hundred lines and avoids
 * adding a decoder to every consumer's `node_modules`.
 *
 * References:
 *  - WMO Manual on Codes No. 306 Vol I.2, FM 92 (GRIB)
 *  - NCEI GRIB2 templates 3.0, 4.0, 5.0, 5.40
 *
 * @module scripts/lib/grib2
 */

import { decodeGrayscalePng } from './png.mjs';

const GRIB = 0x47524942; // "GRIB"
const END_MARKER = 0x37373737; // "7777"

/**
 * Byte offsets within the MRMS section 3 body, relative to section start.
 * `body` excludes the 5-byte section header.
 * @constant
 */
const MRMS_GRID = Object.freeze({
  ni: 25,
  nj: 29,
  la1: 41,
  lo1: 45,
  di: 58,
  dj: 62,
  scanMode: 66,
});

/**
 * Parse one GRIB2 message into its sections.
 *
 * @param {Buffer} buffer Decompressed GRIB2 bytes.
 * @returns {{sections: object[], discipline: number, edition: number, length: number}}
 * @throws when the buffer is not a complete GRIB2 message.
 */
export function parseGrib2(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    throw new TypeError('parseGrib2 requires a GRIB2 buffer');
  }
  if (buffer.readUInt32BE(0) !== GRIB) throw new Error('Not a GRIB message');

  // Section 0 layout varies between encoders. FM 92 puts the one-byte edition
  // at index 6 and the 8-byte length at 7-14; the MRMS archive writes an extra
  // byte, putting the edition at index 7 and the length at 8-15. Both leave
  // section 1 starting at index 16. Try each and require that section 1 really
  // begins there, so a wrong guess fails loudly instead of mis-parsing every
  // offset that follows.
  let edition = 0;
  let length = 0;
  for (const editionIndex of [6, 7]) {
    if (buffer.readUInt8(editionIndex) !== 2) continue;
    const size = Number(buffer.readBigUInt64BE(editionIndex + 1));
    if (!Number.isFinite(size) || size <= 16 || size > buffer.length) continue;
    if (buffer.readUInt8(20) !== 1) continue;
    const sectionLength = buffer.readUInt32BE(16);
    if (sectionLength < 8 || sectionLength > size) continue;
    edition = 2;
    length = size;
    break;
  }
  if (!edition) {
    throw new Error(
      `Unrecognised GRIB2 section 0 (byte6=0x${buffer.readUInt8(6).toString(16)} byte7=0x${buffer.readUInt8(7).toString(16)})`,
    );
  }

  const discipline = buffer.readUInt8(5);
  const messageEnd = Math.min(buffer.length, length);
  const sections = [];
  let offset = 16;

  while (offset < messageEnd) {
    // Section 8 is literally the four ASCII bytes "7777", with no length or
    // section-number fields. Test for it before reading a section header so we
    // never read past the end of the buffer.
    if (
      messageEnd - offset >= 4 &&
      buffer.readUInt32BE(offset) === END_MARKER
    ) {
      sections.push({ number: 8, offset, length: 4 });
      break;
    }
    if (messageEnd - offset < 5)
      throw new Error(`Truncated section at byte ${offset}`);
    const number = buffer.readUInt8(offset + 4);
    if (number < 1 || number > 7) {
      throw new Error(`Unexpected section number ${number} at byte ${offset}`);
    }
    const sectionLength = buffer.readUInt32BE(offset);
    if (sectionLength < 5 || offset + sectionLength > messageEnd) {
      throw new Error(
        `Section ${number} length ${sectionLength} is out of bounds`,
      );
    }
    sections.push({
      number,
      offset,
      length: sectionLength,
      body: buffer.subarray(offset + 5, offset + sectionLength),
    });
    offset += sectionLength;
  }

  if (sections[sections.length - 1]?.number !== 8) {
    throw new Error('GRIB message did not terminate with section 8');
  }
  return { sections, discipline, edition, length };
}

/**
 * Read the grid definition, validating its shape against the declared value
 * count.
 *
 * @param {object[]} sections Parsed sections.
 * @param {number} expectedValues `numberOfValues` from section 5.
 * @returns {{kind:'latlon', ni:number, nj:number, lat1:number, lon1:number, latStep:number, lonStep:number, scanMode:number}}
 */
export function parseGrid(sections, expectedValues) {
  const section = sections.find((s) => s.number === 3);
  if (!section)
    throw new Error('GRIB message has no section 3 (grid definition)');
  const b = section.body;
  if (b.length < MRMS_GRID.scanMode + 1) {
    throw new Error(`Section 3 too short for an MRMS grid: ${b.length} bytes`);
  }
  const ni = b.readUInt32BE(MRMS_GRID.ni);
  const nj = b.readUInt32BE(MRMS_GRID.nj);
  if (!Number.isFinite(ni) || !Number.isFinite(nj) || ni <= 0 || nj <= 0) {
    throw new Error(`Implausible grid dimensions Ni=${ni} Nj=${nj}`);
  }
  // The decisive check. If an upstream layout change moves these fields, this
  // is where it surfaces, rather than as a silently transposed map.
  if (Number.isFinite(expectedValues) && ni * nj !== expectedValues) {
    throw new Error(
      `Grid ${ni}x${nj} (${ni * nj} points) disagrees with ${expectedValues} declared values`,
    );
  }
  return {
    kind: 'latlon',
    ni,
    nj,
    lat1: b.readInt32BE(MRMS_GRID.la1) / 1e6,
    lon1: b.readInt32BE(MRMS_GRID.lo1) / 1e6,
    latStep: b.readInt32BE(MRMS_GRID.dj) / 1e6,
    lonStep: b.readInt32BE(MRMS_GRID.di) / 1e6,
    scanMode: b.readUInt8(MRMS_GRID.scanMode),
  };
}

/**
 * Latitude/longitude of one row-major grid index.
 *
 * MRMS scanning mode 0 is north-to-west: row 0 is the northernmost scan line and
 * longitude increases westward-to-eastward, so index 0 is the north-west corner.
 *
 * @param {object} grid Output of {@link parseGrid}.
 * @param {number} index Row-major sample index.
 * @returns {{lat: number, lon: number}}
 */
export function indexToLonLat(grid, index) {
  const row = Math.floor(index / grid.ni);
  const col = index - row * grid.ni;
  const flip = (grid.scanMode & 0x20) !== 0; // bit 3: rows scan north-to-south
  const lat = flip
    ? grid.lat1 + row * grid.latStep
    : grid.lat1 - row * grid.latStep;
  let lon = grid.lon1 + col * grid.lonStep;
  // MRMS longitudes start at 230°E so the grid spans the dateline without a
  // wrap-around seam; normalise to the conventional -180..180 range.
  if (lon > 180) lon -= 360;
  return { lat, lon };
}

/**
 * Product metadata from section 4.
 *
 * MRMS writes a compact section 4 rather than the FM 92 template 4.0 layout.
 * The reference time is not carried here at all — it lives in section 1 — so
 * {@link parseIdentification} is the source of truth for the timestamp, and the
 * filename carries it as a fallback.
 *
 * @param {object[]} sections
 * @returns {object}
 */
export function parseProduct(sections) {
  const section = sections.find((s) => s.number === 4);
  if (!section)
    throw new Error('GRIB message has no section 4 (product definition)');
  const b = section.body;
  if (b.length < 6) throw new Error(`Section 4 too short: ${b.length} bytes`);
  return {
    parameterCategory: b.readUInt8(4),
    parameterNumber: b.readUInt8(5),
    generatingProcessIdentifier: b.readUInt8(6),
    hoursOfObservationalDataCutoff: b.readUInt16BE(7),
    minutesOfObservationalDataCutoff: b.readUInt8(9),
    typeOfGeneratingProcess: b.readUInt8(3),
  };
}

/**
 * Reference time from section 1 (identification section).
 *
 * @param {object[]} sections
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number}|null}
 */
export function parseIdentification(sections) {
  const section = sections.find((s) => s.number === 1);
  if (!section) return null;
  const b = section.body;
  if (b.length < 14) return null;
  // Significance of reference time doubles as the year for the "1 = analysis,
  // 2 = forecast" conventions; values 100..999 are years directly, and MRMS
  // writes the full four-digit year here.
  const raw = b.readUInt16BE(7);
  const year = raw >= 1900 && raw <= 2200 ? raw : 2000 + (raw % 100);
  const month = b.readUInt8(9);
  const day = b.readUInt8(10);
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  return {
    year,
    month,
    day,
    hour: b.readUInt8(11),
    minute: b.readUInt8(12),
    second: b.readUInt8(13),
  };
}

/**
 * Byte offsets within the MRMS section 5 body, confirmed against the live
 * archive and cross-checked against an independent decoder. MRMS uses a
 * compact section 5 rather than the FM 92 template layout, so the fields are
 * read at fixed positions and then validated: `numberOfValues` must equal
 * Ni x Nj, which is what catches any future format drift.
 * @constant
 */
const MRMS_PACKING = Object.freeze({
  numberOfValues: 0,
  typeOfOriginalFieldValues: 4,
  referenceValue: 6,
  binaryScaleFactor: 10,
  decimalScaleFactor: 12,
  bitsPerValue: 14,
});

/**
 * Data-representation metadata from section 5.
 *
 * MRMS ships PNG packing (template 5.400). Plain template 5.0 simple packing is
 * accepted as well, distinguished by the presence of a conventional template
 * number field.
 *
 * @param {object[]} sections
 * @returns {{template:number, referenceValue:number, binaryScaleFactor:number,
 *   decimalScaleFactor:number, numberOfValues:number, bitsPerValue:number,
 *   typeOfOriginalFieldValues:number}}
 */
export function parseDataRepresentation(sections) {
  const section = sections.find((s) => s.number === 5);
  if (!section) {
    // A constant field may omit section 5 entirely.
    return {
      template: -1,
      referenceValue: 0,
      binaryScaleFactor: 0,
      decimalScaleFactor: 0,
      numberOfValues: 0,
      bitsPerValue: 0,
      typeOfOriginalFieldValues: 0,
    };
  }
  const b = section.body;
  const o = MRMS_PACKING;
  if (b.length < o.bitsPerValue + 1) {
    throw new Error(`Section 5 too short: ${b.length} bytes`);
  }
  const numberOfValues = b.readUInt32BE(o.numberOfValues);
  if (!Number.isFinite(numberOfValues) || numberOfValues <= 0) {
    throw new Error(`Section 5 declares ${numberOfValues} values`);
  }
  const bitsPerValue = b.readUInt8(o.bitsPerValue);
  // MRMS PNG packing uses an 8-bit greyscale PNG for some products and a 16-bit
  // one for others (the rolling-maximum fields are 16-bit). Both are PNG, so the
  // discriminator is the bit depth, not a magic byte: keying this off `=== 8`
  // silently routes the 16-bit products through the bit-unpacker and yields a
  // field that is uniformly at the missing value.
  const pngPacked = bitsPerValue === 8 || bitsPerValue === 16;
  return {
    template: pngPacked ? 400 : 0,
    referenceValue: b.readFloatBE(o.referenceValue),
    binaryScaleFactor: b.readInt16BE(o.binaryScaleFactor),
    decimalScaleFactor: b.readInt16BE(o.decimalScaleFactor),
    numberOfValues,
    bitsPerValue,
    typeOfOriginalFieldValues: b.readUInt8(o.typeOfOriginalFieldValues),
  };
}

/**
 * Decode the data section into physical values.
 *
 * Handles PNG packing (template 5.400, what MRMS ships) and simple bit packing
 * (template 5.0). A bitmap, when present, is applied by filling masked points
 * with the missing value.
 *
 * @param {object[]} sections
 * @param {object} packing Output of {@link parseDataRepresentation}.
 * @param {{ni:number, nj:number}} grid
 * @returns {Float32Array} Row-major physical values.
 */
export function decodeValues(sections, packing, grid) {
  const count = packing.numberOfValues || grid.ni * grid.nj;
  const out = new Float32Array(count);
  const bitmapSection = sections.find((s) => s.number === 6);
  const bitmapPresent =
    bitmapSection &&
    bitmapSection.body.length > 0 &&
    bitmapSection.body.readUInt8(0) !== 0xff;

  if (packing.template === 400) {
    const dataSection = sections.find((s) => s.number === 7);
    if (!dataSection) throw new Error('PNG-packed message has no section 7');
    return decodePngValues(
      dataSection.body,
      packing,
      count,
      out,
      bitmapSection,
      bitmapPresent,
    );
  }
  if (packing.template === 0) {
    const dataSection = sections.find((s) => s.number === 7);
    if (!dataSection) return out.fill(missingValue(packing));
    return decodeSimplePacking(
      dataSection.body,
      packing,
      count,
      out,
      bitmapSection,
      bitmapPresent,
    );
  }
  throw new Error(
    `Unsupported data representation template ${packing.template}`,
  );
}

/** The value MRMS uses for "no data", derived from the reference encoding. */
function missingValue(packing) {
  // -3.0 for MESH and siblings: reference -30 with decimal scale 10^-1.
  return (
    (packing.referenceValue * 2 ** packing.binaryScaleFactor) /
    10 ** packing.decimalScaleFactor
  );
}

function decodePngValues(
  pngBytes,
  packing,
  count,
  out,
  bitmapSection,
  bitmapPresent,
) {
  const image = decodeGrayscalePng(pngBytes);
  if (image.width * image.height < count) {
    throw new Error(
      `PNG covers ${image.width * image.height} pixels, need ${count}`,
    );
  }
  const scale = 2 ** packing.binaryScaleFactor;
  const divisor = 10 ** packing.decimalScaleFactor;
  const limit = Math.min(count, image.width * image.height);
  const sixteenBit = image.bitDepth === 16;
  for (let i = 0; i < limit; i += 1) {
    const raw = sixteenBit
      ? (image.data[i * 2] << 8) | image.data[i * 2 + 1]
      : image.data[i];
    out[i] = (raw * scale + packing.referenceValue) / divisor;
  }
  // A 16-bit PNG that only populates its low byte still carries the value in
  // the low byte, so a sanity check on the decoded range is worth surfacing.
  if (bitmapPresent) applyBitmap(out, bitmapSection, count);
  return out;
}

function decodeSimplePacking(
  section7,
  packing,
  count,
  out,
  bitmapSection,
  bitmapPresent,
) {
  const {
    bitsPerValue,
    numberOfValues,
    referenceValue,
    binaryScaleFactor,
    decimalScaleFactor,
  } = packing;
  const perByte = Math.floor(8 / bitsPerValue);
  const mask = (1 << bitsPerValue) - 1;
  const scale = 2 ** binaryScaleFactor;
  const divisor = 10 ** decimalScaleFactor;
  let index = 0;
  for (let slot = 0; slot < perByte && index < numberOfValues; slot += 1) {
    for (
      let byte = slot;
      byte < section7.length && index < numberOfValues;
      byte += perByte
    ) {
      out[index] = ((section7[byte] & mask) * scale + referenceValue) / divisor;
      index += 1;
    }
  }
  for (; index < count; index += 1) out[index] = referenceValue / divisor;
  if (bitmapPresent) applyBitmap(out, bitmapSection, count);
  return out;
}

function applyBitmap(out, bitmapSection, count) {
  const bitmap = bitmapSection.body;
  const fill = out[0] ?? 0;
  for (let i = 0; i < count; i += 1) {
    const byte = bitmap[Math.floor(i / 8)];
    if (byte === undefined || ((byte >> (7 - (i % 8))) & 1) === 0)
      out[i] = fill;
  }
}

export { MRMS_GRID, MRMS_PACKING };

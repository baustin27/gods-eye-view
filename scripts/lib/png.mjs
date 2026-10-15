/**
 * Minimal PNG decoder for the NOAA MRMS `grid_png` packing.
 *
 * MRMS ships its GRIB2 products with data representation template 5.40, where
 * section 7 holds a PNG stream instead of a packed bit field. Because the fields
 * are mostly uniform, PNG compression is extreme: a 7000x3500 CONUS grid with
 * 24.5 million values arrives as roughly 50 KB. That is what makes a
 * multi-year radar ingest tractable at all.
 *
 * Only what MRMS emits is supported — 8- and 16-bit greyscale, no interlacing —
 * and anything else throws with the offending IHDR values rather than decoding
 * into silently wrong cells.
 *
 * PNG filtering and chunk framing follow the PNG specification (RFC 2083 /
 * W3C-PNG). Node's built-in zlib supplies the inflate, so this adds no
 * dependency.
 *
 * @module scripts/lib/png
 */

import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Decode a greyscale PNG into raw sample values.
 *
 * @param {Buffer} buffer PNG bytes.
 * @returns {{width: number, height: number, bitDepth: number, data: Uint8Array}}
 *   `data` is row-major, `width * height` samples at 8- or 16 bits per sample.
 * @throws for unsupported colour types, bit depths, or interlacing.
 */
export function decodeGrayscalePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    throw new TypeError('decodeGrayscalePng requires a PNG buffer');
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG stream');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break; // tolerate a truncated tail

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer.readUInt8(dataStart + 8);
      colourType = buffer.readUInt8(dataStart + 9);
      interlace = buffer.readUInt8(dataStart + 12);
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    // CRC is not verified: the upstream objects are content-addressed by S3 and
    // the GRIB2 layer already validates its own framing.
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0)
    throw new Error('PNG is missing a usable IHDR');
  if (colourType !== 0) {
    throw new Error(
      `Unsupported PNG colour type ${colourType} (expected greyscale)`,
    );
  }
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`Unsupported PNG bit depth ${bitDepth} (expected 8 or 16)`);
  }
  if (interlace !== 0) throw new Error('Interlaced PNG is not supported');
  if (idat.length === 0) throw new Error('PNG contains no IDAT data');

  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const bytesPerPixel = bytesPerSample;
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const stride = width * bytesPerPixel;
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    throw new Error(
      `PNG inflated to ${raw.length} bytes, expected ${expected}`,
    );
  }

  // Undo per-scanline filtering in place.
  const out = new Uint8Array(stride * height);
  let source = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[source];
    source += 1;
    const rowStart = row * stride;
    const previousStart = (row - 1) * stride;
    for (let i = 0; i < stride; i += 1) {
      const rawByte = raw[source + i];
      const left = i >= bytesPerPixel ? out[rowStart + i - bytesPerPixel] : 0;
      const up = row > 0 ? out[previousStart + i] : 0;
      const upLeft =
        row > 0 && i >= bytesPerPixel
          ? out[previousStart + i - bytesPerPixel]
          : 0;
      let value;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + ((left + up) >> 1);
          break;
        case 4:
          value = rawByte + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`Unknown PNG filter type ${filter} on row ${row}`);
      }
      out[rowStart + i] = value & 0xff;
    }
    source += stride;
  }

  // For 8-bit the bytes are already the samples. For 16-bit the samples are
  // big-endian pairs, which downstream readers expect.
  return { width, height, bitDepth, data: out };
}

/** PNG Paeth predictor. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Read one sample from a decoded greyscale image.
 * @param {{bitDepth:number, data:Uint8Array}} image
 * @param {number} index Row-major sample index.
 * @returns {number}
 */
export function sampleAt(image, index) {
  if (image.bitDepth === 8) return image.data[index];
  return (image.data[index * 2] << 8) | image.data[index * 2 + 1];
}

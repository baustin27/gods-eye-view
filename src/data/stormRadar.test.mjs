import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  parseGrib2,
  parseGrid,
  parseProduct,
  parseIdentification,
  parseDataRepresentation,
  decodeValues,
  indexToLonLat,
} from '../../scripts/lib/grib2.mjs';
import { decodeGrayscalePng } from '../../scripts/lib/png.mjs';
import { toRadarRecord, parseOptionalJson } from './stormDatasets.js';
import {
  radarScore,
  blendScore,
  DEFAULT_WEIGHTS,
  scoreCells,
  describeCellScore,
} from './stormScoring.js';

// ---------------------------------------------------------------------------
// Fixture builders
//
// The MRMS GRIB2 layout is compact and undocumented, and its field offsets were
// established empirically against NOAA's archive and cross-checked with an
// independent decoder. That makes it exactly the kind of knowledge that rots
// silently, so these builders encode the observed layout byte for byte and the
// tests below assert the parser reads back precisely what was written.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * Values come back in a Float32Array, matching the precision the reference
 * decoder reports, so exact float64 equality is the wrong assertion.
 */
function assertClose(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-4,
    `${message}: expected ~${expected}, got ${actual}`,
  );
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Minimal greyscale PNG encoder, 8- or 16-bit, filter type 0 on every row.
 */
function encodeGrayscalePng(width, height, samples, bitDepth = 8) {
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const stride = width * bytesPerSample;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const value = samples[y * width + x];
      const at = y * (stride + 1) + 1 + x * bytesPerSample;
      if (bitDepth === 16) raw.writeUInt16BE(value, at);
      else raw.writeUInt8(value, at);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth === 16 ? 16 : 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * GRIB2 order is a 4-byte length then the 1-byte section number, and every
 * section except section 8 is zero-padded out to a 256-byte boundary. The
 * padding is modelled deliberately: a decoder that derives field offsets from
 * the section *start* rather than the body is fine either way, and one that
 * derives them from the declared *length* is not.
 */
function gribSection(number, body) {
  const unpadded = body.length + 5;
  const length =
    unpadded % 256 === 0 ? unpadded : unpadded + (256 - (unpadded % 256));
  const header = Buffer.alloc(5);
  header.writeUInt32BE(length, 0);
  header.writeUInt8(number, 4);
  const padding = Buffer.alloc(length - unpadded);
  return Buffer.concat([header, body, padding]);
}

/**
 * Build an MRMS-shaped GRIB2 message: `regular_ll` grid, PNG-packed data, the
 * compact section 4/5 layouts observed in the archive.
 */
function buildMeshGrib2({
  ni = 4,
  nj = 3,
  lat1 = 54.995,
  lon1 = 230.005,
  step = 0.01,
  referenceValue = -30,
  binaryScaleFactor = 0,
  decimalScaleFactor = 1,
  bitDepth = 8,
  samples,
  time = { year: 2026, month: 6, day: 15, hour: 12, minute: 30, second: 45 },
  parameterNumber = 28,
} = {}) {
  const count = ni * nj;
  const pixels = samples || new Array(count).fill(0);

  // Section 1 — identification.
  const s1 = Buffer.alloc(21);
  s1.writeUInt16BE(7, 0); // originating centre
  s1.writeUInt16BE(0, 2); // sub-centre
  s1.writeUInt16BE(0xff01, 4); // tables version
  s1.writeUInt8(3, 6); // local table version
  s1.writeUInt16BE(time.year, 7); // significance of reference time
  s1.writeUInt8(time.month, 9);
  s1.writeUInt8(time.day, 10);
  s1.writeUInt8(time.hour, 11);
  s1.writeUInt8(time.minute, 12);
  s1.writeUInt8(time.second, 13);
  s1.writeUInt8(2, 14); // production status
  s1.writeUInt8(7, 15); // type of data

  // Section 3 — grid definition. MRMS uses a compact layout whose fields do not
  // sit at the standard template 3.0 octets, so these are the archive's offsets.
  const s3 = Buffer.alloc(72);
  s3.writeUInt8(0, 0); // source of grid definition
  s3.writeUInt32BE(7000 * 3500, 8); // number of data points (declared, overridden below)
  s3.writeUInt32BE(0, 14); // template number low bytes
  s3.writeUInt8(6, 16); // scale factor of radius of spherical earth
  s3.writeUInt32BE(6371229, 17); // scaled radius
  s3.writeUInt32BE(ni, 25);
  s3.writeUInt32BE(nj, 29);
  s3.writeInt32BE(Math.round(lon1 * 1e6), 33);
  s3.writeInt32BE(Math.round(lat1 * 1e6), 37);
  s3.writeUInt32BE(Math.round(lat1 * 1e6), 41); // La1
  s3.writeInt32BE(Math.round(lon1 * 1e6), 45); // Lo1
  s3.writeInt32BE(Math.round(lat1 * 1e6), 49); // resolution flags
  s3.writeInt32BE(Math.round(lon1 * 1e6), 53);
  s3.writeInt32BE(Math.round(lat1 * 1e6), 57);
  s3.writeInt32BE(Math.round(step * 1e6), 58); // Di
  s3.writeInt32BE(Math.round(step * 1e6), 62); // Dj
  s3.writeUInt8(0, 66); // scanning mode

  // Section 4 — product definition, compact MRMS layout.
  const s4 = Buffer.alloc(29);
  s4.writeUInt8(0, 0); // NV
  s4.writeUInt8(0, 1); // parameter category
  s4.writeUInt8(3, 4); // parameter category
  s4.writeUInt8(parameterNumber, 5);
  s4.writeUInt8(8, 6); // generating process identifier
  s4.writeUInt16BE(97, 7); // hours of cutoff
  s4.writeUInt8(0, 9); // minutes of cutoff

  // Section 5 — data representation, compact MRMS layout.
  const s5 = Buffer.alloc(16);
  s5.writeUInt32BE(count, 0);
  s5.writeUInt8(0, 4); // type of original field values
  s5.writeUInt8(0x29, 5); // group splitting method
  s5.writeFloatBE(referenceValue, 6);
  s5.writeInt16BE(binaryScaleFactor, 10);
  s5.writeInt16BE(decimalScaleFactor, 12);
  s5.writeUInt8(bitDepth, 14);

  const s6 = Buffer.from([0xff]); // bitmap indicator: none

  const png = encodeGrayscalePng(ni, nj, pixels, bitDepth);
  const body = Buffer.concat([
    gribSection(1, s1),
    gribSection(3, s3),
    gribSection(4, s4),
    gribSection(5, s5),
    gribSection(6, s6),
    gribSection(7, png),
    // Section 8 is the four literal bytes "7777", with no length or number field.
    Buffer.from('7777', 'ascii'),
  ]);

  // The MRMS section 0 variant: reserved, discipline, reserved, edition, then an
  // 8-byte total length.
  const s0 = Buffer.alloc(16);
  s0.write('GRIB', 0, 'ascii');
  s0.writeUInt8(0, 4); // reserved
  s0.writeUInt8(0, 5); // discipline
  s0.writeUInt8(0, 6); // reserved
  s0.writeUInt8(2, 7); // edition
  s0.writeBigUInt64BE(BigInt(body.length + 16), 8);
  return Buffer.concat([s0, body]);
}

// ---------------------------------------------------------------------------
// PNG decoder
// ---------------------------------------------------------------------------

test('decodes an 8-bit greyscale PNG', () => {
  const pixels = [0, 1, 127, 128, 255, 42, 99, 200, 17, 3, 88, 240];
  const image = decodeGrayscalePng(encodeGrayscalePng(4, 3, pixels, 8));
  assert.equal(image.width, 4);
  assert.equal(image.height, 3);
  assert.equal(image.bitDepth, 8);
  assert.deepEqual([...image.data], pixels);
});

test('decodes a 16-bit greyscale PNG', () => {
  const pixels = [0, 1, 256, 4096, 65535, 33000, 12, 900, 7, 51, 4200, 8];
  const image = decodeGrayscalePng(encodeGrayscalePng(4, 3, pixels, 16));
  assert.equal(image.bitDepth, 16);
  for (let i = 0; i < pixels.length; i += 1) {
    const value = (image.data[i * 2] << 8) | image.data[i * 2 + 1];
    assert.equal(value, pixels[i], `sample ${i}`);
  }
});

// ---------------------------------------------------------------------------
// GRIB2 section parsing
// ---------------------------------------------------------------------------

test('walks every section and reports framing lengths', () => {
  const message = parseGrib2(buildMeshGrib2());
  assert.deepEqual(
    message.sections.map((s) => s.number),
    [1, 3, 4, 5, 6, 7, 8],
  );
  for (const section of message.sections) {
    if (section.number === 8) {
      // Section 8 is the bare "7777" terminator and is never padded.
      assert.equal(section.length, 4);
      continue;
    }
    assert.equal(section.length % 256, 0, `section ${section.number} padded`);
  }
  assert.equal(
    message.sections.reduce((sum, s) => sum + s.length, 16),
    message.length,
  );
});

test('reads the section 1 reference time', () => {
  const time = parseIdentification(
    parseGrib2(
      buildMeshGrib2({
        time: {
          year: 2026,
          month: 10,
          day: 10,
          hour: 13,
          minute: 20,
          second: 39,
        },
      }),
    ).sections,
  );
  assert.deepEqual(time, {
    year: 2026,
    month: 10,
    day: 10,
    hour: 13,
    minute: 20,
    second: 39,
  });
});

test('reads section 4 product metadata at the compact offsets', () => {
  const product = parseProduct(parseGrib2(buildMeshGrib2()).sections);
  assert.equal(product.parameterCategory, 3);
  assert.equal(product.parameterNumber, 28);
  assert.equal(product.generatingProcessIdentifier, 8);
});

test('reads the regular_ll grid definition', () => {
  const message = parseGrib2(buildMeshGrib2({ ni: 4, nj: 3 }));
  const grid = parseGrid(message.sections, 12);
  assert.equal(grid.kind, 'latlon');
  assert.equal(grid.ni, 4);
  assert.equal(grid.nj, 3);
  assert.equal(grid.lat1, 54.995);
  assert.equal(grid.lonStep, 0.01);
  // 230E is the archive's way of writing a grid that spans the dateline.
  assert.equal(grid.lon1, 230.005);
});

test('normalises longitudes written east of the dateline into the -180..180 range', () => {
  const message = parseGrib2(buildMeshGrib2({ ni: 4, nj: 3 }));
  const grid = parseGrid(message.sections, 12);
  assert.equal(indexToLonLat(grid, 0).lon, -129.995);
  assert.equal(indexToLonLat(grid, 0).lat, 54.995);
});

test('walks a grid south to north as MRMS stores it', () => {
  const message = parseGrib2(buildMeshGrib2({ ni: 4, nj: 3 }));
  const grid = parseGrid(message.sections, 12);
  const first = indexToLonLat(grid, 0);
  const last = indexToLonLat(grid, 11);
  assert.ok(last.lat < first.lat, 'last row is further south');
  assert.equal(Number((first.lat - last.lat).toFixed(2)), 0.02);
});

// ---------------------------------------------------------------------------
// Data representation and value decoding
// ---------------------------------------------------------------------------

test('reads the compact section 5 layout', () => {
  const packing = parseDataRepresentation(
    parseGrib2(buildMeshGrib2({ referenceValue: -30 })).sections,
  );
  assert.equal(packing.numberOfValues, 12);
  assert.equal(packing.referenceValue, -30);
  assert.equal(packing.binaryScaleFactor, 0);
  assert.equal(packing.decimalScaleFactor, 1);
  assert.equal(packing.bitsPerValue, 8);
  assert.equal(packing.template, 400);
});

/**
 * The regression this whole file exists for: the rolling-maximum MRMS products
 * ship a 16-bit PNG, and a decoder that keys "is this PNG?" off an 8-bit depth
 * check sends them down the bit-unpacker and returns a field that is uniformly
 * at the missing value — every point in CONUS reading as "no hail".
 */
test('treats a 16-bit PNG product as PNG packing, not simple packing', () => {
  const count = 12;
  const samples = Array.from({ length: count }, (_, i) => i * 3);
  const message = parseGrib2(buildMeshGrib2({ bitDepth: 16, samples }));
  const packing = parseDataRepresentation(message.sections);
  assert.equal(packing.bitsPerValue, 16);
  assert.equal(packing.template, 400);
  const grid = parseGrid(message.sections, count);
  const values = decodeValues(message.sections, packing, grid);
  const divisor = 10 ** packing.decimalScaleFactor;
  for (let i = 0; i < count; i += 1) {
    assertClose(
      values[i],
      (samples[i] + packing.referenceValue) / divisor,
      `sample ${i}`,
    );
  }
});

test('applies the MESH value transform', () => {
  const samples = [30, 0, 55, 100, 104, 12, 75, 42, 9, 121, 200, 27];
  const message = parseGrib2(buildMeshGrib2({ samples }));
  const packing = parseDataRepresentation(message.sections);
  const grid = parseGrid(message.sections, samples.length);
  const values = decodeValues(message.sections, packing, grid);
  // (pixel + referenceValue) / 10**decimalScaleFactor, with referenceValue -30.
  assertClose(values[0], 0, 'pixel 30 is exactly zero');
  assertClose(values[1], -3, 'pixel 0 is the missing value');
  assertClose(values[2], 2.5, 'pixel 55');
  assertClose(values[3], 7, 'pixel 100');
  assertClose(values[4], 7.4, 'pixel 104');
  assertClose(values[11], -0.3, 'pixel 27');
});

test('applies the binary scale factor', () => {
  const samples = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140];
  const message = parseGrib2(buildMeshGrib2({ samples, binaryScaleFactor: 1 }));
  const packing = parseDataRepresentation(message.sections);
  const grid = parseGrid(message.sections, samples.length);
  const values = decodeValues(message.sections, packing, grid);
  assertClose(values[1], (40 * 2 - 30) / 10, 'binary scale doubles the pixel');
});

test('rejects a section 5 whose declared count disagrees with the grid', () => {
  const message = parseGrib2(buildMeshGrib2());
  // Grid says 4x3; section 5 says 12. Claiming a different total must not be
  // silently accepted, because the decoder would then read a short field as if
  // it were complete.
  assert.throws(() => parseGrid(message.sections, 99), /disagrees with/);
});

test('rejects a truncated section', () => {
  const full = buildMeshGrib2();
  assert.throws(() => parseGrib2(full.subarray(0, full.length - 40)));
});

test('rejects a buffer that is not GRIB at all', () => {
  assert.throws(() => parseGrib2(Buffer.alloc(64, 0x41)));
});

// ---------------------------------------------------------------------------
// Radar record normalisation
// ---------------------------------------------------------------------------

test('normalises a bundled radar feature', () => {
  const record = toRadarRecord({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-96.625, 39.375] },
    properties: {
      i: 157,
      j: -387,
      d: 0.25,
      mx: 72.4,
      cp: 280,
      dy: 12,
      y0: 2021,
      y1: 2026,
    },
  });
  assert.deepEqual(record, {
    i: 157,
    j: -387,
    maxHailMm: 72.4,
    corePoints: 280,
    hailDays: 12,
    firstYear: 2021,
    lastYear: 2026,
  });
});

test('rejects a radar feature without usable grid indices', () => {
  assert.equal(toRadarRecord({ properties: {} }), null);
  assert.equal(toRadarRecord({ properties: { i: 1 } }), null);
  assert.equal(toRadarRecord(null), null);
});

test('optional JSON metadata degrades to null instead of throwing', () => {
  assert.deepEqual(parseOptionalJson('{"a":1}'), { a: 1 });
  assert.equal(parseOptionalJson('not json'), null);
  assert.equal(parseOptionalJson(null), null);
  assert.equal(parseOptionalJson(''), null);
});

// ---------------------------------------------------------------------------
// Radar scoring
// ---------------------------------------------------------------------------

test('scores zero for an absent radar record', () => {
  assert.equal(radarScore(null).radar, 0);
  assert.equal(
    radarScore({ hailDays: 0, maxHailMm: null, corePoints: 0 }).radar,
    0,
  );
});

test('rises monotonically with hail days, magnitude and coverage', () => {
  const low = radarScore({ hailDays: 2, maxHailMm: 26, corePoints: 20 });
  const mid = radarScore({ hailDays: 40, maxHailMm: 50, corePoints: 400 });
  const high = radarScore({ hailDays: 250, maxHailMm: 110, corePoints: 2500 });
  assert.ok(low.radar < mid.radar, 'more evidence scores higher');
  assert.ok(mid.radar < high.radar, 'still higher at the top');
  assert.ok(low.radar > 0, 'any real evidence scores above zero');
});

test('saturates rather than running away on extreme cells', () => {
  const absurd = radarScore({
    hailDays: 5000,
    maxHailMm: 400,
    corePoints: 10_000_000,
  });
  assert.ok(absurd.radar <= 1);
  assert.ok(absurd.radar > 0.95);
});

test('weights magnitude, frequency and coverage rather than one alone', () => {
  // Same magnitude and coverage, different frequency.
  const rare = radarScore({ hailDays: 2, maxHailMm: 60, corePoints: 300 });
  const common = radarScore({ hailDays: 200, maxHailMm: 60, corePoints: 300 });
  assert.ok(common.radar > rare.radar);
  // Same magnitude and frequency, different coverage.
  const speck = radarScore({ hailDays: 50, maxHailMm: 60, corePoints: 3 });
  const widespread = radarScore({
    hailDays: 50,
    maxHailMm: 60,
    corePoints: 900,
  });
  assert.ok(widespread.radar > speck.radar, 'a wide core beats a noise spike');
});

// ---------------------------------------------------------------------------
// Blending
// ---------------------------------------------------------------------------

test('a dataset with no radar scores exactly as it did before radar existed', () => {
  const parts = { observed: 0.5, modelled: 0.4, exposure: 0.3 };
  const legacy =
    (0.5 * DEFAULT_WEIGHTS.observed +
      0.4 * DEFAULT_WEIGHTS.modelled +
      0.3 * DEFAULT_WEIGHTS.exposure) /
    (DEFAULT_WEIGHTS.observed +
      DEFAULT_WEIGHTS.modelled +
      DEFAULT_WEIGHTS.exposure);
  // A missing radar file must not quietly deflate every score in the app.
  assert.equal(blendScore(parts), legacy);
  assert.equal(blendScore(parts, { radar: 0 }), legacy);
});

test('a present radar term lifts the score by a bounded amount', () => {
  const parts = { observed: 0.5, modelled: 0.4, exposure: 0.3 };
  const base = blendScore(parts);
  const withRadar = blendScore({ ...parts, radar: 1 });
  assert.ok(withRadar > base, 'radar evidence can only raise the score');
  assert.ok(withRadar <= 1, 'and never past one');
});

test('an explicitly null radar term is treated as absent', () => {
  const parts = { observed: 0.5, modelled: 0.4, exposure: 0.3 };
  assert.equal(blendScore({ ...parts, radar: null }), blendScore(parts));
});

// ---------------------------------------------------------------------------
// Cell scoring integration
// ---------------------------------------------------------------------------

function miniDataset({ radarByCell } = {}) {
  const cells = [
    {
      i: 1,
      j: 1,
      d: 0.25,
      lat: 0.375,
      lon: 0.375,
      hailCount: 4,
      hailSevere: 0,
      hailSignificant: 0,
      maxHailIn: 2,
      windCount: 2,
      windSevere: 0,
      windStructural: 0,
      maxWindKt: 60,
      compoundDays: 1,
      firstYear: 1955,
      lastYear: 2026,
      reportedLoss: 0,
      injuries: 0,
      fatalities: 0,
      decades: { 2020: [4, 4], 2010: [0, 0], 2000: [0, 0] },
    },
  ];
  return {
    cells,
    coarseCells: [],
    countiesByCell: new Map(),
    radarByCell,
    latestYear: 2026,
    earliestYear: 1955,
  };
}

test('surfaces radar evidence on a scored row', () => {
  const radarByCell = new Map([
    [
      '1:1',
      {
        i: 1,
        j: 1,
        maxHailMm: 88.9,
        corePoints: 900,
        hailDays: 40,
        firstYear: 2021,
        lastYear: 2026,
      },
    ],
  ]);
  const [row] = scoreCells(miniDataset({ radarByCell }));
  assert.equal(row.radarMaxHailMm, 88.9);
  assert.equal(row.radarHailDays, 40);
  assert.ok(row.radar > 0);
  assert.ok(row.score > 0);
});

test('leaves radar fields at zero when the snapshot is absent', () => {
  const [row] = scoreCells(miniDataset());
  assert.equal(row.radar, 0);
  assert.equal(row.radarHailDays, 0);
  assert.equal(row.radarMaxHailMm, null);
  assert.equal(row.reportingGap, false);
});

test('flags a cell where radar shows far more hail than was reported', () => {
  const radarByCell = new Map([
    [
      '1:1',
      {
        i: 1,
        j: 1,
        maxHailMm: 90,
        corePoints: 2000,
        hailDays: 40,
        firstYear: 2021,
        lastYear: 2026,
      },
    ],
  ]);
  const [row] = scoreCells(miniDataset({ radarByCell }));
  assert.equal(row.hailCount, 4);
  assert.equal(row.radarHailDays, 40);
  assert.equal(row.reportingGap, true, '40 radar days vs 4 filed reports');
});

test('does not flag an under-reported cell when reports already dominate', () => {
  const radarByCell = new Map([
    [
      '1:1',
      {
        i: 1,
        j: 1,
        maxHailMm: 60,
        corePoints: 400,
        hailDays: 3,
        firstYear: 2021,
        lastYear: 2026,
      },
    ],
  ]);
  const [row] = scoreCells(miniDataset({ radarByCell }));
  assert.equal(
    row.reportingGap,
    false,
    '3 radar days is not 1.5x of 4 reports',
  );
});

// ---------------------------------------------------------------------------
// Explanation copy
// ---------------------------------------------------------------------------

test('explains radar evidence and warns that MESH runs large', () => {
  const { details, caveat } = describeCellScore({
    score: 0.6,
    observed: 0.5,
    modelled: 0.4,
    exposure: 0.3,
    hailCount: 4,
    windCount: 2,
    maxHailIn: 2,
    maxWindKt: 60,
    compoundDays: 1,
    radarHailDays: 40,
    radarMaxHailMm: 88.9,
    reportingGap: true,
    firstYear: 1955,
    lastYear: 2026,
    county: null,
  });
  assert.ok(details.some((d) => d.includes('radar: hail cores on 40 days')));
  assert.ok(details.some((d) => d.includes('largest core 89 mm')));
  assert.ok(details.some((d) => d.includes('under-reported')));
  assert.match(caveat, /runs large/);
  assert.match(caveat, /2021/);
});

test('says nothing about radar when there is no radar evidence', () => {
  const { details, caveat } = describeCellScore({
    score: 0.6,
    observed: 0.5,
    modelled: 0.4,
    exposure: 0.3,
    hailCount: 4,
    windCount: 2,
    compoundDays: 0,
    radarHailDays: 0,
    firstYear: 1955,
    lastYear: 2026,
    county: null,
  });
  assert.ok(!details.some((d) => d.includes('radar')));
  assert.ok(!caveat || !caveat.includes('Radar'));
});

// ---------------------------------------------------------------------------
// Layer model surfaces
// ---------------------------------------------------------------------------

test('the panel label reports radar evidence and flags an under-reported cell', async () => {
  const { describeCell, mapAnalystCellRecord } =
    await import('../layers/hailwind/model.js');
  const row = {
    key: '1:1',
    hailCount: 4,
    windCount: 2,
    maxHailIn: 2,
    maxWindKt: 60,
    compoundDays: 1,
    radarHailDays: 40,
    radarMaxHailMm: 88.9,
    reportingGap: true,
    score: 0.61,
    band: 'orange',
    observed: 0.5,
    modelled: 0.4,
    exposure: 0.3,
    lat: 39.375,
    lon: -96.625,
  };
  const { title, details } = describeCell(row);
  assert.equal(title, '4 hail · 2 wind');
  assert.ok(details.some((d) => d.includes('radar hail cores on 40 days')));
  assert.ok(
    details.some((d) => d.includes('largest core 4"')),
    `millimetres converted to inches, got ${JSON.stringify(details)}`,
  );
  assert.ok(details.some((d) => d.includes('under-reported')));
});

test('the panel label renders a plain dataset cell without inventing radar', async () => {
  const { describeCell } = await import('../layers/hailwind/model.js');
  const { details } = describeCell({
    hailCount: 12,
    windCount: 3,
    maxHailIn: 1.75,
    maxWindKt: 55,
    compoundDays: 2,
    firstYear: 1995,
    lastYear: 2025,
  });
  assert.ok(!details.some((d) => d.includes('radar')));
  assert.ok(details.some((d) => d.includes('record 1995–2025')));
});

test('the analyst record carries radar fields as JSON-safe values', async () => {
  const { mapAnalystCellRecord } = await import('../layers/hailwind/model.js');
  const record = mapAnalystCellRecord({
    key: '1:1',
    score: 0.6123456,
    band: 'orange',
    hailCount: 4,
    windCount: 2,
    maxHailIn: 2,
    maxWindKt: 60,
    compoundDays: 1,
    radar: 0.5555555,
    radarHailDays: 40,
    radarMaxHailMm: 88.9,
    reportingGap: true,
    observed: 0.5,
    modelled: 0.4,
    exposure: 0.3,
    county: { name: 'Pottawatomie', st: 'KS' },
    lat: 39.375,
    lon: -96.625,
  });
  assert.equal(record.radarHailDays, 40);
  assert.equal(record.radarMaxHailMm, 88.9);
  assert.equal(record.reportingGap, true);
  assert.equal(record.county, 'Pottawatomie');
  assert.equal(JSON.parse(JSON.stringify(record)).reportingGap, true);
});

test('the analyst record reports no radar when the snapshot is absent', async () => {
  const { mapAnalystCellRecord } = await import('../layers/hailwind/model.js');
  const record = mapAnalystCellRecord({
    key: '1:1',
    score: 0.5,
    band: 'yellow',
    hailCount: 4,
    windCount: 2,
    observed: 0.5,
    modelled: 0.4,
    exposure: 0.3,
    lat: 1,
    lon: 1,
  });
  assert.equal(record.radarHailDays, 0);
  assert.equal(record.radarMaxHailMm, null);
  assert.equal(record.reportingGap, false);
});

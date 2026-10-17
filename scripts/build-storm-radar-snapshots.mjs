/**
 * Build the radar hail climatology snapshot from NOAA MRMS.
 *
 * Why this exists
 * ---------------
 * The bundled Storm Events snapshot is built from *reports*: point observations
 * of hail that somebody actually saw and filed. MRMS is the complementary
 * record — a national 1 km multi-radar mosaic that measures hail wherever a
 * storm exists, including the many swaths that produced no report at all. The
 * two answer different questions, and the gap between them is the point:
 * a cell that radar shows a strong hail core every June but that never appears
 * in the report record is a reporting gap, not a safe neighbourhood.
 *
 * Data
 * ----
 * `CONUS/MESH_Max_1440min_00.50` — the 24-hour rolling maximum of MRMS Maximum
 * Estimated Size of Hail, one file per day, covering 7000 x 3500 points at 0.01°.
 * Files are GRIB2 with PNG packing (data representation template 5.40), which is
 * what makes this tractable: a full 24.5M-point field arrives as ~0.1-1.5 MB.
 * Keyless — `s3://noaa-mrms-pds` needs no AWS account and charges no egress.
 *
 * Accuracy caveat, carried into the app rather than buried here
 * -------------------------------------------------------------
 * MESH is *estimated* from radar and is known to over-report compared with
 * ground reports (NSSL documents MESH running large relative to SPC reports).
 * It is a good measure of where hail fell and a poor measure of exactly how
 * large each stone was. The app therefore scores this as corroborating
 * evidence, never as a replacement for the report-based hail size.
 *
 * Output
 * ------
 * `storm_radar_hail.geojsonl` — 0.25 deg cells keyed with the same `i`/`j`
 * grid indices as `storm_cells_025.geojsonl`, so the app joins them directly.
 * Statistics there span the whole window.
 * `storm_radar_hail_<year>.geojsonl.gz` plus a `storm-radar-sources_<year>.json`
 * sidecar — the same grid scoped to one calendar year, so a consumer can pull a
 * single year's climatology without inflating the whole archive, and every
 * number in a year file describes only hail that fell in that year. A cell
 * active in several years appears in each of those years' files, once per year;
 * the combined file is the union of those year records merged on `i:j`, so the
 * two can never disagree. Every emitted file is ordered by a total order over the
 * cells, never by insertion order, so two runs over the same window produce
 * byte-identical artefacts.
 *
 * Usage
 *  node scripts/build-storm-radar-snapshots.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                                       [--days N] [--concurrency N] [--refresh]
 *
 * @module scripts/build-storm-radar-snapshots
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  parseGrib2,
  parseGrid,
  parseDataRepresentation,
  decodeValues,
  indexToLonLat,
} from './lib/grib2.mjs';
import {
  fetchBuffer,
  setRefresh,
  writeGeoJsonl,
  step,
} from './lib/storm-fetch.mjs';

const TOOL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const PROJECT_ROOT = path.resolve(process.env.GEV_PROJECT_ROOT || TOOL_ROOT);
const DEFAULT_OUT = path.join(
  PROJECT_ROOT,
  'src',
  'data',
  'local_data',
  'storm',
);

const BUCKET = 'https://noaa-mrms-pds.s3.amazonaws.com';
const PRODUCT = 'CONUS/MESH_Max_1440min_00.50';
const PRODUCT_LABEL = 'MRMS MESH 24-hour maximum';

/**
 * MESH, in millimetres, at or above which a cell counts as having had a hail
 * core on a given day. 25 mm is just under one inch — the point at which hail
 * does damage rather than merely fall, and it sits between MRMS's bias and a
 * genuinely damaging event.
 */
const HAIL_CORE_MM = 25;

/**
 * MESH, in millimetres, at or above which the *per-day* radar artifact keeps a
 * cell. Deliberately below {@link HAIL_CORE_MM}: a day whose radar shows 12 mm
 * in a cell nobody filed a stone in is exactly the finding the per-day artifact
 * exists to publish, and a 25 mm floor discards it before it reaches the
 * accumulator.
 *
 * The split is the load-bearing part, not the number. One threshold doing double
 * duty — deciding what to discard *and* what to emit — is precisely why the
 * per-day field could not be built at all. Separating them lets the per-day
 * artifact keep 10 mm cells while the per-year and combined GeoJSONL stay
 * byte-for-byte what they are.
 */
export const HAIL_RETAIN_MM = 10;

/**
 * Tenths of a millimetre per unit in the per-day binary encoding.
 *
 * The per-day artifact stores `maxMm × PER_DAY_MM_SCALE` in a `uint16`, so the
 * scale is a correctness constraint and not a formatting preference. MESH peaks
 * at 1437.4 mm over the archive, so scale 10 tops out at 14,374 and fits with
 * room to spare. A scale of 100 — the obvious "be precise" choice — reaches
 * 143,740 and wraps a `uint16` silently, turning a 1,437 mm reading into 11,284
 * and a 600 mm one into a negative. The scale is pinned here, exported, and
 * asserted in the tests for exactly that reason.
 */
export const PER_DAY_MM_SCALE = 10;

/** Bytes per per-day record: `u16 cellIndex, u16 dayIndex, u16 maxMm × scale`. */
export const PER_DAY_RECORD_BYTES = 6;

/**
 * Bytes per FINE per-day record: `u32 cellIndex, u32 dayIndex, u16 maxMm x scale`.
 *
 * The index is 32-bit because {@link GRID_CELL_COUNT_FINE} is 22,750,000 and
 * `writeUInt16LE` would truncate silently past 65,535. `dayIndex` is 32-bit for
 * symmetry and headroom: at a day a year it is a `uint16`, and a document that
 * stays valid as the archive grows is cheaper than one that needs re-encoding.
 *
 * 10 bytes per record rather than 4. That is affordable ONLY because the fine
 * field is per-CALENDAR-DAY, not per-year: within one shard `dayIndex` is
 * constant, so a production encoder drops it and writes 6 bytes — `u32 index,
 * u16 mm x scale`. {@link encodeFineDayRecords} is that encoder, and a test
 * pins the two widths apart.
 */
export const PER_DAY_RECORD_BYTES_FINE = 10;

/** The narrower per-shard width, which omits the constant dayIndex. */
export const FINE_DAY_RECORD_BYTES = 6;

/**
 * Magic at the head of a fine shard: ASCII `FINE`.
 *
 * It exists because the coarse per-day artifact has the SAME six-byte record
 * width, so length alone cannot tell the two families apart. Handing a coarse
 * shard to the fine decoder reads `u16 index, u16 day, u16 mm` as `u32 index,
 * u16 mm`: index 12,000 becomes 10,825,440 — inside the fine space — and 562
 * becomes a plausible 56.2 mm. Measured, not hypothesised. A magic word is the
 * only thing standing between a swapped payload and hail in the wrong county.
 */
export const FINE_DAY_MAGIC = Buffer.from([0x46, 0x49, 0x4e, 0x45]);
/** Bytes of magic before the first record. */
export const FINE_DAY_HEADER_BYTES = FINE_DAY_MAGIC.length;

/** Grid step of the emitted snapshot, degrees. Must match the report snapshot. */
export const CELL_DEG = 0.25;

/**
 * Western bound of the retained domain, degrees. MRMS longitudes start at
 * 230°E so the grid spans the dateline without a wrap seam; normalised to
 * -180..180 that begins at -129.995, and everything west of -125 is Pacific.
 *
 * There is deliberately no eastern bound, and adding one would be a data
 * change rather than a refactor: the grid runs east to -60.005 on its own, and
 * the published climatology already carries Great Lakes and East Coast cells.
 */
export const DOMAIN_MIN_LON = -125;

/**
 * Southern bound, degrees. Below 21°N is the Gulf, Mexico and the Caribbean —
 * outside the CONUS envelope the sidecars describe. Inclusive: a point at
 * exactly 21°N is retained.
 */
export const DOMAIN_MIN_LAT = 21;

/**
 * Northern bound, degrees, inclusive. The MRMS CONUS grid currently tops out at
 * 54.995°N so this bound does not bite today. It is pinned anyway because the
 * emitted row count is derived from it, and a grid that grew north would
 * otherwise widen the index space with nothing anywhere to notice.
 */
export const DOMAIN_MAX_LAT = 56;

/**
 * Eastern edge of the MRMS CONUS grid, degrees. Measured off the archive
 * rather than assumed: 7,000 columns of 0.01° from 230.005°E normalises to
 * -129.995 .. -60.005. This is what bounds the emitted column count, since the
 * domain itself stops at the dateline side.
 */
export const GRID_MAX_LON = -60;

/** First retained grid row, `DOMAIN_MIN_LAT / CELL_DEG`. */
export const GRID_ROW_BASE = Math.round(DOMAIN_MIN_LAT / CELL_DEG);
/** First retained grid column, `DOMAIN_MIN_LON / CELL_DEG`. */
export const GRID_COL_BASE = Math.round(DOMAIN_MIN_LON / CELL_DEG);
/** Rows the retained domain can address: 35° of latitude / CELL_DEG. */
export const GRID_ROWS = Math.round(
  (DOMAIN_MAX_LAT - DOMAIN_MIN_LAT) / CELL_DEG,
);
/** Columns the retained domain can address: 65° of longitude / CELL_DEG. */
export const GRID_COLUMNS = Math.round((GRID_MAX_LON - DOMAIN_MIN_LON) / CELL_DEG);
/**
 * Cells the retained index space can address. The per-day artifact stores this
 * position as a `uint16`, so this number staying under 65,536 is not a style
 * preference — it is the whole reason the encoding is 16-bit rather than 32.
 */
export const GRID_CELL_COUNT = GRID_ROWS * GRID_COLUMNS;

/*
 * The fine grid — 1 km, for the per-day swath field.
 * =======================================================================
 *
 * The source is 1 km and always was. `DATA_SOURCES.md` says so, and it is
 * measurable off any cached day: `ni = 7000`, `nj = 3500`, 24,500,000 points,
 * first point at 54.995N / -129.995E. The `_00.50` in the product name is not
 * the grid step.
 *
 * The 0.25 degree grid above is therefore OUR downsample, by a factor of 25 in
 * each axis: every published cell is a 2x2 block of fine cells collapsed to one
 * value. It was chosen for exactly one reason, stated at `cellIndex`: 0.25
 * degrees gives 140 x 260 = 36,400 addressable cells, which fits a `uint16`. At
 * 0.01 degrees the retained domain is 22.75M cells and the index has to widen.
 *
 * Measured, on ten days across the three-year window, at the 10 mm floor:
 *
 *     day          1km cells   rings   0.25deg cells   ratio
 *     2025-06-18      147,815   4,348           3,003    32x
 *     2024-07-15      115,313   4,330           ~2,300   50x
 *     2026-06-01       68,774   2,649             300    32x
 *     2023-02-06          606     116               ~20   ~0
 *
 * So the detail is real and worth having; what it costs is payload and render
 * count, and both are budgeted rather than discovered later.
 */

/** Grid step of the fine per-day swath field, degrees. 1 km at this latitude. */
export const CELL_DEG_FINE = 0.01;

/** First retained fine grid row, `DOMAIN_MIN_LAT / CELL_DEG_FINE`. */
export const GRID_ROW_BASE_FINE = Math.round(DOMAIN_MIN_LAT / CELL_DEG_FINE);
/** First retained fine grid column, `DOMAIN_MIN_LON / CELL_DEG_FINE`. */
export const GRID_COL_BASE_FINE = Math.round(DOMAIN_MIN_LON / CELL_DEG_FINE);
/** Rows the retained fine domain can address. */
export const GRID_ROWS_FINE = Math.round(
  (DOMAIN_MAX_LAT - DOMAIN_MIN_LAT) / CELL_DEG_FINE,
);
/** Columns the retained fine domain can address. */
export const GRID_COLUMNS_FINE = Math.round(
  (GRID_MAX_LON - DOMAIN_MIN_LON) / CELL_DEG_FINE,
);
/**
 * Cells the retained fine index space can address.
 *
 * 22.75 million, which is why the fine per-day record stores this as a `uint32`
 * and not a `uint16`: `Buffer.writeUInt16LE` truncates silently past 65,535,
 * which at this size would alias thousands of cells onto each other and shift
 * hail across the map with no error at any later stage.
 */
export const GRID_CELL_COUNT_FINE = GRID_ROWS_FINE * GRID_COLUMNS_FINE;

/**
 * The fine per-day floor, millimetres.
 *
 * NOT 10, and the measurement is what decided it. At 19 mm — three-quarters of
 * an inch, which is the NWS severe threshold and the lowest band the category
 * draws — the payload across the three-year window falls from 245 MB to 28 MB
 * and the mean ring count from 3,065 to 979. That is 8.8x smaller and 3.1x fewer
 * shapes, for a floor that is a documented public severity threshold rather
 * than an arbitrary round number.
 *
 * It is a SEPARATE constant from {@link HAIL_RETAIN_MM} for the same reason
 * that one is separate from `HAIL_CORE_MM`: the coarse per-day field stays at
 * 10 mm because it is published and committed, and changing its floor would
 * re-date and re-rank an artifact people already have.
 */
export const HAIL_RETAIN_MM_FINE = 19;

/**
 * Day zero for the per-day artifact's `dayIndex`, ISO form. Fixed to the first
 * day of the MRMS archive so an index means the same calendar day in every
 * build: counted from the window start instead, extending the window by a day
 * would shift every earlier index and silently re-date the archive.
 *
 * The index is a `uint16`, so it addresses 65,536 days — the year 2199 — from
 * here. That is a limit worth stating rather than discovering.
 */
export const DAY_INDEX_EPOCH = '2021-01-01';

/** Guard against a pathological day materialising every CONUS cell. */
const MAX_CELLS = 40000;

/**
 * Grid row of a decoded latitude, as the emitted `i` property counts them.
 * @param {number} lat
 * @returns {number}
 */
export function gridRow(lat) {
  return Math.floor(lat / CELL_DEG);
}

/**
 * Grid column of a decoded longitude, as the emitted `j` property counts them.
 * @param {number} lon
 * @returns {number}
 */
export function gridCol(lon) {
  return Math.floor(lon / CELL_DEG);
}

/**
 * Does a decoded point fall inside the retained domain? All three bounds are
 * inclusive, which is what the original inline filter implied and what the
 * boundary tests pin.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function inDomain(lat, lon) {
  return (
    lon >= DOMAIN_MIN_LON && lat >= DOMAIN_MIN_LAT && lat <= DOMAIN_MAX_LAT
  );
}

/**
 * The flat cell index the per-day artifact stores alongside `dayIndex`.
 *
 * This is the function the per-day encoding rests on, so it refuses rather than
 * degrades: a cell outside the retained space would alias onto a real cell's
 * index and quietly misplace hail on the map, with no error at any later stage.
 * Every axis is bounds-checked for that reason.
 *
 * @param {number} i Grid row, as the `i` property counts them.
 * @param {number} j Grid column, as the `j` property counts them.
 * @returns {number} Index in `[0, GRID_CELL_COUNT)`.
 * @throws {RangeError} when the cell falls outside the retained index space.
 */
export function cellIndex(i, j) {
  const row = i - GRID_ROW_BASE;
  const col = j - GRID_COL_BASE;
  if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLUMNS) {
    throw new RangeError(
      `cell ${i}:${j} falls outside the ${GRID_ROWS}x${GRID_COLUMNS} retained index space`,
    );
  }
  return row * GRID_COLUMNS + col;
}

/**
 * The fine grid's flat cell index — the 1 km sibling of {@link cellIndex}.
 *
 * Same contract, deliberately: it refuses rather than degrades, because an
 * out-of-range index aliases onto a real cell's index and quietly misplaces
 * hail on the map with no error at any later stage. Both axes are bounds-checked
 * for exactly that reason.
 *
 * The return value does NOT fit a `uint16`. {@link GRID_CELL_COUNT_FINE} is
 * 22,750,000, and `Buffer.writeUInt16LE` truncates silently past 65,535 — so
 * the fine encoding writes `uint32`. That is the whole reason the fine grid
 * could not simply reuse the coarse artifact's record layout, and the test
 * suite asserts the ceiling rather than trusting it.
 *
 * @param {number} i Fine grid row, `lat / CELL_DEG_FINE`.
 * @param {number} j Fine grid column, `lon / CELL_DEG_FINE`.
 * @returns {number} Index in `[0, GRID_CELL_COUNT_FINE)`.
 * @throws {RangeError} when the cell falls outside the retained fine space.
 */
export function cellIndexFine(i, j) {
  const row = i - GRID_ROW_BASE_FINE;
  const col = j - GRID_COL_BASE_FINE;
  if (
    row < 0 ||
    row >= GRID_ROWS_FINE ||
    col < 0 ||
    col >= GRID_COLUMNS_FINE
  ) {
    throw new RangeError(
      `fine cell ${i}:${j} falls outside the ${GRID_ROWS_FINE}x${GRID_COLUMNS_FINE} retained fine index space`,
    );
  }
  return row * GRID_COLUMNS_FINE + col;
}

/**
 * The inverse of {@link cellIndexFine}: fine `i:j` from a stored index.
 *
 * A sibling rather than a parameterised {@link cellIndex} so the coarse path
 * cannot be handed fine bases by a caller that means the coarse ones — the two
 * grids differ by 25x in each axis, and mixing them places hail in the wrong
 * hemisphere rather than throwing.
 *
 * @param {number} index
 * @returns {{i: number, j: number}}
 * @throws {RangeError} when the index is outside the retained fine space.
 */
export function cellIJFine(index) {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= GRID_CELL_COUNT_FINE
  ) {
    throw new RangeError(
      `fine index ${index} is outside [0, ${GRID_CELL_COUNT_FINE})`,
    );
  }
  return {
    i: Math.floor(index / GRID_COLUMNS_FINE) + GRID_ROW_BASE_FINE,
    j: (index % GRID_COLUMNS_FINE) + GRID_COL_BASE_FINE,
  };
}

/**
 * First day of the MRMS archive for this product. A bare run reproduces the
 * bundled snapshot exactly, so the committed artefact is never the product of
 * "whatever window someone happened to pass".
 */
const ARCHIVE_START = '2021-01-01';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    out: DEFAULT_OUT,
    concurrency: 4,
    refresh: false,
    from: null,
    to: null,
    days: null,
    // How many years of 1 km detail to keep. Three by default, from the
    // operator's retention call: insurance claim windows close at one to two
    // years, so a decade of fine payload is gigabytes nobody will query.
    fineYears: 3,
    // Build ONLY the fine 1 km family, leaving every coarse artifact untouched.
    // This exists because of a real mistake, not a hypothetical one: a fine-only
    // rolling window is exactly how you would use this, and without the flag a
    // three-year run REWRITES the six-year climatology. The combined
    // storm_radar_hail.geojsonl is truncated to the run window, and the per-year
    // per-day files change because MAX_CELLS truncation is decided on the
    // merged set. GATE A caught it; this is the fix.
    fineOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--refresh') out.refresh = true;
    else if (arg === '--out') out.out = path.resolve(argv[++i]);
    else if (arg === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (arg === '--from') out.from = argv[++i];
    else if (arg === '--to') out.to = argv[++i];
    else if (arg === '--days') out.days = Number(argv[++i]);
    else if (arg === '--fine-years') out.fineYears = Number(argv[++i]);
    else if (arg === '--fine-only') out.fineOnly = true;
  }
  if (!Number.isFinite(out.concurrency) || out.concurrency < 1)
    out.concurrency = 4;
  if (!Number.isFinite(out.fineYears) || out.fineYears < 1) out.fineYears = 3;
  return out;
}

/** Inclusive list of YYYYMMDD strings between two dates. */
function dateRange(from, to) {
  const days = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    const ymd = cursor.toISOString().slice(0, 10).replaceAll('-', '');
    days.push(ymd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Fetch — or lazily create — the per-year slice of the accumulator.
 *
 * The accumulator is `Map<year, Map<'i:j', cell>>` rather than one flat
 * `Map<'i:j', cell>`, and this is the whole point of the file: a per-year
 * snapshot is only meaningful if a cell's statistics describe the year the
 * consumer asked for. A flat map makes `mx`/`cp`/`dy` lifetime aggregates, so a
 * "2021" file built by filtering that map carries numbers earned in 2024 and
 * omits every cell that merely happened to be active in 2021 — the exact
 * inversion that makes a year file useless for scoring one storm day.
 *
 * Keying on the year of the day being ingested (rather than on a cell's first or
 * last active day) is what lets one cell appear in every year file it was
 * active in, each carrying that year's own numbers.
 *
 * @param {Map<number, Map<string, object>>} cellsByYear Accumulator, mutated in place.
 * @param {string} ymd Day stamp; its year selects the bucket.
 * @returns {{year: number, bucket: Map<string, object>}}
 */
export function yearBucket(cellsByYear, ymd) {
  const year = Number(ymd.slice(0, 4));
  let bucket = cellsByYear.get(year);
  if (!bucket) {
    bucket = new Map();
    cellsByYear.set(year, bucket);
  }
  return { year, bucket };
}

/**
 * Decode one MRMS daily-maximum file into that year's per-cell statistics.
 *
 * @param {Buffer} gzipped Raw `.grib2.gz` bytes.
 * @param {string} ymd Day stamp, for the year bucket and the per-cell day tally.
 * @param {Map<number, Map<string, object>>} cellsByYear Accumulator, mutated in place.
 * @param {{retainMm?: number}} [options] `retainMm` is the floor this call keeps,
 *   defaulting to {@link HAIL_CORE_MM}. It defaults to the core threshold because
 *   the per-year and combined artefacts are defined by cores; the per-day artifact
 *   passes {@link HAIL_RETAIN_MM} to see the sub-core field. A point below either
 *   floor is discarded before the domain test, which is why the two had to be split:
 *   one constant could not be both the discard floor and the emission rule.
 * @param {{finePerDay?: Map<string, Map<string, number>>}} [options]
 *   `finePerDay` is `Map<ymd, Map<'i:j', maxMm>>` at 1 km and the higher
 *   {@link HAIL_RETAIN_MM_FINE} floor. Keyed by DAY rather than by cell,
 *   because the fine artifact ships one file per calendar day; keying by cell
 *   and nesting days inside it is the coarse shape and it does not survive a
 *   25x finer grid.
 * @param {{perDay?: Map<string, Map<string, number>>}} [options] `perDay` is an
 *   optional second accumulator, `Map<'i:j', Map<ymd, maxMm>>`, that records the
 *   strongest reading in every retained cell on every day it reaches
 *   {@link HAIL_RETAIN_MM}. It is a separate map rather than a field on the cell
 *   on purpose: a 12 mm cell has no business in the year bucket, and adding one
 *   would emit it as a line in the published climatology with `cp: 0`. Keeping it
 *   separate makes the byte-identity invariant structural instead of a filter
 *   somebody has to remember.
 * @returns {{points: number, maxMm: number|null, cellsTouched: number, year: number}}
 */
export function ingestMeshGz(gzipped, ymd, cellsByYear, options = {}) {
  const retainMm = options.retainMm ?? HAIL_CORE_MM;
  const perDay = options.perDay ?? null;
  const finePerDay = options.finePerDay ?? null;
  const { year, bucket: cells } = yearBucket(cellsByYear, ymd);
  const raw = zlib.gunzipSync(gzipped);
  const message = parseGrib2(raw);
  const packing = parseDataRepresentation(message.sections);
  const grid = parseGrid(message.sections, packing.numberOfValues);
  const values = decodeValues(message.sections, packing, grid);

  let maxMm = null;
  let points = 0;
  for (let i = 0; i < values.length; i += 1) {
    const mm = values[i];
    // The per-day field is read *before* the core gate, and that ordering is the
    // whole reason the two thresholds were split: a 12 mm core in an unreported
    // cell is precisely what the per-day artifact exists to publish, and the
    // core gate would have discarded it a line earlier.
    if (perDay && mm >= HAIL_RETAIN_MM) {
      const spot = indexToLonLat(grid, i);
      if (inDomain(spot.lat, spot.lon)) {
        const dayKey = `${gridRow(spot.lat)}:${gridCol(spot.lon)}`;
        let days = perDay.get(dayKey);
        if (!days) {
          days = new Map();
          perDay.set(dayKey, days);
        }
        const seen = days.get(ymd);
        if (seen === undefined || mm > seen) days.set(ymd, mm);
      }
    }
    // The FINE accumulator, at the finer grid and the higher floor. Separate
    // from the coarse one above for the same reason they are separate constants:
    // the coarse per-day artifact is published and committed, and touching its
    // floor or its grid would re-rank data people already have.
    if (finePerDay && mm >= HAIL_RETAIN_MM_FINE) {
      const fineSpot = indexToLonLat(grid, i);
      if (inDomain(fineSpot.lat, fineSpot.lon)) {
        let dayCells = finePerDay.get(ymd);
        if (!dayCells) {
          dayCells = new Map();
          finePerDay.set(ymd, dayCells);
        }
        // Keyed by the fine i:j, at 1 km rather than the coarse 0.25 degrees.
        const fineKey = `${Math.floor(fineSpot.lat / CELL_DEG_FINE)}:${Math.floor(
          fineSpot.lon / CELL_DEG_FINE,
        )}`;
        const seenFine = dayCells.get(fineKey);
        if (seenFine === undefined || mm > seenFine) dayCells.set(fineKey, mm);
      }
    }
    if (!(mm >= retainMm)) continue;
    points += 1;
    if (maxMm == null || mm > maxMm) maxMm = mm;
    const { lat, lon } = indexToLonLat(grid, i);
    if (!inDomain(lat, lon)) continue;
    const i0 = gridRow(lat);
    const j0 = gridCol(lon);
    const key = `${i0}:${j0}`;
    let cell = cells.get(key);
    if (!cell) {
      // Every field here is scoped to `year` alone. `firstYmd`/`lastYmd` can no
      // longer disagree about the year, which is what lets the emitter publish
      // them as `y0`/`y1` without inventing a cross-year span in a per-year file.
      cell = {
        i: i0,
        j: j0,
        maxMm: null,
        corePoints: 0,
        days: new Set(),
        firstYmd: ymd,
        lastYmd: ymd,
      };
      cells.set(key, cell);
    }
    if (cell.maxMm == null || mm > cell.maxMm) cell.maxMm = mm;
    cell.corePoints += 1;
    cell.days.add(ymd);
    if (ymd < cell.firstYmd) cell.firstYmd = ymd;
    if (ymd > cell.lastYmd) cell.lastYmd = ymd;
  }
  return { points, maxMm, cellsTouched: cells.size, year };
}

/**
 * Fetch one day and fold it into that day's year bucket.
 * @param {string} ymd
 * @param {Map<number, Map<string, object>>} cellsByYear
 * @param {{perDay?: Map<string, Map<string, number>>}} [options] Passed through
 *   to {@link ingestMeshGz}.
 * @returns {Promise<{ymd:string, ok:boolean, points:number, error?:string}>}
 */
async function ingestDay(ymd, cellsByYear, options = {}) {
  const key = `${PRODUCT}/${ymd}/MRMS_MESH_Max_1440min_00.50_${ymd}-000000.grib2.gz`;
  try {
    const body = await fetchBuffer(`${BUCKET}/${key}`);
    const result = ingestMeshGz(body, ymd, cellsByYear, options);
    return { ymd, ok: true, points: result.points };
  } catch (error) {
    // A missing day (product not produced, outage, or a gap in the archive) is
    // recorded, not fatal: a climatology with holes is still useful, and a hard
    // failure would block the build entirely.
    return { ymd, ok: false, points: 0, error: error.message };
  }
}

/**
 * Run `worker` over `items` with bounded concurrency.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} worker
 */
async function pooled(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Selection and partitioning (pure — no I/O, no clock, no network)
// ---------------------------------------------------------------------------

/**
 * Total order over features: strongest hail first, grid index as the tiebreak.
 *
 * The tiebreak is not cosmetic. `[...cells.values()]` is Map insertion order,
 * which under `pooled()` is whatever finished downloading first — so two runs
 * over the same window produce different line order, and `slice(0, MAX_CELLS)`
 * keeps a different *set* of cells each time. Sorting on `mx` alone would leave
 * exact ties (rounded to 0.1 mm) to that same nondeterministic order, so the
 * `i`/`j` tiebreak is what makes the emitted bytes reproducible.
 *
 * @param {{properties: {mx: number, i: number, j: number}}} a
 * @param {{properties: {mx: number, i: number, j: number}}} b
 * @returns {number}
 */
export function compareBySeverity(a, b) {
  const byPeak = (b?.properties?.mx ?? 0) - (a?.properties?.mx ?? 0);
  if (byPeak) return byPeak;
  // Numeric, not lexical: `i`/`j` are signed grid indices and "-9" sorts after
  // "-10" as a string.
  return (
    (a?.properties?.i ?? 0) - (b?.properties?.i ?? 0) ||
    (a?.properties?.j ?? 0) - (b?.properties?.j ?? 0)
  );
}

/**
 * Rank features by hail severity and apply the MAX_CELLS ceiling.
 *
 * Ranking before slicing is load-bearing. The ceiling exists to keep a
 * pathological window from emitting every CONUS cell, so what it discards must
 * be the *weakest* hail: a cell with a 25 mm core may be dropped while a 200 mm
 * core survives, which inverts the meaning of the artifact it produces. The
 * pre-truncation count comes back with the kept set so the meta sidecar can
 * record that a ceiling was applied at all — otherwise the file on disk is
 * indistinguishable from a window that genuinely held only `maxCells` cells.
 *
 * @param {Array<object>} features
 * @param {number} maxCells
 * @returns {{kept: Array<object>, truncated: boolean, cellsBeforeTruncation: number}}
 */
export function selectKeptCells(features, maxCells) {
  const ranked = [...(features ?? [])].sort(compareBySeverity);
  const cellsBeforeTruncation = ranked.length;
  const truncated = cellsBeforeTruncation > maxCells;
  return {
    kept: truncated ? ranked.slice(0, maxCells) : ranked,
    truncated,
    cellsBeforeTruncation,
  };
}

/**
 * One cell's worth of accumulated statistics, as the emitter sees it.
 * @typedef {Object} RadarCell
 * @property {number} i
 * @property {number} j
 * @property {number|null} maxMm
 * @property {number} corePoints
 * @property {Set<string>} days
 * @property {string} firstYmd
 * @property {string} lastYmd
 */

/**
 * Emit one feature. The property shape (`i j d mx cp dy y0 y1`) is fixed by the
 * consumers — `stormCrossReference.js` and `stormDatasets.js` index on `i:j` and
 * read `mx`/`cp` — so it is built in one place and never varies, whether the
 * feature describes one year or the whole archive.
 *
 * Rounding happens on the way out, not on the way in, so a merged cell's `mx`
 * is the max of its per-year maxima rather than a max taken over already-rounded
 * values. (Rounding is monotone, so the two agree — but only because the raw
 * value is still in hand here.)
 *
 * @param {number} i
 * @param {number} j
 * @param {{mx: number, cp: number, dy: number, y0: number, y1: number}} stats
 * @returns {object}
 */
export function cellFeature(i, j, stats) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [
        Math.round((j * CELL_DEG + CELL_DEG / 2) * 100000) / 100000,
        Math.round((i * CELL_DEG + CELL_DEG / 2) * 100000) / 100000,
      ],
    },
    properties: {
      i,
      j,
      d: CELL_DEG,
      mx: Math.round(stats.mx * 10) / 10,
      cp: stats.cp,
      dy: stats.dy,
      y0: stats.y0,
      y1: stats.y1,
    },
  };
}

/**
 * One accumulator bucket to one year's features, ranked strongest-first.
 *
 * `y0` and `y1` are both the bucket's year. That is not a simplification: the
 * statistics in the feature only describe that year, so claiming the cell was
 * active anywhere else would contradict the numbers printed beside it.
 *
 * @param {number} year
 * @param {Map<string, RadarCell>} bucket
 * @returns {Array<object>}
 */
export function yearFeatures(year, bucket) {
  return [...bucket.values()]
    .map((cell) =>
      cellFeature(cell.i, cell.j, {
        mx: cell.maxMm,
        cp: cell.corePoints,
        dy: cell.days.size,
        y0: year,
        y1: year,
      }),
    )
    .sort(compareBySeverity);
}

/**
 * Every accumulator bucket to per-year feature lists, ascending by year.
 *
 * @param {Map<number, Map<string, RadarCell>>} cellsByYear
 * @returns {Map<number, Array<object>>}
 */
export function featuresByYear(cellsByYear) {
  return new Map(
    [...cellsByYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, bucket]) => [year, yearFeatures(year, bucket)]),
  );
}

/**
 * Fold the per-year features back into one whole-archive snapshot.
 *
 * This is the inverse of the partition, and it is derived *from* the per-year
 * files rather than from a parallel accumulator, so the two can never disagree:
 * `mx` is the strongest year, `cp` and `dy` sum (a distinct hail day falls in
 * exactly one year, so summing per-year day counts reproduces the lifetime
 * count), and `y0`/`y1` widen to the span the cell was active over. The property
 * shape is unchanged, so the combined file reads the same as it always did.
 *
 * Output order follows first appearance across ascending years, which is stable;
 * the caller sorts it through `selectKeptCells` anyway.
 *
 * @param {Map<number, Array<object>>} byYear
 * @returns {Array<object>}
 */
export function mergeYearFeatures(byYear) {
  /** @type {Map<string, {i:number,j:number,mx:number,cp:number,dy:number,y0:number,y1:number}>} */
  const merged = new Map();
  for (const [year, list] of [...(byYear ?? new Map())].sort(
    (a, b) => a[0] - b[0],
  )) {
    for (const feature of list ?? []) {
      const p = feature?.properties;
      if (!p || p.i === undefined || p.j === undefined) continue;
      const key = `${p.i}:${p.j}`;
      const mx = Number(p.mx) || 0;
      const cp = Number(p.cp) || 0;
      const dy = Number(p.dy) || 0;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          i: p.i,
          j: p.j,
          mx,
          cp,
          dy,
          y0: year,
          y1: year,
        });
        continue;
      }
      existing.mx = Math.max(existing.mx, mx);
      existing.cp += cp;
      existing.dy += dy;
      existing.y0 = Math.min(existing.y0, year);
      existing.y1 = Math.max(existing.y1, year);
    }
  }
  return [...merged.values()].map((stats) =>
    cellFeature(stats.i, stats.j, stats),
  );
}

/**
 * Restrict every year's feature list to the cells that survived the combined
 * snapshot's ceiling.
 *
 * Truncation is decided once, globally, on the merged set — `MAX_CELLS` bounds
 * the combined artefact, and re-deciding it per year would either let a year
 * file exceed the ceiling the combined file honours or drop cells the combined
 * file kept. Filtering by kept key keeps the union of the year files an exact
 * partition of the combined file under every regime, truncated or not.
 *
 * @param {Map<number, Array<object>>} byYear
 * @param {Set<string>} keptKeys `i:j` keys present in the combined snapshot.
 * @returns {Map<number, Array<object>>}
 */
export function restrictYearsToKeys(byYear, keptKeys) {
  const out = new Map();
  for (const [year, list] of byYear ?? []) {
    // `list` is already ranked; filtering preserves that total order.
    out.set(
      year,
      (list ?? []).filter((f) =>
        keptKeys.has(`${f.properties.i}:${f.properties.j}`),
      ),
    );
  }
  return out;
}

/**
 * Write a gzipped GeoJSONL snapshot atomically, one feature per line.
 *
 * Mirrors `writeGeoJsonl` from `lib/storm-fetch.mjs` — same tmp-then-rename, so
 * a crashed run cannot leave a half-written artefact that later reads as valid —
 * but the payload goes through `gzipSync` at the level the rest of the storm
 * builders use. `gzipSync` stamps no mtime into the header, which is what makes
 * repeated runs byte-identical rather than merely equal in content.
 *
 * @param {string} file Absolute destination path.
 * @param {Array<object>} features
 * @returns {Promise<number>} Bytes on disk.
 */
export async function writeGeoJsonlGz(file, features) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const chunks = [];
  for (const feature of features) chunks.push(`${JSON.stringify(feature)}\n`);
  await fs.writeFile(tmp, zlib.gzipSync(chunks.join(''), { level: 9 }));
  await fs.rename(tmp, file);
  const { size } = await fs.stat(file);
  return size;
}

/**
 * Turn a per-day accumulator into the flat records the binary artifact stores.
 *
 * `dayIndex` is an offset in days from {@link DAY_INDEX_EPOCH}, not from the
 * window start, and that choice is what makes the artifact re-readable. The
 * window end moves every rebuild, so an index counted from the window start would
 * silently re-date every record the next time the window is extended: index 0
 * would quietly become a different day. The epoch is fixed by the archive, so an
 * index means the same day forever and the sidecar can state it once.
 *
 * Cells outside `keptKeys` are dropped here rather than written and filtered
 * later. `MAX_CELLS` currently sits at 21,947 of 40,000, but when it bites, a
 * day record for a cell the combined file dropped is a record the consumer
 * cannot join to anything.
 *
 * @param {Map<string, Map<string, number>>} perDay `Map<'i:j', Map<ymd, maxMm>>`.
 * @param {Set<string>} keptKeys `i:j` keys present in the combined snapshot.
 * @returns {Array<{cellIndex: number, dayIndex: number, maxMm: number}>}
 */
export function perDayRecords(perDay, keptKeys) {
  const records = [];
  for (const [key, days] of perDay ?? []) {
    if (!keptKeys.has(key)) continue;
    const [i, j] = key.split(':').map(Number);
    const index = cellIndex(i, j);
    for (const [ymd, maxMm] of days) {
      records.push({ cellIndex: index, dayIndex: dayIndex(ymd), maxMm });
    }
  }
  return records;
}

/**
 * Days from {@link DAY_INDEX_EPOCH} to `ymd`, the index the artifact stores.
 *
 * @param {string} ymd Day stamp, `YYYYMMDD`.
 * @returns {number}
 */
export function dayIndex(ymd) {
  const toMs = (stamp) => {
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
    return Date.parse(`${iso}T00:00:00Z`);
  };
  return Math.round((toMs(ymd) - toMs(DAY_INDEX_EPOCH.replaceAll('-', ''))) / 86_400_000);
}

/**
 * The inverse of {@link dayIndex}: the day a stored index refers to.
 *
 * @param {number} index
 * @returns {string} `YYYYMMDD`.
 * @throws {RangeError} when the index is outside what a `uint16` can hold.
 */
export function dayFromIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index > 65_535) {
    throw new RangeError(
      `day index ${index} is not a uint16; a stored index cannot address it`,
    );
  }
  const epoch = Date.parse(`${DAY_INDEX_EPOCH}T00:00:00Z`);
  const iso = new Date(epoch + index * 86_400_000).toISOString().slice(0, 10);
  return iso.replaceAll('-', '');
}

/**
 * The inverse of the per-day encoding, for tests and for anyone checking an
 * artifact by hand.
 *
 * @param {Buffer} bytes Decompressed payload.
 * @returns {Array<{cellIndex: number, dayIndex: number, maxMm: number}>}
 * @throws {RangeError} when the payload is not a whole number of records.
 */
export function decodePerDayRecords(bytes) {
  if (bytes.length % PER_DAY_RECORD_BYTES !== 0) {
    throw new RangeError(
      `per-day payload is ${bytes.length} bytes, not a whole number of ${PER_DAY_RECORD_BYTES}-byte records`,
    );
  }
  const out = [];
  for (let at = 0; at < bytes.length; at += PER_DAY_RECORD_BYTES) {
    out.push({
      cellIndex: bytes.readUInt16LE(at),
      dayIndex: bytes.readUInt16LE(at + 2),
      maxMm: bytes.readUInt16LE(at + 4) / PER_DAY_MM_SCALE,
    });
  }
  return out;
}

/**
 * Encode per-day records to the artifact's binary payload, uncompressed.
 *
 * The sort is load-bearing rather than tidy. Records arrive in accumulator order,
 * which under `pooled()` is download-completion order, so two runs over the same
 * window would otherwise produce different bytes for identical data — the exact
 * failure the GeoJSONL writers avoid with `compareBySeverity`. `(dayIndex,
 * cellIndex)` is a total order over distinct records, and no two records can
 * share it, because a cell holds one reading per day.
 *
 * Every field is range-checked before it is written. A `uint16` past 65,535 does
 * not throw; `Buffer.writeUInt16LE` silently truncates, which would turn a
 * 1,437 mm day into 11,284 and ship it. Refusing is the only safe answer.
 *
 * @param {Array<{cellIndex: number, dayIndex: number, maxMm: number}>} records
 * @returns {Buffer}
 */
export function encodePerDayRecords(records) {
  const ordered = [...(records ?? [])].sort(
    (a, b) => a.dayIndex - b.dayIndex || a.cellIndex - b.cellIndex,
  );
  const buffer = Buffer.alloc(ordered.length * PER_DAY_RECORD_BYTES);
  ordered.forEach((record, n) => {
    const scaled = Math.round(record.maxMm * PER_DAY_MM_SCALE);
    for (const [label, value] of [
      ['cellIndex', record.cellIndex],
      ['dayIndex', record.dayIndex],
      ['maxMm x PER_DAY_MM_SCALE', scaled],
    ]) {
      if (!Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new RangeError(
          `per-day ${label} ${value} does not fit a uint16; raise the encoding width rather than truncating`,
        );
      }
    }
    const at = n * PER_DAY_RECORD_BYTES;
    buffer.writeUInt16LE(record.cellIndex, at);
    buffer.writeUInt16LE(record.dayIndex, at + 2);
    buffer.writeUInt16LE(scaled, at + 4);
  });
  return buffer;
}

/**
 * Write the per-day radar artifact atomically: gzip level 9, no mtime, so two
 * runs over the same window produce identical bytes.
 *
 * @param {string} file Absolute destination path.
 * @param {Array<{cellIndex: number, dayIndex: number, maxMm: number}>} records
 * @returns {Promise<number>} Bytes on disk.
 */
export async function writePerDayBin(file, records) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, zlib.gzipSync(encodePerDayRecords(records), { level: 9 }));
  await fs.rename(tmp, file);
  const { size } = await fs.stat(file);
  return size;
}

/**
 * Write ONE calendar day's fine shard.
 *
 * Atomic for the same reason {@link writePerDayBin} is: a half-written gzip
 * that decodes to plausible garbage is worse than a missing one, because the
 * loader keys "absent" on the payload's shape and a truncated one passes that
 * check.
 *
 * @param {string} file destination path
 * @param {Array<{i: number, j: number, maxMm: number}>} cells one day's cells
 * @returns {Promise<number>} bytes written
 */
export async function writeFineDayBin(file, cells) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const gz = zlib.gzipSync(encodeFineDayRecords(ymdFromFile(file), cells), {
    level: 9,
  });
  await fs.writeFile(tmp, gz);
  await fs.rename(tmp, file);
  return gz.length;
}

/** `..._2026-06-01.bin.gz` -> `20260601`, for the shard's own day. */
function ymdFromFile(file) {
  const match = /_(\d{4})-(\d{2})-(\d{2})\.bin\.gz$/.exec(file);
  if (!match) throw new Error(`fine shard filename carries no day: ${file}`);
  return `${match[1]}${match[2]}${match[3]}`;
}

/** The filename a given day's fine shard is published under. */
export function fineDayFileName(ymd) {
  return `storm_radar_hail_fine_${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}.bin.gz`;
}

/**
 * The manifest for the fine family.
 *
 * This did not exist for the coarse artifacts and that is a real gap the
 * exploration turned up: 1,019 files regenerated in place on every rebuild with
 * nothing recording which days SHOULD be there. A day that silently vanished
 * from a rebuild would be invisible — there is no hash check, no prune script
 * and no CI job that reads the payload directory. This manifest is what makes
 * that detectable: a day in `days` with no file beside it is a broken build.
 *
 * @param {object} input
 * @returns {object} the sidecar body
 */
export function fineDayMeta(input) {
  const { builtAt, window: win, unavailableDays = [], days, recordCount, cellCount, bytes } = input;
  return {
    builtAt,
    format: 'fine-per-day',
    geometry: {
      gridDeg: CELL_DEG_FINE,
      rowBase: GRID_ROW_BASE_FINE,
      colBase: GRID_COL_BASE_FINE,
      rows: GRID_ROWS_FINE,
      columns: GRID_COLUMNS_FINE,
      cellCount: GRID_CELL_COUNT_FINE,
    },
    encoding: {
      bytesPerRecord: FINE_DAY_RECORD_BYTES,
      headerBytes: FINE_DAY_HEADER_BYTES,
      magic: FINE_DAY_MAGIC.toString('ascii'),
      cellIndexBits: 32,
      mmScale: PER_DAY_MM_SCALE,
      dayIndexInFilename: true,
    },
    dayIndexEpoch: DAY_INDEX_EPOCH,
    retainMm: HAIL_RETAIN_MM_FINE,
    window: win,
    unavailableDays,
    dayCount: days.length,
    recordCount,
    cellCount,
    bytes,
    days,
  };
}

/**
 * `20210629` -> `2021-06-29`, the ISO form the `window` field is written in.
 * @param {string} ymd
 * @returns {string}
 */
function isoDay(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/**
 * Assemble the provenance sidecar. One shape for the combined snapshot and for
 * every per-year file, so a consumer that learns to read one has learned them
 * all.
 *
 * @param {object} input
 * @param {string} input.builtAt Injected rather than read from the clock so the
 *   builder's only nondeterministic field is testable in isolation.
 * @param {{from: string, to: string, days: number}} input.window
 * @param {Array<{ymd: string, error: string}>} input.unavailableDays
 * @param {number} input.cellCount
 * @param {number} input.corePointCount
 * @param {boolean} input.truncated
 * @param {number} input.cellsBeforeTruncation
 * @returns {object}
 */
export function radarMeta(input) {
  return {
    version: 1,
    builtAt: input.builtAt,
    builder: 'scripts/build-storm-radar-snapshots.mjs',
    product: PRODUCT,
    productLabel: PRODUCT_LABEL,
    bucket: 's3://noaa-mrms-pds',
    license: 'US Government public domain (NOAA/NWS/NSSL)',
    attribution: 'NOAA/NWS/NSSL — Multi-Radar/Multi-Sensor (MRMS)',
    commercialUse: true,
    requiresKey: false,
    units: 'millimetres',
    hailCoreThresholdMm: HAIL_CORE_MM,
    gridDeg: CELL_DEG,
    window: input.window,
    unavailableDays: input.unavailableDays,
    cellCount: input.cellCount,
    corePointCount: input.corePointCount,
    maxCells: MAX_CELLS,
    truncated: input.truncated,
    cellsBeforeTruncation: input.cellsBeforeTruncation,
    caveat:
      'MESH is a radar estimate and is known to over-report relative to ground reports. Treat it as evidence of where hail fell, not as an exact stone size.',
  };
}

/**
 * Provenance for the per-day artifact, which gets its own sidecar rather than a
 * few more keys on `radarMeta`.
 *
 * The fields `radarMeta` already carries describe a climatology — one number per
 * cell, a window, a core threshold. The per-day artifact is a different shape
 * (a sorted list of cell-days), a different threshold (the retain floor), and it
 * carries one thing nothing else does: the day-index epoch. Folding it into
 * `radarMeta` would add `dayIndexEpoch` to seven sidecars that have no day
 * index, and make the reading of the *published* sidecars depend on whether a
 * per-day build happened. Separate is also the honest statement: reading this
 * file tells you how to read the binary beside it, and nothing more.
 *
 * @param {object} input
 * @param {string} input.builtAt
 * @param {{from: string, to: string, days: number}} input.window
 * @param {Array<{ymd: string, error: string}>} input.unavailableDays
 * @param {number} input.recordCount Cell-days in the artifact.
 * @param {number} input.cellCount Distinct cells the artifact mentions.
 * @param {boolean} input.truncated
 * @param {number} input.cellsBeforeTruncation
 * @returns {object}
 */
export function perDayMeta(input) {
  return {
    version: 1,
    builtAt: input.builtAt,
    builder: 'scripts/build-storm-radar-snapshots.mjs',
    artifact: `storm_radar_hail_perday_<year>.bin.gz`,
    product: PRODUCT,
    productLabel: PRODUCT_LABEL,
    bucket: 's3://noaa-mrms-pds',
    license: 'US Government public domain (NOAA/NWS/NSSL)',
    attribution: 'NOAA/NWS/NSSL — Multi-Radar/Multi-Sensor (MRMS)',
    commercialUse: true,
    requiresKey: false,
    units: 'millimetres',
    format: {
      description:
        'Sorted 6-byte little-endian triples: u16 cellIndex, u16 dayIndex, u16 maxMm x 10. Gzipped, no mtime.',
      recordBytes: PER_DAY_RECORD_BYTES,
      order: 'ascending (dayIndex, cellIndex)',
      mmScale: PER_DAY_MM_SCALE,
    },
    geometry: {
      cellIndex:
        '(i - rowBase) * columns + (j - colBase), row-major over the retained domain',
      gridDeg: CELL_DEG,
      rowBase: GRID_ROW_BASE,
      colBase: GRID_COL_BASE,
      rows: GRID_ROWS,
      columns: GRID_COLUMNS,
      cellCount: GRID_CELL_COUNT,
    },
    // Stated because a `uint16` day index is only meaningful with it: without
    // the epoch a reader cannot turn index 2,124 into a date, and a sidecar
    // written before this field existed would silently mis-date every record.
    dayIndexEpoch: DAY_INDEX_EPOCH,
    hailRetainThresholdMm: HAIL_RETAIN_MM,
    hailCoreThresholdMm: HAIL_CORE_MM,
    window: input.window,
    unavailableDays: input.unavailableDays,
    recordCount: input.recordCount,
    cellCount: input.cellCount,
    maxCells: MAX_CELLS,
    truncated: input.truncated,
    cellsBeforeTruncation: input.cellsBeforeTruncation,
    caveat:
      'MESH is a radar estimate and is known to over-report relative to ground reports. A cell here means hail fell in it on that day, not that a stone was measured.',
  };
}

/**
 * Split records by the calendar year of the day they describe.
 *
 * Per-year shards, not one whole-archive file, for the same reason the
 * climatology ships per year: the consumer asks about a date, the loader fetches
 * that date's year, and nothing else crosses the network. A single 5.4 MB
 * payload would have to be fetched and inflated whole to answer a question about
 * one storm day.
 *
 * @param {Array<{cellIndex: number, dayIndex: number, maxMm: number}>} records
 * @returns {Map<number, Array<{cellIndex: number, dayIndex: number, maxMm: number}>>}
 *   Ascending by year.
 */
/**
 * Encode ONE calendar day of the fine grid as a self-contained shard.
 *
 * Per calendar day, not per year, and that is the decision everything else
 * follows from. The loader is asked for a date; a per-year shard means a
 * national storm season in memory to draw one neighbourhood's worth of detail,
 * and 1,019 per-day files means only the day on screen ever crosses the wire.
 * The committed design was per-year (`perDayRecordsByYear`), deliberately, at
 * 0.25 degrees; the fine grid inverts that because the per-year blob is ~85 MB
 * and the per-day one is ~28 KB.
 *
 * `dayIndex` is NOT stored. It is constant within a shard and lives in the
 * filename, so carrying it per record would spend 4 bytes saying nothing. That
 * is what {@link FINE_DAY_RECORD_BYTES} accounts for, and why a 10-byte
 * general record and a 6-byte day record both exist: the general one is for
 * tests and for any future multi-day container, the day one for production.
 *
 * Records are sorted by `cellIndex`, which within one day is also sorted by
 * position, so a consumer walks them in geographic order.
 *
 * @param {number} ymd `YYYYMMDD`
 * @param {Array<{i: number, j: number, maxMm: number}>} cells
 * @returns {Buffer}
 * @throws {RangeError} when a value does not fit its field, rather than
 *   truncating — a wrapped index misplaces hail with no error downstream.
 */
export function encodeFineDayRecords(ymd, cells) {
  const ordered = [...(cells ?? [])].sort(
    (a, b) =>
      cellIndexFine(a.i, a.j) - cellIndexFine(b.i, b.j),
  );
  const buffer = Buffer.alloc(
    FINE_DAY_HEADER_BYTES + ordered.length * FINE_DAY_RECORD_BYTES,
  );
  FINE_DAY_MAGIC.copy(buffer, 0);
  let previousDay = dayIndex(String(ymd));
  if (!Number.isInteger(previousDay) || previousDay < 0) {
    throw new RangeError(`fine day ${ymd} does not resolve to a day index`);
  }
  ordered.forEach((cell, n) => {
    const index = cellIndexFine(cell.i, cell.j);
    const scaled = Math.round(cell.maxMm * PER_DAY_MM_SCALE);
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
      throw new RangeError(
        `fine cellIndex ${index} does not fit a uint32; the index space is wrong`,
      );
    }
    if (!Number.isInteger(scaled) || scaled < 0 || scaled > 0xffff) {
      throw new RangeError(
        `fine maxMm x scale ${scaled} does not fit a uint16; raise PER_DAY_MM_SCALE's inverse or the threshold`,
      );
    }
    const at = FINE_DAY_HEADER_BYTES + n * FINE_DAY_RECORD_BYTES;
    buffer.writeUInt32LE(index, at);
    buffer.writeUInt16LE(scaled, at + 4);
  });
  return buffer;
}

/**
 * The inverse of {@link encodeFineDayRecords}.
 *
 * @param {Uint8Array} bytes
 * @returns {Array<{i: number, j: number, maxMm: number}>}
 * @throws {RangeError} when the length is not a whole number of records — which
 *   is also what rejects an SPA shell served with a 200.
 */
export function decodeFineDayRecords(bytes) {
  if (
    !bytes?.length ||
    bytes.length < FINE_DAY_HEADER_BYTES ||
    bytes.length - FINE_DAY_HEADER_BYTES < 0 ||
    (bytes.length - FINE_DAY_HEADER_BYTES) % FINE_DAY_RECORD_BYTES !== 0
  ) {
    throw new RangeError(
      `fine day payload is ${bytes?.length ?? 0} bytes, not a header plus a multiple of ${FINE_DAY_RECORD_BYTES}`,
    );
  }
  for (let at = 0; at < FINE_DAY_HEADER_BYTES; at += 1) {
    if (bytes[at] !== FINE_DAY_MAGIC[at]) {
      throw new RangeError(
        `fine day payload does not start with the FINE magic — it is probably a coarse shard`,
      );
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let at = FINE_DAY_HEADER_BYTES; at < bytes.length; at += FINE_DAY_RECORD_BYTES) {
    const { i, j } = cellIJFine(view.getUint32(at, true));
    out.push({ i, j, maxMm: view.getUint16(at + 4, true) / PER_DAY_MM_SCALE });
  }
  return out;
}

export function perDayRecordsByYear(records) {
  const byYear = new Map();
  for (const record of records ?? []) {
    const year = Number(dayFromIndex(record.dayIndex).slice(0, 4));
    const bucket = byYear.get(year);
    if (bucket) bucket.push(record);
    else byYear.set(year, [record]);
  }
  return new Map([...byYear.entries()].sort((a, b) => a[0] - b[0]));
}

/**
 * Write a sidecar JSON atomically, with the trailing newline the other builders
 * emit so the files stay diff- and prettier-friendly.
 * @param {string} file
 * @param {object} value
 */
export async function writeMetaJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  setRefresh(args.refresh);
  const startedAt = Date.now();

  // Default window: the trailing N days ending yesterday, because the 24-hour
  // maximum file stamped 00:00 UTC covers the preceding day.
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const to = args.to || yesterday.toISOString().slice(0, 10);
  // Precedence is explicit: an explicit --from/--days beats the archive default.
  const from = args.days
    ? new Date(
        new Date(`${to}T00:00:00Z`).getTime() - (args.days - 1) * 86_400_000,
      )
        .toISOString()
        .slice(0, 10)
    : args.from || ARCHIVE_START;
  if (from < ARCHIVE_START) {
    throw new Error(
      `--from ${from} predates the MRMS archive start of ${ARCHIVE_START}`,
    );
  }
  const days = dateRange(from, to);
  step(`MRMS ${PRODUCT_LABEL}: ${days.length} days, ${from} to ${to}`);

  const cellsByYear = new Map();
  // The per-day field is a second accumulator, not a field on the cell: see the
  // note on `ingestMeshGz`. O(records) — one entry per (cell, day) that reached
  // the retain floor — and never a decoded Float32Array, which is 98 MB a day.
  const perDay = new Map();
  // The fine field's accumulator, keyed by CALENDAR DAY: `Map<ymd, Map<'i:j',
  // maxMm>>`. Not the coarse shape (`Map<'i:j', Map<ymd, mm>>`) because that one
  // does not survive a 25x finer grid — it would mean a Map with a million keys
  // each holding a Map. Keying by day gives one Map per shard, and the shard is
  // the unit that is written, shipped and fetched.
  const finePerDay = new Map();
  /** Distinct cells across all year buckets — a cell active in two years counts twice. */
  const ingestedCells = () => {
    let total = 0;
    for (const bucket of cellsByYear.values()) total += bucket.size;
    return total;
  };
  let done = 0;
  let failed = 0;
  let totalPoints = 0;
  const failures = [];
  // Per-year day tallies, so a year's sidecar can report the window it was
  // built from rather than inheriting the whole run's window.
  const daysByYear = new Map();
  const pointsByYear = new Map();

  await pooled(days, args.concurrency, async (ymd) => {
    const result = await ingestDay(ymd, cellsByYear, { perDay, finePerDay });
    done += 1;
    const year = Number(ymd.slice(0, 4));
    daysByYear.set(year, (daysByYear.get(year) ?? 0) + 1);
    if (result.ok) {
      totalPoints += result.points;
      pointsByYear.set(year, (pointsByYear.get(year) ?? 0) + result.points);
    } else {
      failed += 1;
      failures.push({ ymd, error: result.error });
    }
    if (done % 5 === 0 || done === days.length) {
      step(
        `  ${done}/${days.length} days · ${ingestedCells().toLocaleString()} cell-years · ${failed} unavailable`,
      );
    }
  });

  if (ingestedCells() === 0) {
    throw new Error(
      'No radar hail cores were ingested. Check the date range — the MRMS archive begins 2020-10-14, and the 24-hour-maximum product is not produced for every day.',
    );
  }

  // Per-year files first: each cell carries only the statistics for the year it
  // was active in, which is the only thing a year-scoped consumer can use. A
  // cell that saw hail in 2021 and 2024 appears in both files, with 2021's peak
  // in one and 2024's in the other.
  const byYear = featuresByYear(cellsByYear);
  // The combined snapshot is then folded back out of those per-year features, so
  // it is a merge of the published partitions rather than a parallel aggregate
  // that could drift from them.
  const { kept, truncated, cellsBeforeTruncation } = selectKeptCells(
    mergeYearFeatures(byYear),
    MAX_CELLS,
  );
  const keptKeys = new Set(
    kept.map((feature) => `${feature.properties.i}:${feature.properties.j}`),
  );
  const publishedByYear = restrictYearsToKeys(byYear, keptKeys);

  // Hoisted ABOVE the fine-only guard because BOTH families stamp their
  // sidecars with it. It was declared inside the coarse branch first, and
  // the fine block could not see it — which a smoke run caught immediately
  // with a ReferenceError rather than a silently wrong timestamp.
  const builtAt = new Date().toISOString();

  // GATE A guard, opened here rather than at the sidecars: the combined file is
  // the first coarse artifact written, so a guard that started later would let
  // `--fine-only` truncate the climatology and still report success. That is
  // exactly what happened the first time this flag was added — the run printed
  // the fine line and had already overwritten storm_radar_hail.geojsonl.
  if (args.fineOnly) {
    step(
      'Skipping every coarse artifact (--fine-only): the 0.25-degree climatology ' +
        'is untouched by this run.',
    );
  } else {
  const outFile = path.join(args.out, 'storm_radar_hail.geojsonl');
  const bytes = await writeGeoJsonl(outFile, kept);
  step(
    `Wrote storm_radar_hail.geojsonl — ${kept.length.toLocaleString()} cells, ${(bytes / 1e6).toFixed(1)} MB`,
  );
  if (truncated) {
    step(
      `Truncated to MAX_CELLS=${MAX_CELLS} from ${cellsBeforeTruncation.toLocaleString()}, keeping the strongest hail (highest mx first)`,
    );
  }
  step(
    `Radar hail cores ≥${HAIL_CORE_MM}mm: ${totalPoints.toLocaleString()} 1km points over ${days.length} days`,
  );
  if (failures.length) {
    const sample = failures
      .slice(0, 5)
      .map((f) => `${f.ymd} (${f.error})`)
      .join('; ');
    step(`Unavailable days: ${failures.length} — ${sample}`);
  }

  await writeMetaJson(
    path.join(args.out, 'storm-radar-sources.json'),
    radarMeta({
      builtAt,
      window: { from, to, days: days.length },
      unavailableDays: failures,
      cellCount: kept.length,
      corePointCount: totalPoints,
      truncated,
      cellsBeforeTruncation,
    }),
  );
  step('Wrote storm-radar-sources.json');

  // Per-year partitions of the *kept* set, so the union of the year files is
  // exactly the combined snapshot and a truncation ceiling is never silently
  // bypassed by a year file. Order is already total within each year.
  for (const [year, list] of publishedByYear) {
    const gzPath = path.join(args.out, `storm_radar_hail_${year}.geojsonl.gz`);
    const gzBytes = await writeGeoJsonlGz(gzPath, list);
    const yearDays = days.filter((ymd) => ymd.slice(0, 4) === String(year));
    await writeMetaJson(
      path.join(args.out, `storm-radar-sources_${year}.json`),
      radarMeta({
        builtAt,
        window: {
          from: yearDays.length ? isoDay(yearDays[0]) : null,
          to: yearDays.length ? isoDay(yearDays[yearDays.length - 1]) : null,
          days: daysByYear.get(year) ?? yearDays.length,
        },
        unavailableDays: failures.filter(
          (f) => f.ymd.slice(0, 4) === String(year),
        ),
        cellCount: list.length,
        corePointCount: pointsByYear.get(year) ?? 0,
        // Truncation is global, not per year: MAX_CELLS bounds the combined
        // snapshot, so a year file reports the same ceiling and pre-truncation
        // count as the combined sidecar rather than an invented local one.
        truncated,
        cellsBeforeTruncation,
      }),
    );
    step(
      `Wrote storm_radar_hail_${year}.geojsonl.gz — ${list.length.toLocaleString()} cells, ${(gzBytes / 1e3).toFixed(1)} kB`,
    );
  }

  // The per-day artifact, written last so the file on disk is never newer than
  // the kept-cell set it is filtered against.
  const records = perDayRecords(perDay, keptKeys);
  const perDayByYear = perDayRecordsByYear(records);
  for (const [year, list] of perDayByYear) {
    const yearDays = days.filter((ymd) => ymd.slice(0, 4) === String(year));
    const perDayFile = path.join(
      args.out,
      `storm_radar_hail_perday_${year}.bin.gz`,
    );
    const perDayBytes = await writePerDayBin(perDayFile, list);
    await writeMetaJson(
      path.join(args.out, `storm-radar-days-sources_${year}.json`),
      perDayMeta({
        builtAt,
        window: {
          from: yearDays.length ? isoDay(yearDays[0]) : null,
          to: yearDays.length ? isoDay(yearDays[yearDays.length - 1]) : null,
          days: daysByYear.get(year) ?? yearDays.length,
        },
        unavailableDays: failures.filter(
          (f) => f.ymd.slice(0, 4) === String(year),
        ),
        recordCount: list.length,
        cellCount: new Set(list.map((r) => r.cellIndex)).size,
        truncated,
        cellsBeforeTruncation,
      }),
    );
    step(
      `Wrote storm_radar_hail_perday_${year}.bin.gz — ${list.length.toLocaleString()} cell-days ≥${HAIL_RETAIN_MM}mm, ${(perDayBytes / 1e6).toFixed(2)} MB`,
    );
  }

  } // end the coarse-only guard: everything above is the published climatology

  // The FINE field, written last and one file per calendar day.
  //
  // OUTSIDE the guard, deliberately, and that placement is load-bearing. The
  // first version of `--fine-only` left this block inside the coarse `else`, so
  // the flag skipped the fine shards as well as the coarse ones: the build
  // reported success, printed nothing about fine output, and left the previous
  // day's shards on disk untouched. Nothing failed. Two rebuilds "passed" with
  // stale data before it was caught by checking a file's mtime.
  //
  // Two things happen here that do not happen for the coarse artifacts, both
  // because there are ~1,000 of these rather than six:
  //
  //  - ROLL-OFF. The window is finite by design. Insurance claim windows close
  //    at one to two years, so detail older than `--fine-years` (default 3) is
  //    not worth shipping and is deleted rather than left to accumulate. There
  //    is no prune script in this repo, so without this the payload directory
  //    would grow forever and nothing would ever remove a shard.
  //  - A MANIFEST. `storm-radar-fine-sources.json` lists every day that should
  //    have a shard. Nothing else in the repo can detect a missing or truncated
  //    payload: there is no hash check, no drift gate, and CI does not read this
  //    directory. The manifest is what makes a broken build visible.
  const fineOutDir = args.out;
  const emittedFine = [];
  let fineRecords = 0;
  let fineBytes = 0;
  const fineCells = new Set();
  for (const [ymd, cellsByIJ] of [...finePerDay.entries()].sort()) {
    const file = path.join(fineOutDir, fineDayFileName(ymd));
    const cells = [...cellsByIJ.entries()].map(([key, mm]) => {
      const [i, j] = key.split(':').map(Number);
      return { i, j, maxMm: mm };
    });
    const bytes = await writeFineDayBin(file, cells);
    emittedFine.push(ymd);
    fineRecords += cells.length;
    fineBytes += bytes;
    for (const cell of cells) fineCells.add(cellIndexFine(cell.i, cell.j));
  }

  // Roll off shards older than the retention window, so a rolling rebuild does
  // not accumulate every day it has ever seen.
  const fineYears = Number(args.fineYears || 3);
  const cutoffYear = Number(days[days.length - 1]?.slice(0, 4) || 0) - fineYears + 1;
  let pruned = 0;
  for (const name of await fs.readdir(fineOutDir).catch(() => [])) {
    const match = /^storm_radar_hail_fine_(\d{4})-\d{2}-\d{2}\.bin\.gz$/.exec(name);
    if (!match) continue;
    if (Number(match[1]) >= cutoffYear) continue;
    await fs.rm(path.join(fineOutDir, name), { force: true });
    pruned += 1;
  }

  await writeMetaJson(
    path.join(fineOutDir, 'storm-radar-fine-sources.json'),
    fineDayMeta({
      builtAt,
      window: {
        from: days.length ? isoDay(days[0]) : null,
        to: days.length ? isoDay(days[days.length - 1]) : null,
        days: days.length,
        retentionYears: fineYears,
        cutoffYear,
      },
      unavailableDays: failures,
      days: emittedFine,
      recordCount: fineRecords,
      cellCount: fineCells.size,
      bytes: fineBytes,
    }),
  );
  step(
    `Wrote ${emittedFine.length.toLocaleString()} fine 1km day shards — ` +
      `${fineRecords.toLocaleString()} cells ≥${HAIL_RETAIN_MM_FINE}mm, ` +
      `${(fineBytes / 1e6).toFixed(1)} MB total` +
      (pruned ? `, pruned ${pruned} outside ${fineYears}y` : ''),
  );
  step(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `[storm-radar-etl] FAILED: ${error.stack || error.message}\n`,
    );
    process.exitCode = 1;
  });
}

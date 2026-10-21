/**
 * The sub-daily hail field: the same day of hail, four times over.
 *
 * The committed daily field is a MAXIMUM over the day, and a maximum has no
 * story in it. It says where the biggest hail of the day fell and nothing
 * about when. So a storm cannot be replayed on the globe, and a lead cannot
 * be narrowed to the part of the day that mattered.
 *
 * THIS IS THE SIX-HOURLY FIELD. One shard per day, four frames, each cell
 * stored ONCE with a bitmask of the frames it was over the threshold in. The
 * one-record-per-cell choice is what keeps it small: a day touches about the
 * same number of distinct cells whether it is measured once or four times, and
 * only the RECORD COUNT grows with the frame count. Measured over a four-day
 * sample, a per-frame artifact would be 3.1x the daily field at six-hourly and
 * 13.6x at hourly; this one is 1.3x.
 *
 * THE DAY BOUNDARY. MRMS names a file for the window ENDING at its timestamp.
 * The shard for day D therefore holds the four frames that end at D-1 06:00,
 * D-1 12:00, D-1 18:00 and D 00:00 UTC - the same 24 hours the DAILY field
 * for day D covers, so the timeline and the daily field agree about which day
 * they are showing.
 */

import { RADAR_FINE_GRID, RADAR_PER_DAY_MM_SCALE } from './stormDatasets.js';
import { inflateBytesUint8Array } from './stormReports.inflateHelper.js';

/** Magic at the head of a sub-daily shard: ASCII `SUBD`. */
export const SUB_DAILY_MAGIC = Object.freeze([0x53, 0x55, 0x42, 0x44]);

/** The header: magic, the frame count, and three reserved bytes. */
export const SUB_DAILY_HEADER_BYTES = 8;

/**
 * The record: `u32 cellIndex, u16 maxMm x 10, u16 frameMask`.
 *
 * The mask's bit k is set when the cell was over the threshold in frame k.
 */
export const SUB_DAILY_RECORD_BYTES = 8;

/**
 * The frames in a day, and the hour of the day each one ENDS at, in UTC.
 *
 * The first three end on the previous calendar day, because the day the shard
 * covers is the 24 hours ending at midnight.
 */
export const SUB_DAILY_FRAME_HOURS = Object.freeze([6, 12, 18, 0]);

/**
 * The times the frames of a day end, as ISO strings.
 *
 * @param {string} day ISO `YYYY-MM-DD`
 * @returns {Array<string>}
 */
export function subDailyFrameTimes(day) {
  const previous = new Date(`${day}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const previousDay = previous.toISOString().slice(0, 10);
  return SUB_DAILY_FRAME_HOURS.map((hour) => {
    const date = hour === 0 ? day : previousDay;
    return `${date}T${String(hour).padStart(2, '0')}:00:00Z`;
  });
}

/**
 * The file name a day's sub-daily shard is published under.
 * @param {string} day ISO `YYYY-MM-DD`
 * @returns {string}
 */
export function subDailyFileName(day) {
  return `storm_radar_hail_sub_${day}.bin.gz`;
}

/**
 * Encode a day's frames into a shard.
 *
 * The encoder lives here, beside the decoder, because a format is one thing
 * with two halves and a builder and a reader that each carry their own copy
 * of it are two formats that will drift. The builder imports this.
 *
 * Every cell is written ONCE, with the bitmask of the frames it was over the
 * threshold in and its maximum across the day.
 *
 * @param {Array<Map<number, number>>} frames one map per frame, of the fine
 *   cell index to its maximum millimetres
 * @returns {Uint8Array}
 */
export function encodeSubDaily(frames) {
  const frameCount = frames.length;
  if (!frameCount || frameCount > 16) {
    throw new RangeError(`a shard carries 1 to 16 frames, not ${frameCount}`);
  }
  const cells = new Map();
  for (const [index, frame] of frames.entries()) {
    for (const [cellIndex, mm] of frame) {
      let row = cells.get(cellIndex);
      if (!row) {
        row = { maxMm: 0, mask: 0 };
        cells.set(cellIndex, row);
      }
      if (mm > row.maxMm) row.maxMm = mm;
      row.mask |= 1 << index;
    }
  }
  const ordered = [...cells.entries()].sort((a, b) => a[0] - b[0]);
  const buffer = new Uint8Array(
    SUB_DAILY_HEADER_BYTES + ordered.length * SUB_DAILY_RECORD_BYTES,
  );
  const view = new DataView(buffer.buffer);
  for (let at = 0; at < 4; at += 1) {
    buffer[at] = SUB_DAILY_MAGIC[at];
  }
  view.setUint8(4, frameCount);
  ordered.forEach(([index, row], n) => {
    const at = SUB_DAILY_HEADER_BYTES + n * SUB_DAILY_RECORD_BYTES;
    view.setUint32(at, index, true);
    view.setUint16(
      at + 4,
      Math.round(row.maxMm * RADAR_PER_DAY_MM_SCALE),
      true,
    );
    view.setUint16(at + 6, row.mask, true);
  });
  return buffer;
}

/**
 * Decode ONE sub-daily shard.
 *
 * Split out from the loader for the same reason the daily one is: the
 * decoding has to be testable without a fetch, and the "is this actually a
 * sub-daily payload?" decision has exactly one home.
 *
 * That decision is a LENGTH check plus the magic. The daily fine shard has a
 * SIX-byte record and this one has an EIGHT-byte one, so a swapped payload
 * would not divide evenly - but it would not divide evenly by accident
 * either, and the magic settles it.
 *
 * @param {Uint8Array} bytes Decompressed payload.
 * @returns {{frameCount: number, frames: Array<Array<{i: number, j: number,
 *   maxMm: number}>>}}
 */
export function indexSubDailyDay(bytes) {
  const empty = { frameCount: 0, frames: [] };
  if (
    !bytes?.length ||
    bytes.length < SUB_DAILY_HEADER_BYTES ||
    (bytes.length - SUB_DAILY_HEADER_BYTES) % SUB_DAILY_RECORD_BYTES !== 0
  ) {
    return empty;
  }
  for (let at = 0; at < 4; at += 1) {
    if (bytes[at] !== SUB_DAILY_MAGIC[at]) return empty;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameCount = view.getUint8(4);
  if (!frameCount || frameCount > 16) return empty;
  const { columns, colBase, rowBase, cellCount } = RADAR_FINE_GRID;
  const frames = Array.from({ length: frameCount }, () => []);
  for (
    let at = SUB_DAILY_HEADER_BYTES;
    at < bytes.length;
    at += SUB_DAILY_RECORD_BYTES
  ) {
    const index = view.getUint32(at, true);
    if (index >= cellCount) continue;
    const maxMm = view.getUint16(at + 4, true) / RADAR_PER_DAY_MM_SCALE;
    const mask = view.getUint16(at + 6, true);
    const i = Math.floor(index / columns) + rowBase;
    const j = (index % columns) + colBase;
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (!(mask & (1 << frame))) continue;
      frames[frame].push({ i, j, maxMm });
    }
  }
  return { frameCount, frames };
}

/**
 * Where the shards live.
 *
 * The same string surgery the daily loader uses, and for the same reason:
 * `new URL('./local_data/storm/', import.meta.url)` is rewritten by Vite into
 * a hashed asset URL, which would point at a FILE rather than at the
 * directory the shards are copied into. The `.gz` payloads are copied there
 * by the build plugin rather than emitted as hashed assets, so the directory
 * form is the one that resolves in a production build.
 */
const BASE = `${import.meta.url.replace(/[^/]*$/, '')}local_data/storm/`;

/**
 * The cells of one frame of a day, as the plain `{i, j, maxMm}` shape the
 * renderer already understands.
 *
 * The shards are cached by day, and a caller that wants several frames of the
 * same day reads them out of one shard rather than fetching four.
 */
const shardCache = new Map();
const SHARD_CACHE_ENTRIES = 12;

/**
 * Load ONE day's sub-daily shard.
 *
 * @param {string} day ISO `YYYY-MM-DD`
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{frameCount: number, frames: Array<Array<object>>,
 *   times: Array<string>}>}
 */
export async function loadSubDailyDay(day, options = {}) {
  const key = String(day);
  if (shardCache.has(key)) return shardCache.get(key);
  const fetchImpl = options.fetchImpl || fetch;
  const url = new URL(subDailyFileName(key), BASE);
  let payload;
  try {
    const response = await fetchImpl(url, { signal: options.signal });
    if (!response.ok) {
      if (response.status === 404) {
        const empty = {
          frameCount: 0,
          frames: [],
          times: subDailyFrameTimes(key),
        };
        shardCache.set(key, empty);
        return empty;
      }
      throw new Error(
        `sub-daily radar: HTTP ${response.status} for ${url.href}`,
      );
    }
    // The shared inflate helper, and not a bare `DecompressionStream`. A server
    // that answers a `.gz` with `Content-Encoding: gzip` has ALREADY
    // decompressed the body by the time the browser hands it over, and
    // inflating that again fails - which reads as an absent shard rather than
    // as a broken one. The helper looks at the magic first and inflates only
    // when there is something to inflate.
    payload = await inflateBytesUint8Array(
      new Uint8Array(await response.arrayBuffer()),
    );
  } catch (error) {
    if (error?.message?.includes('404')) {
      const empty = {
        frameCount: 0,
        frames: [],
        times: subDailyFrameTimes(key),
      };
      shardCache.set(key, empty);
      return empty;
    }
    throw error;
  }
  const decoded = indexSubDailyDay(payload);
  const result = { ...decoded, times: subDailyFrameTimes(key) };
  shardCache.set(key, result);
  while (shardCache.size > SHARD_CACHE_ENTRIES) {
    const oldest = shardCache.keys().next().value;
    if (oldest === key) break;
    shardCache.delete(oldest);
  }
  return result;
}

/** Drop the sub-daily cache. */
export function clearSubDailyCache() {
  shardCache.clear();
}

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SUB_DAILY_HEADER_BYTES,
  SUB_DAILY_RECORD_BYTES,
  indexSubDailyDay,
  subDailyFrameTimes,
  subDailyFileName,
  encodeSubDaily,
} from './subDailyRadar.js';

/**
 * A shard's frames, as the builder writes them: a map of the fine cell index
 * to its maximum millimetres.
 */
function frame(entries) {
  return new Map(entries);
}

/** The grid coordinates the decoder returns for a fine cell index. */
function cellOf(index) {
  return { i: Math.floor(index / 6500) + 2100, j: (index % 6500) - 12500 };
}

/** Three fine cells in different rows, so they decode apart. */
const CELL_A = 100;
const CELL_B = 6500;
const CELL_C = 13000;

test('a shard round-trips: the cells come back in the frames they were in', () => {
  const frames = [
    frame([[CELL_A, 30], [CELL_B, 31]]),
    frame([[CELL_A, 32], [CELL_C, 20]]),
    frame([[CELL_C, 21]]),
    frame([[CELL_B, 33]]),
  ];
  const encoded = encodeSubDaily(frames);
  const decoded = indexSubDailyDay(
    new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
  );
  assert.equal(decoded.frameCount, 4);
  assert.equal(decoded.frames.length, 4);

  // Which cells are in which frame.
  const inFrame = (n, index) =>
    decoded.frames[n].some(
      (c) => c.i === cellOf(index).i && c.j === cellOf(index).j,
    );
  assert.ok(inFrame(0, CELL_A), 'cell A is in frame 0');
  assert.ok(inFrame(0, CELL_B), 'cell B is in frame 0');
  assert.ok(!inFrame(0, CELL_C), 'cell C is not in frame 0');
  assert.ok(inFrame(1, CELL_A), 'cell A is in frame 1');
  assert.ok(inFrame(1, CELL_C), 'cell C is in frame 1');
  assert.ok(!inFrame(1, CELL_B), 'cell B is not in frame 1');
  assert.ok(inFrame(2, CELL_C), 'cell C is in frame 2');
  assert.ok(inFrame(3, CELL_B), 'cell B is in frame 3');

  // The cell's value is its maximum across the day, not its value in the
  // frame it happened to be in.
  const a = decoded.frames[1].find(
    (c) => c.i === cellOf(CELL_A).i && c.j === cellOf(CELL_A).j,
  );
  assert.equal(a.maxMm, 32, "the cell's maximum across the day");
});

test('a cell in no frame is not in the shard', () => {
  const encoded = encodeSubDaily([frame([[1, 10]]), frame([]), frame([]), frame([])]);
  const decoded = indexSubDailyDay(
    new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
  );
  let total = 0;
  for (const frame of decoded.frames) total += frame.length;
  assert.equal(total, 1);
});

test('a payload that is not a sub-daily shard is refused', () => {
  assert.equal(indexSubDailyDay(new Uint8Array(0)).frameCount, 0);
  assert.equal(indexSubDailyDay(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).frameCount, 0);

  // The DAILY fine shard has a six-byte record and this one has an eight-byte
  // one, so a swapped payload would not divide evenly. The magic settles the
  // ones that do.
  const daily = new Uint8Array(4 + 8 * 2);
  daily.set([0x46, 0x49, 0x4e, 0x45], 0);
  assert.equal(indexSubDailyDay(daily).frameCount, 0, 'the FINE magic is refused');

  const truncated = new Uint8Array(SUB_DAILY_HEADER_BYTES + 4);
  truncated.set([0x53, 0x55, 0x42, 0x44], 0);
  assert.equal(
    indexSubDailyDay(truncated).frameCount,
    0,
    'a half record is refused rather than decoded',
  );
});

test('the frames of a day are the 24 hours ending at midnight', () => {
  // MRMS names a file for the window ENDING at its timestamp, so the shard
  // for a day holds the frames that end at 06:00, 12:00 and 18:00 on the
  // PREVIOUS day and at 00:00 on the day itself. Those are the same 24 hours
  // the daily field for that day covers, which is what makes the timeline and
  // the daily field agree.
  assert.deepEqual(subDailyFrameTimes('2024-07-08'), [
    '2024-07-07T06:00:00Z',
    '2024-07-07T12:00:00Z',
    '2024-07-07T18:00:00Z',
    '2024-07-08T00:00:00Z',
  ]);
  // Across a month boundary, and across a year boundary.
  assert.deepEqual(subDailyFrameTimes('2024-03-01'), [
    '2024-02-29T06:00:00Z',
    '2024-02-29T12:00:00Z',
    '2024-02-29T18:00:00Z',
    '2024-03-01T00:00:00Z',
  ]);
  assert.deepEqual(subDailyFrameTimes('2025-01-01'), [
    '2024-12-31T06:00:00Z',
    '2024-12-31T12:00:00Z',
    '2024-12-31T18:00:00Z',
    '2025-01-01T00:00:00Z',
  ]);
});

test('the shard is named for its day', () => {
  assert.equal(subDailyFileName('2024-07-08'), 'storm_radar_hail_sub_2024-07-08.bin.gz');
});

test('a record is eight bytes and the header is eight', () => {
  assert.equal(SUB_DAILY_RECORD_BYTES, 8);
  assert.equal(SUB_DAILY_HEADER_BYTES, 8);
});

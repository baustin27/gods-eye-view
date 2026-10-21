import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GEVS_HEADER_BYTES,
  GEVS_MAGIC,
  GEVS_RECORD_BYTES,
  decodeStreetTile,
  encodeStreetTile,
  readVarint,
  unzigzag,
  writeVarint,
  zigzag,
} from './streetTile.js';

/**
 * The street tile format.
 *
 * The one property that matters is that a line survives the round trip
 * EXACTLY - a street is a street, and a map that draws a street one pixel
 * off is a map that puts a house on the wrong side of the road.
 */
test('a line round-trips exactly', () => {
  const lines = [
    { edgeIndex: 12345, points: [[0, 0], [10, 20], [-30, 40], [5, -5]] },
    { edgeIndex: 0xffffffff, points: [[1000, 2000], [1001, 2001]] },
  ];
  const tile = encodeStreetTile({
    zoom: 16,
    westLon: -104.75,
    southLat: 38.8,
    lines,
  });
  const decoded = decodeStreetTile(tile);
  assert.equal(decoded.zoom, 16);
  assert.equal(decoded.westLon, -104.75);
  assert.equal(decoded.southLat, 38.8);
  assert.equal(decoded.lines.length, 2);
  assert.deepEqual(decoded.lines[0].points, lines[0].points);
  assert.equal(decoded.lines[0].edgeIndex, 12345);
  assert.deepEqual(decoded.lines[1].points, lines[1].points);
  assert.equal(decoded.lines[1].edgeIndex, 0xffffffff);
});

test('a line with one point is not a line and is not written', () => {
  const tile = encodeStreetTile({
    zoom: 16,
    westLon: 0,
    southLat: 0,
    lines: [{ points: [[1, 1]] }, { points: [[2, 2], [3, 3]] }],
  });
  const decoded = decodeStreetTile(tile);
  assert.equal(decoded.lines.length, 1, 'only the two-point line survives');
});

test('a payload that is not a tile decodes to nothing', () => {
  assert.equal(decodeStreetTile(new Uint8Array(0)).lines.length, 0);
  assert.equal(decodeStreetTile(new Uint8Array(10)).lines.length, 0);

  // The HTML shell, which is what a static host answers a missing file with.
  const shell = new TextEncoder().encode('<!doctype html><html></html>');
  assert.equal(decodeStreetTile(shell).lines.length, 0);

  // The right magic and the wrong version.
  const wrongVersion = encodeStreetTile({ zoom: 1, westLon: 0, southLat: 0, lines: [] });
  wrongVersion[4] = 99;
  assert.equal(decodeStreetTile(wrongVersion).lines.length, 0);
});

test('a truncated tile decodes to nothing rather than to half a street', () => {
  const tile = encodeStreetTile({
    zoom: 16,
    westLon: 0,
    southLat: 0,
    lines: [{ edgeIndex: 1, points: [[0, 0], [10, 10], [20, 5]] }],
  });
  const truncated = tile.slice(0, tile.length - 3);
  assert.equal(decodeStreetTile(truncated).lines.length, 0);
});

test('the magic is GEVS', () => {
  const tile = encodeStreetTile({ zoom: 0, westLon: 0, southLat: 0, lines: [] });
  assert.deepEqual([...tile.slice(0, 4)], GEVS_MAGIC);
  assert.equal(String.fromCharCode(...tile.slice(0, 4)), 'GEVS');
  assert.equal(tile.length, GEVS_HEADER_BYTES, 'an empty tile is just a header');
});

test('a small delta costs a small number of bytes', () => {
  // The whole point of the delta encoding: consecutive street vertices are
  // metres apart, so the difference between them is tiny.
  const line = { points: Array.from({ length: 100 }, (_, i) => [i * 3, i * 2]) };
  const tile = encodeStreetTile({
    zoom: 16,
    westLon: 0,
    southLat: 0,
    lines: [line],
  });
  const perPoint = (tile.length - GEVS_HEADER_BYTES) / 100;
  assert.ok(perPoint < 3, `a point costs ${perPoint} bytes, not twenty`);
});

test('a record is its fixed part and then its deltas', () => {
  // Two points, one step: the record's fourteen bytes and one byte a
  // coordinate, and nothing else.
  const tile = encodeStreetTile({
    zoom: 16,
    westLon: 0,
    southLat: 0,
    lines: [{ edgeIndex: 1, points: [[0, 0], [1, 1]] }],
  });
  assert.equal(
    tile.length,
    GEVS_HEADER_BYTES + GEVS_RECORD_BYTES + 2,
    'a header, a record and two one-byte deltas',
  );
});

test('zigzag and its inverse are inverses', () => {
  for (const value of [0, 1, -1, 63, -64, 1000, -1000, 2147483647, -2147483648]) {
    assert.equal(unzigzag(zigzag(value)), value, `zigzag(${value})`);
  }
});

test('a varint round-trips, and a long one takes more than one byte', () => {
  const buffer = new Uint8Array(8);
  for (const value of [0, 1, 127, 128, 300, 16384, 0x0fffffff]) {
    const at = writeVarint(buffer, 0, value);
    const read = readVarint(buffer, 0);
    assert.equal(read.value, value, `varint(${value})`);
    assert.equal(read.next, at, 'and it says how long it was');
  }
  assert.ok(writeVarint(buffer, 0, 300) > 1, 'a three hundred takes two bytes');
  assert.ok(writeVarint(buffer, 0, 0x0fffffff) > 1);
});

test('an empty tile decodes to an empty tile', () => {
  const tile = encodeStreetTile({ zoom: 16, westLon: -1, southLat: -2, lines: [] });
  const decoded = decodeStreetTile(tile);
  assert.equal(decoded.lines.length, 0);
  assert.equal(decoded.zoom, 16);
});

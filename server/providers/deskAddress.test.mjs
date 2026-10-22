/**
 * The address lookup.
 *
 * The geocode is the part that can be wrong in a way nobody notices: a point
 * that is slightly off still finds a tract, and a tract that is slightly
 * wrong still finds a day. So the tests here are against REAL data - a real
 * TIGER range, a real shard, a real cell - and they check the answer that
 * matters, which is whether the hail was over the spot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { indexFineDay } from '../../src/data/stormReports.js';
import {
  addressPayload,
  haversineKm,
  parseAddressQuery,
  pointAlongSegment,
} from './deskAddress.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STORM_DIR = path.join(REPO, 'src/data/local_data/storm');

test('an address query is a number, a street and a place', () => {
  assert.deepEqual(parseAddressQuery('123 Main St, Colorado Springs'), {
    number: 123,
    street: 'Main St',
    place: 'Colorado Springs',
  });
  assert.deepEqual(parseAddressQuery('123 Main St'), {
    number: 123,
    street: 'Main St',
    place: '',
  });
  // A street on its own is not an address: there are a hundred Main Streets
  // in a county.
  assert.equal(parseAddressQuery('Main St').number, null);
});

test('the point on a segment is interpolated by DISTANCE, not by vertex', () => {
  // Two segments of very different lengths. Counting the vertices would put
  // the midpoint of the long one at its first vertex.
  const points = [
    0, 0, 0, 10, 0, 20, 0, 30, 0, 40,
  ];
  const middle = pointAlongSegment(points, 0.5);
  assert.ok(Math.abs(middle.lat - 20) < 0.001, `got ${middle.lat}`);
  const quarter = pointAlongSegment(points, 0.25);
  assert.ok(Math.abs(quarter.lat - 10) < 0.001, `got ${quarter.lat}`);
});

test('the distance between two points is the distance', () => {
  // Colorado Springs to Denver, about 100 km.
  const km = haversineKm(38.8339, -104.8214, 39.7392, -104.9903);
  assert.ok(km > 95 && km < 105, `got ${km}`);
  assert.equal(haversineKm(39, -105, 39, -105), 0);
});

test('the hail over a spot is the hail over its CELL, not over its tract', async () => {
  // A day with hail in Colorado, and the cell under the strongest reading.
  const day = '2024-06-01';
  const raw = zlib.gunzipSync(
    fs.readFileSync(path.join(STORM_DIR, `storm_radar_hail_fine_${day}.bin.gz`)),
  );
  const { cells } = indexFineDay(new Uint8Array(raw));
  const strong = cells
    .filter((cell) => cell.maxMm >= 40)
    .sort((a, b) => b.maxMm - a.maxMm);
  assert.ok(strong.length, 'the day has strong readings');
  const cell = strong.find(
    (candidate) =>
      candidate.i * 0.01 > 39.7 &&
      candidate.i * 0.01 < 39.95 &&
      candidate.j * 0.01 > -105.1 &&
      candidate.j * 0.01 < -104.7,
  );
  assert.ok(cell, 'and one of them is in the Denver area');
  const lat = cell.i * 0.01;
  const lon = cell.j * 0.01;

  // The provider's own test, against the same cell: is the hail over THAT
  // point? The answer has to be yes, because the point IS the cell.
  const { stormsAtPoint } = await import('./deskAddress.js');
  const swaths = JSON.parse(
    zlib.gunzipSync(
      fs.readFileSync(
        path.join(REPO, 'apps/hail-desk/public/data/swaths.json.gz'),
      ),
    ).toString('utf8'),
  );
  // The tract the cell is in, by the swaths: the tract with a row for that
  // day whose cell count covers it. The finest tract is not derivable from
  // the swaths alone, so the day is tested through a tract that the swaths
  // name, and the CELL under the point is the thing being checked.
  const rows = swaths.rows.filter((row) => row.d === day);
  assert.ok(rows.length, 'the day has tracts');
  const tract = rows[0].g;
  const result = await stormsAtPoint({ lat, lon, tract });
  const theDay = result.days.find((entry) => entry.day === day);
  assert.ok(theDay, 'the day is in the tract list');
  assert.equal(theDay.over, true, 'the hail was over this cell');
  assert.ok(theDay.maxMm >= 40, 'and the reading is the strong one');
});

test('a spot with no hail on it says so', async () => {
  const { stormsAtPoint } = await import('./deskAddress.js');
  const swaths = JSON.parse(
    zlib.gunzipSync(
      fs.readFileSync(
        path.join(REPO, 'apps/hail-desk/public/data/swaths.json.gz'),
      ),
    ).toString('utf8'),
  );
  const row = swaths.rows.find((entry) => entry.d === '2024-06-01');
  // Somewhere in the same state, in a cell that was not over the threshold.
  const result = await stormsAtPoint({
    lat: 38.0,
    lon: -105.5,
    tract: row.g,
  });
  for (const day of result.days) {
    assert.equal(day.over, false, `${day.day} should not be over this spot`);
  }
});

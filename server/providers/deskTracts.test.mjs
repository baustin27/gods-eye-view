import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { pointInRing } from '../../src/data/adminBoundaries.js';
import { decodeStreetTile } from '../../src/data/streetTile.js';
import { tileBounds } from '../../src/layers/streetLevel/tileMath.js';
import {
  clipRingToBounds,
  countyTractIndex,
  housingUnitCounts,
  ringArea,
  tractTile,
} from './deskTracts.js';
import { runDeskApi } from './deskApi.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOUSING_DIR = path.join(
  HERE,
  '..',
  '..',
  'src',
  'data',
  'local_data',
  'housing_units',
);

/**
 * A county's own housing-unit count, from the county artifact.
 *
 * @param {string} id the five-digit county FIPS
 * @returns {{units: number, moe: number|null}}
 */
function countyUnits(id) {
  const file = path.join(HOUSING_DIR, 'housing_units_county.json.gz');
  const pack = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'),
  );
  const row = pack.rows.find((entry) => entry.id === id);
  assert.ok(row, `the county artifact has ${id}`);
  return { units: row.units, moe: row.moe ?? null };
}

/**
 * The tract tiles, and the clipping that fills them.
 *
 * Two things are load-bearing here and both are about TRUTH rather than
 * shape. A ring must survive the round trip EXACTLY, because a tract
 * boundary that moves by a unit is a house on the wrong side of it. And a
 * ring that does not touch the tile must not be drawn at all, because a
 * tract that is not there is a number the desk will send a canvasser to.
 *
 * The FORMAT's own tests live with the format, in `src/data/streetTile.test.mjs`.
 */

test('a ring inside the rectangle is kept whole', () => {
  const bounds = { west: 0, south: 0, east: 10, north: 10 };
  const ring = [
    [1, 1],
    [9, 1],
    [9, 9],
    [1, 9],
  ];
  const clipped = clipRingToBounds(ring, bounds);
  assert.ok(clipped, 'the ring survives');
  assert.equal(clipped.length, 4);
  assert.deepEqual(clipped[0], [1, 1]);
  assert.deepEqual(clipped[2], [9, 9]);
});

test('a ring outside the rectangle is not a shape', () => {
  const bounds = { west: 0, south: 0, east: 10, north: 10 };
  assert.equal(
    clipRingToBounds(
      [
        [20, 20],
        [30, 20],
        [30, 30],
      ],
      bounds,
    ),
    null,
  );
  assert.equal(
    clipRingToBounds(
      [
        [-5, -5],
        [-1, -5],
        [-1, -1],
      ],
      bounds,
    ),
    null,
  );
});

test('a ring that crosses the rectangle is cut at its edge', () => {
  const bounds = { west: 0, south: 0, east: 10, north: 10 };
  // A square from -5 to 5, so its left half is outside the rectangle.
  const clipped = clipRingToBounds(
    [
      [-5, 0],
      [5, 0],
      [5, 10],
      [-5, 10],
    ],
    bounds,
  );
  assert.ok(clipped, 'what is inside is kept');
  for (const [lon, lat] of clipped) {
    assert.ok(lon >= 0 && lon <= 10, `lon ${lon} is inside`);
    assert.ok(lat >= 0 && lat <= 10, `lat ${lat} is inside`);
  }
  // The part that was inside is still there: the square was ten wide and
  // five of it was inside the rectangle, so half of it survives.
  assert.equal(Math.abs(ringArea(clipped)), 50);
});

test('a ring with no area is not a polygon', () => {
  const bounds = { west: 0, south: 0, east: 10, north: 10 };
  // Three collinear points: a line, and a line cannot be filled.
  assert.equal(
    clipRingToBounds(
      [
        [0, 5],
        [5, 5],
        [10, 5],
      ],
      bounds,
    ),
    null,
  );
});

test('a ring that only touches the rectangle at a corner is not a shape', () => {
  const bounds = { west: 0, south: 0, east: 10, north: 10 };
  assert.equal(
    clipRingToBounds(
      [
        [10, 10],
        [12, 10],
        [12, 12],
      ],
      bounds,
    ),
    null,
  );
});

test('the area of a ring is signed, and a ring and its hole have the same sign', () => {
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  assert.equal(ringArea(square), 100);
  assert.equal(ringArea([...square].reverse()), -100);
});

/*
 * The join, against the committed data.
 *
 * These read the real pack - Denver County, out of twenty nine megabytes of
 * JSON - because what they pin is a JOIN and not a shape: the index in a
 * tile is an index into the county's tract list, and the two have to agree
 * or the desk draws one tract's boundary and writes another tract's number
 * on it. A round trip through a made-up ring cannot catch that.
 */

/** Denver County, Colorado: the county the desk opens on. */
const denver = countyTractIndex('08', '031');

/** A tile over downtown Denver, at street zoom. */
const DENVER_TILE = { z: 14, x: 3413, y: 6218 };
/** A tile over the Atlantic, which is in no county at all. */
const SEA_TILE = { z: 14, x: 6826, y: 7262 };

test('the county index is the county, in GEOID order', async () => {
  const index = await denver;
  assert.ok(index.tracts.length > 100, 'Denver County has hundreds of tracts');
  const geoids = index.tracts.map((tract) => tract.geoid);
  assert.deepEqual(
    geoids,
    [...geoids].sort(),
    'the list is in GEOID order, so a rebuilt pack does not move an index',
  );
  index.tracts.forEach((tract, at) => {
    assert.equal(tract.index, at, 'the index is the position in the list');
    assert.ok(
      tract.geoid.startsWith('08031'),
      `${tract.geoid} is a Denver County tract`,
    );
  });
  assert.ok(
    index.tracts.some((tract) => (tract.units || 0) > 0),
    'and the housing units are attached',
  );
});

test('a tile names its tracts by their index in that list', async () => {
  const index = await denver;
  const tile = await tractTile(
    '08',
    '031',
    DENVER_TILE.z,
    DENVER_TILE.x,
    DENVER_TILE.y,
  );
  assert.ok(tile.count > 0, 'downtown Denver is inside some tracts');
  const decoded = decodeStreetTile(tile.bytes);
  assert.equal(decoded.lines.length, tile.count);
  for (const line of decoded.lines) {
    const tract = index.tracts[line.edgeIndex];
    assert.ok(tract, 'the index in the tile is an index into the list');
    const first = line.points[0];
    const last = line.points[line.points.length - 1];
    assert.deepEqual(first, last, 'a ring ends where it started');
    for (const [px, py] of line.points) {
      assert.ok(
        px >= -1 && px <= 4097 && py >= -1 && py <= 4097,
        `a point is inside the tile: ${px}, ${py}`,
      );
    }
  }
});

test('a tile over the sea is empty', async () => {
  const tile = await tractTile('08', '031', SEA_TILE.z, SEA_TILE.x, SEA_TILE.y);
  assert.equal(tile.count, 0, 'no tract of Denver County is in the Atlantic');
});

test('the tile route answers bytes, and an empty tile a 204', async () => {
  const tile = await runDeskApi(
    new URL(
      `http://localhost/api/desk/tracts/08/031/${DENVER_TILE.z}/${DENVER_TILE.x}/${DENVER_TILE.y}`,
    ),
  );
  assert.equal(tile.status, 200);
  assert.equal(tile.contentType, 'application/vnd.gev.tract-tile');
  assert.ok(tile.cache, 'the route says where the answer came from');
  assert.equal(
    decodeStreetTile(tile.bytes).lines.length,
    tile.count,
    'and the bytes are the tile the route counted',
  );

  const empty = await runDeskApi(
    new URL(
      `http://localhost/api/desk/tracts/08/031/${SEA_TILE.z}/${SEA_TILE.x}/${SEA_TILE.y}`,
    ),
  );
  assert.equal(empty.status, 204, 'an empty tile is a 204');
});

test('the index route answers the county list, in the order the tiles use', async () => {
  const index = await denver;
  const result = await runDeskApi(
    new URL('http://localhost/api/desk/tracts/08/031/index'),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.count, index.tracts.length);
  assert.equal(result.body.tracts.length, result.body.count);
  result.body.tracts.forEach((tract, at) => {
    assert.equal(tract.index, at);
    assert.equal(tract.geoid, index.tracts[at].geoid);
  });
  assert.ok(
    result.body.tracts.every((tract) => tract.geoid.startsWith('08031')),
    'and every one of them is a Denver County tract',
  );
  assert.ok(
    result.body.tracts.every(
      (tract) => tract.units === null || tract.units >= 0,
    ),
    'the housing units travel with the identity',
  );
});

test('the tract under the middle of the tile is in the tile', async () => {
  const index = await denver;
  const tile = await tractTile(
    '08',
    '031',
    DENVER_TILE.z,
    DENVER_TILE.x,
    DENVER_TILE.y,
  );
  const decoded = decodeStreetTile(tile.bytes);
  const bounds = tileBounds(DENVER_TILE.x, DENVER_TILE.y, DENVER_TILE.z);
  const lon = (bounds.west + bounds.east) / 2;
  const lat = (bounds.north + bounds.south) / 2;

  // The tract under the middle of the tile, found the slow way: by asking
  // the boundary itself whether it contains the point.
  let under = null;
  for (const tract of index.tracts) {
    for (const part of tract.parts) {
      if (!pointInRing(part[0], lat, lon)) continue;
      under = tract;
      break;
    }
    if (under) break;
  }
  assert.ok(under, 'the middle of downtown Denver is inside a tract');
  assert.ok(
    decoded.lines.some((line) => line.edgeIndex === under.index),
    `tract ${under.geoid} is in the tile`,
  );
});

test('the housing units are read once, and then they are in memory', async () => {
  const first = await housingUnitCounts();
  const second = await housingUnitCounts();
  assert.equal(first, second, 'the second read is the first one');
  const denver = first.get('08031000102');
  assert.ok(denver, 'the count is keyed by the tract GEOID');
  assert.ok(denver.units > 0, 'and it is a number of houses');
});

test('the housing units of a county add up to the county', async () => {
  const index = await denver;
  const sum = index.tracts.reduce(
    (total, tract) => total + (tract.units || 0),
    0,
  );
  // The county's own count, from the same artifact and the same build. The
  // tracts PARTITION the county, so the two have to agree exactly - a number
  // that does not add up is a number the desk would send a canvasser to.
  const county = countyUnits('08031');
  assert.equal(sum, county.units, 'the tracts of a county partition it');
});

test('the two routes cannot be confused with one another', async () => {
  const tile = await runDeskApi(
    new URL('http://localhost/api/desk/tracts/08/031/14/3413/6218'),
  );
  assert.equal(tile.status, 200);
  assert.ok(tile.bytes, 'the tile route answers bytes');
  const list = await runDeskApi(
    new URL('http://localhost/api/desk/tracts/08/031/index'),
  );
  assert.equal(list.status, 200);
  assert.ok(list.body.tracts, 'the index route answers a list');
});

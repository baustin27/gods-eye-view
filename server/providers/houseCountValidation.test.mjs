/**
 * The tract count against the street count.
 *
 * THE TRACT PATH and THE STREET PATH are two ways of answering the same
 * question with the same 1 km radar field: how much of this place was under
 * the hail.
 *
 *   - The TRACT path multiplies a tract's hail-covered share by the Census's
 *     count of housing units in it.
 *   - The STREET path lays the same field over the TIGER street ranges and
 *     counts the addresses under it, apportioned along each street's length.
 *
 * They are different arithmetic and they do not use the same denominator -
 * ACS housing units against TIGER address ranges, and the ranges run about
 * six times high - so they are NOT expected to agree on a number of houses.
 * What they are expected to do is agree on a SHARE, and that is what this
 * pins: the tract path says 17 percent of the units under the hail in these
 * tracts, the street path says 21 percent of the addresses, and the two are
 * computed from different data by different code.
 *
 * The street path needs the county's TIGER EDGES file, which is fetched from
 * the Census on demand and is not committed, so this test SKIPS when the
 * file is not on the disk. The script that produced the numbers is
 * `scripts/validate-house-counts.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { streetsPayload } from './hailStreets.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TIGER_CACHE =
  process.env.GEV_TIGER_CACHE || path.join(REPO, '.gev-cache', 'tiger');
const EDGES_FILE = path.join(TIGER_CACHE, 'tl_2024_08041_edges.zip');

/** The storm the two paths are compared on: El Paso County, 8 July 2024. */
const DAY = '2024-07-08';
const COUNTY = '041';
const STATE = '08';

function readGzippedJson(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

const swaths = readGzippedJson(
  path.join(REPO, 'apps/hail-desk/public/data/swaths.json.gz'),
);
const rows = swaths.rows.filter(
  (row) => row.d === DAY && String(row.g).startsWith(`08${COUNTY}`),
);

test('the swaths artifact carries both numbers, and the claim is the smaller one', () => {
  assert.ok(rows.length, 'the storm has tracts in the artifact');
  for (const row of rows) {
    assert.ok(
      row.h <= row.u,
      `${row.g}: ${row.h} houses claimed out of ${row.u} units`,
    );
    assert.ok(row.s >= 0 && row.s <= 1, `${row.g}: a share of ${row.s}`);
  }
  // The day itself: 10 tracts, 14,524 housing units, and 2,529 of them under
  // the hail.
  assert.equal(rows.length, 10);
  const units = rows.reduce((total, row) => total + row.u, 0);
  const houses = rows.reduce((total, row) => total + row.h, 0);
  assert.equal(units, 14524);
  assert.equal(houses, 2529);
});

test('the tract path and the street path agree on the share', async (t) => {
  if (!fs.existsSync(EDGES_FILE)) {
    t.skip(
      `the TIGER EDGES file for county ${COUNTY} is not on the disk; ` +
        'run scripts/validate-house-counts.mjs to fetch it and see the numbers',
    );
    return;
  }
  let addresses = 0;
  let underHail = 0;
  for (const row of rows) {
    const payload = await streetsPayload({
      state: STATE,
      county: COUNTY,
      day: DAY,
      tract: String(row.g),
    });
    addresses += payload.streets.reduce(
      (total, street) => total + (street.addresses || 0),
      0,
    );
    underHail += payload.streets.reduce(
      (total, street) => total + (street.underHail || 0),
      0,
    );
  }
  const streetShare = addresses ? underHail / addresses : 0;
  const tractShare = rows.reduce((total, row) => total + row.h, 0) /
    rows.reduce((total, row) => total + row.u, 0);
  // Ten points apart. The two paths are different arithmetic on different
  // data; they are not expected to agree exactly, and if they drift apart by
  // more than this the tract path is claiming something the streets do not
  // agree with.
  assert.ok(
    Math.abs(tractShare - streetShare) < 0.1,
    `the tract path says ${(tractShare * 100).toFixed(0)}% and the street ` +
      `path says ${(streetShare * 100).toFixed(0)}%`,
  );
});

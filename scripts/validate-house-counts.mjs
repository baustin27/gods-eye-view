#!/usr/bin/env node
/**
 * The tract count against the street count.
 *
 * THE TRACT PATH and THE STREET PATH are two ways of answering the same
 * question with the same 1 km radar field: how many houses were under the
 * hail.
 *
 *   - The TRACT path multiplies a tract's share of covered area by the
 *     Census's count of housing units in it.
 *   - The STREET path lays the same field over the TIGER street ranges and
 *     counts the addresses under it, apportioned along each street's length.
 *
 * They are not the same arithmetic and they do not use the same denominator
 * (ACS housing units against TIGER address ranges), so they are not
 * expected to agree exactly. What they ARE expected to do is agree in
 * ORDER OF MAGNITUDE, and to agree on WHICH storms were big. A tract number
 * that is ten times the street number is a tract number nobody should put
 * in front of a canvasser, and this is what catches that.
 *
 * Usage:
 *   node scripts/validate-house-counts.mjs [--day 2024-07-08] [--state 08] [--county 041]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { streetsPayload } from '../server/providers/hailStreets.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};

const day = arg('day', '2024-07-08');
const state = arg('state', '08');
const county = arg('county', '041');

function readGzippedJson(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

const swaths = readGzippedJson(
  path.join(ROOT, 'apps/hail-desk/public/data/swaths.json.gz'),
);
const places = readGzippedJson(
  path.join(ROOT, 'apps/hail-desk/public/data/cities.json.gz'),
);
const placeState = new Map(
  places.cities.map((city) => [String(city.id), String(city.st || '')]),
);
// The state comes in as FIPS (the tile routes and the tract GEOIDs are
// FIPS) and the places carry the postal code, so the two have to meet.
const counties = readGzippedJson(
  path.join(ROOT, 'apps/hail-desk/public/data/counties.json.gz'),
);
const postalForFips = new Map(
  counties.rows.map((row) => [String(row.fips).slice(0, 2), String(row.st)]),
);
const postal = postalForFips.get(state) || state;

const rows = swaths.rows.filter((row) => row.d === day);
const inCounty = rows.filter((row) => {
  if (placeState.get(String(row.k)) !== postal) return false;
  return String(row.g).slice(2, 5) === county;
});

const tractRaw = inCounty.reduce((total, row) => total + (row.u || 0), 0);
const tractApportioned = inCounty.reduce((total, row) => total + (row.h || 0), 0);

const payload = await streetsPayload({ state, county, day });
const streetHail = payload.streets.reduce(
  (total, street) => total + (street.underHail || 0),
  0,
);
const streetAddresses = payload.streets.reduce(
  (total, street) => total + (street.addresses || 0),
  0,
);

const ratio = (a, b) => (b > 0 ? a / b : 0);
console.log(`THE TWO PATHS, ${day}, county ${state}${county}`);
console.log(
  `  the tract path: ${inCounty.length} tracts | the market size ` +
    `${tractRaw.toLocaleString()} units | the apportioned ` +
    `${tractApportioned.toLocaleString()}`,
);
console.log(
  `  the street path: ${payload.count} streets | ${streetAddresses.toLocaleString()} ` +
    `addresses in the ranges | ${streetHail.toLocaleString()} of them under the hail`,
);
console.log(
  `  the apportioned tract count is ${ratio(tractApportioned, streetHail).toFixed(2)}x ` +
    `the street count`,
);
console.log(
  `  the raw tract count is ${ratio(tractRaw, streetHail).toFixed(2)}x the street count`,
);

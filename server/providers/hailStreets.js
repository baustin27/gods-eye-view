/**
 * Which streets were under the hail, on a given day.
 *
 * This is the join that turns a knock list into a work list. The Census says
 * how many addresses a street carries. The radar says where hail fell. This
 * module says how many of each street's addresses were under it.
 *
 * THE TWO SIDES OF THE JOIN.
 *
 *   - The addresses come from the TIGER EDGES file, per county, downloaded on
 *     demand and cached on disk. Its ranges are ADDRESSES in a stretch of
 *     street, which can be several blocks long, so they are not the same
 *     number as the housing units the Census counts in a ZIP. The two are
 *     never added together.
 *
 *   - The hail comes from the 1 km MRMS MESH field, one shard per calendar
 *     day, committed in the repository. A cell is over the threshold or it is
 *     not, at the product floor of one inch.
 *
 * WHY THE CELLS AND NOT THE TRACTS. The radar cell is about a kilometre
 * across; a census tract is usually a few. Joining a street to a tract would
 * put a street that ran along the edge of the hail in the same bucket as one
 * that ran through the middle of it, and would do the same to two streets
 * either side of a cell boundary. The cell is the finest thing anybody can
 * say about where hail fell, so it is what the street is measured against.
 *
 * WHAT THE NUMBER IS NOT. It is not a claim that those roofs were damaged.
 * It is the number of addresses on a street that were UNDER hail on a day,
 * which is a canvass universe and the whole of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { indexFineDay } from '../../src/data/stormReports.js';
import { hailFraction, hitCellSet } from '../../src/data/hailStreet.js';
import { countyEdges, countyStreets } from './tigerStreets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const STORM_DIR = path.join(REPO, 'src/data/local_data/storm');

/**
 * The product floor: one inch, in millimetres.
 *
 * The same floor the rest of the product uses - the desk's swaths, the
 * globe's bands. A knock list measured at a different threshold from the
 * table it hangs off would be a different product.
 */
export const HAIL_THRESHOLD_MM = 25.4;

/**
 * The cells that were over the threshold on a day.
 *
 * The fine shards are committed, so this reads from disk and not from the
 * network. A day outside the retention window has no shard BY DESIGN - the
 * 1 km field starts on 2024-01-01 - so a missing shard is an absence and not
 * a failure, and it is reported as one rather than as an empty county.
 *
 * @param {string} day ISO `YYYY-MM-DD`
 * @param {number} [thresholdMm]
 * @returns {{cells: Set<number>, found: boolean, total: number, maxMm: number}}
 */
export function dayHitCells(day, thresholdMm = HAIL_THRESHOLD_MM) {
  const file = path.join(
    STORM_DIR,
    `storm_radar_hail_fine_${day}.bin.gz`,
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
    throw new Error(`bad day: ${day}`);
  }
  if (!fs.existsSync(file)) {
    return { cells: new Set(), found: false, total: 0, maxMm: 0 };
  }
  const bytes = new Uint8Array(
    zlib.gunzipSync(fs.readFileSync(file)),
  );
  const { cells } = indexFineDay(bytes);
  let maxMm = 0;
  for (const cell of cells) {
    if (cell.maxMm > maxMm) maxMm = cell.maxMm;
  }
  return {
    cells: hitCellSet(cells, thresholdMm),
    found: true,
    total: cells.length,
    maxMm,
  };
}

/**
 * The streets of a county, with how many of their addresses were under the
 * hail on a day.
 *
 * @param {string} state two-digit state FIPS
 * @param {string} county three-digit county FIPS
 * @param {string} day ISO `YYYY-MM-DD`
 * @param {object} [options]
 * @param {string} [options.zip] only this ZIP
 * @param {number} [options.thresholdMm]
 * @returns {Promise<{streets: Array<object>, day: string, found: boolean,
 *   cells: number, maxMm: number, thresholdMm: number}>}
 */
export async function streetsUnderHail(state, county, day, options = {}) {
  const thresholdMm = options.thresholdMm ?? HAIL_THRESHOLD_MM;
  const field = dayHitCells(day, thresholdMm);
  const streets = await countyEdges(state, county, options.zip);

  // The two sides of an edge share one line, so the share is computed once
  // per edge and applied to both. Keyed by the geometry array itself, which
  // is the same object for both sides.
  const shares = new Map();
  for (const street of streets) {
    if (!street.points || street.points.length < 4) {
      street.underHail = 0;
      street.hailShare = 0;
      continue;
    }
    let share = shares.get(street.points);
    if (share === undefined) {
      const result = hailFraction(street.points, field.cells);
      share = result.fraction;
      shares.set(street.points, share);
    }
    street.hailShare = share;
    // ROUNDED, and the rounding is to a whole address because that is what an
    // address is. A street 12% under the hail with 41 addresses in range gets
    // 5 of them, not 4.9.
    street.underHail = Math.round(street.addresses * share);
  }

  // Under the hail first, then the addresses in range, then the name - so the
  // list is a work order and not an alphabetical accident.
  streets.sort(
    (a, b) =>
      b.underHail - a.underHail ||
      b.addresses - a.addresses ||
      a.name.localeCompare(b.name) ||
      a.from - b.from,
  );

  return {
    streets,
    day,
    found: field.found,
    cells: field.cells.size,
    maxMm: field.maxMm,
    thresholdMm,
  };
}

/**
 * The payload for the street list, with the hail on a day when one is asked
 * for.
 *
 * Both of the desk's servers - its own and the one the Vite dev server mounts
 * - answer the same question with this, so the desk sees one shape whether it
 * is being served in development or from the built app. A second handler
 * would be a second answer to the same question, and they would drift.
 *
 * @param {object} query `{state, county, zip, day, thresholdMm}`
 * @returns {Promise<object>}
 */
export async function streetsPayload(query = {}) {
  const state = String(query.state || '').trim();
  const county = String(query.county || '').trim();
  const zip = String(query.zip || '').trim();
  const day = String(query.day || '').trim();
  if (!/^\d{2}$/.test(state) || !/^\d{3}$/.test(county)) {
    throw new Error('state and county are required');
  }

  let streets;
  let hail = null;
  if (day) {
    const result = await streetsUnderHail(state, county, day, {
      zip,
      thresholdMm: Number(query.thresholdMm) || HAIL_THRESHOLD_MM,
    });
    streets = result.streets;
    hail = {
      day: result.day,
      found: result.found,
      cells: result.cells,
      maxMm: result.maxMm,
      thresholdMm: result.thresholdMm,
    };
  } else {
    streets = await countyStreets(state, county, zip);
  }

  const payload = {
    state,
    county,
    zip: zip || null,
    count: streets.length,
    // The addresses in the ranges, which is what these numbers are. The number
    // of HOUSES in a ZIP comes from the Census, and the two are not the same
    // and are never added together.
    addresses: streets.reduce((total, street) => total + street.addresses, 0),
    streets,
  };
  if (hail) {
    payload.hail = hail;
    payload.underHail = streets.reduce(
      (total, street) => total + (street.underHail || 0),
      0,
    );
  }
  return payload;
}

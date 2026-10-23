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
import {
  fineCellIndexAt,
  hitCellSet,
  sampleStreet,
} from '../../src/data/hailStreet.js';
import { countyEdges, countyStreets } from './tigerStreets.js';
import { loadTracts, tractContains } from './tracts.js';

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
  const file = path.join(STORM_DIR, `storm_radar_hail_fine_${day}.bin.gz`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
    throw new Error(`bad day: ${day}`);
  }
  if (!fs.existsSync(file)) {
    return { cells: new Set(), found: false, total: 0, maxMm: 0 };
  }
  const bytes = new Uint8Array(zlib.gunzipSync(fs.readFileSync(file)));
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
 * The streets of a county, with what was on them.
 *
 * Three questions can be asked of a street list, and they are asked together:
 *
 *   - WAS IT UNDER THE HAIL. The day's 1 km radar field, and the share of
 *     the street's length that lay in a cell over the threshold.
 *   - IS IT IN THIS TRACT. The Census boundary, and the share of the street's
 *     length inside it. A street on a tract boundary is in both of them, for
 *     different parts of itself.
 *   - WAS THE PART IN THE TRACT UNDER THE HAIL. The share of the street that
 *     is in the tract AND in a hit cell. This is the number the tract
 *     drill-down is for, and it is a product of two shares rather than a
 *     share of a share - so it is counted directly, from the same samples,
 *     rather than multiplied out of two separately-rounded numbers.
 *
 * All three come from ONE pass of samples along the street. Two passes would
 * answer the same street two slightly different ways, and the knock list
 * would disagree with the tract list.
 *
 * @param {string} state two-digit state FIPS
 * @param {string} county three-digit county FIPS
 * @param {object} [options]
 * @param {string} [options.zip] only this ZIP
 * @param {string} [options.day] ISO `YYYY-MM-DD`
 * @param {string} [options.tract] an eleven-digit tract GEOID
 * @param {number} [options.thresholdMm]
 * @returns {Promise<{streets: Array<object>, day: string, found: boolean,
 *   cells: number, maxMm: number, thresholdMm: number, tract: object|null}>}
 */
export async function countyStreetList(state, county, options = {}) {
  const thresholdMm = options.thresholdMm ?? HAIL_THRESHOLD_MM;
  const day = options.day ? String(options.day) : '';
  const field = day ? dayHitCells(day, thresholdMm) : null;
  const streets = await countyEdges(state, county, options.zip);

  const tractGeoid = String(options.tract || '').trim();
  let tract = null;
  let cellsCentred = 0;
  if (tractGeoid) {
    const tracts = await loadTracts();
    tract = tracts.get(tractGeoid) || null;
    if (!tract) {
      throw new Error(`no tract ${tractGeoid}`);
    }
    // The hit cells whose CENTRE is inside the tract. The tract list counts a
    // cell that only clips the tract's CORNER as reaching it - the radar
    // cell is sampled at its centre and its four corners, so a cell on the
    // boundary splits rather than giving all of its hail to one side - and
    // that is a wider reach than a street's. The two numbers differ, and
    // this is the one that says whether the hail was IN the tract or merely
    // touched it.
    if (field) {
      for (const index of field.cells) {
        const i = Math.floor(index / 6500) + 2100;
        const j = (index % 6500) - 12500;
        if (tractContains(tract, i * 0.01 + 0.005, j * 0.01 + 0.005)) {
          cellsCentred += 1;
        }
      }
    }
  }

  // The two sides of an edge share one line, so the samples are taken once
  // and applied to both. Keyed by the geometry array itself, which is the
  // same object for both sides.
  const seen = new Map();
  for (const street of streets) {
    if (!street.points || street.points.length < 4) {
      street.hailShare = 0;
      street.underHail = 0;
      street.tractShare = 0;
      street.addressesInTract = 0;
      street.underHailInTract = 0;
      continue;
    }
    let counts = seen.get(street.points);
    if (!counts) {
      counts = countStreet(street.points, field?.cells, tract);
      seen.set(street.points, counts);
    }
    street.hailShare = counts.hailShare;
    // ROUNDED, and the rounding is to a whole address because that is what an
    // address is. A street 12% under the hail with 41 addresses in range gets
    // 5 of them, not 4.9.
    street.underHail = Math.round(street.addresses * counts.hailShare);
    street.tractShare = counts.tractShare;
    street.addressesInTract = Math.round(street.addresses * counts.tractShare);
    street.underHailInTract = Math.round(
      street.addresses * counts.hailInTractShare,
    );
  }

  // A tract drill-down keeps only the streets that touch it.
  let kept = streets;
  if (tract) {
    kept = streets.filter((street) => street.tractShare > 0);
  }

  // Under the hail first, then the addresses in range, then the name - so the
  // list is a work order and not an alphabetical accident.
  kept.sort(
    (a, b) =>
      b.underHail - a.underHail ||
      b.addresses - a.addresses ||
      a.name.localeCompare(b.name) ||
      a.from - b.from,
  );

  // The GEOMETRY IS STRIPPED. The points are the server's own arithmetic -
  // they are how a street is measured against the hail - and the client has no
  // use for them. Leaving them in made one street list fourteen megabytes,
  // because a county has hundreds of thousands of coordinates, and the desk
  // was downloading all of them to draw four hundred rows. The map's tile
  // route is where the geometry belongs.
  const payload = kept.map(({ points, ...rest }) => ({
    ...rest,
    bounds: streetBounds(points),
  }));

  return {
    streets: payload,
    day,
    found: field ? field.found : false,
    cells: field ? field.cells.size : 0,
    maxMm: field ? field.maxMm : 0,
    thresholdMm,
    tract: tract
      ? { geoid: tract.geoid, name: tract.name, cellsCentred }
      : null,
  };
}

/** The geographic extent of one flat [lon, lat, ...] street line. */
export function streetBounds(points) {
  if (!Array.isArray(points) || points.length < 4) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const lon = points[i];
    const lat = points[i + 1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return Number.isFinite(west) ? { west, south, east, north } : null;
}

/**
 * The shares of one street, from one pass of samples along it.
 *
 * @param {Array<number>} points flat [lon, lat, lon, lat, ...]
 * @param {Set<number>|null} hitCells
 * @param {object|null} tract
 * @returns {{hailShare: number, tractShare: number, hailInTractShare: number}}
 */
function countStreet(points, hitCells, tract) {
  const { count, lat, lon } = sampleStreet(points);
  if (!count) {
    return { hailShare: 0, tractShare: 0, hailInTractShare: 0 };
  }
  let hail = 0;
  let inTract = 0;
  let hailInTract = 0;
  for (let k = 0; k < count; k += 1) {
    const index = fineCellIndexAt(lat[k], lon[k]);
    const hit = index >= 0 && hitCells ? hitCells.has(index) : false;
    if (hit) hail += 1;
    if (!tract) continue;
    if (!tractContains(tract, lat[k], lon[k])) continue;
    inTract += 1;
    if (hit) hailInTract += 1;
  }
  return {
    hailShare: hail / count,
    tractShare: inTract / count,
    hailInTractShare: hailInTract / count,
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
  const tract = String(query.tract || '').trim();
  if (!/^\d{2}$/.test(state) || !/^\d{3}$/.test(county)) {
    throw new Error('state and county are required');
  }

  let streets;
  let hail = null;
  let tractInfo = null;
  if (day || tract) {
    const result = await countyStreetList(state, county, {
      zip,
      day,
      tract,
      thresholdMm: Number(query.thresholdMm) || HAIL_THRESHOLD_MM,
    });
    streets = result.streets;
    if (day) {
      hail = {
        day: result.day,
        found: result.found,
        cells: result.cells,
        maxMm: result.maxMm,
        thresholdMm: result.thresholdMm,
      };
    }
    tractInfo = result.tract;
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
  if (tractInfo) {
    payload.tract = tractInfo;
    payload.cellsCentred = tractInfo.cellsCentred;
    payload.addressesInTract = streets.reduce(
      (total, street) => total + (street.addressesInTract || 0),
      0,
    );
    payload.underHailInTract = streets.reduce(
      (total, street) => total + (street.underHailInTract || 0),
      0,
    );
  }
  return payload;
}

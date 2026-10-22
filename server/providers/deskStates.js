/**
 * The state outlines, for the desk's map.
 *
 * THE DESK DRAWS ONE COUNTY'S STREETS AND TRACTS, and nothing that says
 * where that county is. A canvasser working a storm that crossed a state
 * line cannot see the line, and a desk that cannot show you where the state
 * ends is a desk that cannot tell you whose market you are in.
 *
 * The outlines are the Natural Earth admin-1 states, which the repo already
 * ships (`src/data/local_data/natural_earth/states_provinces.json`). The
 * pack is 3.6 MB and holds every country on earth, so it is parsed here, on
 * the server, once - the browser is sent one state's outline, which is four
 * points for Colorado and four hundred for Texas.
 *
 * The outline is SIMPLIFIED, like every other boundary in this repo: the
 * pack's own generalisation, not a survey. It is a line to see the state by,
 * not a line to build a fence from.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeRing } from '../../src/data/adminBoundaries.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const STATES_FILE = path.join(
  REPO,
  'src/data/local_data/natural_earth/states_provinces.json',
);

/** The states we serve, by their two-letter postal code. */
let states = null;

/**
 * The US states, by their postal code.
 *
 * The pack holds every country on earth, and the postal codes are only
 * unique WITHIN a country - "CO" is Colorado and a province in Algeria, and
 * a lookup that took the first match would draw the wrong shape.
 *
 * @returns {Map<string, object>}
 */
function stateIndex() {
  if (states) return states;
  states = new Map();
  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(STATES_FILE, 'utf8'));
  } catch {
    return states;
  }
  const decimals = pack.meta?.decimals ?? 5;
  for (const feature of pack.features || []) {
    if (feature.country !== 'United States of America') continue;
    if (feature.type !== 'State') continue;
    const postal = String(feature.postal || '').toUpperCase();
    if (!postal) continue;
    const rings = (feature.polygons || []).map((polygon) =>
      polygon.map((ring) => decodeRing(ring, feature.d ?? decimals)),
    );
    if (!rings.length) continue;
    states.set(postal, { name: feature.name, postal, rings });
  }
  return states;
}

/**
 * One state's outline, as rings of [lon, lat].
 *
 * @param {string} postal the two-letter postal code
 * @returns {{postal: string, name: string, rings: Array<Array<Array<number>>>}|null}
 */
export function stateOutline(postal) {
  const code = String(postal || '').trim().toUpperCase();
  if (!code) return null;
  const found = stateIndex().get(code);
  if (!found) return null;
  return { postal: found.postal, name: found.name, rings: found.rings };
}

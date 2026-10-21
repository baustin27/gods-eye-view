/**
 * The storm-date list: the days a storm happened, and the houses under it.
 *
 * The desk's city table answers "which towns are worth the afternoon". This
 * module answers the question a canvasser actually works from: "on which DAYS,
 * and how many roofs were standing under the hail".
 *
 * There are TWO spines, and the list is their UNION:
 *
 *   - REPORT days - a day on which at least one hail report was filed from
 *     inside a city or town boundary. Somebody measured a stone.
 *   - RADAR days - a day the 1 km MRMS MESH field reached something. The
 *     radar's footprint, and the houses standing in it.
 *
 * A report-only day is a market with no map - the radar missed it, or it
 * happened before the 1 km field starts in 2024. A radar-only day is the
 * PROSPECT thesis: the radar reached a town and nobody called the hail in,
 * which is invisible in a table of reports. Either spine on its own hides half
 * the work, so the list carries both and says which is which in `kind`.
 *
 * THE JOIN, and it is the whole trick: MRMS names a file for the window
 * ENDING at its timestamp, so the shard for day D covers D-1 06:00 -> D 00:00
 * UTC, which is most of the calendar day before it. The measured pairing of
 * report days to radar days (in Colorado the +1 offset covers 67 of 175
 * report days, twice as many as any other offset) says the shard that covers
 * a report day R is the shard named R+1. So a report row's radar columns
 * come from the shard R+1, and the row says WHICH shard it used (`radarDay`)
 * - the desk draws that shard when the row is picked.
 *
 * The shift lives in ONE place (`radarDayFor`) because an offset that gets
 * duplicated and then drifts shows up as a storm on the wrong day, with
 * nothing anywhere broken enough to explain it.
 *
 * A day with no radar reach has NO value for the radar columns, not a zero: a
 * zero claims the radar reached nothing and there were no houses, which is a
 * claim; null says the radar did not reach here, which is the truth.
 *
 * PURE: this module reads nothing and fetches nothing. The desk's `data.js`
 * loads the artifacts and hands them over already parsed, so the same numbers
 * can be computed in a test, in a script, or in the browser.
 */

/** Millimetres in an inch, because the radar speaks millimetres and the desk speaks inches. */
const MM_PER_INCH = 25.4;

/** Milliseconds in a day, because a UTC day is a fixed number of them. */
const MS_PER_DAY = 86400000;

/** The radar shard that covers a report day is the one named the next day. */
const RADAR_DAY_SHIFT_DAYS = 1;

/** The shape of a day, so a bad day is caught rather than rolled into March. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The columns the list sorts by, and every one of them sorts both ways.
 *
 * Exported so a header that offers a sort can CHECK that its key is here,
 * rather than discovering later that the header changed the URL and did not
 * move the table.
 */
export const STORM_SORT_KEYS = Object.freeze([
  'date',
  'houses',
  'reports',
  'severe',
  'largest',
  'places',
  'radarPlaces',
  'tracts',
]);

/**
 * Fail loudly when an artifact is not the shape it is supposed to be.
 *
 * An artifact that arrives empty produces an empty list, and an empty list
 * looks exactly like a day with no storms in it. The repo has a precedent for
 * that mistake and it cost a whole afternoon: the arithmetic was exact and it
 * was exactly wrong, and nothing anywhere said so.
 *
 * @param {unknown} value
 * @param {string} what the field's name, for the message
 * @returns {Array<unknown>}
 */
function requireArray(value, what) {
  if (!Array.isArray(value)) {
    throw new TypeError(`storms: ${what} must be an array`);
  }
  return value;
}

/**
 * The radar day a report day is covered by.
 *
 * MRMS names a file for the window ENDING at its timestamp, so the shard for
 * day D covers D-1 06:00 -> D 00:00 UTC and the shard covering a report day
 * R is the one named R+1. This is the one arithmetic fact the whole list
 * rests on, so it is written down once, here.
 *
 * @param {string} reportDay a `YYYY-MM-DD` day
 * @returns {string} the `YYYY-MM-DD` day of the shard that covers it
 */
export function radarDayFor(reportDay) {
  const day = String(reportDay ?? '').trim();
  if (!ISO_DAY.test(day)) {
    throw new TypeError(`storms: ${JSON.stringify(reportDay)} is not a YYYY-MM-DD day`);
  }
  const [year, month, date] = day.split('-').map(Number);
  const midnight = Date.UTC(year, month - 1, date);
  // The round trip rejects a day that does not exist (2024-02-30) instead of
  // quietly rolling it into March: a storm on the 30th of February is a bug
  // that otherwise arrives as a storm on the 2nd, with no error anywhere.
  if (new Date(midnight).toISOString().slice(0, 10) !== day) {
    throw new RangeError(`storms: ${day} is not a day`);
  }
  return new Date(midnight + RADAR_DAY_SHIFT_DAYS * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * Compare two values, with a missing value LAST in both directions.
 *
 * A day with no radar reach has no size at all - it is not the smallest and
 * it is not the biggest, it is unmeasured - so it goes to the end of the list
 * whichever way the list is sorted. Putting it first in a descending sort
 * would make the emptiest day the biggest storm on the page.
 *
 * @param {number|string|null|undefined} left
 * @param {number|string|null|undefined} right
 * @param {number} sign 1 for ascending, -1 for descending
 * @returns {number} -1, 0 or 1
 */
function compareValues(left, right, sign) {
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    return leftMissing ? 1 : -1;
  }
  if (left === right) return 0;
  if (typeof left === 'string' || typeof right === 'string') {
    const compared = left < right ? -1 : 1;
    return compared * sign;
  }
  return (left < right ? -1 : 1) * sign;
}

/**
 * The value a row carries for one sort key.
 *
 * @param {object} row
 * @param {string} key
 * @returns {number|string|null}
 */
function sortValue(row, key) {
  switch (key) {
    case 'date':
      return row.date;
    case 'houses':
      return row.houses;
    case 'reports':
      return row.reports;
    case 'severe':
      return row.severe;
    case 'largest':
      return row.largest;
    case 'places':
      return row.places;
    case 'radarPlaces':
      return row.radarPlaces;
    case 'tracts':
      return row.tracts;
    default:
      // The fallback is the date, and `STORM_SORT_KEYS` is exported so a
      // header can check its key is real rather than discovering that the
      // header changed the URL and did not move the table.
      return row.date;
  }
}

/**
 * Sort the storm days.
 *
 * Every column sorts, both ways, because the desk's headers ARE the controls:
 * a column that cannot be sorted is a column that lies about being a control.
 *
 * The sort is a COPY. The list is rebuilt from the artifacts whenever the
 * state changes, and a sort that edited the list in place would leave the
 * next render's order depending on the last sort somebody clicked.
 *
 * Ties break on the houses, descending, and then on the date, descending - so
 * two storms of the same size put the newer one first, and the order does not
 * depend on which rows happened to arrive first.
 *
 * @param {Array<object>} rows the storm days
 * @param {string} [key] one of `STORM_SORT_KEYS`; anything else sorts by date
 * @param {'asc'|'desc'} [dir] the way round; anything but 'asc' is descending
 * @returns {Array<object>} a sorted copy of the rows
 */
export function sortStormDays(rows, key = 'date', dir = 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  const list = Array.isArray(rows) ? rows : [];
  return [...list].sort((a, b) => {
    const primary = compareValues(sortValue(a, key), sortValue(b, key), sign);
    if (primary !== 0) return primary;
    const byHouses = compareValues(a.houses, b.houses, -1);
    if (byHouses !== 0) return byHouses;
    return compareValues(a.date, b.date, -1);
  });
}

/**
 * The storm days for one state: the union of the report days and the radar
 * days, with the numbers both spines have for each day.
 *
 * `kind` says which spines the DAY is on:
 *
 *   - 'both'    - reports were filed that day AND the radar reached something.
 *   - 'reports' - reports were filed and the radar did not reach that day.
 *   - 'radar'   - the radar reached something and nobody called it in.
 *
 * The kind is about the DAY; the radar columns are about the SHARD that
 * covers it, which is the next day. So a 'reports' row can still carry a
 * house count - the shard that covers it reached something even though the
 * radar missed the day itself - and a 'both' row can show no house count at
 * all, because the shard that covers it reached nothing. That is not a bug,
 * it is the two clocks: the radar names its file for the window ENDING at its
 * timestamp, and the reports are filed against a calendar day.
 *
 * The radar COLUMNS of a report row come from the shard that covers it (R+1),
 * and a radar row's come from its own shard, so `radarDay` names the shard a
 * row's numbers came from - which is also the shard the desk draws.
 *
 * The rows come back in date order, ascending. The list's display order is the
 * desk's business (`sortStormDays`), not this module's.
 *
 * @param {object} input
 * @param {object} input.cities the parsed cities artifact
 * @param {object} input.swaths the parsed swaths artifact
 * @param {string} [input.state] a two-letter state code ('CO') or a state
 *   name ('Colorado'); empty or absent means every state
 * @returns {Array<{date: string, kind: 'both'|'reports'|'radar', radarDay: string,
 *   houses: number|null, units: number|null, tracts: number|null,
 *   radarPlaces: number|null,
 *   reports: number, severe: number, largest: number|null, places: number}>}
 */
export function buildStormDays({ cities, swaths, state } = {}) {
  const wanted = String(state ?? '').trim().toUpperCase();
  const places = requireArray(cities?.cities, 'cities.cities');
  const days = requireArray(cities?.cityDays, 'cities.cityDays');
  const swathRows = requireArray(swaths?.rows, 'swaths.rows');

  // The state of a PLACE, so a row can be filed under the state it happened
  // in. The code and the name both work, because a desk link that carries
  // 'Colorado' instead of 'CO' should show Colorado rather than nothing.
  const placeState = new Map();
  for (const place of places) {
    placeState.set(String(place.id), {
      code: String(place.st || '').toUpperCase(),
      name: String(place.state || '').toUpperCase(),
    });
  }
  const inState = (geoid) => {
    if (!wanted) return true;
    const place = placeState.get(String(geoid));
    if (!place) return false;
    return place.code === wanted || place.name === wanted;
  };

  // The REPORT spine: a day somebody measured a stone inside a town.
  const reports = new Map();
  for (const row of days) {
    // A day with no HAIL in it is not a hail day. The artifact also carries
    // wind-only days - a place with a wind report and no hail - and counting
    // those would put wind storms in a hail list and inflate the place count.
    if (!(Number(row.n) > 0)) continue;
    if (!inState(row.geoid)) continue;
    let entry = reports.get(row.d);
    if (!entry) {
      entry = { reports: 0, severe: 0, places: new Set(), max: 0 };
      reports.set(row.d, entry);
    }
    entry.reports += Number(row.n) || 0;
    entry.severe += Number(row.n1) || 0;
    entry.places.add(String(row.geoid));
    const max = Number(row.max) || 0;
    if (max > entry.max) entry.max = max;
  }

  // The RADAR spine: a day the 1 km field reached something, and the houses
  // standing in the tracts it reached.
  const radar = new Map();
  for (const row of swathRows) {
    if (!inState(row.k)) continue;
    let entry = radar.get(row.d);
    if (!entry) {
      entry = {
        houses: 0,
        units: 0,
        tracts: 0,
        places: new Set(),
        maxMm: 0,
      };
      radar.set(row.d, entry);
    }
    // A tract with no housing units in it contributes no houses and still
    // counts as a tract: it is a place to work, with nobody living in it.
    //
    // `houses` is the APPORTIONED count - the share of the tract the hail
    // covered, times the units in it - and `units` is the whole tract, which
    // is the market and not a claim about houses. A storm that clipped two
    // and a half percent of a 1,248 square kilometre tract did not put hail
    // over 2,805 roofs, and a canvasser sent there on the raw number would
    // spend a day knocking doors the hail never reached.
    entry.houses += Number(row.h ?? row.u) || 0;
    entry.units += Number(row.u) || 0;
    entry.tracts += 1;
    entry.places.add(String(row.k));
    const mm = Number(row.m) || 0;
    if (mm > entry.maxMm) entry.maxMm = mm;
  }

  const dates = new Set([...reports.keys(), ...radar.keys()]);
  const out = [];
  for (const date of dates) {
    const report = reports.get(date) || null;
    const kind = report ? (radar.has(date) ? 'both' : 'reports') : 'radar';
    // A report day's radar columns come from the shard that COVERS it; a
    // radar row's come from its own shard, which is the day it is named for.
    const radarDay = report ? radarDayFor(date) : date;
    const shard = radar.get(radarDay) || null;
    out.push({
      date,
      kind,
      radarDay,
      // The radar's reach: null when the shard did not reach this state, not
      // zero, because zero would be a claim about the size of nothing.
      houses: shard ? shard.houses : null,
      // The market: every housing unit in the tracts the hail reached, which
      // is not a claim about houses and is beside the claim on purpose.
      units: shard ? shard.units : null,
      tracts: shard ? shard.tracts : null,
      radarPlaces: shard ? shard.places.size : null,
      // The reports: the count of the hail reports filed that day, how many
      // of them were an inch or more, and how many places filed them.
      reports: report ? report.reports : 0,
      severe: report ? report.severe : 0,
      places: report ? report.places.size : 0,
      // The largest stone, in INCHES. The radar's reading when the radar
      // reached, because the radar reads every cell and the reports read the
      // stones that were picked up; otherwise the reports' own largest.
      largest: shard ? shard.maxMm / MM_PER_INCH : report ? report.max : null,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

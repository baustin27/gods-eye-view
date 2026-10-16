/**
 * Normalise storm reports from every source into one internal record shape.
 *
 * Two producers, one shape:
 *
 *  - `normalizeSpcBulkRow` reads the SPC severe-weather archive
 *    (`1955-<year>_{hail,wind}.csv.zip`), whose `mag` is already in inches for
 *    hail and knots for wind, and whose `date` column carries a full ISO day.
 *  - `normalizeSpcDailyRow` reads the per-day CSVs
 *    (`/climo/reports/YYMMDD_rpts_{hail,wind}.csv`), which exist from 2015
 *    onwards and are the only way to reach the current year, because the bulk
 *    archive stops at the last completed year. Their `Size` is hundredths of
 *    an inch for hail and knots for wind, and the day comes from the URL stamp
 *    rather than a column.
 *
 * Pure: no I/O, no clocks, no randomness. `build-storm-reports.mjs` does the
 * fetching and this decides what a record means.
 * @module scripts/lib/storm-report-normalize
 */

/** Hail and wind are the two hazards this covers. */
export const STORM_HAZARDS = Object.freeze(['hail', 'wind']);

/**
 * What a magnitude means, per hazard. Kept beside the value rather than at the
 * call site so no consumer can read a wind speed as inches.
 */
export const MAGNITUDE_UNITS = Object.freeze({
  hail: 'in',
  wind: 'kt',
});

/**
 * Reports below this are traces — "hail was falling but nothing measurable".
 * They are retained and flagged rather than dropped: a trace report still puts
 * a storm on the map, and silently discarding it would understate coverage on a
 * day when few real sizes were filed.
 *
 * The floor sits well under the smallest size the archive actually records
 * (0.13in), so a real measured stone is never mislabelled. It is here to catch
 * the degenerate rows some daily files carry, where the hundredths column
 * arrives as a bare 1-4 and means a trace rather than four hundredths of an
 * inch.
 */
const HAIL_TRACE_IN = 0.05;

/**
 * @typedef {Object} StormReport
 * @property {string} id           Stable per-source id.
 * @property {string} date         ISO day, `YYYY-MM-DD`.
 * @property {number|null} minute  Minutes past midnight, local to the report.
 * @property {string} hazard       `hail` | `wind`.
 * @property {number|null} size    Hail inches, or wind knots.
 * @property {number|null} lat
 * @property {number|null} lon
 * @property {string|null} county
 * @property {string|null} state
 * @property {string|null} countyFips
 * @property {number} loss         USD, 0 when unreported.
 * @property {number|null} injuries
 * @property {number|null} fatalities
 * @property {boolean} trace       A report that qualifies the storm but has no
 *   measurable magnitude.
 * @property {string[]} sources    Provenance, e.g. `['spc-bulk']`.
 * @property {string|null} comment Verbatim text where the source carries it.
 * @property {number} [stormRef]   Ordinal of the storm this report belongs to,
 *   resolved by the build and absent on a freshly normalised row. `-1` once
 *   packed means the report belongs to no storm.
 */

/**
 * Clock time to minutes past midnight.
 *
 * The two producers disagree on format and this is where it has to be absorbed:
 *
 *  - the bulk archive writes `13:15:00`
 *  - the per-day files write `1208`, with no colon at all
 *
 * Anything else is a null time rather than a guess, because a misparsed clock
 * would place a report in the wrong hour of the storm it belongs to.
 * @param {string} [raw]
 * @returns {number|null}
 */
export function parseLocalTime(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const colonated = /^(\d{1,2}):(\d{2})/.exec(text);
  if (colonated) {
    return validateClock(Number(colonated[1]), Number(colonated[2]));
  }
  const bare = /^(\d{3,4})$/.exec(text);
  if (bare) {
    const digits = bare[1].padStart(4, '0');
    return validateClock(Number(digits.slice(0, 2)), Number(digits.slice(2)));
  }
  return null;
}

/**
 * @param {number} hours
 * @param {number} minutes
 * @returns {number|null} Null when out of range.
 */
function validateClock(hours, minutes) {
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * SPC's bulk `stf` is the two-digit state FIPS and `f1` the three-digit county
 * FIPS, together a five-digit county code. Rows where either is absent or
 * non-numeric (0, 99, blank) cannot be joined to county geometry, so they carry
 * `null` rather than a code that would silently match nothing.
 * @param {Object<string,string>} row
 * @returns {string|null}
 */
export function countyFipsFromSpc(row) {
  const state = String(row.stf ?? '').trim();
  const county = String(row.f1 ?? '').trim();
  if (!/^\d{1,2}$/.test(state)) return null;
  if (!/^\d{1,3}$/.test(county)) return null;
  const stateNum = Number(state);
  const countyNum = Number(county);
  if (stateNum === 0 || stateNum === 99) return null;
  if (countyNum === 0 || countyNum === 999) return null;
  return `${state.padStart(2, '0')}${county.padStart(3, '0')}`;
}

/**
 * A row is usable only if it can be placed on a map and on a day. Reports at
 * 0,0 are SPC's null island marker, and `lat/lon` land in the ocean on a few
 * county-spanning rows.
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function isPlottable(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat === 0 && lon === 0) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  return true;
}

/**
 * Normalise one row of the SPC bulk archive.
 *
 * `mag` is inches for hail and knots for wind in this database — no unit
 * conversion is needed, which is the main reason this source is preferred over
 * the daily CSVs whenever it is available.
 * @param {Object<string,string>} row
 * @param {'hail'|'wind'} hazard
 * @returns {StormReport|null} Null when the row cannot be placed or dated.
 */
export function normalizeSpcBulkRow(row, hazard) {
  const date = String(row.date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const lat = Number(row.slat);
  const lon = Number(row.slon);
  if (!isPlottable(lat, lon)) return null;

  const magnitude = Number(row.mag);
  const size = Number.isFinite(magnitude) && magnitude > 0 ? magnitude : null;

  const loss = Number(row.loss);
  const injuries = Number(row.inj);
  const fatalities = Number(row.fat);

  return {
    id: String(row.om ?? '').trim() || `${hazard}-${date}-${lat}-${lon}`,
    date,
    minute: parseLocalTime(row.time),
    hazard,
    size,
    lat,
    lon,
    county: null,
    state: String(row.st ?? '').trim() || null,
    countyFips: countyFipsFromSpc(row),
    // The database carries loss in thousands of dollars, crowd-sourced from NWS.
    loss: Number.isFinite(loss) && loss > 0 ? loss * 1000 : 0,
    injuries: Number.isFinite(injuries) ? injuries : null,
    fatalities: Number.isFinite(fatalities) ? fatalities : null,
    trace: hazard === 'hail' ? size !== null && size < HAIL_TRACE_IN : false,
    sources: ['spc-bulk'],
    comment: null,
  };
}

/**
 * Normalise one row of a per-day SPC report CSV.
 *
 * Two shape differences from the bulk archive drive this function:
 *
 *  - The day is not a column. It comes from the URL stamp the caller passes in,
 *    because the file itself only carries a clock time.
 *  - Hail `Size` is hundredths of an inch — `100` is 1.00″. Wind `Speed` is
 *    already knots.
 *
 * The `Location`/`County`/`State` columns are free text and are kept as-is;
 * there is no FIPS here to join on, which is why the daily path is the fallback
 * for current-year data rather than the primary.
 * @param {Object<string,string>} row
 * @param {'hail'|'wind'} hazard
 * @param {string} day ISO day the file was published for.
 * @returns {StormReport|null}
 */
export function normalizeSpcDailyRow(row, hazard, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ''))) {
    throw new TypeError(
      'A daily row needs the ISO day its file was published for',
    );
  }
  const lat = Number(row.Lat);
  const lon = Number(row.Lon);
  if (!isPlottable(lat, lon)) return null;

  const rawMagnitude = Number(hazard === 'hail' ? row.Size : row.Speed);
  if (!Number.isFinite(rawMagnitude) || rawMagnitude <= 0) return null;

  // Hail arrives in hundredths of an inch; a value below 100 is a trace or a
  // malformed row rather than a size. Wind is knots and needs no scaling.
  const size = hazard === 'hail' ? rawMagnitude / 100 : rawMagnitude;

  const comment = String(row.Comments ?? '').trim();
  // Many rows carry nothing but the forecast-office code, e.g. `(MEG)`. That
  // is provenance, not a description, so it does not count as a narrative.
  const hasText =
    comment.length > 4 && /[a-z]{3}/i.test(comment.replace(/\(.+\)/g, ''));

  return {
    id: `${hazard}-${day}-${row.Time ?? ''}-${lat}-${lon}`,
    date: day,
    minute: parseLocalTime(row.Time),
    hazard,
    size,
    lat,
    lon,
    county: String(row.County ?? '').trim() || null,
    state: String(row.State ?? '').trim() || null,
    countyFips: null,
    loss: 0,
    injuries: null,
    fatalities: null,
    trace: hazard === 'hail' ? size < HAIL_TRACE_IN : false,
    sources: ['spc-daily'],
    comment: hasText ? comment : null,
  };
}

/**
 * Stable sort into the order every consumer expects: chronological, then
 * north-west to south-east so two reports at the same minute stay in a fixed
 * sequence and a rebuild produces byte-identical output.
 * @param {StormReport[]} reports
 * @returns {StormReport[]}
 */
export function sortReports(reports) {
  return reports.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const am = a.minute ?? -1;
    const bm = b.minute ?? -1;
    if (am !== bm) return am - bm;
    if (a.lat !== b.lat) return b.lat - a.lat;
    if (a.lon !== b.lon) return a.lon - b.lon;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Compact wire form. Field names are abbreviated because the payload is a
 * hundred thousand rows per year and this roughly halves it.
 *
 * `stormRef` is appended rather than inserted: the tuple's slot order is a
 * published contract, and the layer's own unpacker destructures by position.
 * It is an integer ordinal into the year's `storm_events_<year>.json.gz`
 * `events` array, not an episode id — a cluster id like
 * `cl-2025-03-30-250330120701` repeated across every one of 155,737 rows is
 * real weight for no information.
 * @param {StormReport} report
 * @returns {Array}
 */
export function packReport(report) {
  return [
    report.date,
    report.minute ?? -1,
    report.hazard === 'hail' ? 0 : 1,
    report.size ?? 0,
    report.lat,
    report.lon,
    report.countyFips || '',
    report.state || '',
    report.county || '',
    report.loss || 0,
    report.comment || '',
    report.sources.join(','),
    report.trace ? 1 : 0,
    report.stormRef ?? -1,
  ];
}

/** Inverse of {@link packReport}. */
export function unpackReport(packed) {
  const [
    date,
    minute,
    hazard,
    size,
    lat,
    lon,
    countyFips,
    state,
    county,
    loss,
    comment,
    sources,
    trace,
    stormRef,
  ] = packed;
  return {
    id: `${date}-${hazard}-${lat}-${lon}-${minute}`,
    date,
    minute: minute < 0 ? null : minute,
    hazard: hazard === 0 ? 'hail' : 'wind',
    size: size || null,
    lat,
    lon,
    countyFips: countyFips || null,
    state: state || null,
    county: county || null,
    loss: loss || 0,
    injuries: null,
    fatalities: null,
    trace: Boolean(trace),
    sources: String(sources || '')
      .split(',')
      .filter(Boolean),
    comment: comment || null,
    // A row packed before this field existed reads as undefined here, and an
    // absent ordinal means the same thing as an explicit -1: no storm.
    stormRef: Number.isInteger(stormRef) ? stormRef : -1,
  };
}

/**
 * Build a county-name lookup from the bundled county polygons.
 *
 * The per-day SPC files carry a county *name* and a state abbreviation, never
 * a FIPS code, so 2026 reports arrive with no county code at all. The bulk
 * archive does carry one. This recovers it for the daily rows.
 *
 * Keys are `STATE|NORMALISED_NAME` with every non-alphanumeric character
 * removed, because the sources disagree about spacing and punctuation: the
 * daily files write `LA PORTE` and `DE KALB` where the county file writes
 * `La Porte` and `De Kalb`.
 *
 * @param {Array<{properties: {fips?: string, name?: string, st?: string}}>} counties
 * @returns {Map<string, string>} Lookup key -> five-digit FIPS.
 */
export function buildCountyFipsIndex(counties) {
  const index = new Map();
  for (const feature of counties) {
    const p = feature?.properties;
    const fips = String(p?.fips ?? '').trim();
    const name = String(p?.name ?? '').trim();
    const state = String(p?.st ?? '').trim();
    if (!/^\d{5}$/.test(fips) || !name || !state) continue;
    index.set(countyLookupKey(state, name), fips);
  }
  return index;
}

/**
 * The one spelling both sources agree on: state, a pipe, then the name with
 * everything non-alphanumeric stripped.
 * @param {string} state
 * @param {string} name
 * @returns {string}
 */
export function countyLookupKey(state, name) {
  const bare = (v) =>
    String(v ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  return `${bare(state)}|${bare(name)}`;
}

/**
 * An NWS zone code such as `GMZ635` or `PZZ655` spans several counties, so it
 * has no single correct FIPS. Recognising them keeps the resolver from
 * inventing one: the zone stays readable in `county`, the code stays null.
 * @param {string} value
 * @returns {boolean}
 */
export function isNwsZoneCode(value) {
  return /^[A-Z]{3}\d{3}$/.test(
    String(value ?? '')
      .trim()
      .toUpperCase(),
  );
}

/**
 * Fill in `countyFips` on reports that only have a county name, leaving the
 * ones that already carry a code untouched and the unresolvable ones null.
 *
 * Mutates in place and returns the same array, because a report list is large
 * enough that copying it per pass is worth avoiding.
 * @param {StormReport[]} reports
 * @param {Map<string, string>} index From {@link buildCountyFipsIndex}.
 * @returns {{resolved: number, unresolvable: number, zones: number}}
 */
export function applyCountyFips(reports, index) {
  let resolved = 0;
  let unresolvable = 0;
  let zones = 0;
  for (const report of reports) {
    if (report.countyFips) continue;
    if (!report.county || !report.state) {
      unresolvable += 1;
      continue;
    }
    if (isNwsZoneCode(report.county)) {
      zones += 1;
      continue;
    }
    const fips = index.get(countyLookupKey(report.state, report.county));
    if (fips) {
      report.countyFips = fips;
      resolved += 1;
    } else {
      unresolvable += 1;
    }
  }
  return { resolved, unresolvable, zones };
}

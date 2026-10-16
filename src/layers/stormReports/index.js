/**
 * Storm Reports — individual hail and wind reports, not an aggregate surface.
 *
 * Where the hail/wind layer paints a blended score across 0.25-degree cells,
 * this draws the reports themselves: one point per observation, sized and
 * coloured by magnitude, filterable by date, county and size, and clickable
 * through to the storm it belonged to.
 *
 * That level is the one a canvasser works from, and it is only possible
 * because the snapshot keeps the day. The aggregate layer averages seventy
 * years; this answers "what fell, where, how big, and on what day".
 * @module layers/stormReports/index
 */

import {
  hailBand,
  HAIL_BANDS,
  magnitudeLabel,
  framingFor,
  matchesFilter,
  parseStormDate,
  radiusMetres,
  windBand,
  worstFirst,
} from './model.js';
import * as Cesium from 'cesium';
import {
  crossReference,
  indexRadarCells,
  summariseAgreement,
} from '../../data/stormCrossReference.js';
import { stormDays } from '../../data/stormReports.js';
import { STORM_SOURCE_BADGE } from '../../data/stormAttribution.js';

/** The layer id, and the token reserved for it in the layer-state ledger. */
export const STORM_REPORTS_ID = 'storm-reports';

/** Shareable options, all defaulted so an absent option means the default. */
/**
 * The smallest hail this layer will ever show.
 *
 * An inch is the point where hail stops being a curiosity and starts being
 * damage, and this layer exists to answer "was there damage". A shared link
 * carrying a lower value is clamped rather than honoured: the codec only knows
 * the value is a positive integer, and the floor is a claim this layer makes.
 */
export const HAIL_FLOOR_IN = 1.0;

/** How many report cards the overlay may show at once. */
const OVERLAY_COHORT_LIMIT = 25;

/**
 * Hard ceiling on the rows one comparison may look at.
 *
 * The largest day on record holds 1,135 reports, so this is a guard rather than
 * a budget: it exists so that a future window widening by accident cannot turn
 * a canvassing question into a national join. Past it, no line is shown at all,
 * which is the honest answer.
 */
const COMPARISON_ROW_LIMIT = 5000;

/**
 * Read a radar payload into the cell lookup the comparison joins on.
 *
 * Deliberately permissive about shape — a Map, the builder's GeoJSONL text, or
 * `{cells}` wrapping either — so a per-year loader and a whole-record index can
 * both be handed in unchanged. An unrecognised shape is an empty Map, which
 * reads as "no cores that day" rather than as a failure.
 *
 * @param {Map<string, {mx: number, cores: number}>|{cells?: Map|string|Array}|string} raw
 * @returns {Map<string, {mx: number, cores: number}>}
 */
function normaliseRadarCells(raw) {
  if (raw instanceof Map) return raw;
  if (typeof raw === 'string') return indexRadarCells(raw).cells;
  if (Array.isArray(raw)) return indexRadarCells(raw.join('\n')).cells;
  const cells = raw?.cells ?? raw?.radarCells;
  if (cells instanceof Map) return cells;
  if (typeof cells === 'string' || Array.isArray(cells))
    return indexRadarCells(Array.isArray(cells) ? cells.join('\n') : cells)
      .cells;
  return new Map();
}

/** The hail threshold rungs offered, inches. */
export const HAIL_THRESHOLDS_IN = Object.freeze([1, 1.5, 2, 2.5, 3]);

/** Bands used for the panel legend. */
const HAIL_LEGEND = [
  {
    label: 'Quarter to half inch',
    color: '#f4e08d',
    title: 'Baroque reading, minor damage',
  },
  {
    label: 'Half to three-quarter',
    color: '#f7c948',
    title: 'Softens a roof, worth a look',
  },
  {
    label: 'Three-quarter to one inch',
    color: '#f0a92e',
    title: 'Typical first-damage threshold',
  },
  {
    label: 'One to one-and-a-half inch',
    color: '#e8862c',
    title: 'Likely shingle damage',
  },
  {
    label: 'One and a half inch and up',
    color: '#d6452c',
    title: 'Serious damage, call the insurer',
  },
];

export const STORM_REPORTS_DEFAULTS = Object.freeze({
  minHailIn: 1.0,
  minWindKt: 50,
  hazard: 'hail',
  fromDate: null,
  toDate: null,
});

/**
 * @param {{source: object, overlayHost?: object, radarSource?: object}} deps
 *
 * `radarSource` is optional and the layer is complete without it: no radar
 * dependency means no cross-reference and no error, which is the only safe
 * default for a feature that was previously unreachable. When one is supplied it
 * must offer
 *
 *   cellsFor(years, signal) -> Promise<Map<'i:j', {mx: number, cores: number}>
 *                              | {cells: Map} | {cells: string}
 *
 * where the string is the GeoJSONL the radar builder emits and
 * {@link module:data/stormCrossReference.indexRadarCells} reads it. It is asked
 * only for a single selected hail day, so a lazily-loading per-year radar pays
 * for one year and never for the record.
 */
/**
 * The chip handlers are called detached from the row, so they need a handle on
 * the instance to call back into. Held in a single slot and cleared on destroy
 * so a stale panel cannot drive a torn-down layer.
 */
let _instance = null;

/** @returns {object|null} */
function self() {
  return _instance;
}

/** The snapshot keys years as strings, and so does every date. */
function yearOf(value) {
  const text = String(value ?? '');
  return /^\d{4}-/.test(text) ? text.slice(0, 4) : null;
}

/**
 * A report's storm ordinal, or -1 when it has none.
 *
 * The shipped snapshot files predate the ordinal and pack 13 slots, so every row
 * in them reads as undefined. That is the same thing as -1: the row belongs to
 * no storm we can address, and every path below has to survive it.
 * @param {object} report
 * @returns {number}
 */
function stormRefOf(report) {
  const ref = report?.stormRef;
  return Number.isInteger(ref) && ref >= 0 ? ref : -1;
}

/**
 * Index the flat event list by year, and record where each year begins.
 *
 * `eventsFor` returns one array per year concatenated together, so a report's
 * `stormRef` — the row's ordinal inside *its own* year's event file — is not an
 * index into the list the layer was handed. Using it as one silently reads a
 * 2026 report's storm out of 2025. The base map is where each year's run
 * begins, and a lookup is `base[year] + stormRef`.
 *
 * Contiguity is derived, not assumed: a year whose events do not occupy one
 * unbroken run gets no base, and the reverse lookup for that year degrades to
 * matching on date rather than resolving to a storm that may not exist.
 *
 * @param {object[]} events
 * @returns {{byYear: Map<string, object[]>, base: Map<string, number|null>}}
 */
function groupEventsByYear(events) {
  const byYear = new Map();
  const base = new Map();
  const list = events || [];
  list.forEach((event, index) => {
    const year = yearOf(event?.date);
    if (!year) return;
    if (!byYear.has(year)) {
      byYear.set(year, []);
      base.set(year, index);
    }
    byYear.get(year).push(event);
  });
  for (const [year, group] of byYear) {
    const start = base.get(year);
    for (let i = 0; i < group.length; i += 1) {
      if (list[start + i] !== group[i]) {
        base.set(year, null);
        break;
      }
    }
  }
  return { byYear, base };
}

export function createStormReportsLayer({
  source,
  overlayHost,
  radarSource,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Storm Reports layer requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('Storm Reports layer requires an overlay host');

  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _snapshot = null;
  let _events = [];
  let _eventsByYear = new Map();
  let _eventBase = new Map();
  let _visible = [];
  let _enabled = false;
  let _loading = false;
  let _lastError = null;
  let _lastUpdate = null;
  let _options = { ...STORM_REPORTS_DEFAULTS };
  let _pendingParams = null;
  let _selectedStormId = null;
  let _stats = null;
  let _loaded = false;
  let _optionsDirty = true;
  let _packed = null;
  let _fieldMessage = null;
  let _previouslyEmpty = true;
  let _comparison = null;
  let _comparisonKey = null;
  let _comparisonToken = 0;
  let _ordinalYears = new Set();

  /**
   * Durable option intent from the manager, replayed once data lands. The
   * manager applies params before the first load, when there is nothing to
   * filter yet, so they have to be remembered rather than applied.
   *
   * The shareable option is `minHailTenths`, because the layer-state codec
   * carries integer options only and 1.75 inches has to survive a round trip.
   * It is translated here rather than in the filter, so nothing downstream ever
   * sees tenths.
   */
  function applyPendingParams() {
    if (!_pendingParams || !_snapshot) return;
    const next = { ..._options, ..._pendingParams };
    _options = {
      ...next,
      // A shared link can carry any positive integer; the floor is ours to hold.
      minHailIn: clampHailIn(
        Number.isFinite(next.minHailTenths)
          ? next.minHailTenths / 10
          : next.minHailIn,
      ),
    };
    _pendingParams = null;
  }

  /** Years the current date window touches. */
  function yearsInWindow() {
    if (!_snapshot?.years?.length) return [];
    const from = _options.fromDate
      ? Number(_options.fromDate.slice(0, 4))
      : _snapshot.years[0];
    const to = _options.toDate
      ? Number(_options.toDate.slice(0, 4))
      : _snapshot.years.at(-1);
    return _snapshot.years.filter((y) => Number(y) >= from && Number(y) <= to);
  }

  async function reload() {
    if (!_enabled) return;
    _loading = true;
    _lastError = null;
    publish();
    try {
      _snapshot = await source.getSnapshot({ signal: _request?.signal });
      applyPendingParams();
      // Through the source, not around it. Reaching into the module directly
      // made the data path unreachable to a stub, which is how a layer this
      // small ends up untested.
      const years = yearsInWindow();
      const [packed, events] = await Promise.all([
        source.reportsFor(years, _request?.signal),
        source.eventsFor(years, _request?.signal),
      ]);
      if (_request?.signal?.aborted) return;
      _events = events;
      const grouped = groupEventsByYear(events);
      _eventsByYear = grouped.byYear;
      _eventBase = grouped.base;
      _packed = packed;
      applyFilter(packed);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      _lastError = error instanceof Error ? error : new Error(String(error));
      // Surfaced loudly: a layer that swallows its load failure returns false
      // from update(), the manager rejects the transition, and the only
      // visible symptom is "Could not enable the requested layer" with no cause
      // anywhere. That is what made this cost an hour.
      console.error('[Storm Reports] load failed:', _lastError.message);
    } finally {
      _loading = false;
      publish();
    }
  }

  /** Apply the option filter and paint. */
  /**
   * Repaint from the rows already in memory.
   *
   * The chip handlers are called by the panel, which does not then call
   * update() - and this layer sets updateInterval: 0, so nothing else will.
   * Marking the options dirty and waiting left the map on the old selection
   * until something else happened to trigger a refresh.
   */
  function repaintFromMemory() {
    if (!_loaded || !_packed) return false;
    applyFilter(_packed);
    return true;
  }

  function applyFilter(packed) {
    const { hazard, minHailIn, minWindKt, fromDate, toDate } = _options;
    // The ordinal is the row's index in the year file, so it survives filtering
    // and keeps entity ids unique.
    const rows = packed
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) =>
        matchesFilter(unpack(row, index), {
          hazard,
          minSize: hazard === 'hail' ? minHailIn : minWindKt,
          from: fromDate,
          to: toDate,
        }),
      );
    _visible = rows.map(({ row, index }) => unpack(row, index));
    indexOrdinalYears();
    _stats = {
      total: _visible.length,
      hail: _visible.filter((r) => r.hazard === 'hail').length,
      wind: _visible.filter((r) => r.hazard === 'wind').length,
      worst: worstFirst(_visible, hazard, 1)[0] || null,
      storms: _events.length,
    };
    render();
    publish();
    refreshComparison();
  }

  /**
   * Which years have reports carrying a storm ordinal at all.
   *
   * A snapshot built before the ordinal existed has none, and asking by ordinal
   * there returns nothing at all — an empty list is not a worse answer than the
   * day's reports, it is a wrong one. Recomputed per repaint because the visible
   * set is what any of this is asked about.
   */
  function indexOrdinalYears() {
    _ordinalYears = new Set();
    for (const report of _visible) {
      if (stormRefOf(report) >= 0) _ordinalYears.add(yearOf(report.date));
    }
  }

  /**
   * Whether the radar comparison can honestly be computed right now.
   *
   * One selected hail day, and nothing broader. The cross-reference joins
   * reports to radar cores cell by cell, and a window of "all dates" is 155,737
   * rows and a radar index for six years: it is a national aggregate wearing the
   * costume of a canvassing answer, and it is not what the panel line would
   * read as. A day is also the question the line is for — hail fell here, and
   * how much of it did nobody notice.
   */
  function comparisonEligible() {
    const { fromDate, toDate, hazard } = _options;
    if (!radarSource) return false;
    if (hazard !== 'hail') return false;
    if (!fromDate || fromDate !== toDate) return false;
    if (!_visible.length || !_packed) return false;
    return _visible.length <= COMPARISON_ROW_LIMIT;
  }

  /** What the current selection compares, or null when it compares nothing. */
  function comparisonKey() {
    if (!comparisonEligible()) return null;
    return [
      _options.fromDate,
      _options.hazard,
      _options.minHailIn,
      _visible.length,
      String(_eventBase.get(yearOf(_options.fromDate))),
    ].join('|');
  }

  /**
   * Re-run the radar comparison for the selected day, if there is one.
   *
   * Fire-and-forget: the panel line is additive and the layer is already
   * correct without it, so a radar source that is absent, slow, or broken must
   * never be able to fail a load or block a repaint. Every failure ends with no
   * comparison and the layer exactly as it was.
   */
  async function refreshComparison() {
    const key = comparisonKey();
    if (key === null) {
      _comparisonToken += 1;
      _comparison = null;
      _comparisonKey = null;
      return;
    }
    if (key === _comparisonKey) return;
    _comparisonKey = key;
    _comparison = null;
    const token = ++_comparisonToken;
    // The visible rows are already filtered by hazard, size bar and window, so
    // they are the whole population for this day. `ordinal` is the row's index
    // in the packed array, which is how the tuples are recovered for the join.
    const rows = _visible.map((r) => _packed[r.ordinal]);
    try {
      const cells = await radarCellsFor(yearsInWindow(), _request?.signal);
      // The window can move while radar is in flight; a stale split for a day
      // nobody is looking at is worse than no line at all.
      if (token !== _comparisonToken) return;
      _comparison = {
        day: _options.fromDate,
        ...summariseAgreement(crossReference(rows, cells)),
      };
    } catch (error) {
      if (error?.name === 'AbortError') return;
      // Logged rather than swallowed: silence here is how a wired-up radar
      // source ends up looking like an unwired one.
      console.warn(
        '[Storm Reports] radar cross-reference unavailable:',
        error?.message || error,
      );
      return;
    }
    publish();
  }

  /**
   * Ask the injected radar source for the window's cells, in whatever shape it
   * keeps them. Anything else is a Map of nothing, which reads as "no cores",
   * not as a failure — see the caveat in `normaliseRadarCells`.
   */
  async function radarCellsFor(years, signal) {
    const call = radarSource?.cellsFor || radarSource?.radarFor;
    if (typeof call !== 'function')
      throw new TypeError('radarSource needs a cellsFor(years, signal) method');
    return normaliseRadarCells(await call.call(radarSource, years, signal));
  }

  /**
   * Expand a packed row, reusing the loader's expansion.
   *
   * `ordinal` is the row's position in the year file. Nothing in the tuple is
   * guaranteed unique - two hail reports of the same size at the same point in
   * the same minute are ordinary, not rare - and Cesium rejects a duplicate id
   * and drops the whole rest of the collection. The loader's canonical key
   * cannot be used as an entity id for exactly that reason.
   *
   * @param {Array} row
   * @param {number} ordinal
   */
  /**
   * Hold a hail threshold to the floor. Sub-inch hail is not offered and cannot
   * arrive from a shared link either.
   * @param {number} inches
   * @returns {number}
   */
  function clampHailIn(inches) {
    if (!Number.isFinite(inches)) return HAIL_FLOOR_IN;
    return Math.max(HAIL_FLOOR_IN, inches);
  }

  function unpack(row, ordinal = 0) {
    const [
      date,
      minute,
      hazardCode,
      size,
      lat,
      lon,
      fips,
      state,
      county,
      loss,
      comment,
      sources,
      trace,
      stormRef,
    ] = row;
    return {
      date,
      ordinal,
      minute: minute < 0 ? null : minute,
      hazard: hazardCode === 0 ? 'hail' : 'wind',
      size: size || null,
      lat,
      lon,
      countyFips: fips || null,
      state: state || null,
      county: county || null,
      loss: loss || 0,
      comment: comment || null,
      sources: String(sources || '')
        .split(',')
        .filter(Boolean),
      trace: Boolean(trace),
      // Slot 13: the row's ordinal into its own year's storm events. Carried
      // here because it is the only thing that identifies a report's storm on
      // a day that carried more than one.
      stormRef: stormRefOf({ stormRef }),
    };
  }

  /**
   * The storm a report belongs to.
   *
   * By ordinal when the row has one, which is the only resolution that is
   * correct on a multi-storm day: a date matches every storm that day, and the
   * first of them is arbitrary. By date only as the fallback for a snapshot with
   * no ordinals, where the day's first storm is at least a storm that happened.
   *
   * @param {object} report
   * @returns {object|null}
   */
  function resolveStorm(report) {
    const ref = stormRefOf(report);
    if (ref >= 0) {
      const storm = _eventsByYear.get(yearOf(report?.date))?.[ref];
      // A storm cannot sit on another day than the report naming it, so this
      // catches a stale events file whose ordinals no longer line up. Guessing
      // there would put the wrong storm's narrative on the card.
      if (storm && storm.date === report.date) return storm;
      return null;
    }
    return _events.find((e) => e.date === report?.date) || null;
  }

  /**
   * A storm's own ordinal, or null when it cannot be addressed as one.
   * @param {object} storm
   * @returns {number|null}
   */
  function ordinalOf(storm) {
    const base = _eventBase.get(yearOf(storm?.date));
    if (base === undefined || base === null) return null;
    const ref = _events.indexOf(storm) - base;
    return ref >= 0 ? ref : null;
  }

  /** Paint the visible reports. */
  function render() {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    for (const report of _visible) {
      const band =
        report.hazard === 'hail'
          ? hailBand(report.size)
          : windBand(report.size);
      if (!band) continue;
      _dataSource.entities.add({
        // The row ordinal, not the coordinates: two reports of the same size at the
        // day are separate observations, and a data source keys on this.
        id: `storm-report-${report.date}-${report.ordinal}-${report.hazard}-${report.size}`,
        position: Cesium.Cartesian3.fromDegrees(report.lon, report.lat),
        point: {
          // Magnitude-scaled, then clamped in pixels: at 155,737 reports an
          // unclamped radius turns a national view into a solid sheet.
          pixelSize: Math.max(
            4,
            Math.min(
              20,
              Math.round(radiusMetres(report.size, report.hazard) / 320),
            ),
          ),
          color: Cesium.Color.fromCssColorString(band.color),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.0, 4.0e7, 0.35),
        },
        properties: report,
      });
    }
  }

  /**
   * Hand the worst reports to the world overlay as clickable cards.
   *
   * `setOverlayEntries` throws unless given an array of entries in its own
   * shape, and this call runs inside `init()`. Passing an object threw there,
   * which failed registration, and the only symptom was the manager's generic
   * "Could not enable the requested layer".
   */
  function publish(message = null) {
    // An explicit null clears a previous rejection; no argument leaves it.
    if (message !== undefined) _fieldMessage = message;
    if (!_viewer) return;
    _lastUpdate = Date.now();
    const entries = _enabled
      ? worstFirst(_visible, _options.hazard, OVERLAY_COHORT_LIMIT).map(
          (report) => {
            const band =
              report.hazard === 'hail'
                ? hailBand(report.size)
                : windBand(report.size);
            const position = Cesium.Cartesian3.fromDegrees(
              report.lon,
              report.lat,
            );
            return {
              id: `storm-report:${report.date}:${report.ordinal}`,
              position,
              cullPosition: position,
              color: band?.color || '#cccccc',
              title: `${magnitudeLabel(report)} — ${report.county || report.state || 'unknown place'}`,
              details: [
                report.county
                  ? `${report.county}, ${report.state}`
                  : report.state || '',
                report.date,
              ]
                .filter(Boolean)
                .join(' · '),
              caveat: band
                ? undefined
                : 'No measured magnitude on this report.',
            };
          },
        )
      : [];
    overlayHost.setEntries(STORM_REPORTS_ID, entries, {
      cohortLimit: OVERLAY_COHORT_LIMIT,
      collisionCapacity: 64,
      moving: false,
    });
    _stats = { ...(_stats || {}), visibleCount: _visible.length };
  }

  /**
   * The radar split for the selected day, as one line.
   *
   * Radar hail is a vertically-integrated estimate derived from reflectivity.
   * It is not a measurement of a stone, and putting it in the same sentence as
   * a reported size without saying so is how someone ends up driving after a
   * radar artefact. The caveat travels with the number.
   *
   * @returns {string|null}
   */
  function comparisonLine() {
    const split = _comparison;
    if (!split) return null;
    const parts = [
      `${split.both} confirmed`,
      `${split.radarOnly} unreported radar core${split.radarOnly === 1 ? '' : 's'}`,
    ];
    if (split.artefacts)
      parts.push(`${split.artefacts} of those cores read as artefacts`);
    parts.push(`${split.reportOnly} reported with no core`);
    return `radar ${parts.join(', ')} — an estimate, not a measured stone`;
  }

  /** One line describing what is on screen right now. */
  function panelInfo() {
    // A rejected date outranks everything: the person is still looking at the
    // previous selection and needs to know their typing did not take.
    if (_fieldMessage) return _fieldMessage;
    if (_lastError) return `Failed: ${_lastError.message}`;
    if (_loading) return 'Loading reports...';
    if (!_enabled) return '';
    const count = _visible.length.toLocaleString();
    const worst = _stats?.worst;
    const parts = [`${count} report${count === '1' ? '' : 's'}`];
    if (worst?.size != null) parts.push(`largest ${magnitudeLabel(worst)}`);
    if (_stats?.storms) parts.push(`${_stats.storms.toLocaleString()} storms`);
    // Read the options directly: getDateRange is an api method, and this
    // function sits outside the object literal that exposes it.
    const from = _options.fromDate;
    const to = _options.toDate;
    if (from) parts.push(from === to ? from : `${from} to ${to}`);
    const radar = comparisonLine();
    if (radar) parts.push(radar);
    return parts.join(' · ');
  }
  const api = {
    id: STORM_REPORTS_ID,
    // The panel reads `name`, `icon` and `source`; without them it renders
    // "undefined" next to the layer.
    name: 'Hail & Wind — Individual Reports',
    icon: '📍',
    source: STORM_SOURCE_BADGE,
    updateInterval: 0,

    init(viewer) {
      if (_viewer)
        throw new Error('Storm Reports layer is already initialized');
      _viewer = viewer;
      // Its own CustomDataSource, like every other layer. Writing into the
      // shared viewer.entities would have every entity cleared by whichever
      // layer rendered last.
      _dataSource = new Cesium.CustomDataSource(STORM_REPORTS_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(STORM_REPORTS_ID, false);
      publish();
    },

    /**
     * Lifecycle protocol: `enable` marks the layer on, `update` does the work
     * and reports whether the scene changed. Returning false from `update`
     * while enabled is what makes the manager reject the transition, so the
     * first enable has to genuinely render and say so.
     */
    enable() {
      if (_enabled) return;
      _enabled = true;
      _request = new AbortController();
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(STORM_REPORTS_ID, true);
      publish();
    },

    disable() {
      if (!_enabled) return;
      _enabled = false;
      _request?.abort();
      _request = null;
      _visible = [];
      _comparison = null;
      _comparisonKey = null;
      _comparisonToken += 1;
      _loaded = false;
      _optionsDirty = true;
      if (_dataSource) {
        _dataSource.show = false;
        _dataSource.entities.removeAll();
      }
      overlayHost.clearSource(STORM_REPORTS_ID);
      overlayHost.setVisible(STORM_REPORTS_ID, false);
      publish();
    },

    async update() {
      if (!_enabled) return false;
      if (_loaded && !_optionsDirty) return false;
      await reload();
      _loaded = true;
      _optionsDirty = false;
      // A failed load is still a state change — the layer is on, and its panel
      // says why. Returning false here would be swallowed as "could not enable".
      if (_lastError) return true;
      return _visible.length > 0 || _previouslyEmpty !== true;
    },

    /**
     * Durable options from the manager. Remembered rather than applied when no
     * data has loaded, and replayed on the next load.
     */
    setParams(params) {
      _pendingParams = { ...(_pendingParams || {}), ...params };
      if (_snapshot) {
        applyPendingParams();
        _optionsDirty = true;
      }
      publish();
    },

    /** Current option intent, which is what a share link encodes. */
    getParams() {
      return {
        ...STORM_REPORTS_DEFAULTS,
        ..._options,
        ...(_pendingParams || {}),
      };
    },

    /**
     * Set the exact window. A single day is `setDate('2026-08-10')`; the layer
     * compares the ISO string, so day granularity needs no separate code path.
     * @param {string|null} from `YYYY-MM-DD`, or null for the whole record.
     * @param {string|null} [to]
     */
    setDateRange(from, to = from) {
      _options = { ..._options, fromDate: from || null, toDate: to || null };
      _pendingParams = null;
      _fieldMessage = null;
      _optionsDirty = true;
      if (!repaintFromMemory()) {
        // Nothing in memory yet - the next update() picks this up.
        _loaded = false;
      }
      publish();
    },

    /** One exact day. */
    setDate(day) {
      this.setDateRange(day || null, day || null);
    },

    /** Clear the window back to the whole record. */
    clearDateRange() {
      _options = { ..._options, fromDate: null, toDate: null };
      _optionsDirty = true;
      if (!repaintFromMemory()) _loaded = false;
      publish();
    },

    /** The window currently in force. */
    getDateRange() {
      return { from: _options.fromDate || null, to: _options.toDate || null };
    },

    /**
     * Fly the camera to the selected day.
     *
     * Separate from setDate on purpose: filtering and moving are different
     * intentions, and a person checking three storms in a row does not want the
     * camera yanked away each time. GO is there when they do want to go.
     *
     * @returns {boolean} false when no single day is selected, or it has no reports
     */
    frameSelectedStorm() {
      const day = _options.fromDate;
      if (!day || _options.toDate !== day || !_viewer) return false;
      const reports = _visible.filter((r) => r.date === day);
      const frame = framingFor(reports);
      if (!frame) return false;
      _viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          frame.lon,
          frame.lat,
          frame.altitudeM,
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: 2,
      });
      return true;
    },

    /** Storm days in the snapshot, newest first, for a date picker. */
    getStormDays(limit = 400) {
      const days = stormDays(_snapshot || { days: {} });
      return limit ? days.slice(0, limit) : days;
    },
    /**
     * Layer-panel controls: the exact-date picker, the size threshold and the
     * hazard switch.
     *
     * The panel's contract is `{readout, chips, legend, info}` — not a bare
     * array. Returning an array meant every control was silently discarded and
     * the layer row rendered with nothing on it, because the panel reads
     * `controls.chips` and an array has none.
     *
     * `readout` stays falsy: truthy tells the panel to hide the chips entirely
     * and show a count instead, which is the opposite of what this layer is for.
     *
     * The date chips are the point of this layer. The aggregate layer can only
     * offer decades, because a decade is what it has; this one has a day, and a
     * control that stops at "2010 onward" would hide the one thing it can do
     * that the other cannot.
     */
    getRowControls() {
      const days = stormDays(_snapshot || { days: {} });
      const ready = Boolean(_snapshot);
      const selected = _options.fromDate;
      const chips = [
        // GO leads: it is the action the rest of the row serves.
        {
          id: 'storm-reports-go',
          label: 'GO',
          title: 'Fly the camera to the selected day',
          disabled: !ready || !selected || _options.toDate !== selected,
          active: false,
          onClick: () => self().frameSelectedStorm(),
        },
        {
          id: 'storm-reports-all',
          label: 'ALL DATES',
          title: 'Every storm day in the record',
          disabled: !ready,
          active: !selected,
          onClick: () => self().clearDateRange(),
        },
        // The most recent days, which is what a canvasser works from.
        ...days.slice(0, 12).map((day) => ({
          id: `storm-reports-${day.date}`,
          label: day.date,
          title: `${day.hail} hail and ${day.wind} wind reports`,
          disabled: !ready,
          active: selected === day.date,
          onClick: () => self().setDate(day.date),
        })),
        {
          id: 'storm-reports-hail-1',
          label: '1\u2033',
          title: 'Hail an inch or larger',
          active: _options.minHailIn <= 1,
          onClick: () => self().setMinHailIn(1),
        },
        {
          id: 'storm-reports-hail-15',
          label: '1.5\u2033',
          title: 'Hail likely to damage a shingle',
          active: _options.minHailIn === 1.5,
          onClick: () => self().setMinHailIn(1.5),
        },
        {
          id: 'storm-reports-hail-2',
          label: '2\u2033',
          title: 'Hail of two inches or more',
          active: _options.minHailIn === 2,
          onClick: () => self().setMinHailIn(2),
        },
        {
          id: 'storm-reports-hail-25',
          label: '2.5\u2033',
          title: 'Hail of two and a half inches or more',
          active: _options.minHailIn === 2.5,
          onClick: () => self().setMinHailIn(2.5),
        },
        {
          id: 'storm-reports-hail-3',
          label: '3\u2033',
          title: 'Hail of three inches or more - severe',
          active: _options.minHailIn >= 3,
          onClick: () => self().setMinHailIn(3),
        },
        {
          id: 'storm-reports-hail',
          label: 'HAIL',
          title: 'Show hail reports',
          active: _options.hazard === 'hail',
          onClick: () => self().setHazard('hail'),
        },
        {
          id: 'storm-reports-wind',
          label: 'WIND',
          title: 'Show wind reports',
          active: _options.hazard === 'wind',
          onClick: () => self().setHazard('wind'),
        },
      ];
      return {
        readout: false,
        chips,
        field: {
          id: 'storm-reports-date',
          value: _options.fromDate || '',
          placeholder: 'Type a date - 2026-08-11',
          ariaLabel: 'Filter the map to one storm date',
          onCommit(raw) {
            const parsed = parseStormDate(raw);
            if (!parsed) {
              // Nothing is worse than a storm view showing the wrong day. Say so
              // and leave the current selection alone.
              publish(`Could not read "${String(raw).trim()}" as a date`);
              return false;
            }
            self().setDate(parsed);
            return true;
          },
          onCancel() {
            publish();
          },
        },
        legend: HAIL_LEGEND.map((band) => ({
          label: band.label,
          color: band.color,
          blurb: band.title,
        })),
        info: panelInfo(),
      };
    },

    /** Threshold in inches. Persisted in tenths so the codec stays integral. */
    setMinHailIn(inches) {
      const floorred = clampHailIn(inches);
      _options = { ..._options, minHailIn: floorred };
      _pendingParams = {
        ...(_pendingParams || {}),
        minHailTenths: Math.round(floorred * 10),
      };
      _optionsDirty = true;
      repaintFromMemory();
      publish();
    },

    /** Switch which hazard the layer is showing. */
    setHazard(hazard) {
      _options = { ..._options, hazard: hazard === 'wind' ? 'wind' : 'hail' };
      _optionsDirty = true;
      repaintFromMemory();
      publish();
    },

    /** Every storm in the current window, for a picker. */
    getStorms() {
      return [..._events].sort((a, b) => (a.date < b.date ? 1 : -1));
    },

    /**
     * The radar-versus-report split for the selected day, or null.
     *
     * Null is the normal answer: no radar source injected, no single day
     * selected, the wind hazard, or a radar load that failed. The panel line
     * reads it; this is here so the numbers are reachable without scraping a
     * sentence.
     */
    getComparison() {
      return _comparison;
    },

    /**
     * The reports belonging to one storm.
     *
     * By ordinal within the storm's own year, which is what separates two storms
     * on the same day. Matching on date returned both storms' reports for either
     * storm, and a day like 2025-05-16 carried sixty-five.
     *
     * Where the snapshot has no ordinals at all, or this year's events do not
     * form one run in the list we were handed, it falls back to the day: every
     * report that day is at least a report that day, which is a wider answer
     * than the ordinal but never a narrower one.
     */
    getStormReports(stormId) {
      const storm = _events.find((e) => e.id === stormId);
      if (!storm) return [];
      const year = yearOf(storm.date);
      const ref = _ordinalYears.has(year) ? ordinalOf(storm) : null;
      const matched =
        ref === null
          ? _visible.filter((r) => r.date === storm.date)
          : _visible.filter(
              (r) => yearOf(r.date) === year && stormRefOf(r) === ref,
            );
      return matched.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    },

    /** The card a click opens. */
    describeReport(report) {
      const storm = resolveStorm(report);
      return {
        ...report,
        magnitude: magnitudeLabel(report),
        band:
          (report.hazard === 'hail' ? hailBand : windBand)(report.size)
            ?.label || null,
        storm: storm
          ? {
              id: storm.id,
              maxHailIn: storm.maxHailIn,
              maxWindKt: storm.maxWindKt,
              reportCount: storm.reportCount,
              narrative: storm.narrative,
              identitySource: storm.identitySource,
              // How this storm was found. `date` is the old snapshot's fallback
              // and is the day's first storm, which is the wrong one on a day
              // that carried two.
              resolvedBy: stormRefOf(report) >= 0 ? 'ordinal' : 'date',
            }
          : null,
      };
    },

    destroy() {
      _request?.abort();
      overlayHost.clearSource(STORM_REPORTS_ID);
      if (_dataSource && _viewer) _viewer.dataSources.remove(_dataSource);
      _dataSource = null;
      if (_instance === api) _instance = null;
      _viewer = null;
    },
  };
  _instance = api;
  return api;
}

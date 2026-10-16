/**
 * Storm Reports — individual hail and wind reports, not an aggregate surface.
 *
 * Where the hail/wind layer paints a blended score across 0.25-degree cells,
 * this draws the reports themselves: one point per observation, sized and
 * coloured by magnitude, filterable by date, county and size, isolatable to an
 * area, and clickable through to the storm it belonged to.
 *
 * That level is the one a canvasser works from, and it is only possible
 * because the snapshot keeps the day. The aggregate layer averages seventy
 * years; this answers "what fell, where, how big, and on what day".
 *
 * ISOLATION. Three axes, deliberately separate: the options (hazard, size and
 * window), the storm selection, and the area (`setIsolation`). Someone working
 * one storm day inside one state is using all three at once, so each is held in
 * its own state and applied from it, and clearing one never clears another.
 * "Inside" is answered by `data/isolation.js` and never here — see
 * {@link module:layers/stormReports/index.insideIsolation}.
 * @module layers/stormReports/index
 */

import {
  hailBand,
  HAIL_BANDS,
  isolationLine,
  magnitudeLabel,
  framingFor,
  matchesFilter,
  OUTLINE_CAVEAT,
  outlineRing,
  parseStormDate,
  radiusMetres,
  stormHeadline,
  stormPlaces,
  stormTimeRange,
  windBand,
  worstFirst,
} from './model.js';
import * as Cesium from 'cesium';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from '../../data/contextStore.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { areaContains, describeIsolation } from '../../data/isolation.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import {
  crossReference,
  indexRadarCells,
  summariseAgreement,
} from '../../data/stormCrossReference.js';
import { stormDays } from '../../data/stormReports.js';
import { STORM_SOURCE_BADGE } from '../../data/stormAttribution.js';

/** The layer id, and the token reserved for it in the layer-state ledger. */
export const STORM_REPORTS_ID = 'storm-reports';

/** How the panel and the shared context store name this layer. */
const LAYER_NAME = 'Hail & Wind — Individual Reports';

/**
 * How many reports carry a click context at once.
 *
 * A hard bound, not a sample. The snapshot holds 44,717 reports on the record
 * day alone; registering one context each would put a five-figure map in a
 * single-key Map, and `removeEntityContextsForLayer` is an O(total registered)
 * scan that nothing else in this app runs at above a few hundred. Forty is the
 * worst of the current filter - the cohort a person works down - so what is
 * registered is exactly the set worth clicking, and the rest of the map is
 * drawn but not interactive.
 */
export const STORM_CONTEXT_LIMIT = 40;

/**
 * Days offered by the storm list when no single day is selected.
 *
 * Twelve, because that is already how many day chips the row offers: the list
 * and the chips must not disagree about which days exist, and a longer list
 * would be a picker the chips cannot reach.
 */
export const STORM_LIST_DAYS = 12;

/** Stroke and wash for the approximate outline. */
const OUTLINE_COLOR = '#7fe6ed';

/** Verdict-cache entries. 0 is "not asked yet", so it has to mean nothing. */
const UNTESTED = 0;
const INSIDE = 1;
const OUTSIDE = 2;

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
 * @param {{source: object, overlayHost?: object, radarSource?: object,
 *          createInputHandler?: (canvas: object) => object}} deps
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
 * Is there a window to hang the shared context store on?
 *
 * The context store is a page singleton. The layer's own tests drive the whole
 * lifecycle with no DOM at all, and an unguarded registration would throw in
 * the middle of a repaint and take the repaint with it. Registration is
 * therefore best-effort: no window, no contexts, and nothing else changes.
 * @returns {boolean}
 */
function contextHostAvailable() {
  return typeof window !== 'undefined' && Boolean(window);
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
  createInputHandler,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Storm Reports layer requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('Storm Reports layer requires an overlay host');
  // Injectable for the same reason localAdsb's is: a ScreenSpaceEventHandler
  // cannot be driven without a real canvas, so without a seam the click path is
  // the one part of this layer that can only be reasoned about and never run.
  const makeInputHandler =
    typeof createInputHandler === 'function'
      ? createInputHandler
      : (canvas) => new Cesium.ScreenSpaceEventHandler(canvas);

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
  // The window selectStorm had to move, so clearing it can put it back.
  let _stormMovedWindow = null;
  // The window the slider owns, kept apart from the date filter.
  //
  // `fromDate`/`toDate` are what the map is filtered by, and a selected day
  // sets them equal. The slider needs the wider bracket the day sits inside,
  // or dragging it afterwards would have nowhere to go back to. Two pieces of
  // state for one control is the price of letting the slider be the window and
  // the chips be a point inside it.
  let _windowFrom = null;
  let _windowTo = null;
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
  let _firstStormByDate = null;
  let _firstStormByDateFrom = null;
  // The storm axis, kept beside the option axis rather than folded into it:
  // selecting a storm narrows what is DRAWN, and the storm's own record has to
  // stay reachable or the outline, the list and the card would all read from
  // the selection they are describing.
  let _scoped = [];
  // The ISOLATION axis, beside the option axis and the storm axis rather than
  // folded into either. A date window answers "which days" and a size floor
  // "how big"; an area answers "where", and the three are chosen independently —
  // a person canvassing one storm day inside one state is using all three, and
  // clearing one must never silently clear the others.
  let _isolation = null;
  let _inArea = [];
  // The inside/outside verdict per packed row, kept until the packed array or the
  // area changes. Tri-state, and filled in only for the rows the option filter let
  // through. See `isolationFlags` for what that buys.
  let _flags = null;
  let _flagsPacked = null;
  let _flagsArea = null;
  let _contextIds = new Set();
  let _selectedReportId = null;
  // The report under the pointer, or null. Cards are summoned rather than
  // scattered: at 44,717 reports an always-on card per report is an unreadable
  // sheet of text, and the colour bands are already drawn by the Cesium points,
  // so the cards were duplicating a mark that exists and adding words to it.
  let _hoveredReportId = null;
  let _outlineVisible = false;
  let _outlineEntity = null;
  let _rowControlsListener = null;
  let _clickHandler = null;
  let _moveHandler = null;

  /**
   * Repaint the panel row.
   *
   * The panel caches each row's controls and re-reads them only when a layer
   * calls the listener it handed to `setRowControlsListener`. Without one, a
   * selected storm changes the map and leaves the row describing the previous
   * state - which reads to the person using it as though the click missed.
   */
  function notifyRowControls() {
    _rowControlsListener?.();
  }

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

  /**
   * Repaint for a change on the STORM axis, not the option axis.
   *
   * Deliberately its own path. `repaintFromMemory` re-runs the hazard, size and
   * date filter, which is the wrong question when the click was a storm in the
   * list: the storm belongs to a day the filter has already accepted, and
   * re-deriving the window from `_options` would either throw the selection
   * away or leave it selecting nothing.
   *
   * @returns {boolean} False when nothing is in memory yet.
   */
  function applyStormSelection() {
    if (!_loaded || !_packed) return false;
    applyFilter(_packed, { narrowToStorm: true });
    return true;
  }

  /** Does the current date window contain this day? */
  /**
   * Whether the current date window already frames this day.
   *
   * An unbounded window (ALL DATES) deliberately counts as NOT framing it. The
   * map would then show one storm while the date field said "all dates", which
   * is the same silent mismatch that this layer has shipped three times over:
   * chips that render but do nothing, an id that resolves to nothing, a
   * caution that is set and never shown. Naming the day is also the honest
   * thing to do - a storm belongs to a date - and ALL DATES is always one
   * click away.
   */
  function windowContains(date) {
    if (!date) return false;
    const { fromDate, toDate } = _options;
    if (!fromDate && !toDate) return false;
    if (fromDate && date < fromDate) return false;
    if (toDate && date > toDate) return false;
    return true;
  }

  /**
   * The reports of a set that fall inside the isolation area.
   *
   * `areaContains` is the whole answer and this deliberately does not re-derive
   * it. Two point-in-polygon implementations in one app is two answers, and they
   * would drift at exactly the cases the data module documents (the antimeridian,
   * a hole in a unit's geometry). `areaContains` also rejects on the bounding box
   * before it walks a single vertex, which is the difference between a filter
   * change and a visible hitch — see the pre-reject note in data/isolation.js and
   * the layer test that counts the scans.
   *
   * With no area set, the set passes through untouched, so an un-isolated layer
   * pays nothing at all for the axis being there.
   *
   * @param {object[]} reports
   * @returns {object[]}
   */
  function insideIsolation(reports) {
    const flags = isolationFlags();
    if (!flags) return reports;
    const inside = [];
    for (const report of reports) {
      const { ordinal } = report;
      // `ordinal` is the row's index in the packed array `flags` was built for,
      // so this is the same row and not a similar one. An ordinal outside it is
      // a row this layer did not unpack, and it is not an inside one.
      if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= flags.length)
        continue;
      if (flags[ordinal] === UNTESTED) {
        const row = _packed[ordinal];
        // Slots 4 and 5 of the packed tuple, read the same way `unpack` reads
        // them. This is the one place that knows the layout; `unpack` owns the
        // rest, and a slot moving would break both rather than one silently.
        flags[ordinal] = areaContains(_isolation.area, row[4], row[5])
          ? INSIDE
          : OUTSIDE;
      }
      if (flags[ordinal] === INSIDE) inside.push(report);
    }
    return inside;
  }

  /**
   * The verdict cache for the current area, or null when there is none.
   *
   * One byte per packed row, tri-state and LAZY: a row is only ever tested when
   * the option filter actually lets it through, and never twice for the same
   * area. An isolation outlives the filter changes made under it, so without
   * this, picking a hail floor after isolating re-walks the geometry of every
   * row the floor has just removed — measured on the shipped six-year record at
   * 72 ms for Texas and 1.6 s for the whole country, per click.
   *
   * The packed array is replaced whenever a year is (re)loaded, and an area is
   * replaced when the isolation changes, so a stale verdict is never read: the
   * identity check IS the invalidation, and it is why a row that is no longer
   * in view does not hold a place in the array that could go stale behind it.
   *
   * @returns {Uint8Array|null} null when there is no area or nothing loaded
   */
  function isolationFlags() {
    const area = _isolation?.area;
    const packed = _packed;
    if (!area || !packed) return null;
    if (_flagsPacked !== packed || _flagsArea !== area || !_flags) {
      _flags = new Uint8Array(packed.length);
      _flagsPacked = packed;
      _flagsArea = area;
    }
    return _flags;
  }

  /**
   * The panel's one isolation line, or null when no area is set.
   *
   * Counted from whichever set is named, so a storm's card quotes its own
   * reports rather than the whole day's: with a storm selected the option-axis
   * total is a day's, and "12 of 40 reports inside Texas" beside a one-storm
   * view is a number about something the person is not looking at.
   *
   * @param {string} [subject] what the counts are of
   * @param {object[]} [reports] that set, or the whole option-axis set
   * @returns {string|null}
   */
  function isolationPanelLine(subject = 'reports', reports = null) {
    if (!_isolation) return null;
    const counted = reports || _scoped;
    // `_inArea` IS `insideIsolation(_scoped)`, so the unscoped case re-reads the
    // answer applyFilter already paid for instead of scanning the window again.
    const inside = reports ? insideIsolation(reports).length : _inArea.length;
    return isolationLine(_isolation.describe, {
      inside,
      total: counted.length,
      active: _isolation.active,
      subject,
    });
  }

  function applyFilter(packed, { narrowToStorm = true } = {}) {
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
    // The option axis alone: hazard, size, window. This is the set the storm
    // axis narrows, and the set every question about a storm is answered from.
    _scoped = rows.map(({ row, index }) => unpack(row, index));
    // The isolation axis, applied between the options and the storm selection.
    // `_scoped` is deliberately NOT narrowed here: a storm's own record stays
    // reachable whatever area is set, because the storm card describing a
    // selection must not be drawn from an empty set.
    //
    // The inside set is computed even while the axis is switched off, because
    // that is the number the panel needs to say what turning it on would do —
    // and because a switch whose filter quietly stops when you look away is
    // indistinguishable from a broken one. The filter itself is the `active`
    // gate below.
    _inArea = insideIsolation(_scoped);
    // A storm cannot outlive the window it belongs to. The date filter is the
    // OUTER axis - it is what decides which days exist - so a selection the
    // window no longer covers is dropped rather than left selecting nothing.
    dropStormOutsideWindow();
    const placed = isolationIsOn() ? _inArea : _scoped;
    _visible =
      narrowToStorm && _selectedStormId
        ? placed.filter((report) => stormIdFor(report) === _selectedStormId)
        : placed;
    indexOrdinalYears();
    _stats = {
      total: _visible.length,
      hail: _visible.filter((r) => r.hazard === 'hail').length,
      wind: _visible.filter((r) => r.hazard === 'wind').length,
      worst: worstFirst(_visible, hazard, 1)[0] || null,
      storms: _events.length,
      scopedTotal: _scoped.length,
      insideIsolation: _inArea.length,
    };
    render();
    publish();
    refreshComparison();
  }

  /** Forget a storm selection the date window has moved out from under. */
  function dropStormOutsideWindow() {
    if (!_selectedStormId) return;
    const storm = _events.find((event) => event.id === _selectedStormId);
    if (!storm || !windowContains(storm.date)) _selectedStormId = null;
  }

  /** The storm event currently selected, or null. */
  function selectedStorm() {
    if (!_selectedStormId) return null;
    return _events.find((event) => event.id === _selectedStormId) || null;
  }

  /**
   * The storm id a report belongs to, or null when it belongs to none.
   *
   * Ordinal first, exactly as `resolveStorm` reads it, and the same date
   * fallback for a snapshot with no ordinals. The fallback is memoised per
   * events load: it is a scan of the event list, and running it per report
   * would make a storm selection on a legacy snapshot quadratic.
   */
  function stormIdFor(report) {
    return resolveStorm(report)?.id ?? null;
  }

  /**
   * Which years have reports carrying a storm ordinal at all.
   *
   * A snapshot built before the ordinal existed has none, and asking by ordinal
   * there returns nothing at all — an empty list is not a worse answer than the
   * day's reports, it is a wrong one. Read from the option-filtered set rather
   * than the drawn one: selecting one storm must not make every other year look
   * like it has no ordinals.
   */
  function indexOrdinalYears() {
    _ordinalYears = new Set();
    for (const report of _scoped) {
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
    return firstStormOn(report?.date);
  }

  /**
   * The first storm event on a date, or null - the fallback for a snapshot whose
   * rows carry no ordinals.
   *
   * Memoised against the event list itself, so it is rebuilt only when the list
   * changes. `resolveStorm` reaches here per report, and an unindexed scan of
   * 44,717 events for each of 155,737 reports is the kind of thing that looks
   * like a hang.
   */
  function firstStormOn(date) {
    if (_firstStormByDateFrom !== _events) {
      _firstStormByDate = new Map();
      for (const event of _events) {
        if (event?.date && !_firstStormByDate.has(event.date))
          _firstStormByDate.set(event.date, event);
      }
      _firstStormByDateFrom = _events;
    }
    return _firstStormByDate.get(date) || null;
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

  /**
   * The reports belonging to one storm, worst first.
   *
   * By ordinal within the storm's own year, which is what separates two storms
   * on the same day. Matching on date returned both storms' reports for either
   * storm, and a day like 2025-05-16 carried sixty-five.
   *
   * Where the snapshot has no ordinals at all, or this year's events do not form
   * one run in the list we were handed, it falls back to the day: every report
   * that day is at least a report that day, which is a wider answer than the
   * ordinal but never a narrower one.
   *
   * Answered from the option-filtered set, NOT from what is currently drawn. The
   * storm axis narrows the map; it must not narrow the storm's own record, or
   * the outline for the selected storm would be framed on an empty set and
   * every other storm in the list would read as having no reports.
   *
   * @param {string} stormId
   * @returns {object[]}
   */
  function reportsForStorm(stormId) {
    const storm = _events.find((e) => e.id === stormId);
    if (!storm) return [];
    const year = yearOf(storm.date);
    const ref = _ordinalYears.has(year) ? ordinalOf(storm) : null;
    const matched =
      ref === null
        ? _scoped.filter((r) => r.date === storm.date)
        : _scoped.filter(
            (r) => yearOf(r.date) === year && stormRefOf(r) === ref,
          );
    return matched.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  }

  /**
   * The entity id for a report.
   *
   * The row ordinal, not the coordinates: two reports of the same size at the
   * day are separate observations, and a data source keys on this. It is also
   * the context-store id, so the map and the shared selection slot cannot drift
   * onto two different names for the same stone.
   */
  function entityIdFor(report) {
    return `storm-report-${report.date}-${report.ordinal}-${report.hazard}-${report.size}`;
  }

  /** Is the isolation axis currently narrowing the map? */
  function isolationIsOn() {
    return _isolation?.active === true;
  }

  /** Point radius in pixels: magnitude-scaled, then clamped. */
  function pixelSizeFor(report) {
    // At 155,737 reports an unclamped radius turns a national view into a
    // solid sheet.
    return Math.max(
      4,
      Math.min(20, Math.round(radiusMetres(report.size, report.hazard) / 320)),
    );
  }

  /** Paint the visible reports. */
  function render() {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    _outlineEntity = null;
    for (const report of _visible) {
      const band =
        report.hazard === 'hail'
          ? hailBand(report.size)
          : windBand(report.size);
      if (!band) continue;
      const entity = _dataSource.entities.add({
        id: entityIdFor(report),
        position: Cesium.Cartesian3.fromDegrees(report.lon, report.lat),
        point: {
          // Magnitude-scaled, then clamped in pixels: at 155,737 reports an
          // unclamped radius turns a national view into a solid sheet.
          pixelSize: pixelSizeFor(report),
          color: Cesium.Color.fromCssColorString(band.color),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.0, 4.0e7, 0.35),
        },
        properties: report,
      });
      if (entity) entity.gevLabelModel = labelModelFor(report, band);
    }
    renderOutline();
    syncEntityContexts();
  }

  /**
   * The label model a clicked report shows.
   *
   * Set on the entity BEFORE it is registered, because the tracked-readout
   * bridge republishes a selected entity's `gevLabelModel` and reads it from
   * there - registered without it, the selection is live but the readout card
   * renders empty.
   *
   * `selected` also means "inside the isolation" while an area is on. The
   * isolation already filtered the map down to exactly those reports, so there
   * is no second list to maintain and no new rendering path: whatever draws
   * `selected` for a clicked report draws it for an isolated one, and turning
   * the isolation off leaves the click selection as the only thing marking a
   * marker.
   *
   * @param {object} report
   * @param {object} band
   * @param {boolean} [selected] Defaults to whether this report is the selected
   *   one or falls inside the active isolation.
   */
  function labelModelFor(report, band, selected = undefined) {
    const isSelected =
      selected === undefined
        ? _selectedReportId === entityIdFor(report) || isolationIsOn()
        : selected;
    return {
      title: magnitudeLabel(report),
      details: [
        report.county
          ? `${report.county}, ${report.state || ''}`.trim()
          : report.state || 'unknown place',
        report.date,
      ]
        .filter(Boolean)
        .join(' · '),
      accent: band?.color || '#cccccc',
      cardStyle: 'tactical',
      selected: isSelected,
      leaderStyle: 'elbow',
      anchorRadiusPx: pixelSizeFor(report) / 2,
      anchorRadiusScale: null,
    };
  }

  /**
   * Draw the selected storm's approximate outline.
   *
   * A circle, not a boundary. NCEI publishes no storm polygons, so there is
   * nothing to trace: the radius is the furthest report from the centroid of
   * the ones in view, and the shape is therefore a bound on where people were
   * reporting rather than on where hail fell. It is off by default, and
   * whatever draws it says so.
   *
   * The polygon goes on this layer's own data source - never `viewer.entities`,
   * which whichever layer rendered last would clear - and never as an ellipse,
   * which nothing else in this app uses.
   */
  function renderOutline() {
    if (!_outlineVisible || !_selectedStormId || !_dataSource) return null;
    const frame = framingFor(reportsForStorm(_selectedStormId));
    if (!frame) return null;
    const ring = outlineRing(frame);
    // outlineRing drops non-finite points for the same reason hailwind's
    // polygonRings does: one NaN vertex makes the polygon's centre NaN and the
    // shape surfaces as "origin has a NaN component". Fewer than three points
    // left is not a shape at all.
    if (ring.length < 3) return null;
    const positions = ring.map((point) =>
      Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
    );
    _outlineEntity = _dataSource.entities.add(
      new Cesium.Entity({
        id: `storm-outline:${_selectedStormId}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material:
            Cesium.Color.fromCssColorString(OUTLINE_COLOR).withAlpha(0.12),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString(OUTLINE_COLOR),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      }),
    );
    return _outlineEntity;
  }

  /**
   * Publish click contexts for the worst reports currently in view, and drop
   * every context this layer holds that is not in that cohort.
   *
   * Bounded on purpose. The snapshot carries 44,717 reports on its record day,
   * and the store is a single Map that `removeEntityContextsForLayer` rescans
   * whole on every refresh - registering all of them would make each repaint
   * cost more than the repaint itself. The cohort is the worst
   * {@link STORM_CONTEXT_LIMIT} reports under the current filter, which is the
   * set a person would click through anyway; the rest stay drawn and stay
   * unclickable, and `retainIds` is what makes that bound hold rather than grow.
   */
  function syncEntityContexts() {
    _contextIds = new Set();
    if (!_enabled || !contextHostAvailable()) return;
    const cohort = worstFirst(_visible, _options.hazard, STORM_CONTEXT_LIMIT);
    for (const report of cohort) {
      const id = entityIdFor(report);
      const entity = _dataSource?.entities.getById(id);
      if (!entity) continue;
      const band =
        report.hazard === 'hail'
          ? hailBand(report.size)
          : windBand(report.size);
      entity.gevLabelModel = labelModelFor(report, band);
      const record = registerEntityContext(entity, {
        id,
        layerId: STORM_REPORTS_ID,
        label: `${magnitudeLabel(report)} — ${report.county || report.state || 'unknown place'}`,
        layerName: LAYER_NAME,
        source: STORM_SOURCE_BADGE,
        latitude: report.lat,
        longitude: report.lon,
        // Without this the store cannot tell a live record from one whose
        // data source has been hidden, and a report from a switched-off layer
        // stays selectable.
        dataSource: _dataSource,
        properties: {
          date: report.date,
          minute: report.minute,
          hazard: report.hazard,
          size: report.size,
          county: report.county,
          state: report.state,
          countyFips: report.countyFips,
          loss: report.loss,
          sources: report.sources,
          trace: report.trace,
          ordinal: report.ordinal,
          band: band?.label || null,
          stormId: stormIdFor(report),
        },
      });
      if (record) _contextIds.add(id);
    }
    removeEntityContextsForLayer(STORM_REPORTS_ID, {
      retainIds: _contextIds,
    });
  }

  /**
   * Drop every context this layer owns, and any selection that pointed at one.
   *
   * Called from disable and destroy. A record left behind points at an entity
   * that no longer exists, and the shared selection slot would keep serving it
   * to voice and the cockpit until something else happened to overwrite it.
   */
  function releaseEntityContexts() {
    _contextIds = new Set();
    _selectedReportId = null;
    if (!contextHostAvailable()) return;
    clearSelectedEntityContextForLayer(STORM_REPORTS_ID);
    removeEntityContextsForLayer(STORM_REPORTS_ID);
  }

  /**
   * Select a clicked report into the shared context slot.
   * @param {string} entityId
   * @returns {boolean}
   */
  function selectReportContext(entityId) {
    const entity = _dataSource?.entities.getById(entityId);
    if (!entity) return false;
    _selectedReportId = entityId;
    selectEntityContext(entity);
    publish();
    notifyRowControls();
    return true;
  }

  /** Release the shared selection, if it was ours. */
  function clearReportContext() {
    if (!_selectedReportId) return;
    _selectedReportId = null;
    if (contextHostAvailable())
      clearSelectedEntityContextForLayer(STORM_REPORTS_ID);
    publish();
    notifyRowControls();
  }

  /**
   * Take the click, when the pointer is ours to take.
   *
   * A tool that has claimed the pointer (src/data/inputOwnership.js) gets the
   * click instead, and empty map releases only this layer's selection - never
   * a sibling layer's.
   */
  function installInteraction() {
    if (_clickHandler || !_viewer?.scene?.canvas) return;
    _clickHandler = makeInputHandler(_viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!isPointerFree() || !_enabled) return;
      const picked = _viewer.scene.pick?.(click.position);
      const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
      if (id && _contextIds.has(id)) {
        // Re-selecting the same report still counts as a click: its card may
        // have been displaced, and a click must never read as a deselect.
        selectReportContext(id);
        return;
      }
      clearReportContext();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Hover summons a card. This is the same pick the click uses, against the
    // same Cesium points, so there is nothing to hit-test separately and no
    // second geometry to keep in sync with the markers.
    _moveHandler = makeInputHandler(_viewer.scene.canvas);
    _moveHandler.setInputAction((move) => {
      // Dismissal is gated differently from summoning. `isPointerFree()`
      // means another tool owns the pointer; that must stop us SUMMONING a
      // card, but it must never stop us taking one away, or a card summoned
      // before a tool took over could never be dismissed.
      const pickable = isPointerFree() && _enabled;
      if (!pickable && _hoveredReportId === null) return;
      const picked = pickable
        ? _viewer.scene.pick?.(move.endPosition)
        : undefined;
      const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
      // ANY report this layer drew is hoverable, not only the ones in the
      // tracked-readout cohort. `_contextIds` holds the worst
      // STORM_CONTEXT_LIMIT reports, so gating on it made hover a no-op for
      // all but forty of 44,717 on a busy day. `publish` builds a card from
      // the report object rather than from `gevLabelModel`, so it never
      // needed the cohort in the first place.
      const next = id && id.startsWith('storm-report-') ? id : null;
      if (next === _hoveredReportId) return;
      _hoveredReportId = next;
      publish();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  }

  function releaseInteraction() {
    _clickHandler?.destroy();
    _clickHandler = null;
    _moveHandler?.destroy();
    _moveHandler = null;
    // A summoned card must not outlive the pointer leaving the layer.
    if (_hoveredReportId) {
      _hoveredReportId = null;
      publish();
    }
  }

  /**
   * Hand the reports that deserve a card to the world overlay.
   *
   * `setOverlayEntries` throws unless given an array of entries in its own
   * shape, and this call runs inside `init()`. Passing an object threw there,
   * which failed registration, and the only symptom was the manager's generic
   * "Could not enable the requested layer".
   *
   * WHY SO FEW ENTRIES. This used to publish the worst `OVERLAY_COHORT_LIMIT`
   * reports as cards, each titled "2.75 hail — Travis County". The colour bands
   * are already drawn by the Cesium points, and clicking already picks through
   * `scene.pick` against those same points, so the cards were duplicating a
   * mark that already existed while adding a line of text to every one. The
   * legend carries the band colours; a card is for the report someone is
   * actually pointing at.
   */
  function publish(message = null) {
    // An explicit null clears a previous rejection; no argument leaves it.
    if (message !== undefined) _fieldMessage = message;
    if (!_viewer) return;
    _lastUpdate = Date.now();
    // At most two cards: the one under the pointer, and the one someone
    // clicked. Hover wins when they are the same report, so a card is never
    // drawn twice. The colour bands stay on the Cesium points and in the
    // legend; a card is for the report someone is actually pointing at.
    const summoned = new Set(
      [_hoveredReportId, _selectedReportId].filter(Boolean),
    );
    const entries = _enabled
      ? _visible
          .filter((report) => summoned.has(entityIdFor(report)))
          .map((report) => {
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
              // `normalizeOverlayEntry` is an explicit field pick, not a
              // pass-through: `color` is not a field it reads - the band colour
              // goes in as `accent` - and `caveat` is not a field it has at
              // all. Both names are accepted here and dropped in silence, so
              // every card rendered in the default grey and the one message
              // that mattered never appeared.
              accent: band?.color || '#cccccc',
              title: `${magnitudeLabel(report)} — ${report.county || report.state || 'unknown place'}`,
              details: [
                report.county
                  ? `${report.county}, ${report.state}`
                  : report.state || '',
                report.date,
              ]
                .filter(Boolean)
                .join(' · '),
              // Opaque per-source extras travel in `metadata`.
              metadata: band
                ? null
                : { caveat: 'No measured magnitude on this report.' },
              // Same mark as the label model, for the same reason: inside an
              // active isolation, every card on offer is one of the inside
              // reports.
              selected:
                _selectedReportId === entityIdFor(report) || isolationIsOn(),
            };
          })
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
  /**
   * The radar line for the current day.
   *
   * It quotes ONLY the two figures an annual radar snapshot can honestly answer
   * about one day: how many of that day's reports sit in a cell that had a
   * core that year, and how many sit outside one.
   *
   * It deliberately does NOT quote the radar-only count. The snapshot is a
   * per-year climatology - peak millimetres, core points and a distinct-day
   * count per cell - so "a core with no report" enumerates every cell that ever
   * had hail that year. Against a 33-report day in a 14,850-cell year that
   * produced "14,832 unreported radar cores", which is not a finding about that
   * day, it is the year. A roofer would read it as a list of streets.
   *
   * The radar-only figure is still meaningful for the question it was built
   * for - canvassing across the whole record - and {@link getComparison} keeps
   * exposing it for that.
   */
  function comparisonLine() {
    const split = _comparison;
    if (!split) return null;
    // Report-weighted, not cell-weighted. A 0.25 degree cell is 25 miles across,
    // so eight reports in one county collapse into a single cell and quoting
    // the cell count would understate a day's reports several-fold.
    const compared = split.reportsCompared ?? 0;
    const withCore = split.reportsWithCore ?? 0;
    const parts = [
      `${withCore} of ${compared} report${compared === 1 ? '' : 's'} sat in a cell with a radar core in ${String(split.day).slice(0, 4)}`,
    ];
    if (split.reportsWithoutCore)
      parts.push(`${split.reportsWithoutCore} sat outside one`);
    if (split.artefacts)
      parts.push(`${split.artefacts} cells read as radar artefacts`);
    return (
      `radar ${parts.join(', ')} — an estimate, and an annual one: this is where ` +
      'hail was seen at some point that year, not on this day'
    );
  }

  /**
   * The panel lines for a selected storm.
   *
   * Its own numbers, not the day's. A day that carried two storms has one radar
   * split between them, and the count on screen is the storm's own reports under
   * the current filter - so the line has to name the storm it is describing, and
   * say so when the filter has left it with nothing.
   *
   * @returns {string[]}
   */
  function stormPanelLines(storm) {
    const reports = reportsForStorm(storm.id);
    const count = reports.length;
    const lines = [];
    const headline = stormHeadline(storm, count);
    lines.push(
      count
        ? `${storm.date} · storm · ${headline}`
        : `${storm.date} · storm · no reports at the current ${_options.hazard} and size filter`,
    );
    // The headline already carries the places, so only add the line when it
    // would say something the headline does not.
    const places = stormPlaces(storm);
    if (places && count && !headline.includes(places)) lines.push(places);
    const isolation = isolationPanelLine("this storm's reports", reports);
    if (isolation) lines.push(isolation);
    const window = stormTimeRange(storm);
    if (window) lines.push(`reported ${window}`);
    if (storm.narrative) lines.push(storm.narrative);
    const radar = comparisonLine();
    // The comparison is computed over whatever is in view, and in view means
    // this storm's reports - so the line says whose reports it is reading.
    if (radar) lines.push(_selectedStormId ? `${radar} (this storm)` : radar);
    if (_outlineVisible) lines.push(OUTLINE_CAVEAT);
    return lines;
  }

  /** One line describing what is on screen right now. */
  function panelInfo() {
    // A rejected date outranks everything: the person is still looking at the
    // previous selection and needs to know their typing did not take.
    if (_fieldMessage) return _fieldMessage;
    if (_lastError) return `Failed: ${_lastError.message}`;
    if (_loading) return 'Loading reports...';
    if (!_enabled) return '';
    const storm = selectedStorm();
    if (storm) return stormPanelLines(storm).join('\n');
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
    // Beside the dates on purpose: those two are the axes, and a person who
    // cannot tell which of them is in force is looking at a map they did not
    // ask for.
    const isolation = isolationPanelLine();
    if (isolation) parts.push(isolation);
    if (_outlineVisible) parts.push(OUTLINE_CAVEAT);
    const radar = comparisonLine();
    if (radar) parts.push(radar);
    return parts.join(' · ');
  }

  /**
   * The rows of the storm list.
   *
   * Exactly the seven properties `rowList` reads, plus the `onClick` the
   * panel's list handler calls. Scoped to the selected day when there is one,
   * because a storm belongs to a date and a list of every storm in the record is
   * not a list anyone can act on. With no day selected it offers the same
   * {@link STORM_LIST_DAYS} recent days the date chips already offer.
   *
   * @returns {Array<{id: string, lead: string, text: string, disabled: boolean,
   *                  active: boolean, current: boolean, onClick: Function}>}
   */
  /**
   * Every storm day in the snapshot, OLDEST first: the slider's axis.
   *
   * `stormDays` hands back newest-first, which is right for a "recent days"
   * list and backwards for a time axis - left would be the present and right
   * the past. Reversed here rather than at every call site.
   */
  function windowDays() {
    return stormDays(_snapshot || { days: {} })
      .map((entry) => entry.date)
      .sort();
  }

  /**
   * Bracket a day inside the slider's window.
   *
   * Picking a day that sits outside the current window drags the window to
   * contain it rather than being silently refused: the user asked for that day,
   * and a control that shrugs is the same failure this layer keeps having.
   */
  function bracketDay(day) {
    if (!day) return;
    const days = windowDays();
    if (!days.length) return;
    if (!_windowFrom) _windowFrom = days[0];
    if (!_windowTo) _windowTo = days.at(-1);
    if (day < _windowFrom) _windowFrom = day;
    if (day > _windowTo) _windowTo = day;
  }

  /** The slider's descriptor inputs, or null when there is nothing to slide. */
  function windowAxis() {
    const window_ = api.getWindow();
    if (!window_ || window_.days < 2) return null;
    return window_;
  }

  function stormListItems() {
    const day = _options.fromDate;
    const singleDay = Boolean(day) && day === _options.toDate;
    const recentDays = new Set(
      stormDays(_snapshot || { days: {} })
        .slice(0, STORM_LIST_DAYS)
        .map((entry) => entry.date),
    );
    const storms = _events
      .filter((storm) =>
        singleDay ? storm?.date === day : recentDays.has(storm?.date),
      )
      .sort((a, b) =>
        (a?.date || '') < (b?.date || '')
          ? 1
          : (a?.date || '') > (b?.date || '')
            ? -1
            : (a?.beginMinute ?? 0) - (b?.beginMinute ?? 0),
      );
    return storms.map((storm) => {
      // Counted against the option filter, not against what is drawn: with a
      // storm selected the map shows only that storm, and reading every other
      // list row out of it would mark the whole day disabled.
      const reports = reportsForStorm(storm.id);
      const selected = storm.id === _selectedStormId;
      return {
        id: `storm-list:${storm.id}`,
        lead: stormTimeRange(storm) || storm.date || '',
        text: stormHeadline(storm, reports.length),
        disabled: reports.length === 0,
        active: selected,
        current: selected,
        onClick: () => self().selectStorm(storm.id),
      };
    });
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
      // The click handler and the pick-ownership predicate come and go with the
      // layer: a handler left installed after disable would keep selecting
      // entities out of a data source that has been emptied.
      installInteraction();
      registerPickOwner(STORM_REPORTS_ID, (id) => _contextIds.has(id));
      publish();
    },

    disable() {
      if (!_enabled) return;
      _enabled = false;
      _request?.abort();
      _request = null;
      _visible = [];
      _scoped = [];
      _contextIds = new Set();
      _outlineEntity = null;
      _comparison = null;
      _comparisonKey = null;
      _comparisonToken += 1;
      _loaded = false;
      _optionsDirty = true;
      if (_dataSource) {
        _dataSource.show = false;
        _dataSource.entities.removeAll();
      }
      releaseInteraction();
      unregisterPickOwner(STORM_REPORTS_ID);
      releaseEntityContexts();
      overlayHost.clearSource(STORM_REPORTS_ID);
      overlayHost.setVisible(STORM_REPORTS_ID, false);
      publish();
      notifyRowControls();
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
      // Only the DATES are dropped from a pending parameter record, and only
      // because the person has just overridden them. The rest of a share link's
      // intent - minHailTenths, minWindKt, hazard - is still waiting for data
      // that has not loaded yet, and clearing the whole record meant opening a
      // shared two-inch wind link and then picking a day silently threw the
      // link's whole point away.
      if (_pendingParams) {
        const { fromDate: _from, toDate: _to, ...rest } = _pendingParams;
        _pendingParams = Object.keys(rest).length ? rest : null;
      }
      _fieldMessage = null;
      _optionsDirty = true;
      if (!repaintFromMemory()) {
        // Nothing in memory yet - the next update() picks this up.
        _loaded = false;
      }
      publish();
      notifyRowControls();
    },

    /** One exact day. */
    setDate(day) {
      this.setDateRange(day || null, day || null);
    },

    /** Clear the window back to the whole record. */
    clearDateRange() {
      _options = { ..._options, fromDate: null, toDate: null };
      // ALL DATES means the whole record, so the slider returns to full travel.
      _windowFrom = null;
      _windowTo = null;
      _optionsDirty = true;
      if (!repaintFromMemory()) _loaded = false;
      publish();
      notifyRowControls();
    },

    /**
     * Narrow the map to one storm, and put its numbers in the panel.
     *
     * AND THE DATE: a storm belongs to a date, so the date filter is the outer
     * axis - it decides which days exist at all - and a storm selected from a
     * wider window is moved to its own day rather than drawn against a filter
     * that no longer covers it. When the window already contains the storm the
     * date is left exactly as it is: someone working down a single day must not
     * have the window rewritten under them by each click, and someone working a
     * month must not be narrowed to one day by the first storm they pick.
     *
     * The hazard and size filters are never touched. Loosening a threshold
     * silently to make a selection look populated would change what "2 inches"
     * means everywhere else in the layer; an empty storm instead says so in the
     * panel.
     *
     * @param {string} stormId
     * @returns {boolean} False when no loaded storm carries that id.
     */
    selectStorm(stormId) {
      const storm = _events.find((event) => event.id === stormId);
      if (!storm) return false;
      _selectedStormId = stormId;
      if (!windowContains(storm.date)) {
        // Remember what the window was, so clearing the storm clears this too.
        // Otherwise selecting a storm from ALL DATES and then deselecting it
        // leaves the map on one day with nothing explaining why.
        _stormMovedWindow = {
          fromDate: _options.fromDate,
          toDate: _options.toDate,
        };
        _options = { ..._options, fromDate: storm.date, toDate: storm.date };
        _fieldMessage = null;
      }
      if (!applyStormSelection()) {
        // Nothing in memory yet - the next update() picks it up.
        _loaded = false;
        _optionsDirty = true;
      }
      publish();
      notifyRowControls();
      return true;
    },

    /** Drop the storm selection and show the whole window again. */
    clearStormSelection() {
      if (!_selectedStormId) return false;
      _selectedStormId = null;
      if (_stormMovedWindow) {
        _options = {
          ..._options,
          fromDate: _stormMovedWindow.fromDate,
          toDate: _stormMovedWindow.toDate,
        };
        _stormMovedWindow = null;
      }
      if (!applyStormSelection()) {
        _loaded = false;
        _optionsDirty = true;
      }
      publish();
      notifyRowControls();
      return true;
    },

    /** The storm currently narrowed to, or null. */
    getSelectedStorm() {
      return selectedStorm();
    },

    /** The storm id currently narrowed to, or null. */
    getSelectedStormId() {
      return _selectedStormId;
    },

    /** The context id of the clicked report, or null. */
    getSelectedReportId() {
      return _selectedReportId;
    },

    /**
     * What the layer is showing, for the panel row and for `getAll()`.
     *
     * The panel renders `—` when a layer publishes no stats, which is what a
     * loaded storm layer holding tens of thousands of reports was doing: it
     * had all of these numbers in `_stats` and no way to publish them. The
     * count is the NARROWED one - the reports actually on the map - because
     * that is what the row describes, and under an isolation it is the number
     * that changed.
     */
    getStats() {
      return {
        count: _stats?.total ?? 0,
        lastUpdate: _lastUpdate,
        error: _lastError?.message ?? null,
        loading: Boolean(_loading),
        hail: _stats?.hail ?? 0,
        wind: _stats?.wind ?? 0,
        storms: _stats?.storms ?? 0,
        scopedTotal: _stats?.scopedTotal ?? 0,
        insideIsolation: _stats?.insideIsolation ?? 0,
      };
    },

    /**
     * Point at a report, summoning its card. `null` sends the pointer away.
     *
     * Public rather than hover-only because the gesture is not the only way to
     * point at something: keyboard navigation and voice both want to summon
     * the same card without synthesising a mouse move.
     *
     * @param {string|null} id a `gev` context id, or null
     * @returns {boolean} whether the pointed-at report changed
     */
    setHoveredReportId(id) {
      // Trusted, not validated. The pointer handler has already checked
      // `_contextIds` before calling, and re-checking here would make the
      // setter depend on the tracked-readout registry, which is not what
      // "point at this report" should mean.
      const next = id ? String(id) : null;
      if (next === _hoveredReportId) return false;
      _hoveredReportId = next;
      publish();
      return true;
    },

    /**
     * Draw or hide the selected storm's approximate outline.
     *
     * Off by default: an inferred circle sitting on a map of measured points
     * invites being read as a measured edge, and this one has no better claim
     * than "people reported roughly this far apart". Whoever turns it on gets
     * the caveat in the legend and the info line, which is why it is offered as
     * an explicit choice rather than a side effect of selecting a storm.
     *
     * @param {boolean} visible
     * @returns {boolean} The state it ended in.
     */
    setOutlineVisible(visible) {
      _outlineVisible = visible !== false;
      render();
      publish();
      notifyRowControls();
      return _outlineVisible;
    },

    /** Whether the approximate outline is being drawn. */
    isOutlineVisible() {
      return _outlineVisible;
    },

    /**
     * Isolate the layer to an area: keep the reports that fall inside it, and
     * mark them as the ones that do.
     *
     * The shape is whatever `resolveIsolation` hands back in its `area` field —
     * `{kind, name, bbox, polygons, ring, areaKm2, …}` for a boundary, and the
     * same shape with `polygons: []` and a box around the point for a place.
     * The `{area}` wrapper is accepted too, because every caller that has just
     * resolved a name has that wrapper to hand and one shape accepted is one
     * shape that cannot be passed wrong.
     *
     * `null` clears the axis. It does NOT touch the date window: the two are
     * independent (see the axis note on `_isolation`), and clearing one because
     * the other changed is the bug this separation exists to prevent.
     *
     * @param {object|null} area
     * @returns {boolean} whether an area is set afterwards
     */
    setIsolation(area) {
      const unit = area && typeof area === 'object' ? area : null;
      _isolation = unit
        ? {
            area: unit,
            active: true,
            // Stated once, here, by the module that owns the wording: a place
            // must read as approximate everywhere it surfaces, not just on the
            // control that set it.
            describe: describeIsolation(unit),
          }
        : null;
      if (!repaintFromMemory()) {
        // Nothing in memory yet - the next update() picks this up.
        _loaded = false;
        _optionsDirty = true;
      }
      publish();
      notifyRowControls();
      return Boolean(_isolation);
    },

    /**
     * Turn the isolation filter on or off, keeping the area.
     *
     * Separate from `setIsolation(null)` on purpose: the chip is a switch for a
     * chosen area, so the off position has to remember what it was filtering to
     * or turning it back on becomes a re-resolve.
     *
     * @param {boolean} active
     * @returns {boolean} false when there is no area to isolate to
     */
    setIsolationActive(active) {
      if (!_isolation) return false;
      const on = active !== false;
      if (_isolation.active !== on) {
        _isolation = { ..._isolation, active: on };
        if (!repaintFromMemory()) {
          _loaded = false;
          _optionsDirty = true;
        }
      }
      publish();
      notifyRowControls();
      return on;
    },

    /**
     * The isolation in force, or null.
     *
     * `inside` of `total` is the option-axis population under the current date,
     * size and hazard filter — so the numbers answer "how much of what I am
     * looking at", which is the only question an isolation is asked.
     *
     * @returns {{area: object, active: boolean, describe: string,
     *            inside: number, total: number}|null}
     */
    getIsolation() {
      if (!_isolation) return null;
      return {
        area: _isolation.area,
        active: _isolation.active,
        describe: _isolation.describe,
        inside: _inArea.length,
        total: _scoped.length,
      };
    },

    /**
     * Repaint this row's controls when the layer's state changes.
     *
     * The panel caches each row's controls and re-reads them only through this
     * listener. A layer with none keeps rendering the controls it first
     * produced, so a selected storm or a clicked marker changes the map and
     * leaves the row describing the previous state.
     *
     * @param {Function|null} fn
     */
    setRowControlsListener(value) {
      _rowControlsListener = typeof value === 'function' ? value : null;
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
          id: 'storm-reports-clear-storm',
          label: 'CLEAR STORM',
          title: 'Show every report in the window again',
          disabled: !ready || !_selectedStormId,
          active: false,
          onClick: () => self().clearStormSelection(),
        },
        {
          id: 'storm-reports-outline',
          label: 'OUTLINE',
          // The title says what the shape is not, because that is the part
          // that would otherwise be assumed.
          title:
            'Approximate circle around the selected storm - inferred from where ' +
            'people reported, NOT a measured boundary',
          disabled: !ready || !_selectedStormId,
          active: _outlineVisible,
          onClick: () => self().setOutlineVisible(!_outlineVisible),
        },
        {
          id: 'storm-reports-isolate',
          label: 'ISOLATE',
          // Disabled rather than hidden when there is no area: an ISOLATE chip
          // that is always live and does nothing is worse than one that says it
          // has nothing to isolate to.
          title: _isolation
            ? isolationIsOn()
              ? `Stop filtering to ${_isolation.describe}`
              : `Filter to ${_isolation.describe}`
            : 'No area to isolate to - pick a place or a boundary first',
          disabled: !_isolation,
          active: isolationIsOn(),
          onClick: () => self().setIsolationActive(!isolationIsOn()),
        },
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
        // The slider is the window; the field and the day chips pick a point
        // inside it. `onInput` is deliberately absent: a drag must not trigger a
        // year fetch per pixel, so only the commit does any work.
        ...(windowAxis()
          ? {
              range: {
                id: 'storm-reports-window',
                min: 0,
                max: windowAxis().days - 1,
                step: 1,
                value: [windowAxis().from, windowAxis().to],
                ariaLabel: 'Storm day window',
                readout: `${windowAxis().fromDate} → ${windowAxis().toDate} · ${
                  windowAxis().to - windowAxis().from + 1
                } of ${windowAxis().days} storm days`,
                onCommit: (from, to) => api.setWindow(from, to),
              },
            }
          : {}),
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
        // The storm list, under the date field: the storms on the selected day,
        // or on the same recent days the date chips offer when no day is
        // chosen. A date with no storms in view yields no rows, and rowList
        // hides an empty list rather than rendering a shell.
        list: {
          items: stormListItems(),
          ariaLabel:
            selected && selected === _options.toDate
              ? `Storms on ${selected}`
              : `Storms on the ${STORM_LIST_DAYS} most recent storm days`,
        },
        legend: [
          ...HAIL_LEGEND.map((band) => ({
            label: band.label,
            color: band.color,
            blurb: band.title,
          })),
          // Only while it is drawn. A legend entry for a shape nobody can see
          // is noise, and this one needs its caveat wherever it is explained.
          ...(_outlineVisible
            ? [
                {
                  label: 'Storm outline (approximate)',
                  color: OUTLINE_COLOR,
                  blurb: OUTLINE_CAVEAT,
                },
              ]
            : []),
        ],
        info: panelInfo(),
      };
    },

    /**
     * Move the window the slider owns.
     *
     * Positions, not dates: the slider's axis is the snapshot's storm-day index,
     * so a position stays meaningful without the layer exposing its day list to
     * the panel.
     *
     * A year that has never been loaded costs one fetch on commit, which is
     * why `onInput` is a no-op here and only `onCommit` does the work. Dragging
     * is then free across years already in memory and expensive exactly once
     * per new one.
     *
     * @param {number} from Position of the window start.
     * @param {number} to Position of the window end.
     * @returns {boolean} whether the window changed
     */
    setWindow(from, to) {
      const days = windowDays();
      if (!days.length) return false;
      const lo = Math.max(0, Math.min(days.length - 1, Math.floor(from)));
      const hi = Math.max(0, Math.min(days.length - 1, Math.floor(to)));
      if (lo > hi) return false;
      const fromDate = days[lo];
      const toDate = days[hi];
      if (fromDate === _options.fromDate && toDate === _options.toDate)
        return false;
      _windowFrom = fromDate;
      _windowTo = toDate;
      // A day selected inside the old window is no longer in force; keeping it
      // would filter the map to something the window no longer contains.
      dropStormOutsideWindow();
      _selectedStormId = null;
      _options = { ..._options, fromDate, toDate };
      _fieldMessage = null;
      if (!repaintFromMemory()) {
        // A year not in memory yet: the next update() loads it.
        _loaded = false;
        _optionsDirty = true;
      }
      publish();
      notifyRowControls();
      return true;
    },

    /** The window the slider owns, as positions on its axis. */
    getWindow() {
      const days = windowDays();
      if (!days.length) return null;
      bracketDay(_options.fromDate);
      bracketDay(_options.toDate);
      const from = _windowFrom ? days.indexOf(_windowFrom) : 0;
      const to = _windowTo ? days.indexOf(_windowTo) : days.length - 1;
      return {
        from: from < 0 ? 0 : from,
        to: to < 0 ? days.length - 1 : to,
        days: days.length,
        fromDate: days[from < 0 ? 0 : from],
        toDate: days[to < 0 ? days.length - 1 : to],
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
      notifyRowControls();
    },

    /** Switch which hazard the layer is showing. */
    setHazard(hazard) {
      _options = { ..._options, hazard: hazard === 'wind' ? 'wind' : 'hail' };
      _optionsDirty = true;
      repaintFromMemory();
      publish();
      notifyRowControls();
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
     * The reports belonging to one storm, worst first. See
     * {@link module:layers/stormReports/index.reportsForStorm}.
     */
    getStormReports(stormId) {
      return reportsForStorm(stormId);
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
      releaseInteraction();
      unregisterPickOwner(STORM_REPORTS_ID);
      // Same teardown as disable: a context record left pointing at an entity
      // this layer has just removed keeps being served to voice and the cockpit
      // as though it were still on the map.
      releaseEntityContexts();
      _rowControlsListener = null;
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

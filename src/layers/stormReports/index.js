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
  GRID_DEG_FINE,
  GRID_DEG_MID,
  downsampleMaxCells,
  HAIL_BANDS,
  gridCellRings,
  hailBand,
  isolationLine,
  magnitudeLabel,
  framingFor,
  matchesFilter,
  OUTLINE_CAVEAT,
  outlineRing,
  parseStormDate,
  radarSwathCells,
  radiusMetres,
  PROSPECT_BANDS,
  PROSPECT_MM_FLOOR,
  PROSPECT_RADIUS_KM,
  CONTOUR_CAVEAT,
  contourRings,
  gridAreaKm2,
  prospectSwathCells,
  reportedSwathCells,
  ringsToDegrees,
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
  GRID_DEG,
  indexRadarDays,
  RADAR_IMPLAUSIBLE_MM,
  summariseAgreement,
} from '../../data/stormCrossReference.js';
import { radarDateFromDayIndex } from '../../data/stormDatasets.js';
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
/**
 * The most markers this layer will draw at once.
 *
 * Measured on the app's own floor - Google Photorealistic 3D Tiles on
 * SwiftShader software GL, which renders at about 4 fps with NOTHING of ours
 * enabled - the scene runs 2.6 fps with all 44,720 reports drawn and 3.5 fps
 * with this layer off. So the markers roughly halve an already-slow frame, and
 * every one is a Cesium Entity carrying `disableDepthTestDistance: INFINITY`,
 * which means none of them can be occluded or rejected by an early-Z test.
 *
 * `worstFirst` already answers "which of these matter most", so the cap takes
 * the worst of the current filter rather than the first few. Every report still
 * counts: the filter, the totals, the storm list, the radar comparison and the
 * isolation maths all read `_visible`, which is untouched. Only the DRAWN
 * markers are bounded, and the panel says so when they are.
 */
const STORM_MAX_MARKERS = 2000;

const OVERLAY_COHORT_LIMIT = 2;

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
 * Tessellation coarseness for the swath rectangles, in radians.
 *
 * Cesium's default is one degree. A rectangle with an UNDEFINED height is
 * routed to the ground-classified path, which extrudes it into a shadow volume
 * spanning the global approximate terrain range and runs a stencil pass with no
 * early-Z: measured for Denver, 66,067 vertices for a flat wash. A DEFINED
 * height keeps it an ordinary depth-tested primitive, and five-degree
 * granularity takes what remains from that to 2,851. Deliberately not coarser:
 * Cesium's ground path grows the shadow volume with the granularity, so past
 * roughly five degrees a coarser grid starts costing more than it saves.
 * @see module:layers/isolation/index for the measurement behind this number.
 */
const SWATH_GRANULARITY = Cesium.Math.toRadians(5);

/**
 * Swath opacity, as a RAMP across the band scale rather than one flat value.
 *
 * The old swaths painted every cell at a flat 0.34, which made a fringe cell
 * carrying a barely-measured stone look exactly as strong as a core — the wash
 * then carried no ranking at all, and "where is the worst" was a question only
 * the panel could answer. Still a wash rather than a wall at the top of the
 * range: the pins stay legible over it, and pins-on-top is the HailMaps model.
 * The measured floor for "reads as a deliberate mark" is mean ΔE 8
 * (`npm run qa:storm-swath`); the old flat fill measured 21, so legibility was
 * never the failure — SHAPE was.
 */
const SWATH_ALPHA_MIN = 0.3;
const SWATH_ALPHA_MAX = 0.72;

/**
 * The same ceiling, at full regional altitude. The wash has to stay dominant
 * when the camera is high enough that a cell is well under a pixel, so the top
 * of the ramp eases off rather than staying pinned. Interpolated, not stepped,
 * so a slow zoom does not snap.
 */
const SWATH_ALPHA_MAX_FAR = 0.52;

/**
 * Camera altitude, in metres, at which the fine 1km field stops being drawn.
 *
 * Above this the radar swath drops to the 0.25-degree field. That is what the
 * 0.25-degree field is FOR, and the measurement says why: at 1.7km over the
 * densest part of Colorado 2026-06-01 the fine field covered 99.94% of the
 * frame with 2,153 polygons merging into one flat wash, because at that scale
 * the cell edges are sub-pixel and same-band polygons stack. The fine field
 * earns its keep at roof level, where a cell is about the size of a block.
 *
 * One constant, and deliberately so: a display choice, not a data one. Set it
 * very high and the fine field is used everywhere, flat wash and all.
 */
const SWATH_FINE_MAX_ALTITUDE_M = 60_000;

/**
 * The altitude at which the 1 km field stops being drawn.
 *
 * It was 12 km, which is the height at which a 1 km cell is about the size of
 * a block - and below that the 1 km field is worth every polygon it costs.
 * But it also meant that from 12 km to 600 km the wash was drawn from the
 * 0.25 degree field, and a 0.25 degree cell is 27.8 km. At 100 km of
 * altitude that is a quarter of the frame, so the storm read as a grid of
 * squares - and the altitudes where a person decides "did this hit my
 * county" are exactly the ones in that gap.
 *
 * So there are THREE tiers now: the 1 km field to 60 km, a 5 km MID field
 * built by pooling the 1 km one, to 600 km, and the 0.25 degree field above
 * that.
 */
const SWATH_MID_MAX_ALTITUDE_M = 600_000;

/** Altitude at which the alpha ceiling is fully eased off, metres. */
const SWATH_ALPHA_FAR_ALTITUDE_M = 600_000;

/** Opacity of a band's hard edge, against the fill it outlines. */
const SWATH_EDGE_ALPHA = 0.95;

/**
 * Ceiling on ground-clamped swath polygons in one draw.
 *
 * Measured, not guessed: sweeping all 1,019 fine shards gives a MEDIAN of 242
 * rings, a mean of 423, and a maximum of 2,592 (2026-07-05, 52,202 cells). Only
 * three days exceed 2,000 and none exceed 3,000. So this cap sits above the
 * measured worst case and does not fire in practice — it bounds an unmeasured
 * future, it is not a quality dial.
 *
 * It matters because each of these is a ground-classified shape carrying a
 * shadow volume over the global approximate terrain range. When it does bite,
 * it drops the WEAKEST band first, because bands are visited weakest-first and
 * a fringe band is where a roofer is not going.
 */
const SWATH_MAX_RINGS = 3000;

/**
 * The RADAR swath's millimetre-to-colour ramp.
 *
 * Radar cells carry no band of their own — the REPORTED cells inherit one from
 * the measured stone, and a millimetre reading is not on the inch chart — so
 * the ramp lives here. Descending thresholds so the first match is the worst.
 */
/**
 * The product's hail floor, in millimetres. One inch, exactly.
 *
 * This is a DISPLAY floor, not a storage one. The artifacts deliberately keep
 * everything down to 19 mm (fine) and 10 mm (coarse) because deleting measured
 * radar to tidy a colour ramp is a bad trade, and the coarsest data predates
 * this decision. So cells below an inch still exist, and the only honest thing
 * this product can do with them is NOT paint them - see `radarColorFor` and
 * the swath band lookup, both of which return nothing rather than falling back
 * to the weakest band.
 */
const RADAR_FLOOR_MM = 25.4;

/**
 * The RADAR swath's millimetre-to-colour ramp: five stops, violet to white.
 *
 * WHY THIS LANE. The report PINS are green, amber, orange and red
 * (`model.js:107,115,122`) and PROSPECT is deliberately cold - blue and cyan,
 * because a gap in the reports must not read as worse hail
 * (`model.js:52-60`). The old ramp was amber, orange and red, which was
 * BYTE-IDENTICAL to three of the pin colours, so the wash and the dots lying
 * on it were the same hue and the wash vanished into the pins. Violet through
 * magenta to white is the only family left, and it reads as one storm with
 * internal structure rather than as a multi-colour heat map.
 *
 * WHY WHITE AT THE TOP. The core is the part a canvasser drives to, and it
 * has to be unmistakable over satellite imagery. White-hot reads as intensity
 * without reading as FIRE, which amber-to-red did.
 *
 * FIVE STOPS, NOT THREE. The bands are the same inch chart the report pins
 * use - 1", 1.5", 2", 2.75", 3.5" - so a pin and the wash it sits in are
 * measured on one scale. Hail Recon publishes ten levels, HailCheck six, DTN
 * contours in quarter-inch steps: everyone who draws a hail map for this
 * audience bands it finer than we did.
 *
 * Each stop carries the colour of the NEXT HOTTER band, and that colour is
 * what outlines it. Cesium's polygon outline is a fixed one-pixel hairline -
 * `outlineWidth` does not widen it - so the edge cannot be a width trick, and
 * a separate polyline entity would share the `storm-swath:` id prefix and
 * break every test that finds swaths by it. The hue carries the edge.
 */
const RADAR_RAMP_MM = Object.freeze([
  Object.freeze({
    min: 88.9,
    color: '#fdf4ff',
    outline: '#ffffff',
    label: '3.5"+',
  }),
  Object.freeze({
    min: 69.85,
    color: '#e879f9',
    outline: '#fdf4ff',
    label: '2.75-3.5"',
  }),
  Object.freeze({
    min: 50.8,
    color: '#c026d3',
    outline: '#e879f9',
    label: '2-2.75"',
  }),
  Object.freeze({
    min: 38.1,
    color: '#9333ea',
    outline: '#c026d3',
    label: '1.5-2"',
  }),
  Object.freeze({
    min: RADAR_FLOOR_MM,
    color: '#6d28d9',
    outline: '#9333ea',
    label: '1-1.5"',
  }),
]);

/**
 * The level each radar band is drawn at.
 *
 * Always the PRODUCT floor, never the band's own minimum: a 3.5" band is drawn
 * as the shape that reached an inch, with the hotter cells inside it carrying
 * the severity in their colour. Contouring at 88.9 mm would draw only the
 * softball core and leave the storm it belongs to invisible.
 */
const RADAR_CONTOUR_MM = RADAR_FLOOR_MM;

/** How an implausible radar reading is drawn: present, but not ranked. */
const RADAR_IMPLAUSIBLE_COLOR = '#8a8a8a';

/** How many impacted places the panel keeps, and how many it names inline. */
const IMPACTED_PLACES_LIMIT = 12;
const IMPACTED_PLACES_INLINE = 4;

/**
 * The colour a radar peak paints, the implausible grey, or null.
 *
 * Null is a real answer and the reason this is not a plain loop with a final
 * `return`: the stored field goes down to 19 mm, the product starts at 25.4 mm,
 * and a cell reading 22 mm is under the line the product claims to show. The
 * old fallback returned the weakest band's colour, so every sub-inch cell was
 * painted in the colour that MEANS "1 to 1.5 inches" - the map asserting a
 * size nobody inferred. Below the floor the correct output is no shape at all.
 * @returns {string|null}
 */
function radarColorFor(cell) {
  if (cell.implausible) return RADAR_IMPLAUSIBLE_COLOR;
  for (const step of RADAR_RAMP_MM)
    if (cell.peakMm >= step.min) return step.color;
  return null;
}

/**
 * Read a per-year radar payload into `Map<dayIndex, Map<'i:j', millimetres>>`.
 *
 * The loader's contract is exactly that map; a `{cells}` wrapper is accepted
 * too so a stub can wrap it without a second convention. An unrecognised shape
 * is an empty Map, which reads as "no radar that year" rather than as a
 * failure — the same safe default the year loaders take.
 *
 * @param {Map|{cells?: Map}|null} raw
 * @returns {Map<number, Map<string, number>>}
 */
function normaliseRadarDays(raw) {
  const out = new Map();
  const source = raw instanceof Map ? raw : raw?.cells;
  if (!(source instanceof Map)) return out;
  for (const [dayIndex, value] of source) {
    const cells = value instanceof Map ? value : value?.cells;
    if (cells instanceof Map) out.set(Number(dayIndex), cells);
  }
  return out;
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
 *   daysFor(year, signal) -> Promise<Map<dayIndex, Map<'i:j', millimetres>>>
 *
 * the per-day map {@link module:data/stormDatasets.radarDateFromDayIndex} reads
 * a day out of and {@link module:data/stormCrossReference.indexRadarDays} folds
 * into cells. It is asked one year at a time for the days inside the selected
 * window, so a range pays for the years it spans and never for the record.
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
  // How many markers the last render actually drew. Drawn <= visible, always.
  let _drawnCount = 0;
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
  // The radar read for the current window, keyed by the DAY it was read for.
  //
  // The per-day artifact is fetched one year at a time and the day is selected
  // out of it, so a memo keyed on the year alone would serve one day's cells
  // under another day's label — a stale number that looks like nothing at all.
  // `_radarKey` therefore carries the full window, and the day is the field
  // that has to be in it.
  let _radarWindowCells = null;
  let _radarKey = null;
  let _radarSwath = [];
  /** Set when a draw hit SWATH_MAX_RINGS, so the panel can say the wash is partial. */
  let _swathCapped = false;
  /**
   * The fine 1 km cells for the selected day, when the window is one day and
   * the shard existed. Null means the wash is being drawn from the coarse
   * 0.25-degree field, which is the multi-day case and any day outside the
   * retention window.
   */
  let _fineRadarCells = null;
  /** Whether the current wash came from the fine field. Read by the renderer. */
  let _radarFine = false;
  /**
   * The day's sub-daily frames, when the window is one day and the shard
   * existed. Each frame is the hail that was over the threshold in that six
   * hours, so the day can be replayed rather than only summarised.
   *
   * Null means there is no timeline: a multi-day window has no frames, and a
   * day outside the retention window has no shard.
   */
  let _subDailyFrames = null;
  /**
   * Which frame the timeline is showing, or null for the whole day.
   *
   * Null is the day's maximum, which is what the layer has always drawn. A
   * frame is a SUBSET of the day, so the day's numbers stay the honest
   * summary and the frame is the detail.
   */
  let _radarFrame = null;
  // The two swath toggles. REPORTED stays off until asked for: the pins are
  // what this layer shipped, and a reported wash is an added claim on top of
  // them.
  //
  // RADAR is ON BY DEFAULT, and that is a change of what the layer IS rather
  // than a preference. A layer called "Hail & Wind" whose default view is a
  // scatter of report pins and a choropleth of counties does not show the
  // hail: the radar swath is the actual storm, and somebody who turns the
  // layer on and sees no swath has learned nothing about the weather.
  //
  // CONDITIONALLY, though. With no radar source there is no swath to draw,
  // and the default must not claim one: `setRadarSwath(true)` refuses without
  // a source, and a default of `true` would put the layer in a state it
  // cannot leave.
  let _showReportedSwath = false;
  let _showRadarSwath = Boolean(radarSource);
  let _showProspectSwath = false;
  // The unclaimed cells for the current view, kept so the legend can put the
  // actual area and report count on screen. Recomputed by `renderSwaths`,
  // which is the one place that knows which radar tier is live.
  let _prospectCells = [];
  /**
   * Swath intent that arrived before it could be honoured.
   *
   * Both toggles refuse for real reasons - REPORTED needs the hail hazard, RADAR
   * needs a wired radar source - and a durable restore can arrive before either
   * is true. A refusal is not a contradiction of the intent, it is the intent
   * arriving too early, so it is kept here and replayed after the next load
   * rather than dropped. Dropping it is what made the map go empty on reload.
   */
  let _pendingSwath = null;
  /**
   * Which LOD tier the last draw used, so a zoom can be told from a no-op.
   *
   * The fine/coarse choice is a function of camera altitude, so without this the
   * layer would not redraw at all when only the altitude changed - the wash
   * would stay 1km after a zoom-out until something unrelated forced a repaint.
   */
  let _lodTier = null;
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

  /**
   * Apply a recorded swath intent, deferring whatever refuses.
   *
   * Goes through the public setters rather than assigning the flags, so the
   * refusal rules and the radar rebuild both still run. An assignment would
   * honour a WIND-hazard REPORTED intent that the chip is disabled for, and
   * would set the radar flag with no radar source to draw it.
   *
   * @param {{reportedSwath?: boolean, radarSwath?: boolean,
   *   prospectSwath?: boolean}|null} intent
   */
  function applySwathIntent(intent) {
    if (!intent) return;
    const deferred = {};
    for (const key of ['reportedSwath', 'radarSwath', 'prospectSwath']) {
      const want = intent[key];
      if (typeof want !== 'boolean') continue;
      const have =
        key === 'reportedSwath'
          ? _showReportedSwath
          : key === 'radarSwath'
            ? _showRadarSwath
            : _showProspectSwath;
      if (want === have) continue;
      const moved =
        key === 'reportedSwath'
          ? self().setReportedSwath(want)
          : key === 'radarSwath'
            ? self().setRadarSwath(want)
            : self().setProspectSwath(want);
      // Defer ONLY while data has not loaded. Before a load a refusal is
      // premature - the hazard and the source are not known yet. After one it is
      // final, and deferring it would replay forever: a RADAR intent on a build
      // with no radar source refuses every single load, for as long as the layer
      // lives.
      if (!moved && !_snapshot) deferred[key] = want;
    }
    _pendingSwath = Object.keys(deferred).length ? deferred : null;
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
      // Now that there is a hazard and a source, replay any swath intent that
      // arrived too early to be honoured. Without this the durable restore sets
      // a toggle before the data can support it, the toggle refuses, and the
      // map comes back empty - the exact silent emptying this is here to stop.
      applySwathIntent(_pendingSwath);
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
      // The impacted places, derived from the county/state every report carries.
      // Computed once per filter rather than per panel read: `_visible` is the
      // full filtered set, and walking it on every publish would repeat work for
      // a list that only moves with the filter itself.
      places: impactedPlaces(_visible, IMPACTED_PLACES_LIMIT),
    };
    render();
    publish();
    refreshRadar();
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

  /**
   * The key the radar read is memoised on.
   *
   * The DAY is the load-bearing field. The per-day artifact is fetched one year
   * at a time and the day selected out of it, so a memo keyed on the year — or
   * on the size floor and row count, which can be identical across two quiet
   * days — would render one day's cells under another day's label and the panel
   * would show a number that was true yesterday. The hazard and size floor
   * complete it, because each changes what is read.
   *
   * @returns {string|null} null when there is nothing to read radar for.
   */
  function radarRequestKey() {
    if (!radarSource) return null;
    if (_options.hazard !== 'hail') return null;
    if (!_options.fromDate) return null;
    return [
      _options.fromDate,
      _options.toDate,
      _options.minHailIn,
      _visible.length,
    ].join('|');
  }

  /**
   * What the radar line is a statement about, or null when it states nothing.
   *
   * The day is the field that must stay in the key: the comparison is re-run
   * only when this changes, so dropping the day would let a panel keep quoting
   * the previous day's split when two days carry the same number of reports.
   */
  function comparisonKey() {
    if (!comparisonEligible()) return null;
    return [
      _options.fromDate,
      _options.toDate,
      _options.hazard,
      _options.minHailIn,
      _visible.length,
      String(_eventBase.get(yearOf(_options.fromDate))),
    ].join('|');
  }

  /**
   * Derive the panel's comparison from the window's cells already in memory.
   *
   * Called only after a radar read lands, so `_radarWindowCells` is the day the
   * comparison names. Gated by {@link comparisonKey} rather than recomputed per
   * repaint: the panel line reads a sentence, and re-running the join on every
   * option change would be work for a number that did not move.
   */
  function computeComparison() {
    const key = comparisonKey();
    if (key === null || !_radarWindowCells) {
      _comparisonKey = key;
      _comparison = null;
      return;
    }
    if (key === _comparisonKey) return;
    _comparisonKey = key;
    // The visible rows are already filtered by hazard, size bar and window, so
    // they are the whole population for this day. `ordinal` is the row's index
    // in the packed array, which is how the tuples are recovered for the join.
    const rows = _visible.map((r) => _packed[r.ordinal]);
    const index = indexRadarDays(_radarWindowCells);
    _comparison = {
      day: _options.fromDate,
      ...summariseAgreement(crossReference(rows, index.cells)),
    };
  }

  /**
   * Read the selected window's radar and derive the line and the swath.
   *
   * Fire-and-forget: the panel line and the swath are additive and the layer is
   * already correct without them, so a radar source that is absent, slow, or
   * broken must never be able to fail a load or block a repaint. Every failure
   * ends with no radar and the layer exactly as it was.
   */
  async function refreshRadar() {
    const key = radarRequestKey();
    if (key === null) {
      _comparisonToken += 1;
      _comparison = null;
      _comparisonKey = null;
      _radarKey = null;
      _radarWindowCells = null;
      _radarSwath = [];
      // The fine cells belong to ONE day. Leaving them behind across a date
      // change is how a swath drawn for yesterday's storm stays on screen
      // tomorrow, which is the same class of bug as the HMR toggle reset this
      // layer already had one of.
      _fineRadarCells = null;
      _radarFine = false;
      return;
    }
    // Already read for this exact window and still in memory: a repaint from a
    // size or hazard change must not re-fetch a year.
    if (key === _radarKey && _radarWindowCells) {
      computeComparison();
      return;
    }
    _radarKey = key;
    _radarWindowCells = null;
    _radarSwath = [];
    _fineRadarCells = null;
    _radarFine = false;
    const token = ++_comparisonToken;
    try {
      // The sub-daily frames are loaded ALONGSIDE the coarse field rather
      // than after it, and both are applied under one token check. Loading
      // them after would let the window move between the two loads, and the
      // frames would be thrown away with the coarse cells they belong to -
      // which is exactly what happens when a person picks a storm day from a
      // list that is already loaded: the first refresh is still in flight when
      // the second starts.
      const day = _options.fromDate;
      const singleDay = day && day === _options.toDate;
      let frames = null;
      let framesFailed = false;
      const cells = await loadRadarWindow(_request?.signal);
      if (singleDay) {
        try {
          frames = await radarSubDailyDay(day, _request?.signal);
        } catch (error) {
          if (error?.name === 'AbortError') return;
          // A day with no sub-daily shard is an absence, not a failure: the
          // timeline simply is not offered for it.
          framesFailed = true;
        }
      }
      // The window can move while radar is in flight; a stale swath or split
      // for a day nobody is looking at is worse than nothing at all.
      if (token !== _comparisonToken) return;
      _radarWindowCells = cells;
      _subDailyFrames = framesFailed ? null : frames;
      // A frame that no longer exists must not survive the day changing
      // under it.
      if (
        _radarFrame !== null &&
        (!_subDailyFrames || _radarFrame >= _subDailyFrames.length)
      ) {
        _radarFrame = null;
      }
      // Banded whenever EITHER swath is on, not only for RADAR. Gating this on
      // the radar chip made PROSPECT depend on a different toggle being
      // enabled first: turn PROSPECT on alone and it found an empty banded
      // list, so it painted nothing and reported no leads at all - while
      // REPORTED and RADAR in the same build worked. Gating on "is anybody
      // going to read this" rather than "is RADAR on" is also why the read
      // stays free when neither chip is in use.
      _radarSwath =
        _showRadarSwath || _showProspectSwath ? swathCellsForWindow(cells) : [];
      computeComparison();
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
    render();
    publish();
    // The panel CACHES each row's controls and only re-reads them when the
    // layer says so. The sub-daily frames arrived with this load, so the row's
    // chips have changed - the timeline chips exist now - and without this
    // the panel keeps drawing the controls it read before the frames landed.
    notifyRowControls();
  }

  /**
   * The radar swath cells for the window, as one merged day.
   *
   * The window is the existing date-range slider, so "combine" is that same
   * control rather than a new one: a single day yields that day's cells, and a
   * range yields the per-cell maximum across every selected day — the
   * repeatedly-hit areas the category overlays dates to find. The merged map is
   * handed to the pure builder as one day so the model's own date guard still
   * applies.
   */
  /**
   * The fine 1 km cells as swath cells, through the SAME builder as the coarse
   * ones.
   *
   * Deliberately not a parallel banding path. `radarSwathCells` owns the
   * millimetre ramp, the implausible-reading filter and the severity sort, and
   * a second implementation of those three would drift from the first the first
   * time one of them is tuned. This only adapts the SHAPE — the loader hands
   * back an array of `{i, j, maxMm}`, the model wants a `Map<'i:j', mm>` — and
   * the `i:j` it builds is the FINE index, which is what makes the geometry 1 km
   * instead of 25 miles.
   *
   * @param {Array<{i: number, j: number, maxMm: number}>|null} cells
   * @returns {Array<object>} swath cells on the fine grid
   */
  /**
   * The six-hour frame chips, when the day has frames.
   *
   * The times are the hours each frame ENDS at, in UTC, because MRMS names a
   * file for the window ending at its timestamp and the shard for a day holds
   * the frames that tile the same 24 hours the daily field covers.
   *
   * @returns {Array<object>}
   */
  function frameChips() {
    if (!_subDailyFrames || !_subDailyFrames.length) return [];
    return _subDailyFrames.map((frame, index) => {
      // The hours each frame ENDS at: 06Z, 12Z, 18Z and 00Z. The shard for a
      // day holds the four frames that tile the same 24 hours the daily field
      // covers, and MRMS names a file for the window ENDING at its timestamp -
      // so the first three of them end on the previous calendar day.
      const hour = (6 + index * 6) % 24;
      const label = `${String(hour).padStart(2, '0')}Z`;
      return {
        id: `storm-reports-frame-${index}`,
        label,
        title:
          `The hail over the threshold in the six hours ending ${label}, ` +
          'in the 1 km field. A frame is a subset of the day.',
        active: _radarFrame === index,
        onClick: () => self().setRadarFrame(index),
      };
    });
  }

  function fineSwathCells(cells) {
    if (!Array.isArray(cells) || !cells.length) return [];
    const byKey = new Map();
    for (const cell of cells) {
      if (!Number.isInteger(cell?.i) || !Number.isInteger(cell?.j)) continue;
      if (
        !swathCellInIsolation(
          cellLat(cell.i, GRID_DEG_FINE),
          cellLon(cell.j, GRID_DEG_FINE),
        )
      )
        continue;
      byKey.set(`${cell.i}:${cell.j}`, cell.maxMm);
    }
    return radarSwathCells(
      { date: _options.fromDate, cells: byKey },
      { date: _options.fromDate, implausibleMm: RADAR_IMPLAUSIBLE_MM },
    );
  }

  /**
   * The fine cells to draw: the selected frame's, or the whole day's.
   *
   * A frame is a subset of the day, so falling back to the day's cells when
   * no frame is selected is the same answer with more in it.
   *
   * @returns {Array<{i: number, j: number, maxMm: number}>}
   */
  function frameRadarCells() {
    if (_radarFrame === null || !_subDailyFrames) return _fineRadarCells;
    return _subDailyFrames[_radarFrame] || [];
  }

  function swathCellsForWindow(cells) {
    return radarSwathCells(
      { date: _options.fromDate, cells: clipToIsolation(cells) },
      { date: _options.fromDate, implausibleMm: RADAR_IMPLAUSIBLE_MM },
    );
  }

  /**
   * A cell's centre in degrees.
   *
   * Half a step on from the corner, because that is where `gridCell` puts a
   * cell's centre and the clip has to agree with the geometry it is clipping.
   *
   * @param {number} index the cell index on its axis
   * @param {number} step the grid step in degrees
   * @returns {number}
   */
  function cellLat(index, step) {
    return index * step + step / 2;
  }

  /** A cell's centre longitude. See {@link cellLat}. */
  function cellLon(index, step) {
    return index * step + step / 2;
  }

  /**
   * Whether an isolation, if one is in force, contains this cell.
   *
   * The REPORTED swath never needed this: it is built from `_visible`, which
   * `applyFilter` has already narrowed to the isolated area. The RADAR swath is
   * built from the radar cells for the window and never passed through that
   * filter, so isolating Colorado used to filter the pins and leave the wash
   * spanning the whole country - the layer agreeing with itself about half its
   * marks.
   *
   * @param {number} lat
   * @param {number} lon
   * @returns {boolean}
   */
  function swathCellInIsolation(lat, lon) {
    if (!_isolation?.active) return true;
    // An area with no usable bbox cannot answer the question, and
    // `areaContains` answers "no" to everything in that case - which would clip
    // every cell and leave a blank map for an isolation that was never really
    // set. Refusing to clip is the safe direction: the wash covers more than it
    // should, which is recoverable, rather than disappearing.
    if (!isolationHasGeometry(_isolation.area)) return true;
    return areaContains(_isolation.area, lat, lon);
  }

  /**
   * Whether an isolation area carries enough shape to be tested against.
   *
   * @param {object|null} area
   * @returns {boolean}
   */
  function isolationHasGeometry(area) {
    const unit = area?.area ?? area;
    return Boolean(unit && Array.isArray(unit.bbox) && unit.bbox.length === 4);
  }

  /**
   * Narrow a `Map<'i:j', mm>` to the isolated area.
   *
   * @param {Map<string, number>|null|undefined} cells
   * @returns {Map<string, number>} the same map when nothing is isolated
   */
  function clipToIsolation(cells) {
    if (!cells || !_isolation?.active) return cells;
    const inside = new Map();
    for (const [key, mm] of cells) {
      const [i, j] = key.split(':').map(Number);
      if (!Number.isFinite(i) || !Number.isFinite(j)) continue;
      // The cell CENTRE, which is half a step on from the corner. `gridCell`
      // places a cell at `i * GRID_DEG + GRID_DEG / 2`; testing `i * GRID_DEG`
      // instead is half a cell out, and at the border that is exactly enough to
      // let a cell whose centre is in Wyoming draw. Colorado's northern edge is
      // 41.00, and this is how a cell spanning 41.00-41.25 survived the clip.
      if (swathCellInIsolation(cellLat(i, GRID_DEG), cellLon(j, GRID_DEG)))
        inside.set(key, mm);
    }
    return inside;
  }

  /**
   * Ask the injected radar source for one year of per-day cells.
   *
   * The source offers `daysFor(year, signal)`, the loader's
   * `Map<dayIndex, Map<'i:j', millimetres>>`. Anything unrecognised is an empty
   * map, which reads as "no radar that year", not as a failure.
   */
  /**
   * The FINE 1 km field for one day, or null when the source has none.
   *
   * A sibling of {@link radarDaysForYear} with its own optional method on the
   * injected source, so a layer constructed without one — every test that does
   * not care about fine detail, and the panel, which no longer ships the
   * payload — behaves exactly as before.
   */
  async function radarFineDay(date, signal) {
    const call = radarSource?.dayFor;
    if (typeof call !== 'function' || !date) return null;
    const raw = await call.call(radarSource, date, signal);
    // The loader returns `{cells: [{i, j, maxMm}]}`. Anything else is treated as
    // absent rather than half-believed, matching `normaliseRadarDays`.
    if (!Array.isArray(raw?.cells)) return null;
    return raw.cells;
  }

  async function radarDaysForYear(year, signal) {
    const call = radarSource?.daysFor;
    if (typeof call !== 'function')
      throw new TypeError('radarSource needs a daysFor(year, signal) method');
    return normaliseRadarDays(await call.call(radarSource, year, signal));
  }

  /**
   * The sub-daily frames for one day, or null when the source has none.
   *
   * A sibling of {@link radarFineDay} with its own optional method on the
   * injected source, so a layer constructed without one behaves exactly as
   * before. The frames are the day's hail split into six-hourly pieces, which
   * is what lets the day be replayed instead of only summarised.
   *
   * @param {string} date
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array<Array<object>>|null>}
   */
  async function radarSubDailyDay(date, signal) {
    const call = radarSource?.subDayFor;
    if (typeof call !== 'function' || !date) return null;
    const raw = await call.call(radarSource, date, signal);
    if (!Array.isArray(raw?.frames) || !raw.frames.length) return null;
    return raw.frames;
  }

  /**
   * The selected window's radar cells, merged per cell.
   *
   * One year at a time, and only the days inside the window: the artifact is
   * per-year, and a cell is maxed across the days selected so a range overlays
   * rather than sums. The per-year payload holds every day of its year, so days
   * outside the window are dropped here rather than upstream.
   */
  async function loadRadarWindow(signal) {
    const from = _options.fromDate;
    const to = _options.toDate || from;
    const merged = new Map();

    // A SINGLE day prefers the fine 1 km field when there is one, because that
    // is the case where the detail is worth a fetch: the coarse path merges a
    // whole year to draw one date, and at 0.25 degrees the result is a flat
    // 25-mile colour block. A multi-day window stays coarse — combining dates is
    // the "which streets took it more than once" question, which is a regional
    // one, and it would otherwise mean a fetch per day in the range.
    //
    // On failure it falls through to the coarse path rather than rendering
    // nothing: a day outside the retention window has no shard by design.
    if (from === to) {
      try {
        const fine = await radarFineDay(from, signal);
        _fineRadarCells = fine && fine.length ? fine : null;
        _radarFine = Boolean(_fineRadarCells);
      } catch (error) {
        if (error?.name === 'AbortError') return merged;
        console.warn(
          '[Storm Reports] fine radar field unavailable, using the coarse one:',
          error?.message || error,
        );
        _fineRadarCells = null;
        _radarFine = false;
      }
    } else {
      _fineRadarCells = null;
      _radarFine = false;
    }

    // The coarse field is loaded whether or not there is a fine one, and this
    // used not to be true.
    //
    // The single-day path used to `return merged` as soon as the fine day
    // arrived, so `_radarWindowCells` held FINE `i:j` keys - 1 km indices - and
    // every consumer of that map read them as 0.25-degree indices. With the LOD
    // in place that stops being hypothetical: above the threshold the radar band
    // draws `_radarSwath`, which is built from exactly this map, so zooming out
    // produced a wash of 0.25-degree cells placed by 1 km indices. It still had
    // the right cell SIZE, which is why the QA that measured span passed it.
    //
    // Both fields are now loaded and kept apart: `merged` is always the coarse
    // map, and the fine day lives only in `_fineRadarCells`. The cost is one
    // year file - 0.7-1.0 MB, cached per year and shared by every day in it -
    // and the alternative is a wrong picture at altitude.
    for (const year of yearsInWindow()) {
      const days = await radarDaysForYear(year, signal);
      for (const [dayIndex, cells] of days) {
        const date = radarDateFromDayIndex(dayIndex);
        if (!date || date < from || date > to) continue;
        for (const [cellKey, mm] of cells) {
          const seen = merged.get(cellKey);
          if (seen === undefined || mm > seen) merged.set(cellKey, mm);
        }
      }
    }
    return merged;
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

  /**
   * The places the visible reports came from, worst-hit first.
   *
   * Built from the county and state every report already carries — no second
   * dataset, and no city table to join. A report with no county yields no row:
   * an "unknown place" row would put a name on the list the data does not
   * support, and the count it holds is the one number a canvasser reads.
   *
   * @param {object[]} reports
   * @param {number} [limit]
   * @returns {Array<{county: string, state: string, count: number}>}
   */
  /**
   * The prospecting view in numbers, because a colour with no count behind it
   * is a mood.
   *
   * Says the area AND the report count, because the two together are the only
   * way to read it honestly. A large area with a high report count is a storm
   * in a populated place; the same area with no reports is either empty
   * country or a reporting failure, and the view cannot tell those apart -
   * which is exactly why it is a lead and not a claim.
   * @returns {string}
   */
  function prospectReadout() {
    if (!_prospectCells.length) {
      return (
        'No radar cell at ' +
        PROSPECT_MM_FLOOR +
        ' mm or above is more than ' +
        PROSPECT_RADIUS_KM +
        ' km from a report of 1" or more'
      );
    }
    const stepDeg = radarCellsForTier().deg;
    const area = gridAreaKm2(_prospectCells, stepDeg);
    const claims = _visible.filter(
      (r) => r.hazard === 'hail' && r.size >= 1,
    ).length;
    const worst = _prospectCells[0]?.peakMm ?? 0;
    return (
      Math.round(area).toLocaleString() +
      ' sq km of radar at ' +
      PROSPECT_MM_FLOOR +
      ' mm or above (' +
      (PROSPECT_MM_FLOOR / 25.4).toFixed(1) +
      '") has no report of 1" or more within ' +
      PROSPECT_RADIUS_KM +
      ' km; ' +
      claims.toLocaleString() +
      (claims === 1 ? ' report ' : ' reports ') +
      'in view; worst unsuppressed reading ' +
      (worst / 25.4).toFixed(1) +
      '"'
    );
  }

  function impactedPlaces(reports, limit = IMPACTED_PLACES_LIMIT) {
    const byPlace = new Map();
    for (const report of reports || []) {
      const county = report?.county;
      if (!county) continue;
      const state = report?.state || '';
      const key = `${county}|${state}`;
      const row = byPlace.get(key);
      if (row) row.count += 1;
      else byPlace.set(key, { county, state, count: 1 });
    }
    return [...byPlace.values()]
      .sort((a, b) => b.count - a.count || (a.county < b.county ? -1 : 1))
      .slice(0, limit);
  }

  /** One line naming the worst-hit places, or null when none carries a county. */
  function impactedPlacesLine(places) {
    if (!places?.length) return null;
    return (
      'impacted: ' +
      places
        .slice(0, IMPACTED_PLACES_INLINE)
        .map(
          (place) =>
            `${place.county}${place.state ? ` ${place.state}` : ''} (${place.count})`,
        )
        .join(', ')
    );
  }

  /**
   * A swath ring set as a Cesium polygon on this layer's own data source.
   *
   * The recipe is `renderOutline`'s, deliberately: a clamped, outlined
   * `PolygonHierarchy` in this same data source, which is a shape already known
   * to render here. Holes come from the same place (`perimeters/index.js`), and
   * Phase F needs them.
   *
   * `CLAMP_TO_GROUND` was ruled OUT by an instruction in the plan ("height: 0
   * + granularity, NOT CLAMP_TO_GROUND") on the strength of a vertex count
   * measured on the ISOLATION layer — in the same breath as an instruction to
   * copy the hailwind pattern, which clamps. That instruction is superseded in
   * `docs/PER-DAY-RADAR-SWATHS.md` §6 D2; `addSwathBand` carries the
   * measurement that settles the placement.
   */
  function polygonHierarchyFor(ringSet) {
    const positions = ringSet.outer.map((point) =>
      Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
    );
    // Cesium turns a non-finite coordinate into a NaN vertex, and one NaN
    // vertex poisons the whole polygon's centroid. Three vertices is also not
    // a shape, so a degenerate ring is dropped rather than drawn.
    if (positions.length < 3) return null;
    const holes = (ringSet.holes || [])
      .filter((hole) => hole.length >= 3)
      .map((hole) =>
        hole.map((point) =>
          Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
        ),
      );
    return new Cesium.PolygonHierarchy(positions, holes);
  }

  /**
   * One swath ring as one clamped, outlined polygon entity.
   *
   * The polygon CLAMPS TO GROUND, and that is not a stylistic choice — it is
   * the difference between drawing and not drawing on the regime this app
   * ships in. The launcher's `pinokio/ENVIRONMENT` carries a CESIUM_ION_TOKEN,
   * so `google3d.js` takes the ion route, Photorealistic 3D Tiles load, and
   * `scene.js` sets `globe.show = false`: the ground is tiled geometry at real
   * elevation, and a polygon at `height: 0` sits on the ellipsoid UNDERNEATH
   * it. Measured on that regime, same cell, 23 km camera:
   *
   *     height 0              0 px      0.0%    invisible — the bug
   *     CLAMP_TO_GROUND  191,543 px     40.6%   drapes on the terrain
   *     altitude 300 m    376,909 px     75.1%   draws, but hangs in the air
   *     altitude 800 m    376,909 px     75.1%   ditto
   *
   * A fixed altitude also draws and covers MORE of the frame, but it floats
   * the wash above the ground, which is obvious at street zoom. Clamping is
   * the honest choice, and the smaller footprint is correct: only a draped
   * shape is partly hidden by terrain and buildings, which is what a ground
   * wash should do.
   *
   * This supersedes the `height: 0` decision that was in this file yesterday,
   * which was measured on a KEYLESS globe. That regime is reachable — this repo
   * has no `.env` — but it is not the one the launcher ships, and a footprint
   * measured there does not transfer. `npm run qa:storm-swath` prints which
   * regime it booted; read `report.regime` before quoting any figure.
   */
  function addSwathBand(
    id,
    hierarchy,
    color,
    alpha,
    outlineColor = color,
    outlineAlpha = SWATH_EDGE_ALPHA,
  ) {
    return _dataSource.entities.add(
      new Cesium.Entity({
        id,
        polygon: {
          hierarchy,
          material: Cesium.Color.fromCssColorString(color).withAlpha(alpha),
          // A hard edge is what separates one band from the next. Set
          // explicitly, and asserted in the lifecycle test: Cesium accepts the
          // property silently whether or not it draws anything. Whether it
          // strokes on ground-clamped geometry is still UNVERIFIED — the
          // harness reports the footprint either way.
          //
          // The edge is the NEXT HOTTER band's colour, not the fill's own.
          // A band that outlined itself in its own colour has no edge at all;
          // one that outlines in the hotter colour reads as a contour line
          // between two intensities, which is what it is.
          outline: true,
          outlineColor:
            Cesium.Color.fromCssColorString(outlineColor).withAlpha(
              outlineAlpha,
            ),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        properties: { swath: true, key: id },
      }),
    );
  }

  /**
   * Alpha for a band, ramping up with severity.
   *
   * The old swaths painted every cell at a flat `SWATH_ALPHA`, so a fringe cell
   * carrying a barely-measured stone looked exactly as strong as a core. A
   * roofer is reading the wash to decide where to drive, and that decision is
   * "where is the worst", so the worst band has to be the most opaque thing on
   * the map. Ranked on the band's position in its own scale, so the REPORTED
   * inch bands and the RADAR millimetre ramp each ramp over their own range.
   *
   * @param {number} rank 0 (weakest) .. 1 (worst)
   */
  function swathAlphaFor(rank) {
    const clamped = Math.min(Math.max(Number(rank) || 0, 0), 1);
    const ceiling = swathAlphaCeiling();
    return SWATH_ALPHA_MIN + (ceiling - SWATH_ALPHA_MIN) * clamped;
  }

  /**
   * The current camera altitude, in metres.
   *
   * `positionCartographic` reports latitude and longitude in RADIANS; `height`
   * is already metres, and is the only field read here.
   */
  function cameraAltitudeM() {
    return _viewer?.camera?.positionCartographic?.height ?? 0;
  }

  /**
   * The alpha ceiling at the camera's current altitude.
   *
   * Eased off toward {@link SWATH_ALPHA_MAX_FAR} as the camera climbs, so the
   * wash does not flatten the basemap at altitude. Linear between the two
   * anchors, which is crude but monotonic and has no knee to argue about.
   */
  function swathAlphaCeiling() {
    const altitude = cameraAltitudeM();
    if (!altitude || altitude <= SWATH_FINE_MAX_ALTITUDE_M)
      return SWATH_ALPHA_MAX;
    // The far anchor is the MID tier's ceiling, not the old 60 km one: the
    // alpha has to ease off across the whole range the wash is drawn at
    // altitude, and the range is now 60 km to 600 km.
    const span = SWATH_ALPHA_FAR_ALTITUDE_M - SWATH_FINE_MAX_ALTITUDE_M;
    const t =
      span > 0 ? Math.min((altitude - SWATH_FINE_MAX_ALTITUDE_M) / span, 1) : 1;
    return SWATH_ALPHA_MAX + (SWATH_ALPHA_MAX_FAR - SWATH_ALPHA_MAX) * t;
  }

  /**
   * Which grid the wash is drawn from: 'fine', 'mid' or 'coarse'.
   *
   * 'fine' is the 1 km field, 'mid' is the same field pooled into 5 km cells,
   * and 'coarse' is the published 0.25 degree field.
   *
   * A SELECTED FRAME is always drawn from the fine field, whatever the
   * altitude. The frames exist only at 1 km, and a scrubber that silently
   * stopped scrubbing when the camera climbed would be a control that lies.
   */
  function radarTier() {
    if (_radarFrame !== null && _subDailyFrames) return 'fine';
    if (!_radarFine) return 'coarse';
    const altitude = cameraAltitudeM();
    if (altitude <= SWATH_FINE_MAX_ALTITUDE_M) return 'fine';
    if (altitude <= SWATH_MID_MAX_ALTITUDE_M) return 'mid';
    return 'coarse';
  }

  /** Whether the camera is close enough for the fine 1km field to be worth drawing. */
  function useFineRadarField() {
    return radarTier() === 'fine';
  }

  /**
   * The radar cells and the grid step for the current tier.
   *
   * The MID tier is the 1 km field pooled into 5 km cells - the same hail at a
   * size that reads from a hundred kilometres up. It exists ONLY for a single
   * day: a multi-day window is drawn from the published 0.25 degree field, and
   * there is no 5 km version of that to pool.
   *
   * @returns {{cells: Array<object>, deg: number}}
   */
  function radarCellsForTier() {
    const tier = radarTier();
    if (tier === 'fine') {
      return { cells: fineSwathCells(frameRadarCells()), deg: GRID_DEG_FINE };
    }
    if (tier === 'mid') {
      const pooled = downsampleMaxCells(frameRadarCells(), 5);
      return { cells: fineSwathCells(pooled), deg: GRID_DEG_MID };
    }
    return { cells: _radarSwath, deg: GRID_DEG };
  }

  /**
   * Redraw only when the altitude has crossed the LOD boundary.
   *
   * `moveEnd`, not `changed`: a drag emits `changed` continuously and each of
   * those would rebuild thousands of polygons for a tier that has not actually
   * changed. A move that ends in the same tier does nothing.
   */
  function onCameraSettled() {
    const tier = radarTier();
    if (tier === _lodTier) return;
    _lodTier = tier;
    // `render()`, never `renderSwaths()`. The swath ids are derived from the
    // band and the ring index, so redrawing without first emptying the
    // collection re-adds ids that are already there and Cesium throws
    // DeveloperError on the first zoom that crosses the boundary - which is a
    // crash on a completely ordinary gesture.
    if (_showRadarSwath) render();
  }

  /**
   * Group swath cells by colour band, and draw each band as contiguous rings.
   *
   * One entity per RING, not per cell — that is the whole of Phase F. Measured
   * before the change: one translucent rectangle per 0.25-degree cell at a flat
   * alpha, which double-blended along every shared edge and read as a green
   * box rather than a storm.
   *
   * @param {string} kind 'reported' | 'radar', for the entity id and the tests.
   * @param {Array<object>} cells cells carrying `i`, `j` and a band.
   * @param {(cell: object) => {key: string, color: string, rank: number}|null} bandFor
   */
  /**
   * A ring's bounding box, for a cheap rejection before a point-in-ring test.
   *
   * @param {Array<{lat: number, lon: number}>} ring
   * @returns {{west: number, south: number, east: number, north: number}}
   */
  function ringBounds(ring) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const point of ring) {
      if (point.lon < west) west = point.lon;
      if (point.lon > east) east = point.lon;
      if (point.lat < south) south = point.lat;
      if (point.lat > north) north = point.lat;
    }
    return { west, south, east, north };
  }

  /**
   * Whether a point is inside a ring, in degrees.
   *
   * The same ray cast the model uses in grid space, in the degrees the
   * contours come back in. A ring here is a list of `{lat, lon}`.
   *
   * @param {{lat: number, lon: number}} point
   * @param {Array<{lat: number, lon: number}>} ring
   * @returns {boolean}
   */
  function pointInRingDegrees(point, ring) {
    let inside = false;
    for (
      let at = 0, prev = ring.length - 1;
      at < ring.length;
      prev = at, at += 1
    ) {
      const y0 = ring[prev].lat;
      const x0 = ring[prev].lon;
      const y1 = ring[at].lat;
      const x1 = ring[at].lon;
      if (y0 > point.lat !== y1 > point.lat) {
        const cross = ((x1 - x0) * (point.lat - y0)) / (y1 - y0) + x0;
        if (point.lon < cross) inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Draw a swath as a set of ANNULAR bands.
   *
   * WHY ANNULAR AND NOT ONE BAND AT A TIME. Every band used to be contoured
   * on its OWN cells, at the product floor. So the boundary between two bands
   * was interpolated twice - once for each band - at a different sub-cell
   * position, and the two edges sat up to four tenths of a cell apart. Four
   * tenths of a kilometre is four hundred metres of gap between two bands
   * that should share a line, filled with whatever was behind them.
   *
   * Here the WHOLE field is contoured once per level, and each band is the
   * region BETWEEN two levels: the lower level's ring, with the hotter level's
   * shape as a hole. The two bands then share ONE interpolated line - the
   * hotter level's contour - and they tile exactly.
   *
   * The cost is that a hot core is drawn once per level below it, as the hole
   * in each of them. It is hidden under the hotter band, so it costs a polygon
   * and not pixels.
   *
   * @param {string} kind 'reported' | 'radar' | 'prospect'
   * @param {Array<{i: number, j: number, v: number}>} cells the whole field
   * @param {Array<{key: string, color: string, rank: number, floor: number,
   *   outline?: string, outlineAlpha?: number}>} levels, ascending by floor
   * @param {number} deg the grid step, in degrees
   * @returns {number} how many entities were drawn
   */
  function drawSwathLevels(kind, cells, levels, deg) {
    const ordered = [...levels].sort((a, b) => a.floor - b.floor);
    // A cell that sits EXACTLY on a level must not disappear.
    //
    // A contour AT a cell's value passes through that cell's centre, so the
    // cell contributes no area and its ring is dropped as degenerate. Without
    // this, every cell reading exactly 25.4 mm - exactly the product floor -
    // would vanish from the map. The epsilon is a hundredth of a unit, which
    // is four hundred times smaller than the gap between two bands.
    const EPSILON = 0.01;
    const contours = ordered.map((level) =>
      contourRings(cells, level.floor - EPSILON, deg),
    );
    // A level with no cells in it is SKIPPED, and this is not an
    // optimisation. The band at a level is the region BETWEEN that level and
    // the next one up - the fringe, not the whole storm - so a level with no
    // cells in its range has an empty fringe, and drawing it would put a
    // polygon on the map that is nothing but the hole for the next band.
    //
    // It is also what keeps the entity count honest: a pair of 1.77 inch
    // cells is ONE polygon, not two, because the 1 inch level has no cells in
    // its range and is skipped rather than drawn as an empty ring.
    const counts = new Array(ordered.length).fill(0);
    for (const cell of cells) {
      const value = Number(cell?.v);
      if (!Number.isFinite(value)) continue;
      for (let k = 0; k < ordered.length; k += 1) {
        const floor = ordered[k].floor;
        const next = k + 1 < ordered.length ? ordered[k + 1].floor : Infinity;
        if (value >= floor && value < next) {
          counts[k] += 1;
          break;
        }
      }
    }
    let drawn = 0;
    for (let k = 0; k < ordered.length; k += 1) {
      const level = ordered[k];
      if (!counts[k]) continue;
      const hotter = contours[k + 1] || [];
      for (let index = 0; index < contours[k].length; index += 1) {
        const ringSet = contours[k][index];
        const outerBounds = ringBounds(ringSet.outer);
        // The band's own pockets - the regions below THIS level - stay empty.
        const holes = [...(ringSet.holes || [])];
        // And the hotter level's shape is a hole in this one, so the two
        // bands share a line instead of each having its own.
        for (const hotterRing of hotter) {
          if (!hotterRing.outer?.length) continue;
          const point = hotterRing.outer[0];
          if (
            point.lon < outerBounds.west ||
            point.lon > outerBounds.east ||
            point.lat < outerBounds.south ||
            point.lat > outerBounds.north
          ) {
            continue;
          }
          if (pointInRingDegrees(point, ringSet.outer)) {
            holes.push(hotterRing.outer);
          }
        }
        const hierarchy = polygonHierarchyFor({ outer: ringSet.outer, holes });
        if (!hierarchy) continue;
        // The cap is applied across the whole draw, so what is bounded is the
        // entity count that actually reaches the scene.
        if (drawn >= SWATH_MAX_RINGS) {
          _swathCapped = true;
          console.warn(
            `[Storm Reports] swath capped at ${SWATH_MAX_RINGS} polygons; ` +
              `further ${kind}/${level.key} ring(s) dropped`,
          );
          return drawn;
        }
        const entity = addSwathBand(
          `storm-swath:${kind}:${level.key}:${index}`,
          hierarchy,
          level.color,
          swathAlphaFor(level.rank),
          level.outline,
          level.outlineAlpha,
        );
        if (entity) drawn += 1;
      }
    }
    return drawn;
  }

  function drawSwathBand(kind, cells, bandFor, deg, { contour = false } = {}) {
    const byBand = new Map();
    for (const cell of cells) {
      const band = bandFor(cell);
      if (!band) continue;
      if (!byBand.has(band.key)) byBand.set(band.key, { band, cells: [] });
      // The value rides along because the contour needs it: a staircase asks
      // only whether a cell is present, an iso-contour asks what the field
      // reads there. Dropping it here would make the two indistinguishable.
      byBand
        .get(band.key)
        .cells.push({ i: cell.i, j: cell.j, v: cell.peakMm ?? cell.peak ?? 0 });
    }
    let drawn = 0;
    for (const [bandKey, group] of byBand) {
      // Whether to contour is a property of the swath, not something to infer
      // from the data. An earlier version asked "does every cell carry a finite
      // value" and REPORTED cells answer yes - a report size is a value - so the
      // reported wash quietly became a contour too and lost its per-cell bands.
      //
      // REPORTED should not be contoured anyway: those cells are banded BY
      // their size, so every cell in a band is by construction at or above that
      // band's floor, and contouring them all at one level collapses the bands
      // into each other. RADAR and PROSPECT carry a millimetre reading across a
      // continuous range, which is what the contour is for.
      const ringSets =
        contour && group.cells.every((cell) => Number.isFinite(cell.v))
          ? contourRings(group.cells, group.band.floorMm ?? RADAR_FLOOR_MM, deg)
          : ringsToDegrees(gridCellRings(group.cells), deg);
      group.cells.length = 0;
      // The cap is applied across the whole draw, not per band, so what is
      // bounded is the entity count that actually reaches the scene.
      if (drawn + ringSets.length > SWATH_MAX_RINGS) {
        const room = Math.max(0, SWATH_MAX_RINGS - drawn);
        const kept = ringSets.slice(0, room);
        _swathCapped = true;
        console.warn(
          `[Storm Reports] swath capped at ${SWATH_MAX_RINGS} polygons; ` +
            `${ringSets.length - kept.length} ring(s) dropped from ${kind}/${bandKey}`,
        );
        for (let index = 0; index < kept.length; index += 1) {
          const hierarchy = polygonHierarchyFor(kept[index]);
          if (!hierarchy) continue;
          if (
            addSwathBand(
              `storm-swath:${kind}:${bandKey}:${index}`,
              hierarchy,
              group.band.color,
              swathAlphaFor(group.band.rank),
              group.band.outline,
              group.band.outlineAlpha,
            )
          ) {
            drawn += 1;
          }
        }
        return drawn;
      }
      // One entity per RING. Grouping a band's rings into one entity by passing
      // an array of hierarchies looks supported and is not: Cesium's
      // `hierarchy` setter runs `PolygonHierarchy.fromPositions` over whatever
      // array it is given, so an array of hierarchies becomes a hierarchy whose
      // "positions" are hierarchies. Measured, not assumed.
      //
      // The shadow-volume cost of one clamped shape per ring was checked
      // against that worry directly: 72 clamped entities ran the tiles regime
      // through five placement candidates without a renderer failure, so the
      // per-ring form stands.
      for (let index = 0; index < ringSets.length; index += 1) {
        const hierarchy = polygonHierarchyFor(ringSets[index]);
        if (!hierarchy) continue;
        const entity = addSwathBand(
          `storm-swath:${kind}:${bandKey}:${index}`,
          hierarchy,
          group.band.color,
          swathAlphaFor(group.band.rank),
          group.band.outline,
          group.band.outlineAlpha,
        );
        if (entity) drawn += 1;
      }
    }
    return drawn;
  }

  /**
   * Paint the swaths UNDER the pins.
   *
   * Drawn before the report markers so the entity ordering puts the pins on
   * top, which is the HailMaps model this copies: the measured stones sit over
   * the radar estimate. REPORTED paints a cell only where a stone was measured
   * in it; RADAR paints the selected day's — or the selected range's combined —
   * radar field, with artefacts greyed rather than dropped.
   */
  function renderSwaths() {
    if (!_dataSource) return;
    const tier = radarTier();
    _lodTier = tier;
    if (_showReportedSwath && _options.hazard === 'hail') {
      // The REPORTED swath is a wash of the ground the measured stones fell
      // on, and it is drawn the same way the radar swath is: the whole field
      // contoured once per level, with each band the region between two
      // levels. It used to be a STAIRCASE - the presence of a cell, traced -
      // because the cells carry inches and the contour level is millimetres.
      // The units were never the blocker; the blocker was contouring each
      // band on its own cells, and the same blocker is what left a four
      // hundred metre gap between two bands on the radar swath.
      //
      // The levels are the inch chart, in inches, and the cells carry inches.
      const reportedLevels = HAIL_BANDS.filter(
        (band) => band.min >= HAIL_FLOOR_IN,
      );
      drawSwathLevels(
        'reported',
        reportedSwathCells(_visible, { hailFloor: 0 }).map((cell) => ({
          i: cell.i,
          j: cell.j,
          v: cell.peak,
        })),
        reportedLevels.map((band, index, all) => ({
          key: band.id,
          color: band.color,
          // Rank by position in the inch scale, worst last.
          rank: index / Math.max(all.length - 1, 1),
          floor: band.min,
        })),
        GRID_DEG,
      );
    }
    _prospectCells = [];
    if (_showProspectSwath) {
      const tierCells = radarCellsForTier();
      const radarCells = tierCells.cells;
      const radarDeg = tierCells.deg;
      _prospectCells = prospectSwathCells(radarCells, _visible, {
        stepDeg: radarDeg,
      });
      // PROSPECT is a DIFFERENCE - the radar cells no report covers - so it
      // is drawn from its own cells, and its levels are its own bands. It is
      // not a stack of thresholds over one field, so it keeps its per-cell
      // shape; only the REPORTED and RADAR washes, which ARE thresholds over
      // one field, are annular.
      drawSwathBand(
        'prospect',
        _prospectCells,
        (cell) => {
          if (!cell.band) return null;
          return {
            key: cell.band.min,
            color: cell.band.color,
            rank: 0.85,
            floorMm: RADAR_CONTOUR_MM,
          };
        },
        radarDeg,
        { contour: true },
      );
    }
    if (_showRadarSwath) {
      // Ascending so the index IS the severity rank: the ramp is declared
      // worst-first, and inverting that here would silently reverse the alpha
      // ramp — the fringe would paint solid and the core would go ghostly.
      const ascending = [...RADAR_RAMP_MM].reverse();
      // The cells and the grid step, which differ by BOTH source and altitude:
      // the fine 1 km field for a single day seen from close up, the published
      // 0.25-degree field for a multi-day combine, a day outside the retention
      // window, or a camera high enough that 1 km cells are sub-pixel.
      const tierCells = radarCellsForTier();
      const radarCells = tierCells.cells;
      const radarDeg = tierCells.deg;
      // The RADAR swath is the one that had a seam. It is a stack of
      // THRESHOLDS over one continuous field - a millimetre reading is not on
      // the inch chart, so the ramp lives here - and it is drawn as one
      // contour per level with each band the region between two levels, so
      // the bands share ONE interpolated line.
      //
      // The levels are the ramp's own floors, ASCENDING: the ramp is declared
      // worst-first, and taking the first match against ascending thresholds
      // is a trap - 'under 10 mm' has a floor of 0, so it matches everything
      // and a 55 mm core gets banded, and painted, as the weakest hail on the
      // map. A test caught that once.
      drawSwathLevels(
        'radar',
        radarCells.map((cell) => ({ i: cell.i, j: cell.j, v: cell.peakMm })),
        ascending.map((step, index, all) => ({
          key: step.label,
          color: step.color,
          // The edge of this band is the next hotter band's colour, so the
          // boundary between two intensities is a line of the hotter one.
          outline: step.outline,
          outlineAlpha: SWATH_EDGE_ALPHA,
          rank: index / Math.max(all.length - 1, 1),
          floor: step.min,
        })),
        radarDeg,
      );
      // The implausible readings - at or above 100 mm, which is 0.22% of cell
      // days - are drawn on top in grey: present, but not ranked. They are
      // inside the hottest band, so they are not a separate level.
      const artefacts = radarCells.filter((cell) => cell.implausible);
      if (artefacts.length) {
        drawSwathLevels(
          'radar-artefact',
          artefacts.map((cell) => ({ i: cell.i, j: cell.j, v: cell.peakMm })),
          [
            {
              key: 'artefact',
              color: RADAR_IMPLAUSIBLE_COLOR,
              rank: 0,
              floor: 100,
            },
          ],
          radarDeg,
        );
      }
    }
  }

  /** Paint the visible reports. */
  function render() {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    _outlineEntity = null;
    // The swaths first, so the pins land on top of them in the entity ordering.
    renderSwaths();
    // The WORST of the current filter, capped. `_visible` itself is never
    // truncated - it is what the count, the storm list, the radar comparison
    // and the isolation maths all read. Only the DRAWN markers are bounded.
    const drawn = worstFirst(_visible, _options.hazard, STORM_MAX_MARKERS);
    _drawnCount = drawn.length;
    for (const report of drawn) {
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
   */
  function labelModelFor(report, band) {
    // A third `selected` argument used to exist here. Both call sites passed
    // two, so the branch that honoured it was unreachable.
    const isSelected =
      _selectedReportId === entityIdFor(report) || isolationIsOn();
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
   * WHY SO FEW ENTRIES. This used to publish the worst 25 reports as cards,
   * each titled "2.75 hail — Travis County". The colour bands are already
   * drawn by the Cesium points, and clicking already picks through
   * `scene.pick` against those same points, so the cards were duplicating a
   * mark that already existed while adding a line of text to every one. The
   * legend carries the band colours; a card is for the report someone is
   * actually pointing at.
   *
   * `cohortLimit` below is the overlay's own per-domain BUDGET, not a cap on
   * how many entries we may publish, so it no longer has to track the old
   * 25-report cohort. It is 2 — the most this layer can ever publish — so the
   * budget states what is true.
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
   * The radar line for the current day: how much hail radar saw and how much of
   * it nobody reported.
   *
   * This publishes the radar-only count, and it can, now. The field behind it is
   * per day — a cell's millimetres belong to the calendar day being read — so "a
   * cell with radar hail and no report" is a finding about this day rather than
   * about the year. Against the annual snapshot the same figure enumerated every
   * cell that ever had hail that year ("14,832 unreported radar cores" on a
   * 33-report day), which was the year talking and a roofer would have read as a
   * list of streets. That unreported-cell count is the honey hole the category
   * charges for, and it is now about the day on screen.
   *
   * Radar hail is a vertically-integrated estimate derived from reflectivity,
   * not a measured stone, and the caveat travels with the number. The artefact
   * count is per day too: a 100mm day reading is a credible extreme, so a cell
   * is flagged on the day's value rather than on a six-year maximum, and the
   * count legitimately differs from the lifetime figure.
   *
   * @returns {string|null}
   */
  function comparisonLine() {
    const split = _comparison;
    if (!split) return null;
    // Report-weighted, not cell-weighted. A 0.25 degree cell is 25 miles across,
    // so eight reports in one county collapse into a single cell and quoting
    // the cell count would understate a day's reports several-fold.
    const compared = split.reportsCompared ?? 0;
    const withCore = split.reportsWithCore ?? 0;
    const without = split.reportsWithoutCore ?? 0;
    // The honey hole: cells where radar showed hail and no stone was reported.
    const hailCells = (split.both ?? 0) + (split.radarOnly ?? 0);
    const unreported = split.radarOnly ?? 0;
    const cell = (n) => (n === 1 ? 'cell' : 'cells');
    const report = (n) => (n === 1 ? 'report' : 'reports');
    const parts = [
      `on ${split.day}, radar showed hail in ${hailCells} ${cell(hailCells)}, ${unreported} of them with no report`,
    ];
    if (compared)
      parts.push(
        `${withCore} of ${compared} ${report(compared)} sat in a cell with a radar core`,
      );
    if (without) parts.push(`${without} sat outside one`);
    if (split.artefacts)
      parts.push(
        `${split.artefacts} ${cell(split.artefacts)} read as radar artefacts`,
      );
    return (
      `radar: ${parts.join(' · ')} — an estimate from reflectivity for this day ` +
      'alone, not a measured stone'
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
    // When the marker cap bites, say so. Every number here is still the
    // true count - the cap bounds only what is DRAWN - but a map showing
    // 2,000 dots for 44,717 reports must not read as "there are 2,000 here".
    if (_drawnCount > 0 && _drawnCount < _visible.length)
      parts.push(
        `showing the ${_drawnCount.toLocaleString()} worst on the map`,
      );
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
    // The places the reports came from, worst-hit first. Beside the count and the
    // dates because it is the same sentence's next clause - how many, when, and
    // where - and a canvasser reads the three together.
    const places = impactedPlacesLine(_stats?.places);
    if (places) parts.push(places);
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
  /**
   * Recompute the radar swath from the cells already in memory, then repaint.
   *
   * The toggle must not re-fetch: flipping RADAR on after a comparison has
   * landed should paint the day already read, not spend a year fetch to draw a
   * shape the layer already holds.
   */
  function rebuildRadarSwath() {
    // Banded for either reader, so PROSPECT does not depend on RADAR having
    // been switched on first.
    _radarSwath =
      (_showRadarSwath || _showProspectSwath) && _radarWindowCells
        ? swathCellsForWindow(_radarWindowCells)
        : [];
    render();
    publish();
    notifyRowControls();
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
      _viewer.camera?.moveEnd?.addEventListener(onCameraSettled);
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
      // The radar read is dropped with the reports: its cells describe a window
      // that is no longer loaded, and re-enabling with the map empty must not
      // paint yesterday's swath from a memo.
      _radarKey = null;
      _radarWindowCells = null;
      _radarSwath = [];
      // The fine cells belong to ONE day. Leaving them behind across a date
      // change is how a swath drawn for yesterday's storm stays on screen
      // tomorrow, which is the same class of bug as the HMR toggle reset this
      // layer already had one of.
      _fineRadarCells = null;
      _radarFine = false;
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
      // The swath toggles are split out and applied last, through their own
      // setters. Order matters: a shared link can carry `hazard: 'hail'` and
      // `reportedSwath: true` together, and REPORTED refuses unless the hazard
      // is already hail. Merging the toggles into `_options` instead would let
      // `applyPendingParams` set them with no refusal check and no radar
      // rebuild at all.
      const { reportedSwath, radarSwath, prospectSwath, ...rest } =
        params || {};
      _pendingParams = { ...(_pendingParams || {}), ...rest };
      if (_snapshot) {
        applyPendingParams();
        _optionsDirty = true;
      }
      if (
        reportedSwath !== undefined ||
        radarSwath !== undefined ||
        prospectSwath !== undefined
      ) {
        // All three, or none of them: listing a subset here is how PROSPECT
        // ended up restorable through getParams and then silently not restored
        // through setParams, so a shared link lost exactly the view the user
        // had chosen. The call site has to name every key `applySwathIntent`
        // knows about.
        applySwathIntent({ reportedSwath, radarSwath, prospectSwath });
      }
      publish();
    },

    /** Current option intent, which is what a share link encodes. */
    getParams() {
      return {
        ...STORM_REPORTS_DEFAULTS,
        ..._options,
        ...(_pendingParams || {}),
        // Live, not recorded intent: the deferred copy would report a toggle as
        // on while it is still off, which is the same lie in the other
        // direction.
        reportedSwath: _showReportedSwath,
        radarSwath: _showRadarSwath,
        prospectSwath: _showProspectSwath,
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
        drawnCount: _drawnCount,
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
      } else {
        // The radar wash is not built from `_visible`, so it does not come
        // back through `repaintFromMemory` on its own.
        rebuildRadarSwath();
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
        } else {
          rebuildRadarSwath();
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
        {
          id: 'storm-reports-swath-reported',
          label: 'REPORTED',
          // Says what it colours, not what it means: the cells carry the
          // measured stone's band, and the caveat about a cell being 25 miles
          // wide lives with the legend.
          title:
            'Outline the ground the reported stones fell on, banded by the ' +
            'size of the largest stone reported in it',
          disabled: !ready || _options.hazard !== 'hail',
          active: _showReportedSwath,
          onClick: () => self().setReportedSwath(!_showReportedSwath),
        },
        {
          id: 'storm-reports-swath-prospect',
          label: 'PROSPECT',
          // Says the two floors it is actually comparing. A chip called
          // PROSPECT next to one called RADAR invites reading both as the same
          // measurement taken twice; they are radar millimetres on one side and
          // reported inches on the other, and the gap between them is the point.
          title:
            'Radar cells at ' +
            PROSPECT_MM_FLOOR +
            ' mm (' +
            (PROSPECT_MM_FLOOR / 25.4).toFixed(1) +
            '") with no report of 1" or more within ' +
            PROSPECT_RADIUS_KM +
            ' km',
          disabled: !ready || _options.hazard !== 'hail',
          active: _showProspectSwath,
          onClick: () => self().setProspectSwath(!_showProspectSwath),
        },
        {
          id: 'storm-reports-timeline-day',
          label: 'DAY',
          // The whole day is the maximum over its hours, which is what the
          // layer has always drawn. Choosing a frame is choosing to see
          // inside that maximum.
          title: 'The whole day: the largest hail that fell on it',
          disabled: !ready || !_subDailyFrames,
          active: _radarFrame === null,
          onClick: () => self().setRadarFrame(null),
        },
        ...frameChips(),
        {
          id: 'storm-reports-swath-radar',
          label: 'RADAR',
          // Disabled, not hidden, with no radar wired: a chip that silently
          // does nothing is the failure mode, so it says it has no source.
          title: radarSource
            ? 'Outline the ground the radar says the hail fell on, banded by ' +
              'the size it estimates - one inch, one and a half, two, two ' +
              'and three quarters, three and a half and up'
            : 'No radar source is wired',
          disabled: !ready || !radarSource,
          active: _showRadarSwath,
          onClick: () => self().setRadarSwath(!_showRadarSwath),
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
          ...(_showReportedSwath && _options.hazard === 'hail'
            ? [
                {
                  label: 'Reported hail cell',
                  color: '#f0a92e',
                  // Says the cell's size, because 25 miles is the fact that
                  // stops a cell count being read as a report count.
                  blurb:
                    'A quarter-degree cell coloured by the largest reported ' +
                    'stone - about 25 miles across, so a county of reports is one cell',
                },
              ]
            : []),
          ...(_showProspectSwath && _options.hazard === 'hail'
            ? [
                {
                  label: 'Prospecting, this view',
                  color: PROSPECT_BANDS[PROSPECT_BANDS.length - 1].color,
                  blurb: prospectReadout(),
                },
                ...PROSPECT_BANDS.map((step) => ({
                  label: `Prospecting ${step.label}`,
                  color: step.color,
                  blurb:
                    'Radar says hail, no report says hail. Neither side proves ' +
                    'anything alone: a cell can go unreported because nobody ' +
                    'was in it, and a report can land in a cell the radar ' +
                    'missed. It is a place to look, not a place to bill.',
                })),
              ]
            : []),
          ...(_showRadarSwath
            ? RADAR_RAMP_MM.map((step) => ({
                label: `Radar hail ${step.label}`,
                color: step.color,
                // The caveat travels with the colour: a millimetre read off a
                // radar is not a stone anyone measured. The floor is named here
                // rather than left implicit, because the stored field goes BELOW
                // it - a user who asks why a 20mm cell is missing deserves an
                // answer on screen, not just in a constant.
                blurb:
                  'Vertically-integrated radar estimate, not a measured stone. ' +
                  'Nothing under an inch is drawn: the stored field keeps it, ' +
                  'the product does not.',
              }))
            : []),
          ...(_showRadarSwath
            ? [
                {
                  label: 'Radar edge',
                  color: RADAR_RAMP_MM[RADAR_RAMP_MM.length - 1].color,
                  blurb: CONTOUR_CAVEAT,
                },
                {
                  label: 'Radar artefact',
                  color: RADAR_IMPLAUSIBLE_COLOR,
                  blurb:
                    `Above ${RADAR_IMPLAUSIBLE_MM} mm: beyond what hail reaches, ` +
                    'kept so the grid has no holes, and never ranked as a lead',
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
     * The places the visible reports came from, worst-hit first.
     *
     * Empty when nothing visible carries a county. The map's own answer, not a
     * second dataset: a report names its county, so the list of impacted places
     * is a read of the reports already on screen rather than a join.
     *
     * @returns {Array<{county: string, state: string, count: number}>}
     */
    getImpactedPlaces() {
      return _stats?.places ?? [];
    },

    /** Whether the reported-hail swath is drawn. */
    getReportedSwath() {
      return _showReportedSwath;
    },

    /**
     * Show or hide the reported-hail swath.
     *
     * Hail only: a wind report has no size band to colour a cell with, so the
     * chip is disabled under WIND and this refuses there too.
     *
     * @param {boolean} on
     * @returns {boolean} whether the toggle moved
     */
    setReportedSwath(on) {
      const next = Boolean(on);
      if (next === _showReportedSwath) return false;
      if (next && _options.hazard !== 'hail') return false;
      _showReportedSwath = next;
      render();
      publish();
      notifyRowControls();
      return true;
    },

    /** Whether the radar-hail swath is drawn. */
    getRadarSwath() {
      return _showRadarSwath;
    },

    /** Whether the prospecting swath is showing. See `setProspectSwath`. */
    getProspectSwath() {
      return _showProspectSwath;
    },

    /**
     * Show or hide the radar-hail swath.
     *
     * Refuses with no radar source wired, mirroring the disabled chip: a wedge
     * that turns on a shape the layer cannot draw is the silent no-op this
     * surface exists to avoid.
     *
     * @param {boolean} on
     * @returns {boolean} whether the toggle moved
     */
    /**
     * Show one six-hour frame of the day, or the whole day.
     *
     * The day is a maximum over its hours and a maximum has no story in it.
     * The frames are the day's hail split into six-hourly pieces, so the
     * storm can be replayed: which part of the day the hail arrived, and
     * whether it came back.
     *
     * A frame is a SUBSET of the day, so the day's numbers stay the summary
     * and the frame is the detail under them.
     *
     * @param {number|null} frame the frame index, or null for the whole day
     * @returns {boolean} whether it moved
     */
    setRadarFrame(frame) {
      const next = frame === null || frame === undefined ? null : Number(frame);
      if (next !== null && !Number.isInteger(next)) return false;
      if (
        next !== null &&
        (!_subDailyFrames || next >= _subDailyFrames.length)
      ) {
        return false;
      }
      if (next === _radarFrame) return false;
      _radarFrame = next;
      // The frame is a different set of cells, so the swath is rebuilt from
      // them rather than recoloured.
      if (_showRadarSwath || _showProspectSwath) {
        rebuildRadarSwath();
      } else {
        render();
        publish();
        notifyRowControls();
      }
      return true;
    },

    setRadarSwath(on) {
      const next = Boolean(on);
      if (next === _showRadarSwath) return false;
      if (next && !radarSource) return false;
      _showRadarSwath = next;
      // Turning RADAR off must not take PROSPECT's banding down with it, and
      // turning it on may be the first thing that asked for the banding at
      // all - so the band is rebuilt whenever either reader's state changed.
      if (_showRadarSwath || _showProspectSwath) {
        rebuildRadarSwath();
      } else {
        // AND THE MAP IS REDRAWN. Clearing the cells is not enough: the
        // polygons are already in the data source, and only `render()` empties
        // it. So switching RADAR off used to leave the swath on the map with
        // nothing to switch it back with. It was invisible because RADAR was
        // off by default and nobody could turn it off; RADAR being on by
        // default makes it a one-click bug.
        _radarSwath = [];
        render();
        publish();
        notifyRowControls();
      }
      return true;
    },

    /**
     * Draw the radar cells nobody reported hail in. See
     * {@link module:layers/stormReports/model.prospectSwathCells}.
     *
     * Returns whether it moved, so a caller can tell "already on" from "turned
     * on" - and false when there is no radar source to compare against, because
     * an unsuppressed area computed with no radar is every report's absence.
     * @param {boolean} on
     * @returns {boolean}
     */
    setProspectSwath(on) {
      const next = Boolean(on);
      if (next === _showProspectSwath) return false;
      if (next && _options.hazard !== 'hail') return false;
      _showProspectSwath = next;
      // The same banding dependency as `setRadarSwath`, from the other side:
      // first time PROSPECT is switched on there is nothing banded to subtract
      // reports from.
      if (_showProspectSwath || _showRadarSwath) rebuildRadarSwath();
      else _radarSwath = [];
      // Render before publish: the legend quotes `_prospectCells`, and only the
      // render computes them. Publishing first would put a readout on screen
      // describing the view as it was before the toggle.
      render();
      publish();
      return true;
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
      _viewer?.camera?.moveEnd?.removeEventListener(onCameraSettled);
      _dataSource = null;
      if (_instance === api) _instance = null;
      _viewer = null;
    },
  };
  _instance = api;
  return api;
}

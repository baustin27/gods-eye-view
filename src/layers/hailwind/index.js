/**
 * Storm intelligence layer — hail/wind history and a residential
 * damage-likelihood surface.
 *
 * What it shows
 *  - A 0.25° grid of observed hail and wind reports since 1955, coloured by a
 *    blended damage-likelihood score.
 *  - Individual significant events (hail ≥ 2.00", wind ≥ 75 kt) as points, with
 *    tracked paths where the Storm Prediction Center recorded a final location.
 *  - A per-cell card explaining exactly which inputs produced its colour.
 *
 * What it does not claim
 *  - It is not a forecast and not an assessment of any individual structure. The
 *    score answers "where should someone look first", which is a triage aid.
 *    The method caveats in `stormAttribution.js` are surfaced by the panel
 *    rather than buried, because a bare risk number with no provenance is worse
 *    than no number at all.
 *
 * @module layers/hailwind/index
 */

import * as Cesium from 'cesium';
import { STORM_FINE_GRID_DEG } from '../../data/stormDatasets.js';
import { areaContains } from '../../data/isolation.js';
import {
  scoreCells,
  scoreCounties,
  searchCounties,
  polygonCenter,
} from '../../data/stormScoring.js';
import {
  STORM_SOURCE_BADGE,
  STORM_METHOD_CAVEATS,
} from '../../data/stormAttribution.js';
import {
  seedStormOptions,
  publishStormOptions,
  subscribeStormOptions,
} from './sharedOptions.js';
import {
  STORM_OVERLAY_COHORT_LIMIT,
  STORM_OVERLAY_COLLISION_CAPACITY,
  STORM_SIGNIFICANT_SCORE,
  STORM_FACET_OBSERVED,
  STORM_FACET_EXPECTED,
  STORM_FACETS,
  STORM_SURFACE_DAMAGE,
  STORM_SURFACE_RADAR_GAP,
  STORM_SURFACE_VS_EXPECTED,
  STORM_OBSERVED_SURFACES,
  stormLayerId,
  radarGapScore,
  expectedRatioScore,
  hexForScore,
  alphaForScore,
  hexForRank,
  alphaForRank,
  rankScores,
  STORM_SIGNIFICANT_RANK,
  accentForScore,
  createCellOverlayEntry,
  createEventOverlayEntry,
  describeEvent,
  createCountyOverlayEntry,
  selectCellOverlayCohort,
  mapAnalystCellRecord,
  mapAnalystEventRecord,
  mapAnalystCountyRecord,
} from './model.js';

export * from './model.js';
export { createStormSource } from './source.js';

/**
 * Hard ceiling on grid rectangles handed to Cesium.
 *
 * A 0.25° CONUS grid is ~12k cells and every one of them is a separate ground
 * entity. Cesium handles that, but the cost is paid on every camera move, so
 * the layer renders only the strongest cells and says how many it dropped
 * rather than pretending the surface is complete.
 */
export const STORM_MAX_CELLS = 6000;

/** Hard ceiling on significant-event markers. */
export const STORM_MAX_EVENTS = 4000;

/**
 * County ENTITIES drawn by the expected layer.
 *
 * One entity per county PART, and holes ride on the part's hierarchy rather
 * than becoming entities of their own. Measured against the bundled snapshot:
 * the whole US is 3,234 counties resolving to **4,210 parts** carrying 46 holes
 * - so 4,256 rings, which is what the old code produced.
 *
 * 4,000 was not enough, and the shortfall was not random. Enforcing it dropped
 * ~210 parts, and the parts it dropped were systematically the lowest-scoring
 * counties - which is where the holed counties live, because a hole is an
 * independent city and independent cities are small and score low. So the cap
 * silently removed exactly the geometry that needed the most care: every
 * Fairfax-style enclave would have been drawn as a solid blob over its own
 * county. The number is a guard against a pathological dataset, not a budget
 * intended to be hit.
 */
export const STORM_MAX_COUNTIES = 5000;

/**
 * Share of the ambient card lane reserved for event drill-down cards.
 *
 * Events are the more specific thing a reader can click, but the damage surface
 * is the layer's primary read, so events get a minority of the slots.
 */
export const STORM_EVENT_CARD_LIMIT = 8;

/** Start of the decade containing `year`. */
function decadeStartFor(year) {
  if (!Number.isFinite(year)) return null;
  return Math.floor(year / 10) * 10;
}

/**
 * Build one "this decade onward" chip per decade the record actually spans.
 *
 * Pure: takes only the readiness flag, the current window and the dataset
 * bounds, so it can be unit-tested without a viewer or a snapshot.
 *
 * @param {boolean} ready
 * @param {{fromYear:number, toYear:number}} window
 * @param {{earliestYear?:number, latestYear?:number}|null} dataset
 * @returns {Array<object>}
 */
export function decadeChips(ready, window, dataset) {
  const first = decadeStartFor(dataset?.earliestYear);
  const last = decadeStartFor(dataset?.latestYear);
  if (first == null || last == null) return [];
  const chips = [];
  for (let d = first; d <= last; d += 10) {
    chips.push({
      id: `storm-from-${d}`,
      label: `${String(d).slice(2)}s`,
      title: `Count reports from ${d} onward — exact, not prorated`,
      disabled: !ready,
      active: ready && window.fromYear === d,
      // Declarative, like the hazard chips: layerPanel routes a chip with
      // `params` through setLayerParams({origin:'user'}), which is the only
      // path that persists the choice into the share link. An onClick here
      // would change the map and be forgotten the moment the link was copied.
      params: { fromYear: d },
    });
  }
  return chips;
}

export function createStormLayer({
  source,
  overlayHost,
  facet = STORM_FACET_OBSERVED,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Storm layer requires a snapshot source');
  if (!overlayHost) throw new TypeError('Storm layer requires an overlay host');
  if (!STORM_FACETS.includes(facet))
    throw new TypeError(`Unknown storm facet: ${facet}`);

  const LAYER_ID = stormLayerId(facet);
  const isExpected = facet === STORM_FACET_EXPECTED;

  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _dataset = null;
  let _rows = [];
  let _enabled = false;
  let _loading = false;
  let _lastError = null;
  let _lastUpdate = null;
  let _stats = null;
  let _window = { fromYear: 1955, toYear: new Date().getFullYear() };
  let _includeHail = true;
  let _includeWind = true;
  let _showEvents = !isExpected;
  // The isolated area, or null. Held here rather than in a subscriber so it
  // survives a durable restore that lands before the layer is enabled.
  let _isolationArea = null;
  let _surface = STORM_SURFACE_DAMAGE;
  let _selectedCellKey = null;
  let _selectedEventId = null;

  /**
   * Durable option intent from the manager, replayed once the snapshot lands.
   *
   * Manager params are applied before the first `update()`, when there is no
   * dataset to score against, so they have to be remembered rather than
   * applied. `getParams()` reports this intent, not the transient window —
   * otherwise the coordinator would read the default back and write it over
   * the share the user just opened.
   *
   * @type {object|null}
   */
  let _pendingParams = null;

  /**
   * Ranks of the last scored row set, keyed by cell key, on whichever measure
   * the active surface paints by. Assigned per rebuild; `surfaceValue` reads it
   * so the painters stay pure.
   *
   * @type {Map<string, number>|null}
   */
  let surfaceRanks = null;

  /** Year requested by a durable option, applied once a dataset exists. */
  let _requestedFromYear = null;

  /** Detaches this layer from the shared option bag. */
  let unsubscribeSibling = null;

  /**
   * Apply a partial durable-option bag.
   *
   * @param {object} params
   * @returns {boolean} False when a supplied value is unusable.
   */
  function applyParams(params = {}, { publish = true } = {}) {
    if (Object.hasOwn(params, 'surface')) {
      // The expected layer has no cell grid, so a surface is meaningless there
      // rather than wrong. Ignore it instead of rejecting, because it mirrors
      // storm-observed's bag and arrives on every restore.
      if (!isExpected && !STORM_OBSERVED_SURFACES.includes(params.surface))
        return false;
    }
    // Recording the intent and applying it to the scene are separate steps.
    // Guarding the whole call on "nothing changed" was wrong: a layer can
    // already hold the requested year while its live window is still the
    // dataset default, because the dataset had not loaded when the intent
    // arrived. Skipping then meant the window was never applied at all.
    const beforeHail = _includeHail;
    const beforeWind = _includeWind;
    const beforeSurface = _surface;
    if (Object.hasOwn(params, 'fromYear')) {
      const from = Math.floor(Number(params.fromYear));
      if (!Number.isFinite(from) || from < 1950) return false;
      _requestedFromYear = from;
    }
    if (Object.hasOwn(params, 'includeHail'))
      _includeHail = Boolean(params.includeHail);
    if (Object.hasOwn(params, 'includeWind'))
      _includeWind = Boolean(params.includeWind);
    if (Object.hasOwn(params, 'surface') && !isExpected)
      _surface = params.surface;
    _pendingParams = { ...(_pendingParams || {}), ...params };

    // Only touch the scene when a value the scene actually uses has moved.
    // setYearWindow rebuilds on its own, so the year is handled separately.
    const windowMoved =
      _dataset &&
      _requestedFromYear != null &&
      _window.fromYear !== _requestedFromYear;
    const sceneMoved =
      _includeHail !== beforeHail ||
      _includeWind !== beforeWind ||
      _surface !== beforeSurface;
    if (windowMoved)
      layer.setYearWindow(_requestedFromYear, _dataset.latestYear);
    else if (_dataset && sceneMoved) rebuild(true);

    // `publish: false` is how a sibling layer applies an incoming change
    // without bouncing it straight back; the store's re-entrancy guard also
    // drops it, but not relying on that keeps the intent readable.
    if (publish) publishStormOptions(_pendingParams, { origin: 'peer' });
    return true;
  }

  /**
   * Adopt a change made on the sibling layer.
   *
   * Applied locally only. The durable state was already written by whoever made
   * the change, so publishing again here would persist the same thing twice and
   * could re-enter.
   *
   * @param {object} options
   */
  function adoptSiblingOptions(options) {
    return applyParams(options, { publish: false });
  }
  const _listeners = new Set();

  function notify() {
    for (const listener of _listeners) {
      try {
        listener(layer.getStats());
      } catch {
        /* a broken listener must not break rendering */
      }
    }
  }

  /**
   * Rebuild the scored grid and the entity collection for the current window.
   *
   * Pure recomputation over the bundled decade histogram, so changing the year
   * range is instant and does not refetch anything.
   *
   * @param {boolean} [force] Re-score even when the window is unchanged.
   * @returns {boolean} True when the scene changed.
   */
  /**
   * Rebuild the county polygons for the expected layer.
   *
   * Separate from the cell path because the unit of analysis differs: NRI is
   * a per-county product, so painting it on a 0.25° grid would imply a
   * precision the source does not have. The observed layer carries the cell
   * grid; this one carries counties, and turning both on is the comparison.
   *
   * @returns {boolean} True when the scene changed.
   */
  function rebuildExpected(windowKey) {
    const rows = scoreCounties(_dataset.counties, {
      fromYear: _window.fromYear,
      toYear: _window.toYear,
      limit: STORM_MAX_COUNTIES,
      includeHail: _includeHail,
      includeWind: _includeWind,
    });
    _rows = rows;

    // Scoped BEFORE the entity cap, so the ranking that decides which counties
    // survive is computed over the area rather than nationally and then cropped.
    // Ranking all 3,234 counties and keeping the first N would keep whichever
    // scored highest in the whole country, not highest in Colorado.
    const scopedRows = rows.filter((row) => countyInIsolatedArea(row));

    // Ranked, not thresholded. `rebuildExpected` was the one surface still
    // banding on absolute score thresholds - 0.72 / 0.42 / 0.18 - which the model
    // module's own comment calls a calibration that silently rots, and which the
    // cell surface abandoned for exactly that reason. A damage surface is read
    // comparatively ("how does this county rank against its neighbours"), and
    // ranking over the SCOPED set means isolating Colorado bands Colorado
    // against itself rather than against the whole country.
    const countyRanks = rankScores(
      scopedRows.map((row) => ({ ...row, key: row.fips })),
    );

    const entities = [];
    // The cap is enforced on ENTITIES, not rows - see STORM_MAX_COUNTIES.
    // Rows arrive score-descending, so a county that would be cut is the least
    // interesting one, but the cut must not land mid-part.
    for (const row of scopedRows) {
      if (entities.length >= STORM_MAX_COUNTIES) break;
      const geometry = _dataset.countiesByFips.get(String(row.fips))?.geometry;
      if (!geometry) continue;
      // One entity per part: Cesium's hierarchy setter collapses an array into
      // a single polygon, which breaks every multi-part county.
      const parts = polygonParts(geometry);
      parts.forEach((hierarchy, index) => {
        // Inside the loop as well as outside it. Checking only per county let a
        // single 13-part county push the total to 4,013 against a 4,000 cap -
        // the guard was right about rows and still let entities through.
        if (entities.length >= STORM_MAX_COUNTIES) return;
        entities.push(
          new Cesium.Entity({
            id: `storm-county:${row.fips}:${index}`,
            polygon: {
              hierarchy,
              material: Cesium.Color.fromCssColorString(
                hexForRank(countyRanks.get(String(row.fips))),
              ).withAlpha(alphaForRank(countyRanks.get(String(row.fips)))),
              outline: false,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            properties: mapAnalystCountyRecord(row),
          }),
        );
      });
    }

    _dataSource.entities.removeAll();
    for (const entity of entities) _dataSource.entities.add(entity);

    const overlayEntries = selectCellOverlayCohort(
      scopedRows
        .filter((row) => _dataset.countiesByFips.get(String(row.fips)))
        .map((row) => {
          const position = Cesium.Cartesian3.fromDegrees(
            ...countyCentre(row, _dataset),
          );
          return createCountyOverlayEntry({ row, position });
        }),
    );
    overlayHost.setEntries(LAYER_ID, overlayEntries, {
      cohortLimit: STORM_OVERLAY_COHORT_LIMIT,
      collisionCapacity: STORM_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });

    _stats = {
      windowKey,
      fromYear: _window.fromYear,
      toYear: _window.toYear,
      includeHail: _includeHail,
      includeWind: _includeWind,
      showEvents: _showEvents,
      countiesScored: rows.length,
      cellsScored: 0,
      eventsShown: 0,
      caveats: STORM_METHOD_CAVEATS,
    };
    notify();
    return true;
  }

  /**
   * Events inside the current window and hazard selection.
   *
   * Single definition so the entity collection and the drill-down cards can
   * never disagree about which events are on screen.
   *
   * @returns {object[]}
   */
  function _visibleEvents() {
    if (!_dataset || !_showEvents) return [];
    return _dataset.significantEvents.filter((event) => {
      if (event.year == null) return false;
      if (event.year < _window.fromYear || event.year > _window.toYear)
        return false;
      if (event.hazard === 'hail' && !_includeHail) return false;
      if (event.hazard === 'wind' && !_includeWind) return false;
      return true;
    });
  }

  /**
   * The 0..1 value a row is painted by under the active surface.
   *
   * @param {object} row scored cell row
   * @returns {{value:number|null}} null means "this measure is unanswerable
   *   for this cell", which renders transparent rather than as zero.
   */
  /** The 0..1 measure a row is coloured by, before ranking. */
  function surfaceMeasure(row) {
    if (_surface === STORM_SURFACE_RADAR_GAP) {
      const gap = radarGapScore(row);
      return gap ? gap.ratio : null;
    }
    if (_surface === STORM_SURFACE_VS_EXPECTED) {
      const ratio = expectedRatioScore(row);
      return ratio ? ratio.ratio : null;
    }
    return row.score;
  }

  function surfaceValue(row) {
    if (_surface === STORM_SURFACE_RADAR_GAP) {
      const gap = radarGapScore(row);
      return {
        value: gap ? gap.ratio : null,
        rank: rankOf(row, gap ? gap.ratio : null),
      };
    }
    if (_surface === STORM_SURFACE_VS_EXPECTED) {
      const ratio = expectedRatioScore(row);
      return {
        value: ratio ? ratio.ratio : null,
        rank: rankOf(row, ratio ? ratio.ratio : null),
      };
    }
    return { value: row.score, rank: rankOf(row, row.score) };
  }

  /**
   * Rank of a row on the measure the surface is painting by.
   *
   * @param {object} row
   * @param {number|null} value
   * @returns {number|null}
   */
  function rankOf(row, value) {
    if (value == null) return null;
    return surfaceRanks.get(String(row.key)) ?? null;
  }

  /**
   * Is this row inside what the camera can actually see?
   *
   * Drawing every 0.25 degree cell regardless of zoom is what made the globe a
   * solid red shell and dragged the frame rate to nothing. A margin keeps
   * cells just off-screen drawn so a small pan does not blank the view.
   *
   * @param {{lat:number, lon:number}} row
   * @returns {boolean}
   */
  /**
   * Is this row inside the isolated area, when one is in force?
   *
   * A cell is tested at its own centre. The 0.25 degree cells are ~25 km, so
   * that is the same call the storm-report swath makes - and the honest one: a
   * quarter-degree grid simply cannot say more precisely than that where its
   * edge falls.
   *
   * @param {{lat:number, lon:number}} row
   * @returns {boolean}
   */
  /**
   * A short string identifying the isolated area, for the rebuild key.
   *
   * The bbox alone is not enough - two different areas can share a frame in
   * degenerate cases, and the rebuild must not be skipped because the shape
   * changed while the box did not. Compared, never displayed.
   *
   * @returns {string}
   */
  function isolationKey() {
    if (!_isolationArea) return '-';
    const bbox = _isolationArea.bbox;
    const parts = Array.isArray(bbox)
      ? bbox.map((v) => Number(v).toFixed(3))
      : [];
    const ringCount = Array.isArray(_isolationArea.polygons)
      ? _isolationArea.polygons.length
      : 0;
    return `${parts.join(',')}|${ringCount}`;
  }

  function inIsolatedArea(row) {
    if (!_isolationArea) return true;
    return areaContains(_isolationArea, row.lat, row.lon);
  }

  /**
   * Is this county inside the isolated area, when one is in force?
   *
   * Tested at the county's own centre rather than by clipping its outline:
   * there is no polygon-polygon intersection anywhere in this app, and an
   * area-weighted share would need one. A whole county is the right unit here
   * anyway - the surface paints counties, not parcels.
   *
   * @param {object} row
   * @returns {boolean}
   */
  function countyInIsolatedArea(row) {
    if (!_isolationArea) return true;
    const [lon, lat] = countyCentre(row, _dataset);
    return areaContains(_isolationArea, lat, lon);
  }

  function isInView(row) {
    const box = viewBox();
    if (!box) return true;
    const margin = 0.5;
    return (
      row.lat >= box.south - margin &&
      row.lat <= box.north + margin &&
      row.lon >= box.west - margin &&
      row.lon <= box.east + margin
    );
  }

  /** Cached view rectangle in degrees, refreshed per rebuild. */
  function viewBox() {
    const d = 180 / Math.PI;
    try {
      const r = _viewer?.camera?.computeViewRectangle?.();
      if (!r) return null;
      return {
        south: r.south * d,
        west: r.west * d,
        north: r.north * d,
        east: r.east * d,
      };
    } catch {
      return null;
    }
  }

  /**
   * One PolygonHierarchy per usable PART of a GeoJSON geometry.
   *
   * Cesium's `polygon.hierarchy` setter does not accept an array of
   * PolygonHierarchy: it wraps whatever array it is handed into a *single*
   * hierarchy and uses the array as that hierarchy's positions. A multi-part
   * county therefore collapses to one vertex, and the tangent plane cannot be
   * computed — "origin has a NaN component". Verified against the running
   * Cesium: an array of hierarchies reads back as one hierarchy with the
   * array as its positions, while a single PolygonHierarchy reads back
   * correctly. So the caller emits one entity per part.
   *
   * Holes are NOT flattened. This previously returned a flat list of rings and
   * the caller made one entity from each, which drew all 46 US county holes —
   * the independent cities, the enclaves — as solid county-coloured blobs
   * sitting on top of the county around them. A hole is not a part; it belongs
   * to the part that surrounds it.
   *
   * Non-finite coordinates are dropped rather than passed through, because one
   * NaN vertex poisons the polygon's centre.
   *
   * @param {object} geometry GeoJSON Polygon or MultiPolygon
   * @returns {Array<Cesium.PolygonHierarchy>} one per drawable part.
   */
  function polygonParts(geometry) {
    const parts =
      geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : geometry?.type === 'Polygon'
          ? [geometry.coordinates]
          : [];
    const hierarchies = [];
    for (const ringSet of parts) {
      const [outer, ...rest] = ringSet;
      if (!outer) continue;
      const positions = [];
      for (const [lon, lat] of outer) {
        // Cesium turns a non-finite coordinate into a NaN vertex, and one NaN
        // vertex is enough to make the whole polygon's centre NaN, which
        // surfaces as "origin has a NaN component".
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        positions.push(Cesium.Cartesian3.fromDegrees(lon, lat));
      }
      if (positions.length < 3) continue;
      const holes = [];
      for (const hole of rest) {
        const holePositions = [];
        for (const [lon, lat] of hole) {
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          holePositions.push(Cesium.Cartesian3.fromDegrees(lon, lat));
        }
        if (holePositions.length >= 3) holes.push(holePositions);
      }
      hierarchies.push(new Cesium.PolygonHierarchy(positions, holes));
    }
    return hierarchies;
  }

  /** @returns {[number, number]} lon, lat for a county card anchor. */
  function countyCentre(row, dataset) {
    const centre = polygonCenter(
      dataset.countiesByFips.get(String(row.fips))?.geometry,
    );
    return centre ? [centre.lon, centre.lat] : [0, 0];
  }

  function rebuild(force = false) {
    if (!_dataset || !_enabled || !_dataSource) return false;
    // Every input that changes the entity set must appear in the key, or the
    // rebuild short-circuits and the control silently does nothing.
    // The area is part of the key. Without it, isolating a state changed
    // nothing until some other control happened to force a rebuild - which is
    // the exact silent no-op the key's own comment warns about for everything
    // else in it.
    const key = `${_window.fromYear}:${_window.toYear}:${_includeHail}:${_includeWind}:${_showEvents}:${_surface}:${isolationKey()}`;
    if (
      !force &&
      _stats?.windowKey === key &&
      _dataSource.entities.values.length
    )
      return false;

    // The expected facet scores counties, not grid cells: FEMA NRI is a
    // county product, and spreading it over 0.25° cells would invent a
    // resolution the source does not have.
    if (isExpected) return rebuildExpected(key);

    const rows = scoreCells(
      {
        cells: _dataset.cells,
        countiesByCell: _dataset.countiesByCell,
        // Omitting this was a live wiring gap: scoreCells reads radar off the
        // dataset, and without it blendScore got `radar: null` and dropped the
        // term from both numerator and denominator. The radar snapshot was
        // loaded, scored in tests, and then silently unused at runtime.
        radarByCell: _dataset.radarByCell,
        latestYear: _dataset.latestYear,
      },
      {
        fromYear: _window.fromYear,
        toYear: _window.toYear,
        limit: STORM_MAX_CELLS,
        includeHail: _includeHail,
        includeWind: _includeWind,
      },
    );
    _rows = rows;

    // Rank before painting, so the bands stay meaningful whatever the
    // snapshot's absolute numbers do. Culling to the view happens here too:
    // a 0.25 degree cell is invisible from orbit, and drawing all of them
    // regardless is what made the globe a wall of red and the frame time
    // unusable.
    // Rank on the measure the active surface paints by, so the bands
    // describe that measure rather than the damage score.
    surfaceRanks = rankScores(rows, (row) => surfaceMeasure(row));
    const visible = rows.filter((row) => isInView(row) && inIsolatedArea(row));

    const entities = [];
    const half = STORM_FINE_GRID_DEG / 2;
    for (const row of visible) {
      const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
      // The surface decides what the colour means. On the non-default
      // surfaces a cell can score zero on the chosen measure, and painting it
      // at zero alpha is the honest answer - a cell with no radar coverage is
      // unknown, not confirmed-clear, and must not read as "no risk".
      const paint = surfaceValue(row);
      const rank = paint.rank;
      const outlined = rank != null && rank >= STORM_SIGNIFICANT_RANK;
      entities.push(
        new Cesium.Entity({
          id: `storm-cell:${row.key}`,
          position,
          rectangle: {
            // Static axes on purpose: a CallbackProperty here would re-tessellate
            // thousands of clamped rectangles on every frame.
            coordinates: Cesium.Rectangle.fromDegrees(
              row.lon - half,
              row.lat - half,
              row.lon + half,
              row.lat + half,
            ),
            material: Cesium.Color.fromCssColorString(
              hexForRank(rank),
            ).withAlpha(rank == null ? 0 : alphaForRank(rank)),
            outline: outlined,
            outlineColor: Cesium.Color.fromCssColorString(
              hexForRank(rank ?? 0),
            ).withAlpha(0.9),
            outlineWidth: outlined ? 1.5 : 0,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
          properties: {
            ...mapAnalystCellRecord(row),
            surface: _surface,
            surfaceValue: paint.value,
            surfaceRank: rank,
          },
        }),
      );
    }

    if (_showEvents) {
      const events = _visibleEvents();
      const color = Cesium.Color.fromCssColorString('#ffdc00');
      // Events carry disableDepthTestDistance, so every one is rasterised
      // even behind the horizon. Four thousand of those is the other half of
      // the frame cost, so cull to the view and scale the budget with how
      // much of the screen they could plausibly occupy.
      const box = viewBox();
      const margin = 1;
      const inView = box
        ? events.filter(
            (e) =>
              e.lat >= box.south - margin &&
              e.lat <= box.north + margin &&
              e.lon >= box.west - margin &&
              e.lon <= box.east + margin,
          )
        : events;
      const span = box
        ? Math.max(box.north - box.south, box.east - box.west)
        : 180;
      const budget = Math.max(
        400,
        Math.round(STORM_MAX_EVENTS * Math.min(1, 4 / Math.max(1, span))),
      );
      for (const event of inView.slice(0, budget)) {
        const position = Cesium.Cartesian3.fromDegrees(event.lon, event.lat);
        entities.push(
          new Cesium.Entity({
            id: `storm-event:${event.id}`,
            position,
            point: {
              pixelSize: event.hazard === 'hail' ? 5 : 4,
              color:
                event.hazard === 'hail'
                  ? color.withAlpha(0.9)
                  : color.withAlpha(0.55),
              outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            properties: mapAnalystEventRecord(event),
          }),
        );
        if (event.track && event.track.length >= 2) {
          entities.push(
            new Cesium.Entity({
              id: `storm-track:${event.id}`,
              polyline: {
                positions: event.track.map(([lon, lat]) =>
                  Cesium.Cartesian3.fromDegrees(lon, lat),
                ),
                width: 1.5,
                material: color.withAlpha(0.35),
                clampToGround: true,
              },
            }),
          );
        }
      }
    }

    _dataSource.entities.removeAll();
    for (const entity of entities) _dataSource.entities.add(entity);

    // Overlay cohort: only the strongest cells, so the card lane stays legible.
    // Events are published alongside them in their own collision group so the
    // host solves them independently — but they still share one cohort budget,
    // and event priority is severity-based, so an unbounded event list fills
    // every slot and starves the damage surface entirely. The lane is split.
    const topRows = rows.slice(0, STORM_OVERLAY_COHORT_LIMIT * 3);
    const shownEvents = _visibleEvents();
    const eventBudget = Math.min(
      STORM_EVENT_CARD_LIMIT,
      Math.floor(STORM_OVERLAY_COHORT_LIMIT / 3),
    );
    const cellBudget = STORM_OVERLAY_COHORT_LIMIT - eventBudget;
    const overlayEntries = [
      ...selectCellOverlayCohort(
        topRows.map((row) =>
          createCellOverlayEntry({
            row,
            position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
            selected: row.key === _selectedCellKey,
          }),
        ),
        cellBudget,
      ),
      // The drill-down cards. `createEventOverlayEntry` existed and was imported
      // but never called, so events had no card and no way to be inspected —
      // they were points on a map you could look at but not ask about.
      ...selectCellOverlayCohort(
        shownEvents.map((event) =>
          createEventOverlayEntry({
            event,
            position: Cesium.Cartesian3.fromDegrees(event.lon, event.lat),
            selected: event.id === _selectedEventId,
            // Reports success so the host treats the activation as handled.
            // Returning rebuild()'s value would report false whenever the
            // rebuild short-circuited, and the card would look dead.
            onActivate: () => {
              layer.selectEvent(event.id);
              return true;
            },
          }),
        ),
        eventBudget,
      ),
    ];
    overlayHost.setEntries(LAYER_ID, overlayEntries, {
      cohortLimit: STORM_OVERLAY_COHORT_LIMIT,
      collisionCapacity: STORM_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });

    _stats = {
      windowKey: key,
      fromYear: _window.fromYear,
      toYear: _window.toYear,
      includeHail: _includeHail,
      includeWind: _includeWind,
      showEvents: _showEvents,
      cellsScored: rows.length,
      cellsAvailable: _dataset.cells.length,
      eventsShown: _showEvents,
      caveats: STORM_METHOD_CAVEATS,
    };
    notify();
    return true;
  }

  const layer = {
    id: LAYER_ID,
    name: isExpected ? 'Hail & Wind — Expected Loss' : 'Hail & Wind — Observed',
    icon: isExpected ? '📉' : '🧊',
    source: STORM_SOURCE_BADGE,
    updateInterval: 0,

    init(viewer) {
      if (_viewer) throw new Error('Storm layer is already initialized');
      _viewer = viewer;
      // Seed once, from whichever layer starts first, and follow the sibling
      // from here on. Seeding later would overwrite the established values with
      // a second layer's defaults, making the outcome depend on load order.
      const seeded = seedStormOptions({
        fromYear: _requestedFromYear ?? _window.fromYear,
        includeHail: _includeHail,
        includeWind: _includeWind,
        surface: _surface,
      });
      // Adopt whatever the bag says. For the first layer that is its own
      // values and this is a no-op; for the second it is the sibling's, and
      // skipping this left the later layer sitting on its own defaults.
      adoptSiblingOptions(seeded);
      if (!unsubscribeSibling) {
        unsubscribeSibling = subscribeStormOptions(adoptSiblingOptions);
      }
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(LAYER_ID, false);
      console.log('[Data:Storm] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(LAYER_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(LAYER_ID);
      overlayHost.setVisible(LAYER_ID, false);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      if (_dataset) {
        // rebuild() reports whether the *scene* changed, and returns false when
        // there was nothing to do. update() has to report success instead: the
        // manager reads a false return as a rejected lifecycle transition, so
        // re-enabling a layer whose entities were still on screen and whose
        // window was unchanged failed the whole enable with "Could not enable
        // the requested layer".
        rebuild();
        return true;
      }
      if (_loading) return false;
      _loading = true;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const dataset = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _dataset = dataset;
        // Restored durable options land before the first update (the manager
        // applies params after init and before enable), so a naive assignment
        // here would discard a share link's year window the moment the
        // snapshot arrived. Re-apply the recorded intent instead.
        if (_pendingParams) applyParams(_pendingParams);
        else
          _window = {
            fromYear: dataset.earliestYear ?? 1955,
            toYear: dataset.latestYear ?? new Date().getFullYear(),
          };
        const changed = rebuild(true);
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:Storm] Loaded ${dataset.cells.length} cells, ${dataset.significantEvents.length} events, ${dataset.counties.length} counties`,
        );
        return changed;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || 'Storm snapshot unavailable';
        console.warn('[Data:Storm]', _lastError);
        notify();
        return false;
      } finally {
        _loading = false;
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      unsubscribeSibling?.();
      unsubscribeSibling = null;
      _viewer = null;
      _enabled = false;
      _listeners.clear();
      overlayHost.clearSource(LAYER_ID);
      overlayHost.setVisible(LAYER_ID, false);
      if (_dataSource) {
        viewer?.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _dataset = null;
      _rows = [];
      _stats = null;
    },

    // ── Public control surface ───────────────────────────────────────────

    /**
     * Filter this surface to an isolated area.
     *
     * Part of the area-scoping contract shared with `storm-reports`. The area
     * is part of the rebuild key, so changing it repaints immediately; cells are
     * tested at their own centre and counties at theirs.
     *
     * @param {object|null} area an isolation area, or null
     * @returns {boolean} whether an area is in force
     */
    setIsolation(area) {
      const next =
        area && typeof area === 'object' ? (area.area ?? area) : null;
      if (next === _isolationArea) return Boolean(_isolationArea);
      _isolationArea = next;
      rebuild(true);
      notify();
      return Boolean(_isolationArea);
    },

    /** @returns {object|null} the area in force, or null. */
    getIsolation() {
      return _isolationArea;
    },

    /** Set the inclusive year window and rebuild. @param {number} fromYear @param {number} toYear */
    setYearWindow(fromYear, toYear) {
      if (!_dataset) return false;
      const latest = _dataset.latestYear ?? new Date().getFullYear();
      const from = Math.max(
        1950,
        Math.min(latest, Math.floor(Number(fromYear))),
      );
      const to = Math.max(from, Math.min(latest, Math.floor(Number(toYear))));
      if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
      _window = { fromYear: from, toYear: to };
      return rebuild();
    },

    /** @returns {{fromYear:number,toYear:number}} */
    getYearWindow() {
      return { ..._window };
    },

    /** @param {boolean} enabled */
    setHailEnabled(enabled) {
      _includeHail = Boolean(enabled);
      return rebuild();
    },

    /** @param {boolean} enabled */
    setWindEnabled(enabled) {
      _includeWind = Boolean(enabled);
      return rebuild();
    },

    /** @param {boolean} enabled */
    setEventsVisible(enabled) {
      _showEvents = Boolean(enabled);
      return rebuild();
    },

    /**
     * Switch what the observed layer colours by.
     *
     * @param {'damage'|'radar-gap'|'vs-expected'} surface
     * @returns {boolean} True when the scene changed.
     */
    setSurface(surface) {
      if (!STORM_OBSERVED_SURFACES.includes(surface)) return false;
      if (surface === _surface) return false;
      _surface = surface;
      return rebuild(true);
    },

    /** @returns {'damage'|'radar-gap'|'vs-expected'} */
    getSurface() {
      return _surface;
    },

    /**
     * Cells whose radar hail coverage far exceeds their filed reports.
     *
     * @param {number} [limit]
     * @returns {object[]}
     */
    getReportingGaps(limit = 25) {
      if (!_dataset) return [];
      return _rows
        .map((row) => ({ row, gap: radarGapScore(row) }))
        .filter((entry) => entry.gap)
        .sort((a, b) => b.gap.ratio - a.gap.ratio)
        .slice(0, Math.max(0, limit))
        .map((entry) => entry.row);
    },

    /**
     * Counties where observed reports outrun the FEMA modelled rate.
     *
     * @param {number} [limit]
     * @returns {object[]}
     */
    getWorstOverperformers(limit = 25) {
      if (!_dataset) return [];
      return scoreCounties(_dataset.counties, {
        fromYear: _window.fromYear,
        toYear: _window.toYear,
        limit,
        includeHail: _includeHail,
        includeWind: _includeWind,
      })
        .map((row) => ({
          row,
          ratio: expectedRatioScore({ ...row, observed: row.observed }),
        }))
        .filter((entry) => entry.ratio)
        .sort((a, b) => b.ratio.ratio - a.ratio.ratio)
        .slice(0, Math.max(0, limit))
        .map((entry) => entry.row);
    },

    /**
     * One significant event by id, for the drill-down inspector.
     *
     * @param {string} id
     * @returns {object|null}
     */
    getEvent(id) {
      if (!_dataset) return null;
      return _dataset.significantEvents.find((e) => e.id === id) || null;
    },

    /** @param {string|null} id */
    selectEvent(id) {
      _selectedEventId = id || null;
      return rebuild();
    },

    /** @returns {string|null} */
    getSelectedEvent() {
      return _selectedEventId;
    },

    /** @param {string|null} key "i:j" */
    selectCell(key) {
      _selectedCellKey = key || null;
      return rebuild();
    },

    /** Scored cells for the current window, best first. */
    getScoredCells(limit = 50) {
      return _rows.slice(0, Math.max(0, limit));
    },

    /** Counties ranked by the same blend. */
    getRankedCounties(limit = 25, options = {}) {
      if (!_dataset) return [];
      return scoreCounties(_dataset.counties, { ...options, limit });
    },

    /** Search counties by name or state, for the area picker and voice. */
    findCounties(query, limit = 10) {
      if (!_dataset) return [];
      return searchCounties(_dataset.counties, query, limit);
    },

    /** Single county record by FIPS, with its FEMA NRI attributes. */
    getCounty(fips) {
      return _dataset?.countiesByFips?.get(String(fips)) || null;
    },

    /** Counties intersecting a geographic point, nearest centroid first. */
    getCountiesNearPoint(lat, lon, limit = 5) {
      if (!_dataset || !Number.isFinite(lat) || !Number.isFinite(lon))
        return [];
      return _dataset.counties
        .map((county) => {
          const center = polygonCenter(county.geometry);
          if (!center) return null;
          const dLat = (center.lat - lat) * 111;
          const dLon =
            (center.lon - lon) * 111 * Math.cos((lat * Math.PI) / 180);
          return { county, km: Math.hypot(dLat, dLon) };
        })
        .filter(Boolean)
        .sort((a, b) => a.km - b.km)
        .slice(0, limit)
        .map((entry) => entry.county);
    },

    /** Subscribe to stats updates. @param {(stats:object|null)=>void} listener @returns {()=>void} Unsubscribe. */
    subscribe(listener) {
      _listeners.add(listener);
      listener(layer.getStats());
      return () => _listeners.delete(listener);
    },

    /**
     * Layer-panel row controls: hazard toggles, a decade scrub, and the county
     * picker that answers "track this area".
     *
     * The chips are the whole user-facing control surface for this layer, so the
     * caveats are carried here rather than hidden in a help page. A risk map
     * whose method notes are one click away reads as a forecast; one that names
     * its own limits in the panel reads as evidence.
     *
     * @returns {{chips: Array<object>, legend: Array<object>, list: object|null}}
     */
    getRowControls() {
      const ready = Boolean(_dataset) && _enabled;
      const stats = layer.getStats();
      const window = layer.getYearWindow();
      const caveat = STORM_METHOD_CAVEATS[0];
      // The expected layer has no events, no radar, and no cell grid to switch
      // between, so it gets the hazard and decade controls only.
      if (isExpected) {
        return {
          chips: [
            {
              id: 'storm-hail',
              label: 'HAIL',
              title: 'Include hail in the expected-loss blend',
              disabled: !ready,
              active: _includeHail,
              // Declarative, not onClick: layerPanel routes a chip with `params`
              // through setLayerParams({origin:'user'}), which is the only path
              // that persists the choice into the share link.
              params: { includeHail: !_includeHail },
            },
            {
              id: 'storm-wind',
              label: 'WIND',
              title: 'Include wind in the expected-loss blend',
              disabled: !ready,
              active: _includeWind,
              params: { includeWind: !_includeWind },
            },
            ...decadeChips(ready, window, _dataset),
            {
              id: 'storm-full',
              label: 'FULL',
              title: 'Show the whole record',
              disabled: !ready,
              onClick: () =>
                layer.setYearWindow(
                  _dataset?.earliestYear ?? 1955,
                  _dataset?.latestYear,
                ),
            },
          ],
          legend: [
            {
              label: 'Expected annual loss',
              color: '#ff4040',
              count: stats.countiesScored ?? 0,
              blurb: `FEMA National Risk Index expected annual loss per county, ${window.fromYear}–${window.toYear} window. Modelled per-dollar rates, not a forecast for any specific house. ${caveat}`,
            },
          ],
        };
      }
      return {
        chips: [
          {
            id: 'storm-hail',
            label: 'HAIL',
            title: 'Include hail reports in the score',
            disabled: !ready,
            active: _includeHail,
            // Declarative, not onClick: layerPanel routes a chip with `params`
            // through setLayerParams({origin:'user'}), which is the only path
            // that persists the choice into the share link.
            params: { includeHail: !_includeHail },
          },
          {
            id: 'storm-wind',
            label: 'WIND',
            title: 'Include wind reports in the score',
            disabled: !ready,
            active: _includeWind,
            params: { includeWind: !_includeWind },
          },
          {
            id: 'storm-events',
            label: 'EVENTS',
            title: 'Show individual significant events and their tracks',
            disabled: !ready,
            onClick: () => layer.setEventsVisible(!_showEvents),
          },
          // Which surface the layer is colouring by. The radar and
          // observed-vs-expected data was already loaded and scored but had no
          // way to be reached, so it was only ever visible in tests.
          {
            id: 'storm-surface-damage',
            label: 'DAMAGE',
            title: 'Blended hail and wind damage likelihood',
            disabled: !ready,
            active: _surface === STORM_SURFACE_DAMAGE,
            params: { surface: STORM_SURFACE_DAMAGE },
          },
          {
            id: 'storm-surface-radar-gap',
            label: 'RADAR GAP',
            title:
              'Cells where radar saw hail cores on days nobody filed a report',
            disabled: !ready || !_dataset?.radarByCell?.size,
            active: _surface === STORM_SURFACE_RADAR_GAP,
            params: { surface: STORM_SURFACE_RADAR_GAP },
          },
          {
            id: 'storm-surface-vs-expected',
            label: 'vs EXPECTED',
            title:
              'Observed reports against the containing county’s FEMA modelled rate',
            disabled: !ready,
            active: _surface === STORM_SURFACE_VS_EXPECTED,
            params: { surface: STORM_SURFACE_VS_EXPECTED },
          },
          // One chip per decade, each setting the window to "this decade onward".
          //
          // The previous three fixed presets (1950+/2000+/2015+) were the only
          // time control, and 2015+ was the least honest of them: it landed
          // mid-decade, so the count was prorated out of a 2010-2019 bucket and
          // shown as though it were a real recent history. With per-year tallies
          // a decade boundary is exact, so these are real windows.
          ...decadeChips(ready, _window, _dataset),
          {
            id: 'storm-full',
            label: 'FULL',
            title: 'Show the whole record',
            disabled: !ready,
            active:
              ready &&
              _window.fromYear <=
                (decadeStartFor(_dataset?.earliestYear) ?? 1955),
            onClick: () =>
              layer.setYearWindow(
                _dataset?.earliestYear ?? 1955,
                _dataset?.latestYear,
              ),
          },
        ],
        legend: [
          {
            label: 'Damage likelihood',
            color: '#ff4040',
            count: stats.cellsScored,
            blurb: `Red to blue: blended likelihood that a residential structure in each ${STORM_FINE_GRID_DEG}° cell is hit by damaging hail or wind, over ${window.fromYear}–${window.toYear}. ${caveat}`,
          },
        ],
      };
    },

    /**
     * Analyst query engine seam. Returns scored cells and significant events as
     * plain JSON-safe records. On-demand only — called at most once per spoken
     * query, never per frame.
     * @param {number} [maxCount]
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataset || !_enabled) return [];
      const limit = Math.max(1, Math.floor(Number(maxCount) || 2000));
      const out = [];
      // The expected layer's unit is the county, so it hands back county
      // records. Handing back cell records there would give the analyst engine
      // a field vocabulary the rows do not have.
      const mapRow = isExpected ? mapAnalystCountyRecord : mapAnalystCellRecord;
      for (const row of _rows) {
        if (out.length >= limit) break;
        out.push(mapRow(row));
      }
      if (_showEvents) {
        for (const event of _dataset.significantEvents) {
          if (out.length >= limit) break;
          if (event.year == null) continue;
          if (event.year < _window.fromYear || event.year > _window.toYear)
            continue;
          out.push(mapAnalystEventRecord(event, out.length));
        }
      }
      return out;
    },

    /**
     * Apply manager-owned durable options (share restore, and panel chips that
     * declare `params` instead of `onClick`).
     *
     * Partial: only keys present in `params` are touched, so a chip that flips
     * one hazard does not overwrite the year window in durable state.
     *
     * @param {object} [params]
     * @returns {boolean} False rejects the whole intent.
     */
    setParams(params = {}) {
      return applyParams(params);
    },

    /**
     * Live durable-option state.
     *
     * Reports the recorded intent where one exists, because params are applied
     * before the snapshot loads and the derived window would otherwise report
     * the default back to the coordinator.
     */
    getParams() {
      return {
        fromYear: _requestedFromYear ?? _window.fromYear,
        includeHail: _includeHail,
        includeWind: _includeWind,
        // The expected layer cannot honour a surface, but it shares the option
        // owner with storm-observed. Reporting its own local default here would
        // let a write that passes through this layer reset the observed
        // layer's surface, so echo back what the bag actually said.
        surface: _pendingParams?.surface ?? _surface,
      };
    },

    /**
     * The CustomDataSource this layer draws into.
     *
     * Exposed so tests can inspect the actual entity shapes. The county
     * polygon geometry is the kind of thing that passes a unit test on the
     * data and still renders as a single vertex, so it needs checking against
     * what the scene really holds.
     *
     * @returns {object|null}
     */
    getDataSourceForTest() {
      return _dataSource;
    },

    getStats() {
      return {
        facet,
        surface: _surface,
        loading: _loading,
        loaded: Boolean(_dataset),
        fromYear: _window.fromYear,
        toYear: _window.toYear,
        includeHail: _includeHail,
        includeWind: _includeWind,
        showEvents: _showEvents,
        cellsScored: _rows.length,
        significantEvents: _dataset?.significantEvents.length ?? 0,
        counties: _dataset?.counties.length ?? 0,
        earliestYear: _dataset?.earliestYear ?? null,
        latestYear: _dataset?.latestYear ?? null,
        snapshotBuiltAt: _dataset?.meta?.builtAt ?? null,
        joinCoverage: _dataset?.stats
          ? Math.round(
              (100 * _dataset.stats.cellsWithCounty) /
                Math.max(
                  1,
                  _dataset.stats.cellsWithCounty +
                    _dataset.stats.cellsWithoutCounty,
                ),
            )
          : null,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };

  return layer;
}

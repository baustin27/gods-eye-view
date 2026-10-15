/**
 * Data scope — the user-facing choice between "everything the provider has" and
 * "just the area on screen".
 *
 * This module is deliberately pure: no viewer, no network, no settings state.
 * It owns the shape of a region and the rule for turning a camera into one, so
 * the settings UI, the layer controllers and the server proxies can all agree on
 * what "the viewport" means without importing each other.
 *
 * Two reasons the region is quantized rather than taken raw:
 *
 *  - QUOTA. FIRMS costs one transaction per source per request against a hard
 *    5,000/10min budget (server/providers/firms.js). A cache key derived from a
 *    raw camera rectangle misses on every pan, so panning would spend quota
 *    continuously. Snapping outward to a grid means a whole drag usually lands
 *    on one or two keys.
 *  - STABILITY. A key that changes on every frame also defeats single-flight
 *    and coalescing, which are what make a rapid re-fetch safe.
 */

export const SCOPE_GLOBAL = 'global';
export const SCOPE_VIEWPORT = 'viewport';

export const DATA_SCOPE_MODES = [SCOPE_GLOBAL, SCOPE_VIEWPORT];
export const DEFAULT_DATA_SCOPE = SCOPE_GLOBAL;

/** Largest edge length a viewport region may span, in degrees. */
export const VIEWPORT_SCOPE_MAX_SPAN_DEG = 1;

/**
 * Smallest edge length.
 *
 * Deliberately small: this used to be 0.25°, which silently widened a
 * street-level view into a quarter-degree box — a few kilometres — so zooming
 * in could never tighten the request. It is only high enough that a camera
 * looking almost straight down still asks for something the providers accept.
 */
export const VIEWPORT_SCOPE_MIN_SPAN_DEG = 0.02;

/**
 * Quantize grid as a function of the requested span.
 *
 * A single fixed grid cannot serve both ends of the zoom range. At 0.5° a
 * city-scale view wastes ~25 km of request on every edge, and no amount of
 * zooming refines it; at 0.05° the same grid makes every pan a new cache key,
 * and FIRMS charges a transaction per miss.
 *
 * So the step tracks the span: coarse requests get a coarse grid, tight
 * requests get a tight one. Each tier keeps the requested span within roughly
 * one to two steps, which bounds both waste and churn.
 *
 * @param {number} spanDeg requested edge length in degrees
 * @returns {number} grid step in degrees
 */
export function quantizeStepForSpan(spanDeg) {
  if (spanDeg <= 0.1) return 0.02;
  if (spanDeg <= 0.25) return 0.05;
  if (spanDeg <= 0.5) return 0.1;
  return 0.25;
}

/** @returns {'global'|'viewport'} */
export function normalizeDataScopeMode(value) {
  return DATA_SCOPE_MODES.includes(value) ? value : DEFAULT_DATA_SCOPE;
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Clamp one value into [min, max]. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * A region as four degrees, or null when the input cannot describe one.
 *
 * @typedef {{south: number, west: number, north: number, east: number}} Region
 */
function toRegion(south, west, north, east) {
  if (![south, west, north, east].every(isFiniteNumber)) return null;
  if (south < -90 || north > 90 || south >= north) return null;
  if (west < -180 || east > 180) return null;
  return { south, west, north, east };
}

/**
 * Turn a camera view rectangle into the region the providers will be asked for.
 *
 * Outward snapping is deliberate: rounding inward would exclude features that
 * are actually on screen at the region edge, which is the one failure a user
 * notices immediately.
 *
 * @param {{south: number, west: number, north: number, east: number}} rect
 *        view rectangle in degrees
 * @returns {Region|null}
 */
export function regionFromViewRect(rect) {
  const source = toRegion(rect?.south, rect?.west, rect?.north, rect?.east);
  if (!source) return null;

  const spanLat = clamp(
    source.north - source.south,
    VIEWPORT_SCOPE_MIN_SPAN_DEG,
    VIEWPORT_SCOPE_MAX_SPAN_DEG,
  );
  const spanLon = clamp(
    source.east - source.west,
    VIEWPORT_SCOPE_MIN_SPAN_DEG,
    VIEWPORT_SCOPE_MAX_SPAN_DEG,
  );

  const centerLat = (source.south + source.north) / 2;
  const centerLon = (source.west + source.east) / 2;

  const step = quantizeStepForSpan(Math.max(spanLat, spanLon));
  // Grid snapping must round *outward*, or the region would silently exclude
  // part of what the user can see. A plain Math.floor does not guarantee that:
  // 38.9 / 0.1 is 388.99999999999994, so flooring snaps 38.9 DOWN to 38.8 and
  // the provider is then asked about a box that misses the visible strip. So a
  // value sitting on the grid within float noise is treated as exactly on the
  // grid, and only genuinely-off-grid values round outward.
  //
  // Snapped values are then cleaned to the grid's own precision. Without this,
  // -2102 * 0.05 evaluates to -105.10000000000001, which is *less* than
  // -105.1 and makes a correctly-rounded region look like it under-covers — and
  // pollutes every cache key derived from it.
  const decimals = (String(step).split('.')[1] || '').length;
  const clean = (v) => Number(v.toFixed(decimals + 2));
  const onGrid = (q) => Math.abs(q - Math.round(q)) < 1e-9;
  /** Snap to a grid line, guaranteeing the result stays on the requested side. */
  const snap = (v, index) => {
    const q = v / step;
    let snapped = clean((onGrid(q) ? Math.round(q) : index(q)) * step);
    // Belt and braces: never trust arithmetic for a containment guarantee.
    // Compared with a tolerance, because `clean` may land exactly on v's grid
    // point while v itself still carries float noise — an exact comparison
    // there reads "snapped > v" and shoves the region a whole cell further
    // out than the view asked for.
    if (index === Math.floor && snapped > v + 1e-9) {
      snapped = clean(snapped - step);
    }
    if (index === Math.ceil && snapped < v - 1e-9) {
      snapped = clean(snapped + step);
    }
    return snapped;
  };
  const floorTo = (v) => snap(v, Math.floor);
  const ceilTo = (v) => snap(v, Math.ceil);

  const south = clamp(floorTo(centerLat - spanLat / 2), -90, 90);
  const north = clamp(ceilTo(centerLat + spanLat / 2), -90, 90);
  // Longitude snapping is allowed to exceed a grid cell at the antimeridian so a
  // region never inverts, which a provider would reject outright.
  const west = clamp(floorTo(centerLon - spanLon / 2), -180, 180);
  const east = clamp(ceilTo(centerLon + spanLon / 2), -180, 180);

  return south < north && west <= east ? { south, west, north, east } : null;
}

/**
 * The region as `south,west,north,east`, our own query form.
 *
 * This is the value carried on `?bbox=` between the app and our proxies. It is
 * deliberately latitude-first because that is the convention the rest of the
 * codebase already speaks (the camera bias string, the installations route).
 *
 * It is NOT the order every upstream wants — see `regionToFirmsBbox`.
 *
 * Two decimals is well under the 0.5° grid, so equal keys always mean the same
 * box. Never feed the result upstream as coordinates — round-trips through a
 * query string should not be able to drift.
 */
export function regionKey(region) {
  if (!region) return '';
  const f = (v) => v.toFixed(2);
  return `${f(region.south)},${f(region.west)},${f(region.north)},${f(region.east)}`;
}

/** Our `south,west,north,east` query form, or '' for an unscoped request. */
export function regionToQueryParam(region) {
  return regionKey(region);
}

/**
 * The FIRMS area path segment: `west,south,east,north`.
 *
 * FIRMS orders its bbox longitude-first and answers a latitude-first string
 * with `400 Invalid area coordinate. Expects: [-90..90]`. Verified against the
 * live API: `-105.5,42.5,-104,44` returns 200 CSV, `42.5,-105.5,44,-104`
 * returns 400.
 *
 * @param {Region|null} region
 * @returns {string}
 */
export function regionToFirmsBbox(region) {
  if (!region) return '';
  const f = (v) => v.toFixed(4);
  return `${f(region.west)},${f(region.south)},${f(region.east)},${f(region.north)}`;
}

/**
 * Resolve the region to request for a mode, given the current view.
 *
 * @param {string} mode
 * @param {{south:number,west:number,north:number,east:number}} viewRect
 * @returns {Region|null} null means "no spatial filter"
 */
export function regionForScope(mode, viewRect) {
  if (normalizeDataScopeMode(mode) !== SCOPE_VIEWPORT) return null;
  return regionFromViewRect(viewRect);
}

/**
 * Parse a `south,west,north,east` query value into a region.
 *
 * Shared by the client that produces the value and the proxy that validates
 * it, so the two cannot disagree about what is acceptable. An unparseable
 * region is REFUSED rather than widened to the world: a scope that quietly
 * became global would spend quota on a continent and look like a broken
 * setting rather than a rejected request.
 *
 * @param {unknown} raw
 * @returns {{ok: true, region: Region|null}|{ok: false, error: string}}
 *          region is null for a world request
 */
export function parseRegionParam(raw) {
  if (raw == null || String(raw).trim() === '') {
    return { ok: true, region: null };
  }
  const parts = String(raw)
    .split(',')
    .map((v) => Number(String(v).trim()));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    return {
      ok: false,
      error: 'bbox must be south,west,north,east in degrees',
    };
  }
  const region = toRegion(parts[0], parts[1], parts[2], parts[3]);
  if (!region) {
    return {
      ok: false,
      error: 'bbox is out of range or inverted',
    };
  }
  return { ok: true, region };
}

/**
 * Isolation mode — the pure data half. Three questions, one module:
 *
 *   1. which named place is this   `resolveIsolation(text, { near, findPlace })`
 *   2. what shape is it            `normaliseBbox(bbox)` → one or two boxes
 *   3. is this point inside it     `areaContains(area, lat, lon)`
 *
 * Names come from `adminBoundaries.js` (Natural Earth countries and
 * states/provinces, US Census counties — bundled and offline); this module
 * never loads a pack itself. The place rung (cities, which have no boundary in
 * this data) is injected by the caller as `findPlace`, so Stage 2 owns the
 * place index and this module stays testable without one.
 *
 * WHY BOXES COME BACK AS AN ARRAY. `adminBoundaries.js` unwraps each unit's
 * longitudes around its largest part, so a bundled box may run past the
 * antimeridian: United States `[-187.5, 18.9, -67.0, 71.4]`, Russia
 * `[19.6, 41.2, 190.4, 81.3]`, Fiji `[177.0, -19.2, 181.8, -12.5]`. A naive
 * `lon >= west && lon <= east` silently drops everything near the date line,
 * and no single rectangle can represent a straddling arc — hence
 * `normaliseBbox` returns one box or two. A box is for drawing and for a cheap
 * pre-reject; the polygon test is what answers "inside".
 *
 * WHY THE PRE-REJECT IS LOAD-BEARING. Measured on Node 24 over the
 * deterministic 7,484-row hail-report sample in `isolation.test.mjs` (the
 * Texas box, the central corridor, the rest of the country, an off-box tail):
 * against Texas an unfiltered polygon scan is ~50 ms and 1,342 hits; the box
 * pre-reject cuts it to ~21 ms and 2,680 polygon tests out of 7,484 rows.
 * California is the case that matters most — ~27 ms unfiltered for a handful
 * of hits, under 1 ms with the pre-reject. Scaled to the six-year window
 * (~44,717 rows) the unfiltered scan is ~264 ms, a visible hitch on every
 * filter change. The test counts the polygon tests with and without the
 * pre-reject, so the saving cannot be lost by accident.
 *
 * HONEST LIMITS, both inherited from the bundles rather than hidden here:
 *   - A place is a point with a box around it, not a boundary. Places are
 *     marked `approximate` everywhere they surface, and `describeIsolation`
 *     says so in words.
 *   - The stored rings are flat in [-180, 180] (every bundled vertex is inside
 *     that range), so the even-odd test is exact for a point inside it but
 *     loses the sliver of a unit sitting immediately west of the +180 seam —
 *     Chukotka at 64.7°N reads inside at 178.5°E and outside at 179.5°E, though
 *     its own box runs on to 190.4°. The pre-reject admits both points; the
 *     flat ring is what decides them, and `areaContains` is deliberately
 *     identical to `polygonsContain` on everything the pre-reject keeps.
 *
 * PURE data module — no Cesium, no DOM, node-testable.
 *
 * @module data/isolation
 */

import { findAdminArea, polygonsContain } from './adminBoundaries.js';

/**
 * What an isolation can be. A `place` is the approximate one: a point with a
 * radius, because no city boundary ships with these bundles.
 */
export const ISOLATION_KINDS = Object.freeze([
  'country',
  'state',
  'county',
  'place',
]);

/** Default box for a place with no extent of its own: ±0.25° (≈ ±28 km). */
export const PLACE_BOX_DEG = 0.25;

const KIND_ALIASES = new Map([
  ['country', 'country'],
  ['nation', 'country'],
  ['state', 'state'],
  ['province', 'state'],
  ['prefecture', 'state'],
  ['oblast', 'state'],
  ['region', 'state'],
  ['county', 'county'],
  ['parish', 'county'],
  ['borough', 'county'],
  ['municipality', 'county'],
  ['district', 'county'],
  ['census area', 'county'],
  ['place', 'place'],
  ['city', 'place'],
  ['town', 'place'],
  ['village', 'place'],
  ['locality', 'place'],
  ['point', 'place'],
  ['poi', 'place'],
]);

/**
 * Fold any wording for a kind to one of `ISOLATION_KINDS`.
 * @param {string} value
 * @returns {'country'|'state'|'county'|'place'|null}
 */
export function normaliseIsolationKind(value) {
  return (
    KIND_ALIASES.get(
      String(value ?? '')
        .trim()
        .toLowerCase(),
    ) ?? null
  );
}

/** Longitude wrapped into [-180, 180] — the seam always resolves to -180. */
function wrapLon(lon) {
  // Rounded because the wrap is float arithmetic: 19.61 comes back as
  // 19.610000000000014, and a drawing box should not carry that.
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Math.abs(wrapped) < 1e-9 ? 0 : +wrapped.toFixed(9);
}

/**
 * A bounding box as one or two boxes whose longitudes are inside
 * [-180, 180] — a straddling unit becomes two boxes that together cover the
 * whole arc, with the cut at the antimeridian.
 *
 * A box is a drawing and a pre-reject, never an answer to "inside"
 * (`areaContains`).
 *
 * @param {number[]|{bbox:number[]}} bbox `[west, south, east, north]`, west
 *   and east possibly outside [-180, 180]; an area object is also accepted
 * @returns {number[][]} one box, or two for an arc crossing the antimeridian
 */
export function normaliseBbox(bbox) {
  const raw = Array.isArray(bbox) ? bbox : bbox?.bbox;
  if (!Array.isArray(raw) || raw.length < 4) return [];
  const [west, south, east, north] = raw;
  if (![west, south, east, north].every(Number.isFinite)) return [];
  const latMin = Math.min(south, north);
  const latMax = Math.max(south, north);
  const from = wrapLon(west);
  const to = wrapLon(east);
  if (from <= to) return [[from, latMin, to, latMax]];
  // The arc runs east from `from`, over the seam, to `to`.
  return [
    [from, latMin, 180, latMax],
    [-180, latMin, to, latMax],
  ];
}

/**
 * Whether a point falls in one of `boxes`. Only meaningful for boxes from
 * `normaliseBbox` (raw bundles cross the antimeridian and would answer wrong);
 * a raw box or area is normalised first.
 *
 * @param {number[][]} boxes
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function boxesContain(boxes, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const list = Array.isArray(boxes?.[0]) ? boxes : normaliseBbox(boxes ?? null);
  for (const [west, south, east, north] of list)
    if (lat >= south && lat <= north && lon >= west && lon <= east) return true;
  return false;
}

/** Normalised boxes per area, keyed weakly so nothing is retained or mutated. */
const boxCache = new WeakMap();

function boxesOf(area) {
  const cached = boxCache.get(area);
  if (
    cached &&
    cached.raw.length === area.bbox.length &&
    cached.raw.every((value, i) => value === area.bbox[i])
  )
    return cached.boxes;
  const boxes = normaliseBbox(area.bbox);
  boxCache.set(area, { raw: [...area.bbox], boxes });
  return boxes;
}

/** An isolation area, or the `{ area }` wrapper `resolveIsolation` returns. */
function unitOf(area) {
  if (!area || typeof area !== 'object') return null;
  if (Array.isArray(area.bbox)) return area;
  if (Array.isArray(area.area?.bbox)) return area.area;
  return null;
}

/**
 * Whether a point is inside an isolation area.
 *
 * The box is a pre-reject and the polygon test is the answer — for an area
 * with geometry. A place has no geometry here, so its box is the whole area and
 * the caller is expected to read `approximate` on the result (a city is a point
 * with a radius; no city boundary ships with these bundles).
 *
 * @param {object|{area:object}} area an admin/place area, or a
 *   `resolveIsolation` hit
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function areaContains(area, lat, lon) {
  const unit = unitOf(area);
  if (!unit || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (!boxesContain(boxesOf(unit), lat, lon)) return false;
  const { polygons } = unit;
  return Array.isArray(polygons) && polygons.length
    ? polygonsContain(polygons, lat, lon)
    : true;
}

/**
 * A short honest label for the UI — and the one place that says a place is a
 * point with a radius rather than a boundary.
 *
 * @param {object|{area:object}} area
 * @returns {string} e.g. "Travis County, Texas", "Bavaria, Germany",
 *   "New York City — approximate: point with a radius, no boundary data"
 */
export function describeIsolation(area) {
  const unit = unitOf(area);
  if (!unit) return 'unknown area';
  const name = String(unit.name ?? '').trim() || 'this area';
  // A county already carries its state name ("Travis County, Texas" is the
  // pack's `full`), so only add what the name is not already telling you.
  const where =
    String(unit.region ?? '').trim() || String(unit.country ?? '').trim();
  const label = where && !name.includes(where) ? `${name}, ${where}` : name;
  if (hasGeometry(unit)) return label;
  return `${label} — approximate: point with a radius, no boundary data`;
}

/** Whether an area carries real polygons (anything but a place). */
function hasGeometry(area) {
  return Array.isArray(area?.polygons) && area.polygons.length > 0;
}

function pointBox(lat, lon, halfDeg = PLACE_BOX_DEG) {
  return [lon - halfDeg, lat - halfDeg, lon + halfDeg, lat + halfDeg];
}

/**
 * Normalise whatever a place provider returned into the same shape as an
 * `AdminArea`, so callers never branch on kind to draw or test it.
 *
 * @param {object} place
 * @param {string} ask the typed text, used when the provider names nothing
 * @returns {object|null} a place area, or null when there is no usable position
 */
function toPlaceArea(place, ask) {
  if (!place || typeof place !== 'object') return null;
  const lat = Number(place.lat ?? place.latitude);
  const lon = Number(place.lon ?? place.lng ?? place.longitude);
  const halfDeg = Number.isFinite(Number(place.radiusDeg))
    ? Number(place.radiusDeg)
    : PLACE_BOX_DEG;
  const rawBox =
    place.bbox ??
    (Number.isFinite(lat) && Number.isFinite(lon)
      ? pointBox(lat, lon, halfDeg)
      : null);
  if (!normaliseBbox(rawBox).length) return null;
  const label = place.label ?? (Number.isFinite(lat) ? { lat, lon } : null);
  return {
    kind: 'place',
    name: String(place.name ?? '').trim() || ask,
    localName: place.localName ?? null,
    type: place.type ?? 'locality',
    region: place.region ?? null,
    regionCode: place.regionCode ?? null,
    country: place.country ?? null,
    id: place.id ?? null,
    source: place.source ?? 'place-index',
    polygons: [],
    ring: null,
    bbox: rawBox,
    areaKm2: Number.isFinite(Number(place.areaKm2)) ? Number(place.areaKm2) : 0,
    label: label
      ? { lat: Number(label.lat ?? lat), lon: Number(label.lon ?? lon) }
      : null,
    candidates: Number.isFinite(Number(place.candidates))
      ? Number(place.candidates)
      : 1,
    approximate: true,
  };
}

function hit(text, unit) {
  const boxes = boxesOf(unit);
  return {
    ok: true,
    text,
    kind: normaliseIsolationKind(unit.kind) ?? 'place',
    area: unit,
    boxes,
    split: boxes.length > 1,
    approximate: !hasGeometry(unit) || unit.approximate === true,
    describe: describeIsolation(unit),
  };
}

/**
 * Resolve a typed name to an isolation area.
 *
 * Admin areas are tried first; the place rung runs only when a provider is
 * passed, so a caller with no place index still gets every boundary in the
 * bundles. A miss is a value — `{ ok: false, reason }` — because the app's
 * recurring failure is a control that silently does nothing, and "couldn't find
 * that" is the only acceptable other outcome. Nothing here throws for a name
 * that cannot be placed: a provider that rejects or blows up becomes
 * `reason: 'error'`.
 *
 * @param {string} text e.g. "Texas", "Bavaria", "Travis County", "New York"
 * @param {{near?: {lat:number, lon:number}|null, findPlace?: FindPlace|null}} [options]
 *   `near` is the camera's view centre (the tie-break between same-named
 *   units); `findPlace` is the Stage 2 place lookup
 * @returns {Promise<object>} `{ok:true, text, kind, area, boxes, split,
 *   approximate, describe}` or `{ok:false, text, reason, tried, detail?}`
 *   where `reason` is `'empty'`, `'no-match'` or `'error'`
 *
 * @callback FindPlace
 * @param {string} text
 * @param {{near: {lat:number, lon:number}|null}} options
 * @returns {Promise<object|null>} a place: `{name?, country?, region?, id?,
 *   lat?, lon?, bbox?, radiusDeg?, label?, source?}`
 */
export async function resolveIsolation(
  text,
  { near = null, findPlace = null } = {},
) {
  const ask = String(text ?? '').trim();
  if (!ask) return { ok: false, text: '', reason: 'empty', tried: [] };
  const camera =
    Number.isFinite(near?.lat) && Number.isFinite(near?.lon)
      ? { lat: near.lat, lon: near.lon }
      : null;
  const tried = [];
  let failure = null;
  try {
    tried.push('admin');
    const admin = await findAdminArea(ask, { near: camera });
    if (admin) return hit(ask, admin);
  } catch (error) {
    failure = error;
  }
  if (typeof findPlace === 'function') {
    tried.push('place');
    try {
      const place = toPlaceArea(await findPlace(ask, { near: camera }), ask);
      if (place) return hit(ask, place);
    } catch (error) {
      failure = failure ?? error;
    }
  }
  return failure
    ? {
        ok: false,
        text: ask,
        reason: 'error',
        tried,
        detail: String(failure?.message ?? failure),
      }
    : { ok: false, text: ask, reason: 'no-match', tried };
}

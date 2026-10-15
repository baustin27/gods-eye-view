/**
 * Presentation model for the storm intelligence layer.
 *
 * Pure functions over plain records — no Cesium imports — so the colour
 * decisions, the card copy, and the cohort selection are all unit-testable in
 * Node without a viewer. Cesium types appear only at the layer boundary in
 * `index.js`.
 *
 * @module layers/hailwind/model
 */

import {
  severityBand,
  hailSeverity,
  windSeverity,
  describeCellScore,
  DEFAULT_WEIGHTS,
  HAIL_THRESHOLDS,
  WIND_THRESHOLDS,
} from '../../data/stormScoring.js';

/**
 * The two storm layers.
 *
 * Split on the analytical axis rather than the hazard axis: one layer is what
 * actually happened, the other is what FEMA's model says should happen. Putting
 * "observed" and "expected" in the same layer made the comparison a mode you had
 * to remember to switch to; as two layers the comparison is just "turn both on".
 */
export const STORM_FACET_OBSERVED = 'observed';
export const STORM_FACET_EXPECTED = 'expected';
export const STORM_FACETS = Object.freeze([
  STORM_FACET_OBSERVED,
  STORM_FACET_EXPECTED,
]);

/** Layer id for a facet. Also the overlay source id, which the host keys by. */
export function stormLayerId(facet) {
  return facet === STORM_FACET_EXPECTED ? 'storm-expected' : 'storm-observed';
}

/** @deprecated Kept for callers that predate the split. */
export const STORM_OVERLAY_SOURCE_ID = stormLayerId(STORM_FACET_OBSERVED);

/**
 * Ambient card budget. Deliberately far below the host's shared 192-card lane
 * ceiling: a 0.25° grid can produce thousands of high-scoring cells, and
 * letting them all reach the overlay turns the panel into a wall of text.
 */
export const STORM_OVERLAY_COHORT_LIMIT = 24;
export const STORM_OVERLAY_COLLISION_CAPACITY = 24;

/** Beyond this score a cell is drawn as a track-worthy "worst case" marker. */
export const STORM_SIGNIFICANT_SCORE = 0.72;

/**
 * Band colours, matching the FIRMS severity vocabulary so the two layers read
 * as one system. Values are CSS rgb() strings because the overlay host consumes
 * accent strings, not Cesium.Colour.
 */
export const STORM_BAND_ACCENT = Object.freeze({
  red: '255, 64, 64',
  orange: '255, 140, 0',
  yellow: '255, 220, 0',
  blue: '64, 160, 255',
});

/** Hex form for Cesium entity fills, keyed by band. */
export const STORM_BAND_HEX = Object.freeze({
  red: '#ff4040',
  orange: '#ff8c00',
  yellow: '#ffdc00',
  blue: '#40a0ff',
});

/** Alpha ramp so the surface reads as a heat field rather than flat tiles. */
export const STORM_BAND_ALPHA = Object.freeze({
  red: 0.55,
  orange: 0.45,
  yellow: 0.35,
  blue: 0.22,
});

/**
 * Accent for a 0..1 score.
 * @param {number} score
 * @returns {string} "r, g, b"
 */
export function accentForScore(score) {
  return STORM_BAND_ACCENT[severityBand(score)];
}

/** Cesium fill colour for a 0..1 score. */
export function hexForScore(score) {
  return STORM_BAND_HEX[severityBand(score)];
}

/** Fill alpha for a 0..1 score. */
export function alphaForScore(score) {
  return STORM_BAND_ALPHA[severityBand(score)];
}

/** Convert knots to the mph a US homeowner's insurance conversation uses. */
export function knotsToMph(knots) {
  const v = Number(knots);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 1.15078);
}

/**
 * Human label for one cell, for the panel and for the analyst engine.
 *
 * Accepts either a bundled dataset cell or a scored row from `scoreCells`. The
 * radar fields only exist on the latter, so a plain cell simply renders its
 * report history — which is the honest answer, since radar genuinely is a
 * separate record with a different start date.
 *
 * @param {object} cell
 * @returns {{title:string, details:string[]}}
 */
export function describeCell(cell) {
  const title = `${Math.round(cell.hailCount || 0).toLocaleString()} hail · ${Math.round(
    cell.windCount || 0,
  ).toLocaleString()} wind`;
  const details = [];
  if (cell.maxHailIn)
    details.push(
      `largest ${cell.maxHailIn.toFixed(2)}" (${severityWord(cell.maxHailIn)})`,
    );
  const mph = knotsToMph(cell.maxWindKt);
  if (mph) details.push(`strongest ${mph} mph`);
  if (cell.compoundDays > 0)
    details.push(
      `${cell.compoundDays.toLocaleString()} days with both hail and wind`,
    );
  if (cell.radarHailDays > 0) {
    const mm = cell.radarMaxHailMm || 0;
    details.push(
      `radar hail cores on ${cell.radarHailDays.toLocaleString()} days since 2021${
        mm > 0 ? `, largest core ${Math.round(mm / 25.4)}"` : ''
      }`,
    );
  }
  if (cell.reportingGap) {
    details.push(
      'radar shows far more hail than was reported — likely under-reported',
    );
  }
  if (cell.firstYear && cell.lastYear)
    details.push(`record ${cell.firstYear}–${cell.lastYear}`);
  return { title, details };
}

/** Damage-band word for a hail diameter, using SPC's published size names. */
export function severityWord(inches) {
  const v = Number(inches) || 0;
  if (v >= HAIL_THRESHOLDS.significant) return 'significant hail';
  if (v >= HAIL_THRESHOLDS.shingle) return 'large hail';
  if (v >= HAIL_THRESHOLDS.severe) return 'severe hail';
  if (v >= HAIL_THRESHOLDS.damaging) return 'damaging hail';
  return 'sub-damage-threshold hail';
}

/** Damage-band word for a wind gust, in knots. */
export function windSeverityWord(knots) {
  const v = Number(knots) || 0;
  if (v >= WIND_THRESHOLDS.saturating) return 'extreme wind';
  if (v >= WIND_THRESHOLDS.structural) return 'severe structural wind';
  if (v >= WIND_THRESHOLDS.severe) return 'destructive wind';
  if (v >= WIND_THRESHOLDS.damaging) return 'damaging wind';
  return 'sub-damage-threshold wind';
}

/**
 * Build the overlay card for one scored cell.
 *
 * @param {object} input
 * @param {object} input.row Row from `scoreCells`.
 * @param {Cesium.Cartesian3} input.position Ground anchor.
 * @param {boolean} [input.selected]
 * @param {object} [input.weights]
 * @returns {object} worldOverlay entry
 */
export function createCellOverlayEntry({
  row,
  position,
  selected = false,
  cullPosition,
  weights = DEFAULT_WEIGHTS,
}) {
  const { title, details, caveat } = describeCellScore(row, weights);
  // The caveat is part of the disclosure, not decoration: it is what tells a
  // reader that counts may be apportioned, or that radar runs large. It was
  // computed by the scorer and then dropped here, so the panel promised
  // caveats the card never showed.
  return {
    id: `storm-cell:${row.key}`,
    position,
    cullPosition: cullPosition || position,
    variant: selected ? 'selected' : 'card',
    cardStyle: 'tactical',
    title,
    details,
    caveat,
    accent: accentForScore(row.score),
    priority: Math.round(row.score * 1000),
    collisionGroup: 'ambient-card',
    gapPx: 12,
    selected,
    actionable: false,
    interactive: false,
    protected: selected,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    verticalOnly: true,
    viewportMargin: 4,
  };
}

/**
 * Build the overlay card for one significant individual event.
 *
 * @param {object} input
 * @param {object} input.event Normalized event record.
 * @param {Cesium.Cartesian3} input.position
 * @param {boolean} [input.selected]
 * @returns {object} worldOverlay entry
 */
export function createEventOverlayEntry({
  event,
  position,
  selected = false,
  onActivate = null,
  onInspect = null,
}) {
  const { title, details, caveat } = onInspect
    ? onInspect(event)
    : describeEvent(event);
  return {
    id: `storm-event:${event.id}`,
    position,
    cullPosition: position,
    variant: selected ? 'selected' : 'card',
    cardStyle: 'tactical',
    title,
    details,
    caveat,
    // Without an accessibilityLabel the entry is unreachable by keyboard, and
    // without `activate` a click does nothing — which is how this builder sat
    // unused for so long: it produced an entry that looked interactive and was
    // neither reachable nor actionable.
    accessibilityLabel: `${title}. ${details.join('. ')}`,
    ...(typeof onActivate === 'function' ? { activate: onActivate } : {}),
    accent: STORM_BAND_ACCENT[event.hazard === 'hail' ? 'red' : 'orange'],
    priority: Math.round((Number(event.severity) || 0) * 1000),
    collisionGroup: 'storm-event-card',
    gapPx: 12,
    selected,
    actionable: true,
    interactive: true,
    protected: selected,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    verticalOnly: true,
    viewportMargin: 4,
  };
}

/**
 * Keep the strongest cells for the ambient overlay, stable by identity.
 * @param {object[]} entries
 * @param {number} [limit]
 * @returns {object[]}
 */
export function selectCellOverlayCohort(
  entries,
  limit = STORM_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * Map one event to the JSON-safe analyst record shape.
 * @param {object} event
 * @param {number} index
 * @returns {object}
 */
export function mapAnalystEventRecord(event, index = 0) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  return {
    id: text(event.id) || `STORM-${String(index).padStart(6, '0')}`,
    hazard: event.hazard === 'hail' ? 'hail' : 'wind',
    // Reported in the unit the engine filters on, with the other unit attached
    // so a spoken "hail over 2 inches" resolves without a unit conversion step.
    magnitude: num(event.magnitude),
    magnitudeMph: event.hazard === 'wind' ? knotsToMph(event.magnitude) : null,
    severity:
      num(event.severity) ??
      (event.hazard === 'hail'
        ? r3(hailSeverity(event.magnitude))
        : r3(windSeverity(event.magnitude))),
    year: num(event.year),
    month: num(event.month),
    lat: num(event.lat),
    lon: num(event.lon),
    county: text(event.countyFips),
    state: text(event.state),
    reportedLoss: num(event.reportedLoss),
    hasTrack: Boolean(event.track),
  };
}

const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

/**
 * Map one scored cell to the JSON-safe analyst record shape.
 * @param {object} row Row from `scoreCells`.
 * @returns {object}
 */
export function mapAnalystCellRecord(row) {
  return {
    id: `cell:${row.key}`,
    score: r3(row.score),
    band: row.band,
    hailReports: Math.round(row.hailCount || 0),
    windReports: Math.round(row.windCount || 0),
    maxHailIn: row.maxHailIn ?? null,
    maxWindMph: knotsToMph(row.maxWindKt),
    compoundDays: row.compoundDays || 0,
    observed: r3(row.observed),
    modelled: r3(row.modelled),
    exposure: r3(row.exposure),
    radar: r3(row.radar),
    radarHailDays: row.radarHailDays || 0,
    radarMaxHailMm: row.radarMaxHailMm ?? null,
    reportingGap: row.reportingGap === true,
    county: row.county?.name ?? null,
    state: row.county?.state ?? null,
    lat: row.lat,
    lon: row.lon,
  };
}

export {
  hailSeverity,
  windSeverity,
  severityBand,
  describeCellScore,
  HAIL_THRESHOLDS,
  WIND_THRESHOLDS,
  DEFAULT_WEIGHTS,
};

// --- surfaces ---------------------------------------------------------------

/**
 * What the observed layer is currently colouring by.
 *
 * `damage` is the blended likelihood surface the layer has always shown. The
 * other two exist because the data to answer those questions is already
 * present but was unreachable: radar shows hail cores on days nobody filed a
 * report, and FEMA's expected loss can be compared against what was observed
 * rather than blended into it.
 */
export const STORM_SURFACE_DAMAGE = 'damage';
export const STORM_SURFACE_RADAR_GAP = 'radar-gap';
export const STORM_SURFACE_VS_EXPECTED = 'vs-expected';
export const STORM_OBSERVED_SURFACES = Object.freeze([
  STORM_SURFACE_DAMAGE,
  STORM_SURFACE_RADAR_GAP,
  STORM_SURFACE_VS_EXPECTED,
]);

/**
 * Radar-vs-reporting gap for a cell.
 *
 * A storm reports itself only if someone filed a report. Radar is the only
 * record of hail that fell where nobody was watching, so a cell with many
 * radar core-days against few filed reports is under-reported, not quiet.
 *
 * Returns null when the question is unanswerable — no radar coverage, or no
 * reports at all, where "gap" has no meaning.
 *
 * @param {object} row scored cell row
 * @returns {{ratio:number, hailDays:number, reports:number}|null}
 */
export function radarGapScore(row) {
  const days = Number(row?.radarHailDays) || 0;
  const reports = Number(row?.hailCount) || 0;
  if (days <= 0) return null;
  // Not a gap: radar saw no more days than were filed, which is agreement.
  if (reports > 0 && days <= reports) return null;
  if (reports <= 0) return { ratio: 1, hailDays: days, reports: 0 };
  // Capped: a single storm day against one report is a ratio of 1 and is not
  // evidence of anything, so the scale saturates rather than exploding.
  const ratio = Math.min(1, days / (reports * 8));
  return { ratio, hailDays: days, reports };
}

/**
 * Observed-versus-expected ratio for a cell.
 *
 * Observed is the cell's own report count; expected is the containing county's
 * FEMA NRI annual rate, which is normalised per dollar of building value. A
 * cell reporting far more than its county's modelled rate is a place the model
 * under-rates, which is the actionable reading.
 *
 * Returns null when the county carries no usable NRI rate.
 *
 * @param {object} row scored cell row
 * @returns {{ratio:number, observed:number, expected:number}|null}
 */
export function expectedRatioScore(row) {
  const expected = Number(row?.modelled) || 0;
  const observed = Number(row?.observed) || 0;
  if (expected <= 0) return null;
  return { ratio: clampRatio(observed / expected), observed, expected };
}

/** Map a ratio to 0..1, log-scaled so 10x and 0.1x sit symmetrically. */
function clampRatio(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  // log10 over 3 decades, offset so parity (ratio 1) lands at 0.5.
  return Math.max(0, Math.min(1, (Math.log10(ratio) + 1) / 2));
}

/**
 * Describe a scored county for the expected layer's card.
 *
 * @param {object} row a `scoreCounties` row
 * @returns {{title:string, details:string[], caveat:string|null}}
 */
export function describeCountyScore(row) {
  const details = [];
  if (row.nriHailRating) details.push(`hail risk ${row.nriHailRating}`);
  if (row.nriWindRating) details.push(`wind risk ${row.nriWindRating}`);
  if (Number.isFinite(row.nriHailEal) && row.nriHailEal > 0)
    details.push(
      `hail expected annual loss $${Math.round(row.nriHailEal).toLocaleString()}`,
    );
  if (Number.isFinite(row.nriWindEal) && row.nriWindEal > 0)
    details.push(
      `wind expected annual loss $${Math.round(row.nriWindEal).toLocaleString()}`,
    );
  if (row.hailCount > 0 || row.windCount > 0)
    details.push(
      `observed ${row.hailCount.toLocaleString()} hail / ${row.windCount.toLocaleString()} wind reports`,
    );
  const title = `${row.name}, ${row.st}`;
  return {
    title,
    details,
    caveat:
      'Expected loss is FEMA’s National Risk Index, a modelled per-dollar rate, not a forecast for any specific house.',
  };
}

/**
 * Map a scored county to an overlay entry for the expected layer.
 *
 * @param {{row:object, position:object, selected?:boolean}} input
 * @returns {object}
 */
export function createCountyOverlayEntry({ row, position, selected = false }) {
  const { title, details, caveat } = describeCountyScore(row);
  return {
    id: `storm-county:${row.fips}`,
    position,
    cullPosition: position,
    variant: selected ? 'selected' : 'card',
    cardStyle: 'tactical',
    title,
    details,
    caveat,
    accessibilityLabel: `${title}. ${details.join('. ')}`,
    accent: accentForScore(row.score),
    priority: Math.round(row.score * 1000),
    collisionGroup: 'storm-expected-card',
    gapPx: 12,
    selected,
    actionable: false,
    interactive: false,
    protected: selected,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    verticalOnly: true,
    viewportMargin: 4,
  };
}

/**
 * Map one scored county to a JSON-safe analyst record.
 *
 * Mirrors `mapAnalystCellRecord` so the analyst engine sees the same field
 * vocabulary from both storm layers. Everything is coerced to a finite number
 * or null — a NaN would survive to JSON as `null` and then be spoken as
 * "null" by the voice analyst.
 *
 * @param {object} row a `scoreCounties` row
 * @returns {object}
 */
export function mapAnalystCountyRecord(row) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const text = (v) => (typeof v === 'string' ? v : null);
  return {
    id: `county:${row.fips}`,
    score: num(row.score),
    band: text(row.band),
    county: text(row.name),
    state: text(row.st),
    fips: text(String(row.fips ?? '')),
    hailReports: num(row.hailCount),
    windReports: num(row.windCount),
    maxHailIn: num(row.maxHailIn),
    maxWindMph: knotsToMph(row.maxWindKt),
    observed: num(row.observed),
    modelled: num(row.modelled),
    exposure: num(row.exposure),
    reportedLoss: num(row.reportedLoss),
    population: num(row.population),
    nriHailRating: text(row.nriHailRating),
    nriWindRating: text(row.nriWindRating),
    nriHailEal: num(row.nriHailEal),
    nriWindEal: num(row.nriWindEal),
    firstYear: num(row.firstYear),
    lastYear: num(row.lastYear),
  };
}

/**
 * Describe one significant event for the drill-down inspector.
 *
 * @param {object} event
 * @returns {{title:string, details:string[], caveat:string|null}}
 */
export function describeEvent(event) {
  const details = [];
  details.push(
    event.month
      ? `${event.month}/${event.year}`
      : String(event.year ?? 'unknown year'),
  );
  if (event.hazard === 'hail' && Number.isFinite(event.magnitude))
    details.push(`${event.magnitude.toFixed(2)}" hail`);
  if (event.hazard === 'wind' && Number.isFinite(event.magnitude))
    details.push(`${event.magnitude.toFixed(0)} kt wind`);
  if (event.state) details.push(event.state);
  if (event.reportedLoss)
    details.push(
      `$${Math.round(event.reportedLoss).toLocaleString()} reported`,
    );
  if (event.track?.length >= 2)
    details.push(`tracked across ${event.track.length} points`);
  if (event.pathLenKm) details.push(`${event.pathLenKm.toFixed(0)} km path`);
  return {
    title: `${event.hazard === 'hail' ? 'Hail' : 'Wind'} event ${String(event.id)}`,
    details,
    caveat:
      event.year != null && event.year < 1995
        ? 'Pre-1995 reports are a much sparser record; the absence of an event is not evidence it did not happen.'
        : null,
  };
}

// --- rank-based surface banding ---------------------------------------------
//
// The band thresholds (0.72 / 0.42 / 0.18) are absolute, which made them a
// calibration that silently rots. Correcting the grid bucketing roughly doubled
// the reports attributed to each cell, the log-frequency term rose with it, and
// 29% of the country came out red with the 10th percentile already over the
// red threshold. The next snapshot rebuild would have done it again.
//
// A damage surface is read comparatively — "how does this cell rank against
// its neighbours" — so band on rank and keep the raw score for the card and the
// analyst, where an absolute number is what a reader actually wants.

/** Share of cells in each band, highest first. */
export const STORM_BAND_SHARES = Object.freeze({
  red: 0.1,
  orange: 0.25,
  yellow: 0.4,
});

/**
 * Map every row to a 0..1 rank, where 1 is the highest score in the set.
 *
 * @param {Array<object>} rows
 * @param {(row: object) => number|null} [measure] Defaults to the damage score.
 *   The surface decides which measure the bands describe, so radar-gap ranks by
 *   divergence and vs-expected ranks by the ratio, not by damage.
 * @returns {Map<string, number>}
 */
export function rankScores(rows, measure = (row) => row?.score) {
  const ranks = new Map();
  const scored = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ row, value: measure(row) }))
    .filter((entry) => Number.isFinite(entry.value) && entry.row?.key != null)
    .sort((a, b) => b.value - a.value);
  const n = scored.length;
  if (!n) return ranks;
  scored.forEach((entry, index) => {
    // Equal values share a rank, so a plateau does not split across bands.
    const previous = index > 0 ? scored[index - 1] : null;
    const rank =
      previous && previous.value === entry.value
        ? ranks.get(String(previous.row.key))
        : (n - 1 - index) / (n - 1 || 1);
    ranks.set(String(entry.row.key), rank);
  });
  return ranks;
}

/**
 * Band for a 0..1 rank from {@link rankScores}.
 *
 * @param {number} rank
 * @returns {'red'|'orange'|'yellow'|'blue'}
 */
export function bandForRank(rank) {
  if (!Number.isFinite(rank)) return 'blue';
  if (rank >= 1 - STORM_BAND_SHARES.red) return 'red';
  if (rank >= 1 - STORM_BAND_SHARES.red - STORM_BAND_SHARES.orange)
    return 'orange';
  if (
    rank >=
    1 -
      STORM_BAND_SHARES.red -
      STORM_BAND_SHARES.orange -
      STORM_BAND_SHARES.yellow
  )
    return 'yellow';
  return 'blue';
}

/** Fill colour for a rank. */
export function hexForRank(rank) {
  return STORM_BAND_HEX[bandForRank(rank)];
}

/** Fill alpha for a rank. */
export function alphaForRank(rank) {
  return STORM_BAND_ALPHA[bandForRank(rank)];
}

/** Rank at or above which a cell is outlined as a worst case. */
export const STORM_SIGNIFICANT_RANK = 0.97;

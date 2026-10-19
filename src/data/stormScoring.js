/**
 * Storm damage-likelihood scoring.
 *
 * Pure logic over plain records — no Cesium, no DOM, no fetch — so it runs
 * unchanged in the browser and under the Node test runner.
 *
 * The question this answers is deliberately narrow and is *not* "what will the
 * weather do". It is: **given everything actually observed at this location, how
 * much of the surrounding area's housing stock should a hail-and-wind inspection
 * effort look at first?**
 *
 * Three independent quantities are kept apart on purpose, because conflating
 * them is how these maps usually mislead:
 *
 *  1. Observed hazard   — what storm reports actually recorded here.
 *  2. Modelled hazard   — FEMA's expected annual loss per dollar of building
 *                         value, which folds in vulnerability the report data
 *                         never sees.
 *  3. Exposure          — how many dollars of building are actually at stake.
 *
 * The displayed score is a blend with the weights shown to the user, never a
 * single opaque number.
 *
 * @module data/stormScoring
 */

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/** Damage-relevant hail thresholds, inches (SPC severe/significant lines). */
export const HAIL_THRESHOLDS = Object.freeze({
  damaging: 0.75,
  severe: 1.0,
  shingle: 1.5,
  significant: 2.0,
  saturating: 3.0,
});

/** Damaging-wind thresholds, knots. */
export const WIND_THRESHOLDS = Object.freeze({
  damaging: 50,
  severe: 58,
  structural: 75,
  saturating: 100,
});

/**
 * Read a storm statistic that the loader names one way and the raw snapshot
 * another.
 *
 * The normalized records produced by `stormDatasets.toCellRecord` /
 * `toCountyRecord` use descriptive names (`maxHailIn`), while the compact
 * GeoJSONL payload uses short keys (`hx`). Scoring against only one of the two
 * silently yields zero severity, zero compound days, or no record span — the
 * score still renders, it is just quietly wrong. Both spellings resolve here so
 * the scorer is correct on raw build output and on loaded records alike.
 *
 * @param {object} record
 * @param {string} longKey Normalized field name.
 * @param {string} shortKey Compact snapshot key.
 * @param {*} [fallback]
 * @returns {*}
 */
function stat(record, longKey, shortKey, fallback = undefined) {
  const value = record?.[longKey] ?? record?.[shortKey];
  return value === undefined || value === null ? fallback : value;
}

/**
 * Numeric record span for either spelling of the year fields.
 * @param {object} record
 * @returns {{start:number|undefined, end:number|undefined}}
 */
function recordSpan(record) {
  return {
    start: stat(record, 'firstYear', 'y0'),
    end: stat(record, 'lastYear', 'y1'),
  };
}

/**
 * Decode the per-year tallies a snapshot carries.
 *
 * The on-disk form is a flat array of TRIPLES - year, hail, wind, year, hail,
 * wind - because a JSON object with 69 numeric keys per county is far larger
 * than the same numbers in a row, and there are 3,234 counties.
 *
 * It lives here rather than in the loader because the Hail Desk needs it and
 * the loader cannot be imported there: `stormDatasets.js` holds the URL
 * constants for the 78 MB of storm artifacts at module scope, and importing it
 * from a second front end would make the bundler emit all of them for a table
 * that draws none of it.
 *
 * @param {Array<number>} raw
 * @returns {Map<number, {hail: number, wind: number}>}
 */
export function decodeYearBuckets(raw) {
  const years = new Map();
  if (!Array.isArray(raw)) return years;
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const year = Number(raw[i]);
    const hail = Number(raw[i + 1]);
    const wind = Number(raw[i + 2]);
    if (
      !Number.isFinite(year) ||
      !Number.isFinite(hail) ||
      !Number.isFinite(wind)
    )
      continue;
    years.set(year, { hail, wind });
  }
  return years;
}

/**
 * Whether a value is usable as a record-coverage bound.
 *
 * Callers pass 0 as their "unknown" sentinel, and `Number.isFinite(0)` is true,
 * so a naive check lets that sentinel through. The record then appears to end in
 * year 0, every decade's available span collapses to zero or negative length,
 * and every count silently comes back as zero — the score still renders, it is
 * just empty. Bounds must also be plausible years, not just finite numbers.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function usableBound(value, fallback) {
  return Number.isFinite(value) && value >= 1800 && value <= 2200
    ? value
    : fallback;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Fallback record coverage for a single cell when the caller supplied none.
 * @param {object} cell
 * @returns {{startYear:number, endYear:number}}
 */
function datasetBounds(cell) {
  const span = recordSpan(cell);
  const start = Number(span.start);
  const end = Number(span.end);
  return {
    startYear: usableBound(start, undefined),
    endYear: usableBound(end, undefined),
  };
}

/** Earliest year any county in a list observed an event. */
function earliestCountyYear(counties) {
  let min = Number.POSITIVE_INFINITY;
  for (const county of counties || []) {
    const year = Number(recordSpan(county).start);
    if (Number.isFinite(year) && year < min) min = year;
  }
  return Number.isFinite(min) ? min : undefined;
}

/**
 * Hail severity 0..1 from measured diameter.
 *
 * Anchored on SPC's own published lines — 0.75" (begins to damage), 1.0"
 * (severe), 2.0" (significant) — and saturating at 3.0" (grapefruit), past
 * which incremental diameter buys sharply less incremental residential damage
 * because most of the loss has already happened.
 *
 * A null magnitude scores 0 rather than throwing away the event: an unknown-size
 * hail report is still evidence hail fell there. The count of unmeasured events
 * is surfaced separately so the UI can say so.
 *
 * @param {number|null} inches
 * @returns {number} 0..1
 */
export function hailSeverity(inches) {
  const v = Number(inches);
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v < HAIL_THRESHOLDS.damaging) return 0;
  if (v >= HAIL_THRESHOLDS.saturating) return 1;
  if (v >= HAIL_THRESHOLDS.severe) {
    return 0.25 + ((v - HAIL_THRESHOLDS.severe) / 2) * 0.75;
  }
  return ((v - HAIL_THRESHOLDS.damaging) / 0.25) * 0.25;
}

/**
 * Wind severity 0..1 from gust speed in knots.
 *
 * 50 kt is the damaging-wind report floor, 58 kt is where tree and roof damage
 * becomes widespread, 75 kt is where severe structural loss starts, and 100 kt
 * saturates.
 *
 * @param {number|null} knots
 * @returns {number} 0..1
 */
export function windSeverity(knots) {
  const v = Number(knots);
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v < WIND_THRESHOLDS.damaging) return 0;
  if (v >= WIND_THRESHOLDS.saturating) return 1;
  if (v >= WIND_THRESHOLDS.structural) {
    return 0.55 + ((v - WIND_THRESHOLDS.structural) / 25) * 0.45;
  }
  if (v >= WIND_THRESHOLDS.severe) {
    return 0.2 + ((v - WIND_THRESHOLDS.severe) / 17) * 0.35;
  }
  // The damaging band starts slightly above zero on purpose. SPC classifies a
  // 50 kt gust as a damaging-wind report, so scoring it exactly 0 would claim a
  // report that caused damage caused none.
  return 0.02 + ((v - WIND_THRESHOLDS.damaging) / 8) * 0.18;
}

// ---------------------------------------------------------------------------
// Recency
// ---------------------------------------------------------------------------

/**
 * Exponential recency weight.
 *
 * A 50-year-old hail report is real evidence about hail-prone geography, but it
 * is weaker evidence about the roof stock standing there now. The half-life is
 * therefore a user-facing control, not a hidden constant.
 *
 * @param {number} year Event year.
 * @param {number} asOf Reference year (defaults to the newest observed year).
 * @param {number} halfLifeYears
 * @returns {number} 0..1
 */
export function recencyWeight(year, asOf, halfLifeYears) {
  const y = Number(year);
  const age = Number(asOf) - y;
  if (!Number.isFinite(age) || age <= 0) return 1;
  if (!Number.isFinite(halfLifeYears) || halfLifeYears <= 0) return 1;
  return Math.pow(0.5, age / halfLifeYears);
}

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

/**
 * The bundled cell payload stores counts in decade buckets, which is what keeps
 * the snapshot small enough to ship in-repo. That bounds how precisely a time
 * scrub can be answered: any period narrower than a decade is approximated from
 * the containing decade's totals. Callers must surface this rather than imply
 * year-exact totals they do not have.
 *
 * @constant
 */
export const WINDOW_RESOLUTION = Object.freeze({
  unit: 'decade',
  label: 'Decade',
  note: 'Counts are stored per decade, so a period narrower than ten years is apportioned from its decade. Individual event points remain year-exact.',
});

/**
 * Apportion a decade bucket into a year period.
 *
 * Within a decade we have totals but not a year distribution, so the share of
 * the bucket that falls inside the period is estimated as the overlap between
 * the period and the part of the decade the record actually covers, in years.
 *
 * The record-boundary clamp matters more than it looks. Counts are stored per
 * decade, but the record does not fill whole decades at either end: hail and
 * wind data begin in 1955 and the build ends mid-2020s. Treating every bucket
 * as a full ten years therefore silently halves the most recent six years —
 * the data people care about most — and quietly drops the first few years of
 * the record. Dividing by the decade's *available* span instead keeps both
 * boundary decades whole while still apportioning genuinely interior ones.
 *
 * @param {number} count Decade bucket total.
 * @param {number} decadeStart Decade start year (e.g. 2010).
 * @param {{fromYear: number, toYear: number}} period Inclusive year period.
 * @param {{startYear?: number, endYear?: number}} [bounds] Record coverage.
 * @returns {number} Estimated count inside the period.
 */
export function apportionDecade(count, decadeStart, period, bounds = {}) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const recordStart = usableBound(bounds.startYear, decadeStart);
  const recordEnd = usableBound(bounds.endYear, decadeStart + 9);
  // Half-open [lo, hi) so a year period of 1955–2025 spans 71 years, not 70.
  const availableStart = Math.max(decadeStart, recordStart);
  const availableEnd = Math.min(decadeStart + 10, recordEnd + 1);
  const available = availableEnd - availableStart;
  if (available <= 0) return 0;
  const overlap =
    Math.min(period.toYear + 1, availableEnd) -
    Math.max(period.fromYear, availableStart);
  if (overlap <= 0) return 0;
  if (overlap >= available) return n;
  return (n * overlap) / available;
}

/**
 * Recompute a cell's hail and wind statistics for a year period from its
 * per-year tallies.
 *
 * Exact: every year in the period is counted, and nothing outside it is. The
 * returned severe tallies are apportioned within the year because the snapshot
 * stores them per record, not per year — so those two are the one remaining
 * estimate, and they are reported as such by `describeCellScore`.
 *
 * @param {object} cell
 * @param {{fromYear: number, toYear: number}} period
 * @param {Map<number, {hail:number, wind:number}>} years
 * @returns {{hailCount:number, windCount:number, hailEvents:number, windEvents:number, partial:boolean}}
 */
function exactWindowCounts(cell, period, years) {
  const from = period.fromYear;
  const to = period.toYear;
  let hailCount = 0;
  let windCount = 0;
  for (const [year, counts] of years) {
    if (year < from || year > to) continue;
    hailCount += counts.hail || 0;
    windCount += counts.wind || 0;
  }
  // The record's own severe tallies are all-time. Scale them by the share of
  // reported volume inside the window so the card cannot show a full-record
  // severe count next to a single-year count.
  const totalHail = stat(cell, 'hailCount', 'hn', 0);
  const totalWind = stat(cell, 'windCount', 'wn', 0);
  const share = totalHail > 0 ? Math.min(1, hailCount / totalHail) : 0;
  const shareW = totalWind > 0 ? Math.min(1, windCount / totalWind) : 0;
  return {
    hailCount,
    windCount,
    hailEvents: stat(cell, 'hailSevere', 'hs', 0) * share,
    windEvents: stat(cell, 'windSevere', 'ws', 0) * shareW,
    // Never partial: the window is applied exactly.
    partial: false,
  };
}

/**
 * Recompute a cell's hail and wind statistics for a year period from its
 * decade histogram.
 *
 * @param {object} cell Bundled cell feature properties.
 * @param {{fromYear: number, toYear: number}} period
 * @param {{startYear?: number, endYear?: number}} [bounds] Record coverage,
 *   used to keep the first and last partially-covered decades whole.
 * @returns {{hailCount:number, windCount:number, hailEvents:number, windEvents:number, partial:boolean}}
 */
export function windowCellCounts(cell, period, bounds = {}) {
  // Exact path: the per-year tallies answer the period directly, with no
  // scaling and no assumption that reports were spread evenly through time.
  // They were not — 774 filed in the 1950s against 9,146 in the 2010s — so
  // prorating a narrow window is worse than useless; it looks like a recent
  // history and is really a fraction of a 71-year average.
  const years = cell?.years instanceof Map ? cell.years : null;
  if (years && years.size) return exactWindowCounts(cell, period, years);

  // Fallback: decade histogram, apportioned. Retained for snapshots built
  // before per-year buckets existed, and for any cell whose `ye` failed to
  // decode — a pruned year list degrades to an estimate instead of nothing.
  // `decades` is the normalized field produced by stormDatasets.toCellRecord;
  // `dc` is the compact key the snapshot itself uses. Accept both so the scorer
  // works on raw build output and on loaded records identically — reading only
  // one of them silently yields zero counts for every cell.
  const buckets = cell?.decades ?? cell?.dc ?? {};
  const span = recordSpan(cell);
  const recordStart = usableBound(
    bounds.startYear,
    span.start ?? period.fromYear,
  );
  const recordEnd = usableBound(bounds.endYear, span.end ?? period.toYear);
  let hailCount = 0;
  let windCount = 0;
  let hailEvents = 0;
  let windEvents = 0;
  let partial = false;
  for (const [decadeKey, pair] of Object.entries(buckets)) {
    // Decade keys are the full four-digit decade start ("1950", "2000"). A
    // two-digit key is ambiguous with the 2050s; inferring a century from a
    // `+ 2000` heuristic silently maps every pre-2000 bucket outside the record
    // and drops about a third of the hail history with no visible error. Only
    // fall back to the heuristic when the key genuinely is two digits.
    const rawDecade = Number(decadeKey);
    const decadeStart =
      rawDecade >= 1000
        ? rawDecade
        : rawDecade >= 50
          ? 1900 + rawDecade
          : 2000 + rawDecade;
    const [hail, wind] = Array.isArray(pair) ? pair : [0, 0];
    const localBounds = { startYear: recordStart, endYear: recordEnd };
    const h = apportionDecade(hail, decadeStart, period, localBounds);
    const w = apportionDecade(wind, decadeStart, period, localBounds);
    if (h > 0 || w > 0) {
      const availableStart = Math.max(decadeStart, recordStart);
      const availableEnd = Math.min(decadeStart + 10, recordEnd + 1);
      const overlap =
        Math.min(period.toYear + 1, availableEnd) -
        Math.max(period.fromYear, availableStart);
      if (overlap > 0 && overlap < availableEnd - availableStart)
        partial = true;
    }
    hailCount += h;
    windCount += w;
    // Severe-only tallies are all-time in the payload; scale them by the same
    // share so the period does not silently show the full record's severe count.
    const share = hail > 0 ? h / hail : 0;
    const shareW = wind > 0 ? w / wind : 0;
    hailEvents += stat(cell, 'hailSevere', 'hs', 0) * share;
    windEvents += stat(cell, 'windSevere', 'ws', 0) * shareW;
  }
  return {
    hailCount,
    windCount,
    hailEvents: Math.round(hailEvents),
    windEvents: Math.round(windEvents),
    partial,
  };
}

// ---------------------------------------------------------------------------
// Composite score
// ---------------------------------------------------------------------------

/**
 * Default blend. Weighted toward observed hazard because it is the only part
 * grounded in measurements at this exact location, with FEMA's modelled loss
 * rate and exposure acting as amplifiers rather than the primary signal.
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  observed: 0.5,
  modelled: 0.3,
  exposure: 0.2,
  // Radar is weighted deliberately low and, critically, only when the snapshot is
  // present. See `radarScore` for why it is not a peer of the other three.
  radar: 0.1,
  recencyHalfLife: 25,
});

/**
 * Rank-normalise an array of finite values to 0..1.
 * @param {number[]} values
 * @returns {number[]}
 */
export function rankNormalize(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return values.map(() => 0);
  let max = -Infinity;
  let min = Infinity;
  for (const v of finite) {
    if (v > max) max = v;
    if (v < min) min = v;
  }
  const span = max - min;
  return values.map((v) => {
    if (!Number.isFinite(v)) return 0;
    if (span <= 0) return 1;
    return (v - min) / span;
  });
}

/**
 * Observed-hazard score for one cell inside a period.
 *
 * Frequency is taken as a log ratio because storm-report frequency is heavily
 * skewed: the hail alley counties see hundreds of events, the fringe sees one.
 * A linear frequency term would collapse everything outside a handful of
 * counties to zero and make the map useless exactly where someone is asking
 * "has this ever been hit?".
 *
 * @param {object} cell Bundled cell properties.
 * @param {{fromYear:number,toYear:number}} period
 * @param {object} [options]
 * @param {boolean} [options.includeHail=true]
 * @param {boolean} [options.includeWind=true]
 * @returns {{observed:number, hail:number, wind:number, compound:number, counts:object}}
 */
export function observedScore(cell, period, options = {}) {
  const { includeHail = true, includeWind = true } = options;
  const counts = windowCellCounts(cell, period, {
    startYear: options.startYear ?? datasetBounds(cell).startYear,
    endYear: options.endYear ?? datasetBounds(cell).endYear,
  });

  // Log-frequency: each doubling of event count adds a fixed increment.
  const hailFreq = includeHail ? Math.log10(1 + counts.hailCount) : 0;
  const windFreq = includeWind ? Math.log10(1 + counts.windCount) : 0;

  // Severity: the worst recorded event in this cell, scaled by the period share
  // so an ancient single 4-inch report does not dominate a 70-year total.
  const years = Math.max(1, period.toYear - period.fromYear + 1);
  const span = recordSpan(cell);
  const windowShare = Math.min(
    1,
    years /
      Math.max(
        1,
        (span.end || period.toYear) - (span.start || period.fromYear) + 1,
      ),
  );
  const hailSev =
    clamp01(stat(cell, 'maxHailIn', 'hx', 0) / HAIL_THRESHOLDS.saturating) *
    windowShare;
  const windSev =
    clamp01(stat(cell, 'maxWindKt', 'wx', 0) / WIND_THRESHOLDS.saturating) *
    windowShare;

  // Compound events — hail and wind on the same day in the same cell — are the
  // case that actually wrecks a roof, because the envelope is already breached
  // when the wind arrives. Weighted above either hazard alone.
  const compound = clamp01(
    Math.log10(1 + stat(cell, 'compoundDays', 'cd', 0) * windowShare),
  );

  const observed = clamp01(
    0.34 * hailFreq +
      0.28 * windFreq +
      0.2 * Math.max(hailSev, windSev) +
      0.18 * compound,
  );
  return {
    observed,
    hail: hailFreq,
    wind: windFreq,
    compound,
    // Counts follow the toggles. In hail-only mode the card must not go on
    // showing a wind total that the score is ignoring, because the two numbers
    // are read side by side.
    counts: {
      ...counts,
      ...(includeHail ? {} : { hailCount: 0, hailEvents: 0 }),
      ...(includeWind ? {} : { windCount: 0, windEvents: 0 }),
    },
  };
}

/**
 * FEMA modelled-hazard score from the containing county's National Risk Index.
 *
 * `hRate`/`wRate` are expected annual loss per dollar of building value — the
 * actuarial form we want, because it already divides out how much money is at
 * stake and leaves a pure rate.
 *
 * @param {object|null} county Bundled county properties.
 * @param {object} [options]
 * @returns {{modelled:number, hailRate:number, windRate:number, rating:string|null}}
 */
export function modelledScore(county, options = {}) {
  if (!county) return { modelled: 0, hailRate: 0, windRate: 0, rating: null };
  const hailRate = Number(stat(county, 'nriHailRate', 'hRate', 0)) || 0;
  const windRate = Number(stat(county, 'nriWindRate', 'wRate', 0)) || 0;
  // NRI rates span roughly 1e-6 to 1e-4 for hail and 1e-6 to 1e-3 for wind.
  // Normalising against a decade-log scale keeps the transform monotone and
  // bounded without pretending to know the distribution.
  const norm = (r, floor) => clamp01(Math.log10(1 + r / floor) / 2);
  const modelled = clamp01(
    0.5 * norm(hailRate, 1e-6) + 0.5 * norm(windRate, 2e-6),
  );
  return {
    modelled,
    hailRate,
    windRate,
    rating:
      stat(county, 'nriHailRating', 'hRating', null) ||
      stat(county, 'nriWindRating', 'wRating', null),
  };
}

/**
 * Exposure score from the containing county's building value.
 * @param {object|null} county
 * @param {number[]} [normalized] Pre-computed rank-normalised building values.
 * @returns {number}
 */
export function exposureScore(county, normalized) {
  if (!county) return 0;
  if (Array.isArray(normalized) && Number.isFinite(normalized[0]))
    return normalized[0];
  const buildingValue = Number(stat(county, 'buildingValue', 'bld', 0)) || 0;
  if (buildingValue <= 0) return 0;
  return clamp01(Math.log10(1 + buildingValue / 1e8));
}

/**
 * Radar corroboration score for one cell.
 *
 * This is deliberately *not* a peer of `observed`, `modelled` and `exposure`,
 * for three reasons that all push the same way:
 *
 *  1. **Record length.** MRMS covers 2021 to the present. `observed` covers 1955
 *     onward. A cell cannot be "half as risky" because the last five years are
 *     better observed, so radar must never be allowed to dilute a 70-year
 *     record by scoring low.
 *  2. **MESH over-reports.** NSSL documents Maximum Estimated Size of Hail
 *     running large against ground reports, so the raw magnitudes are biased
 *     upward and are not on the same scale as reported hail size.
 *  3. **It measures a different thing.** Reported hail is "somebody filed a
 *     report". Radar hail is "a core was detected". The gap between them is the
 *     reporting-gap signal, which is worth a little weight on its own and is
 *     otherwise lost.
 *
 * So: a small additive term, plus the reporting-gap flag surfaced directly to
 * the user rather than folded silently into the number.
 *
 * @param {object|null} radar Normalised radar record from `toRadarRecord`.
 * @returns {{radar:number, frequency:number, magnitude:number, extent:number}}
 */
export function radarScore(radar) {
  const empty = { radar: 0, frequency: 0, magnitude: 0, extent: 0 };
  if (!radar) return empty;
  const days = Math.max(0, Number(radar.hailDays) || 0);
  const maxMm = Math.max(0, Number(radar.maxHailMm) || 0);
  const points = Math.max(0, Number(radar.corePoints) || 0);
  if (days <= 0 && maxMm <= 0) return empty;
  // Log frequency: a cell with hail cores on 300 of ~1900 days is extreme, and
  // the transform saturates there rather than dominating the blend.
  const frequency = clamp01(Math.log10(1 + days) / Math.log10(1 + 300));
  // 75 mm is roughly 3 inches, deep into territory where roofs are damaged.
  const magnitude = clamp01(maxMm / 75);
  // A handful of 1 km points can be a false detection; sustained coverage
  // across the cell is the difference between hail and a noise spike.
  const extent = clamp01(Math.log10(1 + points) / Math.log10(1 + 1500));
  const value = clamp01(0.45 * frequency + 0.35 * magnitude + 0.2 * extent);
  return { radar: value, frequency, magnitude, extent };
}

/**
 * Blend the components into the published damage-likelihood score.
 *
 * Radar is only folded in when a radar record was actually supplied. Leaving it
 * out of both the numerator and the denominator when it is absent is what keeps
 * the score identical for datasets built before the radar snapshot existed,
 * rather than silently deflating every score by 9% because a file was missing.
 *
 * @param {{observed:number, modelled:number, exposure:number, radar?:number}} parts
 * @param {object} [weights]
 * @returns {number} 0..1
 */
export function blendScore(parts, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const hasRadar = Number.isFinite(parts?.radar);
  const radarWeight = hasRadar ? w.radar : 0;
  const total = w.observed + w.modelled + w.exposure + radarWeight || 1;
  const raw =
    (parts.observed || 0) * w.observed +
    (parts.modelled || 0) * w.modelled +
    (parts.exposure || 0) * w.exposure +
    (hasRadar ? parts.radar * radarWeight : 0);
  return clamp01(raw / total);
}

/**
 * Severity band for a 0..1 score, matching the FIRMS heat thresholds the rest
 * of the app already uses so the two layers read as one system.
 * @param {number} score 0..1
 * @returns {'red'|'orange'|'yellow'|'blue'}
 */
export function severityBand(score) {
  const v = Number(score) || 0;
  if (v >= 0.72) return 'red';
  if (v >= 0.42) return 'orange';
  if (v >= 0.18) return 'yellow';
  return 'blue';
}

// ---------------------------------------------------------------------------
// Whole-dataset operations
// ---------------------------------------------------------------------------

/**
 * Bounding box of a Polygon or MultiPolygon, as [minLon, minLat, maxLon, maxLat].
 * @param {object|null} geometry
 * @returns {number[]|null}
 */
export function polygonBounds(geometry) {
  const polygons =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : null;
  if (!polygons) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i += 1) {
        const [lon, lat] = ring[i];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return Number.isFinite(minLon) ? [minLon, minLat, maxLon, maxLat] : null;
}

/**
 * Ray-casting point-in-ring test on a GeoJSON ring (array of [lon, lat]).
 * @param {number[]} ring
 * @param {number} x Longitude.
 * @param {number} y Latitude.
 * @returns {boolean}
 */
export function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Point-in-polygon test for Polygon / MultiPolygon, honouring holes.
 * @param {object} geometry
 * @param {number} x Longitude.
 * @param {number} y Latitude.
 * @returns {boolean}
 */
export function pointInPolygon(geometry, x, y) {
  const polygons =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : null;
  if (!polygons) return false;
  for (const polygon of polygons) {
    if (!polygon.length) continue;
    if (!pointInRing(polygon[0], x, y)) continue;
    let inHole = false;
    for (let h = 1; h < polygon.length; h += 1) {
      if (pointInRing(polygon[h], x, y)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * Assign every grid cell to the county that actually contains its centre.
 *
 * A centroid-to-cell join (the cheaper alternative) silently drops most cells:
 * a county's centroid frequently lands in a different grid cell than the cells
 * covering the county's hail-belt interior, which is exactly where the map
 * needs an answer. Doing the real point-in-polygon test with a bounding-box
 * prefilter costs one pass over 3,000 bboxes and raises coverage from roughly a
 * quarter of cells to nearly all of them.
 *
 * @param {Array<{i:number,j:number,lat:number,lon:number}>} cells
 * @param {Array<{geometry:object|null, properties:object}>} counties
 * @returns {{byCell: Map<string, object>, matchedCells: number, totalCells: number, unmatchedCells: number}}
 */
export function indexCellsToCounties(cells, counties) {
  const indexed = [];
  for (const county of counties || []) {
    const bounds = polygonBounds(county?.geometry);
    if (!bounds) continue;
    // `stormDatasets.toCountyRecord` produces a flat record (named fields beside
    // `.geometry`), while GeoJSON-style callers wrap attributes in
    // `.properties`. Accept both: reading only one shape yields an undefined
    // county in the map, which then scores as zero exposure and zero modelled
    // rate instead of failing loudly.
    const attributes = county?.properties ?? county;
    indexed.push({ bounds, properties: attributes, geometry: county.geometry });
  }
  const byCell = new Map();
  let matched = 0;
  for (const cell of cells || []) {
    const key = `${cell.i}:${cell.j}`;
    for (const entry of indexed) {
      const [minLon, minLat, maxLon, maxLat] = entry.bounds;
      if (
        cell.lon < minLon ||
        cell.lon > maxLon ||
        cell.lat < minLat ||
        cell.lat > maxLat
      )
        continue;
      if (!pointInPolygon(entry.geometry, cell.lon, cell.lat)) continue;
      const existing = byCell.get(key);
      // A cell can straddle a county line; keep the county the centre falls in.
      // First match wins because `indexed` preserves county order, which the
      // caller sorted by descending building value if it wants that bias.
      if (!existing) byCell.set(key, entry.properties);
      break;
    }
    if (byCell.has(key)) matched += 1;
  }
  return {
    byCell,
    matchedCells: matched,
    totalCells: (cells || []).length,
    unmatchedCells: (cells || []).length - matched,
  };
}

/**
 * Index counties by the fine grid cell that contains them, so every cell can
 * find its FEMA modelled rate and building value without a point-in-polygon
 * test over 3,000 polygons.
 *
 * Cells are stored with an index i such that the cell's centre sits at
 * i*step + step/2, so the inverse of that mapping is a floor, not a round.
 * Using round here silently shifts every county a full cell.
 *
 * @param {Array<{geometry:object|null, properties:object}>} counties
 * @param {number} cellDegrees
 * @returns {Map<string, object>} "latIndex:lonIndex" -> county properties
 */
export function indexCountiesByCell(counties, cellDegrees) {
  const byCell = new Map();
  const step = Number(cellDegrees) > 0 ? Number(cellDegrees) : 0.25;
  for (const county of counties || []) {
    const center = polygonCenter(county.geometry);
    if (!center) continue;
    // Cells are stored with an index i such that the cell's centre sits at
    // i*step + step/2, so the inverse of that mapping is a floor, not a round.
    // Using round here silently shifts every county a full cell.
    const key = `${Math.floor(center.lat / step)}:${Math.floor(center.lon / step)}`;
    // Several counties can land in one cell; keep the largest by building value
    // so urban counties win over rural neighbours sharing a coarse cell.
    const existing = byCell.get(key);
    if (
      !existing ||
      (Number(county.properties.bld) || 0) > (Number(existing.bld) || 0)
    ) {
      byCell.set(key, county.properties);
    }
  }
  return byCell;
}

/**
 * Area-weighted centre of a Polygon or MultiPolygon, falling back to the vertex
 * mean. Exact enough to place a county on the right grid cell.
 * @param {object|null} geometry
 * @returns {{lat:number, lon:number}|null}
 */
export function polygonCenter(geometry) {
  if (!geometry) return null;
  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : null;
  if (!polygons) return null;
  let weight = 0;
  let sx = 0;
  let sy = 0;
  let vertexCount = 0;
  let vx = 0;
  let vy = 0;
  for (const polygon of polygons) {
    const outer = polygon[0];
    if (!Array.isArray(outer) || outer.length < 3) continue;
    for (let i = 0, n = outer.length; i < n; i += 1) {
      const [x, y] = outer[i];
      const [x2, y2] = outer[(i + 1) % n];
      const cross = x * y2 - x2 * y;
      weight += cross;
      sx += (x + x2) * cross;
      sy += (y + y2) * cross;
    }
    for (const [x, y] of outer) {
      vertexCount += 1;
      vx += x;
      vy += y;
    }
  }
  if (Math.abs(weight) > 1e-12)
    return { lon: sx / (3 * weight), lat: sy / (3 * weight) };
  if (vertexCount > 0) return { lon: vx / vertexCount, lat: vy / vertexCount };
  return null;
}

/**
 * Score every cell in a dataset for a period and return them ranked.
 *
 * @param {{cells: Array<object>, countiesByCell: Map<string,object>, latestYear: number}} dataset
 * @param {{fromYear?:number, toYear?:number, limit?:number, includeHail?:boolean, includeWind?:boolean, weights?:object}} [options]
 * @returns {Array<object>} Ranked cell results, best first.
 */
export function scoreCells(dataset, options = {}) {
  const cells = dataset?.cells || [];
  if (cells.length === 0) return [];
  const latest = dataset.latestYear || 0;
  const toYear = options.toYear ?? latest;
  const fromYear = options.fromYear ?? 0;
  const period = { fromYear, toYear };

  const rows = cells.map((cell) => {
    const observed = observedScore(cell, period, {
      ...options,
      startYear: options.startYear ?? dataset.earliestYear,
      endYear: options.endYear ?? dataset.latestYear,
    });
    const county = dataset.countiesByCell?.get(`${cell.i}:${cell.j}`) || null;
    const modelled = modelledScore(county);
    const exposure = exposureScore(county);
    const radarRecord = dataset.radarByCell?.get(`${cell.i}:${cell.j}`) || null;
    const radar = radarScore(radarRecord);
    const score = blendScore(
      {
        observed: observed.observed,
        modelled: modelled.modelled,
        exposure,
        radar: dataset.radarByCell?.size ? radar.radar : null,
      },
      options.weights,
    );
    // A cell whose radar record shows far more hail days than the report record
    // has hail reports is not low-risk — it is under-reported. Surfacing that
    // distinction is the whole reason the radar snapshot is bundled.
    const reportingGap =
      !!radarRecord &&
      radarRecord.hailDays >= 3 &&
      observed.counts.hailCount > 0 &&
      radarRecord.hailDays > observed.counts.hailCount * 1.5;
    return {
      key: `${cell.i}:${cell.j}`,
      lat: cell.lat,
      lon: cell.lon,
      score,
      band: severityBand(score),
      observed: observed.observed,
      modelled: modelled.modelled,
      exposure,
      radar: radar.radar,
      radarMaxHailMm: radarRecord?.maxHailMm ?? null,
      radarHailDays: radarRecord?.hailDays ?? 0,
      radarCorePoints: radarRecord?.corePoints ?? 0,
      reportingGap,
      hailCount: observed.counts.hailCount,
      windCount: observed.counts.windCount,
      hailEvents: observed.counts.hailEvents,
      windEvents: observed.counts.windEvents,
      partial: observed.counts.partial,
      maxHailIn: stat(cell, 'maxHailIn', 'hx', null),
      maxWindKt: stat(cell, 'maxWindKt', 'wx', null),
      compoundDays: stat(cell, 'compoundDays', 'cd', 0),
      firstYear: recordSpan(cell).start ?? null,
      lastYear: recordSpan(cell).end ?? null,
      county: county
        ? // Keyed `state` to match the county record it came from. The summary
          // previously re-keyed it to `st`, which is what let a consumer reading
          // the wrong one silently produce `undefined` with no error.
          { fips: county.fips, name: county.name, state: county.state }
        : null,
    };
  });

  rows.sort((a, b) => b.score - a.score || b.hailCount - a.hailCount);
  const limit = Number.isFinite(options.limit) ? options.limit : rows.length;
  return rows.slice(0, Math.max(0, limit));
}

/**
 * Human-readable explanation of a score's inputs, for the overlay card.
 *
 * The point is auditability: an inspector should be able to see exactly why a
 * cell is highlighted and disagree with it.
 *
 * @param {object} row One row from {@link scoreCells}.
 * @param {object} [weights]
 * @returns {{title:string, details:string[], caveat:string|null}}
 */
export function describeCellScore(row, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const title = `Risk ${(row.score * 100).toFixed(0)}%`;
  const details = [];
  details.push(
    `${Math.round(row.hailCount).toLocaleString()} hail · ${Math.round(row.windCount).toLocaleString()} wind reports`,
  );
  if (row.maxHailIn) details.push(`largest hail ${row.maxHailIn.toFixed(2)}"`);
  if (row.maxWindKt)
    details.push(`strongest wind ${Math.round(row.maxWindKt)} kt`);
  if (row.compoundDays > 0)
    details.push(`${row.compoundDays.toLocaleString()} hail+wind days`);
  if (row.radarHailDays > 0) {
    const mm = row.radarMaxHailMm ?? 0;
    details.push(
      `radar: hail cores on ${row.radarHailDays.toLocaleString()} days${
        mm > 0
          ? `, largest core ${mm.toFixed(0)} mm (${(mm / 25.4).toFixed(1)}")`
          : ''
      }`,
    );
  }
  if (row.reportingGap) {
    details.push(
      `radar shows ${row.radarHailDays.toLocaleString()} hail days against ${Math.round(
        row.hailCount,
      ).toLocaleString()} filed reports — under-reported`,
    );
  }
  details.push(
    `observed ${(row.observed * 100).toFixed(0)}% · modelled ${(row.modelled * 100).toFixed(0)}% · exposure ${(row.exposure * 100).toFixed(0)}%`,
  );
  let caveat = null;
  if (row.partial)
    caveat = `No per-year tallies for this cell, so the ${WINDOW_RESOLUTION.label.toLowerCase()} bucket is apportioned across the window and counts are an estimate.`;
  if (row.firstYear && row.lastYear)
    caveat = `${caveat ? `${caveat} ` : ''}Record spans ${row.firstYear}–${row.lastYear}, weight half-life ${w.recencyHalfLife} yr.`;
  if (row.county)
    caveat = `${caveat ? `${caveat} ` : ''}Modelled rate from FEMA NRI for ${row.county.name} County.`;
  if (row.radarHailDays > 0)
    caveat = `${caveat ? `${caveat} ` : ''}Radar hail is an estimate that runs large versus ground reports, and covers 2021 onward only, so it is weighted as corroboration rather than as a severity measure.`;
  return { title, details, caveat };
}

// ---------------------------------------------------------------------------
// County-level summary
// ---------------------------------------------------------------------------

/**
 * Rank counties by the same blend, for the area-selection panel.
 * @param {Array<object>} counties
 * @param {{fromYear?:number,toYear?:number,limit?:number,weights?:object}} [options]
 * @returns {Array<object>}
 */
export function scoreCounties(counties, options = {}) {
  const list = counties || [];
  const latest = list.reduce(
    (max, c) => Math.max(max, Number(recordSpan(c).end) || 0),
    0,
  );
  const period = {
    fromYear: options.fromYear ?? 0,
    toYear: options.toYear ?? latest,
  };
  const rows = list.map((county) => {
    // Counties carry the same observed-hazard statistics as cells but no
    // compound-day count, so that term is absent rather than zeroed here.
    const cell = {
      decades: county.decades ?? county.dc ?? {},
      hailSevere: stat(county, 'hailSevere', 'hs', 0),
      windSevere: stat(county, 'windSevere', 'ws', 0),
      maxHailIn: stat(county, 'maxHailIn', 'hx', null),
      maxWindKt: stat(county, 'maxWindKt', 'wx', null),
      compoundDays: 0,
      firstYear: recordSpan(county).start ?? null,
      lastYear: recordSpan(county).end ?? null,
    };
    const observed = observedScore(cell, period, {
      ...options,
      startYear: options.startYear ?? earliestCountyYear(list),
      endYear: options.endYear ?? latest,
    });
    const modelled = modelledScore(county);
    const exposure = exposureScore(county);
    const score = blendScore(
      { observed: observed.observed, modelled: modelled.modelled, exposure },
      options.weights,
    );
    return {
      fips: county.fips,
      name: county.name,
      // The loader names this `state`; the compact snapshot key is `st`.
      st: stat(county, 'state', 'st', null),
      score,
      band: severityBand(score),
      observed: observed.observed,
      modelled: modelled.modelled,
      exposure,
      hailCount: observed.counts.hailCount,
      windCount: observed.counts.windCount,
      maxHailIn: stat(county, 'maxHailIn', 'hx', null),
      maxWindKt: stat(county, 'maxWindKt', 'wx', null),
      buildingValue: stat(county, 'buildingValue', 'bld', null),
      nriHailRate: stat(county, 'nriHailRate', 'hRate', null),
      nriWindRate: stat(county, 'nriWindRate', 'wRate', null),
      nriHailRating:
        stat(county, 'nriHailRating', 'hRating', null) ||
        stat(county, 'nriHailRiskRating', 'hRisk', null),
      nriWindRating:
        stat(county, 'nriWindRating', 'wRating', null) ||
        stat(county, 'nriWindRiskRating', 'wRisk', null),
      nriHailEal: stat(county, 'nriHailEal', 'hEal', null),
      nriWindEal: stat(county, 'nriWindEal', 'wEal', null),
      // Through `stat`, like every other field here. These three read the raw
      // GeoJSON keys (`pl`, `y0`, `y1`) directly, and the counties this function
      // is actually fed are `toCountyRecord` outputs, which RENAME all three -
      // so `reportedLoss`, `firstYear` and `lastYear` were silently null on the
      // live path and only ever worked in a test that passed raw features.
      reportedLoss: stat(county, 'reportedLoss', 'pl', null),
      population: stat(county, 'population', 'pop', null),
      firstYear: stat(county, 'firstYear', 'y0', null),
      lastYear: stat(county, 'lastYear', 'y1', null),
      partial: observed.counts.partial,
    };
  });
  rows.sort((a, b) => b.score - a.score);
  const limit = Number.isFinite(options.limit) ? options.limit : rows.length;
  return rows.slice(0, Math.max(0, limit));
}

/**
 * Search counties by name, for the area picker and for voice queries.
 *
 * Handles the three shapes people actually type: a bare name ("Cook"), a
 * name-qualified-by-state ("Cook Illinois", "Cook, IL"), and a name with the
 * word "county" in it ("Cook County, Illinois"). Voice input tends to produce
 * the middle form, and a matcher that only ever compares the whole string
 * against the county name returns nothing for it — which reads to the user as
 * "the app cannot find my county" rather than as a search bug.
 *
 * @param {Array<object>} counties
 * @param {string} query
 * @param {number} [limit=12]
 * @returns {Array<object>}
 */
export function searchCounties(counties, query, limit = 12) {
  const raw = String(query || '')
    .trim()
    .toLowerCase();
  if (!raw) return [];
  // Drop the filler word and punctuation, then split into parts.
  const parts = raw
    .replace(/\bcounties\b/g, ' ')
    .replace(/\bcounty\b/g, ' ')
    .replace(/[,.]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return [];

  const out = [];
  for (const county of counties || []) {
    const name = String(county.name || '').toLowerCase();
    // `toCountyRecord` exposes the postal abbreviation as `state` and the full
    // name as `stateName`; the old `stn`/`st` keys never existed on the record
    // and made every state-scoped search silently miss.
    const stateCode = String(county.state || '').toLowerCase();
    const stateName = String(county.stateName || '').toLowerCase();
    const state = stateName || stateCode;
    if (!name) continue;

    // Rank 0..2 on how well the name matched, then -1 if the remainder of the
    // query was consumed by a state qualifier.
    let nameRank = -1;
    const rest = [];
    for (const part of parts) {
      // Track whether *this* part was spent on the name. Testing `nameRank`
      // after assignment instead would wrongly mark the matching token as
      // unconsumed and then demand the state also match the county's own name.
      let consumed = false;
      if (nameRank < 0) {
        if (name === part || `${name} county` === part) {
          nameRank = 0;
          consumed = true;
        } else if (name.startsWith(part)) {
          nameRank = 1;
          consumed = true;
        } else if (name.includes(part)) {
          nameRank = 2;
          consumed = true;
        }
      }
      if (!consumed) rest.push(part);
    }
    // No part of the query touched a county name, so fall back to treating the
    // whole query as a state, which is how people look up "every county in
    // Illinois" from the area picker.
    if (nameRank < 0) {
      const whole = parts.join(' ');
      if (
        whole === stateName ||
        whole === stateCode ||
        (stateName && stateName.startsWith(whole))
      ) {
        out.push({ ...county, _rank: 3, _stateMatched: true });
        if (out.length > 400) break;
      }
      continue;
    }

    const qualifier = rest.join(' ');
    let stateMatched = false;
    if (qualifier) {
      if (qualifier === stateName || qualifier === stateCode)
        stateMatched = true;
      else if (
        state &&
        (stateName.startsWith(qualifier) || stateCode === qualifier)
      )
        stateMatched = true;
      else continue; // the state qualifier named something this county is not in
    }

    out.push({ ...county, _rank: nameRank, _stateMatched: stateMatched });
    if (out.length > 400) break;
  }
  out.sort(
    (a, b) =>
      a._rank - b._rank ||
      Number(b._stateMatched) - Number(a._stateMatched) ||
      String(a.name).localeCompare(String(b.name)),
  );
  return out.slice(0, Math.max(0, limit));
}

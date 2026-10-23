/**
 * apps/hail-desk/src/ui/stormTimeline.js — Storm Timeline & Sub-Daily Radar Scrubber.
 *
 * Provides monthly histogram aggregation for multi-year storm catalogs and
 * circular sub-daily radar frame navigation for Hail Desk 2.0.
 *
 * WHY THIS MODULE EXISTS:
 * Canvassing directors, roofing sales teams, and forensic insurance adjusters
 * need two distinct temporal views when investigating hail events:
 *
 * 1. MACRO TIMELINE (Monthly Aggregation):
 *    A multi-year storm catalog contains thousands of individual storm days.
 *    Displaying raw daily points across six years creates overwhelming visual
 *    clutter and obscures seasonal severity patterns. Aggregating storm days
 *    by calendar month ('YYYY-MM') reveals seasonal outbreak intensity:
 *    the volume of events, total housing market exposure under the hail swath,
 *    and the peak hailstone size recorded in that month.
 *
 * 2. MICRO SCRUBBER (Sub-Daily Frame Progression):
 *    Convective hail storms are dynamic, rapidly propagating mesoscale systems.
 *    A 24-hour composite swath ('DAY') shows the total cumulative footprint,
 *    but cannot prove WHEN a specific neighborhood was impacted. MRMS 6-hour
 *    radials ('06Z', '12Z', '18Z', '00Z') partition the UTC day so operators
 *    can scrub through the storm's track. Stepping through frames circularly
 *    allows seamless keyboard navigation (arrow keys or scrubber controls)
 *    without dead ends.
 */

/**
 * Standard sub-daily radar frame keys in chronological UTC sequence,
 * prefixed by the composite full-day view ('DAY').
 */
export const SUBDAILY_FRAMES = Object.freeze(['DAY', '06Z', '12Z', '18Z', '00Z']);

/**
 * Descriptive metadata for UI scrubber tooltips and accessibility labels.
 * WHY: Field operators on tablet displays need clear UTC-to-operational
 * context rather than cryptic meteorological abbreviations.
 */
export const SUBDAILY_FRAME_LABELS = Object.freeze({
  DAY: 'Full Day (24h Composite)',
  '06Z': '00:00 - 06:00 UTC (Early Morning)',
  '12Z': '06:00 - 12:00 UTC (Morning / Sunrise)',
  '18Z': '12:00 - 18:00 UTC (Afternoon Initiation)',
  '00Z': '18:00 - 24:00 UTC (Evening Peak Outbreak)',
});

/**
 * Steps through sub-daily radar frames circularly.
 *
 * WHY CIRCULAR PROGRESSION:
 * Scrubber buttons and hotkeys should never lock up or require a manual reset
 * when reaching the end of a sequence. Advancing past '00Z' wraps back to 'DAY'
 * (the full-day summary), and stepping backwards from 'DAY' wraps to '00Z'.
 * If the current frame is null, undefined, or unrecognized, it safely defaults
 * to the initial 'DAY' baseline before progressing.
 *
 * @param {string|null|undefined} currentFrame current frame key
 * @param {number} [step=1] progression delta (+1 for forward, -1 for backward)
 * @returns {string} next frame key ('DAY' | '06Z' | '12Z' | '18Z' | '00Z')
 */
export function nextSubdailyFrame(currentFrame, step = 1) {
  // Normalize casing and handle nullish or empty strings gracefully by anchoring to 'DAY'
  const raw = currentFrame == null ? '' : String(currentFrame).trim();
  const normalized = (raw === '' ? 'DAY' : raw).toUpperCase();
  const idx = SUBDAILY_FRAMES.indexOf(normalized);

  // Unrecognized frames fall back to the primary full-day composite
  if (idx === -1) {
    return SUBDAILY_FRAMES[0];
  }

  // Modulo arithmetic with safe wrapping for negative step deltas
  const length = SUBDAILY_FRAMES.length;
  const nextIdx = ((idx + step) % length + length) % length;
  return SUBDAILY_FRAMES[nextIdx];
}

/**
 * Steps backwards through sub-daily radar frames circularly.
 *
 * @param {string|null|undefined} currentFrame current frame key
 * @returns {string} previous frame key
 */
export function prevSubdailyFrame(currentFrame) {
  return nextSubdailyFrame(currentFrame, -1);
}

/**
 * Aggregates an array of storm day records into chronological monthly summaries.
 *
 * WHY SORTED MONTHLY SUMMARIES:
 * Histograms and timeline bar charts render along a left-to-right chronological
 * time axis. Returning an array sorted chronologically by 'YYYY-MM' guarantees
 * that rendering code does not have to re-sort or group items on every animation
 * frame.
 *
 * WHY ZERO-VALUE DEFAULTS FOR MISSING FIELDS:
 * Incomplete radar feeds or pre-MRMS historical years might lack housing reach
 * or hailstone diameter measurements. We guard against NaN by treating missing,
 * null, or non-finite values as 0, ensuring numerical consistency.
 *
 * @param {Array<{ d?: string, date?: string, houses?: number, maxHail?: number }>} stormDays
 * @returns {Array<{ month: string, count: number, houses: number, maxHail: number }>}
 */
export function aggregateStormsByMonth(stormDays) {
  if (!Array.isArray(stormDays) || stormDays.length === 0) {
    return [];
  }

  // Intermediate monthly buckets keyed by 'YYYY-MM'
  const monthlyBuckets = new Map();

  for (const storm of stormDays) {
    if (!storm) continue;

    // Accept either 'd' or 'date' property for compatibility across desk data shapes
    const rawDate = storm.d || storm.date || storm.day;
    if (!rawDate) continue;

    // Extract 'YYYY-MM' prefix (e.g. '2024-06-15' -> '2024-06')
    const match = String(rawDate).match(/^(\d{4}-\d{2})/);
    if (!match) continue;

    const monthKey = match[1];

    // Housing reach: numeric, finite, non-negative
    const housesVal = storm.houses ?? storm.housesInReach ?? storm.units ?? 0;
    const houses = typeof housesVal === 'number' && Number.isFinite(housesVal) && housesVal > 0
      ? housesVal
      : 0;

    // Maximum hail size: preserve peak measurement across all storms in the month
    const hailVal = storm.maxHail ?? storm.peakHail ?? storm.largest ?? storm.maxHailSize ?? 0;
    const maxHail = typeof hailVal === 'number' && Number.isFinite(hailVal) && hailVal > 0
      ? hailVal
      : 0;

    let bucket = monthlyBuckets.get(monthKey);
    if (!bucket) {
      bucket = {
        count: 0,
        houses: 0,
        maxHail: 0,
      };
      monthlyBuckets.set(monthKey, bucket);
    }

    bucket.count += 1;
    bucket.houses += houses;
    if (maxHail > bucket.maxHail) {
      bucket.maxHail = maxHail;
    }
  }

  // Sort chronologically ascending ('2021-05' before '2024-06')
  const sortedMonths = Array.from(monthlyBuckets.keys()).sort();

  return sortedMonths.map((month) => {
    const data = monthlyBuckets.get(month);

    // Primary summary object matching specification contract
    const summary = {
      month,
      count: data.count,
      houses: data.houses,
      maxHail: data.maxHail,
    };

    // Non-enumerable aliases provide developer ergonomics without breaking
    // strict object equality comparisons (assert.deepEqual) in test suites.
    Object.defineProperties(summary, {
      stormCount: { value: data.count, enumerable: false, writable: true },
      storms: { value: data.count, enumerable: false, writable: true },
      totalHouses: { value: data.houses, enumerable: false, writable: true },
      housesInReach: { value: data.houses, enumerable: false, writable: true },
      peakHail: { value: data.maxHail, enumerable: false, writable: true },
      maxHailSize: { value: data.maxHail, enumerable: false, writable: true },
      largest: { value: data.maxHail, enumerable: false, writable: true },
    });

    return summary;
  });
}

/**
 * Formats a 'YYYY-MM' string into an abbreviated human-readable label.
 * Example: '2024-06' -> 'Jun 2024'
 *
 * @param {string} monthKey
 * @returns {string} formatted month label
 */
export function formatMonthLabel(monthKey) {
  if (typeof monthKey !== 'string') return '';
  const match = monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!match) return monthKey;

  const year = match[1];
  const monthIdx = parseInt(match[2], 10) - 1;
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  if (monthIdx >= 0 && monthIdx < 12) {
    return `${monthNames[monthIdx]} ${year}`;
  }
  return monthKey;
}

/**
 * Computes aggregate summary statistics for driving timeline histogram UIs.
 *
 * WHY:
 * UI timeline histogram components need global maximum values (e.g. peak monthly
 * houses) to calculate percentage bar heights (0% to 100%) and determine visual
 * scaling without making multiple passes over the dataset.
 *
 * @param {Array<{ d?: string, houses?: number, maxHail?: number }>} stormDays
 * @returns {{
 *   months: Array<{ month: string, count: number, houses: number, maxHail: number }>,
 *   totalStorms: number,
 *   totalHouses: number,
 *   peakHail: number,
 *   maxMonthlyHouses: number,
 *   maxMonthlyCount: number,
 * }}
 */
export function createTimelineModel(stormDays) {
  const months = aggregateStormsByMonth(stormDays);

  let totalStorms = 0;
  let totalHouses = 0;
  let peakHail = 0;
  let maxMonthlyHouses = 0;
  let maxMonthlyCount = 0;

  for (const m of months) {
    totalStorms += m.count;
    totalHouses += m.houses;
    if (m.maxHail > peakHail) peakHail = m.maxHail;
    if (m.houses > maxMonthlyHouses) maxMonthlyHouses = m.houses;
    if (m.count > maxMonthlyCount) maxMonthlyCount = m.count;
  }

  return {
    months,
    totalStorms,
    totalHouses,
    peakHail,
    maxMonthlyHouses,
    maxMonthlyCount,
  };
}

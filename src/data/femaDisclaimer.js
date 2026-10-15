/**
 * FEMA's mandated attribution text, in one dependency-free module.
 *
 * FEMA's National Risk Index terms require this sentence verbatim wherever the
 * data is displayed or derived from. Two modules need it — `dataCredits.js`,
 * which every application surface can reach, and `stormAttribution.js`, which is
 * part of the storm layer's own graph — so it lives here rather than in either.
 * Putting it in `dataCredits.js` and importing from there would drag Cesium and
 * the whole credit table into the storm layer's boundary group; duplicating the
 * string would let the two copies drift apart, which for a contractual sentence
 * is worse than either.
 *
 * This module must never gain an import.
 *
 * @module data/femaDisclaimer
 */

/** @constant */
export const FEMA_NRI_DISCLAIMER =
  "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA. The Federal Government or FEMA cannot vouch for the data or analyses derived from these data after the data have been retrieved from the Agency's website(s).";

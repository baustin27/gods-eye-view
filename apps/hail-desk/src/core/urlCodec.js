/**
 * apps/hail-desk/src/core/urlCodec.js — bidirectional URL codec for Hail Desk 2.0.
 *
 * Preserves 100% backward compatibility with the layer-state owner token
 * format (`#v=...&lo=...`) while cleanly round-tripping modern Hail Desk 2.0
 * workspace parameters:
 *   - mode: 'split' | 'map' | 'knock' | 'dossier'
 *   - frame: 'DAY' | '06Z' | '12Z' | '18Z' | '00Z'
 *
 * Comments explain WHY: Hail Desk links are shared across roofing sales teams,
 * canvassers in trucks, and estimators. Links must never drop their state,
 * must parse safely across all browsers, and must fail closed rather than
 * showing a wrong storm date.
 */

import { DEFAULT_FILTERS, filtersFromHash, hashFromFilters } from '../state.js';

export const VALID_MODES = Object.freeze(['split', 'map', 'knock', 'dossier']);
export const VALID_FRAMES = Object.freeze(['DAY', '06Z', '12Z', '18Z', '00Z']);

export const CORE_DEFAULTS = Object.freeze({
  ...DEFAULT_FILTERS,
  mode: 'split',
  frame: 'DAY',
});

/**
 * Parse full Hail Desk state from a URL hash or query string.
 *
 * @param {string} hash the location.hash or search string
 * @returns {object} complete state object
 */
export function decodeDeskUrl(hash) {
  const base = filtersFromHash(hash);
  const params = new URLSearchParams((hash || '').replace(/^[#?]/, ''));
  
  // Custom workspace parameters (mode, frame) that sit cleanly beside layer-state
  const rawMode = String(params.get('mode') || '').trim().toLowerCase();
  const mode = VALID_MODES.includes(rawMode) ? rawMode : CORE_DEFAULTS.mode;

  const rawFrame = String(params.get('frame') || '').trim().toUpperCase();
  const frame = VALID_FRAMES.includes(rawFrame) ? rawFrame : CORE_DEFAULTS.frame;

  const stateCode =
    typeof base.state === 'string' && base.state.length === 2
      ? base.state.toUpperCase()
      : base.state;

  return {
    ...CORE_DEFAULTS,
    ...base,
    state: stateCode,
    mode,
    frame,
  };
}

/**
 * Encode Hail Desk state into a shareable URL hash.
 *
 * @param {object} state
 * @returns {string} e.g. "#v=3&l=8&lo=...&mode=split"
 */
export function encodeDeskUrl(state) {
  const baseHash = hashFromFilters(state);
  const params = new URLSearchParams(baseHash.replace(/^#/, ''));

  if (state.mode && state.mode !== CORE_DEFAULTS.mode && VALID_MODES.includes(state.mode)) {
    params.set('mode', state.mode);
  }
  if (state.frame && state.frame !== CORE_DEFAULTS.frame && VALID_FRAMES.includes(state.frame)) {
    params.set('frame', state.frame);
  }

  return `#${params.toString()}`;
}

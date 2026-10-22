/**
 * The desk's URL state.
 *
 * The desk is a second front end over the same data, so its filters are
 * LAYER state like any other: a desk link and a globe link differ only in
 * which application reads them. That means a shared view is a URL, with no
 * server, no account and no database - which is the whole of "a team sharing
 * views" at its cheapest honest end.
 *
 * The codec is the shared one (`src/data/layerState.js`): versioned, token
 * ledged, fail-closed, and already able to express the desk's options. The
 * desk does not get a second URL format.
 */

import {
  LAYER_STATE_VERSION,
  decodeOwnerOptions,
  encodeOwnerOptions,
} from '../../../src/data/layerState.js';

const OWNER = 'hail-desk';

/**
 * The owner's token, from the permanent reservation ledger.
 *
 * The desk is NOT a layer in the globe's catalog - the globe's catalog
 * requires every layer-state registry entry to be a layer it can actually
 * construct - so the desk cannot be a registry entry. It still holds a token,
 * because it writes the same option format: a link that means one thing in
 * the desk means the same thing in the globe, and a future layer must not be
 * able to take the token the desk's links already use.
 */
const OWNER_TOKEN = '8';

/** The desk's defaults, matching the registered option specs. */
export const DEFAULT_FILTERS = Object.freeze({
  fromYear: 1955,
  // The data runs to 2026 - the reports to 2026-10-13 and the radar to
  // 2026-10-15 - and the desk used to stop at 2025, which hid the whole of
  // the current year from the window that is supposed to show the recent
  // storms.
  toYear: 2026,
  // COLORADO IS THE STATE. The desk opens on our market, not on the whole
  // country, because a national list is a list nobody works through and the
  // state is where the work is. The chips carry the other forty-nine.
  state: 'CO',
  minHailTenths: 10,
  sort: 'score',
  dir: 'desc',
  q: '',
  // THE DAY, and the storm list's own sort. The market table sorts by
  // `sort`/`dir` and the storm list by `dsort`/`ddir`, because the two tables
  // have different columns and one key that meant two things would make every
  // link read back as the wrong list.
  d: '',
  dsort: 'date',
  ddir: 'desc',
  // Which spine the storm list shows. 'all' is the whole story; 'prospect'
  // is the lead list - the days the radar reached and nobody called in.
  dscope: 'all',
  // The place the desk is ISOLATED to, or '' for the whole market. The
  // globe's ISOLATE: one place, and only what fell inside it.
  iso: '',
  // Which view the desk opens on. The storm list is the centre, so this is
  // the default, and a link that names a market view says so.
  view: 'storm',
});

/**
 * Read the filters out of the URL.
 *
 * A link with no desk parameters reads as the defaults, and a link with
 * garbage reads as the defaults too: `decodeLayerStateParams` returns null for
 * anything it does not recognise, and a share link that silently changed the
 * filters it was shared with would be worse than one that ignored them.
 *
 * @param {string} hash the location hash
 * @returns {object} the filters
 */
export function filtersFromHash(hash) {
  const params = new URLSearchParams((hash || '').replace(/^#/, ''));
  if (params.get('v') !== String(LAYER_STATE_VERSION)) {
    return { ...DEFAULT_FILTERS };
  }
  const tokens = (params.get('lo') || '').split('_').filter(Boolean);
  const options = decodeOwnerOptions(OWNER, OWNER_TOKEN, tokens);
  if (!Object.keys(options).length) return { ...DEFAULT_FILTERS };
  return { ...DEFAULT_FILTERS, ...options };
}

/**
 * Write the filters into the URL.
 *
 * Only the desk's own options are written. The camera and the style are the
 * globe's, and a desk link has no camera to describe.
 *
 * @param {object} filters
 * @returns {string} the hash, including its leading `#`
 */
export function hashFromFilters(filters) {
  const params = new URLSearchParams();
  params.set('v', String(LAYER_STATE_VERSION));
  // The enabled-layer token says WHICH TOOL the link is for, so a link
  // identifies itself. The desk's token is not one the globe can enable, and
  // does not need to be: the globe reads the OPTIONS out of the same string.
  params.set('l', OWNER_TOKEN);
  const tokens = encodeOwnerOptions(OWNER, OWNER_TOKEN, filters);
  if (tokens.length) params.set('lo', tokens.join('_'));
  return `#${params.toString()}`;
}

/**
 * Whether the URL is one this desk understands.
 * @param {string} hash
 * @returns {boolean}
 */
export function isDeskHash(hash) {
  const params = new URLSearchParams((hash || '').replace(/^#/, ''));
  return params.get('l')?.split('.').includes('7') ?? false;
}

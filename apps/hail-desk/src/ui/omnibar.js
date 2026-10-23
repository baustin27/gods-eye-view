/**
 * apps/hail-desk/src/ui/omnibar.js — typeahead input controller and query classifier.
 *
 * Hail Desk 2.0 serves diverse personas across the roofing workflow:
 * field canvassers inspecting storm damage roof-by-roof, sales managers analyzing
 * county-level swathes, and catastrophe estimators triaging dates of loss.
 *
 * The Omnibar is the unified search gateway. Rather than requiring users to manually
 * toggle between "Address", "Date", "County", or "State" search modes, the Omnibar
 * classifies queries dynamically based on structural semantics:
 *   - 'address': Begins with building/street digits followed by a street name (e.g. "2840 S Elm St", "1042 16th St").
 *   - 'date': Matches standard ISO calendar format `^\d{4}-\d{2}-\d{2}$` (e.g. "2024-06-01").
 *   - 'state': Matches 2-letter postal abbreviation or full state name (e.g. "CO", "Colorado", "Texas").
 *   - 'place': Matches city, town, or county nomenclature (e.g. "Denver", "Aurora", "El Paso County").
 *
 * Performance and Architectural Invariants:
 *   1. Debounced Execution: Geospatial filtering and coordinate lookups are computationally
 *      expensive. All input mutations are debounced (default 200ms) to preserve 60fps rendering
 *      while typing.
 *   2. Immediate Submission: Pressing 'Enter' bypasses debounce latency and executes immediately.
 *   3. Teardown Safety: `createOmnibar` returns an idempotent cleanup function to unhook listeners
 *      and clear pending timers during view transitions.
 */

/**
 * Standard 2-letter postal codes for all US states, territories, and federal districts.
 * Defined as an uppercase Set for O(1) lookup.
 */
export const US_STATE_CODES = Object.freeze(
  new Set([
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
    'DC', 'PR', 'VI', 'GU', 'MP', 'AS',
  ]),
);

/**
 * Canonical names of US states and territories in lowercase for case-insensitive matching.
 */
export const US_STATE_NAMES = Object.freeze(
  new Set([
    'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
    'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
    'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
    'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
    'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
    'new hampshire', 'new jersey', 'new mexico', 'new york',
    'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
    'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
    'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
    'west virginia', 'wisconsin', 'wyoming',
    'district of columbia', 'puerto rico', 'virgin islands', 'guam',
    'northern mariana islands', 'american samoa',
    'washington dc', 'washington d.c.', 'washington, dc', 'washington, d.c.',
  ]),
);

/** ISO 8601 YYYY-MM-DD date format expression. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Classifies an omnibar search query into one of the four domain types,
 * or returns null if the query is blank, invalid, or pure punctuation.
 *
 * Order of evaluation matters:
 *   1. Null/empty/punctuation check rejects unsearchable noise early.
 *   2. Date is checked before address because ISO dates begin with 4 digits and
 *      must never be mistakenly treated as a street house number.
 *   3. Address is checked before state because addresses often conclude with city/state
 *      tokens (e.g. "123 Main St, Colorado") and must retain address precedence.
 *   4. State is checked before generic place to enable market switching.
 *   5. Fallback to place if text contains alphabetical characters.
 *
 * @param {string} query the raw input string
 * @returns {'address'|'date'|'state'|'place'|null} classification identifier
 */
export function classifyQuery(query) {
  if (typeof query !== 'string') {
    return null;
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return null;
  }

  // Edge case guard: strings containing only punctuation or symbols without
  // alphanumeric characters (e.g. "???", "---", "!@#$%") are not valid queries.
  if (!/[a-zA-Z0-9]/.test(trimmed)) {
    return null;
  }

  // 1. DATE: ISO format (e.g. "2024-06-01")
  // Allows estimators to navigate directly to hail swath radar frames for a date of loss.
  if (ISO_DATE_PATTERN.test(trimmed)) {
    return 'date';
  }

  // 2. ADDRESS: begins with digits followed by street name (e.g. "2840 S Elm St", "1042 16th St").
  // Street names may include cardinal directions ("S Elm"), named streets ("Main St"),
  // or ordinal numbered streets ("16th St", "5th Ave").
  // We require the portion after leading digits and whitespace to contain alphabetical characters
  // so that isolated numeric strings (e.g. zip codes "80202" or "123 456") do not qualify as addresses.
  const addressMatch = trimmed.match(/^(\d+[a-zA-Z0-9/-]*)\s+(.+)$/);
  if (addressMatch) {
    const streetPart = addressMatch[2].trim();
    if (/[a-zA-Z]/.test(streetPart)) {
      return 'address';
    }
  }

  // 3. STATE: 2-letter postal code or recognized state name (e.g. "CO", "Colorado", "Texas").
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && US_STATE_CODES.has(upper)) {
    return 'state';
  }

  const lower = trimmed.toLowerCase();
  if (US_STATE_NAMES.has(lower)) {
    return 'state';
  }

  // 4. PLACE: City, town, or county name query (e.g. "Denver", "Aurora", "El Paso County").
  // If the query contains letters and has not matched any higher-precedence pattern,
  // it is treated as a geographic place query for city/county filtering.
  if (/[a-zA-Z]/.test(trimmed)) {
    return 'place';
  }

  // Pure numeric queries that lack street names and are not dates (e.g. "12345") are invalid.
  return null;
}

/**
 * Creates an Omnibar controller bound to an HTML input element.
 *
 * Provides debounced input event handling, instant search on 'Enter',
 * automatic query classification, and deterministic teardown.
 *
 * @param {object} options
 * @param {HTMLInputElement|EventTarget} options.inputEl the target input element
 * @param {(query: string, type: 'address'|'date'|'state'|'place'|null) => void} options.onSearch callback invoked on search trigger
 * @param {number} [options.debounceMs=200] debounce wait window in milliseconds
 * @returns {(() => void) & { destroy: () => void, cleanup: () => void, triggerSearch: (immediate?: boolean) => void }} teardown function
 */
export function createOmnibar({ inputEl, onSearch, debounceMs = 200 } = {}) {
  if (!inputEl || typeof inputEl.addEventListener !== 'function') {
    throw new TypeError('createOmnibar: inputEl must provide addEventListener');
  }

  let timer = null;

  /**
   * Dispatches the search action with the current value and its classification.
   * Clears any active debounce timer to prevent duplicate invocations.
   */
  function triggerSearch() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const query = typeof inputEl.value === 'string' ? inputEl.value : '';
    const type = classifyQuery(query);
    if (typeof onSearch === 'function') {
      onSearch(query, type);
    }
  }

  /**
   * Handles user keystrokes with debounce timing.
   * Debouncing avoids thrashing map tiles and data pipelines on every intermediate keypress.
   */
  function handleInput() {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      triggerSearch();
    }, debounceMs);
  }

  /**
   * Handles immediate form submission or Enter keypress.
   * Bypasses debounce timer so deliberate user submissions execute without perceptible lag.
   */
  function handleKeyDown(event) {
    if (event.key === 'Enter') {
      if (typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      triggerSearch();
    }
  }

  inputEl.addEventListener('input', handleInput);
  inputEl.addEventListener('keydown', handleKeyDown);

  /**
   * Cleanly unbinds listeners and cancels any pending timer.
   * Ensures zero memory leaks or stray asynchronous callbacks after unmount.
   */
  function destroy() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    inputEl.removeEventListener('input', handleInput);
    inputEl.removeEventListener('keydown', handleKeyDown);
  }

  // Provide both functional and property-based cleanup interfaces
  destroy.destroy = destroy;
  destroy.cleanup = destroy;
  destroy.triggerSearch = triggerSearch;

  return destroy;
}

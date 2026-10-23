/**
 * apps/hail-desk/src/core/store.js — reactive state store for Hail Desk 2.0.
 *
 * Implements a lightweight, zero-dependency unidirectional pub-sub state store.
 * Eliminates the mutable monolithic state object and sprawling DOM mutation
 * side effects in `main.js`.
 *
 * Invariants:
 *   1. State is always immutable from the outside: `getState()` returns a frozen snapshot.
 *   2. State transitions notify registered listeners synchronously.
 *   3. Bidirectional URL sync connects the browser's location hash to the store.
 */

import { CORE_DEFAULTS, decodeDeskUrl, encodeDeskUrl } from './urlCodec.js';

/**
 * Creates an instance of the Hail Desk reactive store.
 *
 * @param {object} [initialOverrides={}]
 * @returns {object} the store interface
 */
export function createStore(initialOverrides = {}) {
  let state = Object.freeze({
    ...CORE_DEFAULTS,
    basemap: 'road',
    mapFallback: false,
    focusedTract: null,
    focusedStreet: null,
    dots: null,
    stateRings: null,
    ...initialOverrides,
  });

  const listeners = new Set();

  /**
   * Return current immutable state snapshot.
   */
  function getState() {
    return state;
  }

  /**
   * Mutate state via shallow merge and notify all subscribers.
   *
   * @param {object|((current: object) => object)} updater
   */
  function setState(updater) {
    const nextValues = typeof updater === 'function' ? updater(state) : updater;
    if (!nextValues) return;

    let hasChange = false;
    for (const key of Object.keys(nextValues)) {
      if (nextValues[key] !== state[key]) {
        hasChange = true;
        break;
      }
    }

    if (!hasChange) return;

    state = Object.freeze({
      ...state,
      ...nextValues,
    });

    listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (err) {
        console.error('[HailDesk Store] Listener threw:', err);
      }
    });
  }

  /**
   * Subscribe to state changes.
   *
   * @param {(state: object) => void} listener
   * @returns {() => void} unsubscribe function
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Subscriber must be a function');
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * Convenience action dispatches
   */
  function setMode(mode) {
    setState({ mode });
  }

  function selectState(stateCode) {
    const code = String(stateCode || '').trim().toUpperCase();
    setState({
      state: code,
      // Reset tract/street drill-down when switching market state
      focusedTract: null,
      focusedStreet: null,
    });
  }

  function selectStormDay(day) {
    setState({
      d: String(day || '').trim(),
      focusedTract: null,
      focusedStreet: null,
    });
  }

  function setFrame(frame) {
    setState({ frame: String(frame || 'DAY').trim() });
  }

  function setThreshold(minHailTenths) {
    setState({ minHailTenths: Number(minHailTenths) || 0 });
  }

  function setSearch(query) {
    setState({ q: String(query || '') });
  }

  function setFocusTract(geoid) {
    setState({ focusedTract: geoid ? String(geoid) : null });
  }

  function setFocusStreet(edge) {
    setState({ focusedStreet: edge || null });
  }

  function toggleIsolation() {
    setState({
      iso: state.iso === 'state' ? '' : 'state',
    });
  }

  function toggleBasemap() {
    setState({
      basemap: state.basemap === 'satellite' ? 'road' : 'satellite',
    });
  }

  function toggleDots() {
    const nextDots = state.dots === null ? true : !state.dots;
    setState({ dots: nextDots });
  }

  function setView(view) {
    if (['storm', 'city', 'county'].includes(view)) {
      setState({ view });
    }
  }

  function setSort(sort, dir = state.dir) {
    setState({ sort, dir: dir === 'asc' ? 'asc' : 'desc' });
  }

  function setStormSort(dsort, ddir = state.ddir) {
    setState({ dsort, ddir: ddir === 'asc' ? 'asc' : 'desc' });
  }

  function setScope(dscope) {
    if (['all', 'reported', 'prospect'].includes(dscope)) {
      setState({ dscope });
    }
  }

  function setYearRange(fromYear, toYear) {
    const from = Number(fromYear) || state.fromYear;
    const to = Number(toYear) || state.toYear;
    setState({ fromYear: from, toYear: to });
  }

  function reset() {
    setState({
      ...CORE_DEFAULTS,
      focusedTract: null,
      focusedStreet: null,
    });
  }

  /**
   * Initialize state from current window.location.hash.
   */
  function syncFromHash(hash = globalThis.location?.hash) {
    const decoded = decodeDeskUrl(hash);
    setState(decoded);
  }

  /**
   * Push current store state to window.location.hash without triggering reload.
   */
  function syncToHash() {
    if (typeof globalThis.history?.replaceState !== 'function') return;
    const nextHash = encodeDeskUrl(state);
    if (globalThis.location?.hash !== nextHash) {
      globalThis.history.replaceState(null, '', nextHash);
    }
  }

  /**
   * Automatically bind store to window hashchange events for browser history support.
   *
   * @param {Window} [win=globalThis.window]
   * @returns {() => void} unbind function
   */
  function bindWindowHash(win = globalThis.window) {
    if (!win?.addEventListener) return () => {};
    const onHashChange = () => syncFromHash(win.location.hash);
    win.addEventListener('hashchange', onHashChange);
    return () => win.removeEventListener('hashchange', onHashChange);
  }

  return {
    getState,
    setState,
    subscribe,
    setMode,
    selectState,
    selectStormDay,
    setFrame,
    setThreshold,
    setSearch,
    setFocusTract,
    setFocusStreet,
    toggleIsolation,
    toggleBasemap,
    toggleDots,
    setView,
    setSort,
    setStormSort,
    setScope,
    setYearRange,
    reset,
    syncFromHash,
    syncToHash,
    bindWindowHash,
  };
}

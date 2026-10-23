/**
 * apps/hail-desk/src/ui/workspaceLayout.js — Hail Desk 2.0 Workspace Layout Controller.
 *
 * Coordinates responsive viewport modes and synchronizes panel visibility across
 * the four dedicated Hail Desk 2.0 workspace modes:
 *   - 'split'   : Balanced side-by-side market exploration & storm date triage
 *   - 'map'     : Maximized full-bleed WebGL map for field navigation & driving
 *   - 'knock'   : Canvassing hub with street knock lists, progress & CRM export
 *   - 'dossier' : Property-level forensic loss verification & claim deadline card
 *
 * WHY THIS MODULE EXISTS:
 * In legacy Hail Desk, workspace layout was managed via ad-hoc DOM mutations
 * tangled throughout 2,300+ lines of monolithic `main.js`. Clicking into a tract
 * or street drilldown directly mutated inline styles and class lists on arbitrary
 * containers, causing severe layout bugs:
 *   1. Canvas overlay de-sync and clipped controls on mobile/tablet viewports.
 *   2. Accidental collisions between the storm ranking table and drill-down panels.
 *   3. Inability to provide dedicated single-purpose screens for canvassers
 *      (who need full-screen knock lists on clipboards) or territory directors
 *      (who need full-bleed map swathes without distracting side consoles).
 *
 * Architectural Invariants:
 *   - Unidirectional synchronization: store state (`state.mode`) drives layout;
 *     the layout controller never maintains out-of-band mode state.
 *   - Pure panel determination: `getActivePanels(mode)` is a pure, side-effect-free
 *     function usable in Node tests, SSR, or layout queries without DOM dependencies.
 *   - Accessible DOM toggles: Hidden panels use both HTML5 `hidden`, CSS `.hidden`,
 *     and `aria-hidden="true"` so screen readers and assistive tech accurately
 *     reflect workspace state.
 *   - Container CSS synchronization: Container root always carries `.mode-{mode}`
 *     and `data-mode="{mode}"` for clean CSS grid and flexbox transitions.
 */

/**
 * The canonical 4 workspace layout modes of Hail Desk 2.0.
 *
 * WHY 4 MODES:
 * Hail restoration workflows span distinct operational phases:
 *   - 'split'   : Macro market overview for estimators and production managers.
 *   - 'map'     : Territory routing for sales directors planning drive routes.
 *   - 'knock'   : Field canvassers knocking doors on a specific street segment.
 *   - 'dossier' : Public adjusters verifying a specific address against hail history.
 */
export const WORKSPACE_MODES = Object.freeze(['split', 'map', 'knock', 'dossier']);

/**
 * Default fallback workspace mode when hash or state is empty or invalid.
 */
export const DEFAULT_MODE = 'split';

/**
 * Pure function computing active panel visibility for a given workspace mode.
 *
 * WHY A PURE FUNCTION:
 * Decoupling panel visibility rules from DOM mutation allows layout logic
 * to be verified in headless unit tests, queried by route guards, and used
 * by responsive breakpoint controllers without requiring DOM mock harnesses.
 *
 * PANEL DEFINITIONS:
 *   - `map`     : The interactive MapLibre WebGL map pane (canvas/vector layers).
 *   - `console` : The primary Side Console hosting storm dates and market tables.
 *   - `knock`   : The Knock Hub panel showing street address leads and progress.
 *   - `dossier` : The Property Loss Dossier card showing address forensic history.
 *
 * MODE-TO-PANEL MAPPING:
 *   - 'split'   : Map + Console visible (standard desktop dual-pane view).
 *   - 'map'     : Map only (full-bleed map canvas, side console completely hidden).
 *   - 'knock'   : Map + Knock Hub visible (map centrelines paired with knock leads).
 *   - 'dossier' : Map + Dossier Card visible (map address marker paired with dossier).
 *
 * @param {string|null|undefined} mode workspace mode key
 * @returns {{ map: boolean, console: boolean, knock: boolean, dossier: boolean }}
 */
export function getActivePanels(mode) {
  const normalized = WORKSPACE_MODES.includes(mode) ? mode : DEFAULT_MODE;

  switch (normalized) {
    case 'map':
      return { map: true, console: false, knock: false, dossier: false };
    case 'knock':
      return { map: true, console: false, knock: true, dossier: false };
    case 'dossier':
      return { map: true, console: false, knock: false, dossier: true };
    case 'split':
    default:
      return { map: true, console: true, knock: false, dossier: false };
  }
}

/**
 * Helper to toggle an element's visibility cleanly and accessibly.
 *
 * WHY MULTI-METHOD TOGGLING:
 * Different CSS frameworks and styling rules target different mechanisms:
 *   - `element.hidden = !isVisible` handles standard HTML5 user-agent styling.
 *   - `.classList.toggle('hidden', !isVisible)` supports utility frameworks (Tailwind).
 *   - `.classList.toggle('is-active', isVisible)` supports BEM/state selectors.
 *   - `aria-hidden` guarantees screen readers ignore collapsed panels.
 *
 * @param {HTMLElement|null|undefined} element DOM node
 * @param {boolean} isVisible whether the element should be shown
 */
export function setPanelVisibility(element, isVisible) {
  if (!element) return;

  if (typeof element.hidden !== 'undefined') {
    element.hidden = !isVisible;
  }

  if (element.classList && typeof element.classList.toggle === 'function') {
    element.classList.toggle('hidden', !isVisible);
    element.classList.toggle('is-active', isVisible);
  }

  if (typeof element.setAttribute === 'function') {
    element.setAttribute('aria-hidden', String(!isVisible));
  }
}

/**
 * Creates and initializes the Hail Desk 2.0 workspace layout controller.
 *
 * WHY A CONTROLLER FACTORY:
 * Centralizes container class synchronization, store subscription, button click
 * dispatching, and panel visibility toggling into a single lifecycle-managed object.
 * Prevents memory leaks by returning an explicit `destroy()` method that unsubscribes
 * from the store and unbinds all attached DOM event listeners.
 *
 * @param {object} options
 * @param {HTMLElement} options.container root workspace container element
 * @param {object} [options.store] reactive store instance (from `createStore`)
 * @param {(mode: string, activePanels: object) => void} [options.onModeChange] optional callback
 * @param {object} [options.panels] optional explicit panel elements or query selectors
 * @returns {object} layout controller interface
 */
export function createWorkspaceLayout(options = {}) {
  const { container, store, onModeChange, panels: customPanels = {} } = options;

  if (!container) {
    throw new TypeError('createWorkspaceLayout: options.container is required');
  }

  // Resolve or query individual panels within container or custom overrides
  function resolvePanel(key, fallbackSelectors) {
    if (customPanels[key]) {
      if (typeof customPanels[key] === 'string' && container.querySelector) {
        return container.querySelector(customPanels[key]);
      }
      return customPanels[key];
    }
    if (container.querySelector) {
      for (const sel of fallbackSelectors) {
        const found = container.querySelector(sel);
        if (found) return found;
      }
    }
    return null;
  }

  const panels = {
    map: resolvePanel('map', ['#mapSection', '#mapPane', '.map-pane', '[data-panel="map"]']),
    console: resolvePanel('console', [
      '#content-storms',
      '#sideConsole',
      '#ranked',
      '.side-console',
      '[data-panel="console"]',
    ]),
    knock: resolvePanel('knock', [
      '#content-knock',
      '#knockHub',
      '.knock-hub',
      '[data-panel="knock"]',
    ]),
    dossier: resolvePanel('dossier', [
      '#content-dossier',
      '#dossierCard',
      '.dossier-card',
      '[data-panel="dossier"]',
    ]),
  };

  // Detect parent aside container if content panels are nested tabs inside `#sideConsole`
  const sideConsoleParent =
    customPanels.sideConsole ||
    (container.querySelector
      ? container.querySelector('#sideConsole, aside.side-console, [data-panel="side-console"]')
      : null);

  let currentMode = null;
  const clickListeners = [];

  /**
   * Synchronize DOM classes, panel visibility, and mode buttons.
   */
  function applyMode(nextMode) {
    const validatedMode = WORKSPACE_MODES.includes(nextMode) ? nextMode : DEFAULT_MODE;
    if (validatedMode === currentMode) return;

    currentMode = validatedMode;

    // 1. Synchronize container CSS classes
    if (container.classList) {
      for (const m of WORKSPACE_MODES) {
        container.classList.remove(`mode-${m}`);
      }
      container.classList.add(`mode-${currentMode}`);
    }

    if (typeof container.setAttribute === 'function') {
      container.setAttribute('data-mode', currentMode);
    }

    // 2. Compute active panels from pure layout logic
    const activePanels = getActivePanels(currentMode);

    // 3. Toggle panel DOM visibility
    setPanelVisibility(panels.map, activePanels.map);
    setPanelVisibility(panels.console, activePanels.console);
    setPanelVisibility(panels.knock, activePanels.knock);
    setPanelVisibility(panels.dossier, activePanels.dossier);

    // If `#sideConsole` is a parent aside element containing the tab bodies,
    // collapse it entirely when entering full-screen map mode ('map').
    if (sideConsoleParent) {
      const isSideConsoleActive = currentMode !== 'map';
      setPanelVisibility(sideConsoleParent, isSideConsoleActive);
    }

    // 4. Update mode switcher buttons state if present in DOM
    const buttonScope =
      container.ownerDocument ||
      (typeof document !== 'undefined' ? document : container);
    if (buttonScope && buttonScope.querySelectorAll) {
      for (const m of WORKSPACE_MODES) {
        const btns = buttonScope.querySelectorAll(
          `#mode-${m}, [data-mode="${m}"], [data-mode-target="${m}"]`,
        );
        btns.forEach((btn) => {
          const isActive = m === currentMode;
          if (typeof btn.setAttribute === 'function') {
            btn.setAttribute('aria-pressed', String(isActive));
            btn.setAttribute('aria-selected', String(isActive));
          }
          if (btn.classList) {
            btn.classList.toggle('active', isActive);
            btn.classList.toggle('is-active', isActive);
          }
        });
      }
    }

    // 5. Notify external listener if registered
    if (typeof onModeChange === 'function') {
      try {
        onModeChange(currentMode, activePanels);
      } catch (err) {
        console.error('[HailDesk WorkspaceLayout] onModeChange callback threw:', err);
      }
    }
  }

  // Bind click listeners on mode buttons if present
  const buttonScope =
    container.ownerDocument ||
    (typeof document !== 'undefined' ? document : container);
  if (buttonScope && buttonScope.querySelectorAll) {
    for (const m of WORKSPACE_MODES) {
      const btns = buttonScope.querySelectorAll(
        `#mode-${m}, [data-mode="${m}"], [data-mode-target="${m}"]`,
      );
      btns.forEach((btn) => {
        if (btn === container) return;
        if (typeof btn.addEventListener === 'function') {
          const handler = (evt) => {
            evt?.preventDefault?.();
            setMode(m);
          };
          btn.addEventListener('click', handler);
          clickListeners.push({ element: btn, handler });
        }
      });
    }
  }

  // Subscribe to external reactive store if provided
  let unsubscribeStore = null;
  if (store && typeof store.subscribe === 'function') {
    unsubscribeStore = store.subscribe((nextState) => {
      if (nextState && nextState.mode && nextState.mode !== currentMode) {
        applyMode(nextState.mode);
      }
    });
  }

  /**
   * Programmatically switch workspace layout mode.
   *
   * @param {string} nextMode
   */
  function setMode(nextMode) {
    const validatedMode = WORKSPACE_MODES.includes(nextMode) ? nextMode : DEFAULT_MODE;
    if (store && typeof store.setMode === 'function') {
      store.setMode(validatedMode);
    } else if (store && typeof store.setState === 'function') {
      store.setState({ mode: validatedMode });
    } else {
      applyMode(validatedMode);
    }
  }

  // Initialize with initial store state or default mode
  const initialMode = store?.getState?.()?.mode || DEFAULT_MODE;
  applyMode(initialMode);

  return {
    getMode: () => currentMode,
    setMode,
    getActivePanels: () => getActivePanels(currentMode),
    panels,
    container,
    destroy() {
      if (typeof unsubscribeStore === 'function') {
        unsubscribeStore();
        unsubscribeStore = null;
      }
      for (const { element, handler } of clickListeners) {
        if (typeof element.removeEventListener === 'function') {
          element.removeEventListener('click', handler);
        }
      }
      clickListeners.length = 0;
    },
  };
}

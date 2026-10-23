/**
 * apps/hail-desk/src/ui/workspaceLayout.test.mjs — unit tests for Hail Desk 2.0 Workspace Layout Controller.
 *
 * Verifies:
 *   1. Pure layout panel activation rules (`getActivePanels`) across all 4 modes.
 *   2. Fail-safe fallback to 'split' mode on invalid or undefined modes.
 *   3. Container CSS class synchronization (`.mode-split`, `.mode-map`, `.mode-knock`, `.mode-dossier`).
 *   4. Panel visibility toggling across Map, Side Console, Knock Hub, and Dossier Card.
 *   5. Store subscription synchronization and action dispatching.
 *   6. Mode button event bindings, accessible attributes (`aria-pressed`), and cleanup on destroy.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MODE,
  WORKSPACE_MODES,
  createWorkspaceLayout,
  getActivePanels,
  setPanelVisibility,
} from './workspaceLayout.js';
import { createStore } from '../core/store.js';

/**
 * Lightweight mock DOM element simulating browser node APIs in headless Node.js tests.
 */
class MockElement {
  constructor(tag = 'div', attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    this.hidden = false;
    this.children = [];
    this.eventListeners = {};

    const classSet = new Set(
      typeof attributes.class === 'string'
        ? attributes.class.split(/\s+/).filter(Boolean)
        : [],
    );

    this.classList = {
      add: (...tokens) => tokens.forEach((t) => classSet.add(t)),
      remove: (...tokens) => tokens.forEach((t) => classSet.delete(t)),
      toggle: (token, force) => {
        if (typeof force !== 'undefined') {
          if (force) classSet.add(token);
          else classSet.delete(token);
          return force;
        }
        if (classSet.has(token)) {
          classSet.delete(token);
          return false;
        }
        classSet.add(token);
        return true;
      },
      contains: (token) => classSet.has(token),
      toString: () => Array.from(classSet).join(' '),
    };
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') {
      this.classList = new MockElement('div', { class: value }).classList;
    }
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    if (!this.eventListeners[type]) {
      this.eventListeners[type] = new Set();
    }
    this.eventListeners[type].add(listener);
  }

  removeEventListener(type, listener) {
    if (this.eventListeners[type]) {
      this.eventListeners[type].delete(listener);
    }
  }

  click() {
    const listeners = this.eventListeners['click'] ? Array.from(this.eventListeners['click']) : [];
    let defaultPrevented = false;
    const evt = {
      type: 'click',
      target: this,
      preventDefault: () => {
        defaultPrevented = true;
      },
    };
    for (const listener of listeners) {
      listener(evt);
    }
    return defaultPrevented;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const match = (el) => {
      // Simple selector matching for id, class, and attributes
      if (selector.startsWith('#') && el.getAttribute('id') === selector.slice(1)) {
        return true;
      }
      if (selector.startsWith('.') && el.classList.contains(selector.slice(1))) {
        return true;
      }
      if (selector.includes('[data-mode="')) {
        const val = selector.match(/data-mode="([^"]+)"/)?.[1];
        if (el.getAttribute('data-mode') === val) return true;
      }
      if (selector.includes('[data-panel="')) {
        const val = selector.match(/data-panel="([^"]+)"/)?.[1];
        if (el.getAttribute('data-panel') === val) return true;
      }
      return false;
    };

    const traverse = (node) => {
      for (const child of node.children) {
        // Handle comma-separated selectors
        const subSelectors = selector.split(',').map((s) => s.trim());
        if (subSelectors.some((sub) => {
          if (sub.startsWith('#') && child.getAttribute('id') === sub.slice(1)) return true;
          if (sub.startsWith('.') && child.classList.contains(sub.slice(1))) return true;
          if (sub.includes('[data-mode="')) {
            const val = sub.match(/data-mode="([^"]+)"/)?.[1];
            return child.getAttribute('data-mode') === val;
          }
          if (sub.includes('[data-panel="')) {
            const val = sub.match(/data-panel="([^"]+)"/)?.[1];
            return child.getAttribute('data-panel') === val;
          }
          return false;
        })) {
          results.push(child);
        }
        traverse(child);
      }
    };

    traverse(this);
    return results;
  }
}

test('WORKSPACE_MODES exports the 4 canonical modes and is immutable', () => {
  assert.deepStrictEqual(WORKSPACE_MODES, ['split', 'map', 'knock', 'dossier']);
  assert.ok(Object.isFrozen(WORKSPACE_MODES), 'WORKSPACE_MODES should be frozen');
  assert.strictEqual(DEFAULT_MODE, 'split');
});

test('getActivePanels determines active panel visibility accurately for all modes', () => {
  // Mode 1: Split Desk (Balanced map + side console)
  assert.deepStrictEqual(getActivePanels('split'), {
    map: true,
    console: true,
    knock: false,
    dossier: false,
  });

  // Mode 2: Field Map (Full-bleed map with consoles collapsed)
  assert.deepStrictEqual(getActivePanels('map'), {
    map: true,
    console: false,
    knock: false,
    dossier: false,
  });

  // Mode 3: Knock Hub (Map centrelines + knock lead list)
  assert.deepStrictEqual(getActivePanels('knock'), {
    map: true,
    console: false,
    knock: true,
    dossier: false,
  });

  // Mode 4: Loss Dossier (Map address marker + single-property dossier card)
  assert.deepStrictEqual(getActivePanels('dossier'), {
    map: true,
    console: false,
    knock: false,
    dossier: true,
  });
});

test('getActivePanels safely falls back to default mode (split) on invalid inputs', () => {
  const defaultPanels = {
    map: true,
    console: true,
    knock: false,
    dossier: false,
  };

  assert.deepStrictEqual(getActivePanels(null), defaultPanels);
  assert.deepStrictEqual(getActivePanels(undefined), defaultPanels);
  assert.deepStrictEqual(getActivePanels(''), defaultPanels);
  assert.deepStrictEqual(getActivePanels('nonexistent_mode'), defaultPanels);
  assert.deepStrictEqual(getActivePanels(123), defaultPanels);
  assert.deepStrictEqual(getActivePanels({}), defaultPanels);
});

test('setPanelVisibility updates element hidden property, classList, and aria attributes', () => {
  const el = new MockElement('section', { id: 'testPanel' });

  // Initially show
  setPanelVisibility(el, true);
  assert.strictEqual(el.hidden, false);
  assert.strictEqual(el.classList.contains('hidden'), false);
  assert.strictEqual(el.classList.contains('is-active'), true);
  assert.strictEqual(el.getAttribute('aria-hidden'), 'false');

  // Toggle hide
  setPanelVisibility(el, false);
  assert.strictEqual(el.hidden, true);
  assert.strictEqual(el.classList.contains('hidden'), true);
  assert.strictEqual(el.classList.contains('is-active'), false);
  assert.strictEqual(el.getAttribute('aria-hidden'), 'true');

  // Null/undefined guard
  assert.doesNotThrow(() => setPanelVisibility(null, true));
  assert.doesNotThrow(() => setPanelVisibility(undefined, false));
});

test('createWorkspaceLayout throws TypeError if container is missing', () => {
  assert.throws(() => {
    createWorkspaceLayout();
  }, TypeError);

  assert.throws(() => {
    createWorkspaceLayout({ container: null });
  }, TypeError);
});

test('createWorkspaceLayout synchronizes container CSS classes across all modes', () => {
  const container = new MockElement('main');
  const store = createStore({ mode: 'split' });

  const layout = createWorkspaceLayout({ container, store });

  // Initial state should be 'split'
  assert.strictEqual(layout.getMode(), 'split');
  assert.ok(container.classList.contains('mode-split'));
  assert.ok(!container.classList.contains('mode-map'));
  assert.strictEqual(container.getAttribute('data-mode'), 'split');

  // Switch to 'map'
  layout.setMode('map');
  assert.strictEqual(layout.getMode(), 'map');
  assert.ok(container.classList.contains('mode-map'));
  assert.ok(!container.classList.contains('mode-split'));
  assert.strictEqual(container.getAttribute('data-mode'), 'map');

  // Switch to 'knock'
  layout.setMode('knock');
  assert.strictEqual(layout.getMode(), 'knock');
  assert.ok(container.classList.contains('mode-knock'));
  assert.ok(!container.classList.contains('mode-map'));
  assert.strictEqual(container.getAttribute('data-mode'), 'knock');

  // Switch to 'dossier'
  layout.setMode('dossier');
  assert.strictEqual(layout.getMode(), 'dossier');
  assert.ok(container.classList.contains('mode-dossier'));
  assert.ok(!container.classList.contains('mode-knock'));
  assert.strictEqual(container.getAttribute('data-mode'), 'dossier');

  // Clean up
  layout.destroy();
});

test('createWorkspaceLayout toggles panel visibility correctly based on mode', () => {
  const container = new MockElement('main');

  const mapPanel = new MockElement('section', { id: 'mapSection' });
  const sideConsole = new MockElement('aside', { id: 'sideConsole' });
  const stormsPanel = new MockElement('div', { id: 'content-storms' });
  const knockPanel = new MockElement('div', { id: 'content-knock' });
  const dossierPanel = new MockElement('div', { id: 'content-dossier' });

  sideConsole.appendChild(stormsPanel);
  sideConsole.appendChild(knockPanel);
  sideConsole.appendChild(dossierPanel);

  container.appendChild(mapPanel);
  container.appendChild(sideConsole);

  const store = createStore({ mode: 'split' });
  const layout = createWorkspaceLayout({
    container,
    store,
    panels: {
      map: mapPanel,
      console: stormsPanel,
      knock: knockPanel,
      dossier: dossierPanel,
      sideConsole,
    },
  });

  // Verify 'split' mode
  assert.strictEqual(mapPanel.hidden, false);
  assert.strictEqual(stormsPanel.hidden, false);
  assert.strictEqual(knockPanel.hidden, true);
  assert.strictEqual(dossierPanel.hidden, true);
  assert.strictEqual(sideConsole.hidden, false);

  // Switch to 'map' mode: side console and all child panels collapse
  layout.setMode('map');
  assert.strictEqual(mapPanel.hidden, false);
  assert.strictEqual(stormsPanel.hidden, true);
  assert.strictEqual(knockPanel.hidden, true);
  assert.strictEqual(dossierPanel.hidden, true);
  assert.strictEqual(sideConsole.hidden, true);

  // Switch to 'knock' mode: map and knock list active
  layout.setMode('knock');
  assert.strictEqual(mapPanel.hidden, false);
  assert.strictEqual(stormsPanel.hidden, true);
  assert.strictEqual(knockPanel.hidden, false);
  assert.strictEqual(dossierPanel.hidden, true);
  assert.strictEqual(sideConsole.hidden, false);

  // Switch to 'dossier' mode: map and dossier card active
  layout.setMode('dossier');
  assert.strictEqual(mapPanel.hidden, false);
  assert.strictEqual(stormsPanel.hidden, true);
  assert.strictEqual(knockPanel.hidden, true);
  assert.strictEqual(dossierPanel.hidden, false);
  assert.strictEqual(sideConsole.hidden, false);

  layout.destroy();
});

test('createWorkspaceLayout invokes onModeChange callback and syncs with store updates', () => {
  const container = new MockElement('main');
  const store = createStore({ mode: 'split' });
  const history = [];

  const layout = createWorkspaceLayout({
    container,
    store,
    onModeChange: (mode, activePanels) => {
      history.push({ mode, activePanels });
    },
  });

  // Initial call on mount
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].mode, 'split');
  assert.strictEqual(history[0].activePanels.console, true);

  // External store mutation (e.g. from URL hash sync or another component)
  store.setMode('knock');

  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[1].mode, 'knock');
  assert.strictEqual(history[1].activePanels.knock, true);
  assert.strictEqual(layout.getMode(), 'knock');

  // Redundant store setMode should not trigger callback
  store.setMode('knock');
  assert.strictEqual(history.length, 2);

  layout.destroy();
});

test('createWorkspaceLayout binds mode switcher buttons and dispatches on click', () => {
  const container = new MockElement('main');

  const btnSplit = new MockElement('button', { id: 'mode-split', 'data-mode': 'split' });
  const btnMap = new MockElement('button', { id: 'mode-map', 'data-mode': 'map' });
  const btnKnock = new MockElement('button', { id: 'mode-knock', 'data-mode': 'knock' });
  const btnDossier = new MockElement('button', { id: 'mode-dossier', 'data-mode': 'dossier' });

  container.appendChild(btnSplit);
  container.appendChild(btnMap);
  container.appendChild(btnKnock);
  container.appendChild(btnDossier);

  const store = createStore({ mode: 'split' });
  const layout = createWorkspaceLayout({ container, store });

  // Initial button attributes
  assert.strictEqual(btnSplit.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(btnMap.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(btnKnock.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(btnDossier.getAttribute('aria-pressed'), 'false');

  // Simulate user clicking "Field Map" button
  btnMap.click();
  assert.strictEqual(layout.getMode(), 'map');
  assert.strictEqual(store.getState().mode, 'map');
  assert.strictEqual(btnMap.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(btnSplit.getAttribute('aria-pressed'), 'false');

  // Simulate user clicking "Knock List" button
  btnKnock.click();
  assert.strictEqual(layout.getMode(), 'knock');
  assert.strictEqual(store.getState().mode, 'knock');
  assert.strictEqual(btnKnock.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(btnMap.getAttribute('aria-pressed'), 'false');

  layout.destroy();
});

test('createWorkspaceLayout destroy unbinds store listener and button click listeners', () => {
  const container = new MockElement('main');
  const btn = new MockElement('button', { id: 'mode-map', 'data-mode': 'map' });
  container.appendChild(btn);

  const store = createStore({ mode: 'split' });
  const layout = createWorkspaceLayout({ container, store });

  layout.destroy();

  // Further store changes should have no effect on container
  store.setMode('knock');
  assert.ok(!container.classList.contains('mode-knock'));

  // Further clicks on button should not mutate store
  btn.click();
  assert.strictEqual(store.getState().mode, 'knock'); // unchanged by button click
});

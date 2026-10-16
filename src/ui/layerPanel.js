import { syncChipGroup } from './chipGroup.js';
import { syncRowList } from './rowList.js';
import { layerFeedState } from '../data/feedState.js';
export { layerFeedState } from '../data/feedState.js';
import { GUIDANCE_STATUSES } from '../loadingFeedback.js';
import {
  keySetupRequirement,
  keySetupWithAlternatives,
} from '../keySetupCore.mjs';
import { createWeatherPanel } from './weatherPanel.js';
const FEED_STATE_LABELS = Object.freeze({
  nominal: 'ON',
  loading: 'LOADING',
  degraded: 'DEGRADED',
  stale: 'STALE',
  partial: 'PARTIAL',
  fallback: 'FALLBACK',
  unavailable: 'UNAVAILABLE',
});

// Presentation order is independent of catalog registration and startup order.
const PANEL_GROUPS = [
  {
    label: 'Movement',
    ids: [
      'satellites',
      'flights',
      'military',
      'local-adsb',
      'ais-live-vessels',
      'traffic',
      'transit',
      'bikeshare',
    ],
  },
  {
    label: 'Cameras',
    ids: ['cctv', 'recent-imagery', 'street-level'],
  },
  {
    label: 'Infrastructure',
    ids: [
      'alpr-cameras',
      'military-installations',
      'local-datacenters',
      'telegeography-submarine-cables',
      'local-dams',
    ],
  },
  {
    label: 'Events',
    ids: [
      'rocket-launches',
      'earthquakes',
      'local-firms',
      'fire-perimeters',
      // Paired deliberately: the comparison between what was observed and
      // what the model expects is the point, so the two sit next to each
      // other.
      'storm-observed',
      'storm-expected',
      // The individual reports, not the aggregate surface. Placed last in the
      // group because the aggregates answer "where is the risk" and this
      // answers "what actually fell, where, and how big".
      'storm-reports',
    ],
  },
  {
    // Isolation is not weather and not a utility - it is a lens applied over
    // everything else, so it gets its own group at the top rather than
    // borrowing Utilities and implying it belongs to one domain.
    label: 'Focus',
    ids: ['isolation'],
  },
  {
    label: 'Weather',
    ids: [
      'wind',
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
      'weather-cyclones',
    ],
  },
  {
    label: 'Utilities',
    ids: ['directions', 'radio'],
  },
];
const PANEL_ORDER = PANEL_GROUPS.flatMap(({ label, ids }) =>
  ids.map((id) => ({ id, label })),
);
const PANEL_POSITIONS = new Map(
  PANEL_ORDER.map(({ id }, index) => [id, index]),
);
const PANEL_LABELS = {
  'ais-live-vessels': 'Live Vessels',
  bikeshare: 'Bike Share',
  cctv: 'Cameras',
  'street-level': 'Street Level',
  'alpr-cameras': 'Mapped ALPR Cameras',
  'local-datacenters': 'Data Centers',
  'local-firms': 'Active Fires',
};

function panelLabel(layer) {
  return PANEL_LABELS[layer.id] || layer.name;
}

/**
 * Guidance for a control a missing provider key is holding back.
 *
 * The key registry already owns what each key is called and which environment
 * variables enable it, so a layer only declares WHICH key it needs
 * (`requiresKeyId`) and reports `stats.keyRequired` while that key is absent.
 * Naming the variable turns an unexplained dead control into a next step.
 *
 * An unnamed or unknown key returns '' rather than guessing: guidance naming
 * the wrong variable sends the operator to the wrong provider.
 *
 * @param {object} [layer] Row from the layer manager's getAll().
 * @returns {string} Guidance text, or '' when no key guidance applies.
 */
export function layerKeyRequirementTooltip(layer = {}) {
  if (layer?.stats?.keyRequired !== true) return '';
  const requiresKeyId = String(layer.requiresKeyId || '').trim();
  // A layer with several sources also names the ones it could use instead.
  return keySetupWithAlternatives(
    requiresKeyId ? keySetupRequirement(requiresKeyId) : '',
    layer.stats.keyAlternatives || [],
  );
}

/** Layer row presentation over supplied state and actions; no layer imports. */
export class LayerPanel {
  constructor({
    getLayers,
    isEnabled,
    setEnabled,
    setLayerParams,
    getRowControls,
    hasRowControls,
    subscribeRowControls,
    onHiddenRefresh = () => {},
    weatherClock,
  }) {
    this.weatherClock = weatherClock;
    this.getAll = getLayers;
    this.isEnabled = isEnabled;
    this.setEnabled = setEnabled;
    this.setLayerParams = setLayerParams;
    this._rowControlsFor = getRowControls;
    this.hasRowControls = hasRowControls;
    this.subscribeRowControls = subscribeRowControls;
    this.onHiddenRefresh = onHiddenRefresh;
    this._generation = 0;
    this._removers = [];
    this._destroyed = false;
    this._cancelRowControlsRefresh = null;
    this._recentImageryFactory = null;
    this._recentImageryPanel = null;
  }
  mount(container) {
    if (this._destroyed) return;
    this._releaseBindings();
    this._toggleContainer = container;
    this._weatherPanel?.destroy();
    this._weatherPanel = createWeatherPanel({
      clock: this.weatherClock,
      container:
        container?.ownerDocument?.getElementById?.('weather-panel-body'),
      setLayerParams: this.setLayerParams,
    });
    this._mountRecentImagery();
    this._renderToggles();
  }
  /**
   * Host the Recent Imagery readout in its rail body, like the weather
   * readout. The application supplies the factory once the layer, viewer and
   * box tool exist; a remount rebuilds the readout in place.
   * @param {((container: HTMLElement) => { destroy: () => void } | null) | null} factory
   */
  attachRecentImagery(factory) {
    if (this._destroyed) return;
    this._recentImageryFactory = typeof factory === 'function' ? factory : null;
    this._mountRecentImagery();
  }
  _mountRecentImagery() {
    this._recentImageryPanel?.destroy();
    this._recentImageryPanel = null;
    const container = this._toggleContainer?.ownerDocument?.getElementById?.(
      'recent-imagery-panel-body',
    );
    if (container && this._recentImageryFactory)
      this._recentImageryPanel = this._recentImageryFactory(container) || null;
  }
  _bind(element, type, listener) {
    element.addEventListener(type, listener);
    this._removers.push(() => element.removeEventListener(type, listener));
  }
  _releaseBindings() {
    this._generation++;
    this._cancelRowControlsRefresh?.();
    this._cancelRowControlsRefresh = null;
    for (const remove of this._removers.splice(0)) remove();
  }
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._releaseBindings();
    this._weatherPanel?.destroy();
    this._weatherPanel = null;
    this._recentImageryPanel?.destroy();
    this._recentImageryPanel = null;
    this._recentImageryFactory = null;
    this._toggleContainer = null;
  }
  _renderToggles() {
    if (this._destroyed || !this._toggleContainer) return;
    this._releaseBindings();
    this._toggleContainer.innerHTML = '';

    const generation = this._generation;
    const layers = this.getAll()
      .slice()
      .sort(
        (a, b) =>
          (PANEL_POSITIONS.get(a.id) ?? PANEL_ORDER.length) -
          (PANEL_POSITIONS.get(b.id) ?? PANEL_ORDER.length),
      );
    let previousGroup = '';
    for (const layer of layers) {
      if (!layer.showInTogglePanel) continue;
      const group =
        PANEL_ORDER[PANEL_POSITIONS.get(layer.id)]?.label ?? 'Other layers';
      if (group && group !== previousGroup) {
        const heading = document.createElement('h3');
        heading.className = 'data-layer-group-heading';
        heading.textContent = group;
        this._toggleContainer.appendChild(heading);
      }
      previousGroup = group;
      const row = document.createElement('div');
      row.className = 'data-toggle-row';
      row.dataset.layerId = layer.id;

      const topRow = document.createElement('div');
      topRow.className = 'data-toggle-top';

      const left = document.createElement('div');
      left.className = 'data-toggle-left';
      const icon = document.createElement('span');
      icon.className = 'data-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = layer.icon;
      const name = document.createElement('span');
      name.className = 'data-name';
      name.textContent = panelLabel(layer);
      left.appendChild(icon);
      left.appendChild(name);

      const right = document.createElement('div');
      right.className = 'data-toggle-right';

      const count = document.createElement('span');
      count.className = 'data-count';
      count.textContent = this._layerCountText(layer.stats);

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = `data-toggle-btn${layer.enabled ? ' active' : ''}`;
      this._syncToggleButton(toggle, layer);
      this._bind(toggle, 'click', async () => {
        // Native `disabled` immediately evicts keyboard focus in Chromium. Keep
        // the lifecycle control focusable while it is busy, and enforce the
        // same single-flight interaction contract through ARIA instead.
        if (
          this._destroyed ||
          this._generation !== generation ||
          toggle.getAttribute('aria-disabled') === 'true'
        )
          return;
        toggle.setAttribute('aria-disabled', 'true');
        toggle.setAttribute('aria-busy', 'true');
        try {
          await this.setEnabled(layer.id, !this.isEnabled(layer.id), {
            origin: 'user',
          });
        } catch (error) {
          console.warn(`[Data] ${layer.id} toggle error:`, error);
        } finally {
          const current = this.getAll().find(({ id }) => id === layer.id);
          if (!this._destroyed && current && this._generation === generation)
            this._syncToggleButton(toggle, current);
        }
      });

      const readout = Boolean(this._rowControlsFor(layer.id)?.readout);
      if (!readout) right.appendChild(count);
      right.appendChild(toggle);
      topRow.appendChild(left);
      topRow.appendChild(right);

      const bottomRow = document.createElement('div');
      bottomRow.className = 'data-toggle-meta';
      bottomRow.textContent = this._buildMetaText(layer);

      row.appendChild(topRow);
      row.appendChild(bottomRow);

      // Optional per-layer sub-controls (chips + color legend). The click
      // listener is delegated and attached once here, so it survives
      // _refreshTogglePanel — which only rewrites the container's contents.
      if (this.hasRowControls(layer.id)) {
        // A layer whose controls settle asynchronously (a chunked catalog load
        // that can also fail) pushes a re-render through this; nothing else
        // would repaint the row before its next scheduled refresh.
        const unsubscribe = this.subscribeRowControls(layer.id, () =>
          this._scheduleRowControlsRefresh(),
        );
        if (unsubscribe) this._removers.push(unsubscribe);
        if (!readout) {
          const controls = document.createElement('div');
          controls.className = 'data-toggle-controls';
          this._bind(controls, 'click', (event) => {
            const button = event.target?.closest?.('.data-toggle-chip');
            if (!button || button.disabled) return;
            // Re-read the live descriptor rather than trusting the rendered
            // chip, so a stale row can never apply an inverted toggle.
            const chip = this._rowControlsFor(layer.id)?.chips?.find(
              (entry) => entry.id === button.dataset.chipId,
            );
            if (!chip || chip.disabled || !this.isEnabled(layer.id)) return;
            if (typeof chip.onClick === 'function') chip.onClick();
            else if (chip.params)
              this.setLayerParams(layer.id, chip.params, { origin: 'user' });
          });
          row.appendChild(controls);
          // An ordered list below the chips, for a layer whose row carries a
          // sequence (turn-by-turn directions). Its own delegated listener, its
          // own container — the chip row stays a chip row.
          const list = document.createElement('ol');
          list.className = 'data-row-list';
          list.hidden = true;
          this._bind(list, 'click', (event) => {
            const button = event.target?.closest?.('.data-row-list-item');
            if (!button || button.disabled) return;
            // Re-read the live descriptor rather than trusting the rendered
            // item, so a stale row can never apply the wrong step.
            const item = this._rowControlsFor(layer.id)?.list?.items?.find(
              (entry) => entry.id === button.dataset.listItemId,
            );
            if (!item || item.disabled || !this.isEnabled(layer.id)) return;
            if (typeof item.onClick === 'function') item.onClick();
            else if (item.params)
              this.setLayerParams(layer.id, item.params, { origin: 'user' });
          });
          row.appendChild(list);
          // An optional typed field. Its own container and its own listeners,
          // because syncChipGroup reconciles the chip container by rewriting
          // textContent - anything nested inside a chip is destroyed on the next
          // panel refresh, which is what the user's own commit triggers.
          const field = document.createElement('div');
          field.className = 'data-toggle-field';
          field.hidden = true;
          this._bind(field, 'keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              this._commitRowField(field, layer.id);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              this._cancelRowField(field, layer.id);
            }
          });
          // Committing on blur is what makes a field feel ordinary. Guarded so
          // moving from the field onto a chip does not fire twice.
          this._bind(field, 'focusout', (event) => {
            if (event.relatedTarget && field.contains(event.relatedTarget))
              return;
            this._commitRowField(field, layer.id);
          });
          row.appendChild(field);
          // A window control, same contract as the field: its own container and its
          // own delegated listeners, so a slider mid-drag is never reconciled out
          // from under the pointer by the next panel refresh.
          const range = document.createElement('div');
          range.className = 'data-toggle-range';
          range.hidden = true;
          this._bind(range, 'input', (event) =>
            this._onRowRangeInput(range, layer.id, event),
          );
          this._bind(range, 'change', (event) =>
            this._onRowRangeChange(range, layer.id, event),
          );
          row.appendChild(range);
          this._syncRowControls(controls, layer, list, field, range);
        }
      }

      this._toggleContainer.appendChild(row);
    }
    this._refreshWeatherPanel();
  }

  _scheduleRowControlsRefresh() {
    if (this._destroyed || this._cancelRowControlsRefresh) return;
    const refresh = () => {
      this._cancelRowControlsRefresh = null;
      if (!this._destroyed) this._refreshTogglePanel();
    };
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(refresh);
      this._cancelRowControlsRefresh = () => cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(refresh, 0);
      this._cancelRowControlsRefresh = () => clearTimeout(timer);
    }
  }

  /** Synchronously flush a pending row-controls refresh, including in tests. */
  _flushRowControlsRefresh() {
    if (this._destroyed || !this._cancelRowControlsRefresh) return;
    this._cancelRowControlsRefresh();
    this._cancelRowControlsRefresh = null;
    this._refreshTogglePanel();
  }

  _refreshWeatherPanel() {
    this._weatherPanel?.update(
      this.getAll()
        .filter(
          (layer) =>
            layer.enabled &&
            [
              'wind',
              'weather-radar',
              'weather-satellite',
              'weather-lightning',
              'weather-cyclones',
            ].includes(layer.id),
        )
        .map((layer) => ({
          id: layer.id,
          icon: layer.icon,
          ...this._rowControlsFor(layer.id),
        })),
    );
  }

  /** Qualify a loaded count when it does not mean items currently on screen. */
  _layerCountText(stats) {
    if (typeof stats.countLabel === 'string' && stats.countLabel.trim())
      return stats.countLabel;
    return stats.count ? this._formatCount(stats.count) : '—';
  }

  /**
   * Render a layer's row chips and color legend, and keep the whole block
   * hidden while the layer is off (or while a dependency owner has surrendered
   * it) so a quiet row stays quiet.
   *
   * Chip BUTTONS are reconciled in place, keyed by chip id, rather than
   * rebuilt: this runs on every panel refresh — including the one the chip's
   * own click triggers — and replacing the node would drop keyboard focus
   * mid-interaction. Legend entries are rebuilt only when their content changes;
   * the info node is retained across refreshes.
   * @param {HTMLElement|null} container The row's `.data-toggle-controls` node.
   * @param {object} layer Registered layer entry.
   * @param {HTMLElement|null} [listContainer] The row's `.data-row-list` node.
   */
  _syncRowControls(
    container,
    layer,
    listContainer = null,
    fieldContainer = null,
    rangeContainer = null,
  ) {
    if (!container) return;
    const controls = layer.enabled ? this._rowControlsFor(layer.id) : null;
    if (controls?.readout) {
      container.remove();
      listContainer?.remove();
      fieldContainer?.remove();
      rangeContainer?.remove();
      return;
    }
    this._syncRowField(fieldContainer, controls?.field || null);
    this._syncRowRange(rangeContainer, controls?.range || null);
    const chips = controls?.chips || [];
    const legend = controls?.legend || [];
    const infoText = controls?.info;
    this._syncRowList(listContainer, controls?.list || null);
    container.hidden = chips.length === 0 && legend.length === 0 && !infoText;

    const info = container._rowControlsInfo || null;
    const firstLegend = container.querySelector('.data-toggle-legend-item');

    syncChipGroup(container, chips, { before: firstLegend || info });

    const legendSignature = JSON.stringify(
      legend.map(({ label, color, count, blurb }) => [
        label,
        color,
        count,
        blurb,
      ]),
    );
    if (container._legendSignature !== legendSignature) {
      for (const node of [...container.children]) {
        if (node.className === 'data-toggle-legend-item') node.remove();
      }
      for (const item of legend) {
        const entry = document.createElement('span');
        entry.className = 'data-toggle-legend-item';
        if (item.blurb) entry.title = item.blurb;
        const swatch = document.createElement('span');
        swatch.className = 'data-toggle-legend-swatch';
        swatch.style.background = item.color;
        const text = document.createElement('span');
        text.textContent =
          item.count == null
            ? String(item.label)
            : `${item.label} ${this._formatCount(item.count)}`;
        entry.append(swatch, text);
        container.insertBefore(entry, info);
      }
      container._legendSignature = legendSignature;
    }
    if (infoText || info) {
      const node = info || document.createElement('div');
      if (!info) {
        container.appendChild(node);
        container._rowControlsInfo = node;
      }
      const className = 'data-toggle-controls-info';
      if (node.className !== className) node.className = className;
      const text = infoText ? String(infoText) : '';
      const title = controls?.infoTitle || '';
      if (node.textContent !== text) node.textContent = text;
      if (node.title !== title) node.title = title;
      const hidden = !text;
      if (node.hidden !== hidden) node.hidden = hidden;
    }
  }

  /**
   * Render a row's ordered list (turn-by-turn directions).
   *
   * Each entry is a real `<button>` inside a real `<li>`, so Tab reaches it and
   * Enter activates it with no key handling of our own, and the `<ol>` carries
   * the ordering a screen reader announces. Items are reconciled in place,
   * keyed by id, for the same reason chips are: this runs on every refresh —
   * including the one a click on the list triggers — and replacing the node
   * would drop keyboard focus mid-interaction.
   * @param {HTMLElement|null} container The row's `.data-row-list` node.
   * @param {{ariaLabel?: string, items?: Array<object>}|null} list Descriptor.
   */
  /**
   * Reconcile the row's optional typed field.
   *
   * The input node is kept across refreshes and only its value is touched, so
   * a refresh triggered while someone is mid-word does not steal focus or
   * discard a half-typed date. While the field has focus nothing is written to
   * it at all - the panel refreshes on a timer, and that timer must not be able
   * to interrupt typing.
   *
   * @param {HTMLElement|null} container The row's `.data-toggle-field` node.
   * @param {object|null} descriptor Row-controls `field`, or null to hide it.
   */
  _syncRowField(container, descriptor) {
    if (!container) return;
    if (!descriptor || this.destroyed) {
      container.hidden = true;
      container._rowFieldInput?.remove();
      container._rowFieldInput = null;
      return;
    }
    container.hidden = false;
    container.dataset.fieldId = descriptor.id || '';
    // Tracked on the container rather than looked up: the fixture DOM used by
    // the panel tests answers class selectors only, and a retained node is
    // what keeps focus alive across a refresh anyway.
    let input = container._rowFieldInput;
    if (!input) {
      const document = container.ownerDocument ?? globalThis.document;
      input = document.createElement('input');
      input.className = 'data-toggle-field-input';
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('inputmode', 'text');
      container.appendChild(input);
      container._rowFieldInput = input;
    }
    if (descriptor.ariaLabel)
      input.setAttribute('aria-label', descriptor.ariaLabel);
    else input.removeAttribute('aria-label');
    if (descriptor.placeholder) input.placeholder = descriptor.placeholder;
    else input.removeAttribute('placeholder');
    if (descriptor.disabled) input.disabled = true;
    else input.disabled = false;
    const active = container.ownerDocument?.activeElement === input;
    if (!active && input.value !== String(descriptor.value ?? ''))
      input.value = String(descriptor.value ?? '');
  }

  /**
   * Hand the typed value to the layer and report whether it took.
   *
   * The layer decides what its text means; a rejected value leaves the input
   * showing what was typed so it can be corrected rather than silently
   * reverted to a date nobody asked for.
   *
   * @param {HTMLElement} container The row's `.data-toggle-field` node.
   * @param {string} layerId
   * @returns {boolean}
   */
  _commitRowField(container, layerId) {
    const input = container?._rowFieldInput;
    if (!input || input.disabled) return false;
    const field = this._rowControlsFor(layerId)?.field;
    if (!field) return false;
    let accepted = true;
    if (typeof field.onCommit === 'function')
      accepted = field.onCommit(input.value) !== false;
    if (accepted)
      input.value = String(this._rowControlsFor(layerId)?.field?.value ?? '');
    return accepted;
  }

  /**
   * Abandon the edit and put the field back to the layer's current value.
   * @param {HTMLElement} container
   * @param {string} layerId
   */
  _cancelRowField(container, layerId) {
    const input = container?._rowFieldInput;
    if (!input) return;
    const field = this._rowControlsFor(layerId)?.field;
    input.value = String(field?.value ?? '');
    if (typeof field?.onCancel === 'function') field.onCancel();
    // Blurring fires focusout, which would commit the value we just restored.
    // Without this the cancel is immediately undone by the very next tick.
    container._rowFieldCancelling = true;
    input.blur?.();
    container._rowFieldCancelling = false;
  }

  /**
   * Reconcile a layer's optional window control.
   *
   * Two sliders rather than one dual-thumb track. The browser has no dual
   * range input, and stacking two overlapping ones means z-index juggling, an
   * unreachable thumb whenever the ends cross, and a keyboard user who cannot
   * tell which end they are on. Two labelled sliders are plainer and each is
   * independently operable.
   *
   * Values are integer positions the layer owns; the panel never interprets
   * them, so a layer can map positions onto anything it likes. The nodes are
   * reconciled rather than rebuilt, and a value is not written while the
   * pointer or the keyboard is on that slider - otherwise a panel refresh
   * would yank it back mid-drag.
   *
   * @param {HTMLElement|null} container The row's `.data-toggle-range` node.
   * @param {object|null} descriptor Row-controls `range`, or null to hide it.
   */
  _syncRowRange(container, descriptor) {
    if (!container) return;
    if (!descriptor || this.destroyed) {
      container.hidden = true;
      container._rowRangeNodes = null;
      return;
    }
    const document = container.ownerDocument ?? globalThis.document;
    const { min = 0, max = 0, step = 1, ariaLabel = 'Range' } = descriptor;
    let nodes = container._rowRangeNodes;
    if (!nodes || nodes.min !== min || nodes.max !== max) {
      container.replaceChildren?.();
      const document = container.ownerDocument ?? globalThis.document;
      const readout = document.createElement('span');
      readout.className = 'data-toggle-range-readout';
      const make = (which, label) => {
        const wrap = document.createElement('label');
        wrap.className = 'data-toggle-range-row';
        const caption = document.createElement('span');
        caption.className = 'data-toggle-range-label';
        caption.textContent = label;
        const input = document.createElement('input');
        input.className = 'data-toggle-range-input';
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.dataset.rangeEnd = which;
        input.setAttribute('aria-label', `${ariaLabel} ${label.toLowerCase()}`);
        wrap.append(caption, input);
        return { wrap, input };
      };
      const from = make('from', 'From');
      const to = make('to', 'To');
      container.append(from.wrap, to.wrap, readout);
      nodes = { min, max, from: from.input, to: to.input, readout };
      container._rowRangeNodes = nodes;
    }
    container.hidden = false;
    const [fromValue, toValue] = descriptor.value || [min, max];
    for (const [input, value] of [
      [nodes.from, fromValue],
      [nodes.to, toValue],
    ]) {
      const document = container.ownerDocument ?? globalThis.document;
      // Never fight the person dragging: a refresh that lands mid-drag and
      // writes the value back makes the handle jump.
      if (document.activeElement === input && container._rowRangeEditing)
        continue;
      const next = String(value);
      if (input.value !== next) input.value = next;
    }
    if (descriptor.readout) nodes.readout.textContent = descriptor.readout;
    else nodes.readout.textContent = '';
  }

  /**
   * A slider moved. Reported on every `input` so a layer can preview live,
   * but the layer decides whether that is cheap.
   * @param {HTMLElement} container
   * @param {string} layerId
   * @param {Event} event
   */
  _onRowRangeInput(container, layerId, event) {
    const input = event.target?.closest?.('.data-toggle-range-input');
    if (!input || !container.contains(input)) return;
    container._rowRangeEditing = true;
    const range = this._rowControlsFor(layerId)?.range;
    if (typeof range?.onInput === 'function') {
      const [from, to] = this._rowRangeValues(container, range);
      range.onInput(from, to);
    }
  }

  /**
   * The drag ended. This is where work is worth paying for.
   * @param {HTMLElement} container
   * @param {string} layerId
   * @param {Event} event
   */
  _onRowRangeChange(container, layerId, event) {
    const input = event.target?.closest?.('.data-toggle-range-input');
    if (!input || !container.contains(input)) return;
    container._rowRangeEditing = false;
    const range = this._rowControlsFor(layerId)?.range;
    if (typeof range?.onCommit === 'function') {
      const [from, to] = this._rowRangeValues(container, range);
      range.onCommit(from, to);
    }
  }

  /**
   * Read both thumbs, keeping them in order. The `from` thumb dragged past
   * `to` means a window, and a window has a start and an end whatever order
   * the handles were grabbed in.
   * @returns {[number, number]}
   */
  _rowRangeValues(container, range) {
    const nodes = container._rowRangeNodes;
    const min = Number(range?.min ?? nodes?.min ?? 0);
    const max = Number(range?.max ?? nodes?.max ?? 0);
    const clamp = (value) => Math.min(max, Math.max(min, Number(value) || 0));
    const a = clamp(nodes.from.value);
    const b = clamp(nodes.to.value);
    return a <= b ? [a, b] : [b, a];
  }

  _syncRowList(container, list) {
    syncRowList(container, list);
  }

  _refreshTogglePanel() {
    if (this._destroyed || !this._toggleContainer) return;
    // Skip DOM churn while hidden; visibilitychange (main.js) triggers one
    // refresh on return. (perf wave 2)
    if (typeof document !== 'undefined' && document.hidden) {
      this.onHiddenRefresh();
      return;
    }
    for (const layer of this.getAll()) {
      const row = this._toggleContainer.querySelector(
        `[data-layer-id="${layer.id}"]`,
      );
      if (!row) continue;

      const btn = row.querySelector('.data-toggle-btn');
      if (btn) {
        this._syncToggleButton(btn, layer);
      }

      const count = row.querySelector('.data-count');
      if (count) {
        count.textContent = this._layerCountText(layer.stats);
      }

      const meta = row.querySelector('.data-toggle-meta');
      if (meta) {
        meta.textContent = this._buildMetaText(layer);
      }

      this._syncRowControls(
        row.querySelector('.data-toggle-controls'),
        layer,
        row.querySelector('.data-row-list'),
        row.querySelector('.data-toggle-field'),
        row.querySelector('.data-toggle-range'),
      );
    }
    this._refreshWeatherPanel();
  }

  _buildMetaText(layer) {
    const stats = layer.stats || {};
    const feedState = layerFeedState(stats);
    const stateLabel = FEED_STATE_LABELS[feedState];
    const source = stats.source || layer.source;
    const lifecycleState =
      layer.lifecycleState || (layer.enabled ? 'enabled' : 'disabled');
    if (lifecycleState === 'enabling' || lifecycleState === 'disabling') {
      return `${lifecycleState.toUpperCase()} · ${source}`;
    }
    if (layer.lifecycleUncertain) {
      return `UNCERTAIN · ${source} · lifecycle state requires reconciliation`;
    }
    const presentedError =
      stats.error || stats.lastError || stats.managerRefreshError;
    if (presentedError) {
      if (typeof stats.retryInSec === 'number' && stats.retryInSec > 0) {
        return `${stateLabel} · ${source} · ${presentedError} · retry ${stats.retryInSec}s`;
      }
      return `${stateLabel} · ${source} · ${presentedError}`;
    }
    // A guidance status carries its prompt in `statusMessage`, not `error`, so
    // the row still tells the operator what to do without reporting a fault.
    if (
      GUIDANCE_STATUSES.includes(String(stats.status || '').toLowerCase()) &&
      typeof stats.statusMessage === 'string' &&
      stats.statusMessage.trim()
    ) {
      return `${source} · ${stats.statusMessage.trim()}`;
    }
    const ago = stats.lastUpdate ? this._timeAgo(stats.lastUpdate) : 'never';
    if (stats.loading) {
      const loadingLabel =
        typeof stats.loadingLabel === 'string' && stats.loadingLabel.trim()
          ? stats.loadingLabel.trim()
          : 'loading...';
      return `${source} · ${loadingLabel}`;
    }
    if (feedState === 'fallback') {
      const detail =
        typeof stats.loadingLabel === 'string' && stats.loadingLabel.trim()
          ? stats.loadingLabel.trim()
          : stats.coverage || ago;
      return `${stateLabel} · ${source} · ${detail}`;
    }
    if (feedState === 'partial') {
      const { acceptedRowCount, rawRowCount } = stats;
      const detail =
        Number.isInteger(acceptedRowCount) &&
        Number.isInteger(rawRowCount) &&
        acceptedRowCount >= 0 &&
        rawRowCount > acceptedRowCount
          ? `${acceptedRowCount} of ${rawRowCount} records accepted`
          : 'incomplete snapshot';
      return `${stateLabel} · ${source} · ${detail} · ${ago}`;
    }
    if (feedState === 'stale') {
      const retry =
        typeof stats.retryInSec === 'number' && stats.retryInSec > 0
          ? ` · retrying in ${stats.retryInSec}s`
          : '';
      return `${stateLabel} · ${source} · ${ago}${retry}`;
    }
    if (typeof stats.loadingLabel === 'string' && stats.loadingLabel.trim()) {
      return `${source} · ${stats.loadingLabel.trim()}`;
    }
    return `${source} · ${ago}`;
  }

  _syncToggleButton(button, layer) {
    const unavailable = layer.stats?.sourceUnavailable === true;
    const feedState = unavailable
      ? 'unavailable'
      : layer.enabled
        ? layerFeedState(layer.stats)
        : 'off';
    const transitioning =
      layer.lifecycleState === 'enabling' ||
      layer.lifecycleState === 'disabling';
    const uncertain = Boolean(layer.lifecycleUncertain);
    button.classList.toggle('active', layer.enabled);
    button.classList.toggle('transitioning', transitioning);
    button.classList.toggle('enabling', layer.lifecycleState === 'enabling');
    button.classList.toggle('disabling', layer.lifecycleState === 'disabling');
    button.classList.toggle('lifecycle-uncertain', uncertain);
    for (const state of Object.keys(FEED_STATE_LABELS)) {
      button.classList.toggle(
        `feed-${state}`,
        (layer.enabled || unavailable) && !uncertain && feedState === state,
      );
    }
    button.dataset.feedState = transitioning
      ? layer.lifecycleState
      : uncertain
        ? 'uncertain'
        : feedState;
    // A busy toggle remains the keyboard focus owner. `aria-disabled` plus the
    // click guard above prevents repeat activation without the focus loss caused
    // by native `disabled`.
    button.disabled = false;
    button.setAttribute(
      'aria-disabled',
      String(transitioning || (unavailable && !layer.enabled)),
    );
    button.setAttribute('aria-busy', String(transitioning));
    button.textContent = transitioning
      ? layer.lifecycleState.toUpperCase()
      : uncertain
        ? 'UNCERTAIN'
        : layer.enabled || unavailable
          ? FEED_STATE_LABELS[feedState]
          : 'OFF';
    const keyGuidance = unavailable
      ? String(layer.stats.error || 'Data source unavailable')
      : layerKeyRequirementTooltip(layer);
    // Name the missing key on the control itself: a row reading KEY REQUIRED
    // without saying WHICH key leaves a dead control and no next step. Empty
    // when the layer needs no key, or already has one.
    button.title = keyGuidance;
    button.setAttribute(
      'aria-label',
      keyGuidance
        ? `${panelLabel(layer)}: ${button.textContent}. ${keyGuidance}`
        : `${panelLabel(layer)}: ${button.textContent}`,
    );
  }

  _formatCount(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  }

  _timeAgo(timestamp) {
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }
}

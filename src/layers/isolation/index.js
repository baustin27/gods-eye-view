/**
 * Isolation Mode — the visual half: the box, the scrim around it, and the
 * camera move.
 *
 * `src/data/isolation.js` answers "Texas?" and returns an area. This layer draws
 * that area and nothing else: a boundary rectangle per box, a translucent scrim
 * over the rest of the world, and a `flyTo` that frames it. It never filters
 * anything — the filter reads the same area object — so what you see dimmed is
 * exactly what the filter is counting inside.
 *
 * WHY A NEW LAYER RATHER THAN A STATE FLAG ON AN EXISTING ONE. Three reasons,
 * each of which has bitten this codebase before:
 *
 *   1. Its own `Cesium.CustomDataSource`. Writing a scrim into `viewer.entities`
 *      would have it cleared by whichever layer rendered last — and a scrim that
 *      vanishes on the next repaint is the worst possible failure here, because
 *      it looks like the isolation stopped working.
 *   2. It must survive every other layer's lifecycle. Isolation is a mode, not a
 *      feed: nothing about it expires, and a periodic update that re-fetched it
 *      would be inventing work.
 *   3. It can be off while an isolation is set, and on with none. Both are
 *      ordinary states, and neither may throw.
 *
 * HONEST LIMITS, stated here rather than hidden in the panel:
 *   - The drawn shape is the area's BOUNDING BOX, not its polygon. For the United
 *     States that is a rectangle from the Aleutians to Maine, which is much
 *     larger than the country. The filter reads polygons; the box is the frame.
 *   - A place has no boundary at all — it is a point with a ±0.25° radius — and
 *     `describeIsolation` says so wherever the label appears.
 *   - A split isolation draws two boxes and frames the larger one. The other part
 *     is real and is on screen; the camera simply does not go there.
 *
 * @module layers/isolation/index
 */

import * as Cesium from 'cesium';
import {
  framingForBoxes,
  isolationBoxes,
  scrimRectangles,
  splitNote,
} from './model.js';
import { describeIsolation, resolveIsolation } from '../../data/isolation.js';
import { findPlace } from '../../data/places.js';

/** The layer id, and the token reserved for it in the layer-state ledger. */
export const ISOLATION_LAYER_ID = 'isolation';

/** How the panel names it. */
const LAYER_NAME = 'Isolation Mode';

/**
 * Where the boundaries come from.
 *
 * Bundled Natural Earth and US Census polygons, offline. The place rung is a
 * separate index and is not claimed here, because a place is not a boundary and
 * saying so in the badge would be a lie.
 */
const ISOLATION_SOURCE_BADGE = 'BUNDLED BOUNDARIES · OFFLINE';

/** The box outline. */
const OUTLINE_COLOR = '#ffd166';
const OUTLINE_FILL_ALPHA = 0.14;

/**
 * The scrim.
 *
 * Dark rather than grey, and dark at a strength you can read a map through: the
 * point is to push the rest of the world back, not to hide it. A reader still has
 * to see that there is, say, a storm happening just outside the isolation they
 * asked about.
 */
const SCRIM_COLOR = '#03060c';
const SCRIM_ALPHA = 0.62;

/** Overlay cards published at once. One: the label of what is isolated. */
const OVERLAY_LIMIT = 1;

function sameBoxes(left, right) {
  if (left.length !== right.length) return false;
  return left.every((box, index) =>
    box.every((value, edge) => value === right[index]?.[edge]),
  );
}

/**
 * @param {{overlayHost?: object}} [deps] The overlay host is OPTIONAL. A
 *   missing host means no label card on the globe, which is a cosmetic loss;
 *   throwing for it would make an optional dependency a hard one.
 */
export function createIsolationLayer({ overlayHost } = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _area = null;
  // The text the person actually typed, kept beside the resolved area because
  // that text - not the geometry - is what a share link carries. Encoding a
  // polygon would put kilobytes of coordinates in a URL; re-resolving a name
  // costs one lookup and is deterministic.
  let _areaText = null;
  // Set when a name could not be resolved. A rejected area outranks the normal
  // info line, because the person is still looking at the PREVIOUS isolation and
  // needs to know their typing did not take.
  let _fieldMessage = null;
  let _pendingText = null;
  // Layers that honour the isolation. Not a broadcast bus and not an event
  // emitter: a Set of plain listeners, called with the area, cleared on destroy.
  const _areaListeners = new Set();
  // SOLO support. The manager arrives late - `app/data.js` calls
  // `attachDataManager` on every catalog layer once it exists - so without it
  // this layer simply cannot solo, and says so rather than pretending.
  let _manager = null;
  let _soloSnapshot = null;
  let _soloMessage = null;
  let _boxes = [];
  let _scrim = [];
  let _enabled = false;
  let _dimmed = true;
  // Whether the scene owes a repaint. `enable`, `disable`, `setIsolation` and
  // `setDimmed` all set it and only `update()` clears it — so a change that
  // arrives between `enable()` and `update()` still reports itself, and
  // `update()` always has an honest answer to give the manager.
  let _dirty = true;
  let _framed = null;
  let _lastUpdate = null;
  let _rowControlsListener = null;

  /**
   * Repaint the panel row.
   *
   * The panel caches each row's controls and re-reads them only when a layer
   * calls the listener it handed to `setRowControlsListener`. Without one, an
   * isolation that changed keeps rendering the controls it first produced — so
   * CLEAR stays disabled over a live isolation and DIM keeps claiming to be on.
   */
  function notifyRowControls() {
    _rowControlsListener?.();
  }

  function clearEntities() {
    _dataSource?.entities.removeAll();
    _boxes = [];
    _scrim = [];
    _framed = null;
  }

  /**
   * Draw the isolation and the scrim.
   *
   * Called from `update()` and from `setIsolation`, so it must be cheap enough to
   * run twice and safe to run when there is no data source yet. Rebuilding the
   * whole collection rather than mutating entities is deliberate: an isolation is
   * a handful of rectangles, and a stale entity from a previous area is worse
   * than a repaint.
   */
  function render() {
    _boxes = isolationBoxes(_area);
    if (!_dataSource) return 0;
    _dataSource.entities.removeAll();
    if (!_boxes.length) {
      _scrim = [];
      _framed = null;
      return 0;
    }
    // The scrim goes on first so the box outline is drawn over it; Cesium has no
    // z-order for entities on one data source, but the outline is additive and
    // translucent so it reads through regardless.
    _scrim = _dimmed ? scrimRectangles(_boxes) : [];
    _scrim.forEach((rect, index) => {
      const [west, south, east, north] = rect;
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `isolation-scrim:${index}`,
          rectangle: {
            coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
            material:
              Cesium.Color.fromCssColorString(SCRIM_COLOR).withAlpha(
                SCRIM_ALPHA,
              ),
            // Clamped to the ground rather than at a fixed height: the scrim has
            // to dim the imagery, not float over it, and a fixed height punches
            // holes in it wherever the terrain rises.
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        }),
      );
    });
    _boxes.forEach((box, index) => {
      const [west, south, east, north] = box;
      const corners = [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
      ];
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `isolation-box:${index}`,
          rectangle: {
            coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
            material:
              Cesium.Color.fromCssColorString(OUTLINE_COLOR).withAlpha(
                OUTLINE_FILL_ALPHA,
              ),
            // Clamped to the ground, NOT a fixed height: the box has to sit on
            // the imagery rather than float over it.
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
          // The frame is a polyline, not `rectangle.outline`. Cesium silently
          // disables outlines on ground-clamped geometry, so asking for one
          // here drew nothing at all and left no error — the frame is the
          // whole visual affordance, so it is drawn the way that survives
          // terrain.
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([
              ...corners.flat(),
              ...corners[0],
            ]),
            width: 3,
            material: Cesium.Color.fromCssColorString(OUTLINE_COLOR),
            clampToGround: true,
          },
          properties: {
            isolation: true,
            box,
            label: _area ? describeIsolation(_area) : '',
          },
        }),
      );
    });
    return _scrim.length + _boxes.length;
  }

  /**
   * Hand the isolated area's name to the world overlay.
   *
   * `setEntries` throws unless given an array of entries in its own shape, and
   * this runs inside `init()`. Passing an object throws there, fails
   * registration, and surfaces only as the manager's generic "Could not enable
   * the requested layer".
   */
  function publish() {
    if (!overlayHost) return;
    _lastUpdate = Date.now();
    const frame = framingForBoxes(_boxes);
    const entries =
      _area && frame
        ? [
            {
              id: 'isolation-area',
              // The framed box's centre, so the label sits where the camera
              // goes. A split isolation labels its mainland, not the seam.
              position: Cesium.Cartesian3.fromDegrees(frame.lon, frame.lat, 0),
              cullPosition: Cesium.Cartesian3.fromDegrees(
                frame.lon,
                frame.lat,
                0,
              ),
              accent: OUTLINE_COLOR,
              title: describeIsolation(_area),
              details: [
                // The honest framing of the shape: a box, not a boundary.
                'Bounding box, not a boundary',
                splitNote(_boxes),
              ].filter(Boolean),
            },
          ]
        : [];
    overlayHost.setEntries(ISOLATION_LAYER_ID, entries, {
      cohortLimit: OVERLAY_LIMIT,
      collisionCapacity: 4,
      moving: false,
    });
  }

  const api = {
    id: ISOLATION_LAYER_ID,
    // The panel reads `name`, `icon` and `source`; without them it renders
    // "undefined" next to the layer.
    name: LAYER_NAME,
    icon: '🎯',
    source: ISOLATION_SOURCE_BADGE,
    // Nothing here expires: an isolation is set by a person, not by a feed.
    updateInterval: 0,

    init(viewer) {
      if (_viewer) throw new Error('Isolation layer is already initialized');
      _viewer = viewer;
      // Its own CustomDataSource, like every other layer. The shared collection
      // is emptied by whichever layer rendered last.
      _dataSource = new Cesium.CustomDataSource(ISOLATION_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      // A pending isolation set before `init` draws now, rather than waiting for
      // the first `update()` — which for a layer the manager enables with an
      // isolation already in hand would be one repaint too late.
      render();
      // A share link's area arrives through `setParams` before the scene exists.
      // Resolution is async, so it is flushed here rather than blocking `init`.
      if (_pendingText) {
        const pending = _pendingText;
        _pendingText = null;
        api.setIsolationText(pending);
      }
      overlayHost?.setVisible(ISOLATION_LAYER_ID, false);
      publish();
    },

    /**
     * Lifecycle protocol: `enable` marks the layer on, `update` does the work and
     * reports whether the scene changed. Returning false from `update` while
     * enabled is what makes the manager reject the transition, so the first
     * enable has to genuinely render and say so — even when there is no
     * isolation yet, which is the state a freshly-enabled layer is in.
     */
    enable() {
      if (_enabled) return;
      _enabled = true;
      _dirty = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible(ISOLATION_LAYER_ID, true);
      notifyRowControls();
    },

    disable() {
      if (!_enabled) return;
      _enabled = false;
      _dirty = true;
      // The AREA is kept, deliberately: isolation is a person's choice, not
      // loaded data, and re-enabling the mode should put their box back rather
      // than silently returning to the whole world.
      clearEntities();
      if (_dataSource) _dataSource.show = false;
      overlayHost?.clearSource(ISOLATION_LAYER_ID);
      overlayHost?.setVisible(ISOLATION_LAYER_ID, false);
      publish();
      notifyRowControls();
    },

    update() {
      if (!_enabled) return false;
      if (!_dirty) return false;
      render();
      _dirty = false;
      // True even with nothing to draw: the layer is on and its panel says so,
      // and false here is read as "could not enable".
      return true;
    },

    /**
     * Isolate an area, or pass null to clear.
     *
     * Safe before `init`, safe with an area that has no usable box, and safe
     * while disabled — all three are states a caller reaches rather than bugs.
     *
     * @param {object|null} area an admin area, a `resolveIsolation` hit, or null
     * @returns {boolean} whether the isolation changed
     */
    setIsolation(area) {
      const unit = area && typeof area === 'object' ? area : null;
      const boxes = unit ? isolationBoxes(unit) : [];
      // An area with no usable box is not an isolation. Clearing is the honest
      // answer; dimming everything outside nothing would black out the globe and
      // read as a rendering fault.
      const next = boxes.length ? unit : null;
      const changed = next !== _area || !sameBoxes(boxes, _boxes);
      _area = next;
      // Clearing the area clears the name with it. A link must never be able to
      // read out a stale area after the person has taken the isolation off.
      if (!next) _areaText = null;
      // Repainted eagerly when the scene is live, because a person who has just
      // named a place should see the box now rather than at the next tick. The
      // dirty flag is deliberately left SET: the manager judges an enable by
      // `update()`'s return, and a change that arrived between `enable()` and
      // `update()` must still report itself. The second render is a handful of
      // rectangles and buys an enable that cannot be rejected for having been
      // already up to date.
      _dirty = true;
      // `render` is safe with no data source — it computes the boxes, then has
      // nothing to put them on — so this runs either way and `getBoxes()` is
      // honest before `init` as well as after.
      render();
      publish();
      notifyRowControls();
      // Subscribers learn about the area only when it actually changed, so a
      // repeated set with the same area does not re-filter a storm layer that
      // has 44,717 rows behind it.
      if (changed) notifyAreaListeners();
      return changed;
    },

    /** The current isolation area, or null. */
    getIsolation() {
      return _area;
    },

    /**
     * Subscribe to area changes. This is how the storm layer learns to filter:
     * the isolation layer owns the area, and the layers that want to honour it
     * ask to be told. The alternative - the isolation layer reaching for the
     * storm layer - would make it know another layer's id and couple the two
     * lifetimes together.
     *
     * @param {(area: object|null) => void} listener called immediately with the
     *   current area, so a subscriber never has to ask separately
     * @returns {() => void} unsubscribe
     */
    onAreaChange(listener) {
      if (typeof listener !== 'function')
        throw new TypeError('onAreaChange needs a function');
      _areaListeners.add(listener);
      // Told immediately, and told through the same guard as every later
      // notification: a broken subscriber must not fail the subscription that
      // introduced it, which would read as "isolation is broken" rather than
      // "your listener was".
      safeNotify(listener);
      return () => _areaListeners.delete(listener);
    },

    /**
     * Resolve free text to an area and isolate it — "Texas", "New York State",
     * "Denver". This is the only entry point the panel uses, because the panel
     * has text and not an area object.
     *
     * @param {string|null} text
     * @param {{near?: {lat:number, lon:number}|null}} [opts] `near` breaks ties
     *   the way the geocoder does: several Springfields, one camera.
     * @returns {Promise<{ok:boolean, reason?:string}>} `ok:false` carries the
     *   reason so the panel can say "couldn't find that" instead of doing
     *   nothing, which is the failure mode this feature would otherwise ship.
     */
    async setIsolationText(text, { near = null } = {}) {
      const query = typeof text === 'string' ? text.trim() : '';
      if (!query) {
        _pendingText = null;
        api.setIsolation(null);
        return { ok: true };
      }
      // The same name again is not a change. Re-resolving would build a fresh
      // area object, read as a change by identity, and re-filter a storm layer
      // holding tens of thousands of rows to arrive at the answer it already had.
      if (_area && _areaText === query) return { ok: true, area: _area };
      const result = await resolveIsolation(query, { near, findPlace });
      if (!result.ok) {
        // A miss must not silently clear a working isolation, and must not throw
        // either: the person gets told, and the previous area stays put.
        return { ok: false, reason: result.reason };
      }
      _pendingText = null;
      _areaText = query;
      api.setIsolation(result.area);
      return { ok: true, area: result.area };
    },

    /** The text that produced the current isolation, for a share link. */
    getIsolationText() {
      return _areaText;
    },

    /**
     * Shareable intent. The area is carried as the text it was resolved from, so
     * the link survives a rebuild of the boundaries pack and stays readable.
     */
    getParams() {
      return _areaText ? { area: _areaText } : {};
    },

    /**
     * Apply a share link's intent. Held until `init` if the layer is not up yet,
     * for the same reason the storm layer holds its params.
     */
    setParams(params) {
      const area =
        params && typeof params.area === 'string' ? params.area : null;
      if (!area) return;
      if (_viewer) {
        api.setIsolationText(area);
        return;
      }
      _pendingText = area;
    },

    /** The current boxes, copied so a caller cannot mutate the layer's state. */
    getBoxes() {
      return _boxes.map((box) => [...box]);
    },

    /** The scrim rectangles currently drawn, copied. */
    getScrimRectangles() {
      return _scrim.map((rect) => [...rect]);
    },

    /** Remove the isolation and its scrim. @returns {boolean} */
    clearIsolation() {
      // Clearing the area releases SOLO. Leaving thirty layers switched off
      // because the area went away would be a far worse failure than SOLO
      // itself, so the two are tied together deliberately.
      void restoreSoloLayers({ ok: true, off: 0 });
      return api.setIsolation(null);
    },

    /**
     * Dim everything outside the isolation.
     *
     * Separate from `setIsolation` because they are different intentions: a box
     * you asked for and a screen that makes it obvious are not the same act.
     *
     * @param {boolean} value
     * @returns {boolean} the new state
     */
    setDimmed(value) {
      const next = value !== false;
      if (next === _dimmed) return _dimmed;
      _dimmed = next;
      _dirty = true;
      render();
      notifyRowControls();
      return _dimmed;
    },

    isDimmed() {
      return _dimmed;
    },

    /** The last framing this layer flew to, or null. */
    getFraming() {
      return _framed ? { ..._framed } : null;
    },

    /**
     * Fly the camera to the isolation.
     *
     * Frames the larger box: for a split isolation the union is an arc running to
     * the seam, and framing that would put the mainland in the middle of an
     * ocean. Returns false rather than moving the camera to nothing, so a caller
     * can tell a refused move from a completed one.
     *
     * @param {number} [durationSeconds]
     * @returns {boolean}
     */
    frameIsolation(durationSeconds = 2) {
      const frame = framingForBoxes(_boxes);
      if (!frame || !_viewer?.camera) return false;
      // Clamped rather than trusted: `flyTo` with a NaN duration throws inside
      // Cesium, and a panel chip that computes its own duration should not be
      // able to take the camera down with it.
      const duration = Number.isFinite(durationSeconds)
        ? Math.min(10, Math.max(0, durationSeconds))
        : 2;
      _viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          frame.lon,
          frame.lat,
          frame.altitudeM,
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration,
      });
      _framed = frame;
      publish();
      return true;
    },

    /**
     * Repaint this row's controls when the layer's state changes.
     * @param {Function|null} fn
     */
    setRowControlsListener(value) {
      _rowControlsListener = typeof value === 'function' ? value : null;
    },

    /**
     * Layer-panel controls.
     *
     * The panel's contract is `{readout, chips, legend, info}` — not a bare array.
     * Returning an array silently discards every control and the row renders
     * empty, because the panel reads `controls.chips`.
     *
     * `readout` stays falsy: truthy tells the panel to hide the chips and show a
     * count instead, which is the opposite of what this row is for.
     */
    /**
     * The layer-state manager, injected once the catalog is constructed.
     *
     * Late binding is deliberate: the isolation layer is built before the
     * manager exists, and this is the seam every other layer that needs to
     * drive layers uses (`src/app/data.js`).
     */
    attachDataManager(manager) {
      _manager = manager ?? null;
    },

    /** Is SOLO engaged right now? */
    isSolo() {
      return _soloSnapshot !== null;
    },

    /**
     * Turn every OTHER layer off, remembering exactly what was on.
     *
     * Two deliberate choices:
     *
     * 1. `origin: 'programmatic'`. `isExplicitLayerStateOrigin` persists only
     *    `user`, `voice` and `tool`, so switching layers off here cannot
     *    overwrite the layer set the person actually chose and has stored.
     * 2. Isolation itself is never in the snapshot. Solo is a lens, and taking
     *    the lens away must not take away the ability to take it off again.
     *
     * A failed restore is REPORTED rather than swallowed: this path switches off
     * up to thirty layers, and silently leaving someone with none of them back is
     * the worst outcome available.
     *
     * @param {boolean} on
     * @returns {Promise<{ok:boolean, off:number, restored?:number, failed?:string[]}>}
     */
    async setSolo(on) {
      if (!_manager) return { ok: false, off: 0, reason: 'no-manager' };
      if (on) {
        if (_soloSnapshot !== null) return { ok: true, off: 0, already: true };
        // Snapshot BEFORE anything is switched off.
        _soloSnapshot = [..._manager.getEnabledLayerIds()].filter(
          (id) => id !== ISOLATION_LAYER_ID,
        );
        try {
          const result = await _manager.clearSelectedLayers({
            origin: 'programmatic',
          });
          // `clearSelectedLayers` clears EVERYTHING, including this layer, so
          // isolation comes back unconditionally. The guard here used to be
          // "if it wasn't cleared, re-enable it", which is exactly backwards:
          // the layer that clears itself is the normal case, so the lens that
          // turned the lights off was then the only light left off.
          await _manager.setEnabled(ISOLATION_LAYER_ID, true, {
            origin: 'programmatic',
          });
          _soloMessage = null;
          notifyRowControls();
          return {
            ok: true,
            off: Math.max(0, (result.clearedIds?.length ?? 0) - 1),
          };
        } catch (error) {
          // The clear failed partway. Put back whatever we can, then report.
          await restoreSoloLayers({ ok: true, off: 0 });
          return { ok: false, off: 0, reason: 'clear-failed' };
        }
      }
      return restoreSoloLayers({ ok: true, off: 0 });
    },

    /**
     * Put back exactly the layers SOLO switched off.
     *
     * Separate from `setSolo(false)` because the same thing must happen when the
     * isolation is cleared or the layer is destroyed: leaving thirty layers off
     * because the area went away would be a far worse failure than SOLO itself.
     */
    getRowControls() {
      const ready = _boxes.length > 0;
      return {
        readout: null,
        // The only way to START an isolation. Everything above this row is a
        // control on an area that does not exist yet, so a panel that showed
        // them without this field would offer three disabled buttons and no
        // way to enable the feature at all.
        field: {
          id: 'isolation-area',
          value: _areaText || '',
          placeholder: 'Type an area - Texas, Denver, Japan',
          ariaLabel: 'Isolate the map to one country, state or city',
          onCommit(raw) {
            const query = String(raw ?? '').trim();
            if (!query) {
              // Empty text is NOT a request to clear. The panel commits on blur,
              // and a blur is what happens when someone clicks a chip — so an
              // empty commit used to arrive immediately after a perfectly good
              // one and silently destroy it. Clearing is what the CLEAR chip is
              // for, and it is visible.
              _fieldMessage = null;
              notifyRowControls();
              return { ok: true, unchanged: true };
            }
            return api.setIsolationText(query).then((result) => {
              if (!result.ok) {
                // Say why, and change nothing. Silently doing nothing is the
                // failure this feature would otherwise ship.
                _fieldMessage = `Could not find "${query}" — try a country, a state, or a city`;
              } else {
                // A stale rejection must not outlive the name that fixed it.
                _fieldMessage = null;
              }
              publish();
              notifyRowControls();
              return result;
            });
          },
        },
        chips: [
          {
            id: 'isolation-frame',
            label: 'FRAME',
            title: 'Fly the camera to the isolation',
            disabled: !ready,
            active: false,
            onClick: () => api.frameIsolation(),
          },
          {
            id: 'isolation-dim',
            label: 'DIM',
            title: 'Dim everything outside the isolation',
            disabled: !ready,
            active: _dimmed,
            onClick: () => api.setDimmed(!_dimmed),
          },
          {
            id: 'isolation-clear',
            label: 'CLEAR',
            title: 'Show the whole world again',
            disabled: !_area,
            active: false,
            onClick: () => api.clearIsolation(),
          },
          {
            id: 'isolation-solo',
            label: 'SOLO',
            // Opt-in, deliberately. Switching thirty layers off the moment
            // someone types a place name would be destructive and surprising;
            // this has to be a thing they ask for.
            title: _soloSnapshot
              ? 'Turn every other layer back on'
              : 'Turn every other layer off, and remember them',
            disabled: !_manager || (!_area && _soloSnapshot === null),
            active: _soloSnapshot !== null,
            onClick: () => api.setSolo(_soloSnapshot === null),
          },
        ],
        legend: [
          {
            label: 'Isolation box',
            color: OUTLINE_COLOR,
            title: 'The area bounding box — not its boundary',
          },
          {
            label: 'Dimmed',
            color: '#4a5568',
            title: 'Everything outside the isolation',
          },
        ],
        info: infoLine(),
      };
    },

    getStats() {
      return {
        enabled: _enabled,
        isolated: Boolean(_area),
        boxes: _boxes.length,
        scrimRectangles: _scrim.length,
        dimmed: _dimmed,
        label: _area ? describeIsolation(_area) : null,
        lastUpdate: _lastUpdate,
      };
    },

    destroy() {
      clearEntities();
      // Best-effort release, for the same reason: a destroyed isolation that
      // took thirty layers with it would be unrecoverable from the panel.
      if (_soloSnapshot !== null && _manager)
        void restoreSoloLayers({ ok: true, off: 0 });
      // Dropped before the area is nulled, and without notifying: a destroyed
      // isolation must not push a final "no isolation" into layers that have
      // outlived it.
      _areaListeners.clear();
      _area = null;
      _enabled = false;
      _dirty = true;
      _rowControlsListener = null;
      overlayHost?.clearSource(ISOLATION_LAYER_ID);
      if (_dataSource && _viewer) _viewer.dataSources.remove(_dataSource);
      _dataSource = null;
      _viewer = null;
    },
  };

  /**
   * The panel's info line: what is isolated, and what the shape is not.
   */
  function infoLine() {
    if (_fieldMessage) return _fieldMessage;
    // A partial restore outranks everything: the person is looking at a map
    // that lost layers and has to know which.
    if (_soloMessage) return _soloMessage;
    if (!_area) return 'No isolation. Everything on the map counts.';
    const solo = _soloSnapshot
      ? ` · SOLO on, ${_soloSnapshot.length} layers parked`
      : '';
    const parts = [describeIsolation(_area), splitNote(_boxes)];
    return parts.filter(Boolean).join(' · ') + solo;
  }

  /**
   * Tell every subscriber the current area. A throwing subscriber must not take
   * the others down with it, or leave the isolation half-applied: the dimming is
   * already drawn by the time this runs, and one bad listener cannot be allowed to
   * undo that or to stop the rest being told.
   */
  function safeNotify(listener) {
    try {
      listener(_area);
    } catch (error) {
      console.error('[isolation] an area subscriber threw', error);
    }
  }

  async function restoreSoloLayers(result) {
    if (_soloSnapshot === null) return result;
    const snapshot = _soloSnapshot;
    _soloSnapshot = null;
    try {
      await _manager.restoreEnabledLayerIds(snapshot, {
        origin: 'programmatic',
        // The snapshot deliberately omits isolation, and
        // `restoreEnabledLayerIds` is AUTHORITATIVE: it sets every layer it
        // does not exclude to `target.has(id)`. So omitting isolation from
        // the snapshot without excluding it turned the lens off on the way
        // back out - the one layer that must never be part of this dance.
        excludeLayerIds: [ISOLATION_LAYER_ID],
      });
      _soloMessage = null;
      notifyRowControls();
      return { ...result, ok: true, restored: snapshot.length, failed: [] };
    } catch (error) {
      const failed = error?.failedLayerIds ?? [];
      _soloMessage = `Restored ${snapshot.length - failed.length} of ${snapshot.length} layers — ${failed.join(', ')}`;
      notifyRowControls();
      return { ...result, ok: false, failed };
    }
  }

  function notifyAreaListeners() {
    for (const listener of [..._areaListeners]) safeNotify(listener);
  }

  return api;
}

/**
 * Data scope controller — owns the GLOBAL/VIEWPORT choice and the region it
 * currently implies.
 *
 * Why a controller and not a field on the settings object: switching scope
 * means re-fetching every scoped layer, which is async, and a user can toggle
 * twice while the first pass is still running. The generation guard copied from
 * MapSourceController (src/maps/controller.js) means the slower first switch
 * cannot land on top of the newer one and leave the UI describing a scope the
 * data no longer matches.
 *
 * Layers do not read this object directly. They ask their source for a region
 * through `getScope()`, which is a plain snapshot, so a layer can never hold a
 * live reference into controller state.
 */

import {
  DEFAULT_DATA_SCOPE,
  normalizeDataScopeMode,
  regionForScope,
  regionKey,
  regionToQueryParam,
  SCOPE_VIEWPORT,
  VIEWPORT_SCOPE_MAX_SPAN_DEG,
} from './dataScope.js';

export const DATA_SCOPE_STORAGE_KEY = 'gev:data-scope:v1';

/** Never throws: Safari private mode throws on the storage access itself. */
function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredDataScope(
  storage = safeStorage(),
  key = DATA_SCOPE_STORAGE_KEY,
) {
  try {
    return normalizeDataScopeMode(storage?.getItem(key) || DEFAULT_DATA_SCOPE);
  } catch {
    return DEFAULT_DATA_SCOPE;
  }
}

export function writeStoredDataScope(
  mode,
  storage = safeStorage(),
  key = DATA_SCOPE_STORAGE_KEY,
) {
  const normalized = normalizeDataScopeMode(mode);
  try {
    storage?.setItem(key, normalized);
  } catch {
    /* a setting that cannot persist is still a setting that works this session */
  }
  return normalized;
}

/**
 * View rectangle in degrees for the live camera, or null when the camera cannot
 * produce one (straight down the globe, or a scene with no globe geometry —
 * `computeViewRectangle` is undefined in the latter case, which is why the
 * callers all guard it).
 */
function cameraViewRect(viewer) {
  try {
    const rect = viewer?.camera?.computeViewRectangle?.();
    if (!rect) return null;
    const d = 180 / Math.PI;
    const view = {
      south: rect.south * d,
      west: rect.west * d,
      north: rect.north * d,
      east: rect.east * d,
    };
    // Cesium returns the entire globe when it cannot compute the frustum on a
    // globe — which is what happens once the camera climbs to near-space.
    // That rect's midpoint is (0,0), so viewport mode would fetch a box in
    // the Gulf of Guinea while the user watches Texas. Fall back to a box
    // around the camera itself, which is what "what am I looking at" means
    // when the view is effectively unbounded.
    const degenerate = view.north - view.south >= 179.999;
    if (degenerate) {
      const p = viewer?.camera?.positionCartographic;
      if (p) {
        const half = VIEWPORT_SCOPE_MAX_SPAN_DEG / 2 / d;
        return {
          south: Math.max(-90, p.latitude * d - half),
          west: Math.max(-180, p.longitude * d - half),
          north: Math.min(90, p.latitude * d + half),
          east: Math.min(180, p.longitude * d + half),
        };
      }
    }
    return view;
  } catch {
    return null;
  }
}

export function createScopeController({
  viewer = null,
  dataManager = null,
  storage = safeStorage(),
  storageKey = DATA_SCOPE_STORAGE_KEY,
} = {}) {
  let mode = readStoredDataScope(storage, storageKey);
  let region = null;
  let regionId = '';
  let switching = false;
  let lastError = null;
  let generation = 0;
  const listeners = new Set();

  function recomputeRegion() {
    region =
      mode === SCOPE_VIEWPORT
        ? regionForScope(mode, cameraViewRect(viewer))
        : null;
    regionId = regionKey(region);
  }

  function getScope() {
    return {
      mode,
      region: region ? { ...region } : null,
      regionId,
      /** Ready-to-send query value. '' means "no spatial filter". */
      query: regionToQueryParam(region),
      switching,
      generation,
      lastError,
    };
  }

  function getState() {
    return getScope();
  }

  function emit() {
    const snapshot = getState();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        /* one bad subscriber must not stop the others */
      }
    }
  }

  recomputeRegion();

  /**
   * Switch scope. Returns the state that actually won, which may not be the
   * request that was made if a newer switch landed first.
   */
  async function setMode(next, { persist = true, notify = true } = {}) {
    const normalized = normalizeDataScopeMode(next);
    if (normalized === mode) return getState();

    const gen = ++generation;
    const previous = mode;
    mode = normalized;
    switching = true;
    lastError = null;
    if (persist) writeStoredDataScope(mode, storage, storageKey);
    recomputeRegion();
    if (notify) emit();

    try {
      await refreshScopedLayers({ generation: gen, signal: null });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      // A superseded switch must not clear the flag the newer one owns.
      if (gen === generation) {
        switching = false;
        if (notify) emit();
      }
    }
    void previous;
    return getState();
  }

  /**
   * Re-run update() for every enabled layer.
   *
   * Layers that cannot scope ignore the region and simply re-run; that is
   * cheaper than maintaining a per-layer capability registry for a mode that
   * mostly re-fetches the same data anyway.
   */
  async function refreshScopedLayers({ generation: gen, signal = null } = {}) {
    const ids = dataManager?.getEnabledLayerIds?.();
    // `getEnabledLayerIds` returns a Set (see lifecycle.js), so normalise
    // before counting — a Set has .size, not .length, and reading .length off
    // it silently yielded undefined, which made this method return early and
    // refetch nothing.
    const layerIds = ids
      ? typeof ids.size === 'number'
        ? [...ids]
        : typeof ids.length === 'number'
          ? [...ids]
          : null
      : null;
    if (!layerIds) return;
    const results = await Promise.allSettled(
      layerIds
        .filter((id) => typeof id === 'string')
        .map((id) => dataManager.refreshLayer?.(id, { signal })),
    );
    // If a newer switch started while these were in flight, the newer switch
    // owns the refresh; this pass is now redundant but not harmful.
    if (gen !== generation) return;
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? layerIds[i] : null))
      .filter(Boolean);
    if (failed.length) {
      lastError = `refresh failed for ${failed.join(', ')}`;
    }
    return results;
  }

  /**
   * Recompute the region from the current camera without changing mode.
   *
   * Call on camera moveEnd in viewport mode: the user has flown somewhere new
   * and the region the providers are being asked about is now stale. Returns
   * true when the region actually changed, so callers can skip a refetch that
   * would land on the same cache key anyway.
   */
  function refreshRegion() {
    const before = regionId;
    recomputeRegion();
    return before !== regionId;
  }

  function subscribe(listener, { emitCurrent = false } = {}) {
    listeners.add(listener);
    if (emitCurrent) listener(getState());
    return () => listeners.delete(listener);
  }

  // --- camera-driven region refresh ---------------------------------------
  //
  // Without this the region is computed once and then silently wrong: the
  // user pans to Kansas, every provider is still being asked about Colorado,
  // and the viewport shows an empty map. Only moveEnd is used, never
  // moveStart/perFrame, so a drag costs one region recompute.
  let removeCameraListener = null;

  function addCameraListener() {
    const camera = viewer?.camera;
    if (!camera?.moveEnd?.addEventListener) return;
    const handler = () => {
      // recomputeRegion is a no-op in global mode, so this costs one camera
      // rectangle read while zoomed out and nothing at all in effect.
      const changed = refreshRegion();
      if (changed && getState().mode === 'viewport') {
        const gen = generation;
        refreshScopedLayers({ generation: gen }).catch(() => {});
      }
    };
    removeCameraListener = camera.moveEnd.addEventListener(handler) || null;
  }

  function detachCamera() {
    removeCameraListener?.();
    removeCameraListener = null;
  }

  return {
    getState,
    getScope,
    setMode,
    refreshRegion,
    subscribe,
    /**
     * Adopt dependencies that did not exist at construction.
     *
     * Both arrive late in the composition root: the viewer only exists once the
     * scene is built, and the data manager once the data phase runs. Binding
     * them here rather than by reordering construction keeps the controller
     * usable from a source that is created before either.
     */
    attach({ viewer: nextViewer, dataManager: nextDataManager } = {}) {
      if (nextViewer !== undefined) {
        if (nextViewer !== viewer) detachCamera();
        viewer = nextViewer;
        addCameraListener();
      }
      if (nextDataManager !== undefined) dataManager = nextDataManager;
      recomputeRegion();
      emit();
    },
    /** Drop the camera listener, for teardown paths. */
    detach() {
      detachCamera();
    },
    /** Kept for callers that only need to supply the viewer. */
    attachViewer(next) {
      this.attach({ viewer: next });
    },
  };
}

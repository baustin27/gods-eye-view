import * as Cesium from 'cesium';
import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';
import { isolationBoxes } from '../isolation/model.js';

export function createLifecycle({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { restoreSpriteOrderOnEnable } = services.sprites;
  const { clearSelectedEntityContextForLayer } = services.context;
  const { id, overlayHost } = config;

  const methods = {
    init(viewer) {
      if (layerState._destroyed) return;
      layerState._viewer = viewer;
      layerState._dataSource = new Cesium.CustomDataSource(id);
      layerState._dataSource.show = false;
      viewer.dataSources.add(layerState._dataSource);
    },

    async enable(viewer) {
      if (layerState._destroyed) return;
      layerState._enabled = true;
      layerState._viewer = viewer;
      if (!layerState._dataSource) this.init(viewer);
      if (layerState._dataSource) layerState._dataSource.show = true;
      if (layerState._billboards) {
        // The camera can have moved anywhere while the layer was off: moveEnd
        // was not being listened to, and the preRender watcher is inert while
        // disabled AND while the (untimed) refetch below is in flight. So the
        // retained per-sprite show flags describe the OLD viewpoint. Re-cull
        // BEFORE the collection becomes visible — otherwise re-enabling at a
        // new location flashes far-side fires through the planet (and keeps
        // near-side ones hidden) until the fetch resolves.
        components.rendering.refreshHorizonCulling();
        layerState._billboards.show = true;
      }
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, true);
      components.viewport.installLodWatcher();
      components.viewport.installMoveEndWatcher();
      components.selection.installClickHandler();
      registerPickOwner(id, (pickedId) =>
        layerState._pickIndexById.has(pickedId),
      );
      if (!layerState._fires.length && !layerState._loading)
        await components.ingestion.loadHeatmap();
      if (
        layerState._enabled &&
        !layerState._destroyed &&
        layerState._viewer === viewer
      )
        restoreSpriteOrderOnEnable('firms', viewer);
    },

    disable() {
      layerState.request?.abort();
      layerState.request = null;
      layerState._loading = false;
      layerState._enabled = false;
      components.selection.clearFireSelection();
      if (layerState._dataSource) layerState._dataSource.show = false;
      if (layerState._billboards) layerState._billboards.show = false;
      overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, false);
      clearSelectedEntityContextForLayer(id);
      components.selection.removeClickHandler();
      components.viewport.removeMoveEndWatcher();
      unregisterPickOwner(id);
      components.viewport.removeLodWatcher();
    },

    /**
     * Filter fires to an isolated area.
     *
     * Part of the area-scoping contract shared with `storm-reports`. FIRMS is a
     * good fit: it already filtered against a box-shaped `{west, south, east,
     * north, wraps}` for the viewport, and `isolationBoxes` produces
     * `[west, south, east, north]`, so this is the same test with a different
     * box rather than new geometry code.
     *
     * The box is used INSTEAD of the view bounds, not intersected with them. Both
     * mean "only show me this" and the area someone typed outranks the viewport
     * they scrolled.
     *
     * @param {object|null} area an isolation area, or null
     * @returns {boolean} whether an area is in force
     */
    setIsolation(area) {
      const boxes = area ? isolationBoxes(area) : [];
      const [first] = boxes;
      const next = first
        ? {
            west: first[0],
            south: first[1],
            east: first[2],
            north: first[3],
            wraps: false,
          }
        : null;
      if (JSON.stringify(next) === JSON.stringify(layerState._isolationBounds))
        return Boolean(next);
      layerState._isolationBounds = next;
      // The camera has not moved, so the render path's early-out would otherwise
      // swallow the change and the fires would not re-filter.
      layerState._isolationChanged = true;
      components.rendering.renderCurrentLod?.(true);
      return Boolean(next);
    },

    /** @returns {object|null} the area box in force, or null. */
    getIsolation() {
      return layerState._isolationBounds;
    },

    destroy(viewer = layerState._viewer) {
      layerState._isolationBounds = null;
      layerState.request?.abort();
      layerState.request = null;
      layerState._loading = false;
      if (layerState._destroyed) return;
      layerState._destroyed = true;
      layerState._enabled = false;
      components.viewport.removeLodWatcher();
      components.viewport.removeMoveEndWatcher();
      components.selection.removeClickHandler();
      unregisterPickOwner(id);
      if (layerState._dataSource && viewer) {
        viewer.dataSources.remove(layerState._dataSource, true);
      }
      layerState._dataSource = null;
      components.rendering.removeDetectionCollections(viewer);
      components.selection.clearContextRegistrations();
      clearSelectedEntityContextForLayer(id);
      layerState._fires = [];
      layerState._firesByFrp = [];
      layerState._cellCacheByGrid.clear();
      layerState._count = 0;
      layerState._cellCount = 0;
      layerState._lastUpdate = null;
      layerState._keyRequired = false;
      layerState._stale = false;
      layerState._error = null;
      layerState._currentLodId = null;
      overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, false);
      layerState._currentLodIndex = -1;
      layerState._lastViewRect = null;
      layerState._selectedFire = null;
      layerState._labelCandidates = [];
      layerState._labelLodDistance = 0;
      layerState._pickIndexById.clear();
      layerState._fireByCardId.clear();
      layerState._cullPositions.length = 0;
      layerState._camSnapValid = false;
    },
  };

  return { methods };
}

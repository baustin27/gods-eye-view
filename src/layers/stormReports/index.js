/**
 * Storm Reports — individual hail and wind reports, not an aggregate surface.
 *
 * Where the hail/wind layer paints a blended score across 0.25-degree cells,
 * this draws the reports themselves: one point per observation, sized and
 * coloured by magnitude, filterable by date, county and size, and clickable
 * through to the storm it belonged to.
 *
 * That level is the one a canvasser works from, and it is only possible
 * because the snapshot keeps the day. The aggregate layer averages seventy
 * years; this answers "what fell, where, how big, and on what day".
 * @module layers/stormReports/index
 */

import {
  hailBand,
  magnitudeLabel,
  matchesFilter,
  radiusMetres,
  windBand,
  worstFirst,
} from './model.js';
import { eventsFor, getSnapshot, reportsFor } from './source.js';

/** The layer id, and the token reserved for it in the layer-state ledger. */
export const STORM_REPORTS_ID = 'storm-reports';

/** Shareable options, all defaulted so an absent option means the default. */
export const STORM_REPORTS_DEFAULTS = Object.freeze({
  minHailIn: 1.0,
  minWindKt: 50,
  hazard: 'hail',
  fromDate: null,
  toDate: null,
});

/**
 * @param {{source: object, overlayHost?: object}} deps
 */
export function createStormReportsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Storm Reports layer requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('Storm Reports layer requires an overlay host');

  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _snapshot = null;
  let _events = [];
  let _visible = [];
  let _enabled = false;
  let _loading = false;
  let _lastError = null;
  let _lastUpdate = null;
  let _options = { ...STORM_REPORTS_DEFAULTS };
  let _pendingParams = null;
  let _selectedStormId = null;
  let _stats = null;

  /**
   * Durable option intent from the manager, replayed once data lands. The
   * manager applies params before the first load, when there is nothing to
   * filter yet, so they have to be remembered rather than applied.
   */
  function applyPendingParams() {
    if (!_pendingParams || !_snapshot) return;
    _options = { ..._options, ..._pendingParams };
    _pendingParams = null;
  }

  /** Years the current date window touches. */
  function yearsInWindow() {
    if (!_snapshot?.years?.length) return [];
    const from = _options.fromDate
      ? Number(_options.fromDate.slice(0, 4))
      : _snapshot.years[0];
    const to = _options.toDate
      ? Number(_options.toDate.slice(0, 4))
      : _snapshot.years.at(-1);
    return _snapshot.years.filter((y) => Number(y) >= from && Number(y) <= to);
  }

  async function reload() {
    if (!_enabled) return;
    _loading = true;
    _lastError = null;
    publish();
    try {
      _snapshot = await source.getSnapshot({ signal: _request?.signal });
      applyPendingParams();
      const years = yearsInWindow();
      const [packed, events] = await Promise.all([
        reportsFor(years, _request?.signal),
        eventsFor(years, _request?.signal),
      ]);
      if (_request?.signal?.aborted) return;
      _events = events;
      applyFilter(packed);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      _lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      _loading = false;
      publish();
    }
  }

  /** Apply the option filter and paint. */
  function applyFilter(packed) {
    const { hazard, minHailIn, minWindKt, fromDate, toDate } = _options;
    const rows = packed.filter((row) =>
      matchesFilter(unpack(row), {
        hazard,
        minSize: hazard === 'hail' ? minHailIn : minWindKt,
        from: fromDate,
        to: toDate,
      }),
    );
    _visible = rows.map(unpack);
    _stats = {
      total: _visible.length,
      hail: _visible.filter((r) => r.hazard === 'hail').length,
      wind: _visible.filter((r) => r.hazard === 'wind').length,
      worst: worstFirst(_visible, hazard, 1)[0] || null,
      storms: _events.length,
    };
    render();
    publish();
  }

  /** Expand a packed row, reusing the loader's expansion. */
  function unpack(row) {
    const [
      date,
      minute,
      hazardCode,
      size,
      lat,
      lon,
      fips,
      state,
      county,
      loss,
      comment,
      sources,
      trace,
    ] = row;
    return {
      date,
      minute: minute < 0 ? null : minute,
      hazard: hazardCode === 0 ? 'hail' : 'wind',
      size: size || null,
      lat,
      lon,
      countyFips: fips || null,
      state: state || null,
      county: county || null,
      loss: loss || 0,
      comment: comment || null,
      sources: String(sources || '')
        .split(',')
        .filter(Boolean),
      trace: Boolean(trace),
    };
  }

  /** Paint the visible reports. */
  function render() {
    if (!_viewer) return;
    const host = overlayHost.entityCollection?.() || _viewer.entities;
    host.removeAll();
    for (const report of _visible) {
      const band =
        report.hazard === 'hail'
          ? hailBand(report.size)
          : windBand(report.size);
      if (!band) continue;
      host.add({
        id: `storm-report-${report.date}-${report.lat}-${report.lon}`,
        position: {
          longitude: report.lon,
          latitude: report.lat,
          height: 0,
        },
        point: {
          pixelSize: Math.max(
            4,
            Math.round(radiusMetres(report.size, report.hazard) / 220),
          ),
          color: band.color,
          outlineColor: '#000000',
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: report,
      });
    }
  }

  function publish() {
    if (!_viewer) return;
    overlayHost.publish?.({
      id: STORM_REPORTS_ID,
      enabled: _enabled,
      loading: _loading,
      error: _lastError,
      update: _lastUpdate,
      stats: _stats,
      options: { ..._options },
      visibleCount: _visible.length,
    });
  }

  return {
    id: STORM_REPORTS_ID,
    title: 'Storm Reports',

    init(viewer) {
      _viewer = viewer;
      render();
      publish();
    },

    async setEnabled(enabled) {
      if (enabled === _enabled) return _enabled;
      _enabled = enabled;
      if (enabled) {
        _request = new AbortController();
        await reload();
      } else {
        _request?.abort();
        _request = null;
        _visible = [];
        _viewer?.entities?.removeAll?.();
        publish();
      }
      return _enabled;
    },

    /**
     * Durable options from the manager. Remembered rather than applied when no
     * data has loaded, and replayed on the next load.
     */
    setParams(params) {
      _pendingParams = { ...(_pendingParams || {}), ...params };
      if (_snapshot) applyPendingParams();
      publish();
    },

    /** Current option intent, which is what a share link encodes. */
    getParams() {
      return {
        ...STORM_REPORTS_DEFAULTS,
        ..._options,
        ...(_pendingParams || {}),
      };
    },

    /** Every storm in the current window, for a picker. */
    getStorms() {
      return [..._events].sort((a, b) => (a.date < b.date ? 1 : -1));
    },

    /** The reports belonging to one storm. */
    getStormReports(stormId) {
      const storm = _events.find((e) => e.id === stormId);
      if (!storm) return [];
      return _visible
        .filter((r) => r.date === storm.date)
        .filter((r) => worstFirst([r], r.hazard, 1).length >= 0)
        .sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    },

    /** The card a click opens. */
    describeReport(report) {
      const storm = _events.find((e) => e.date === report.date);
      return {
        ...report,
        magnitude: magnitudeLabel(report),
        band:
          (report.hazard === 'hail' ? hailBand : windBand)(report.size)
            ?.label || null,
        storm: storm
          ? {
              id: storm.id,
              maxHailIn: storm.maxHailIn,
              maxWindKt: storm.maxWindKt,
              reportCount: storm.reportCount,
              narrative: storm.narrative,
              identitySource: storm.identitySource,
            }
          : null,
      };
    },

    destroy() {
      _request?.abort();
      _viewer?.entities?.removeAll?.();
      _viewer = null;
    },
  };
}

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
import * as Cesium from 'cesium';
import { stormDays } from '../../data/stormReports.js';
import { STORM_SOURCE_BADGE } from '../../data/stormAttribution.js';

/** The layer id, and the token reserved for it in the layer-state ledger. */
export const STORM_REPORTS_ID = 'storm-reports';

/** Shareable options, all defaulted so an absent option means the default. */
/** How many report cards the overlay may show at once. */
const OVERLAY_COHORT_LIMIT = 25;

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
  let _loaded = false;
  let _optionsDirty = true;
  let _previouslyEmpty = true;

  /**
   * Durable option intent from the manager, replayed once data lands. The
   * manager applies params before the first load, when there is nothing to
   * filter yet, so they have to be remembered rather than applied.
   *
   * The shareable option is `minHailTenths`, because the layer-state codec
   * carries integer options only and 1.75 inches has to survive a round trip.
   * It is translated here rather than in the filter, so nothing downstream ever
   * sees tenths.
   */
  function applyPendingParams() {
    if (!_pendingParams || !_snapshot) return;
    const next = { ..._options, ..._pendingParams };
    _options = {
      ...next,
      minHailIn: Number.isFinite(next.minHailTenths)
        ? next.minHailTenths / 10
        : next.minHailIn,
    };
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
      // Through the source, not around it. Reaching into the module directly
      // made the data path unreachable to a stub, which is how a layer this
      // small ends up untested.
      const years = yearsInWindow();
      const [packed, events] = await Promise.all([
        source.reportsFor(years, _request?.signal),
        source.eventsFor(years, _request?.signal),
      ]);
      if (_request?.signal?.aborted) return;
      _events = events;
      applyFilter(packed);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      _lastError = error instanceof Error ? error : new Error(String(error));
      // Surfaced loudly: a layer that swallows its load failure returns false
      // from update(), the manager rejects the transition, and the only
      // visible symptom is "Could not enable the requested layer" with no cause
      // anywhere. That is what made this cost an hour.
      console.error('[Storm Reports] load failed:', _lastError.message);
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
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    for (const report of _visible) {
      const band =
        report.hazard === 'hail'
          ? hailBand(report.size)
          : windBand(report.size);
      if (!band) continue;
      _dataSource.entities.add({
        // Size and time in the id: two reports at the same place on the same
        // day are separate observations, and a data source keys on this.
        id: `storm-report-${report.date}-${report.minute}-${report.lat}-${report.lon}-${report.hazard}-${report.size}`,
        position: Cesium.Cartesian3.fromDegrees(report.lon, report.lat),
        point: {
          // Magnitude-scaled, then clamped in pixels: at 155,737 reports an
          // unclamped radius turns a national view into a solid sheet.
          pixelSize: Math.max(
            4,
            Math.min(
              20,
              Math.round(radiusMetres(report.size, report.hazard) / 320),
            ),
          ),
          color: Cesium.Color.fromCssColorString(band.color),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.0, 4.0e7, 0.35),
        },
        properties: report,
      });
    }
  }

  /**
   * Hand the worst reports to the world overlay as clickable cards.
   *
   * `setOverlayEntries` throws unless given an array of entries in its own
   * shape, and this call runs inside `init()`. Passing an object threw there,
   * which failed registration, and the only symptom was the manager's generic
   * "Could not enable the requested layer".
   */
  function publish() {
    if (!_viewer) return;
    _lastUpdate = Date.now();
    const entries = _enabled
      ? worstFirst(_visible, _options.hazard, OVERLAY_COHORT_LIMIT).map(
          (report) => {
            const band =
              report.hazard === 'hail'
                ? hailBand(report.size)
                : windBand(report.size);
            const position = Cesium.Cartesian3.fromDegrees(
              report.lon,
              report.lat,
            );
            return {
              id: `storm-report:${report.date}:${report.lat}:${report.lon}`,
              position,
              cullPosition: position,
              color: band?.color || '#cccccc',
              title: `${magnitudeLabel(report)} — ${report.county || report.state || 'unknown place'}`,
              details: [
                report.county
                  ? `${report.county}, ${report.state}`
                  : report.state || '',
                report.date,
              ]
                .filter(Boolean)
                .join(' · '),
              caveat: band
                ? undefined
                : 'No measured magnitude on this report.',
            };
          },
        )
      : [];
    overlayHost.setEntries(STORM_REPORTS_ID, entries, {
      cohortLimit: OVERLAY_COHORT_LIMIT,
      collisionCapacity: 64,
      moving: false,
    });
    _stats = { ...(_stats || {}), visibleCount: _visible.length };
  }

  return {
    id: STORM_REPORTS_ID,
    // The panel reads `name`, `icon` and `source`; without them it renders
    // "undefined" next to the layer.
    name: 'Hail & Wind — Individual Reports',
    icon: '📍',
    source: STORM_SOURCE_BADGE,
    updateInterval: 0,

    init(viewer) {
      if (_viewer)
        throw new Error('Storm Reports layer is already initialized');
      _viewer = viewer;
      // Its own CustomDataSource, like every other layer. Writing into the
      // shared viewer.entities would have every entity cleared by whichever
      // layer rendered last.
      _dataSource = new Cesium.CustomDataSource(STORM_REPORTS_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(STORM_REPORTS_ID, false);
      publish();
    },

    /**
     * Lifecycle protocol: `enable` marks the layer on, `update` does the work
     * and reports whether the scene changed. Returning false from `update`
     * while enabled is what makes the manager reject the transition, so the
     * first enable has to genuinely render and say so.
     */
    enable() {
      if (_enabled) return;
      _enabled = true;
      _request = new AbortController();
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(STORM_REPORTS_ID, true);
      publish();
    },

    disable() {
      if (!_enabled) return;
      _enabled = false;
      _request?.abort();
      _request = null;
      _visible = [];
      _loaded = false;
      _optionsDirty = true;
      if (_dataSource) {
        _dataSource.show = false;
        _dataSource.entities.removeAll();
      }
      overlayHost.clearSource(STORM_REPORTS_ID);
      overlayHost.setVisible(STORM_REPORTS_ID, false);
      publish();
    },

    async update() {
      if (!_enabled) return false;
      if (_loaded && !_optionsDirty) return false;
      await reload();
      _loaded = true;
      _optionsDirty = false;
      // A failed load is still a state change — the layer is on, and its panel
      // says why. Returning false here would be swallowed as "could not enable".
      if (_lastError) return true;
      return _visible.length > 0 || _previouslyEmpty !== true;
    },

    /**
     * Durable options from the manager. Remembered rather than applied when no
     * data has loaded, and replayed on the next load.
     */
    setParams(params) {
      _pendingParams = { ...(_pendingParams || {}), ...params };
      if (_snapshot) {
        applyPendingParams();
        _optionsDirty = true;
      }
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

    /**
     * Set the exact window. A single day is `setDate('2026-08-10')`; the layer
     * compares the ISO string, so day granularity needs no separate code path.
     * @param {string|null} from `YYYY-MM-DD`, or null for the whole record.
     * @param {string|null} [to]
     */
    setDateRange(from, to = from) {
      _options = { ..._options, fromDate: from || null, toDate: to || null };
      _pendingParams = null;
      _optionsDirty = true;
      _loaded = false;
      publish();
    },

    /** One exact day. */
    setDate(day) {
      this.setDateRange(day || null, day || null);
    },

    /** Clear the window back to the whole record. */
    clearDateRange() {
      _options = { ..._options, fromDate: null, toDate: null };
      _optionsDirty = true;
      _loaded = false;
      publish();
    },

    /** The window currently in force. */
    getDateRange() {
      return { from: _options.fromDate || null, to: _options.toDate || null };
    },

    /** Storm days in the snapshot, newest first, for a date picker. */
    getStormDays(limit = 400) {
      const days = stormDays(_snapshot || { days: {} });
      return limit ? days.slice(0, limit) : days;
    },

    /**
     * Layer-panel controls: the exact-date picker, the size threshold and the
     * hazard switch.
     *
     * The date chips are the point of this layer. The aggregate layer can only
     * offer decades, because a decade is what it has; this one has a day, and a
     * control that stops at "2010 onward" would hide the one thing it can do
     * that the other cannot.
     */
    getRowControls() {
      const days = stormDays(_snapshot || { days: {} });
      const ready = Boolean(_snapshot);
      const selected = _options.fromDate;
      return [
        {
          group: 'Date',
          id: 'storm-reports-all',
          label: 'ALL DATES',
          title: 'Every storm day in the record',
          disabled: !ready,
          active: !selected,
          onClick: () => this.clearDateRange(),
        },
        // The most recent days, which is what a canvasser works from.
        ...days.slice(0, 12).map((day) => ({
          group: 'Date',
          id: `storm-reports-${day.date}`,
          label: day.date,
          title: `${day.hail} hail, ${day.wind} wind reports`,
          disabled: !ready,
          active: selected === day.date,
          onClick: () => this.setDate(day.date),
        })),
        {
          group: 'Hail size',
          id: 'storm-reports-hail-075',
          label: '0.75\u2033',
          title: 'Include hail down to three-quarter inch',
          active: _options.minHailIn <= 0.75,
          onClick: () => this.setMinHailIn(0.75),
        },
        {
          group: 'Hail size',
          id: 'storm-reports-hail-1',
          label: '1\u2033',
          title: 'Only hail an inch or larger',
          active: _options.minHailIn === 1,
          onClick: () => this.setMinHailIn(1),
        },
        {
          group: 'Hail size',
          id: 'storm-reports-hail-15',
          label: '1.5\u2033',
          title: 'Only hail likely to damage a shingle',
          active: _options.minHailIn === 1.5,
          onClick: () => this.setMinHailIn(1.5),
        },
        {
          group: 'Hail size',
          id: 'storm-reports-hail-2',
          label: '2\u2033+',
          title: 'Only hail of two inches or more',
          active: _options.minHailIn >= 2,
          onClick: () => this.setMinHailIn(2),
        },
        {
          group: 'Show',
          id: 'storm-reports-hail',
          label: 'HAIL',
          active: _options.hazard === 'hail',
          onClick: () => this.setHazard('hail'),
        },
        {
          group: 'Show',
          id: 'storm-reports-wind',
          label: 'WIND',
          active: _options.hazard === 'wind',
          onClick: () => this.setHazard('wind'),
        },
      ];
    },

    /** Threshold in inches. Persisted in tenths so the codec stays integral. */
    setMinHailIn(inches) {
      _options = { ..._options, minHailIn: inches };
      _pendingParams = {
        ...(_pendingParams || {}),
        minHailTenths: Math.round(inches * 10),
      };
      _optionsDirty = true;
      publish();
    },

    /** Switch which hazard the layer is showing. */
    setHazard(hazard) {
      _options = { ..._options, hazard: hazard === 'wind' ? 'wind' : 'hail' };
      _optionsDirty = true;
      publish();
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
      overlayHost.clearSource(STORM_REPORTS_ID);
      if (_dataSource && _viewer) _viewer.dataSources.remove(_dataSource);
      _dataSource = null;
      _viewer = null;
    },
  };
}

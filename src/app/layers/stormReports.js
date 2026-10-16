import { createStormReportsLayer } from '../../layers/stormReports/index.js';
import { loadRadarForYears } from '../../data/stormReports.js';
import {
  eventsFor,
  getSnapshot,
  reportsFor,
} from '../../layers/stormReports/source.js';
import { overlayHost } from './overlayHost.js';

/**
 * The report-level storm layer, wired to the application overlay host.
 *
 * Unlike the aggregate storm layers, this one has no bundled snapshot provider:
 * its data ships as gzipped per-year files and is fetched on demand, so only
 * the years the current date window touches are ever loaded. The layer reads
 * the year payloads itself through its own source module, so this constructor
 * only has to hand it the index reader.
 *
 * The radar source is optional in the layer and genuinely absent-safe: without
 * it the cross-reference is skipped and the panel says nothing about radar.
 * It is wired here rather than inside the layer so a checkout without the
 * radar build still constructs and runs.
 */
export function createApplicationStormReports({ source } = {}) {
  return createStormReportsLayer({
    source: source || {
      getSnapshot: () => getSnapshot(),
      reportsFor,
      eventsFor,
    },
    overlayHost,
    radarSource: {
      // Per-year radar files, year-scoped statistics: a cell's peak and day
      // count are for that year alone, so one storm day compares against its
      // own year rather than a 2021-2026 lifetime aggregate.
      cellsFor: (years, signal) => loadRadarForYears(years, signal),
    },
  });
}

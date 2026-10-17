import { createStormReportsLayer } from '../../layers/stormReports/index.js';
import {
  loadFineRadarDay,
  loadRadarDaysForYear,
} from '../../data/stormReports.js';
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
      // Per-day radar files, day-scoped statistics: a cell's peak is for one
      // calendar day, so a day's comparison and its swath are about that day
      // rather than a 2021-2026 lifetime aggregate. The layer asks for one year
      // at a time and selects the day's cells out of it.
      daysFor: (year, signal) => loadRadarDaysForYear(year, signal),
      // The fine 1 km field, one calendar day at a time. A SIBLING of
      // `daysFor`, not a mode of it: the two index spaces are 25x apart in each
      // axis and index 0 means different places in each, so sharing a cache or a
      // decoder between them would return plausible numbers for the wrong cells.
      // The layer only asks for this when the window is a single day.
      dayFor: (date, signal) => loadFineRadarDay(date, signal),
    },
  });
}

import { createStormReportsLayer } from '../../layers/stormReports/index.js';
import { getSnapshot } from '../../layers/stormReports/source.js';
import { overlayHost } from './overlayHost.js';

/**
 * The report-level storm layer, wired to the application overlay host.
 *
 * Unlike the aggregate storm layers, this one has no bundled snapshot provider:
 * its data ships as gzipped per-year files and is fetched on demand, so only
 * the years the current date window touches are ever loaded. The layer reads
 * the year payloads itself through its own source module, so this constructor
 * only has to hand it the index reader.
 */
export function createApplicationStormReports({ source } = {}) {
  return createStormReportsLayer({
    source: source || { getSnapshot: () => getSnapshot() },
    overlayHost,
  });
}

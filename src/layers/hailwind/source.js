/**
 * Storm intelligence source — the bundled snapshot loader.
 *
 * The layer reads build artefacts committed under
 * `src/data/local_data/storm/`, not a live endpoint. That is a deliberate
 * trade: hail and wind history is a static record, so a live fetch would only
 * add a failure mode. The near-real-time feed is a separate, optional proxy
 * (`server/providers/storm-recent.js`) that augments rather than replaces this.
 *
 * @module layers/hailwind/source
 */

import { loadStormDataset } from '../../data/stormDatasets.js';
import { normalizeStormDataset } from './records.js';

/**
 * Construct the bundled storm source without performing any I/O.
 * @param {{load?: Function}} [options]
 */
export function createStormSource({ load = loadStormDataset } = {}) {
  return {
    label: 'NOAA/NWS SPC + FEMA NRI',
    /**
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<object>} Validated dataset.
     * @throws when the snapshot is missing or contains no usable cells.
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const raw = await load({ signal });
      signal?.throwIfAborted();
      const result = normalizeStormDataset(raw);
      if (!result.ok) throw new Error(result.reason);
      return result.dataset;
    },
  };
}

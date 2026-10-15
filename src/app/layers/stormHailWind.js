import { createStormLayer } from '../../layers/hailwind/index.js';
import {
  STORM_FACET_OBSERVED,
  STORM_FACET_EXPECTED,
} from '../../layers/hailwind/model.js';
import { overlayHost } from './overlayHost.js';

/** Wire the bundled storm snapshot to the application overlay host. */
export function createApplicationStorm(options) {
  return createStormLayer({ overlayHost, ...options });
}

/**
 * Both storm layers over one shared source.
 *
 * They read the same bundled snapshot, and `loadStormDataset` caches a single
 * in-flight promise, so enabling both costs one load rather than two.
 */
export function createApplicationStormLayers(options) {
  return {
    'storm-observed': createApplicationStorm({
      ...options,
      facet: STORM_FACET_OBSERVED,
    }),
    'storm-expected': createApplicationStorm({
      ...options,
      facet: STORM_FACET_EXPECTED,
    }),
  };
}

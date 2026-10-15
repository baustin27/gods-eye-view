import { createStormLayer } from '../layers/hailwind/index.js';
import { createStormSource } from '../layers/hailwind/source.js';
import { createApplicationStorm } from '../app/layers/stormHailWind.js';

export * from '../layers/hailwind/index.js';

/**
 * Wire the bundled storm snapshot and the application overlay owner.
 * The snapshot is a build artefact, so the default source performs no I/O until
 * the layer is first enabled.
 */
export function createStormHailWindLayer({
  source = createStormSource(),
  ...options
} = {}) {
  return createApplicationStorm({ source, ...options });
}

export default createStormHailWindLayer();

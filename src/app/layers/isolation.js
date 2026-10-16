import { createIsolationLayer } from '../../layers/isolation/index.js';
import { overlayHost } from './overlayHost.js';

/**
 * Isolation Mode, wired to the application overlay host.
 *
 * The shortest constructor in the catalog, and deliberately so: isolation has
 * no source. `src/data/isolation.js` resolves a typed name against bundled
 * Natural Earth and US Census boundaries with no network call, so there is
 * nothing to configure, nothing to declare in `sourceComposition.js`, and no
 * unavailable state to report — the layer works or the boundaries are missing
 * from the checkout, which is a build problem rather than a provider one.
 *
 * The area is handed in from outside through `setIsolation`, so this constructor
 * owns no state beyond the host the label card is published to.
 */
export function createApplicationIsolation() {
  return createIsolationLayer({ overlayHost });
}

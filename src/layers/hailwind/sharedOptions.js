/**
 * Shared option bag for the two storm layers.
 *
 * `storm-observed` and `storm-expected` are one split layer presented as two,
 * and they share a single option owner, so a link that says "hail only, since
 * 2010" means the same thing on both. That is only true on restore. A write to
 * one layer afterwards updates the shared durable state and that layer, and
 * leaves the other showing a different window until the next reload — which
 * defeats the whole point of putting them side by side.
 *
 * This closes that gap without touching the layer manager's mirroring, which
 * is shared with `military`->`flights`: syncing every same-owner layer as a
 * side effect of fixing storm would change behaviour nobody asked to change.
 *
 * Loop safety: a layer applies an incoming patch locally *without*
 * republishing. Only a genuine change originating from a layer or the manager
 * publishes. So A publishes -> B applies silently -> neither republishes.
 */

/** @typedef {{fromYear:number, includeHail:boolean, includeWind:boolean, surface:string}} StormOptions */

/** @type {StormOptions|null} null until a layer seeds it from its own defaults. */
let bag = null;

/**
 * Subscribers, held weakly.
 *
 * A strong Set here would pin every layer that ever subscribed, and through
 * the layer closure that means its whole scored dataset — thousands of rows and
 * entities each. In production the two layers live for the page and unsubscribe
 * on destroy, so a strong Set is survivable; but it makes any future layer that
 * forgets to unsubscribe a slow memory leak that only shows up as the tab
 * getting heavier. Weak references make the registry incapable of that.
 *
 * Dead entries are pruned whenever a change is published.
 *
 * @type {Set<WeakRef<(options: StormOptions, meta: {origin: string}) => void>>}
 */
const subscribers = new Set();

/** Re-entrancy guard so a notification cannot cascade back into a publish. */
let notifying = false;

/**
 * The current bag, or null before any layer has seeded one.
 * @returns {StormOptions|null}
 */
export function stormOptions() {
  return bag ? { ...bag } : null;
}

/**
 * Seed the bag from a layer's own defaults, without notifying.
 *
 * Called when the first layer starts. A second layer seeding later must not
 * overwrite what the first established, or the values would depend on which
 * layer happened to load first.
 *
 * @param {StormOptions} defaults
 * @returns {StormOptions}
 */
export function seedStormOptions(defaults) {
  if (!bag) bag = { ...defaults };
  return { ...bag };
}

/**
 * Merge a patch and notify subscribers.
 *
 * @param {Partial<StormOptions>} patch
 * @param {{origin?: string}} [meta]
 * @returns {StormOptions|null} The new bag, or null when nothing changed.
 */
export function publishStormOptions(patch, { origin = 'programmatic' } = {}) {
  if (!bag || notifying || !patch) return bag ? { ...bag } : null;
  const next = { ...bag };
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.is(next[key], value)) {
      next[key] = value;
      changed = true;
    }
  }
  if (!changed) return { ...bag };
  bag = next;
  notifying = true;
  try {
    for (const weak of [...subscribers]) {
      const subscriber = weak.deref();
      if (!subscriber) {
        subscribers.delete(weak);
        continue;
      }
      try {
        subscriber({ ...bag }, { origin });
      } catch {
        // A broken subscriber must not stop the others from seeing the change.
      }
    }
  } finally {
    notifying = false;
  }
  return { ...bag };
}

/**
 * Subscribe to bag changes.
 *
 * @param {(options: StormOptions, meta: {origin: string}) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribeStormOptions(listener) {
  const weak = new WeakRef(listener);
  subscribers.add(weak);
  return () => subscribers.delete(weak);
}

/**
 * Test seam: drop all shared state.
 *
 * Only for tests — the two layers are expected to live for the life of the
 * page, and resetting this underneath a running layer would desynchronise it.
 */
export function resetStormOptions() {
  bag = null;
  subscribers.clear();
  notifying = false;
}

/**
 * How many subscribers are still alive. Test-facing.
 * @returns {number}
 */
export function liveSubscriberCount() {
  let live = 0;
  for (const weak of [...subscribers]) {
    if (weak.deref()) live += 1;
    else subscribers.delete(weak);
  }
  return live;
}

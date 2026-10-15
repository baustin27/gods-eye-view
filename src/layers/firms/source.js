import { regionToQueryParam } from '../../data/dataScope.js';

/**
 * Live NASA FIRMS active-fire endpoint.
 *
 * `getScope` is a callback rather than a value so the request always reflects
 * the scope at the moment it is made: the user may have panned since the last
 * fetch, and a captured region would silently request a box that no longer
 * matches the view. Returns '' (world) or 'south,west,north,east'.
 */
export function createFirmsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getScope = null,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const bbox = regionToQueryParam(getScope?.()?.region ?? null);
      const query = bbox ? `?bbox=${encodeURIComponent(bbox)}` : '';
      const response = await fetchImpl(`/api/firms${query}`, {
        signal,
        cache: 'no-store',
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        /* status below remains authoritative */
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        if (response.status === 503 && payload?.error === 'no_key')
          return { keyRequired: true };
        if (response.status === 400)
          // A refused bbox is our bug, not the provider's: falling back to a
          // world request would turn a scoping mistake into a quota event.
          throw new Error(
            `FIRMS rejected the region: ${payload?.error || 'bad bbox'}`,
          );
        throw new Error(`FIRMS HTTP ${response.status}`);
      }
      if (!Array.isArray(payload?.fires))
        throw new Error('Malformed fire snapshot');
      return payload;
    },
  };
}

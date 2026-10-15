import { normalizeEarthquakeSnapshot } from './records.js';
import { regionToQueryParam } from '../../data/dataScope.js';

/**
 * USGS FDSN event feed, optionally scoped to a region.
 *
 * The unscoped form is the static `all_day` summary GeoJSON — no key, one
 * request, everything on the planet. It is kept as the default because a
 * viewport scope has to switch to the FDSN query endpoint, and that endpoint
 * takes `minlatitude`/`maxlatitude`/`minlongitude`/`maxlongitude` — the axis
 * pairs USGS uses, which are named per-parameter so the order is unambiguous.
 *
 * USGS needs no key, so this is the cheapest layer to scope.
 */

const SUMMARY_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const FDSN_BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

/** Request and validate a complete USGS snapshot before it can replace displayed events. */
export function createUsgsEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getScope = null,
} = {}) {
  /** The FDSN query URL for a region, or null when nothing is scoped. */
  function urlFor(region) {
    const bbox = regionToQueryParam(region ?? null);
    if (!bbox) return SUMMARY_URL;
    const [south, west, north, east] = bbox.split(',').map(Number);
    if ([south, west, north, east].some((v) => !Number.isFinite(v))) {
      throw new Error(
        'region did not survive the round trip to USGS coordinates',
      );
    }
    const url = new URL(FDSN_BASE);
    // Named parameters, so unlike the FIRMS area segment there is no axis-order
    // guess to get wrong.
    url.searchParams.set('format', 'geojson');
    url.searchParams.set('minlatitude', String(south));
    url.searchParams.set('maxlatitude', String(north));
    url.searchParams.set('minlongitude', String(west));
    url.searchParams.set('maxlongitude', String(east));
    // all_day is the layer cadence; a longer window would silently change what
    // the layer claims to show.
    url.searchParams.set('limit', '20000');
    return url.toString();
  }

  return {
    /** Exposed for tests and diagnostics; never called by the layer directly. */
    buildUrl: urlFor,
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const region = getScope?.()?.region ?? null;
      const response = await fetchImpl(urlFor(region), { signal });
      if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeEarthquakeSnapshot(payload);
      if (!rows) throw new Error('Malformed USGS response');
      return rows;
    },
  };
}

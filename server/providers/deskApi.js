/**
 * deskApi.js — the desk's API, as ONE handler module.
 *
 * The desk had its API in two places that were not the same place: the
 * built server (`server/desk/server.mjs`) had a route, and the dev server
 * (`apps/hail-desk/vite.config.js`) had NO plugins at all - so
 * `npm run dev:desk` served the app and its data files and 404'd on every
 * API call. The street list only worked against the built server, which meant
 * the street list could not be worked on in development.
 *
 * There is a `tigerStreetsPlugin()` in the tree that mounts the route in a
 * Vite dev server, and it is referenced NOWHERE. So the route existed twice
 * in spirit and once in fact, and the half that ran was the one that could
 * not be developed against.
 *
 * This module is that plugin, and the built server calls the SAME handlers.
 * One implementation, two hosts, and a route that cannot drift from the one
 * the dev server runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { streetsPayload } from './hailStreets.js';
import { streetTile } from './deskTiles.js';
import { countyTractIndex, tractListBody, tractTile } from './deskTracts.js';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const STORM_DIR = path.join(REPO, 'src/data/local_data/storm');

/**
 * The desk's API routes, as a map of path to handler.
 *
 * The handlers take the parsed URL and return a plain object, so the same one
 * serves a Vite middleware and a `node:http` reply.
 */
export const DESK_ROUTES = {
  '/api/desk/places': async (url) => {
    const { placesForState } = await import('./deskGeography.js');
    const places = placesForState(url.searchParams.get('state') || '');
    return { count: places.length, places };
  },
  '/api/desk/street-geometry': async (url) => {
    const { countyStreetGeometry } = await import('./tigerStreets.js');
    return countyStreetGeometry(
      url.searchParams.get('state') || '',
      url.searchParams.get('county') || '',
      url.searchParams.get('edge') || '',
    );
  },
  '/api/desk/state': async (url) => {
    const { stateOutline } = await import('./deskStates.js');
    const outline = stateOutline(url.searchParams.get('state') || '');
    if (!outline) {
      return { error: 'no outline for that state' };
    }
    return outline;
  },
  '/api/desk/address': async (url) => {
    const { addressPayload } = await import('./deskAddress.js');
    return addressPayload({
      q: url.searchParams.get('q') || '',
      place: url.searchParams.get('place') || '',
      state: url.searchParams.get('state') || '',
      county: url.searchParams.get('county') || '',
    });
  },
  '/api/desk/streets': async (url) => {
    const state = String(url.searchParams.get('state') || '').trim();
    const county = String(url.searchParams.get('county') || '').trim();
    if (!/^\d{2}$/.test(state) || !/^\d{3}$/.test(county)) {
      const error = new Error('state and county are required');
      error.status = 400;
      throw error;
    }
    return streetsPayload({
      state,
      county,
      zip: url.searchParams.get('zip') || '',
      day: url.searchParams.get('day') || '',
      tract: url.searchParams.get('tract') || '',
      thresholdMm: url.searchParams.get('thresholdMm') || '',
    });
  },
};

/**
 * The street tile route.
 *
 * `/api/desk/tiles/{z}/{x}/{y}` resolves its county from the tile centre;
 * `/api/desk/tiles/{state}/{county}/{z}/{x}/{y}` remains for older callers.
 * Both responses are BINARY, not JSON, because a tile is a tile. Geography
 * resolved by the server is returned in `X-Gev-Geoid` for the tract index.
 *
 * BOTH TILE ROUTES SEND `X-Gev-Cache`, which says where the answer came from:
 * `memory` when the county's index was already in memory, and `index` when
 * this request built it. The word `disk` is for a tile that was read back
 * from a disk cache, and the desk's tiles have no disk cache.
 */
const STREET_TILE_PATH =
  /^\/api\/desk\/tiles\/(\d{2})\/(\d{3})\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/;

/**
 * The census tract routes.
 *
 * `/api/desk/tracts/{z}/{x}/{y}` resolves the tile's county on the server;
 * `/api/desk/tracts/{state}/{county}/{z}/{x}/{y}` remains for older callers.
 * Both return a binary tile in the SAME format the street tiles use: a
 * feature is a closed ring, and its index is the tract's index in the county's
 * list.
 *
 * `/api/desk/tracts/{state}/{county}/index` - the county's tract LIST, in the
 * order the tiles index into. It is fetched ONCE per county and cached by the
 * client, because a tile carries an index into this list and not the list
 * itself: a GEOID is eleven digits and a name on top of it, and a county has
 * hundreds of tracts, and a tile at every zoom of every pan would pay for
 * all of it again and again. The list also carries the housing-unit count,
 * which is a property of the tract and not of the ring.
 *
 * The two paths cannot be confused: the tile's last three segments are
 * numbers and this one's are not.
 */
const TRACT_TILE_PATH =
  /^\/api\/desk\/tracts\/(\d{2})\/(\d{3})\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/;
// The same tiles, with the county left out: the county is the tile's own
// geography, and a client that has to name it cannot pan across a county
// line without the roads stopping.
const STREET_TILE_BY_GEO_PATH =
  /^\/api\/desk\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/;
const TRACT_TILE_BY_GEO_PATH =
  /^\/api\/desk\/tracts\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/;
const TRACT_INDEX_PATH = /^\/api\/desk\/tracts\/(\d{2})\/(\d{3})\/index$/;
const TRACT_GEOMETRY_PATH =
  /^\/api\/desk\/tracts\/(\d{2})\/(\d{3})\/(\d{11})\/geometry$/;

/**
 * How long a tile may be cached by the browser.
 *
 * A tile is cut from a county's data, and the data does not move under the
 * browser in a minute.
 */
const TILE_CACHE_CONTROL = 'public, max-age=3600';

/**
 * Run the desk's API for one request.
 *
 * @param {URL} url the parsed request URL
 * @returns {Promise<{status: number, body: object}|{status: number,
 *   bytes: Uint8Array, contentType: string, count: number, cache: string}|null>}
 *   null when the path is not one of the desk's
 */
export async function runDeskApi(url) {
  // The day's fine 1 km field, so the desk's map can draw the swath.
  //
  // It is a COMMITTED artifact and it is gzipped, and the browser cannot reach
  // it: the desk is a separate build and the storm payloads live in the
  // shared core's tree, not in the desk's public folder. So the server
  // streams it, the way it streams the street tiles.
  const storm = /^\/api\/desk\/storm\/(\d{4}-\d{2}-\d{2})\.bin\.gz$/.exec(
    url.pathname,
  );
  if (storm) {
    const file = path.join(
      STORM_DIR,
      `storm_radar_hail_fine_${storm[1]}.bin.gz`,
    );
    if (!fs.existsSync(file)) {
      return { status: 404, body: { error: `no field for ${storm[1]}` } };
    }
    return {
      status: 200,
      bytes: new Uint8Array(fs.readFileSync(file)),
      contentType: 'application/gzip',
      count: 1,
    };
  }

  // The day's SUB-DAILY field, so the desk can show a storm six hours at a
  // time instead of a day at a time.
  //
  // The desk already had these shards and never used them: they are built,
  // committed and served by the globe, and the desk's map drew a whole day at
  // a time as if a storm were one thing that happened over eighteen hours.
  // It was not. A storm is a thing that happened over an hour, and a map
  // that says "this is where the hail fell on Tuesday" is a claim about
  // eighteen hours of weather.
  const subDaily = /^\/api\/desk\/subdaily\/(\d{4}-\d{2}-\d{2})\.bin\.gz$/.exec(
    url.pathname,
  );
  if (subDaily) {
    const file = path.join(
      STORM_DIR,
      `storm_radar_hail_sub_${subDaily[1]}.bin.gz`,
    );
    if (!fs.existsSync(file)) {
      return {
        status: 404,
        body: { error: `no sub-daily field for ${subDaily[1]}` },
      };
    }
    return {
      status: 200,
      bytes: new Uint8Array(fs.readFileSync(file)),
      contentType: 'application/gzip',
      count: 1,
    };
  }

  const geoTileMatch = STREET_TILE_BY_GEO_PATH.exec(url.pathname);
  if (geoTileMatch) {
    const [, z, x, y] = geoTileMatch;
    const { countyForTile } = await import('./deskGeography.js');
    const county = countyForTile(Number(z), Number(x), Number(y));
    if (!county) {
      // A tile with no county under it - the ocean, or outside the Census's
      // geography. There are no streets there, and saying so with a 204
      // costs nothing.
      return {
        status: 204,
        bytes: Buffer.alloc(0),
        contentType: 'application/vnd.gev.street-tile',
        count: 0,
        cache: 'memory',
      };
    }
    try {
      const { bytes, count, cache } = await streetTile(
        county.geoid.slice(0, 2),
        county.geoid.slice(2, 5),
        Number(z),
        Number(x),
        Number(y),
      );
      return {
        status: count ? 200 : 204,
        bytes,
        contentType: 'application/vnd.gev.street-tile',
        count,
        cache,
        geoid: county.geoid,
      };
    } catch (error) {
      return {
        status: 404,
        body: { error: error?.message || 'the tile could not be built' },
      };
    }
  }

  const geoTractMatch = TRACT_TILE_BY_GEO_PATH.exec(url.pathname);
  if (geoTractMatch) {
    const [, z, x, y] = geoTractMatch;
    const { countyForTile } = await import('./deskGeography.js');
    const county = countyForTile(Number(z), Number(x), Number(y));
    if (!county) {
      return {
        status: 204,
        bytes: Buffer.alloc(0),
        contentType: 'application/vnd.gev.tract-tile',
        count: 0,
        cache: 'memory',
      };
    }
    try {
      const { bytes, count, cache } = await tractTile(
        county.geoid.slice(0, 2),
        county.geoid.slice(2, 5),
        Number(z),
        Number(x),
        Number(y),
      );
      return {
        status: count ? 200 : 204,
        bytes,
        contentType: 'application/vnd.gev.tract-tile',
        count,
        cache,
        geoid: county.geoid,
      };
    } catch (error) {
      return {
        status: 404,
        body: { error: error?.message || 'the tract tile could not be built' },
      };
    }
  }

  const tileMatch = STREET_TILE_PATH.exec(url.pathname);
  if (tileMatch) {
    // THE COUNTY IS THE TILE'S, not the client's. The client used to name a
    // county and the map could therefore only ever show ONE county's
    // streets: pan across a county line and the roads stopped, with nothing
    // to say why. The county is a fact about the tile, and the server has
    // the boundaries to work it out with.
    const [, state, county, z, x, y] = tileMatch;
    try {
      const { bytes, count, cache } = await streetTile(
        state,
        county,
        Number(z),
        Number(x),
        Number(y),
      );
      return {
        // 204 for an EMPTY tile, not for a tile with no streets in it. A
        // header-only tile is a perfectly good answer - the browser just
        // draws nothing - and 204 says "there is nothing here" without
        // spending the bytes.
        status: count ? 200 : 204,
        bytes,
        contentType: 'application/vnd.gev.street-tile',
        count,
        cache,
        geoid: `${state}${county}`,
      };
    } catch (error) {
      return {
        status: 404,
        body: { error: error?.message || 'the tile could not be built' },
      };
    }
  }

  const tractTileMatch = TRACT_TILE_PATH.exec(url.pathname);
  if (tractTileMatch) {
    const [, state, county, z, x, y] = tractTileMatch;
    try {
      const { bytes, count, cache } = await tractTile(
        state,
        county,
        Number(z),
        Number(x),
        Number(y),
      );
      return {
        // The same rule as the street tile: an empty tile is a 204 with no
        // body, and a header-only tile is a perfectly good answer.
        status: count ? 200 : 204,
        bytes,
        contentType: 'application/vnd.gev.tract-tile',
        count,
        cache,
        geoid: `${state}${county}`,
      };
    } catch (error) {
      return {
        status: 404,
        body: { error: error?.message || 'the tract tile could not be built' },
      };
    }
  }

  const tractIndexMatch = TRACT_INDEX_PATH.exec(url.pathname);
  if (tractIndexMatch) {
    const [, state, county] = tractIndexMatch;
    try {
      const index = await countyTractIndex(state, county);
      return {
        status: 200,
        body: tractListBody(state, county, index),
        cache: index.built ? 'index' : 'memory',
      };
    } catch (error) {
      return {
        status: 404,
        body: { error: error?.message || 'the tract list could not be built' },
      };
    }
  }

  const tractGeometryMatch = TRACT_GEOMETRY_PATH.exec(url.pathname);
  if (tractGeometryMatch) {
    const [, state, county, geoid] = tractGeometryMatch;
    try {
      const { tractGeometry } = await import('./deskTracts.js');
      return { status: 200, body: await tractGeometry(state, county, geoid) };
    } catch (error) {
      return {
        status: Number(error?.status) || 404,
        body: {
          error: error?.message || 'the tract outline could not be loaded',
        },
      };
    }
  }

  const handler = DESK_ROUTES[url.pathname];
  if (!handler) return null;
  try {
    const body = await handler(url);
    return { status: 200, body };
  } catch (error) {
    return {
      status: Number(error?.status) || 500,
      body: { error: error?.message || 'the request failed' },
    };
  }
}

/**
 * The Vite plugin that mounts the desk's API in the dev server.
 *
 * @returns {import('vite').Plugin}
 */
export function deskApiPlugin() {
  return {
    name: 'gev-desk-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/desk/')) return next();
        const result = await runDeskApi(new URL(req.url, 'http://localhost'));
        // An API path that matched nothing is a 404, in dev as in production.
        // The dev server's own fallback would answer with its index page, and
        // a client that asked for a tile and got a web page would draw
        // nothing and say nothing about why.
        if (!result) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'no such desk route' }));
          return;
        }
        // WHERE THE ANSWER CAME FROM: `memory` when the county's index was
        // already in memory, `index` when this request built it.
        if (result.cache) res.setHeader('x-gev-cache', result.cache);
        if (result.geoid) res.setHeader('x-gev-geoid', result.geoid);
        if (result.bytes) {
          res.setHeader('content-type', result.contentType);
          res.setHeader('x-gev-tile-count', String(result.count ?? 0));
          res.setHeader('cache-control', TILE_CACHE_CONTROL);
          res.statusCode = result.status;
          // A 204 CARRIES NO BODY. The tile's header bytes are not sent with
          // it: a 204 that answers with bytes is a 200 that lies about its
          // status, and some clients will read the body anyway.
          res.end(
            result.status === 204 ? undefined : Buffer.from(result.bytes),
          );
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.statusCode = result.status;
        res.end(JSON.stringify(result.body));
      });
    },
  };
}

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

import { streetsPayload } from './hailStreets.js';

/**
 * The desk's API routes, as a map of path to handler.
 *
 * The handlers take the parsed URL and return a plain object, so the same one
 * serves a Vite middleware and a `node:http` reply.
 */
export const DESK_ROUTES = {
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
 * Run the desk's API for one request.
 *
 * @param {URL} url the parsed request URL
 * @returns {Promise<{status: number, body: object}|null>} null when the path
 *   is not one of the desk's
 */
export async function runDeskApi(url) {
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
        if (!result) return next();
        res.setHeader('content-type', 'application/json');
        res.statusCode = result.status;
        res.end(JSON.stringify(result.body));
      });
    },
  };
}

#!/usr/bin/env node
/**
 * server/desk/server.mjs — serves the Hail Desk and its street list.
 *
 * The desk is a static app, but the street list is not: it comes from the
 * Census TIGER files, which are downloaded per county and cached on disk, and
 * a static host cannot do that. So the desk gets its own small server rather
 * than a second API to cross-origin against.
 *
 * Serving BOTH the files and the API from one origin also means the browser
 * never has to be told to allow a cross-origin request, which is the thing
 * that turns "open it on my phone" into "open it on my phone and it works".
 *
 * Usage:
 *   node server/desk/server.mjs [--port 5201] [--host 0.0.0.0]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

import { countyStreets } from '../providers/tigerStreets.js';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const ROOT = path.join(REPO, 'apps/hail-desk/dist');

const args = process.argv.slice(2);
const port = Number(
  args.includes('--port') ? args[args.indexOf('--port') + 1] : 5201,
);
const host = String(
  args.includes('--host') ? args[args.indexOf('--host') + 1] : '0.0.0.0',
);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gz': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (url.pathname === '/api/desk/streets') {
    const state = String(url.searchParams.get('state') || '').trim();
    const county = String(url.searchParams.get('county') || '').trim();
    const zip = String(url.searchParams.get('zip') || '').trim();
    if (!/^\d{2}$/.test(state) || !/^\d{3}$/.test(county)) {
      send(
        res,
        400,
        JSON.stringify({ error: 'state and county are required' }),
        TYPES['.json'],
      );
      return;
    }
    try {
      const streets = await countyStreets(state, county, zip);
      send(
        res,
        200,
        JSON.stringify({
          state,
          county,
          zip: zip || null,
          count: streets.length,
          // The addresses in the ranges, which is what these numbers are.
          // The number of HOUSES in a ZIP comes from the Census, and the two
          // are not the same and are never added together.
          addresses: streets.reduce(
            (total, street) => total + street.addresses,
            0,
          ),
          streets,
        }),
        TYPES['.json'],
      );
    } catch (error) {
      send(res, 500, JSON.stringify({ error: error.message }), TYPES['.json']);
    }
    return;
  }

  // A static file, with the SPA fallback the desk's own routing needs.
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(
    ROOT,
    path.normalize(requested).replace(/^(\.\.[/\\])+/, ''),
  );
  if (
    file.startsWith(ROOT) &&
    fs.existsSync(file) &&
    fs.statSync(file).isFile()
  ) {
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('content-type', type);
    fs.createReadStream(file).pipe(res);
    return;
  }
  const index = path.join(ROOT, 'index.html');
  if (fs.existsSync(index)) {
    res.statusCode = 200;
    res.setHeader('content-type', TYPES['.html']);
    fs.createReadStream(index).pipe(res);
    return;
  }
  send(res, 404, 'not found');
});

server.listen(port, host, () => {
  console.log(`[desk] serving apps/hail-desk/dist on http://${host}:${port}/`);
  if (!fs.existsSync(ROOT)) {
    console.log('[desk] no dist yet - run "npm run build:desk" first');
  }
});

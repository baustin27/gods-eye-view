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

import { runDeskApi } from '../providers/deskApi.js';

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

  // The desk's API, through the SAME handler the dev server uses. One
  // implementation, two hosts: a route that cannot drift from the one the
  // dev server runs.
  if (url.pathname.startsWith('/api/desk/')) {
    const result = await runDeskApi(url);
    if (result) {
      // WHERE THE ANSWER CAME FROM: `memory` when the county's index was
      // already in memory, `index` when this request built it.
      if (result.cache) res.setHeader('x-gev-cache', result.cache);
      if (result.bytes) {
        res.setHeader('content-type', result.contentType);
        res.setHeader('x-gev-tile-count', String(result.count ?? 0));
        res.setHeader('cache-control', 'public, max-age=3600');
        res.statusCode = result.status;
        // A 204 CARRIES NO BODY, so the empty tile's header bytes are not
        // sent with it.
        res.end(result.status === 204 ? undefined : Buffer.from(result.bytes));
        return;
      }
      send(res, result.status, JSON.stringify(result.body), TYPES['.json']);
      return;
    }
    // AN API PATH THAT MATCHED NOTHING IS A 404, and not the desk's index
    // page. The SPA fallback answers any unmatched path with a 200 and an
    // HTML shell, and a client that asked for a tile and got a web page
    // would decode it as an empty tile and draw nothing - a silent failure
    // that reads as "there are no streets here".
    send(
      res,
      404,
      JSON.stringify({ error: 'no such desk route' }),
      TYPES['.json'],
    );
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

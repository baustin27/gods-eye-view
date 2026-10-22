import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import { loadGzippedJson } from './data.js';

test('a server-managed gzip response is parsed after Fetch decodes it', async () => {
  const payload = { source: 'vite' };
  const fetchImpl = async () =>
    new Response(JSON.stringify(payload), {
      headers: { 'content-encoding': 'gzip' },
    });

  assert.deepEqual(
    await loadGzippedJson('/data/cities.json.gz', fetchImpl),
    payload,
  );
});

test('an opaque gzip artifact is inflated by the desk loader', async () => {
  const payload = { source: 'binary' };
  const bytes = gzipSync(Buffer.from(JSON.stringify(payload)));
  const fetchImpl = async () =>
    new Response(bytes, {
      headers: { 'content-type': 'application/octet-stream' },
    });

  assert.deepEqual(
    await loadGzippedJson('/data/cities.json.gz', fetchImpl),
    payload,
  );
});

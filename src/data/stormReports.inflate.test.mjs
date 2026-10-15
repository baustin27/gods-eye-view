import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createInflateHelper } from './stormReports.inflateHelper.js';

const gz = (s) => gzipSync(Buffer.from(s, 'utf8'));

test('inflates a payload that really is compressed', async () => {
  const inflate = await createInflateHelper();
  const body = { total: 155737, years: ['2026'] };
  const out = await inflate(gz(JSON.stringify(body)));
  assert.deepEqual(JSON.parse(out), body);
});

test('reads a payload the browser already inflated for us', async () => {
  // This is the dev-server case: Content-Encoding: gzip means fetch hands back
  // plain bytes, and running them through DecompressionStream threw.
  const inflate = await createInflateHelper();
  const out = await inflate(Buffer.from(JSON.stringify({ total: 7 }), 'utf8'));
  assert.deepEqual(JSON.parse(out), { total: 7 });
});

test('an empty payload is empty, not a crash', async () => {
  const inflate = await createInflateHelper();
  assert.equal(await inflate(new Uint8Array(0)), '');
});

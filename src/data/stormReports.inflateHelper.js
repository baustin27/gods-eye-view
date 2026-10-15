/**
 * The gzip sniff used by the storm snapshot loader, factored out so it can be
 * tested against real compressed bytes.
 *
 * The dev server serves `.gz` payloads with `Content-Encoding: gzip`, and
 * `fetch` honours that automatically — the bytes arrive already inflated, and
 * piping them through DecompressionStream fails. Another server may hand back
 * the same file as an opaque binary. Checking the gzip magic number covers both
 * without guessing which server is in front of us.
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Promise<string>} decoded text
 */
export async function inflateBytes(bytes) {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const looksGzipped =
    buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (!looksGzipped) return new TextDecoder().decode(buffer);
  const stream = new Blob([buffer])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export function createInflateHelper() {
  return Promise.resolve(inflateBytes);
}

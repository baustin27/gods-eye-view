import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { deskApiPlugin } from '../../server/providers/deskApi.js';

/**
 * The Hail Desk's own build.
 *
 * A SEPARATE config from the globe's, and that is the point: the desk is a
 * second front end, not a mode of the first. It builds to its own directory,
 * it has no Cesium in it, and it can be deployed to a plain static host on
 * its own - with the globe, or without it.
 *
 * The one thing it shares with the globe is the DATA CORE, and it imports it
 * by relative path rather than by package name. That is deliberate: the repo
 * is not a workspace, and the core's own boundary check
 * (`scripts/check-import-directions.mjs`) is what guarantees the modules this
 * app imports are free of Cesium, the DOM and Node. Importing them by path
 * means that check is still the thing standing between the desk and a
 * dependency it cannot have.
 *
 * `server.fs.allow` is what lets the dev server serve the core, which lives
 * outside this app's root. The BUILD is unaffected: the bundler follows the
 * relative import wherever it goes.
 */

const root = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root,
  plugins: [
    // The desk's API, in the dev server. It used to have NONE, so every API
    // call 404'd in development and the street list could only be worked on
    // against the built server. The handler is the SAME one the built server
    // calls, so the two cannot drift.
    deskApiPlugin(),
  ],
  base: './',
  server: {
    port: 5200,
    strictPort: false,
    fs: { allow: [repoRoot] },
  },
  preview: {
    port: 5201,
    strictPort: false,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    // The artifact is 749 KB and is served as an opaque binary, not inlined.
    assetsInlineLimit: 4096,
  },
});

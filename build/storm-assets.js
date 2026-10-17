/**
 * Ship the storm `.gz` payloads in a production build.
 *
 * The loaders resolve their base by string surgery on `import.meta.url`
 * (`src/data/stormReports.js:40`), so a built chunk asks for
 * `<origin>/assets/local_data/storm/<file>.gz`. `vite build` copies nothing
 * there: the five plain `.geojsonl` are emitted hashed by the bundler and the
 * small sidecars are inlined as data URIs, but nothing emits the gzipped
 * payloads. Measured before this existed: `find dist -name '*.gz'` returned 0.
 *
 * That failure is silent and looks like missing data rather than a build bug.
 * A static host answers the request with the SPA shell and a **200** through its
 * fallback, which is exactly why the loader keys "absent" on the payload's
 * SHAPE rather than on the status code. Under the Pinokio launcher nobody sees
 * it, because that runs Vite's DEV server, which serves
 * `src/data/local_data/storm/*` straight from source.
 *
 * Two rules this file exists to enforce:
 *
 *   1. The destination is DERIVED from the resolved config — `base`,
 *      `build.outDir`, `build.assetsDir` — and never hardcoded. The panel build
 *      shares this plugin through `panelBuildConfig` with a different `base`
 *      (`/panel/`) and a different `outDir` (`dist/panel`), and hardcoding a path
 *      is how a fix ships for the app and silently misses the panel.
 *   2. Only the `.gz` payloads are copied. Copying the `.geojsonl` too would
 *      duplicate ~27 MB for files the bundler already emitted.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repo root, from `build/`. */
export const REPO_ROOT = path.resolve(HERE, '..');
/** Where the payloads live in source, and where the loader looks for them. */
export const STORM_SOURCE_DIR = path.join(
  REPO_ROOT,
  'src/data/local_data/storm',
);
/** The path segment inside the built assets directory. */
export const STORM_ASSET_SUBDIR = path.join('local_data', 'storm');

/**
 * The payload files to copy: every `.gz`, and nothing else.
 *
 * Exported and pure so the selection is testable without running a build.
 *
 * @param {string[]} names filenames in the source storm directory
 * @returns {string[]} the `.gz` ones, sorted for a deterministic copy order
 */
export function selectStormPayloads(names) {
  return (names || []).filter((name) => name.endsWith('.gz')).sort();
}

/**
 * Where a resolved Vite config's storm payloads belong.
 *
 * @param {object} config A RESOLVED Vite config (`outDir`, `assetsDir`, `base`).
 * @returns {string} an absolute destination directory
 */
export function stormAssetDestination(config) {
  const outDir = config?.build?.outDir || 'dist';
  const assetsDir = config?.build?.assetsDir || 'assets';
  return path.resolve(
    REPO_ROOT,
    outDir,
    assetsDir,
    STORM_ASSET_SUBDIR,
  );
}

/**
 * Copy the gzipped storm payloads into a finished bundle.
 *
 * `closeBundle` rather than `writeBundle`: by then every chunk is written and
 * nothing will rewrite the directory out from under the copy. Errors are thrown
 * rather than warned, because a build that silently ships without the data is
 * the exact failure this plugin exists to stop — and a hard failure here is a
 * loud one at build time instead of a mystery at runtime.
 *
 * @param {{root?: string, copies?: string[]}} [options] Test seam.
 * @returns {() => Promise<{copied: string[], destination: string, bytes: number}>}
 */
export function copyStormAssets(options = {}) {
  const { root = REPO_ROOT } = options;
  const sourceDir = options.sourceDir || STORM_SOURCE_DIR;
  let copied = null;
  return async function closeBundle(config) {
    if (copied) return copied;
    const destination = stormAssetDestination(config);
    const names = selectStormPayloads(await fs.readdir(sourceDir));
    await fs.mkdir(destination, { recursive: true });
    let bytes = 0;
    for (const name of names) {
      const from = path.join(sourceDir, name);
      const to = path.join(destination, name);
      const contents = await fs.readFile(from);
      await fs.writeFile(to, contents);
      bytes += contents.length;
    }
    copied = { copied: names, destination, bytes, root };
    return copied;
  };
}

/** The plugin as Vite wants it. */
export function stormAssetsPlugin(options = {}) {
  return {
    name: 'gev-storm-assets',
    // Only meaningful for a production bundle; the dev server already serves
    // these from source.
    apply: 'build',
    closeBundle: copyStormAssets(options),
  };
}
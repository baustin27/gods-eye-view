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
 * Three rules this file exists to enforce:
 *
 *   1. The destination is DERIVED from the resolved config — `build.outDir` and
 *      `build.assetsDir` — and never hardcoded. Vite always emits assets at
 *      `<outDir>/<assetsDir>`, so `base` is NOT part of that path and is not
 *      read here; an earlier version of this header claimed otherwise and the
 *      test that "proved" it passed an inert `base` argument. The two builds
 *      that matter differ by `outDir`, and that is what the test asserts.
 *   2. Only the payloads the app actually fetches are copied, matched by an
 *      explicit pattern rather than "every `.gz` in the directory". The fine
 *      1 km per-day family is ~1,000 files, and a blanket extension rule would
 *      copy anything that ever landed here.
 *   3. Writes are atomic (`.tmp` + `rename`) and bounded in concurrency. An
 *      interrupted `closeBundle` must not leave a half-copied payload set that
 *      looks complete to the next request.
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
 * Payload families the app fetches at runtime.
 *
 * Explicit, because the source directory also holds `.geojsonl` files the
 * bundler already emits hashed, and because a per-day family of ~1,000 files
 * must be selectable without dragging in anything else that ends in `.gz`.
 */
export const STORM_PAYLOAD_PATTERNS = Object.freeze([
  /^storm_reports_\d{4}\.json\.gz$/,
  /^storm_events_\d{4}\.json\.gz$/,
  /^storm_radar_hail_\d{4}\.geojsonl\.gz$/,
  /^storm_radar_hail_perday_\d{4}\.bin\.gz$/,
  /^storm_radar_hail_fine_\d{4}-\d{2}-\d{2}\.bin\.gz$/,
  /^storm_radar_hail_sub_\d{4}-\d{2}-\d{2}\.bin\.gz$/,
  /^storm_report_index\.json\.gz$/,
]);

/** How many copies may be in flight at once. */
const COPY_CONCURRENCY = 16;

/**
 * The payload files to copy, matched against the runtime-fetch families.
 *
 * Exported and pure so the selection is testable without running a build.
 *
 * @param {string[]} names filenames in the source storm directory
 * @param {RegExp[]} [patterns] defaults to {@link STORM_PAYLOAD_PATTERNS}
 * @returns {string[]} matched names, sorted for a deterministic copy order
 */
export function selectStormPayloads(names, patterns = STORM_PAYLOAD_PATTERNS) {
  const rules = patterns?.length ? patterns : STORM_PAYLOAD_PATTERNS;
  return (names || []).filter((name) => rules.some((rule) => rule.test(name))).sort();
}

/**
 * Where a resolved Vite config's storm payloads belong.
 *
 * @param {object} config A RESOLVED Vite config (`outDir`, `assetsDir`).
 * @param {{root?: string}} [options] `root` overrides the repo root. This is a
 *   real seam, not decoration: the copy test uses it to land in a temp dir
 *   instead of polluting the developer's own `dist`.
 * @returns {string} an absolute destination directory
 */
export function stormAssetDestination(config, { root = REPO_ROOT } = {}) {
  const outDir = config?.build?.outDir || 'dist';
  const assetsDir = config?.build?.assetsDir || 'assets';
  return path.resolve(root, outDir, assetsDir, STORM_ASSET_SUBDIR);
}

/**
 * Copy the payloads into a finished bundle.
 *
 * `closeBundle` rather than `writeBundle`: by then every chunk is written and
 * nothing will rewrite the directory out from under the copy. Errors are thrown
 * rather than warned, because a build that silently ships without the data is
 * the exact failure this plugin exists to stop — and a hard failure here is a
 * loud one at build time instead of a mystery at runtime.
 *
 * @param {{root?: string, sourceDir?: string, patterns?: RegExp[]}} [options]
 * @returns {(config: object) => Promise<{copied: string[], destination: string, bytes: number}>}
 */
export function copyStormAssets(options = {}) {
  const { root = REPO_ROOT, patterns } = options;
  const sourceDir = options.sourceDir || STORM_SOURCE_DIR;
  let copied = null;
  return async function closeBundle(config) {
    if (copied) return copied;
    const destination = stormAssetDestination(config, { root });
    const names = selectStormPayloads(await fs.readdir(sourceDir), patterns);
    await fs.mkdir(destination, { recursive: true });
    let bytes = 0;
    let index = 0;
    const worker = async () => {
      while (index < names.length) {
        const name = names[index++];
        const from = path.join(sourceDir, name);
        const to = path.join(destination, name);
        const contents = await fs.readFile(from);
        // Atomic: a rename is what makes this all-or-nothing per file. A
        // half-written payload that decodes to plausible garbage is worse than
        // a missing one, because the loaders cannot tell the difference.
        const temp = `${to}.tmp`;
        await fs.writeFile(temp, contents);
        await fs.rename(temp, to);
        bytes += contents.length;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(COPY_CONCURRENCY, names.length || 1) }, worker),
    );
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
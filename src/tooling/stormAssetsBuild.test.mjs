import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBrowserViteConfig } from '../../build/vite.js';
import { panelBuildConfig, STORM_ASSETS_PLUGIN } from '../../build/panel.js';
import {
  REPO_ROOT,
  STORM_ASSET_SUBDIR,
  STORM_SOURCE_DIR,
  copyStormAssets,
  selectStormPayloads,
  stormAssetDestination,
  stormAssetsPlugin,
} from '../../build/storm-assets.js';

test('the plugin is registered on the browser config', () => {
  const config = createBrowserViteConfig();
  const names = config.plugins.map((plugin) => plugin?.name);
  assert.ok(
    names.includes('gev-storm-assets'),
    `storm assets plugin is registered; got ${JSON.stringify(names)}`,
  );
});

// The panel build must NOT inherit it. Inheriting is how every storm payload
// gets duplicated into dist/panel as well: harmless at 14.7 MB, a second full
// copy of a payload the panel cannot enumerate once the fine 1 km per-day
// family lands. The loaders degrade to an empty map when a payload is missing,
// so dropping it is safe.
test('the panel build does not copy the storm payloads', () => {
  const panel = panelBuildConfig(createBrowserViteConfig());
  const names = panel.plugins.map((plugin) => plugin?.name);
  assert.ok(
    !names.includes(STORM_ASSETS_PLUGIN),
    `the panel build drops ${STORM_ASSETS_PLUGIN}; got ${JSON.stringify(names)}`,
  );
  // And it must still be the app build, not a stripped one.
  assert.ok(
    names.includes('embed-framing') && names.includes('panel-build'),
    'the rest of the plugin list survives',
  );
});

test('only the gzipped payloads are selected', () => {
  const selected = selectStormPayloads([
    'storm_radar_hail.geojsonl',
    'storm_radar_hail_2026.geojsonl.gz',
    'storm_radar_hail_perday_2026.bin.gz',
    'storm_radar_hail_2026.json',
    'notes.txt',
  ]);
  assert.deepEqual(selected, [
    'storm_radar_hail_2026.geojsonl.gz',
    'storm_radar_hail_perday_2026.bin.gz',
  ]);
  // The plain .geojsonl are already emitted hashed by the bundler; copying them
  // again would duplicate ~27 MB for nothing. The assertion below is about the
  // NON-gzipped ones — an earlier version tested `endsWith('.geojsonl')`, which
  // `'x.geojsonl.gz'.endsWith('.geojsonl')` is false for, so it passed without
  // proving anything.
  assert.ok(
    !selected.includes('storm_radar_hail.geojsonl'),
    'the bundler-emitted plain geojsonl is left alone',
  );
  assert.deepEqual(selectStormPayloads([]), [], 'an empty dir is not an error');
  assert.deepEqual(selectStormPayloads(undefined), []);
});

test('the destination derives from the config, never from a constant', () => {
  const main = stormAssetDestination({
    base: '/',
    build: { outDir: 'dist', assetsDir: 'assets' },
  });
  assert.equal(main, path.join(REPO_ROOT, 'dist/assets', STORM_ASSET_SUBDIR));

  // The panel's own shape: a different outDir. `base` is deliberately NOT
  // passed, because Vite emits assets at `<outDir>/<assetsDir>` and the plugin
  // does not read it. An earlier version of this test passed `base` as though
  // it mattered and passed anyway, which is how the header comment came to
  // claim the destination was derived from it.
  const panel = stormAssetDestination({
    build: { outDir: 'dist/panel', assetsDir: 'assets' },
  });
  assert.equal(
    panel,
    path.join(REPO_ROOT, 'dist/panel/assets', STORM_ASSET_SUBDIR),
  );
  assert.notEqual(main, panel, 'the two builds never share a destination');
});

test('defaults survive a config that says nothing', () => {
  assert.equal(
    stormAssetDestination({}),
    path.join(REPO_ROOT, 'dist/assets', STORM_ASSET_SUBDIR),
    'outDir and assetsDir both default',
  );
});

test('root redirects the destination, so a test cannot pollute the real dist', () => {
  // This is a real seam, not decoration: the copy test below passes a temp
  // source, and before `root` existed its output landed in the developer's own
  // dist/assets/local_data/storm/. `find dist -name '*.gz'` counted 27 files
  // instead of 25 because of it.
  assert.equal(
    stormAssetDestination({}, { root: '/tmp/some-root' }),
    path.join('/tmp/some-root', 'dist/assets', STORM_ASSET_SUBDIR),
  );
});

test('the plugin only applies to a build, and names itself', () => {
  const plugin = stormAssetsPlugin();
  assert.equal(plugin.name, 'gev-storm-assets');
  assert.equal(plugin.apply, 'build', 'the dev server already serves these');
  assert.equal(typeof plugin.closeBundle, 'function');
});

test('closeBundle copies the payloads, byte for byte', async () => {
  // A fixture source dir with two payloads and two decoys, so the test proves
  // the SELECTION as well as the copy. Names match the real families, because
  // the selection is pattern-based now rather than "everything ending .gz".
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-storm-assets-'));
  const source = path.join(root, 'storm');
  await fs.mkdir(source, { recursive: true });
  const payload = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0xff, 0x42, 0x43]);
  await fs.writeFile(path.join(source, 'storm_report_index.json.gz'), payload);
  await fs.writeFile(
    path.join(source, 'storm_radar_hail_fine_2026-06-01.bin.gz'),
    Buffer.from('second'),
  );
  await fs.writeFile(path.join(source, 'ignored.geojsonl'), Buffer.from('nope'));
  await fs.writeFile(path.join(source, 'notes.txt.gz'), Buffer.from('decoy'));

  // `root` points the destination at the temp tree. Without it this test wrote
  // into the real dist.
  const close = copyStormAssets({ root, sourceDir: source });
  const result = await close({
    build: { outDir: 'dist', assetsDir: 'assets' },
  });
  assert.deepEqual(
    result.copied,
    ['storm_radar_hail_fine_2026-06-01.bin.gz', 'storm_report_index.json.gz'],
    'the runtime payload families only',
  );
  assert.equal(
    result.destination,
    path.join(root, 'dist/assets', STORM_ASSET_SUBDIR),
    'and it landed under the temp root, never the real dist',
  );
  assert.equal(
    result.bytes,
    payload.length + 'second'.length,
    'the byte total is reported, so a payload budget can be asserted on it',
  );

  const written = await fs.readFile(
    path.join(result.destination, 'storm_report_index.json.gz'),
  );
  assert.deepEqual(
    [...written],
    [...payload],
    'the gzip magic survives the copy — a text-mode round trip would break it',
  );
  for (const decoyName of ['ignored.geojsonl', 'notes.txt.gz']) {
    const present = await fs
      .stat(path.join(result.destination, decoyName))
      .then(() => true)
      .catch(() => false);
    assert.equal(present, false, `${decoyName} was not copied`);
  }
  // No .tmp left behind: an interrupted copy must not look like a partial one.
  const leftovers = (await fs.readdir(result.destination)).filter((f) =>
    f.endsWith('.tmp'),
  );
  assert.deepEqual(leftovers, [], 'no half-written temporary files remain');

  await fs.rm(root, { recursive: true, force: true });
});

test('the real source directory holds gzipped payloads to copy', async () => {
  const names = await fs.readdir(STORM_SOURCE_DIR);
  assert.ok(
    selectStormPayloads(names).length > 0,
    'the per-day artifact the loader fetches is present in source',
  );
  assert.ok(
    names.some((name) => name.includes('storm_radar_hail_perday')),
    'and specifically the per-day field',
  );
});

// `selectStormPayloads` is exercised against the real directory above, so the
// path is imported lazily to keep this file's import list honest about what it
// asserts on.
function STORM_SOURCE_DIR_FOR_TEST() {
  return path.join(REPO_ROOT, 'src/data/local_data/storm');
}
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBrowserViteConfig } from '../../build/vite.js';
import { panelBuildConfig } from '../../build/panel.js';
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

// The panel build must inherit it. A plugin registered anywhere other than the
// shared config is a fix that ships for the app and silently misses the panel,
// which is the failure this file is written against.
test('the panel build inherits the plugin', () => {
  const panel = panelBuildConfig(createBrowserViteConfig());
  const names = panel.plugins.map((plugin) => plugin?.name);
  assert.ok(
    names.includes('gev-storm-assets'),
    'the panel build keeps the plugin',
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
  // again would duplicate ~27 MB for nothing.
  assert.ok(
    !selected.some((name) => name.endsWith('.geojsonl')),
    'the bundler-emitted geojsonl is left alone',
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

  // The panel's own shape: a different base AND a different outDir. A hardcoded
  // path passes the first assertion and fails this one.
  const panel = stormAssetDestination({
    base: '/panel/',
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

test('the plugin only applies to a build, and names itself', () => {
  const plugin = stormAssetsPlugin();
  assert.equal(plugin.name, 'gev-storm-assets');
  assert.equal(plugin.apply, 'build', 'the dev server already serves these');
  assert.equal(typeof plugin.closeBundle, 'function');
});

test('closeBundle copies the payloads, byte for byte', async () => {
  // A fixture source dir with a gz and a decoy, so the test proves the
  // SELECTION as well as the copy.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-storm-assets-'));
  const source = path.join(root, 'storm');
  await fs.mkdir(source, { recursive: true });
  const payload = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0xff, 0x42, 0x43]);
  await fs.writeFile(path.join(source, 'a.bin.gz'), payload);
  await fs.writeFile(path.join(source, 'b.bin.gz'), Buffer.from('second'));
  await fs.writeFile(path.join(source, 'ignored.geojsonl'), Buffer.from('nope'));

  const close = copyStormAssets({ sourceDir: source });
  const result = await close({
    build: { outDir: 'dist', assetsDir: 'assets' },
  });
  assert.deepEqual(result.copied, ['a.bin.gz', 'b.bin.gz'], 'gz only');

  const written = await fs.readFile(
    path.join(result.destination, 'a.bin.gz'),
  );
  assert.deepEqual(
    [...written],
    [...payload],
    'the gzip magic survives the copy — a text-mode round trip would break it',
  );
  const decoy = await fs
    .stat(path.join(result.destination, 'ignored.geojsonl'))
    .then(() => true)
    .catch(() => false);
  assert.equal(decoy, false, 'the decoy was not copied');

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
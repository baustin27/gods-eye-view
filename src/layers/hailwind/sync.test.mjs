import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStormLayer } from './index.js';
import { createStormSource } from './source.js';
import { loadStormDataset } from '../../data/stormDatasets.js';

/**
 * End-to-end exercise of the layer through its real load path.
 *
 * A Cesium viewer needs a GPU, so the scene is stubbed at the two seams the layer
 * actually uses: `Cesium.Entity` / `Cesium.Color` construction is bypassed by
 * recording what the layer asks for, and the overlay host is recorded. Everything
 * between — snapshot fetch, validation, scoring, entity assembly, cohort
 * selection, the analyst seam, and the year scrub — is the real implementation.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const stormDir = path.join(here, '..', '..', 'data', 'local_data', 'storm');
const hasSnapshot = fs.existsSync(path.join(stormDir, 'storm-sources.json'));

/** Map the bundled asset URL back to the file on disk. */
function fileFetch(url) {
  const name = path.basename(String(url));
  const file = path.join(stormDir, name);
  if (!fs.existsSync(file)) throw new Error(`no snapshot asset for ${name}`);
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(fs.readFileSync(file, 'utf8')),
  });
}

function stubViewer() {
  const added = [];
  const removed = [];
  return {
    added,
    removed,
    dataSources: {
      add(source) {
        added.push(source);
      },
      remove(source, destroy) {
        removed.push(source);
      },
    },
  };
}

function recordingOverlayHost() {
  const entries = new Map();
  const cleared = [];
  return {
    entries,
    cleared,
    clearSource(id) {
      cleared.push(id);
      entries.delete(id);
    },
    setEntries(id, list) {
      entries.set(id, list);
    },
    setVisible() {},
    last(id) {
      return entries.get(id) || [];
    },
  };
}

const maybe = hasSnapshot ? test : test.skip;

maybe(
  'the layer loads its snapshot, renders entities, and exposes controls',
  async (t) => {
    // The default source is what production uses; swap only the transport so the
    // snapshot comes from disk instead of the dev server.
    const source = createStormSource({
      load: () => loadStormDataset({ fetchImpl: fileFetch }),
    });
    const overlayHost = recordingOverlayHost();
    const storm = createStormLayer({ source, overlayHost });
    const viewer = stubViewer();
    storm.init(viewer);
    storm.enable(viewer);

    const changed = await storm.update();
    assert.equal(changed, true, 'the first update should populate the scene');

    const source_ = viewer.added[0];
    assert.ok(source_, 'a CustomDataSource should have been added');
    assert.ok(
      source_.entities.values.length > 100,
      'expected many grid entities',
    );

    const stats = storm.getStats();
    assert.equal(stats.loaded, true);
    assert.equal(stats.loading, false);
    assert.equal(stats.error, null);
    assert.ok(
      stats.cellsScored > 1000,
      `expected a populated grid, got ${stats.cellsScored}`,
    );
    assert.equal(stats.counties, 3234);
    assert.ok(
      stats.joinCoverage > 85,
      `county join coverage too low: ${stats.joinCoverage}%`,
    );
    assert.ok(stats.snapshotBuiltAt, 'the build stamp should reach the UI');

    // The ambient card cohort must stay small even though thousands of cells
    // scored, or the overlay lane becomes a wall of text.
    const cards = overlayHost.last('storm-observed');
    assert.ok(cards.length > 0, 'expected overlay cards');
    assert.ok(cards.length <= 24, `overlay cohort too large: ${cards.length}`);
    assert.ok(
      cards.every((c) => typeof c.title === 'string' && c.title.length > 0),
    );
    // The cohort now mixes cell cards with event drill-down cards, so the
    // score-bearing assertion applies to the cell subset specifically.
    const cellCards = cards.filter((c) => c.id.startsWith('storm-cell:'));
    assert.ok(cellCards.length > 0, 'cell cards must be published');
    assert.ok(
      cellCards.some((c) => c.title.startsWith('Risk ')),
      'cards must state a score rather than just a count',
    );

    t.after(() => storm.destroy(viewer));
  },
);

maybe(
  'the year scrub narrows the record and re-scores without refetching',
  async () => {
    const source = createStormSource({
      load: () => loadStormDataset({ fetchImpl: fileFetch }),
    });
    const storm = createStormLayer({
      source,
      overlayHost: recordingOverlayHost(),
    });
    const viewer = stubViewer();
    storm.init(viewer);
    storm.enable(viewer);
    await storm.update();

    const full = storm.getScoredCells(5);
    assert.equal(storm.getYearWindow().fromYear, 1955);

    assert.equal(storm.setYearWindow(2015, 2025), true);
    assert.equal(storm.getYearWindow().fromYear, 2015);
    assert.equal(storm.getYearWindow().toYear, 2025);

    const modern = storm.getScoredCells(5);
    const fullReports = full.reduce((s, r) => s + r.hailCount, 0);
    const modernReports = modern.reduce((s, r) => s + r.hailCount, 0);
    // The top cells over a decade cannot exceed the whole-record count.
    assert.ok(
      modernReports <= fullReports,
      'narrowing the window must not add reports',
    );
    assert.equal(storm.getStats().fromYear, 2015);

    // Out-of-range and garbage inputs clamp rather than throw.
    assert.equal(storm.setYearWindow(1800, 9999), true);
    assert.ok(storm.getYearWindow().fromYear >= 1950);
    assert.equal(storm.setYearWindow(Number.NaN, 2020), false);
  },
);

maybe('hazard toggles and event visibility drive the scene', async () => {
  const source = createStormSource({
    load: () => loadStormDataset({ fetchImpl: fileFetch }),
  });
  const storm = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
  });
  const viewer = stubViewer();
  storm.init(viewer);
  storm.enable(viewer);
  await storm.update();

  const cellsBefore = storm.getScoredCells(1)[0];
  assert.ok(cellsBefore.windCount > 0, 'wind reports should count by default');

  storm.setWindEnabled(false);
  const hailOnly = storm.getScoredCells(1)[0];
  assert.equal(
    hailOnly.windCount,
    0,
    'excluding wind must zero the reported wind count',
  );
  assert.ok(hailOnly.hailCount > 0);

  storm.setHailEnabled(false);
  const windOnly = storm.getScoredCells(1)[0];
  assert.equal(windOnly.hailCount, 0);

  // Significant events are entity children of the same data source, so toggling
  // them must shrink the entity set rather than just the overlay. Both hazards
  // must be back on first: with hail and wind both excluded, every event is
  // already filtered out and there is nothing left for the toggle to hide.
  storm.setHailEnabled(true);
  storm.setWindEnabled(true);
  const viewerEntities = () => viewer.added[0].entities.values.length;
  const withEvents = viewerEntities();
  storm.setEventsVisible(false);
  const withoutEvents = viewerEntities();
  assert.ok(
    withoutEvents < withEvents,
    `hiding events must reduce the scene (${withEvents} -> ${withoutEvents})`,
  );
  assert.equal(storm.getStats().showEvents, false);
});

maybe('county search and lookup answer "track this area"', async () => {
  const source = createStormSource({
    load: () => loadStormDataset({ fetchImpl: fileFetch }),
  });
  const storm = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
  });
  const viewer = stubViewer();
  storm.init(viewer);
  storm.enable(viewer);
  await storm.update();

  const found = storm.findCounties('Travis', 5);
  assert.ok(found.length >= 1, 'Travis County must be findable');
  assert.match(found[0].name, /Travis/);
  assert.ok(
    found[0].nriHailRate !== undefined,
    'a result must carry its FEMA rate',
  );

  const ranked = storm.getRankedCounties(10);
  assert.equal(ranked.length, 10);
  assert.ok(ranked[0].score >= ranked[9].score, 'ranking must be descending');
  assert.ok(
    ranked.some((c) => ['TX', 'OK', 'KS', 'NE', 'SD', 'MN'].includes(c.st)),
  );

  // Point lookup backs "where am I looking at?".
  const nearby = storm.getCountiesNearPoint(30.27, -97.74, 3);
  assert.ok(nearby.length > 0);
  assert.match(
    nearby[0].name,
    /Travis/,
    'a point in Austin should resolve to Travis County',
  );
  assert.equal(storm.getCountiesNearPoint(Number.NaN, 0, 3).length, 0);
  assert.equal(storm.getCounty('99999'), null);
  assert.ok(storm.getCounty('48201'));
});

maybe('the analyst seam returns bounded, JSON-safe records', async () => {
  const source = createStormSource({
    load: () => loadStormDataset({ fetchImpl: fileFetch }),
  });
  const storm = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
  });
  const viewer = stubViewer();
  storm.init(viewer);
  storm.enable(viewer);
  await storm.update();

  const records = storm.getAnalystRecords(500);
  assert.ok(records.length > 0 && records.length <= 500);
  // Must survive a JSON round trip: the voice layer serializes these.
  const roundTripped = JSON.parse(JSON.stringify(records));
  assert.equal(roundTripped.length, records.length);
  assert.ok(records.every((r) => r.id && typeof r.id === 'string'));
  assert.ok(records.some((r) => r.hazard === 'hail' || r.hazard === undefined));
  // No NaN may leak: JSON turns it into null and a spoken number becomes "null".
  for (const record of records) {
    for (const value of Object.values(record)) {
      assert.ok(
        typeof value !== 'number' || Number.isFinite(value),
        `non-finite number in analyst record: ${JSON.stringify(record)}`,
      );
    }
  }
});

maybe('disable clears the overlay and destroy releases the scene', async () => {
  const source = createStormSource({
    load: () => loadStormDataset({ fetchImpl: fileFetch }),
  });
  const overlayHost = recordingOverlayHost();
  const storm = createStormLayer({ source, overlayHost });
  const viewer = stubViewer();
  storm.init(viewer);
  storm.enable(viewer);
  await storm.update();
  assert.ok(overlayHost.last('storm-observed').length > 0);

  storm.disable(viewer);
  assert.equal(
    overlayHost.last('storm-observed').length,
    0,
    'disable must clear cards',
  );
  assert.ok(overlayHost.cleared.includes('storm-observed'));

  storm.destroy(viewer);
  assert.equal(viewer.removed.length, 1, 'destroy must remove the data source');
  assert.equal(storm.getStats().loaded, false);
});
// --- decade window chips (stage 2d) -----------------------------------------

// The two storm layers share one option owner, so a link means the same window
// on both — but only on restore. Without live sync, changing the decade on one
// layer leaves the other showing a different window, which is worse than the
// single layer it replaced.

test('a change on the observed layer reaches the expected layer live', async (t) => {
  const { createStormLayer } = await import('./index.js');
  const { resetStormOptions } = await import('./sharedOptions.js');
  resetStormOptions();
  t.after(() => resetStormOptions());

  const viewer = stubViewer();
  const source = createStormSource({
    load: () => loadStormDataset({ fetchImpl: fileFetch }),
  });
  const observed = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
  });
  const expected = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
    facet: 'expected',
  });
  for (const l of [observed, expected]) {
    l.init(viewer);
    l.enable(viewer);
  }
  t.after(() => {
    observed.destroy(viewer);
    expected.destroy(viewer);
  });

  assert.equal(observed.getParams().fromYear, expected.getParams().fromYear);
  observed.setParams({ fromYear: 2010 });
  assert.equal(
    expected.getParams().fromYear,
    2010,
    'the sibling must see the new window without a reload',
  );
  observed.setParams({ includeWind: false });
  assert.equal(expected.getParams().includeWind, false);
});

test('the sync is symmetric, and does not loop', async (t) => {
  const { createStormLayer } = await import('./index.js');
  const { resetStormOptions } = await import('./sharedOptions.js');
  resetStormOptions();
  t.after(() => resetStormOptions());

  const viewer = stubViewer();
  const source = createStormSource({
    load: () => loadStormDataset({ fetchImpl: fileFetch }),
  });
  const observed = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
  });
  const expected = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
    facet: 'expected',
  });
  for (const l of [observed, expected]) {
    l.init(viewer);
    l.enable(viewer);
  }
  t.after(() => {
    observed.destroy(viewer);
    expected.destroy(viewer);
  });

  expected.setParams({ fromYear: 1990 });
  assert.equal(
    observed.getParams().fromYear,
    1990,
    'a change on either layer propagates',
  );

  // A no-op publish must not bounce: applying the same value twice is stable.
  expected.setParams({ fromYear: 1990 });
  assert.equal(observed.getParams().fromYear, 1990);
});

test('a destroyed layer stops following its sibling', async (t) => {
  const { createStormLayer } = await import('./index.js');
  const { resetStormOptions } = await import('./sharedOptions.js');
  resetStormOptions();
  t.after(() => resetStormOptions());

  const viewer = stubViewer();
  const source = createStormSource({
    load: () => loadStormDataset({ fetchImpl: fileFetch }),
  });
  const observed = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
  });
  const expected = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
    facet: 'expected',
  });
  for (const l of [observed, expected]) {
    l.init(viewer);
    l.enable(viewer);
  }

  observed.setParams({ fromYear: 2010 });
  expected.destroy(viewer);
  t.after(() => observed.destroy(viewer));

  observed.setParams({ fromYear: 2000 });
  assert.equal(
    expected.getParams().fromYear,
    2010,
    "a destroyed layer must not be updated behind the caller's back",
  );
});

test("a layer that starts second adopts the first one's state", async (t) => {
  const { createStormLayer } = await import('./index.js');
  const { resetStormOptions } = await import('./sharedOptions.js');
  resetStormOptions();
  t.after(() => resetStormOptions());

  const viewer = stubViewer();
  const source = createStormSource({
    load: () => loadStormDataset({ fetchImpl: fileFetch }),
  });
  const observed = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
  });
  observed.init(viewer);
  observed.enable(viewer);
  t.after(() => observed.destroy(viewer));
  observed.setParams({ fromYear: 2010, includeWind: false });

  // The expected layer starts after the observed one is already configured.
  const expected = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
    facet: 'expected',
  });
  expected.init(viewer);
  expected.enable(viewer);
  t.after(() => expected.destroy(viewer));

  assert.equal(
    expected.getParams().fromYear,
    2010,
    "seeding later must not reset the state to the second layer's defaults",
  );
  assert.equal(expected.getParams().includeWind, false);
});

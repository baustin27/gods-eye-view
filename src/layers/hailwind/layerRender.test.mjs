import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Cesium from 'cesium';
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

function stubViewer({ viewSpanDeg = 0.08, lat = 39.74, lon = -104.99 } = {}) {
  const added = [];
  const removed = [];
  const D = Math.PI / 180;
  const half = viewSpanDeg / 2;
  return {
    added,
    removed,
    // The layer culls to the camera's view rectangle, so a stub with no camera
    // silently disables that path and any test of it passes or fails for the
    // wrong reason.
    camera: {
      computeViewRectangle: () => ({
        south: (lat - half) * D,
        west: (lon - half) * D,
        north: (lat + half) * D,
        east: (lon + half) * D,
      }),
    },
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

// The two storm layers share a module-level option bag, and that bag outlives a
// single test. Without this, a layer from a finished test stays subscribed and
// pinned, and a later test inherits the previous test's year window — so a test
// asserting the default 1955 start would fail on state it never set. Resetting
// per test is what makes both the assertions and the memory honest.
afterEach(async () => {
  const { resetStormOptions } = await import('./sharedOptions.js');
  resetStormOptions();
});

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
  async (t) => {
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
    t.after(() => storm.destroy(viewer));

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

maybe('hazard toggles and event visibility drive the scene', async (t) => {
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
  t.after(() => storm.destroy(viewer));

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

maybe('county search and lookup answer "track this area"', async (t) => {
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
  t.after(() => storm.destroy(viewer));

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

maybe('the analyst seam returns bounded, JSON-safe records', async (t) => {
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
  t.after(() => storm.destroy(viewer));

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

// Scene-heavy storm layer tests, split from layer.test.mjs.
//
// Each of these renders the full surface — 6,000 cell rectangles plus up to
// 4,000 event points — and some build two layers at once. Node runs each test
// file in its own process, so keeping them together with the light option and
// chip tests put enough allocations in one heap to OOM it. The split is about
// memory, not about what is being tested.

// --- the two-layer split (stage 1) ------------------------------------------

test('the two facets are distinct layers over one shared snapshot', async (t) => {
  const { createStormLayer } = await import('./index.js');
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

  assert.equal(observed.id, 'storm-observed');
  assert.equal(expected.id, 'storm-expected');
  assert.notEqual(observed.id, expected.id);

  observed.init(viewer);
  expected.init(viewer);
  observed.enable(viewer);
  expected.enable(viewer);
  t.after(() => {
    observed.destroy(viewer);
    expected.destroy(viewer);
  });

  assert.equal(await observed.update(), true);
  assert.equal(await expected.update(), true);

  // The observed layer carries grid cells; the expected layer carries counties.
  // getScoredCells caps at its limit, so ask for more than the threshold.
  assert.ok(
    observed.getScoredCells(5000).length > 100,
    'observed layer scores cells',
  );
  const counties = expected.getScoredCells(5000);
  assert.ok(counties.length > 100, 'expected layer scores counties');
  assert.ok(
    counties.every((row) => row.fips && row.name && row.st),
    'expected rows are counties, keyed by fips',
  );
  assert.notEqual(observed.getStats().facet, expected.getStats().facet);
});

test('the expected layer does not carry events or radar controls', async (t) => {
  const { createStormLayer } = await import('./index.js');
  const viewer = stubViewer();
  const layer = createStormLayer({
    source: createStormSource({
      load: () => loadStormDataset({ fetchImpl: fileFetch }),
    }),
    overlayHost: recordingOverlayHost(),
    facet: 'expected',
  });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => layer.destroy(viewer));
  await layer.update();

  const ids = layer.getRowControls().chips.map((c) => c.id);
  assert.ok(
    !ids.includes('storm-events'),
    'events are an observed-layer concept',
  );
  assert.ok(
    !ids.includes('storm-surface-damage'),
    'no surface switch without cells',
  );
  assert.ok(ids.includes('storm-hail') && ids.includes('storm-wind'));
});

test('an unknown facet is rejected rather than silently defaulting', async () => {
  const { createStormLayer } = await import('./index.js');
  assert.throws(
    () =>
      createStormLayer({
        source: createStormSource({
          load: () => loadStormDataset({ fetchImpl: fileFetch }),
        }),
        overlayHost: recordingOverlayHost(),
        facet: 'nonsense',
      }),
    /Unknown storm facet/,
  );
});

test('switching surface changes what the cells are painted by', async (t) => {
  const { createStormLayer } = await import('./index.js');
  const viewer = stubViewer();
  const layer = createStormLayer({
    source: createStormSource({
      load: () => loadStormDataset({ fetchImpl: fileFetch }),
    }),
    overlayHost: recordingOverlayHost(),
  });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => layer.destroy(viewer));

  // Asserted on state, not on setSurface's return: that return is the
  // rebuild's, and a rebuild is a no-op until a dataset has loaded.
  assert.equal(layer.getSurface(), 'damage');
  layer.setSurface('radar-gap');
  assert.equal(layer.getSurface(), 'radar-gap');
  assert.equal(
    layer.setSurface('nonsense'),
    false,
    'an unknown surface is rejected',
  );
  assert.equal(layer.getSurface(), 'radar-gap', 'and does not change state');
  layer.setSurface('vs-expected');
  assert.equal(layer.getSurface(), 'vs-expected');
});

test('the radar gap surface finds cells radar saw but nobody reported', async (t) => {
  const { createStormLayer } = await import('./index.js');
  const viewer = stubViewer();
  const layer = createStormLayer({
    source: createStormSource({
      load: () => loadStormDataset({ fetchImpl: fileFetch }),
    }),
    overlayHost: recordingOverlayHost(),
  });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => layer.destroy(viewer));
  await layer.update();

  const gaps = layer.getReportingGaps(10);
  assert.ok(
    gaps.length > 0,
    'the snapshot has radar/report divergence to find',
  );
  for (const row of gaps) {
    assert.ok(row.radarHailDays > 0, 'a gap needs radar coverage');
    assert.ok(
      row.radarHailDays > row.hailCount,
      'a gap means more radar days than filed reports',
    );
  }
  // Sorted worst-first, by the same measure the layer ranks on.
  const { radarGapScore } = await import('./model.js');
  for (let i = 1; i < gaps.length; i += 1) {
    const a = radarGapScore(gaps[i - 1]);
    const b = radarGapScore(gaps[i]);
    assert.ok(a.ratio >= b.ratio, 'gaps are ranked by severity of divergence');
  }
});

test('event drill-down cards are actionable and keyboard-reachable', async (t) => {
  const { createStormLayer } = await import('./index.js');
  const viewer = stubViewer();
  const host = recordingOverlayHost();
  const layer = createStormLayer({
    source: createStormSource({
      load: () => loadStormDataset({ fetchImpl: fileFetch }),
    }),
    overlayHost: host,
  });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => layer.destroy(viewer));
  await layer.update();

  const cards = host.last('storm-observed');
  const eventCards = cards.filter((c) => c.id.startsWith('storm-event:'));
  assert.ok(eventCards.length > 0, 'events must be published as cards');
  for (const card of eventCards) {
    assert.equal(card.interactive, true, 'event cards are interactive');
    assert.equal(card.actionable, true, 'and actionable');
    assert.ok(card.accessibilityLabel, 'and must carry an accessibility label');
    assert.equal(typeof card.activate, 'function', 'and an activate handler');
    assert.equal(
      card.collisionGroup,
      'storm-event-card',
      'its own collision group',
    );
  }
  // Cell cards must not be starved by the event cards.
  assert.ok(
    cards.filter((c) => c.id.startsWith('storm-cell:')).length > 0,
    'cell cards must still be published alongside event cards',
  );

  // Activating a card selects the event, and the event is retrievable.
  const target = eventCards[0].id.replace('storm-event:', '');
  assert.equal(eventCards[0].activate(), true);
  assert.equal(layer.getSelectedEvent(), target);
  const found = layer.getEvent(target);
  assert.ok(found, 'the selected event is retrievable for the inspector');
  assert.equal(found.id, target);
});

// --- county polygon geometry (regression) -----------------------------------
//
// Cesium's `polygon.hierarchy` setter does not accept an array of
// PolygonHierarchy: it wraps the array into a single hierarchy and uses the
// array as that hierarchy's positions. Every county then rendered as a
// one-vertex polygon and Cesium threw "origin has a NaN component" from
// EllipsoidTangentPlane. The shape of the data looked perfectly fine, which is
// why it took running the app to find.

test('every county polygon has at least three finite vertices', async (t) => {
  const { createStormLayer } = await import('./index.js');
  const viewer = stubViewer();
  const layer = createStormLayer({
    source: createStormSource({
      load: () => loadStormDataset({ fetchImpl: fileFetch }),
    }),
    overlayHost: recordingOverlayHost(),
    facet: 'expected',
  });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => layer.destroy(viewer));
  await layer.update();

  const ds = layer.getDataSourceForTest?.() ?? null;
  assert.ok(
    ds,
    'the expected layer must expose its data source for inspection',
  );
  const entities = [...ds.entities.values];
  assert.ok(entities.length > 3000, 'all counties are drawn');

  // A ring set handed to Cesium as an array is wrapped into one hierarchy whose
  // positions ARE that array, so the polygon ends up with a single vertex. Read
  // the hierarchy the same way the scene does.
  for (const entity of entities) {
    const hierarchy = entity.polygon.hierarchy._value;
    const positions = hierarchy?.positions;
    assert.ok(
      Array.isArray(positions) && positions.length >= 3,
      `${entity.id} has ${positions ? positions.length : 0} vertices — Cesium was handed an array of rings instead of one hierarchy per ring`,
    );
    for (const c of positions) {
      assert.ok(
        Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z),
        `${entity.id} has a non-finite vertex, which makes the polygon centre NaN`,
      );
    }
  }
});

test('a layer can be turned off and back on again', async (t) => {
  // The manager treats a false return from update() as a rejected lifecycle
  // transition. rebuild() returns whether the *scene* changed, and false when
  // there was nothing to do — so on re-enable, with the entities still on screen
  // and the window unchanged, update() answered false and the whole enable
  // failed with "Could not enable the requested layer".
  const { createStormLayer } = await import('./index.js');
  const viewer = stubViewer();
  const layer = createStormLayer({
    source: createStormSource({
      load: () => loadStormDataset({ fetchImpl: fileFetch }),
    }),
    overlayHost: recordingOverlayHost(),
  });
  layer.init(viewer);
  t.after(() => layer.destroy(viewer));

  assert.equal(
    await layer.update(),
    false,
    'not enabled yet, so nothing to do',
  );
  layer.enable(viewer);
  assert.equal(await layer.update(), true, 'first enable loads and renders');

  layer.disable(viewer);
  assert.equal(await layer.update(), false, 'disabled, so nothing to do');

  layer.enable(viewer);
  assert.equal(
    await layer.update(),
    true,
    're-enabling must report success even when nothing needed redrawing',
  );
  // And it must still be drawing. The count is bounded by the view cull, not by
  // the snapshot, so this asserts "drawing something" rather than a total.
  const drawn = layer.getDataSourceForTest().entities.values.length;
  assert.ok(drawn > 0, 'entities are back on screen after re-enabling');
});

test('the surface bands by rank, so it cannot saturate red again', async () => {
  // Absolute thresholds rot. Correcting the grid bucketing roughly doubled the
  // reports per cell, the log-frequency term rose with it, and 29% of the
  // country came out red with the 10th percentile already over the 0.72
  // threshold — the map read as uniformly red. Ranks are immune to that.
  const { rankScores, bandForRank, STORM_BAND_SHARES } =
    await import('./model.js');
  // Deliberately a shifted, compressed distribution: the shape does not matter,
  // only that the bands stay proportional to it.
  // Distinct scores: equal scores deliberately share a rank, so a fixture with
  // a few repeated values would put a whole plateau in the top band and measure
  // the plateau rule rather than the band shares.
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    key: `k${i}`,
    score: 0.8 + (i / 1000) * 0.006,
  }));
  const ranks = rankScores(rows);
  const bands = {};
  for (const row of rows) {
    const band = bandForRank(ranks.get(String(row.key)));
    bands[band] = (bands[band] || 0) + 1;
  }
  assert.equal(
    bands.red / rows.length,
    STORM_BAND_SHARES.red,
    'red must stay the top slice however the scores are distributed',
  );
  // Adding a constant to every score must not move a single cell across a band.
  const shifted = rows.map((r) => ({ ...r, score: r.score + 5 }));
  const shiftedRanks = rankScores(shifted);
  for (const row of rows) {
    assert.equal(
      bandForRank(shiftedRanks.get(String(row.key))),
      bandForRank(ranks.get(String(row.key))),
      'a uniform shift must not change any band',
    );
  }
});

test('the layer draws only what the camera can see', async (t) => {
  // Drawing all 12,094 cells regardless of zoom is what made the globe a solid
  // red shell. Culling to the view takes the entity count from ~10,000 to
  // under a thousand at street level.
  const { createStormLayer } = await import('./index.js');
  const viewer = stubViewer();
  const layer = createStormLayer({
    source: createStormSource({
      load: () => loadStormDataset({ fetchImpl: fileFetch }),
    }),
    overlayHost: recordingOverlayHost(),
  });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => layer.destroy(viewer));
  await layer.update();

  const values = [...layer.getDataSourceForTest().entities.values];
  const cellsDrawn = values.filter((entity) => entity.rectangle).length;
  const cellsScored = layer.getScoredCells(1e6).length;
  assert.ok(cellsScored > 1000, 'the layer really does score a large cell set');
  assert.ok(values.length > 0, 'the layer draws what is on screen');
  // The stub camera looks at 0.08 degrees. Without the cull every scored cell
  // was drawn at every zoom, which is what made the globe an unusable red
  // shell; with it, a street-level view draws a handful of cells.
  assert.ok(
    cellsDrawn < cellsScored / 20,
    `expected the view cull to drop most cells, drew ${cellsDrawn} of ${cellsScored}`,
  );
});

test('a county hole is a hole, not a second filled county', async (t) => {
  // Every US county hole is an independent city or an enclave. The county path
  // flattened rings and made one entity from each, so all 46 of them were drawn
  // as solid county-coloured blobs sitting on top of the county around them.
  // Real data, real hole: the snapshot is read, not mocked.
  const source = createStormSource({
    load: () => loadStormDataset({ fetchImpl: fileFetch }),
  });
  const storm = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
    facet: 'expected',
  });
  const viewer = stubViewer();
  storm.init(viewer);
  storm.enable(viewer);
  t.after(() => storm.destroy(viewer));
  assert.equal(await storm.update(), true);

  const entities = [...storm.getDataSourceForTest().entities.values];
  const countyEntities = entities.filter((e) =>
    String(e.id ?? '').startsWith('storm-county:'),
  );
  assert.ok(countyEntities.length > 0, 'counties drew');

  // Every county's parts must produce ONE entity per part, with the holes
  // carried on the hierarchy rather than promoted to entities of their own.
  const byCounty = new Map();
  for (const e of countyEntities) {
    const [, fips] = String(e.id).split(':');
    byCounty.set(fips, (byCounty.get(fips) ?? 0) + 1);
  }
  const dataset = await source.getSnapshot();
  let holeChecked = 0;
  let holeOwnEntity = 0;
  for (const county of dataset.counties) {
    const geometry = dataset.countiesByFips.get(String(county.fips))?.geometry;
    if (!geometry) continue;
    const parts =
      geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [geometry.coordinates];
    const withHoles = parts.filter((set) => set.length > 1);
    if (!withHoles.length) continue;
    holeChecked += withHoles.length;
    // Previously every ring became an entity, so a part with 3 rings produced
    // 3 entities. Now it produces 1.
    if ((byCounty.get(String(county.fips)) ?? 0) > parts.length) holeOwnEntity += 1;
  }
  assert.ok(holeChecked > 0, 'the snapshot really does contain holed counties');
  assert.equal(
    holeOwnEntity,
    0,
    'no holed county produced more entities than it has parts',
  );

  // And the hierarchy a holed county drew actually carries its holes.
  // `entity.polygon` is a ConstantProperty wrapping the PolygonGraphics, and
  // `.hierarchy` is a ConstantProperty inside that, so both need unwrapping.
  // Reading `.holes` off the wrapper is always undefined - which is how the
  // first version of this test "found no holed counties" on data that has 22.
  const unwrap = (property) =>
    property && typeof property.getValue === 'function'
      ? property.getValue()
      : property;
  const holed = countyEntities.find((e) => {
    const graphics = unwrap(e.polygon);
    const hierarchy = unwrap(graphics?.hierarchy);
    return Array.isArray(hierarchy?.holes) && hierarchy.holes.length > 0;
  });
  assert.ok(
    holed,
    `at least one drawn county carries holes on its hierarchy (${countyEntities.length} county entities)`,
  );
});

test('the county entity budget is a budget on entities, not on rows', async (t) => {
  // `STORM_MAX_COUNTIES` bounded the rows `scoreCounties` returned, and every
  // row can carry several parts. The real file produced 4,256 rings from 3,234
  // counties, so "3,234 of 4,000" was the cap checked in the wrong unit and
  // 256 entities overran it.
  const source = createStormSource({
    load: () => loadStormDataset({ fetchImpl: fileFetch }),
  });
  const storm = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
    facet: 'expected',
  });
  const viewer = stubViewer();
  storm.init(viewer);
  storm.enable(viewer);
  t.after(() => storm.destroy(viewer));
  assert.equal(await storm.update(), true);

  const allEntities = [...storm.getDataSourceForTest().entities.values];
  const countyEntities = allEntities.filter((e) =>
    String(e.id ?? '').startsWith('storm-county:'),
  );
  assert.ok(countyEntities.length > 0, 'counties drew');
  assert.ok(
    countyEntities.length <= 5000,
    `${countyEntities.length} county entities is within the 5,000 cap`,
  );
});

test('isolating a state scopes the damage surface to that state', async (t) => {
  // The surface paints 0.25 degree cells from 1955 onward. Isolating Colorado
  // used to filter the storm reports and leave this drawing the whole country,
  // which reads as the feature being broken rather than half-built.
  const source = createStormSource({
    load: () => loadStormDataset({ fetchImpl: fileFetch }),
  });
  const storm = createStormLayer({ source, overlayHost: recordingOverlayHost() });
  // A WIDE view. The stub defaults to a 0.08 degree window over Denver,
  // already inside Colorado - so scoping changed nothing and the first version
  // of this test asserted 16 of 16 and read as a broken filter.
  const viewer = stubViewer({ viewSpanDeg: 90, lat: 39, lon: -100 });
  storm.init(viewer);
  storm.enable(viewer);
  t.after(() => storm.destroy(viewer));
  assert.equal(await storm.update(), true);

  const cells = () =>
    [...storm.getDataSourceForTest().entities.values].filter((e) =>
      String(e.id ?? '').startsWith('storm-cell:'),
    );
  const unscoped = cells().length;
  assert.ok(unscoped > 50, `a wide view draws a lot of cells (${unscoped})`);

  assert.equal(storm.setIsolation({ bbox: [-109.05, 37, -102.04, 41] }), true);
  const scoped = cells().length;
  assert.ok(
    scoped > 0 && scoped < unscoped,
    `Colorado shows ${scoped} of ${unscoped} cells - fewer, but not none`,
  );

  // Every drawn cell must be inside Colorado's box. Read from the entity's own
  // position rather than from the row it came from, so this measures what
  // reached the scene.
  const DEG = 180 / Math.PI;
  const unwrap = (property) =>
    property && typeof property.getValue === 'function'
      ? property.getValue()
      : property;
  for (const cell of cells()) {
    // `entity.position` is a ConstantProperty until asked.
    const c = Cesium.Cartographic.fromCartesian(unwrap(cell.position));
    const lat = c.latitude * DEG;
    const lon = c.longitude * DEG;
    assert.ok(
      lat >= 37 - 0.25 && lat <= 41 + 0.25,
      `no cell drawn north of Colorado (${lat.toFixed(2)})`,
    );
    assert.ok(
      lon >= -109.05 - 0.25 && lon <= -102.04 + 0.25,
      `no cell drawn outside Colorado's longitudes (${lon.toFixed(2)})`,
    );
  }

  assert.equal(storm.setIsolation(null), false);
  assert.equal(cells().length, unscoped, 'clearing the area brings them all back');
});

test('the county surface bands by rank, so it cannot saturate red again', async (t) => {
  // `rebuildExpected` was the last surface banding on ABSOLUTE score thresholds
  // (0.72 / 0.42 / 0.18) - a calibration the model module's own comment says
  // rots silently, and which the cell surface already abandoned for that reason.
  //
  // Measured against the real snapshot: on the absolute calibration 36.6% of all
  // US counties land in the top band and 93.8% land in the top two - the map is a
  // red/orange wall. Scoped to Colorado it is 40.6% / 82.8%. Rank banding puts
  // ~11% in the top band, which is what STORM_BAND_SHARES asks for.
  const source = createStormSource({
    load: () => loadStormDataset({ fetchImpl: fileFetch }),
  });
  const storm = createStormLayer({
    source,
    overlayHost: recordingOverlayHost(),
    facet: 'expected',
  });
  const viewer = stubViewer({ viewSpanDeg: 90, lat: 39, lon: -100 });
  storm.init(viewer);
  storm.enable(viewer);
  t.after(() => storm.destroy(viewer));
  assert.equal(await storm.update(), true);

  // Read the RGB, not the whole string. `toCssColorString()` gives
  // 'RGBA(255,64,64,0.55)' and `toCssHexString()` gives '#FF40408C' - both carry
  // the alpha. Two earlier versions of this test compared those whole strings
  // against '#FF4040', which never matches, so the band share was always zero and
  // the assertion passed against BOTH bandings. A green test that cannot go red.
  //
  // The first 7 characters are the colour; the last two are alpha, and the alpha
  // differs per band anyway (0.55 / 0.45 / 0.35 / 0.22) so it cannot be part of
  // the match.
  const countyColour = (entity) => {
    const graphics = entity.polygon?.getValue?.() ?? entity.polygon;
    const material = graphics?.material?.getValue?.() ?? graphics?.material;
    const colour = material?.color ?? material;
    const hex = (colour?.toCssHexString?.() ?? '').toUpperCase();
    return hex.slice(0, 7);
  };
  const drawn = () =>
    [...storm.getDataSourceForTest().entities.values]
      .filter((e) => String(e.id ?? '').startsWith('storm-county:'))
      .map((e) => ({ fips: String(e.id).split(':')[1], colour: countyColour(e) }))
      .filter((e) => e.colour);

  // The RED band specifically, not "the largest band". Counties with identical
  // scores share a rank by design - a plateau must not be split across bands -
  // and on the national set there are enough zero-scored counties to make blue a
  // third of the map. That is correct. What must not happen is the TOP band
  // covering the map, which is the failure the absolute calibration produced.
  const RED = '#FF4040';
  const shareOfRed = (list) =>
    list.filter((row) => row.colour === RED).length / list.length;

  const all = drawn();
  assert.ok(all.length > 20, `counties drew (${all.length})`);
  const nationalRed = shareOfRed(all);
  // Measured on this snapshot: rank banding puts 7.9% of counties in the top
  // band; the absolute calibration puts 29.3% there and 53.6% in the second,
  // which is the red/orange wall this change exists to remove.
  assert.ok(
    nationalRed <= 0.2,
    `the top band covers at most a fifth of the country (${(nationalRed * 100).toFixed(1)}%)`,
  );

  // Ranking happens over the counties ACTUALLY DRAWN, so scoping a state bands
  // that state against itself rather than against a national distribution most
  // of it will never reach.
  storm.setIsolation({ bbox: [-109.05, 37, -102.04, 41] });
  const scoped = drawn();
  assert.ok(scoped.length > 5, `counties drew inside Colorado (${scoped.length})`);
  const scopedRed = shareOfRed(scoped);
  assert.ok(
    scopedRed <= 0.2,
    `and at most a fifth of Colorado (${(scopedRed * 100).toFixed(1)}%)`,
  );
  assert.ok(
    new Set(scoped.map((r) => r.colour)).size >= 3,
    'Colorado reads comparatively - several bands in use',
  );
});

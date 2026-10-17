#!/usr/bin/env node
/**
 * Focused browser proof for the per-day radar swaths — the Phase F gate.
 *
 * Why this exists: the swaths were reported invisible, and the handoff's answer
 * was to ask a human whether the wash was "invisible or faint". That is a
 * subjective judgement blocking real work, and three candidates were never
 * separated: the toggles being off, the wash being buried, or the wash being
 * too faint. This harness settles all three with measurements, and writes them
 * to disk so the next person quotes a figure instead of an impression.
 *
 * The three probes, in the order they must be eliminated:
 *
 *   1. ARE THEY ON?    Both chips are clicked through the real DOM, then the
 *                       entity collections are read back. Both swath toggles
 *                       default to false (src/layers/stormReports/index.js:421),
 *                       so "no swaths on screen" is a legitimate state and not
 *                       a rendering bug.
 *   2. BURIED, OR FAINT?  Lift every swath rectangle to 200 km, well above any
 *                       terrain, and re-measure. Appears => buried. Still
 *                       absent => faint, or off-screen. No human in the loop.
 *   3. WHICH GROUND?   Read the regime that actually booted. There is no .env
 *                       in this repo, so a plain run boots keyless: route 'osm',
 *                       globe.show true, esri-imagery (src/maps/google3d.js:12-14,
 *                       src/app/scene.js:82-99). That is a free control against
 *                       the photorealistic-tiles hypothesis.
 *
 * Visibility is measured as a DIFFERENCE between two captures of the same
 * frame — swaths on, then swaths off — rather than by sampling a colour the
 * viewer was supposed to paint. It needs no projection maths, no knowledge of
 * where the cells landed, and it fails honestly when the canvas is blank.
 *
 * SAFETY: this launches its OWN headless Chrome with its own profile and never
 * connects to a remote debugging port. It must never be pointed at 9222 or
 * 9333 — those are the operator's live Pinokio sessions, and a reload there has
 * cost him the session before. The app here is a top-level page on a plain dev
 * server, not the out-of-process iframe the Pinokio shell wraps.
 *
 * Usage:
 *   npm run qa:storm-swath                       # whatever regime boots
 *   QA_BASE_URL=http://127.0.0.1:4188 npm run qa:storm-swath
 *   node scripts/qa-storm-swath.mjs --headful   # watch it
 *   node scripts/qa-storm-swath.mjs --keep-going # report every failure
 *
 * Env:
 *   QA_BASE_URL           app to test (default http://localhost:4173)
 *   QA_SHOTS_DIR          shot directory (default qa-shots/storm-swath)
 *   QA_SWATH_DATE         day to stage (default 2026-10-13)
 *   QA_SWATH_LAT/LON      camera target (default 34.4 / -100.3)
 *   PUPPETEER_EXECUTABLE_PATH  browser binary override
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { redact, hookRenderErrors, readRenderErrors } from './qa-browserEvidence.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir =
  process.env.QA_SHOTS_DIR || path.join(repoRoot, 'qa-shots', 'storm-swath');
const appUrl = process.env.QA_BASE_URL || 'http://localhost:4173';
const headful = process.argv.includes('--headful');
const keepGoing = process.argv.includes('--keep-going');
const stageDate = process.env.QA_SWATH_DATE || '2026-10-13';
const targetLat = Number(process.env.QA_SWATH_LAT || 34.4);
const targetLon = Number(process.env.QA_SWATH_LON || -100.3);
const CAMERA_HEIGHT_M = 40_000;
/**
 * The lift probe's height. 200 km clears any terrain this app can show and is
 * far enough below the horizon that the rectangle still faces the camera.
 */
const LIFT_HEIGHT_M = 200_000;
/** A pixel must differ by at least this in any channel to count as "washed". */
const DELTA_THRESHOLD = 8;
/**
 * Fraction of each edge to ignore when measuring.
 *
 * The app's instrument panel is LIVE: the REC timestamp, DOLL stopwatch, ALT,
 * GSD and orbit counters all re-render every frame. Comparing two captures
 * pixel for pixel therefore reads 80-320px of pure telemetry churn that has
 * nothing to do with the swaths — which is exactly the spread this harness
 * first reported (82px vs 321px) and mistook for instability. Measuring a
 * central region drops the panel and keeps the map, where the wash is.
 */
const MEASURE_INSET = Number(process.env.QA_SWATH_INSET || 0.18);

fs.mkdirSync(shotsDir, { recursive: true });

const failures = [];
const notes = [];
const report = {
  appUrl,
  stageDate,
  camera: { lat: targetLat, lon: targetLon, heightM: CAMERA_HEIGHT_M },
  liftHeightM: LIFT_HEIGHT_M,
  deltaThreshold: DELTA_THRESHOLD,
};

function check(name, passed, detail = '') {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures.push(name);
  return passed;
}

function note(message) {
  notes.push(message);
  console.log(`         ${message}`);
}

/**
 * Find a browser: the explicit override, then Puppeteer's own download, then
 * whatever Chrome the box already has. The last step is not a convenience — on
 * a machine where `puppeteer install` was never run, the first two are both
 * absent and this is the difference between the gate running and the gate
 * being silently unrunnable.
 */
async function resolveBrowser() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    await puppeteer.executablePath().catch(() => null),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const executablePath = await resolveBrowser();
if (!executablePath) {
  throw new Error(
    'No Chrome found. Set PUPPETEER_EXECUTABLE_PATH, or run `npx puppeteer browsers install chrome`.',
  );
}
note(`browser: ${executablePath}`);

const browser = await puppeteer.launch({
  headless: headful ? false : 'new',
  executablePath,
  // Metal is a macOS-only ANGLE backend and passing it on Linux or Windows
  // fails WebGL initialisation outright, which kills Cesium at the boot wait
  // before a single assertion runs. SwiftShader is the Linux path.
  args: [
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--no-sandbox',
  ],
});

/**
 * Read every entity the app has, through every collection it might be in.
 *
 * Deliberately does NOT classify by `entity.id`. The handoff records that id
 * as `undefined` on real entities in this build, and the first run of this
 * script reproduced exactly that — zero readable ids on every collection while
 * the wash was plainly rendering. So the discriminator is the PropertyBag the
 * renderer itself sets: `addSwathCell` stamps `{ swath: true, key: id }`
 * (index.js:1243), and a PropertyBag reads through `getValue()`.
 *
 * Every collection tried is reported with its readable-id count, because a
 * harness that reports "0 found" without saying WHY is how three false findings
 * were produced in this area. This one must be able to say "I looked here, this
 * is what I read, and here is the path that worked".
 */
async function collectSwaths(page) {
  return page.evaluate(() => {
    const viewer = window.__godsEyeView?.viewer;
    if (!viewer) return { error: 'no viewer' };
    const read = (property) => {
      if (property == null) return undefined;
      if (typeof property.getValue === 'function') return property.getValue();
      return property;
    };
    const found = [];
    const readPaths = [];
    const scan = (label, collection) => {
      if (!collection) {
        readPaths.push({ path: label, usable: false, why: 'no collection' });
        return;
      }
      // `values` on a Cesium EntityCollection is an ARRAY GETTER, not a method.
      // The handoff records "values() is not a function" and that is exactly
      // right — but it is right about the CALL SYNTAX, not about the collection
      // being uniterable. Writing `typeof values !== 'function'` skips every
      // collection and reports "0 entities" while they are full. The first run
      // of this script made precisely that mistake.
      const raw = collection.values;
      const entities = typeof raw === 'function' ? raw.call(collection) : raw;
      if (!entities || typeof entities[Symbol.iterator] !== 'function') {
        readPaths.push({
          path: label,
          usable: false,
          why: `values is ${typeof raw}, not iterable`,
        });
        return;
      }
      let seen = 0;
      let readableIds = 0;
      let tagged = 0;
      for (const entity of entities) {
        seen += 1;
        if (typeof entity?.id === 'string') readableIds += 1;
        const bag = entity?.properties;
        const isSwath = read(bag?.swath) === true;
        if (isSwath) tagged += 1;
        const key = read(bag?.key);
        if (isSwath) {
          // Record the cell's own footprint so the camera can be aimed at the
          // storm itself. Hardcoding a target coordinate is how the first run
          // ended up framing 60% empty ocean with the swath clipped at the top
          // of the frame — and a wash you cannot see in the picture is not a
          // measurement of the wash.
          let bounds = null;
          const rect = read(entity.rectangle?.coordinates);
          if (rect) {
            const d = 180 / Math.PI;
            bounds = {
              west: rect.west * d,
              south: rect.south * d,
              east: rect.east * d,
              north: rect.north * d,
            };
          }
          found.push({
            key: typeof key === 'string' ? key : null,
            kind: entity.rectangle ? 'rectangle' : entity.polygon ? 'polygon' : 'other',
            bounds,
            entity,
          });
        }
      }
      readPaths.push({
        path: label,
        usable: seen > 0,
        entities: seen,
        readableIds,
        swathTagged: tagged,
      });
    };

    scan('viewer.entities', viewer.entities);
    const sources = viewer.dataSources;
    const sourceCount = sources && typeof sources.length === 'number' ? sources.length : 0;
    for (let i = 0; i < sourceCount; i += 1) {
      scan(`viewer.dataSources[${i}].entities`, sources.get(i)?.entities);
    }

    const byKind = { reported: 0, radar: 0, other: 0 };
    for (const item of found) {
      if (String(item.key).startsWith('storm-swath:reported:')) byKind.reported += 1;
      else if (String(item.key).startsWith('storm-swath:radar:')) byKind.radar += 1;
      else byKind.other += 1;
    }

    // Sample one real entity's geometry so the report says what is actually
    // being drawn, and — importantly for Phase F — whether it is a rectangle
    // or a polygon.
    let geometry = null;
    const sample = found.find((f) => f.key) || found[0];
    if (sample) {
      const entity = sample.entity;
      if (entity.rectangle) {
        const readG = (g) => (g == null ? null : (typeof g.getValue === 'function' ? g.getValue() : g));
        // `coordinates` is ITSELF a PropertyBag wrapping a Rectangle, so
        // reading .west straight off it returns undefined — which is why the
        // first run's report carried `west: null` on a cell that demonstrably
        // had bounds. Unwrap once, then read.
        const c = readG(entity.rectangle.coordinates);
        geometry = {
          kind: 'rectangle',
          key: sample.key,
          height: readG(entity.rectangle.height),
          heightReference: readG(entity.rectangle.heightReference),
          granularity: readG(entity.rectangle.granularity),
          outline: readG(entity.rectangle.outline),
          // Radians, per the handoff's instrument traps. Converted to degrees
          // only here, where the whole point is to aim the camera.
          westDeg: c ? (c.west * 180) / Math.PI : null,
          southDeg: c ? (c.south * 180) / Math.PI : null,
          eastDeg: c ? (c.east * 180) / Math.PI : null,
          northDeg: c ? (c.north * 180) / Math.PI : null,
        };
      } else if (entity.polygon) {
        geometry = {
          kind: 'polygon',
          key: sample.key,
          heightReference: read(entity.polygon.heightReference),
          outline: read(entity.polygon.outline),
          hasOutlineColor: Boolean(read(entity.polygon.outlineColor)),
          vertices: read(entity.polygon.hierarchy)?.length ?? null,
        };
      } else {
        geometry = { kind: 'other', key: sample.key };
      }
    }
    // Extents PER KIND. A single union over every drawn cell is useless for
    // framing: the day's radar field covers the whole ingest domain — the first
    // run framed 21.75..52.75 N and -119.5..-60.25 W, which is most of the
    // country, and the wash shrank to 0.19% of a frame 964 km up. The REPORTED
    // cells are the storm itself and are what a roofer is looking at.
    const boxOf = (items) => {
      const withBounds = items.filter((f) => f.bounds);
      if (!withBounds.length) return null;
      const b = {
        west: Math.min(...withBounds.map((f) => f.bounds.west)),
        south: Math.min(...withBounds.map((f) => f.bounds.south)),
        east: Math.max(...withBounds.map((f) => f.bounds.east)),
        north: Math.max(...withBounds.map((f) => f.bounds.north)),
        cells: withBounds.length,
      };
      b.centerLat = (b.south + b.north) / 2;
      b.centerLon = (b.west + b.east) / 2;
      return b;
    };
    const reportedItems = found.filter((f) =>
      String(f.key).startsWith('storm-swath:reported:'),
    );
    const radarItems = found.filter((f) =>
      String(f.key).startsWith('storm-swath:radar:'),
    );

    /**
     * The DENSEST cluster of drawn cells, not the bounding box.
     *
     * A centroid is the wrong aim point for a legibility test: the day's
     * reports run from Kansas to Texas, so the middle of the box can be empty
     * ground and the wash shrinks to 315px of a 1280x900 frame — a measurement
     * of the framing, not of the wash. Legibility is judged where the storm is,
     * so group cells within a couple of degrees of each other and take the
     * largest group. One pass of greedy grouping, which is plenty for cells
     * that already arrive as 0.25-degree neighbours.
     */
    const densestCluster = (items) => {
      const withBounds = items.filter((f) => f.bounds);
      if (!withBounds.length) return null;
      const NEIGHBOUR_DEG = 2.5;
      const seen = new Set();
      let best = null;
      for (const seed of withBounds) {
        if (seen.has(seed)) continue;
        const group = [];
        const queue = [seed];
        seen.add(seed);
        while (queue.length) {
          const cell = queue.shift();
          group.push(cell);
          for (const other of withBounds) {
            if (seen.has(other)) continue;
            const dLon = Math.abs(other.bounds.west - cell.bounds.west);
            const dLat = Math.abs(other.bounds.south - cell.bounds.south);
            if (dLon <= NEIGHBOUR_DEG && dLat <= NEIGHBOUR_DEG) {
              seen.add(other);
              queue.push(other);
            }
          }
        }
        if (!best || group.length > best.length) best = group;
      }
      return boxOf(best);
    };

    /**
     * The aim point: ONE known-drawn cell, not a cluster centroid.
     *
     * A cluster centroid can sit over empty ground between scattered cells —
     * at 23 km the two captures then differ by 385px of live HUD and nothing
     * else, which is a measurement of the framing. A single cell centre puts a
     * 25-mile square of known-present wash under the camera, so the contrast
     * figure describes the wash. Sorted by key so the choice is deterministic.
     */
    const aimKey = new URLSearchParams(location.search).get('swathCell');
    const sortedReported = [...reportedItems].sort((a, b) =>
      String(a.key).localeCompare(String(b.key)),
    );
    const focusCell =
      sortedReported.find((f) => String(f.key) === aimKey) ||
      sortedReported.find((f) => f.bounds) ||
      [...radarItems].sort((a, b) => String(a.key).localeCompare(String(b.key))).find(
        (f) => f.bounds,
      ) ||
      null;
    const focus = focusCell
      ? {
          cells: 1,
          west: focusCell.bounds.west,
          south: focusCell.bounds.south,
          east: focusCell.bounds.east,
          north: focusCell.bounds.north,
          centerLat: (focusCell.bounds.south + focusCell.bounds.north) / 2,
          centerLon: (focusCell.bounds.west + focusCell.bounds.east) / 2,
          key: focusCell.key,
          cluster: densestCluster(reportedItems)?.cells ?? null,
        }
      : densestCluster(reportedItems) || densestCluster(radarItems) || null;
    const extent = boxOf(reportedItems) || boxOf(radarItems);
    const radarExtent = boxOf(radarItems);
    if (extent) {
    }

    return {
      readPaths,
      dataSourceCount: sourceCount,
      total: found.length,
      extent,
      radarExtent,
      focus,
      byKind,
      keys: found.map((f) => f.key).filter(Boolean).slice(0, 400),
      geometry,
    };
  });
}

/**
 * The layer module, reached the way the app actually holds it.
 *
 * `dataManager.layers` maps an id to a lifecycle RECORD, not to the layer: the
 * module that owns `setHazard`, `setDate` and the swath toggles is on
 * `record.module`. Probing this cost a run, so it is one named seam asserted
 * before any measurement — a future reshuffle then fails as a harness error and
 * not as a silent "zero swaths", which is how three false findings were born in
 * this area.
 */
async function resolveLayerModule(page) {
  return page.evaluate(() => {
    const record =
      window.__godsEyeView?.dataManager?.layers?.get('storm-reports');
    const layer = record?.module ?? record;
    return {
      found: Boolean(layer),
      hasSetHazard: typeof layer?.setHazard === 'function',
      hasSetDate: typeof layer?.setDate === 'function',
      hasReportedSwath: typeof layer?.setReportedSwath === 'function',
      hasRadarSwath: typeof layer?.setRadarSwath === 'function',
    };
  });
}

/**
 * Which map regime actually booted, read from live scene state rather than
 * from the environment.
 *
 * This is the control the handoff asked for. With no `.env` in the repo,
 * `google3d.js` falls through to route 'osm' and `scene.js:82-99` initialises
 * `esri-imagery` with `globe.show` true — a ground the occlusion hypothesis
 * never contemplated, and therefore a free way to tell "buried by photorealistic
 * tiles" apart from "too faint to see".
 */
async function readRegime(page) {
  return page.evaluate(() => {
    const app = window.__godsEyeView;
    const scene = app?.viewer?.scene;
    return {
      hasTileset: Boolean(app?.tileset),
      globeShow: scene?.globe?.show ?? null,
      depthTestAgainstTerrain: scene?.globe?.depthTestAgainstTerrain ?? null,
      imageryLayers: scene?.imageryLayers?.length ?? null,
      name: Boolean(app?.tileset)
        ? 'photorealistic-3d-tiles'
        : scene?.globe?.show
          ? 'keyless-globe-esri-imagery'
          : 'unknown',
    };
  });
}

/**
 * Call one of the app's own automation verbs.
 *
 * This is the surface scripts/gev-control.mjs drives, and it is the app's
 * sanctioned way to move the camera and switch the map stack. Rebuilding a
 * Cesium camera by hand from `window` was tried first and threw a
 * `DeveloperError` with an empty message — a second instrument lying, worth
 * recording next to the first. The verbs also hand back real state, so the
 * camera loop below closes on a MEASURED height rather than an assumed one.
 */
async function runVerb(page, name, args = {}) {
  return page.evaluate(
    async (verb, verbArgs) => {
      const runner = window.__gevVoiceCommands?.runner;
      if (typeof runner !== 'function') return { ok: false, error: 'no runner' };
      try {
        return await runner(verb, verbArgs);
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    name,
    args,
  );
}

/** Camera height in metres, straight off the live camera. */
async function cameraHeight(page) {
  return page.evaluate(() => {
    const cartographic =
      window.__godsEyeView?.viewer?.camera?.positionCartographic;
    return cartographic ? Number(cartographic.height) : null;
  });
}

/**
 * Stage the layer: enable it, set HAIL, choose the day, then bring the camera
 * to the target and close the loop on its ACTUAL height.
 *
 * Zooming is iterative on purpose: `adjust_camera_zoom` moves an orbit radius
 * by a fixed factor, so one call lands wherever it lands. Reading the height
 * back and zooming until it is in range is what makes "40 km" a fact about the
 * capture instead of an intention. The iteration cap matters too: a camera
 * that will not converge is a finding to report, not a loop to spin in.
 */
async function stageScene(page) {
  // The first-launch mission dialog covers the middle of the frame. It is not
  // part of the map, but it sits between the camera and the thing under test,
  // so the capture has to be taken with it gone. Suppressing it durably (the
  // key the app itself writes) is better than clicking ESC: a keyed run must
  // not depend on a focus assumption.
  await page.evaluate(() => {
    try {
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    } catch {
      /* private mode; the ESC path below still applies */
    }
  });
  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 600));

  const enabled = await runVerb(page, 'set_layer_visibility', {
    layerId: 'storm-reports',
    enabled: true,
  });
  report.verbs = { setLayerVisibility: enabled };
  if (enabled?.ok === false) {
    note(`layer enable: ${enabled.error || JSON.stringify(enabled)}`);
  }

  const staged = await page.evaluate((date) => {
    const record =
      window.__godsEyeView?.dataManager?.layers?.get('storm-reports');
    const layer = record?.module ?? record;
    if (!layer) return { ok: false, error: 'no layer record' };
    layer.setHazard('hail');
    // A day is what makes the radar swath mean anything; without one it is a
    // lifetime fallback wearing a per-day label (see radarSwathCells).
    if (typeof layer.setDate === 'function') layer.setDate(date);
    return { ok: true, hazard: 'hail', date };
  }, stageDate);
  report.staged = staged;
  if (!staged.ok) note(`staging: ${staged.error}`);

  // `rangeM` is the verb's own argument and is clamped to [100, 20e6] m by the
  // app, so the requested altitude is honoured in one move. The earlier
  // version iterated `adjust_camera_zoom` by a 2.4x factor and overshot to a
  // NEGATIVE height — inside the ellipsoid — because nothing in the loop
  // checked for that.
  const flew = await runVerb(page, 'fly_to_location', {
    latitude: targetLat,
    longitude: targetLon,
    rangeM: CAMERA_HEIGHT_M,
    waitForArrival: true,
  });
  report.verbs = { ...(report.verbs || {}), flyToLocation: flew };

  // Verify rather than trust: a verb that silently ignored rangeM would leave
  // the camera at a global view and every measurement below would be about
  // nothing. The height is the fact, not the request.
  let height = await cameraHeight(page);
  if (height != null && (height < 0 || height > CAMERA_HEIGHT_M * 4)) {
    note(
      `fly reported ${Math.round(height)} m, outside the expected band — falling back to zoom steps`,
    );
    for (let attempt = 0; attempt < 12 && height != null; attempt += 1) {
      if (height < 0) break;
      if (height >= CAMERA_HEIGHT_M * 0.6 && height <= CAMERA_HEIGHT_M * 1.8) break;
      await runVerb(page, 'adjust_camera_zoom', {
        direction: height > CAMERA_HEIGHT_M ? 'in' : 'out',
        amount: 'little',
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      height = await cameraHeight(page);
    }
  }

  report.camera = report.camera || {};
  report.camera.heightAfterStaging = height;
  note(`camera height after staging: ${Math.round(height || 0)} m`);
  check(
    'the camera is at the requested swath altitude',
    height != null && height > 0 && height <= CAMERA_HEIGHT_M * 4,
    `${Math.round(height || 0)} m (want ${CAMERA_HEIGHT_M} m)`,
  );
  await settle(page);
}

/**
 * Let loads land and Cesium actually paint before anything is captured.
 *
 * The `tilesLoaded` wait is not politeness, it is correctness. Two captures
 * taken while imagery is still streaming differ from each other for reasons
 * that have nothing to do with the swaths, and this harness compares captures
 * pixel for pixel: an unsettled globe read 145px on the first pass and 3,019px
 * on the second for the very same scene. Timeout-guarded, because a globe that
 * never reports loaded must not hang the gate.
 */
async function settle(page, frames = 12) {
  await page
    .waitForFunction(
      () => {
        const globe = window.__godsEyeView?.viewer?.scene?.globe;
        if (!globe) return false;
        if (globe.tilesLoaded !== true) return false;
        // Under photorealistic tiles the globe is hidden and imagery layers do
        // not report on it, so treat a hidden globe as settled by definition.
        return globe.show === false ? true : globe.imageryLayers?.length >= 0;
      },
      { timeout: 30_000, polling: 250 },
    )
    .catch(() => note('tiles never reported loaded; capturing anyway'));
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i += 1) {
      window.__godsEyeView?.requestRender?.();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    }
  }, frames);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/**
 * Click a chip by its id and report the state it left behind.
 *
 * The chips are the real seam and the real suspect: an HMR reload of the layer
 * file resets both toggles to off, which is the likeliest reason a scene ever
 * looked empty. So this clicks the button and then reads the layer back, and
 * fails loudly if the click did not move it.
 */
async function clickChip(page, chipId) {
  return page.evaluate((id) => {
    const button = document.querySelector(`[data-chip-id="${id}"]`);
    if (!button) return { found: false };
    const before = button.classList.contains('active');
    if (button.disabled) return { found: true, disabled: true, before };
    button.click();
    return { found: true, disabled: false, before };
  }, chipId);
}

async function readSwathState(page) {
  return page.evaluate(() => {
    const record =
      window.__godsEyeView?.dataManager?.layers?.get('storm-reports');
    const layer = record?.module ?? record;
    const chip = (id) => {
      const node = document.querySelector(`[data-chip-id="${id}"]`);
      return node
        ? { active: node.classList.contains('active'), disabled: node.disabled }
        : null;
    };
    return {
      reported: layer?.getReportedSwath?.() ?? null,
      radar: layer?.getRadarSwath?.() ?? null,
      reportedChip: chip('storm-reports-swath-reported'),
      radarChip: chip('storm-reports-swath-radar'),
    };
  });
}

/**
 * Capture the WebGL canvas, forcing real frames first.
 *
 * `requestRender()` alone is not enough. The app installs a render governor
 * (installRenderGovernor in src/app/scene.js) that suppresses frames when it
 * judges nothing changed, so a screenshot taken after it returns can be the
 * SAME compositor frame as the previous one — two captures of two different
 * states come back byte-identical while the live screen plainly differs. That
 * is what produced a 0px wash footprint against a wash visible in the picture.
 * Calling scene.render() directly bypasses the governor and guarantees the
 * framebuffer holds the state being measured.
 */
async function captureCanvas(page, name) {
  const canvas = await page.$('canvas');
  if (!canvas) {
    note('no canvas found');
    return null;
  }
  await page.evaluate(() => {
    const scene = window.__godsEyeView?.viewer?.scene;
    if (!scene || scene.isDestroyed?.()) return;
    for (let i = 0; i < 3; i += 1) scene.render();
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const file = path.join(shotsDir, `${name}.png`);
  await canvas.screenshot({ path: file });
  return file;
}

/**
 * Compare two captures and report, as numbers:
 *   changed   how many pixels moved at all (the wash's screen footprint)
 *   meanDelta average channel movement inside those pixels (how strong it is)
 *   contrast  WCAG ratio between the two colours where they differ (legibility)
 *
 * A single flat alpha over busy imagery can be *present* and still fail to
 * read. `contrast` is the figure that settles that, and it is what a
 * regression test should assert on — not "it looked faint".
 */
async function diffMetrics(nameA, nameB) {
  const [a, b] = await Promise.all([
    sharp(path.join(shotsDir, `${nameA}.png`)).raw().toBuffer({ resolveWithObject: true }),
    sharp(path.join(shotsDir, `${nameB}.png`)).raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (a.data.length !== b.data.length || a.info.width !== b.info.width) {
    return { error: 'captures differ in size', a: a.info, b: b.info };
  }
  const channels = a.info.channels;
  const width = a.info.width;
  const height = a.info.height;
  // The measured window: the frame minus the instrument panel margins.
  const insetX = Math.floor(width * MEASURE_INSET);
  const insetY = Math.floor(height * MEASURE_INSET);
  const x0 = insetX;
  const y0 = insetY;
  const x1 = width - insetX;
  const y1 = height - insetY;
  const total = a.info.width * a.info.height;
  let measured = 0;
  let changed = 0;
  let sumDelta = 0;
  let maxDelta = 0;
  let sumLumaA = 0;
  let sumLumaB = 0;
  let minX = a.info.width;
  let minY = a.info.height;
  let maxX = -1;
  let maxY = -1;
  const heat = Buffer.alloc(a.data.length);
  for (let px = 0; px < total; px += 1) {
    const x = px % width;
    const y = (px / width) | 0;
    // Skip the live HUD margins.
    if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
    measured += 1;
    const o = px * channels;
    const dr = Math.abs(a.data[o] - b.data[o]);
    const dg = Math.abs(a.data[o + 1] - b.data[o + 1]);
    const db = Math.abs(a.data[o + 2] - b.data[o + 2]);
    const delta = Math.max(dr, dg, db);
    if (delta >= DELTA_THRESHOLD) {
      changed += 1;
      sumDelta += delta;
      if (delta > maxDelta) maxDelta = delta;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumLumaA += 0.2126 * a.data[o] + 0.7152 * a.data[o + 1] + 0.0722 * a.data[o + 2];
      sumLumaB += 0.2126 * b.data[o] + 0.7152 * b.data[o + 1] + 0.0722 * b.data[o + 2];
      heat[o] = 255;
      heat[o + 1] = 0;
      heat[o + 2] = 0;
    }
  }
  // WCAG contrast between the mean washed and mean unwashed luminance.
  const lumaA = changed ? sumLumaA / changed : 0;
  const lumaB = changed ? sumLumaB / changed : 0;
  const lum = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const hi = Math.max(lum(lumaA), lum(lumaB));
  const lo = Math.min(lum(lumaA), lum(lumaB));
  const contrast = hi > 0 ? (hi + 0.05) / (lo + 0.05) : 1;

  /**
   * CIE76 colour difference, which is the metric that actually applies here.
   *
   * Luminance contrast is a TEXT-legibility measure and it is close to useless
   * for a coloured wash on a coloured basemap: a green (#2fa84f) fill over tan
   * Oklahoma imagery is plainly visible to the eye while its luma ratio reads
   * 1.02:1, because the two differ in hue and barely at all in brightness.
   * Worse, optimising for luma contrast pushes a design toward a pale, washed
   * tint — exactly the wrong direction. Delta E compares the actual colour, so
   * it rewards the saturated band the category uses.
   */
  const toLab = (r, g, b) => {
    const lin = (c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const R = lin(r);
    const G = lin(g);
    const B = lin(b);
    // sRGB -> XYZ (D65), then XYZ -> Lab.
    const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(X);
    const fy = f(Y);
    const fz = f(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  };
  let sumDeltaE = 0;
  let maxDeltaE = 0;
  if (changed) {
    for (let px = 0; px < total; px += 1) {
      const x = px % width;
      const y = (px / width) | 0;
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
      const o = px * channels;
      const d = Math.max(
        Math.abs(a.data[o] - b.data[o]),
        Math.abs(a.data[o + 1] - b.data[o + 1]),
        Math.abs(a.data[o + 2] - b.data[o + 2]),
      );
      if (d < DELTA_THRESHOLD) continue;
      const labA = toLab(a.data[o], a.data[o + 1], a.data[o + 2]);
      const labB = toLab(b.data[o], b.data[o + 1], b.data[o + 2]);
      const de = Math.hypot(labA[0] - labB[0], labA[1] - labB[1], labA[2] - labB[2]);
      sumDeltaE += de;
      if (de > maxDeltaE) maxDeltaE = de;
    }
  }
  const meanDeltaE = changed ? sumDeltaE / changed : 0;
  await sharp(heat, {
    raw: { width: a.info.width, height: a.info.height, channels },
  })
    .png()
    .toFile(path.join(shotsDir, `diff-${nameA}-vs-${nameB}.png`));
  return {
    width: a.info.width,
    height: a.info.height,
    measuredInset: MEASURE_INSET,
    measuredWindow: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    measuredPixels: measured,
    totalPixels: total,
    changedPixels: changed,
    changedPercent: Number(((changed / Math.max(measured, 1)) * 100).toFixed(3)),
    meanDelta: changed ? Number((sumDelta / changed).toFixed(2)) : 0,
    maxDelta,
    meanLumaOn: Number(lumaA.toFixed(2)),
    meanLumaOff: Number(lumaB.toFixed(2)),
    // Reported, but NOT the gate: it measures brightness, and a wash is a hue.
    contrastRatio: Number(contrast.toFixed(3)),
    meanDeltaE: Number(meanDeltaE.toFixed(2)),
    maxDeltaE: Number(maxDeltaE.toFixed(2)),
    boundingBox:
      maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

// ---------------------------------------------------------------------------

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(redact(message.text()));
});
page.on('pageerror', (error) => consoleErrors.push(redact(error.message)));

console.log(`\nStorm swath QA — ${appUrl}\n`);

try {
  await hookRenderErrors(page);
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => Boolean(window.__godsEyeView?.viewer?.scene),
    { timeout: 120_000 },
  );
  note('viewer is up');

  const regime = await readRegime(page);
  report.regime = regime;
  check(
    'a ground regime is established',
    regime.globeShow !== null,
    regime.hasTileset
      ? 'photorealistic 3D Tiles (globe hidden)'
      : `keyless globe, globe.show=${regime.globeShow}`,
  );

  await stageScene(page);

  const moduleProbe = await resolveLayerModule(page);
  report.layerModule = moduleProbe;
  check(
    'the storm-reports layer module is reachable',
    moduleProbe.found && moduleProbe.hasSetHazard,
    moduleProbe.found
      ? `setHazard=${moduleProbe.hasSetHazard} setDate=${moduleProbe.hasSetDate}`
      : 'no record for storm-reports',
  );
  check(
    'the module exposes both swath toggles',
    moduleProbe.hasReportedSwath && moduleProbe.hasRadarSwath,
    `reported=${moduleProbe.hasReportedSwath} radar=${moduleProbe.hasRadarSwath}`,
  );

  // ---- PROBE 1: are the swaths on at all? ---------------------------------
  const reportedClick = await clickChip(page, 'storm-reports-swath-reported');
  await settle(page, 4);
  const radarClick = await clickChip(page, 'storm-reports-swath-radar');
  await settle(page);

  const state = await readSwathState(page);
  report.chips = { reportedClick, radarClick, state };
  check(
    'the REPORTED chip is present and enabled',
    reportedClick.found && !reportedClick.disabled,
    reportedClick.found ? '' : 'chip not in the DOM',
  );
  check(
    'the RADAR chip is present and enabled',
    radarClick.found && !radarClick.disabled,
    radarClick.found ? '' : 'chip not in the DOM',
  );
  check(
    'both swath toggles read back ON from the layer',
    state.reported === true && state.radar === true,
    `reported=${state.reported} radar=${state.radar}`,
  );

  const swaths = await collectSwaths(page);
  report.swaths = swaths;
  check(
    'swath entities are present and discoverable',
    swaths.total > 0,
    `${swaths.total} found (reported=${swaths.byKind?.reported} radar=${swaths.byKind?.radar}) across ${swaths.dataSourceCount} data source(s)`,
  );
  check(
    'both swath kinds are drawn',
    swaths.byKind?.reported > 0 && swaths.byKind?.radar > 0,
    `reported=${swaths.byKind?.reported} radar=${swaths.byKind?.radar}`,
  );
  // Recorded as evidence, not as a gate: whether `entity.id` is readable
  // varies by build, and the first run of this script read zero on every
  // collection. The discovery path does not depend on it, but the report
  // should keep saying so out loud.
  note(
    `id readability by collection: ${(swaths.readPaths || [])
      .map(
        (p) =>
          `${p.path}: ${p.entities ?? 'n/a'} entities, ${p.readableIds ?? 0} readable ids${p.usable ? '' : ` (${p.why || 'empty'})`}`,
      )
      .join('; ')}`,
  );
  if (swaths.geometry) {
    report.sampleGeometry = swaths.geometry;
    note(`sample geometry: ${JSON.stringify(swaths.geometry)}`);
  }

  // ---- Aim the camera at the storm the swaths actually cover ---------------
  //
  // The cells span far more than the hand-picked target coordinate: the day's
  // radar field runs from the domain edge in California up through Oklahoma,
  // so a camera aimed at one point frames a lot of nothing with the wash
  // clipped at the top of the frame. Framing from the measured extent means
  // the contrast figure below describes the swath and not the composition.
  const aim = swaths.focus || swaths.extent;
  if (aim) {
    const { centerLat, centerLon, west, east, south, north } = aim;
    // Frame the CENTROID at the requested altitude, rather than scaling range
    // to the extent. The day's reports genuinely span Kansas to Texas, so
    // fitting the bounding box parks the camera near 900 km and shrinks the
    // wash to half a percent of the frame — a composition, not a legibility
    // measurement. 40 km over the storm's centroid is the operator's own view.
    const spanKm =
      Math.max(
        Math.abs(north - south),
        Math.abs(east - west) * Math.cos((centerLat * Math.PI) / 180),
        1,
      ) * 111;
    const rangeM = CAMERA_HEIGHT_M;
    note(
      `aim: cell ${swaths.focus?.key || 'n/a'} centre ${centerLat.toFixed(3)}, ${centerLon.toFixed(3)} (swath spans ${south.toFixed(2)}..${north.toFixed(2)} lat, ${west.toFixed(2)}..${east.toFixed(2)} lon)`,
    );
    if (swaths.radarExtent) {
      note(
        `radar field extent: ${swaths.radarExtent.cells} cells, ${swaths.radarExtent.south.toFixed(2)}..${swaths.radarExtent.north.toFixed(2)} lat (the whole ingest domain — not a framing target)`,
      );
    }
    await runVerb(page, 'fly_to_location', {
      latitude: centerLat,
      longitude: centerLon,
      rangeM,
      waitForArrival: true,
    });
    report.camera = report.camera || {};
    report.camera.reframed = {
      lat: centerLat,
      lon: centerLon,
      rangeM: Math.round(rangeM),
      spanKm: Number(spanKm.toFixed(1)),
      basis: swaths.focus?.key
        ? `single drawn cell ${swaths.focus.key}`
        : 'bounding box',
      targetCell: swaths.focus?.key ?? null,
    };
    await settle(page);
    const framed = await cameraHeight(page);
    report.camera.heightAfterFraming = framed;
    note(
      `reframed on the storm centroid ${centerLat.toFixed(2)}, ${centerLon.toFixed(2)} — height ${Math.round(framed || 0)} m`,
    );
    // Assert the FINAL altitude, not just the pre-reframe one. The reframe
    // moved the camera after the staging assertion had already passed, and a
    // silent 900 km would make every contrast figure below describe a view
    // nobody will ever look at.
    check(
      'the reframed camera sits at swath altitude',
      framed != null && framed > 0 && framed <= CAMERA_HEIGHT_M * 2,
      `${Math.round(framed || 0)} m`,
    );
  } else {
    note('no swath bounds available; keeping the original camera framing');
  }

  // ---- PROBE 2: buried, or faint? A difference of two captures ------------
  await captureCanvas(page, 'swaths-on');
  await page.evaluate(() => {
    const record =
      window.__godsEyeView?.dataManager?.layers?.get('storm-reports');
    const layer = record?.module ?? record;
    layer?.setReportedSwath?.(false);
    layer?.setRadarSwath?.(false);
    window.__godsEyeView.requestRender?.();
  });
  await settle(page);
  await captureCanvas(page, 'swaths-off');
  const visible = await diffMetrics('swaths-on', 'swaths-off');
  report.visibility = visible;
  note(
    visible.error
      ? `diff failed: ${visible.error}`
      : `wash footprint ${visible.changedPixels}px (${visible.changedPercent}% of frame), mean Δ${visible.meanDelta}, contrast ${visible.contrastRatio}:1`,
  );

  const buried = visible.error ? false : visible.changedPixels === 0;
  report.diagnosis = buried
    ? 'NOT DRAWN — zero pixels changed with the swaths on. Either the toggles are off, or nothing at all reached the framebuffer.'
    : 'DRAWN — the swaths change the frame.';

  // ---- Is the result repeatable, or was that one lucky frame? --------------
  //
  // Both halves of this comparison are captured back to back, with their own
  // baseline. The first version compared the re-enabled wash against the
  // ORIGINAL off-frame, several seconds and one camera flight earlier, and
  // read 129px where the real answer was 2,991 — a measurement of camera drift
  // wearing a measurement's clothes. Diffing on-against-off with the two
  // captures adjacent removes the drift term entirely.
  if (!buried) {
    await page.evaluate(() => {
      const record =
        window.__godsEyeView?.dataManager?.layers?.get('storm-reports');
      const layer = record?.module ?? record;
      layer?.setReportedSwath?.(true);
      layer?.setRadarSwath?.(true);
    });
    await settle(page, 8);
    await captureCanvas(page, 'cycle-on');
    await page.evaluate(() => {
      const record =
        window.__godsEyeView?.dataManager?.layers?.get('storm-reports');
      const layer = record?.module ?? record;
      layer?.setReportedSwath?.(false);
      layer?.setRadarSwath?.(false);
    });
    await settle(page, 8);
    await captureCanvas(page, 'cycle-off');
    const repeat = await diffMetrics('cycle-on', 'cycle-off');
    report.repeatable = repeat;
    check(
      'the wash is repeatable across a toggle cycle',
      repeat.error ? false : repeat.changedPixels > 0,
      repeat.error
        ? repeat.error
        : `${repeat.changedPixels}px vs ${report.visibility?.changedPixels}px first pass`,
    );
    // Leave the swaths ON so the final state matches the layer's intent.
    await page.evaluate(() => {
      const record =
        window.__godsEyeView?.dataManager?.layers?.get('storm-reports');
      const layer = record?.module ?? record;
      layer?.setReportedSwath?.(true);
      layer?.setRadarSwath?.(true);
    });
    await settle(page, 8);
  }

  // ---- How legible is it? Contrast is the number that decides. -----------
  if (!report.visibility?.error) {
    /**
     * The legibility gate, on Delta E.
     *
     * Thresholds, not claims: CIE76 under ~2.3 is the classic "just noticeable
     * difference", and by ~10 a colour difference is unmistakable at a glance.
     * The bar is set at 8 — clearly a deliberate mark rather than a tint that
     * has to be hunted for — because a roofer is scanning a map for the worst
     * streets, not studying it.
     *
     * The luminance figure is printed alongside for completeness and is
     * explicitly not the gate, for the reason above.
     */
    const LEGIBLE_DELTA_E = Number(process.env.QA_SWATH_MIN_DELTA_E || 8);
    check(
      `the wash is legible against the basemap (mean ΔE >= ${LEGIBLE_DELTA_E})`,
      report.visibility.meanDeltaE >= LEGIBLE_DELTA_E,
      `mean ΔE ${report.visibility.meanDeltaE} (max ${report.visibility.maxDeltaE}); luminance ratio ${report.visibility.contrastRatio}:1, which is not the right instrument for a coloured wash`,
    );
    note(
      report.visibility.meanDeltaE < LEGIBLE_DELTA_E
        ? 'PRESENT BUT FAINT — Phase F legibility work (banded polygons, band-ramped alpha, hard edge), NOT an occlusion bug.'
        : 'LEGIBLE — the wash reads as a deliberate mark.',
    );
  }

  // ---- REPORTED vs RADAR, so a regression cannot hide in the other layer --
  const renderErrors = await readRenderErrors(page);
  report.renderErrors = renderErrors;
  report.consoleErrors = consoleErrors.slice(0, 40);
  check(
    'Cesium raised no render errors',
    renderErrors.length === 0,
    renderErrors.length ? redact(renderErrors[0]).slice(0, 160) : '',
  );
} catch (error) {
  failures.push(`harness error: ${error?.message || error}`);
  console.error(`\n  [FAIL] harness error — ${error?.stack || error}\n`);
  if (!keepGoing) {
    report.notes = notes;
    fs.writeFileSync(
      path.join(shotsDir, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    await browser.close();
    process.exit(1);
  }
}

report.notes = notes;
report.failures = failures;
fs.writeFileSync(
  path.join(shotsDir, 'report.json'),
  JSON.stringify(report, null, 2),
);

console.log(
  `\n${failures.length ? `${failures.length} FAILURE(S)` : 'ALL CHECKS PASSED'} — ${redact(
    JSON.stringify(report.diagnosis || report.notes),
  )}`,
);
console.log(`artifacts: ${path.relative(repoRoot, shotsDir)}\n`);

await browser.close();
process.exit(failures.length ? 1 : 0);
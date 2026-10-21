# The completion guard, and the rest of Path B

**The complaint being answered:** *"What can you do to make sure from now on that everything is completed to 100% before you stop? In this repo, whatever it is, we need to do that."*

**The answer: three files, in the house style, so that "stopped early" is a
failed check rather than a judgement call.**

The research that made this concrete (all of it read from the working tree):

- **There is NO tracked agent instruction file.** `pinokio/AGENTS.md` exists but
  is untracked, excluded via `.git/info/exclude:11-18`, and is the generic
  Pinokio launcher guide — not repo house style. `docs/MAINTAINER_WORKFLOW.md:13`
  says outright that `AGENTS.md` "cannot replace trusted instructions".
- **The house guard pattern is `scripts/check-import-directions.mjs`** (261
  lines): an exported pure `checkImportDirections(root)`; enumeration by
  `git ls-files -z --cached --others --exclude-standard` (`:53-69`); errors
  collected into a `Set` of `` `${file}: ${message}` `` (`:74`); failure as
  one aggregate `throw new Error([...errors].join('\n'))` (`:243`); success
  returns a counts object (`:244`); a CLI self-invocation guard (`:247-250`)
  that prints JSON on success and the message to stderr with
  `process.exitCode = 1` on failure. It has a test at
  `src/tooling/importDirections.test.mjs`, which `npm test` auto-discovers
  (`UNIT_TEST_ROOTS = ['src','server','scripts','apps']`,
  `scripts/run-unit-tests.mjs:36-41`).
- **The only durable wiring is `package.json` + `.github/workflows/ci.yml`.**
  No `core.hooksPath`, no husky, no lefthook, no pre-commit config. The
  `verify` job runs `doctor` → `format:check` → `check:boundaries` →
  `layer-token:check` (PR only) → `npm test` → `npm run build` (ci.yml:1-156).
- **The repo's own state vocabulary** is `docs/KNOWN-ISSUES.md`: a `Status:`
  line per entry, with values like `Open (workaround available)` and
  `Closed as fixed on \`main\``. No tables, no checkboxes.
- **The machine-readable registry precedent** is
  `src/data/layerStateTokenReservations.json` — a flat JSON array, one entry
  per line — and `scripts/package-boundaries.json`, an object keyed by group.

---

## PART 1 — the guard

### 1.1 `scripts/task-registry.json` — the registry

Flat JSON, one task per line, in the `KNOWN-ISSUES.md` status vocabulary.

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "B0.1",
      "title": "the showStreets parameter shadows the module state object",
      "status": "done",
      "commit": "0971421a",
      "files": ["apps/hail-desk/src/main.js"],
      "gate": "the realised-damage table renders real numbers"
    }
  ]
}
```

`status` is `open` or `done`. `commit` is filled in when the task lands.

### 1.2 `scripts/check-task-completion.mjs` — the checker

**Exactly** the `check-import-directions.mjs` shape, so a maintainer reads it
without a word of explanation:

- exports `checkTaskCompletion(root, { allowOpen = false })`;
- enumerates with `git ls-files -z --cached --others --exclude-standard`
  (so a task's files are checked whether they are tracked or not);
- for every task with `status: "open"`, an error line
  `` `${id}: ${title} - ${files.join(', ')}` ``;
- for every task with `status: "done"`, every file in `files` must EXIST — a
  task that claims to be done but points at a file that was renamed is a lie
  the checker catches;
- every task must have a non-empty `id`, `title`, `files` and `gate` — the
  registry cannot rot into a list of names;
- `commit` must be present on a done task and absent on an open one;
- failure is one aggregate `throw new Error([...errors].join('\n'))`;
- success returns `{ tasks, done, open }`;
- the CLI prints `JSON.stringify(result)` on success, and on failure prints
  `error.message` to stderr and sets `process.exitCode = 1`.

**`--allow-open`** is the local escape hatch: it reports the open tasks and
exits 0, for a branch that is mid-flight.

### 1.3 `src/tooling/taskCompletion.test.mjs` — the tests

Auto-discovered by `npm test`. Three cases:

1. the checker **fails** on a registry with an open task, and the message
   names the task and its files;
2. the checker **passes** on a registry where every task is done and every
   file exists;
3. the checker **fails** on a done task whose file does not exist — the
   "it says it is done but the code is not there" case.

And one more, against the REAL registry:

4. **`docs/PATH-B-TASKS.json` is well-formed** — every task has an id, a
   title, a status in the vocabulary, at least one file, and a gate, and the
   ids are unique. The registry cannot quietly become a list of intentions.

### 1.4 `package.json` and CI

```json
"check:tasks": "node scripts/check-task-completion.mjs"
```

and in `.github/workflows/ci.yml`, the `verify` job, after
`npm run check:boundaries`:

```yaml
- name: Check the task registry
  run: npm run check:tasks -- --allow-open
```

**strict on `main`, lenient on a PR.** A PR that is mid-flight carries open
tasks and must not be blocked by them — but `main` must never carry one, so
the step runs strict when the ref is `main`:

```yaml
- name: Check the task registry
  run: |
    if [ "${{ github.ref }}" = "refs/heads/main" ]; then
      npm run check:tasks
    else
      npm run check:tasks -- --allow-open
    fi
```

### 1.5 `AGENTS.md` — the standing rule, tracked

**This is the file that would have stopped me.** A tracked, repo-root
`AGENTS.md` (there is none today) with the rules in the imperative:

> ## Draining the registry
>
> Work in this repo is registered in `scripts/task-registry.json`. Before you
> stop:
>
> 1. Every task you were asked to do is `status: "done"` with the commit
>    that landed it.
> 2. `npm run check:tasks` passes.
> 3. `npm test` is green.
> 4. `npm run build` succeeds.
>
> If a task genuinely cannot be finished, it stays `open`, and you say so
> **in your final message**, with the reason. You do not close it quietly.
> An open task that is not reported is the only failure this rule permits.

And a second section, because the failure I actually made was procedural:

> ## Do not stop mid-way through a workstream
>
> The work is registered in waves. A wave is finished when every task in it
> is `done`. Do not stop halfway through a wave to report progress — finish
> the wave, then report. The exception is a task that is blocked on
> something outside the repo, which is registered as `open` with the reason
> in its title, and reported.

### 1.6 Wiring the two together

`docs/MAINTAINER_WORKFLOW.md:86-91` has a check table — a new row
`| Task registry | \`npm run check:tasks\` |` — and `CONTRIBUTING.md:131-139`
gets the same command. `docs/KNOWN-ISSUES.md` gets a pointer, so the two
documents agree about where outstanding work lives.

---

## PART 2 — the rest of Path B, exactly

Everything below is specified to the point of mechanical. The research for
each is in this session's transcripts; the targets are re-verified against
HEAD `762874b6`.

### Wave 4 — the swath finishes (three tasks, one file)

**B1.4 — the bands must TILE.**
`drawSwathBand` (index.js:1988-2071) currently groups cells by band and
contours EACH GROUP at the product floor, so the boundary between two bands is
interpolated twice at different sub-cell positions — a seam up to ~400 m.

Replace the per-band grouping with **ascending levels over the whole field**:

- `contourRings(cells, isoValue, deg)` (model.js:1416) returns
  `Array<{outer: Array<{lat,lon}>, holes: Array<Array<{lat,lon}>>}>` — one
  entry per outer ring, in the **sample-centred** frame (`y*deg + deg/2`).
  Outers are NOT sorted; holes ARE sorted by |area| desc.
- There is **no degree-space point-in-ring helper** — `pointInRingGrid`
  (model.js:1706) is private and works in grid coords. Add a local
  `pointInRingDegrees(point, ring)` next to `polygonHierarchyFor`
  (index.js:1821-1837) — the standard ray cast, ring points as `{lat, lon}`.
- For each band ascending by floor: `outer = contourRings(field, band.floor)`;
  `holes` = that ring's own pockets **plus** the hotter band's contours whose
  first vertex is inside the outer.
- `polygonHierarchyFor` takes holes as a flat `Cartesian3[][]` — so the hotter
  band's own pockets are dropped. If that shows, nest `PolygonHierarchy`
  holes instead (perimeters/index.js:317-323 does that).
- **Exclude the implausible cells** (≥100 mm) from the annulus set; they are
  their own grey group today (index.js:2148).
- RADAR floors ascending: `[25.4, 38.1, 50.8, 69.85, 88.9]` (index.js:276-307).

**B1.5 — the third LOD tier.**
`SWATH_FINE_MAX_ALTITUDE_M` (index.js:204) 12 000 → **60 000**; new
`SWATH_MID_MAX_ALTITUDE_M = 600_000` beside `:207`. Replace
`useFineRadarField()` (index.js:1947-1955) with `radarTier()` returning
`'fine' | 'mid' | 'coarse'`; `onCameraSettled()` (1964-1974) and
`renderSwaths()` (2082-2184) branch on it, and `prospectReadout()` (1752)
takes its `stepDeg` from it. `GRID_DEG_MID = 0.05` beside `GRID_DEG_FINE`
(model.js:26). A new exported pure `downsampleMaxCells(cells, factor = 5)`
beside `radarSwathCells` (model.js:1314) that pools by
`floor(i/5), floor(j/5)` and keeps the max, emitting
`{key:'i:j', i, j, peakMm, implausible}` — the shape the consumers read
(`drawSwathBand` reads `cell.peakMm ?? cell.peak`, `contourRings` reads
`cell.v ?? cell.peakMm`, `prospectSwathCells` reads `implausible/peakMm/i/j`).

**`swathAlphaCeiling()` (index.js:1936-1944) must be re-based**: with 204
raised to 60 000 the ramp span collapses to zero.

**Tests that pin the tiers and will need updating** (layerLifecycle.test.mjs):
`:3207-3240` (40 000 m must become >600 000 m, or the assertion becomes
`>0.02 && <0.1` for the mid tier), `:3242-3266` (25 000 m, same),
`:3268-3293` (the alpha comparison at 3 000 vs 60 000 m), `:3451-3500` and
`:3502-3530` (both at 40 000 m, and both currently assert the COARSE tier).

**B1.6 — the REPORTED swath.**
`reportedSwathCells` (model.js:1098-1128) returns
`{key, i, j, peak: INCHES, count, lat, lon, bounds, band}` — worst first.
`contourRings` reads `cell.v ?? cell.peakMm` and **never** `peak`, so it
cannot contour them as they are — but `drawSwathBand` already rewrites to
`{i, j, v: cell.peakMm ?? cell.peak ?? 0}` (index.js:1999), so `v` is inches
for the REPORTED path. The change is the same as B1.4: contour the **union**
once per level with inch floors from `HAIL_BANDS` (model.js:81-124). A cell
exactly at its floor contours to zero area and is dropped (model.js:1643-1650),
so it is drawn by the lower band — which is correct tiling.

### Wave 5 — the globe's remaining chrome (four tasks)

**B1.0.4** the celestial ring must hug the globe, not the porthole: add
`frameRadius: Math.hypot(w*0.5, h*0.5)` to `getKeyholeGeometry`
(celestialRing.js:72-85), return it from `projectEarthDiscToViewport`
(:280-288), use it in `isFullGlobeInsideKeyhole` (:182-210) and
`focusFullGlobe` (:534-538), and change the ring radius (:776) to
`Math.min(disc.frameRadius - RING_INSET_PX, disc.earthRadius + Math.max(38, disc.earthRadius * 0.12))`.

**B1.0.5** `src/ui/styles/foundation.css`: delete `#scope-mask` (:136-151);
`#cockpit-cloud-effects` `clip-path: circle(...)` (:176-196) → `none`;
`.celestial-ring-overlay` `z-index: 2` → `1`.

**B1.0.6** the HUD becomes one telemetry strip. It **cannot be deleted**:
`src/cyberSonar.js:493,513` gate the Cyber sweep on
`hud.classList.contains('active')`, `src/ui/cyberSonarControls.js:23` reads
it, `src/ui/cockpitLayout.js:277` anchors on `.hud-top-right`.

**B1.0.7** the rails' collapse policy is the real dependency, not the
obstacle list: `src/ui/leftPanelRail.js:41-48,236-242` and
`src/ui/rightPanelRail.js:84-113,285-294`. Stub `readHud` at
`src/ui/panelChrome.js:69-72` to `{visible:false, variant:'none'}` and the
rails fall into their no-HUD branch. Remove the 16 `#intel-hud .hud-*`
selectors from `src/ui/panelLayoutController.js:19-26,49-56` and the two
`MutationObserver`s (:261-285, :362-396).

### Wave 6 — the desk becomes a tool (four tasks)

**B3.2** one drill panel with a back stack, and a grid layout.
`apps/hail-desk/index.html`: replace the three sibling sections
`#detail` (:79), `#tracts` (:81), `#streets` (:83) with ONE
`<section class="detail" id="detail" hidden>`. `main.js`: `el.detail` is the
only panel; a stack array holds `{level, title, render}`; `onCityClick`
(:220-371) pushes a city view, `showTracts` (:381-466) and `showStreets`
(:489-724) push theirs; the two `document.getElementById('tracts'|'streets')`
calls (:382, :490) go; `showStreets` must write only if its view is still on
top after the `await` at :505; fix the duplicated `panel.append(note)` at
:397/:399. The layout becomes a grid — rail / map / list.

**B3.3** the control rail, ported from `src/ui/layerPanel.js` (the desk
cannot import `src/ui/` — `scripts/check-import-directions.mjs:23` classes it
`renderer`). The contracts to copy:

- **Toggle row** (layerPanel.js:243-309): `div.data-toggle-row[data-layer-id]`
  › `div.data-toggle-top` › (`div.data-toggle-left` › `span.data-icon` +
  `span.data-name`) + (`div.data-toggle-right` › `span.data-count` +
  `button.data-toggle-btn`); then `div.data-toggle-meta`. `aria-disabled` +
  `aria-busy` instead of native `disabled` (:275-296 — native `disabled`
  evicts keyboard focus in Chromium).
- **Chips** (chipGroup.js:9 `syncChipGroup(container, chips, {before})`):
  `button[data-chip-id].data-toggle-chip.chip-<state>[.active]`, `aria-pressed`,
  `aria-busy`, `title`. The handler is DELEGATED on the container and
  re-reads the live descriptor by `dataset.chipId` (layerPanel.js:325-338).
- **Ranked list** (rowList.js:8 `syncRowList(container, {ariaLabel, items})`):
  `ol.data-row-list` › `li[data-list-item-id]` › `button.data-row-list-item`
  › `span.data-row-list-lead` + `span.data-row-list-text`; the current item
  scrolls into view (:65-73). The desk's hand-rolled `renderRankedList`
  (main.js:149-177) should be replaced by `syncRowList`.

**B3.7** lat/lon for the city and county rows.
`scripts/build-hail-desk-data.mjs` already reads
`src/data/local_data/us_census_places/places.json` (:62) and computes the
rings' bounds (:196-217), so the centroid is free — add `lat`/`lon` and a bbox
to each row (:355-370). ~330 KB raw, ~120 KB gzipped for 32,607 rows.

### Wave 7 — the 2D map and its tiles (four tasks)

**B4.1** the tile format: our own `GEVS` v1. 32-byte header (magic `GEVS`,
version, extentShift=12, featureCount u16, geometryBytes u32, zoom u8, 3
reserved, westLon f64, southLat f64) then per feature: pointCount u16,
edgeIndex u32, x0 i32, y0 i32 (tile-local, y DOWN), varint zigzag deltas.
~20 B per feature on the measured Douglas County file (17,205 records, 245,363
points, avg 14.26 pts/record) — about 1.2 MB per county per zoom, where
GeoJSON is 4–6× larger and needs `JSON.parse` on the main thread per tile.

**B4.1b** the tile maths: `src/layers/streetLevel/tileMath.js` exports
`wrapLon`, `lonToTileX`, `latToTileY`, `tileBounds`, `normalizeBbox`,
`tilesForBbox`, `tileLocalToLonLat`, `coverageZoomForHeight`,
`overviewZoomForHeight`. **`tileXAt`/`tileYAt` are NOT exported** and neither
are the inverses `tileXToLon`/`tileYToLat` — export them, plus a new
`lonLatToTileLocal(lon, lat, extent, x, y, z)`, so the server and the client
share ONE implementation. The file has zero imports: pure, Cesium-free,
DOM-free, Node-free, importable from a Node route AND the desk app.

**B4.2** the route `GET /api/desk/tiles/{state}/{county}/{z}/{x}/{y}` in
`server/desk/server.mjs`, between the streets route (ends :86) and the
static handler (:88) — and it must NEVER fall through, because the SPA
fallback (:105-111) answers index.html with a **200** for any unmatched path.
`204` for an empty tile, `X-Gev-Cache: memory|disk|index`,
`Cache-Control: public, max-age=3600`, the same-site gate and a 600/min rate
limiter, all copied from `server/providers/mapillary/routes.js:48-53,84-95`.
Disk cache `.gev-cache/desk-tiles/2024/<state><county>/<z>/<x>-<y>.gvt` — the
TIGER vintage is in the path, so a new vintage is a new tree.

**B4.2b** the parse-once index — **the tile source must be the RAW EDGES
records, not `countyEdges()`**. `countyEdges` (tigerStreets.js:176-263)
returns one object per SIDE and drops every edge whose side has no address
range (:241) — on Douglas County that is 2,468 of 6,671 named edges, so 37%
of the centrelines, and a map built from it has holes. Split it: export
`countyEdgeRecords(state, county)` (the parse half, :178-224, returning
`{rows, shapes, zipPath, zipMtime}`) and keep `countyEdges()` on top. Export
`countyEdgesPath` (:90-112) so the tile module can key on the zip's mtime
(`fs.statSync(file)` at :95, `stat.mtimeMs` at :100). Then: parse the county
ONCE into `{lines: [{points: Float64Array, bbox}], byZoom: Map<z, Map<"x-y",
Uint32Array>>}`, **deduping by the `points` array IDENTITY** exactly as
`hailStreets.js:166-180` does (L and R share one array object, so identity
dedup collapses them), clipping each line to the tile box, memory-only with an
LRU over counties, invalidated by the zip's mtime rather than by a clock.

**B4.3** the client map: `apps/hail-desk/src/map/{viewport,basemap,streets,
vectors,swath,map}.js`. Basemap
`https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
— **z, then y, then x** — with `img.crossOrigin = 'anonymous'` set BEFORE
`img.src`, or the canvas is tainted and `getImageData` throws. Attribution
inlined: `src/maps/imagery.js:1` imports Cesium, so the desk cannot import
it. OSM is **rejected**: OSMF Tile Usage Policy §4 forbids offline use and
§3.1 requires an identifying User-Agent, and a browser cannot set its own —
verified live, `curl/8.0` and `Mozilla/5.0` both get `x-blocked: Access
denied`. The swath rings come from `contourRings` (model.js:1416), which the
desk MAY import (model.js's only import is `src/data/stormCrossReference.js`,
which has zero imports and no globals); cells must be mapped to `{i, j, v}`
because `contourRings` never reads `maxMm`.

**B4.4** dev/prod parity: `apps/hail-desk/vite.config.js` has **no
`plugins` key**, so `npm run dev:desk` has no API at all and
`/api/desk/streets` 404s in dev; `tigerStreetsPlugin()` (tigerStreets.js:299)
exists and is referenced **nowhere**. Extract one handler module
`server/providers/deskApi.js` exporting `deskApiPlugin()` (registering
`/api/desk/streets` AND `/api/desk/tiles` in `configureServer`) and add
`plugins: [deskApiPlugin()]` to the desk's vite config, so dev and prod call
the SAME `fetchStreetTile`/`streetsPayload` and cannot drift.

### Wave 8 — the per-storm artifact

The gallery's renderer (B2.3) and the desk's painter (Wave 7) are the seed:
**the same painter, static PNG.** The thing that competes with a $229 map.

---

## Order, and the rule that governs it

| wave | tasks | gate |
|---|---|---|
| 0 | the guard (Part 1) | `npm run check:tasks` exists and fails on an open task |
| 4 | B1.4, B1.5, B1.6 | the swath tiles, and reads at every altitude |
| 5 | B1.0.4–B1.0.7 | no porthole left in the code |
| 6 | B3.2, B3.3, B3.7 | the desk is a rail, a map and a list |
| 7 | B4.1–B4.4 | the map draws streets |
| 8 | the per-storm artifact | a PNG per storm |

**A wave is finished when every task in it is `done` in the registry.** Not
half a wave, and not a wave with one task left open to be picked up later.

## The one decision I am not making for you

Whether `npm run check:tasks` should be **strict in CI on a PR** (which
blocks a WIP branch) or **strict only on `main`** (which lets a WIP branch
through but never lets `main` carry an open task). The plan above assumes the
second, because a guard that blocks your own work-in-progress gets disabled
within a week, and a guard that gets disabled guards nothing.

# Path B — final execution registry

**Status:** every decision is now resolved. Nothing here needs a judgement call.
**Branch:** `contrib/storm-scope-20261015`. Nothing pushed.
**North star:** *"We're not doing anything else until this shit on the desktop makes sense and is usable ASAP."* Desktop first. Visual pass first.

**Decisions taken (no further questions):**
- The county surface (`storm-expected`) is **cut as the default**. The swath becomes the default surface; the county surface stays one chip away. The ranking list survives — it lives on `storm-observed` (`src/layers/hailwind/index.js:634-658`).
- The **cockpit aesthetic is gone**. Full-bleed map. The HUD is **kept but reduced to one telemetry strip** — it is load-bearing (`src/cyberSonar.js:493,513` gate the Cyber sonar on it; `src/ui/cockpitLayout.js:277` anchors on it).
- Swath ramp: **5 discrete bands, violet → magenta → white-hot**, edge in the next-hotter stop.
- 2D basemap: **Esri World Imagery online + our own Census geometry as the no-signal floor.** OSM is disqualified (see §4).
- Desk layout: **rail / map / ranked list**, one drill panel at a time, windowed table.

---

## WAVE 0 — the two live bugs. Gates everything.

| id | change | files | gate |
|---|---|---|---|
| **B0.1** | `showStreets(state, county, day, tract)` — the parameter **shadows the module `state` object**, so `state.femaIndex` (main.js:470) is `undefined` and `withDamage = damaged.filter(z => z.households > 0)` (main.js:564) is **always empty** — the whole FEMA damage table can never render. Rename the parameter to `stateCode` (3 uses) and read the module object at :470. The globe made this exact mistake and fixed it identically (`src/layers/hailwind/index.js:1399-1403`). | `apps/hail-desk/src/main.js:440,446,447,452,470` | the ZIP-damage table renders real numbers |
| **B0.2** | `setRadarSwath(false)` sets `_radarSwath = []` but never calls `render()`, so the polygons stay on screen. Invisible only because RADAR is off by default — and **B1.1 turns it on**. Tail becomes `else { _radarSwath = []; render(); publish(); notifyRowControls(); }` | `src/layers/stormReports/index.js:3709-3720` | turning RADAR off removes the polygons |

**Also in the same file:** the storm table has **10 `<th>` and 9 `<td>`** (main.js:245-271 vs 284-324). Split the one button cell into two — `tractCell` and `streetCell` — so 8 + 2 = 10.

---

## WAVE 1 — the globe's visual system

### 1a. Full-bleed (the porthole goes)

| id | change | files |
|---|---|---|
| **B1.0.1** | Scope mask **off by default**: `let _enabled = true` → `false` in `src/scopeMask.js:104`; `_resetScopeMaskForTest()` (`:564`) likewise; drop `active` / `aria-pressed="true"` on the toggle in `src/ui/templates/display-controls.html:116`; add `scopeEnabled: false` to `src/ui/visualPresets.js:67` and the matching branch in `src/ui/visualSettings.js:902-907`. Keep `installScopeMask` (`src/app/tools.js:105`) so the toggle still works — `draw()` early-outs (`:373-382`) and an off mask costs one clear then nothing. **Leave `src/sharelink.js:217` at `true`** — it is the fallback for links predating `sc`. | `src/scopeMask.js:104,564`; `src/ui/templates/display-controls.html:116`; `src/ui/visualPresets.js:67`; `src/ui/visualSettings.js:902-907` |
| **B1.0.2** | **Keyhole label fade off**: `KEYHOLE_OUTSIDE_OPACITY_DEFAULT` 0.01 → 1 and `KEYHOLE_LABEL_FEATHER_RATIO` 0.07 → 0 in `src/celestialRing.js:29,15`. Then `keyholeLabelAlphaFromGeometry` (`:101-119`) returns 1 everywhere. Knock-on: `src/data/detectionPolicy.js:46` `AIRCRAFT_BRACKET_FLOOR_ANCHOR` 0.01 → 1 (pinned by `src/reasonableDefaults.test.mjs:188`). **Better: gate the fade on a `keyholeEnabled` flag rather than changing the constants**, so the `ko` slider keeps its meaning (`src/ui/visualSettings.js:571-596`). | `src/celestialRing.js:15,29`; `src/data/detectionPolicy.js:46` |
| **B1.0.3** | `src/overlays/worldOverlay.js` — delete the `entry.edgeFade === 'keyhole'` branch in `paintEntryItem` (`:2464-2480`); `record.candidate.keyholeAlpha` (`:2083-2088`) becomes 1. Keep the `_keyhole` geometry cache (`:2631-2645`) — the celestial ring still uses it. | `src/overlays/worldOverlay.js:2464-2480, 2083-2088` |
| **B1.0.4** | The celestial ring must hug the globe, not the porthole: add `frameRadius: Math.hypot(w*0.5, h*0.5)` to `getKeyholeGeometry` (`src/celestialRing.js:72-85`) and return it from `projectEarthDiscToViewport` (`:280-288`); `isFullGlobeInsideKeyhole` (`:182-210`) compares against `frameRadius`; the ring radius (`:776`) becomes `Math.min(disc.frameRadius - RING_INSET_PX, disc.earthRadius + Math.max(38, disc.earthRadius * 0.12))`; `focusFullGlobe` (`:534-538`) uses `frameRadius`; re-tune `FULL_GLOBE_RADIUS_RATIO` (`:35`). | `src/celestialRing.js:35,72-85,182-210,280-288,534-538,776` |
| **B1.0.5** | `src/ui/styles/foundation.css` — delete `#scope-mask` (`:136-151`); `#cockpit-cloud-effects` `clip-path: circle(...)` (`:176-196`) → `none`; `.celestial-ring-overlay` `z-index: 2` → `1` and drop the stale scope-mask comment (`:198-223`). Nothing else assumes the letterbox — `#cesiumContainer` (`:106-112`) and `#world-overlay-root` (`:118-134`) are already `inset: 0`. | `src/ui/styles/foundation.css:136-151,176-196,198-223` |
| **B1.0.6** | **The HUD becomes one strip.** Keep `#intel-hud` but show only the bottom-left telemetry line (MGRS / lat-lon / ALT / GSD). The HUD is load-bearing — `src/cyberSonar.js:493,513` gate the Cyber sonar on `hud.classList.contains('active')`, `src/ui/cyberSonarControls.js:23` reads it, `src/ui/cockpitLayout.js:277` anchors the Cockpit utility strip on `.hud-top-right`. **Deleting the HUD would break**: `src/hud.js`, `src/ui/composition.js:13,76`, `src/ui/applicationShell.js` (11 refs), `src/ui/visualSettings.js:169,182,272`, `src/ui/panelChrome.js:42,50,69,82`, `src/ui/panelLayoutController.js` (all), `src/ui/cockpitLayout.js:277`, `src/cyberSonar.js:493,513`, `src/ui/cyberSonarControls.js:23`, `src/ui/templates/hud-loading.html:2`, `src/voice/actionSchemas.js:1,286`, `src/hudLayouts.js`, `src/hudLayoutPolicy.js`, CSS in 7 files, and 10 test files. **A reduced HUD touches one file plus CSS.** | `src/hud.js`, `src/ui/styles/overlays.css` |
| **B1.0.7** | The rails' **collapse policy** is the real dependency, not the obstacle list: `src/ui/leftPanelRail.js:41-48` (un-collapse unless HUD is tactical), `:236-242` (`autoCollapseIndices` gated on `hud.visible`; `collapseLaterPanels: shouldFocus && hud.variant === 'tactical'`), `src/ui/rightPanelRail.js:84-91,94-113,285-294`. Stub `readHud` at `src/ui/panelChrome.js:69-72` to `{visible:false, variant:'none'}` and the rails fall into their no-HUD branch: no auto-collapse, no `layout-exclusive`, everything expanded. Remove the 16 `#intel-hud .hud-*` selectors from `src/ui/panelLayoutController.js:19-26,49-56` and the two `MutationObserver`s (`:261-268,362-368`) and two `transitionend` handlers (`:271-285,378-396`). | `src/ui/panelChrome.js:69-72`; `src/ui/panelLayoutController.js:19-26,49-56,261-285,362-396`; `src/ui/leftPanelRail.js:41-48,236-242`; `src/ui/rightPanelRail.js:84-113,285-294` |

### 1b. The swath

| id | change | files |
|---|---|---|
| **B1.1** | RADAR on by default, **conditionally**: `let _showRadarSwath = false;` → `let _showRadarSwath = Boolean(radarSource);` (`radarSource` is a factory arg, `:456`). This is exactly "off when there is no source", satisfying `src/layers/stormReports/layerLifecycle.test.mjs:3126-3135`. Update the test at `:1138-1139` (it asserts "off until asked for" on a layer that **has** a source). | `src/layers/stormReports/index.js:550`; `src/layers/stormReports/layerLifecycle.test.mjs:1138-1139` |
| **B1.2** | **The ramp: 5 stops, violet → magenta → white-hot**, on the `HAIL_BANDS` inch chart so both swaths share one scale: `#6d28d9` (1.0–1.5") `#9333ea` (1.5–2.0") `#c026d3` (2.0–2.75") `#e879f9` (2.75–3.5") `#fdf4ff` (≥3.5"). **Why this lane**: the report pins own green/amber/orange/red (`model.js:107,115,122`) — our current ramp is **byte-identical** to them, which is a real collision; PROSPECT owns blue/cyan (`#f0abfc`→`#a5f3fc` to clear it). Competitors that overlay satellite (Hail Recon: 10 levels in ¼"; HailCheck: 6 bands; DTN: ¼" contours; NOAA SPC: filled contours) all use **discrete** bands — only the dark-native animated one (AniSwath) uses a gradient. | `src/layers/stormReports/index.js:248-252`; `src/layers/stormReports/model.js:65` |
| **B1.3** | **The edge carries the hue.** `addSwathBand(id, hierarchy, color, alpha, outlineColor = color, outlineAlpha = SWATH_EDGE_ALPHA)` — `:1814-1815` uses `outlineColor` instead of re-using the fill. Call sites `:1954-1959` and `:1979-1984` pass `group.band.outline`/`outlineAlpha`; the RADAR `bandFor` (`:2065-2092`) carries them from `chosen`. Each band is outlined in the **next-hotter** stop, the top band in `#ffffff`, alpha 1.0. Cesium's `polygon.outline` is a fixed 1 px hairline (`outlineWidth` does not widen it — `scripts/qa-storm-swath.mjs:1331`), so hue must carry it. **No glow** — a separate polyline entity would share the `storm-swath:` id prefix and break `swathEntities()` in 8+ tests. | `src/layers/stormReports/index.js:1801-1821,1954-1959,1979-1984,2065-2092`; `src/layers/stormReports/model.js:107,115,122`; `src/layers/stormReports/layerLifecycle.test.mjs:1290-1297` (3 bands → 5) |
| **B1.4** | **The bands must TILE.** Real defect: every band is contoured at the *product* floor 25.4 mm (`:262`, `:1937`), and `contourRings` reads the other bands' cells as `0` (`model.js:1436`) — so each band is a blob with holes, and **the shared boundary between two bands is interpolated twice at different sub-cell positions** (seam up to ~0.4 of a 1 km cell ≈ 400 m). Fix: contour the **full** field once per iso level and build each band as an **annulus** — `outer = contourRings(allCells, F_k)`, `holes = contourRings(allCells, F_{k+1})` filtered to rings inside the outer. | `src/layers/stormReports/index.js:1910-1989, 2003-2098` |
| **B1.5** | **The third LOD tier.** The blocky band is **12–100 km, not 100–600 km** (a 0.25° cell is 27.8 km; at 1080 px / 60° fovy it is 24% of the frame at 100 km and 4% at 600 km). Three tiers: fine (0.01°) to `SWATH_FINE_MAX_ALTITUDE_M` **12 000 → 60 000**; a **mid tier at 0.05°** (a 5×5 max-downsample of the fine field — max is right, the field value is already a per-cell maximum) to a new `SWATH_MID_MAX_ALTITUDE_M = 600_000`; coarse (0.25°) above. A 5×5 downsample takes a 74 000-cell day to ~2 960, inside `SWATH_MAX_RINGS` (3000). **The mid tier is unavailable on multi-day windows** — say so in the legend rather than pretending. | `src/layers/stormReports/index.js:204,1868-1877,1881,2000-2002`; new `GRID_DEG_MID` + `downsampleSwathCells` in `src/layers/stormReports/model.js` |
| **B1.6** | **REPORTED becomes smooth.** The blocker is **not units** — `contourRings` compares `cell.v` to `isoValue` in the same units and `drawSwathBand` already pushes `v: cell.peakMm ?? cell.peak ?? 0` (`:1921`), so an inch floor is legal. The blocker is the file's own note at `:1925-1934`: contouring a **per-band group** at that band's floor collapses the bands. Fix: contour the **union** once per level and draw nested annuli (same shape as B1.4). `_visible` is already floored at 1.0" (`HAIL_FLOOR_IN`), so the outer edge is the 1.0" iso-line — genuinely smooth. Recompute the alpha rank over the levels actually drawn (`:2016` divides by the full 5-band chart). Rewrite the legend blurb (`:3449-3461`, "A quarter-degree cell") and attach `CONTOUR_CAVEAT` (as RADAR does at `:3495-3501`) — a contoured **max** field traces the storm's shape and may sit outside the true edge. | `src/layers/stormReports/index.js:1910-1989,2003-2021,3449-3461`; `src/layers/stormReports/contour.test.mjs` (add an inch-unit case) |
| **B1.7** | The chip titles say "grid cell" but describe a contour. Rewrite both. | `src/layers/stormReports/index.js:3323-3334,3366-3377` |
| **B1.8** | The QA harness clicks both chips and asserts both became true; with RADAR on by default the click **toggles it off**. Click only if not already active. | `scripts/qa-storm-swath.mjs:1116-1137` |
| **B1.9** | Delete the dead `radarColorFor` (`:282-287`, referenced only from a comment at `:2076`). | `src/layers/stormReports/index.js:282-287` |

**Gates:** `npm test` green; `npm run qa:storm-swath` passes (mean ΔE ≥ 8; last report 22.73); the swath is visible on a clean boot of the production build with RADAR on by default.

---

## WAVE 2 — the gallery, then the desk

### 2a. The gallery (settles the look, then everything else is mechanical)

| id | change | files |
|---|---|---|
| **B2.1** | `apps/hail-desk/gallery.html` at the **app root** — NOT `public/`, which Vite copies verbatim into `dist`. Vite's build input is `<root>/index.html` only, so a root-level `gallery.html` is not in `dist/`. Dev: `http://localhost:5200/gallery.html`. | new `apps/hail-desk/gallery.html` |
| **B2.2** | The gallery reaches the shards by **relative import** of the shared loader, the desk's existing pattern (`apps/hail-desk/src/data.js:19-23`): `import { loadFineRadarDay } from '../../../src/data/stormReports.js'`. In dev the module is served at `/@fs/<repoRoot>/…` and `stormReports.js:48` derives its base from `import.meta.url`, so the shard resolves under `/@fs/` — which Vite serves because `server.fs.allow` includes the repo root (`vite.config.js:34`). **Dev only.** If the gallery must also run against `npm run serve:desk`, add `GET /api/desk/storm/{day}.bin.gz` streaming from disk. | `apps/hail-desk/gallery.html` |
| **B2.3** | Render the 5 biggest storms × 3 treatments (cell-fill / contour-fill / contour-fill + hot edge) × 2 altitudes, over the real basemap, plus the ramp options. Reuse `contourRings` (`model.js:1416`), `indexFineDay` (`stormReports.js:676`), and the desk's own painter (§3). **Gotcha:** `contourRings` reads `cell.v ?? cell.peakMm` (`model.js:1429`) but `indexFineDay` returns `{i, j, maxMm}` — map to `{i, j, v: maxMm}` or it contours nothing. | `apps/hail-desk/gallery.html` |

### 2b. The desk rebuild

| id | change | files |
|---|---|---|
| **B3.1** | **Window the table.** `content-visibility: auto` is REJECTED — it defers paint, not construction, so all 64,960 cells and 12,992 listeners still exist and the `container.replaceChildren()` rebuild on every keystroke is untouched. A row cap is rejected (it truncates a ranked market list — the file then holds more rows than the table, which is the exact lie the desk's caveats exist to avoid). Pagination is rejected (it destroys the rank reading). **Use windowing with spacer rows** in `apps/hail-desk/src/table.js`: `ROW_HEIGHT = 29` (must match the CSS row height), `OVERSCAN = 12`, a `spacerRow(height, span)` helper, keep the `<table>` alive, and fill the body with `first..last` from `scroller.scrollTop` / `scroller.clientHeight`. DOM rows drop 6,496 → ~40. **The CSV costs nothing**: `main.js:781-785` builds it from `state.rows`, never the DOM — record that as a comment invariant. Also **debounce the `#q` input ~120 ms** (`main.js:763` fires `applyFilters` per keystroke). | `apps/hail-desk/src/table.js:279-343`; `apps/hail-desk/src/main.js:763,781-785` |
| **B3.2** | **The layout**: replace `index.html:25-88` with a grid — `300px / minmax(0,1fr) / minmax(420px,34vw)` for rail / map / list, `height: calc(100vh - 62px)`. The three drill-down sections (`#detail`, `#tracts`, `#streets`, index.html:79-83) collapse into **one `#drill` panel** with a `drillStack` of `{level, title, render}`; `drillBack` pops, `drillClose` returns to the table. Levels: storms → tracts → streets. `.table-wrap` loses `max-height: calc(100vh - 320px)` (styles.css:218-224) — that 320px is a hard-coded height of everything above the table. | `apps/hail-desk/index.html:25-88`; `apps/hail-desk/styles.css:86-90,218-224` |
| **B3.3** | **The rail** — port the globe's pattern into a new `apps/hail-desk/src/rail.js` (the desk cannot import `src/ui/`: `vite.config.js:9-24` and `scripts/check-import-directions.mjs:23` class it `renderer`). Use the **same class names** so the vocabulary matches: toggle row `.data-toggle-row` / `.data-toggle-top` / `.data-toggle-left` / `.data-icon` / `.data-name` / `.data-toggle-right` / `.data-count` / `.data-toggle-btn` / `.data-toggle-meta`; chips `.data-toggle-controls` / `.data-toggle-chip` with `chip-active|chip-idle` and `aria-pressed`; field `.data-toggle-field` / `.data-toggle-field-input`; list `<ol class="data-row-list">` with `<li>` > `button.data-row-list-item` and `.data-row-list-lead` / `.data-row-list-text`. **Contract:** the button is a real `<button type=button>`; `aria-disabled` + `aria-busy` instead of native `disabled` (native disabled evicts keyboard focus in Chromium, `layerPanel.js:275-296`); chips are **reconciled in place, never rebuilt** (focus survives); dispatch is delegated on the container and re-reads the live descriptor; the field commits on Enter or blur, cancels on Escape, and its value is never written while focused. | new `apps/hail-desk/src/rail.js`; `apps/hail-desk/index.html`; `apps/hail-desk/styles.css` |
| **B3.4** | **The ranked list** — delete `topNames` (`table.js:373-378`, hard-coded limit 4) and its use (`main.js:130-131`). Add `rankedList(rows, {view, currentId})` to `table.js`, mirroring `src/layers/hailwind/index.js:634-658`: `RANKED_LIST_LIMIT = 12` (the globe's `STORM_COUNTY_LIST_LIMIT`), `lead` = the state, `text` = name + **share of the maximum** (an absolute score is not comparable across windows) + max hail, `ordinal` = rank, `current` = the drill-down's row, `params` = the click payload. | `apps/hail-desk/src/table.js:357-378`; `apps/hail-desk/src/main.js:130-131` |
| **B3.5** | **The inert sort headers.** `SORTERS` (`table.js:221-236`) has no entry for `name`, `st`, `big`, `umoe`, `band`, `severe`, `maxHail`, `bld` — those headers change the URL and the table does not move (`sortRows` falls back to `Object.values(table)[0]`, `table.js:253`). Give each view a **complete** sorter table with the **default sort first** (the fallback depends on it): `city: {severe, severe15, big, max, hail, units, umoe, pop, name, st}`, `county: {score, hail, severe, maxHail, units, umoe, pop, bld, name, st, band}`, with `name: r => r.full \|\| r.name`, `st: r => r.st \|\| ''`, `umoe: r => r.umoe ?? -1`, `maxHail: r => r.maxHailIn ?? 0`, `bld: r => r.bld ?? -1`. | `apps/hail-desk/src/table.js:221-236,251-268` |
| **B3.6** | **The URL codec.** The enum is `['score','units','hail','loss','pop']` (`src/data/layerState.js:513`) but the city default sort is `'severe'` (`main.js:774`), which is not in the enum — so it encodes as the literal `"undefined"` and **every city link writes `8.o.undefined`**. `'loss'` matches no column either. Changes: add `view` to the desk options (`enumOption('view','v','city',['city','county'],{city:'c',county:'y'})`); extend the sort enum to all 14 visible keys with distinct codes; and **harden the shared core**: `layerState.js:239` `encode: (value) => codes[value] ?? codes[defaultValue]` — `encodeOwnerOptions` (`:1131-1143`) calls `spec.encode` without normalising, which is why `'severe'` wrote `"undefined"`. **One line makes every enum fail-safe.** Add `view: 'city'` to `DEFAULT_FILTERS` (`apps/hail-desk/src/state.js:36-44`) and replace `state.view` with `state.filters.view` (`main.js:112,115-120,766-779,782`). **Delete `isDeskHash`** (`state.js:89-97`) — zero callers and it tests token `'7'` which is not in the ledger (the desk's token is `'8'`). | `src/data/layerState.js:239,508-528`; `apps/hail-desk/src/state.js:36-44,89-97`; `apps/hail-desk/src/main.js:112,115-120,766-779,782` |
| **B3.7** | **Geometry for the map.** The desk's artifacts carry **no lat/lon** — `scripts/build-hail-desk-data.mjs:164-168` says so outright: *"The geometry is deliberately dropped… The map, when it comes, will load boundaries on its own."* But `indexPlaces` already computes `minLat/minLon/maxLat/maxLon` (`:196-217`) from the rings, so the centroid is free. Add `lat`/`lon` (and a bbox) to each city and county row: ~330 KB raw / ~120 KB gzipped for 32,607 rows. | `scripts/build-hail-desk-data.mjs:355-370` |

---

## WAVE 3 — the 2D map and its tiles

### 3a. The tile format — our own `GEVS` v1

There is **no MVT encoder** in the repo (`@mapbox/vector-tile` decodes only). `pbf` v5 *does* have a writer (`node_modules/pbf/index.js:222` `PbfWriter`), so MVT is feasible without a new dependency — but it buys a protobuf envelope, a tags table and a decode path for a format with exactly one producer and one consumer. **Use our own binary.**

Header, 32 bytes LE: magic `GEVS` (0-3), version=1 (4), extentShift=12 → extent 4096 (5), featureCount u16 (6), geometryBytes u32 (8), zoom u8 (12), reserved (13-15), westLon f64 (16), southLat f64 (24).

Feature, ×featureCount: pointCount u16 (≥2), edgeIndex u32 (0xFFFFFFFF = none), x0 i32, y0 i32 (tile-local, y grows DOWN), then varint zigzag deltas ×(pointCount−1).

Measured on the cached Douglas County zip (17,205 records, 245,363 points, avg 14.26 pts/record): ≈20 B per feature → ~1.2 MB per county per zoom. GeoJSON is 4–6× larger and forces `JSON.parse` on the main thread per tile.

**Tile maths:** `src/layers/streetLevel/tileMath.js` — **zero imports**, pure, Cesium-free, DOM-free, Node-free, so it is importable from a Node route **and** the desk app. It keeps `tileXAt`/`tileYAt` private (`:16-26`) and exposes only the inverse (`:183`). **Export them**, plus one helper `lonLatToTileLocal(lon, lat, extent, x, y, z) → [px, py]` — the exact inverse of `tileLocalToLonLat`, reusing the file's own maths so there is one implementation.

### 3b. The route

`GET /api/desk/tiles/{state}/{county}/{z}/{x}/{y}`

- **Placement:** between the streets route (ends `:86`) and the static handler (`:88`). **It must never fall through** — the SPA fallback (`server/desk/server.mjs:105-111`) answers index.html with a **200** for any unmatched path, so a typo'd tile URL would return HTML.
- **204** for an empty tile; `X-Gev-Cache: memory|disk|index`; `Cache-Control: public, max-age=3600`; `Content-Type: application/vnd.gev.street-tile`. All copied from `server/providers/mapillary/routes.js:48-53`.
- **Rate limit** 600/min, globalMax 2400, same as `mapillary/constants.js:58`; the same-site gate `server/providers/common/same-site.js`.
- **Disk cache:** `.gev-cache/desk-tiles/2024/<state><county>/<z>/<x>-<y>.gvt` — the TIGER vintage (2024, `tigerStreets.js:46`) is in the path, so a new vintage is a new tree and stale tiles are impossible. Caps: 1 MB/tile, 64 MB memory LRU, 2 GB disk, 30 d TTL (matching `CACHE_TTL_MS`, `tigerStreets.js:56`); background sweep + single-flight + slot semaphore copied from `server/providers/mapillary/tiles.js:266-282,370-402,444-464`.
- **CRITICAL — the source must be the RAW RECORDS, not `countyEdges()`.** `countyEdges()` (`tigerStreets.js:176-263`) returns one object per **side** and **drops every edge whose side has no address range** (`:241`). Measured on 08027: 17,205 records → only 6,671 named → only **2,468** have a range on either side, so `countyEdges()` would cover **37% of the named centrelines** and the map would have holes. **Split `countyEdges()`** into an exported `countyEdgeRecords(state, county)` (the parse half, `:177-224`, returning `{rows, shapes, zipPath, zipMtime}`) and keep `countyEdges()` on top. Also export `countyEdgesPath` (`:90`) so the tile module can key on the zip's mtime.
- **Parse-once index** (the critical part — `countyEdges()` re-parses 27 MB on **every call**): `countyIndex(state, county)` → `{key: county+zipMtime+zipSize, lines: [{points: Float64Array, bbox}], byZoom: Map<z, Map<"x-y", Uint32Array(lineIndices)>>}`. **Dedup by the `points` array IDENTITY** exactly as `hailStreets.js:166-180` does — L and R share one array object (`tigerStreets.js:232`), so identity dedup collapses them; the naive one-per-side duplicates every street. Clip each line to the tile box (Liang–Barsky) so the payload is bounded, then quantise to tile-local ints. **Memory only**, LRU over counties (cap 2 counties / 256 MB; Denver ≈ 1.26 M points ≈ 20 MB). **Invalidated by content, not time**: a changed zip mtime drops the index and deletes that county's tile tree.
- First request for a county pays download (if absent) + parse ≈ 1–3 s; every other request joins the same promise. The slot semaphore caps concurrent county parses at 2.

**Dev parity.** `apps/hail-desk/vite.config.js` has **no `plugins` key**, so `npm run dev:desk` has no API and `/api/desk/streets` 404s in dev; `tigerStreetsPlugin()` (`tigerStreets.js:299`) exists and is referenced **nowhere**. Extract one handler module `server/providers/deskApi.js` exporting `deskApiPlugin()` (registers `/api/desk/streets` **and** `/api/desk/tiles` in `configureServer`, mirroring `tigerStreetsPlugin`), and add `plugins: [deskApiPlugin()]` to the desk's vite config. Dev and prod then call the **same** `fetchStreetTile`/`streetsPayload` and cannot drift.

### 3c. The client map

New `apps/hail-desk/src/map/`: `viewport.js`, `basemap.js`, `streets.js`, `vectors.js`, `swath.js`, `map.js`.

- **Projection:** world pixels at the current zoom; `worldPx = (tileXAt(lon,z), tileYAt(lat,z)) × 256`; screen = `(worldPx − originWorldPx) × dpr`. Tile set = `tilesForBbox` (`tileMath.js:117`) or `tilesForBounds` (`tomtomTiles.js:114`).
- **Pan/zoom:** `pointerdown/move/up` (capture) → centre shift in world px; `wheel` with `{passive:false}` + `preventDefault()`, zoom anchored at the cursor (world px under the cursor before/after, re-centre). `z = clamp(round(log2(256·n/viewportPx)), 4, 18)`.
- **Basemap:** `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` — **z, then y, then x** (REST is level/row/column). 256 px, levels 0–23. **Set `img.crossOrigin = 'anonymous'` BEFORE `img.src`** (Esri sends `Access-Control-Allow-Origin: *`) or the canvas is tainted and `getImageData`/`toBlob` throw `SecurityError`. Attribution must be **inlined** — `src/maps/imagery.js:1` imports Cesium so the desk cannot import it; copy the string from `:4-5`. The live credit is "Source: Esri, **Vantor**, Earthstar Geographics…" (the repo still says "Maxar", `:19`).
- **Vector layers:** streets from `/api/desk/tiles/…` → `arrayBuffer()` → decode GEVS (≈40 lines, no dependency) → stroke. Counties need a build step into `public/data/` or a server route. **Tracts are 29.7 MB** (`server/providers/tracts.js:25-29`) — not shippable; they need a second tile layer, e.g. `/api/desk/tiles/tracts/{state}/{county}/{z}/{x}/{y}`, leaving the streets URL as specified.
- **Swath rings:** `contourRings` (`model.js:1416`) — **the desk may import it**: `model.js` has exactly one import (`:15-19` → `src/data/stormCrossReference.js`, zero imports, no globals). **Do not import the renderer** `src/layers/stormReports/index.js` (it is the Cesium layer). Usage mirrors `index.js:1937`: `contourRings(cells, isoMm, GRID_DEG_FINE)` with `GRID_DEG_FINE = 0.01` (`model.js:26`), and cells mapped to `{i, j, v}`.

---

## WAVE 4 — the per-storm artifact (Path B 3.2)

The gallery's renderer (B2.3) and the desk's painter (WAVE 3) are the seed: **the same painter, static PNG.** The thing that competes with a $229 map.

---

## The basemap decision, in full

**Esri as the online default; our own Census geometry as the guaranteed no-signal floor. OSM is rejected.**

- **OSM is disqualified by policy, not preference.** OSMF Tile Usage Policy §4: *"Offline use is not permitted"* on `tile.openstreetmap.org`; §3.1 requires an identifying User-Agent. Verified live: `curl/8.0` and `Mozilla/5.0` both return `x-blocked: Access denied` — only a custom UA returns 200, and **a browser cannot set its own UA**. OSM cannot legally serve the no-signal field case.
- **Esri** (verified live): 200, `image/jpeg`, `Access-Control-Allow-Origin: *`, `max-age=86400`, 256×256, EPSG:3857, levels 0–23, no referer needed, CloudFront-cached.
- **Street-level orientation must come from our own TIGER street tiles** — offline-capable, no third party. Esri World Imagery carries **no labels** (the keyless `World_Boundaries_and_Places` reference layer 404s). Optional labelled toggle: keyless `World_Street_Map` (verified 200, CORS `*`).
- **No-signal path:** the repo has **no service worker** — add one caching Esri tiles (respect 86400) for the working county, and degrade to the dark canvas (counties / tracts / streets / swath + a labelled grid) with an explicit "Basemap unavailable offline" notice.
- **Attribution:** always visible, never behind a toggle. Credit Esri, NOAA/NWS MRMS MESH, and US Census TIGER/Line.

---

## The lesson that keeps biting

`38.83 / 0.01` is `3882.9999999999995` in a double. The floor of it puts the point in the wrong grid row, which moved every street in the country one cell off the hail — and the knock list came back **empty with no error anywhere**.

All 4,405,145 hit cells across the 1,019 days now round-trip with zero mismatches, and there is a test that pins it.

**Never trust a cell lookup that has not been round-tripped.**

---

# STATUS — as of 2026-10-20, end of the first build session

## DONE and committed

| id | commit | what |
|---|---|---|
| B0.1 | `0971421a` | the `showStreets` shadowing bug — the FEMA damage table can render now |
| B0.2 | `da8efbc1` | `setRadarSwath(false)` re-renders, so the swath comes off the map |
| B0.3 | `da8efbc1` | the storm table's tenth cell (10 headers, 9 cells) |
| B1.1 | `da8efbc1` | RADAR on by default, conditionally on a radar source |
| B1.2 | `da8efbc1` | the five-stop violet→magenta→white ramp, off the pins' colours |
| B1.3 | `da8efbc1` | each band outlined in the next hotter band's colour |
| B1.7 | `da8efbc1` | the chip titles, which described a per-cell fill that is gone |
| B1.8 | `da8efbc1` | the QA harness, which would have toggled RADAR OFF |
| B1.0.1 | `da8efbc1` | the scope mask off by default — **the porthole is gone, the map is full-bleed** |
| B1.0.2 | `da8efbc1` | the keyhole label fade tied to the porthole, not to a pinned constant |
| B3.1 | `ae95bb58` | the table is a window: 6,496 rows → 47 in the DOM, 30.005 px/row |
| B3.5 | `ae95bb58` | every visible sort header is a control again |
| B3.6 | `ae95bb58` | every sort key round-trips through a link, and the shared encoder can no longer write `undefined` |
| B2.1–B2.3 | `cf88f3e2` | **the gallery** — `apps/hail-desk/gallery.html`, five real storms × three treatments |
| B3.4 | `0971421a` | **the ranked list** — the globe's county-list vocabulary, twelve entries, clickable |

## STILL TO DO

| id | what | size |
|---|---|---|
| **B1.4** | the bands do not TILE: every band is contoured at the 25.4 mm floor, so the shared boundary between two bands is interpolated twice at different sub-cell positions — a seam up to ~400 m. Fix: contour the field once per level and build each band as an annulus (`outer = contour(F_k)`, `holes = contour(F_{k+1})`). | medium |
| **B1.5** | the third LOD tier: fine to 60 km, a 0.05° mid tier (5×5 max-downsample) to 600 km, coarse above. The blocky band is 12–100 km, not 100–600 km. | medium |
| **B1.6** | the REPORTED swath is still a staircase. Contour the union per level and draw annuli, as B1.4. | medium |
| **B1.0.4–B1.0.7** | the celestial ring must hug the globe not the porthole (`frameRadius`); the HUD becomes one telemetry strip; the rails stop collapsing around it; `foundation.css` loses `#scope-mask` and the cockpit clip-path. | medium |
| **B3.2** | the desk's layout: a grid — rail / map / list — and the three drill-down sections collapse into ONE panel with a `drillStack`. | large |
| **B3.3** | the control rail, porting the globe's `.data-toggle-*` / `.data-row-list` vocabulary into a new `apps/hail-desk/src/rail.js`. | large |
| **B3.7** | lat/lon for the city and county rows, so the map has something to plot. `scripts/build-hail-desk-data.mjs` already computes the rings' bounds. | small |
| **WAVE 3** | the 2D map: the `GEVS` tile format, the `tileMath.js` exports, the `/api/desk/tiles/...` route, the parse-once county index, the desk's canvas pane, and `deskApiPlugin()` so dev and prod share one handler. | large |
| **WAVE 4** | the per-storm artifact — the gallery's renderer, made static. | medium |

**The one thing to read before starting WAVE 3:** the tile source must be the RAW EDGES
records, not `countyEdges()`. `countyEdges()` drops every edge whose side has no
address range — on Douglas County that is 37% of the named centrelines, so a map
built from it has holes. Split `countyEdges()` into an exported
`countyEdgeRecords()` and keep `countyEdges()` on top of it.

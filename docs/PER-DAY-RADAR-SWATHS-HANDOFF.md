# Per-Day Radar Swaths — Handoff

State of `docs/PER-DAY-RADAR-SWATHS.md` Phases A–E as of `be814a2a` on
`contrib/storm-scope-20261015`, and the two things still open.

Read this before touching the layer. Most of what follows is **how not to waste
a day on instruments that lie.**

> **Amended** after review: §0 added, §4's gate replaced with a runnable
> protocol, §6's browser rule carved out to protect only the operator's live
> Chrome, §8 extended with three controls that were never consulted. The
> operator's bar is **HailTrace-class legibility**, which the original §4
> explicitly capped below. Two line anchors were corrected (§5). If you are
> following the old text anywhere else, it is this version that is right.

---

## 0. Read this first — three things that outrank the open question in §4

**Both swath toggles default to `false`** (`src/layers/stormReports/index.js:421-422`).
A freshly loaded scene, and any HMR reload of the layer file, therefore draws
**zero swaths by design**. "The operator sees only the pins" is fully explained
by that alone, with no geometry bug in sight. If you are about to investigate
occlusion, first prove the chips are actually on.

**The occlusion hypothesis in §4 was never ranked against the simplest
explanation**, and there are **three controls in this repository** that answer
the question without a human being asked:

| Control | Where | What it proves |
|---|---|---|
| A clamped polygon with an outline, rendering in this scene, in this data source | `renderOutline`, `index.js:1383-1394` | `heightReference: CLAMP_TO_GROUND` is **not** buried here |
| Tens of thousands of clamped cell rectangles that are visible | `hailwind/index.js:587-611` | The working layer already does the thing §4 calls risky |
| Polygons **with holes** | `perimeters/index.js:316-322` | Ring extraction has a house pattern to copy |

`renderOutline` is the strongest of the three: same file, same `_dataSource`,
same ground, and it is a visible feature with a legend entry.

**The goal is HailTrace fidelity, not "make it visible."** §4's original
framing — *if it is faint, the fix is contrast and nothing more structural* —
sets a ceiling below the target and is now superseded. See the plan's Phase F.

---

## 1. The short version

Phases A–E are built, merged, committed and green. The per-day radar field is
built, shipped, loaded, normalised, cross-referenced, summarised in the panel,
and rendered into the scene as rectangles.

**One thing is unverified: whether the swaths are visible, and at what quality.**
The entities are provably in the scene. The operator reports seeing only the
pins. Three candidate causes remain — the toggles were off, the wash is buried,
or the wash is too faint — and §4 now gives a protocol that separates them
without asking a human. Start at **§0**.

One thing is **known broken** and approved for fixing: production builds ship no
storm `.gz` payloads at all (§5).

One thing is **newly scoped**: the swaths are drawn as one translucent rectangle
per 0.25° cell at a flat alpha. Even fully visible, that does not read like the
category. That is Phase F of the plan.

---

## 2. What is proven working, with the numbers

Everything below was measured in the running app through
`scripts/gev-control.mjs`.

| Claim | Evidence |
|---|---|
| The loader reads the binary field correctly | `loadRadarDaysForYear(2026)` → **288 days, 252,051 cells**, decoded to correct `i:j` and millimetres (`148:-481` → 10.6 mm) |
| The per-day claim publishes | Panel line: `radar: on 2026-10-13, radar showed hail in 10 cells, 10 of them with no report · 0 of 21 reports sat in a cell with a radar core · 21 sat outside one — an estimate from reflectivity for this day alone, not a measured stone` |
| Impacted places | `Shawnee KS (5), Buchanan IA (2), Hall TX (2), Motley TX (2)` |
| The pure model is correct | Called live in-page: `reportedSwathCells` returns Denver cells banded `severe` (#e06020) / `large` (#e0a020); `radarSwathCells` returns cells with correct bounds, and `84:-500` → lat 21.125 / lon −124.875 — exactly the geometry edge |
| REPORTED swaths exist in the scene | **15 of 15** swath rectangles found via `entities.getById()` for a single day |
| RADAR swaths exist in the scene | `getById('storm-swath:radar:177:-316')` resolves; 100 cells for 2026-10-13 |
| Materials are right | `ColorMaterialProperty`, `rgba(200,30,30,0.34)` |
| The rebuild is deterministic and non-destructive | Two independent full rebuilds: the 7 published artifacts byte-identical, the per-day payload byte-identical. Σ`dy` = 253,016 |

---

## 3. The data, in one place

`src/data/local_data/storm/storm_radar_hail_perday_<year>.bin.gz`, six shards,
gzip, sorted by `(dayIndex, cellIndex)`, 6-byte little-endian records:

| Offset | Type | Meaning |
|---|---|---|
| 0 | `u16` | cell index, `(i - 84) * 260 + (j + 500)` |
| 2 | `u16` | day index, days since **2021-01-01** |
| 4 | `u16` | peak MESH in **tenths** of a millimetre |

- 1,407,918 cell-days, 8,447,508 bytes raw, 5,363,723 gzipped across the six.
- Retained from **10 mm**; the published climatology stays at **25 mm**.
- Epoch is fixed to the archive start, not the window start, so extending the
  window cannot re-date records already written.
- Scale is 10, not 100 — at 100 the 1,437.4 mm peak becomes 143,740 and wraps a
  `uint16` silently.
- Per-day implausibility: **0.22%** of cell-days over 100 mm, against **10.9%**
  of lifetime cells. Both figures measured.

---

## 4. The open question: is the wash visible, and at what quality?

**This section was rewritten.** The original asked one binary question — *is the
wash invisible or merely faint?* — and said only the operator could answer it.
That framing was wrong in three ways, all now fixed below: it ignored the
toggles' default state (§0), it had an in-repo control it never consulted, and
its "faint" branch capped the work below the actual goal.

### The state that produced the report

Camera 40 km over west-central Oklahoma (34.4 N, 100.3 W), date **2026-10-13**,
HAIL, both toggles on. 15 REPORTED rectangles and the RADAR rectangles all
present via `getById`. Operator sees **dots only**.

### The three candidate causes, in the order you must eliminate them

1. **The toggles were off.** `_showReportedSwath` and `_showRadarSwath` both
   initialise `false` (`index.js:421-422`). Prove they are on before anything
   else. If they were off, there is no bug and every hypothesis below is moot.
2. **The wash is buried.** `addSwathCell` (`src/layers/stormReports/index.js:1224`)
   creates the rectangle with `height: 0`, the **ellipsoid surface**, while this
   scene's ground may be Google Photorealistic 3D Tiles at real elevations —
   tiled geometry is an ordinary depth-tested primitive, so a cell at sea level
   renders *underneath* the terrain. It builds, it costs the vertex budget, and
   nothing appears.
3. **The wash is too faint.** A 34%-alpha band over a busy photorealistic
   basemap at 40 km may just be hard to see. And even when it is seen, a grid of
   independent translucent squares is not a HailTrace swath — that is Phase F,
   and it is not a "contrast" problem.

### The protocol, in order. Each step is falsifiable and answers one question.

**Step 1 — are they on?** Read the chip states, then `getById` a known id from
each of the two sets. Non-empty on both ⇒ cause 1 is eliminated.

**Step 2 — is it buried, or is it faint?** Lift one swath rectangle far above
any terrain, in-page, without editing code:

```js
// pick any reported swath id from Step 1, then:
viewer.entities.getById(id).rectangle.height = 200000
```

If the wash **appears**, it was buried (cause 2). If it **still does not**, it was
faintness or off-screen (cause 3). One eval, binary answer, no human judgment.

**Step 3 — which ground was under the camera?** The occlusion argument blames
Photorealistic 3D Tiles, but the repro may never have been in that regime. There
is **no `.env` in this repository** — only `.env.example` — so
`loadPhotorealisticTileset` falls through to route `'osm'`, sets
`globe.show = true`, and initialises the stack to `'esri-imagery'`
(`src/app/scene.js:82-99`, `src/maps/google3d.js:12-14`). **The keyless globe is
a control**: if the wash is plainly visible on it and buried on tiles, occlusion
is proven. If it is faint on *both*, the diagnosis is contrast and Phase F.

`scene.globe.depthTestAgainstTerrain` is `false`, but that is the **Cesium
default** — nothing in `src/` ever sets it. It covers the ellipsoid's own
terrain, **not** 3D tiles.

### If it is occlusion, the options, honestly

1. **`heightReference: CLAMP_TO_GROUND` on a polygon.** The recipe already
   renders in this scene — `renderOutline` (`index.js:1386-1392`) is a clamped,
   outlined polygon in this same data source, and `hailwind/index.js:611` clamps
   tens of thousands of cell rectangles. This is the house pattern, and it is
   what Phase F uses regardless of the diagnosis. Caveat: `polygon.outline`
   under photorealistic tiles is the one Cesium behaviour not to assert from
   memory — **measure it** with the Phase 1 harness before relying on the edge.
2. **Lift per cell above local terrain** — needs a terrain height source, and
   §6 records that reading terrain through this API has been awkward.
3. **Move the wash out of Cesium geometry** into the layer's existing
   `overlayHost`, which already carries labels and storm cards. Always on top by
   construction, no depth fight. Bigger change; loses the "a place on the
   ground" quality that makes a swath read as geography.

Note this overrides an explicit instruction in the plan (§6 D2: "**`height: 0` +
`granularity`, NOT `CLAMP_TO_GROUND`**"). That instruction was written from a
Denver vertex measurement on the **isolation** layer, in the same breath as
"render on the hailwind cell-rectangle pattern" — and haildwind, the layer it
told you to copy, **uses `CLAMP_TO_GROUND`**. The instruction contradicts its
own precedent. The reversal is recorded here and in the plan's §6 D2, so the
next person who reads the plan and not the history does not revert it.

---

## 5. Known broken: production builds ship no storm data

Approved for fixing, unrelated to the swaths.

The loaders build their base by string surgery on `import.meta.url`
(`src/data/stormReports.js:40` — the `BASE` const; the comment block above it
starts at `:30`), so a built chunk resolves to
`<origin>/assets/local_data/storm/`. `vite build` copies **nothing** there.
Measured: `dist/assets/` holds only five hashed `.geojsonl` and the small
sidecars inlined as data URIs. **No `.gz` of any kind** — `find dist -name
'*.gz'` returns 0. A static host answers a
per-day request with the SPA shell and a **200**, via the SPA fallback — which
is why the loader keys "absent" on the payload's shape rather than the status
code (`src/data/stormReports.js`, `indexRadarDays`).

Under the Pinokio launcher this works: it runs Vite's **dev** server
(`scripts/pinokio-start.mjs:41`), which serves `src/data/local_data/storm/*`
straight from source. Confirmed live — 200, `Content-Encoding: gzip`, 712,667
bytes, gzip magic `1f 8b`.

**Fix:** a Vite plugin, `build/storm-assets.js`, registered in the `plugins`
array of `createBrowserViteConfig` (`build/vite.js:51` is the export;
`:62` is the array) so it covers both the main build and
the panel build — `panelBuildConfig` spreads the same config, keeping
plugins. A `closeBundle` hook copies the runtime-fetched `.gz` payloads to
`<config.base><assetsDir>/local_data/storm/`, **derived from config, never
hardcoded**, so `/assets/` and `/panel/assets/` both resolve. Mirror
`build/panel.js`'s style.

**Two outDirs, one shared plugin.** The panel build writes to
`PANEL_OUT_DIR` (`build/panel.js:21-23`), not the main one. `closeBundle` fires
per build with that build's own config, so deriving the destination from
`config.base + config.build.outDir + config.build.assetsDir` lands both sets of
payloads correctly. Hardcoding a path is how this silently ships for the app and
not for the panel.

Copy only the `.gz` payloads. The five plain `.geojsonl` are already emitted
hashed by the bundler and the small sidecars are inlined as data URIs; copying
them would duplicate ~27 MB for nothing.

- Test: `src/tooling/stormAssetsBuild.test.mjs`, matching `viteBuild.test.mjs`.
  Assert registration, the file selection, and that the destination derives from
  base + assetsDir + outDir.
- Build check: `dist/assets/local_data/storm/storm_radar_hail_perday_2026.bin.gz`
  exists and is byte-identical to source. As a `qa:*` script, not a unit test —
  building in the suite is too slow.
- **Cost to flag:** dist grows ~15 MB. There is no way to serve files you do not
  ship.
- Ticks the plan's §9 item *"Production-build check that the new `.gz` is
  actually served"*.

### An honest note on resolution, so nobody files it as a bug later

HailMate states its grid as **~1 km**. Ours is **0.25° ≈ 28 km** at this
latitude — a single cell is about 25 miles across. Phase F is matching the
category's **visual language** (contiguous colour-banded polygons, hard edges,
band-ramped alpha, pins on top), **not** its street-level resolution. At HailTrace's
neighbourhood zoom one of our cells covers the whole neighbourhood. That is a
property of the MRMS feed we ingest, not a defect to be patched, and the plan
says so.

---

## 6. Instrument traps — read before trusting a single number

Every one of these cost real time. All observed in this build, through
`node scripts/gev-control.mjs eval '<expression>'`.

| Trap | What happens | What to do instead |
|---|---|---|
| `entity.id` | **`undefined` on every real Cesium entity**, pins included. Any classification by id silently reports everything as one type. This produced a false "zero swaths" finding that nearly caused a "fix" to working code. | `entities.getById(id)` — the only id access I have found reliable |
| `EntityCollection.values()` | Not a function. `.length` is `undefined` too. | `getById()`, or the layer's own `getStats()` / `getComparison()` |
| `entities._entities` | Exists, but iterating it yields items whose `.id` is `undefined` — it is not what it looks like | `getById()` |
| `camera.positionCartographic` | `.latitude` / `.longitude` come back in **radians**, not degrees. 0.6, −1.75 is Oklahoma, not the Gulf of Guinea. | Multiply by 180/π, or trust `gev-control state`, which reports degrees |
| `globe.getHeight({lat, lon})` | Returns `undefined` for a plain object, even with `tilesLoaded: true` | Needs a real `Cartographic`; no route to one was found |
| Vite HMR | **Every edit to the layer file reloads the module and resets both swath toggles to off.** This is the most likely reason the operator saw an empty map. | After any edit, re-stage the toggles and the date before looking |
| `RectangleGraphics` options | Silently ignores anything not in its documented list. `disableDepthTestDistance` compiles, runs, does nothing. | A test asserting the property is the cheapest guard |

And the two that are not traps but rules — the second of which has changed:

- **Visibility is a measurement, not an opinion.** `scripts/gev-control.mjs` has
  no screenshot, so it cannot answer "can you see it". It no longer has to:
  `scripts/qa-storm-swath.mjs` launches its **own** Chrome via the repo's
  existing puppeteer dependency and writes shots plus a sampled contrast figure
  to `qa-shots/storm-swath/`. Use that. If you find yourself transcribing a
  human's aesthetic impression into a doc instead of quoting a measurement,
  that is the trap.
- **Never touch the operator's live Chrome.** The original rule was "no agent
  drives a browser", written after a CDP navigation against the Pinokio shell
  cost the operator his session three times. The actual hazard is narrower and
  is now carved out: **never connect to or reload port 9222**, which is his
  running session. An **independent** headless Chrome against its own server on
  its own port is safe and is the house pattern — see `scripts/qa-map-source-tray.mjs`,
  which launches `puppeteer.launch({ executablePath })` and targets
  `QA_BASE_URL || 'http://localhost:4173'`. Agents may drive that freely.
- **`polygon.outline` is not to be assumed.** Whether Cesium draws a polygon
  outline under photorealistic tiles depends on its ground depth-test path.
  Measure it with the `qa:storm-swath` harness before designing an edge around
  it; if it does not draw, fall back to a `PolylineGraphics` boundary ring at
  the same height. Do not assert this from memory.

---

## 7. What is already committed

Twelve commits on `contrib/storm-scope-20261015`, `f54e2c4a..be814a2a`:

```
be814a2a feat: per-day radar swaths, and publish the day's unreported cells
e528643c feat: read the per-day field as bytes, or not at all
e0b7839e feat: pure swath builders and hail-size nicknames
9d58c20e test: the per-day geometry is pinned against every year shard, not one
01f3bbd4 docs: correct the storm snapshot record counts
7324676c feat: index the per-day radar field without changing its consumers
52601e31 perf: shard the per-day radar field by year, the way the climatology is
91f8edc0 docs: the per-day radar file is not GeoJSONL, and says so where the others are
aa1f6a6e data: the per-day radar artifact, 1,407,918 cell-days over 2021-2026
b7c5a1c6 feat: emit the per-day radar field, and keep the climatology untouched
afcd2f0c test: drive the retained-domain constants through the real seam
6988db14 refactor: extract domain triple and add HAIL_RETAIN_MM split
```

Working tree clean. No worktrees. Nothing pushed.

---

## 8. Do not "fix" these

They were investigated and found healthy. Reopening them is how this work
regresses:

- **The swath render path.** `renderSwaths()` is called, the guard passes, the
  model returns 7,719 cells at the archive filter, and the entities land.
- **`refreshRadar()` repainting.** It calls `render(); publish();` at
  `index.js:928-929`. An earlier reading stopped at line 918 and declared a
  missing repaint that is not missing.
- **`setRadarSwath`.** It routes through `rebuildRadarSwath()`, which renders.
- **The loader's byte path.** `Uint8Array` has no `readUInt16LE`; the code
  correctly uses a `DataView`. It has its own cache, because sharing `radarYears`
  with the year loader would collide on the year key.
- **`heightReference: CLAMP_TO_GROUND` is not a risky experiment.** Three
  controls say it already works here: `renderOutline` (`index.js:1386-1392`) is a
  clamped, outlined polygon in this same `_dataSource` and it renders;
  `hailwind/index.js:611` clamps tens of thousands of cell rectangles and that
  layer is visible; `perimeters/index.js:316-322` draws clamped polygons with
  holes. The plan's contrary instruction came from a vertex count measured on
  the **isolation** layer. Do not spend the day re-deriving occlusion.
- **The keyless globe is a supported shipped state, not a degraded one.** No
  `.env` exists in the repo; `google3d.js:12-14` falls through to `'osm'` and
  `scene.js:82-99` initialises `esri-imagery` with `globe.show = true`. The QA
  suite already treats this as a branch worth proving (`qa-map-source-tray.mjs`
  has a `--keyless` flag). It is also a free control for any "is it buried"
  question.

If a future reader believes one of these is broken, the burden of proof is on
them, and §6 explains how the last three such claims arose. For the last two,
the burden includes **running `qa:storm-swath`** and quoting its output, not
re-deriving it by reading.

---

## 9. Standing rules

From the plan's §8, and they have all earned their place:

- **A test that passes with the bug restored is not a test.** Restore the bug,
  watch it fail, restore the fix. Report what you killed.
- **Test through the real seam.** The hover feature once shipped gated behind a
  cohort only the direct API bypassed, and the suite was green because the
  harness only drove the click handler.
- **Every number you write must be one you measured.** Quote the source for any
  figure you did not take yourself.
- **Orchestrate with worktrees**, disjoint file ownership per agent, never more
  than four at once, no two agents in one file.

Existing test coverage for the swaths lives in
`src/layers/stormReports/layerLifecycle.test.mjs` (the swaths section, ~line
1061+) and `src/layers/stormReports/model.test.mjs`.

One known gap in that coverage, worth closing whenever the render question is
settled: **every existing swath test awaits `settled(layer)` before toggling**,
so the toggle-before-data-arrives ordering is untested.

---

## 10. Suggested order of work

**The gate is no longer a person.** Item 1 below replaces the old "ask the
operator" step, which blocked all progress on a subjective judgement that three
in-repo controls could have settled.

1. **Close the question with a measurement.** `npm run qa:storm-swath` — the new
   harness — runs the §4 protocol end to end (toggles on? → buried or faint?
   → which ground regime?), writes screenshots and a sampled contrast figure to
   `qa-shots/storm-swath/`, and prints the diagnosis. No operator time, no
   code changes. **Its output is the answer to the open question; quote it, do
   not paraphrase it.**
2. **Phase F — HailTrace fidelity.** The actual goal. Per-cell translucent
   rectangles become contiguous banded polygons with hard edges and band-ramped
   alpha, following the `renderOutline` / `perimeters` precedents. Spec is in
   the plan's Phase F. Whether or not Step 1 says "buried", this is the work
   that gets us to the category's standard.
3. **Independently and in parallel: the `build/storm-assets.js` fix from §5.** It
   touches no layer code, so it cannot collide with item 2.
4. **Persist the two toggles** so an HMR reload cannot silently reset them
   again. That trap has already produced one false finding; a regression test
   asserting a re-mount preserves both chips belongs with it.
5. Re-verify: `qa:storm-swath` again with before/after shots, full suite,
   `format:check`, `check-import-directions`, `check-layer-state-tokens`. Keep
   the existing pins-on-top assertion (`layerLifecycle.test.mjs:1177-1199`)
   passing across the polygon swap.
6. Tick the plan's §9 boxes that are now genuinely satisfied, with figures from
   the harness output.
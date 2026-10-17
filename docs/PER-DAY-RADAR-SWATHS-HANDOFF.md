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

## 0. Read this first — three things that outranked the open question in §4

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
built, shipped, loaded, normalised, cross-referenced and summarised in the
panel. **Phase F is now built too**, and both open items from this handoff are
closed.

**The open question is answered, and the answer was not the expected one.** The
wash was never invisible and never buried: it covered 64% of the frame and
measured ΔE 21 — plainly visible. It was the wrong *shape*, drawn as one
translucent rectangle per 0.25° cell at a flat alpha, which double-blends into
seams and carries no ranking. Phase F draws contiguous banded polygons with
hard edges and band-ramped alpha: **ΔE 21 → 52**, entities 115 → 72. Full
figures and the reasoning reversal in **§4**.

**The production `.gz` gap is fixed.** A build now ships 24 payloads, every one
byte-identical to source, 14,721,326 bytes (§5).

What remains open is honest and small: whether `polygon.outline` actually
strokes at a defined height (§4), and whether the wash holds up under
photorealistic tiles, which this machine cannot test — it has no `.env`, so it
boots keyless.

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
| **The wash is legible and shaped** | `npm run qa:storm-swath`: mean colour ΔE **51.96** (max 110.37), footprint 357,818 px = 75.76% of frame, repeatable to the pixel on a second toggle cycle. Was ΔE 21.18 / 64.25% as per-cell rectangles |
| **A production build ships the data** | `npm run build` → 24 `.gz` payloads in `dist/assets/local_data/storm/`, every one byte-identical to source by `cmp`, 14,721,326 bytes |

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

## 4. RESOLVED: it was never buried — it was the wrong shape

**This section answered the open question. It did not go the way it was
written to go, so read the correction before the history.**

The question was *is the wash invisible, or merely faint?*, with depth
occlusion under photorealistic tiles as the leading hypothesis and "if it is
faint, the fix is contrast and nothing more structural" as the fallback.
`npm run qa:storm-swath` (Phase 1's harness) answered it by measurement
instead of opinion. Camera 23.7 km over one known-drawn cell at 34.125 N,
100.875 W, on the keyless `esri-imagery` ground:

| | Before | After Phase F |
|---|---|---|
| wash footprint | 303,480 px (64.25%) | 357,818 px (75.76%) |
| mean colour ΔE | **21.18** | **51.96** |
| max colour ΔE | 43.61 | 110.37 |
| entities drawn | 115 per-cell rectangles | 72 rings |
| repeatability | 303,478 px on a second cycle | 357,818 px, exact |

Three things follow, and none of them is "raise the contrast":

1. **Occlusion is dead.** The old rectangles covered two thirds of the frame.
   Nothing was buried. The `height: 0` ellipsoid surface was not under
   anything on this ground, and §4's own caveat — that the hypothesis was never
   ranked against the toggles being off — turned out to be the real lesson.
2. **Faintness was never the problem either.** ΔE 21 is a colour difference
   plainly visible to the eye; the screenshot showed an obvious green tint.
3. **The wash was the wrong SHAPE.** One flat translucent rectangle per
   0.25° cell at a uniform alpha. Neighbouring rectangles double-blend along
   every shared edge, which draws a lattice of darker seams over the storm, and
   a uniform alpha means a fringe cell looks exactly as strong as a core. It
   read as a green box, not a swath. Phase F fixed it by drawing contiguous
   banded polygons: ΔE 21 → 52, a 2.45× improvement, and the seams are gone by
   construction.

### The reversal worth reading twice

Phase F's polygons use a **defined height, not `CLAMP_TO_GROUND`** — against
the advice §4 gave an hour earlier. Both measurements were right and they
contradict the usual reading of each other:

- The `height: 0` rectangles were never buried (ΔE 21, 64% of frame), so
  there was nothing to fix by clamping.
- Clamping **72 polygons** killed the renderer process outright, because each
  ground-classified shape carries a shadow volume spanning the global
  approximate terrain range. The plan's vertex objection was real — it was
  just attached to the wrong shape, and to rectangles rather than polygons.

So: polygons for the shape, a defined height for the cost. On this scene's
keyless globe the ground *is* the ellipsoid, which is the surface `height: 0`
already sat on.

`polygon.outline` is set and asserted, but whether it strokes at a defined
height is **unverified** — Cesium accepts the property silently either way, and
the harness reports the wash footprint regardless. Measured, not assumed, as
promised. If a future ground regime really does bury these, the first thing to
change is `addSwathRingSet`'s height, and the evidence will be in
`qa:storm-swath`.

### What is still true about occlusion, for whoever needs it

`scene.globe.depthTestAgainstTerrain` is `false` — the **Cesium default**;
nothing in `src/` sets it. It covers the ellipsoid's own terrain, not 3D tiles.
`renderOutline` (`index.js:1509`), `hailwind/index.js:611` and
`perimeters/index.js:316` all clamp in this scene without trouble, so clamping
is not forbidden here — it is simply expensive at this entity count.

---

## 5. FIXED: production builds shipped no storm data

**Status: done** (`build/storm-assets.js`, verified on a real `npm run build`).
24 payloads copied, every one byte-identical to source by `cmp`, 14,721,326
bytes. `find dist -name '*.gz'` went from **0** to 24. The section is kept
because the *reason* it was invisible for so long is worth not rediscovering.

Unrelated to the swaths, and the reason nobody saw it:

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

**Fix (landed):** a Vite plugin, `build/storm-assets.js`, registered in the `plugins`
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
| `entity.id` | **CORRECTION — this entry was wrong.** `entity.id` reads back fine: all 136 ids on the storm data source are readable strings. The real trap is one level up: **`viewer.entities` is EMPTY**, because layers own their own data sources. A probe of the default collection finds nothing and concludes "the swaths never render" — which is the false finding that nearly caused a "fix" to working code. | Walk `viewer.dataSources[i].entities`, or use the PropertyBag the renderer stamps: `{swath: true, key: id}` (`addSwathCell`/`addSwathRingSet`) |
| `EntityCollection.values` | It is an **array getter**, not a method — so `values()` yields nothing. But it is *not* uniterable. Guarding on `typeof values !== 'function'` skips every collection and reports "0 entities" while they are full; `qa-storm-swath.mjs` made exactly that mistake and read zero. | `for (const e of collection.values)` — no call parens. `.length` on it is fine. |
| `entities._entities` | Exists, but iterating it yields items whose `.id` is `undefined` — it is not what it looks like | `getById()` |
| `camera.positionCartographic` | `.latitude` / `.longitude` come back in **radians**, not degrees. 0.6, −1.75 is Oklahoma, not the Gulf of Guinea. | Multiply by 180/π, or trust `gev-control state`, which reports degrees |
| `globe.getHeight({lat, lon})` | Returns `undefined` for a plain object, even with `tilesLoaded: true` | Needs a real `Cartographic`; no route to one was found |
| Vite HMR | **Every edit to the layer file reloads the module and resets both swath toggles to off.** This is the most likely reason the operator saw an empty map. | After any edit, re-stage the toggles and the date before looking |
| `RectangleGraphics` options | Silently ignores anything not in its documented list. `disableDepthTestDistance` compiles, runs, does nothing. | A test asserting the property is the cheapest guard |
| `ellipsoid.cartesianToCartographic` | Returns **radians**, like every Cesium coordinate accessor. Read raw it aimed a camera at 0.6 N, 1.76 W — the Gulf of Guinea — and produced a clean "the swaths are not drawn" finding caused entirely by units. | Multiply by 180/π. **Assert the aim point is on land** before believing a 0px result |
| `dataManager.layers.get(id)` | Returns a lifecycle **record**, not the layer. `setHazard` is undefined on it. | `record.module` — the module with the layer's API |
| `fly_to_location` | Takes `rangeM`. Iterating `adjust_camera_zoom` to approximate it instead walks the camera to a **negative height**, inside the ellipsoid. | Pass `rangeM`, then *verify* by reading `camera.positionCartographic.height` back |
| The render governor | `requestRender()` does not guarantee a frame. Two screenshots of two different states come back **identical** while the live screen plainly differs — which reads as "the swaths are not drawn". | Call `scene.render()` directly before every capture |
| The live HUD | The instrument panel re-renders every frame (REC clock, DOLL, ALT, GSD). Comparing whole-frame captures reads **80–320 px of telemetry churn** and mistakes it for instability or for a wash. | Diff a central window only; the harness masks an 18% margin |
| Imagery still streaming | Two captures taken mid-load differ for reasons unrelated to the swaths. | Wait on `globe.tilesLoaded` before capturing (timeout-guarded) |
| A bounding box is not a storm | The day's radar field spans the whole ingest domain (21.75–52.75 N). Framing its bounding box parks the camera ~900 km up and shrinks the wash to 0.19% of the frame. | Aim at one **known-drawn cell**, or the densest cluster |
| `polygon.outline` | Accepted silently; whether it strokes at a defined height is unverified here. | Assert the property (free), and read the footprint from `qa:storm-swath` |

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

Fifteen commits on `contrib/storm-scope-20261015`, `f54e2c4a..ca89bf2e`:

```
ca89bf2e fix: production builds ship no storm data at all
35dfdf64 feat: draw the swaths as banded polygons, the shape the category draws
58dad531 qa: measure the swath wash instead of asking whether it is there
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
- **The swath polygons' defined `height: 0`.** Not an oversight — Phase F
  measured that `height: 0` rectangles were never buried (ΔE 21, 64% of frame)
  and that clamping **72 polygons killed the renderer process**, each
  ground-classified shape carrying a shadow volume over the global terrain
  range. Polygons for the shape, a defined height for the cost. The full
  reasoning is in §4 and the note on `addSwathRingSet`; changing it back needs
  evidence from `qa:storm-swath`, not a preference.
- **The keyless globe is a supported shipped state, not a degraded one.** No
  `.env` exists in the repo; `google3d.js:12-14` falls through to `'osm'` and
  `scene.js:82-99` initialises `esri-imagery` with `globe.show = true`. The QA
  suite already treats this as a branch worth proving (`qa-map-source-tray.mjs`
  has a `--keyless` flag). It is also a free control for any "is it buried"
  question.

If a future reader believes one of these is broken, the burden of proof is on
them, and §6 explains how the last three such claims arose — §11 lists six of
my own, including two that were in a straight-faced table. For the last three,
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

## 10. What is left, in the order I would do it

Both original items are closed (§4, §5). What remains is short, and none of it
blocks anything.

1. **Confirm the wash under photorealistic 3D Tiles.** The one thing this
   machine cannot do: no `.env`, so it boots keyless on `esri-imagery`, and
   every measurement above is from that regime. On a keyed machine,
   `npm run qa:storm-swath` reports which regime it ran in — check
   `report.regime` before quoting a figure. If the wash vanishes on tiles, the
   first change is `addSwathRingSet`'s height, and this §4 section is the
   evidence for why it is a defined one.
2. **Verify `polygon.outline` actually strokes.** Set and asserted, but Cesium
   accepts the property silently whether or not it draws, so the assertion only
   proves it was *set*. If it does not stroke, the hard edge needs a
   `PolylineGraphics` boundary ring at the same height — the house pattern is
   `perimeters/index.js:316`.
3. **Persist the two swath toggles.** Both still initialise `false`
   (`index.js:421-422`), so an HMR reload still silently empties the map. This
   is the trap that produced the original false finding, and it is one
   regression test away from being closed for good.
4. **Tune the top of the alpha ramp if it reads too heavy.** `SWATH_ALPHA_MAX`
   is 0.72; at the top band the terrain under the wash is dim. The category is
   saturated too, so this is a taste call rather than a defect — but it is a
   single constant and it is the obvious next dial.

## 11. What this session got wrong, for the record

Kept because the whole point of §6 is that instruments lie, and these were all
mine:

- I ranked occlusion above "the toggles were off", which was the actual
  explanation for the original report, and it is written in a
  straight-faced table in §0.
- I claimed `entity.id` was unusable. It is fine. `viewer.entities` was empty.
- I used luminance contrast to judge a coloured wash, which called a plainly
  visible green fill "1.015:1, not legible". The fix is CIE76 ΔE.
- I asserted `CLAMP_TO_GROUND` was safe on the strength of three in-repo
  examples, then clamped 72 polygons and killed the renderer.
- I read `camera.positionCartographic` as degrees in the harness's own aim
  logic — the exact trap this document lists second — and flew a camera into
  the Gulf of Guinea, where it correctly reported no swaths.
- Every one of those produced a confident, clean, wrong number.

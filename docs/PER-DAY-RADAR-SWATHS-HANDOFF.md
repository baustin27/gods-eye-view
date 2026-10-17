# Per-Day Radar Swaths — Handoff

State of `docs/PER-DAY-RADAR-SWATHS.md` Phases A–E as of `be814a2a` on
`contrib/storm-scope-20261015`, and the two things still open.

Read this before touching the layer. Most of what follows is **how not to waste
a day on instruments that lie.**

---

## 1. The short version

Phases A–E are built, merged, committed and green. The per-day radar field is
built, shipped, loaded, normalised, cross-referenced, summarised in the panel,
and rendered into the scene as rectangles.

**One thing is unverified: whether the swaths are actually visible to the
operator.** The entities are provably in the scene. The operator reports seeing
only the pins. The leading hypothesis is depth occlusion under Google
Photorealistic 3D Tiles, and it is **not yet proven** — see §4.

One thing is **known broken** and approved for fixing: production builds ship no
storm `.gz` payloads at all (§5).

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

## 4. The open question: is the wash visible?

### The state that produced the report

Camera 40 km over west-central Oklahoma (34.4 N, 100.3 W), date **2026-10-13**,
HAIL, both toggles on. 15 REPORTED rectangles and the RADAR rectangles all
present via `getById`. Operator sees **dots only**.

### Leading hypothesis — occlusion

`addSwathCell` (`src/layers/stormReports/index.js:1224`) creates the rectangle
with `height: 0`. That is the **ellipsoid surface**. This scene's ground is
Google Photorealistic 3D Tiles at real elevations, and tiled geometry is an
ordinary depth-tested primitive — so a cell at sea level renders *underneath* the
terrain. It builds, it costs the vertex budget, and nothing appears.

The pins are visible only because point primitives carry
`disableDepthTestDistance: Number.POSITIVE_INFINITY`
(`index.js:1304`). **`RectangleGraphics` has no such option** — verified in
`node_modules/@cesium/engine/Source/DataSources/RectangleGraphics.js`. Its full
option list is `show, coordinates, height, heightReference, extrudedHeight,
extrudedHeightReference, rotation, stRotation, granularity, fill, material,
outline, outlineColor, outlineWidth, shadows, distanceDisplayCondition,
classificationType, zIndex`. There is no one-line fix in the pins' direction.

`scene.globe.depthTestAgainstTerrain` is `false`, but that covers the
ellipsoid's own terrain, **not** 3D tiles.

### Do NOT start by changing the code

The first question is unanswered and only the operator can answer it: **is the
wash invisible, or merely faint?** A 34%-alpha band over a busy photorealistic
basemap at 40 km may just be hard to see. Change nothing until they look at a
freshly staged scene and describe what they see — none, faint, partial.

### If it is occlusion, the options, honestly

1. **`heightReference: CLAMP_TO_GROUND` + `granularity`.** The standard Cesium
   idiom for ground-conforming geometry. Caveat worth knowing up front: Cesium's
   ground clamp samples the *globe*, so under photorealistic tiles it may still
   be buried. Cheap to try, not guaranteed.
2. **Lift per cell above local terrain** — needs a terrain height source.
   Reliable, but see §6: reading terrain through this API has been awkward.
3. **Move the wash out of Cesium geometry** into the layer's existing
   `overlayHost`, which already carries labels and storm cards. Always on top by
   construction, no depth fight. Bigger change; loses the "a place on the
   ground" quality that makes a swath read as geography.

Note this overrides an explicit instruction in the plan (§6 D2: "**`height: 0` +
`granularity`, NOT `CLAMP_TO_GROUND`**"). That instruction was written from a
Denver vertex measurement and, as far as anyone can tell, never checked against
what the operator actually sees. **Record the reason for the reversal in the
commit message** — this is exactly the kind of decision that gets reverted by
the next person who reads the plan and not the history.

---

## 5. Known broken: production builds ship no storm data

Approved for fixing, unrelated to the swaths.

The loaders build their base by string surgery on `import.meta.url`
(`src/data/stormReports.js:36`), so a built chunk resolves to
`<origin>/assets/local_data/storm/`. `vite build` copies **nothing** there.
Measured: `dist/assets/` holds only five hashed `.geojsonl` and the small
sidecars inlined as data URIs. **No `.gz` of any kind.** A static host answers a
per-day request with the SPA shell and a **200**, via the SPA fallback — which
is why the loader keys "absent" on the payload's shape rather than the status
code (`src/data/stormReports.js`, `indexRadarDays`).

Under the Pinokio launcher this works: it runs Vite's **dev** server
(`scripts/pinokio-start.mjs:41`), which serves `src/data/local_data/storm/*`
straight from source. Confirmed live — 200, `Content-Encoding: gzip`, 712,667
bytes, gzip magic `1f 8b`.

**Fix:** a Vite plugin, `build/storm-assets.js`, registered in
`createBrowserViteConfig` (`build/vite.js:60`) so it covers both the main build
and the panel build — `panelBuildConfig` spreads the same config, keeping
plugins. A `closeBundle` hook copies the runtime-fetched `.gz` payloads to
`<config.base><assetsDir>/local_data/storm/`, **derived from config, never
hardcoded**, so `/assets/` and `/panel/assets/` both resolve. Mirror
`build/panel.js`'s style.

Copy only the `.gz` payloads. The five plain `.geojsonl` are already emitted
hashed by the bundler and the small sidecars are inlined as data URIs; copying
them would duplicate ~27 MB for nothing.

- Test: `src/tooling/stormAssetsBuild.test.mjs`, matching `viteBuild.test.mjs`.
  Assert registration, the file selection, and that the destination derives from
  base + assetsDir.
- Build check: `dist/assets/local_data/storm/storm_radar_hail_perday_2026.bin.gz`
  exists and is byte-identical to source. As a `qa:*` script, not a unit test —
  building in the suite is too slow.
- **Cost to flag:** dist grows ~15 MB. There is no way to serve files you do not
  ship.
- Ticks the plan's §9 item *"Production-build check that the new `.gz` is
  actually served"*.

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

And the two that are not traps but rules:

- **There is no screenshot in `gev-control.mjs`.** Visibility is judged by the
  operator. Say what is staged and ask.
- **No agent drives a browser.** Live checks are the orchestrator's job, through
  `scripts/gev-control.mjs` only. Navigating or reloading a CDP target aimed at
  the Pinokio shell has cost the operator his session three times.

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

If a future reader believes one of these is broken, the burden of proof is on
them, and §6 explains how the last three such claims arose.

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

1. Ask the operator to look at a freshly staged scene and say whether the wash
   is invisible or faint. Everything below depends on the answer.
2. If invisible: pick an occlusion strategy from §4 and implement it in a
   worktree, with a test asserting the property actually lands — the
   `RectangleGraphics` option list is short and Cesium ignores the rest without
   complaint.
3. Independently and in parallel: the `build/storm-assets.js` fix from §5. It
   touches no layer code.
4. Re-verify live: both toggles painting, swaths ordered before pins,
   `height`/`granularity` as decided, and the day's unreported-cell count in the
   panel.
5. Tick the plan's §9 boxes that are now genuinely satisfied.
# Per-Day Radar Swaths — Implementation Plan

Approved plan for making hail **swaths** on the storm map, the way the
roofing-canvassing category draws them, without claiming more than the data
supports.

Supersedes nothing. Builds on `docs/NEXT-ITERATION.md` (the approved roofing
brief) and `docs/CURRENT-STATE.md` (the measurement record).

**Start here:** `docs/CURRENT-STATE.md` § "What the renderer wedge turned out to
be" for the performance context, and `docs/NEXT-ITERATION.md` for the audience
and priorities.

---

## 1. What the category does, and what we are copying

Visual research across HailTrace, HailMaps, HailMate, HailPing, Interactive
Hail Maps, THOR Storm Mapper, StormConnect, HailTrack.io and hail.org found a
consistent pattern:

| Pattern                                                                                       | Who does it                                                                                   |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Size-banded polygon swaths** — 0.75/1/1.5/2″+ — not dots                                    | HailMate, HailMaps, HailTrace (1″/1.75″/2.5″+), hail.org                                      |
| **Report pins drawn ON TOP of the swath**                                                     | HailMaps: "SPC & mPING reports displayed as point data alongside radar swaths"                |
| **Multi-date combine** — overlay dates to find repeatedly-hit areas                           | Interactive HailMaps "Combine", HailMate "three years at once", HailTrace "Honey Hole Finder" |
| **Size→object nickname**                                                                      | "2.5″ _(tennis ball)_", "1.25″ _(quarter)_", "Hen Egg (2.00 in.)"                             |
| **Severity grade**                                                                            | Extreme / Severe / Moderate / Light; THOR scores 0–100                                        |
| **Impacted places list** — states, cities, ZIPs                                               | HailTrace, Interactive Hail Maps                                                              |
| **Address check** — radar estimate at the point + reports within 5 mi, with distance          | HailTrack.io                                                                                  |
| **Field-readable map** — clean colours, city labels stay on, colourblind modes, layer toggles | HailTrace 5.0                                                                                 |

Two findings shape this plan:

1. **Every one of these apps uses swaths AND pins together.** The dots are not
   the wrong visual — they are the pins-on-top-of-the-swath pattern. Our
   measured hail sizes are the measured stones under a radar estimate.
2. **The swaths are MRMS-derived.** One competitor states it plainly: _"HailTrace
   and Interactive Hail Maps charge $999/mo and up for what is essentially the
   same NEXRAD/MRMS feed every weather company has access to."_ We already ship
   that feed, keyless and free.

So this is not a paid-data problem. It is a **pipeline** problem: our builder
discards the per-day radar field, so we cannot draw a per-day swath.

---

## 2. What unlocks

`src/layers/stormReports/index.js` currently **refuses** to publish the
radar-only count, and the docstring names the exact failure:

> _"Against a 33-report day in a 14,850-cell year that produced '14,832
> unreported radar cores', which is not a finding about that day, it is the
> year. A roofer would read it as a list of streets."_

A per-day artifact fixes precisely that. It turns an annual total into
_"on 14 August, radar showed hail cores in 40 cells across Kansas and nobody
reported a stone."_ That is the honey hole the category charges $999/month for.

---

## 3. Key facts about the rebuild

Measured, not assumed:

- **The download is already paid.** All 2,114 MRMS files (1,060,155,172 bytes)
  sit in `.gev-cache/build/`, complete and gap-free for 2021-01-01 →
  2026-10-15. The rebuild is a **~14-minute offline CPU pass** (0.40 s/day ×
  2,114). `--concurrency` does not shorten it: `zlib.gunzipSync` and
  `decodeValues` are synchronous, so the pooled workers only overlap network.
- **Record count is exactly derivable** from committed data: Σ`dy` across the six
  year files = **253,016 (cell, day) pairs** at the 25 mm threshold.
  Cross-checks against `corePointCount` (8,380,588 vs 8,384,616) to 0.05%.
- **Encoding.** 6-byte triples `u16 cellIndex, u16 dayIndex, u16 maxMm×10`,
  sorted by `(dayIndex, cellIndex)`. `uint16` is safe: the emitted index space is
  140 rows × 260 columns = **36,400 cells** (the domain filter at `:204` has no
  eastern bound, so the space is larger than the geographic width implies).
- **Size.** ~1.45 MiB raw / ~0.8–1.1 MB gzipped **at the 25 mm threshold**. We
  are retaining from **10 mm** (decision below), so the real number is larger and
  **must be measured on the first run**. Low megabytes gzipped is the
  expectation. Do not quote a number before measuring it.

---

## 4. Decisions taken

| Decision                   | Choice                                           |
| -------------------------- | ------------------------------------------------ |
| What drives the swath fill | **Both**, as two toggles: REPORTED and RADAR     |
| Per-day radar swath        | **Rebuild the pipeline** (cache is already paid) |
| Sub-threshold retention    | **Keep from 10 mm up**                           |

### The two-threshold split

Lowering retention to 10 mm must **not** change the existing artifacts. Today one
threshold at `:198` does double duty — discard, _and_ decide what gets emitted.
Split it:

| Constant                   | Value | Role                                                                                                                              |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| `HAIL_RETAIN_MM` (**new**) | 10    | what the **per-day** artifact keeps                                                                                               |
| `HAIL_CORE_MM` (existing)  | 25    | what counts as a core — still coupled to `stormCrossReference.js:118`, still literal-pinned by `stormCrossReference.test.mjs:279` |

**Invariant:** the per-year and combined GeoJSONL files apply `HAIL_CORE_MM` on
the way out and stay **byte-identical**. Only the new per-day artifact sees the
10 mm floor.

---

## 5. Orchestration

Execution is **orchestrator-driven with subagents in isolated git worktrees**,
maximum **4 agents at a time**, tasks granular enough to review individually.
Worktrees are merged once each phase's gate passes.

### Worktree mechanics

- `git worktree add .gstack/worktrees/<slug> feature/<slug>` — `.gstack/` is
  already in `.gitignore` (line 20), so worktrees never pollute status.
- **`/gstack-spawn "<task>"` is a slash command, not a binary.** There is no
  `gstack-spawn` on `PATH`; it must be invoked in-session. It creates the branch,
  the worktree, and launches `opencode run` inside it. Agents auto-commit and are
  harvested with **`/gstack-weave`**. `/gstack-status` shows heartbeat and state.
- `opencode` **is** on `PATH` (`~/.local/bin/opencode`), so if a task needs a
  different launcher shape it can be driven directly — but prefer the skill.
- Suggested branch names: `feature/radar-days-a1`, `feature/radar-days-b`,
  `feature/swath-d1`, etc., so `git branch` reads as the plan.

### Fan-out discipline

- **Never more than 4 concurrent worktrees.** Phase B's cache is shared on disk;
  the Phase A rebuild is CPU-bound and single-threaded per day. Running multiple
  agent branches is fine; running multiple _rebuilds_ concurrently is not.
- **Each task names its own files.** Two agents editing one file is the failure
  mode to design out, not discover at merge time. File ownership is listed per
  task below.
- **No agent drives the browser.** Verification in the app is the orchestrator's
  job, via `scripts/gev-control.mjs` only. This is a hard rule: an agent
  navigating a CDP target against the Pinokio shell has cost the operator his
  session three times.
- **Every agent must leave the full suite green** and run `npm run format:check`,
  `node scripts/check-import-directions.mjs`, and
  `node scripts/check-layer-state-tokens.mjs --base-ref HEAD`.

---

## 6. Phases

### Phase A — Builder (agent 1, then agent 2)

**A1 — hardening** _(agent 1; files: `scripts/build-storm-radar-snapshots.mjs`,
`scripts/build-storm-radar-snapshots.test.mjs`)_

- Extract the `:204` domain triple (`lon < -125 || lat < 21 || lat > 56`) into an
  exported, **tested** constant. It becomes load-bearing 16-bit geometry; a
  one-unit error silently misplaces every cell with no error anywhere. This is
  the weakest link in the whole rebuild and it is currently untested and
  unexported.
- Export the row/column bases and index stride used for the binary encoding.
- Add `HAIL_RETAIN_MM = 10` alongside `HAIL_CORE_MM = 25`; apply the retain floor
  on the way into the new per-day accumulator and `HAIL_CORE_MM` on the way out
  to the existing GeoJSONL.
- Tests: the domain constants; that a cell at the boundary is in or out per the
  documented rule; the existing 8 property keys still
  `deepEqual ['cp','d','dy','i','j','mx','y0','y1']`.

**A2 — per-day artifact** _(agent 2; same files, after A1 merges)_

- Accumulate `cell.perDay` at `:222-224` — the only real change. `cellFeature`
  builds `properties` key-by-key, so a new field **cannot leak** into the JSON.
- Accumulator stays **O(records)**, never holding a 98 MB `Float32Array` across
  a run; only one alive at a time.
- New binary writer beside `writeGeoJsonlGz`: 6-byte triples, sorted by
  `(dayIndex, cellIndex)`, gzip level 9, no mtime, tmp-then-rename — matching the
  existing byte-determinism convention.
- Record the **day-index epoch in the sidecar**. The window end moves every
  rebuild, so an artifact re-read later would silently mis-date every record.
- **Run with `--to 2026-10-15`.** The `to = yesterday` default means a bare
  rerun tomorrow produces a different artifact from the committed one. The
  README's byte-exact reproduction claim is subtly wrong about this — fix it.
- Test: `uint16` overflow asserted. `maxMm × 10` peaks at 14,374, safe. A 0.01 mm
  scale would give 143,740 and **overflow** — pin the scale.
- Test: the known `171:-406` fixture from the existing real-GRIB test resolves to
  the same cell index.
- Respect `keptKeys` / `restrictYearsToKeys` so a future `MAX_CELLS` truncation
  cannot orphan day records.

**GATE A — hard stop.** The 7 existing artifacts
(`storm_radar_hail.geojsonl`, 6 × `storm_radar_hail_<year>.geojsonl.gz`, 7
sidecars) must be **byte-identical**. If they are not, stop and diagnose before
proceeding. Note that `builtAt` changes every run, so sidecar diffs alone are
expected and are not a data change.

### Phase B — Byte-preserving loader (agent 3)

_(files: `src/data/stormReports.js`, `src/data/stormReports.inflateHelper.js`,
`src/data/stormReports.test.mjs`)_

- The existing `inflateMaybeAlreadyInflated` → `TextDecoder` path **would corrupt
  `uint16` triples**. Add a byte-returning sibling.
- **Keep the gzip-magic sniff.** `stormReports.test.mjs:383-419` pins both
  directions: the dev server sends `Content-Encoding: gzip` and fetch
  pre-inflates, while other servers return opaque bytes.
- `loadRadarDaysForYear` beside `loadRadarForYear`: 404 → empty, memoised,
  in-flight joining via the same `once()` pattern.

**GATE B:** existing loader tests unchanged and passing.

### Phase C — Consumer and the honest claim (agent 4)

_(files: `src/data/stormDatasets.js`, `src/data/stormCrossReference.js`,
`src/data/stormRadar.test.mjs`, `src/layers/stormReports/index.js`,
`src/app/layers/stormReports.js`)_

- `toRadarDays()` sibling to `toRadarRecord`. `toRadarRecord` is a strict
  normaliser and would reject a per-day record — it needs a sibling, not a change.
- `indexRadarCells` already emits `Map<'i:j', {mx, cores}>`; emitting the same
  shape means **`crossReference`, `summariseAgreement` and `canvassTargets` need
  nothing**.
- Wire at `src/app/layers/stormReports.js:36` — **the one production file that
  changes**.
- Add the day to the `comparisonKey` memo (`:742-751`) — it currently keys on
  date+hazard+size+rowcount+yearbase.
- **Rewrite `comparisonLine`'s copy** (`:1371-1407`). It documents _why_ it
  withholds the radar-only count, and that reason disappears. This is a **UI
  change disguised as an ETL change**.
- Apply `RADAR_IMPLAUSIBLE_MM` **per day**. A 100 mm _day_ reading is far more
  credible evidence than a six-year lifetime 100 mm reading, so the artefacts
  count will legitimately change value. Expect and say so in the UI.
- Do **not** repoint the lifetime consumers: `stormScoring`, `hailwind/*`,
  `radarGapScore` are climatology and a per-day artifact is the wrong scale.

**GATE C:** full suite green; panel tests updated for the new copy.

### Phase D — Swath rendering, both toggles (agents 5 and 6, in parallel)

_(agents 5: `src/layers/stormReports/`; agent 6: pure model helpers in
`src/layers/stormReports/model.js` + tests — coordinate so they do not collide on
`index.js`)_

**D1 — pure model** _(agent 6, first)_

- `reportedSwathCells(reports, {hailFloor})` → cells coloured by the **largest
  hail reported** in them, banded on the existing 1 / 1.5 / 2 / 2.5 / 3″
  thresholds. Every pixel traces to a measured stone.
- `radarSwathCells(radarDays, {date, implausibleMm})` → cells coloured by
  per-day radar max, artefacts flagged.
- Both pure and node-testable. No Cesium.

**D2 — rendering** _(agent 5, after D1 merges)_

- Two chips: **REPORTED** and **RADAR**.
- Render on the hailwind cell-rectangle pattern (`hailwind/index.js:587-605`),
  using the isolation-layer lesson: **`height: 0` + `granularity`, NOT
  `CLAMP_TO_GROUND`**. A ground-classified rectangle expands into a shadow
  volume spanning the global terrain range; Denver measured 66,067 vertices for a
  flat wash, reduced to 2,851 by a defined height and 5° granularity.
- Static axes only — never a `CallbackProperty` (see the comment at
  `hailwind/index.js:589-591`).
- **Pins stay on top.** That is the HailMaps model.

> **AMENDED TWICE — D2's height instruction is superseded. Do not apply it.**
>
> It was superseded once to `CLAMP_TO_GROUND`, then superseded AGAIN by Phase F to
> a defined `height: 0`, after clamping 72 polygons killed the renderer. Read
> Phase F, not the amendment below, for the shipped answer.
>
> This subsection told the implementer `height: 0` + `granularity`, **NOT**
> `CLAMP_TO_GROUND`, citing a Denver vertex measurement — taken on the
> **isolation** layer, two instructions after naming `hailwind/index.js:587-605`
> as the pattern to copy. **`hailwind` clamps to ground** (`:611`), tens of
> thousands of cells, visibly. So the instruction contradicted its own
> precedent, and the swaths it produced are per-cell translucent rectangles at
> the ellipsoid surface, which the operator could not see.
>
> Three controls in this repo prove clamping renders here: `renderOutline`
> (`src/layers/stormReports/index.js:1386-1392`) is a clamped, outlined polygon
> in the same data source; `hailwind/index.js:611`; `perimeters/index.js:316-322`
> (clamped polygons **with holes**, which Phase F needs).
>
> **Phase F replaces D2's geometry entirely.** D2's other instruction — static
> axes, never a `CallbackProperty` — stands, and its pins-on-top requirement is
> asserted at `layerLifecycle.test.mjs:1177-1199` and must survive the swap.

**GATE D:** full suite green; live check for both toggles.

### Phase E — Category details (agents 7 and 8, in parallel)

- **E1** _(agent 7: `src/layers/stormReports/model.js` + its tests)_ — size→object
  nicknames: quarter, golf ball, tennis ball, hen egg. `trimInches` already
  exists at `model.js:214`.
- **E2** _(agent 8: `src/layers/stormReports/index.js` + tests)_ — impacted
  places list from the county/city fields every report already carries; and
  multi-date combine riding the **existing** date-range slider.

**GATE E:** full suite green, format, token checker, import directions.

### Phase F — HailTrace fidelity _(BUILT — measured, see below)_

**Outcome.** Delivered as banded polygons. Measured before and after on the
same cell, same camera (`npm run qa:storm-swath`, keyless `esri-imagery`
ground, 23.7 km over 34.125 N / 100.875 W):

| | Before | After |
|---|---|---|
| wash footprint, keyless | 303,480 px (64.25%) | 366,805 px (77.66%) |
| **wash footprint, tiles (ships)** | **0 px (0.0%)** | **376,157 px (79.64%)** |
| mean colour ΔE | 21.18 | **51.9** |
| entities drawn | 115 per-cell rectangles | 72 rings |

Two findings, and the second one is the one that matters:

1. The wash was the wrong **shape**. Neighbouring translucent rectangles
   double-blend along shared edges, so it drew darker seams over the storm and a
   uniform alpha left a fringe cell as strong as a core. Contiguous polygons
   remove the seams by construction.
2. The wash was also **buried** — and that was missed entirely at first, because
   the measurement was taken on the keyless globe. `pinokio/ENVIRONMENT` carries
   a `CESIUM_ION_TOKEN`, so the launcher boots Photorealistic 3D Tiles with
   `globe.show = false`, and at `height: 0` the wash measures **0 px**. This
   repo has no `.env`, which makes the keyless regime easy to measure by
   accident and useless as a proxy.

**One reversal, and it is a restoration.** D2 said `height: 0`, NOT
`CLAMP_TO_GROUND`, citing a vertex count from the isolation layer. It was
overruled to `CLAMP_TO_GROUND`, then overridden back to `height: 0` on the
strength of a renderer crash observed under headless **SwiftShader** — software
rendering, not the operator's GPU. Both of those moves were mistakes, and the
second one shipped an invisible feature.

The shipped answer is **CLAMP_TO_GROUND**, measured on the regime that boots
(same cell, 23 km camera, operator's token):

| placement | footprint | % of frame |
|---|---|---|
| `height: 0` | 0 px | 0.0% |
| **`CLAMP_TO_GROUND`** | 191,543 px | 40.6% |
| altitude 300 m | 376,909 px | 75.1% |

A fixed altitude also draws but floats the wash above the ground; clamping is
the honest choice, and only a *draped* shape is partly hidden by terrain. The
shadow-volume worry was re-checked on the tiles regime with 72 clamped entities
across five placement candidates: no renderer failure.

**`report.regime` is part of every result.** `npm run qa:storm-swath` prints
which ground it booted, and the gate fails below a 1% footprint floor — because
an invisible wash still moved 45 px of live HUD churn and the harness read that
as paint.

**Why this phase exists.** Phases A–E made the data correct and drew it. What
they drew does not read like the category. The reference behaviour, from
HailMate's own description of a HailTrace substitute:

> hail swaths **colour-banded by stone size, from yellow through red to
> purple**… "**not a county blob**… the polygon follows the storm"… legend at
> **0.75″ / 1″ / 1.5″ / 2″+**… **pins sit on top of the swaths**.

`renderSwaths` currently emits **one independent `RectangleGraphics` per 0.25°
cell** at a flat `SWATH_ALPHA = 0.34`. Neighbouring translucent rectangles
double-blend along shared edges, so the wash reads as a **grid with darker
seams** rather than a swath — even when fully visible. Contrast alone does not
fix that, and the handoff's earlier "the fix is contrast and nothing more
structural" is withdrawn.

**F1 — pure ring extraction** _(agent; `src/layers/stormReports/model.js` +
`model.test.mjs`)_

- Per band, take the occupied `i:j` cell set and trace its boundary on the
  integer lattice (**marching squares**, hand-rolled — no new dependency) into
  `{ outer, holes[] }` rings in cell-corner coordinates.
- Pure, node-testable, no Cesium — the D1 rule.
- Deterministic vertex order, so the renderer cannot reorder differently per
  run and so tests can assert exact rings.

**F2 — polygon render** _(agent; `src/layers/stormReports/index.js` + lifecycle
tests, after F1 merges)_

- One entity **per ring set**, not per cell: `PolygonHierarchy(outer, holes)`,
  `heightReference: CLAMP_TO_GROUND`, `outline: true` — the `renderOutline`
  recipe at `index.js:1386-1392`, and holes per `perimeters/index.js:316-322`.
- **Band-ramped alpha**, mirroring `hailwind`'s `alphaForRank`, replacing the
  flat 0.34: the core band reads far more opaque than the fringe.
- Static axes only (D2's rule survives). Pins still added last.

**Acceptance criteria — checkable, not aesthetic:**

| # | Criterion |
|---|---|
| 1 | Drawn swath entity count equals **ring** count, never cell count |
| 2 | No alpha seams: adjacent same-band cells share an edge in one polygon |
| 3 | Alpha is non-decreasing with band rank; two bands never share an alpha |
| 4 | Every swath polygon entity has `outline === true` |
| 5 | Pins still render above every swath (existing assertion must pass) |
| 6 | Legend covers every band actually drawn (entries already exist) |
| 7 | Legible at **both** 40 km and neighbourhood zoom |

**On `polygon.outline`:** whether Cesium draws it under photorealistic 3D Tiles
depends on its ground depth-test path and is **not to be asserted from memory**.
`npm run qa:storm-swath` measures it. If it does not draw, fall back to a
`PolylineGraphics` boundary ring at the same height.

**Honest limit:** the category's grid is ~1 km; ours is 0.25° ≈ 28 km. Phase F
matches their **visual language**, not their street-level resolution. At
neighbourhood zoom one cell covers the neighbourhood. That is the MRMS feed we
ingest, not a defect, and it is stated so it is not filed as one.

**Tests, each required to fail with its bug restored** (§8's rule):

| Test | Restored bug must fail it |
|---|---|
| donut of cells → 1 outer ring + 1 hole ring | per-cell rectangles |
| entity count == ring count | any per-cell emission |
| alpha non-decreasing with band rank | flat `0.34` |
| `outline === true` on every swath entity | missing hard edge |
| re-mount preserves both swath toggles | HMR reset (the trap that produced a false finding) |

**GATE F:** `qa:storm-swath` shows the wash in both ground regimes, with
before/after shots; all five tests above observed failing against the old
behaviour; full suite green; format, tokens, import directions pass.

---

## 7. Risks

1. **The `:204` domain filter is an inline literal, unexported, untested** — and
   Phase A makes it load-bearing 16-bit geometry. Wrong by one and every cell is
   silently misplaced. Highest-value single test in this plan.
2. **One-way door below the floor.** Everything under 10 mm is still discarded at
   `:198` before accumulation. Retaining from 10 mm opens the door in the safe
   direction; retaining from 0 mm would cost far more and is not planned.
3. **The binary artifact cannot be read by the existing loader.**
   `TextDecoder` corrupts it. Phase B exists solely for this.
4. **`builtAt` changes every run**, so all 7 sidecars will diff even when the
   data is identical. Do not misread a sidecar diff as a data change.
5. **Unverified distribution path.** `dist/assets/` contains only the 5
   GeoJSONL files — **none** of the per-year `.gz` payloads. Whatever mechanism
   serves them must also serve the new file, and it has not been confirmed. This
   may need a real production-build check.
6. **Latent truncation coupling.** 21,947 of `MAX_CELLS = 40,000` today. Past that
   line, a per-day artifact built from the raw accumulator references cells the
   combined file dropped. `restrictYearsToKeys` exists for this class of bug.
7. **Phase C changes a user-visible number.** `split.artefacts` and the radar
   comparison line change value under per-day data. Intended, but it is a
   behaviour change wearing an ETL costume.
8. **Correct data, unreadable picture.** Per-cell translucent rectangles at a
   flat alpha read as a grid with seams, not as a swath. This risk was live for
   the whole of Phases A–E and is only now addressed, by Phase F. It is the
   reason "the entities exist" was never evidence that the feature worked.
9. **Both swath toggles default to `false`** (`index.js:421-422`), and an HMR
   reload resets them. Any visual judgement made without reading the chip states
   is measuring a scene that legitimately has no swaths in it.

### Coupled constants that must hold

| Constant                     | Where                                                               | Pin                                                                        |
| ---------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `HAIL_CORE_MM = 25`          | builder `:93` ↔ `stormCrossReference.js:118`                        | literal assert, `stormCrossReference.test.mjs:279`                         |
| `RADAR_IMPLAUSIBLE_MM = 100` | `stormCrossReference.js:105`                                        | `stormCrossReference.test.mjs:140`; **meaning changes** under per-day data |
| `CELL_DEG = 0.25`            | builder `:95` ↔ `stormCrossReference.js:33` ↔ `stormDatasets.js:41` | now also the binary index geometry                                         |
| domain triple                | builder `:204`                                                      | **none — must be created**                                                 |
| `MAX_CELLS`                  | builder `:97`                                                       | sidecar `truncated` flag                                                   |

---

## 8. Verification discipline

Carried over from the bugs this plan responds to, all of which shipped green:

- **A test that passes with the bug restored is not a test.** For every
  regression test added here, restore the bug, watch it fail, then restore the
  fix. Two tests in this repo passed against the exact defect they were written
  for.
- **Test through the real seam.** The hover feature shipped gated behind a
  cohort that only the direct API bypassed, and the suite was green because the
  harness only ever drove the click handler.
- **Live checks are orchestrator-only** via `scripts/gev-control.mjs`, **and by an
  independent browser.** Nothing may navigate or reload a CDP target aimed at
  the Pinokio shell, and **nothing may touch port 9222** — that is the
  operator's running session, and an agent reload there has cost him the session
  three times. A **separate** headless Chrome launched by
  `scripts/qa-storm-swath.mjs` against its own server on its own port is safe,
  is the house pattern (`scripts/qa-map-source-tray.mjs`), and is the preferred
  way to answer a question about what is visible, because it produces a
  screenshot and a sampled contrast figure instead of an impression.

---

## 9. Definition of done

- [ ] Existing 7 radar artifacts byte-identical across the rebuild
- [ ] New per-day artifact committed with a sidecar carrying its epoch and threshold
- [ ] Full suite green at every phase gate; format, tokens, import directions pass
- [ ] REPORTED and RADAR swath toggles both render, with pins on top
- [ ] The per-day radar-only claim is published, with copy that explains it
- [ ] Production-build check that the new `.gz` is actually served
- [ ] `DATA_SOURCES.md` and `src/data/local_data/storm/README.md` updated —
      including the record-count drift (docs say 12,119 / 3,507 / 37,727; the
      files say 12,094 / 3,514 / 37,245) and the combined-file artefact rate
      (10.9% of cells exceed 100 mm, versus the 1.4% quoted, which is 2026-only)

Phase F status:

- [x] Swaths drawn as contiguous per-band polygons with holes, **not** per-cell
      rectangles — 115 entities → 72 rings; `layerLifecycle.test.mjs` asserts a
      run of four adjacent cells is ONE polygon
- [x] Alpha ramps by band (0.30 → 0.72); a hard edge set on every band boundary
- [x] `npm run qa:storm-swath` measures the wash and reports mean ΔE; ΔE 21.18 →
      51.96 on the same cell. Shots and `report.json` land in `qa-shots/storm-swath/`
      (gitignored — quote the figures, do not commit the PNGs)
- [x] Production build ships the `.gz` payloads: 24 files, all byte-identical to
      source, 14,721,326 bytes (`find dist -name '*.gz'` went 0 → 24)
- [ ] Swath toggles survive an HMR remount, with a regression test — **not done**
- [x] `polygon.outline` renders. Confirmed under both regimes in the QA shots.
- [x] Wash confirmed under **photorealistic 3D Tiles**, the shipping regime —
      the token lives in `pinokio/ENVIRONMENT`, not a `.env`, so the run has to
      be launched through the operator's own environment. ΔE 51.86, wash 79.64%
      of frame. The keyless globe regime also passes (ΔE 41.37, 77.66%), and the
      harness reports which one it ran in so the two are never confused

## Fine 1 km phase — done

Shipped on `contrib/storm-scope-20261015`. Commits, in order:

| Commit | What |
|---|---|
| `93b1555c` | build plugin: panel excludes payloads, pattern allowlist, atomic copy, `.gz` binary |
| `c956dd85` | the fine builder: constants, `uint32` index, `FINE` magic, `--fine-only`, `--fine-years`, rolloff, manifest, GATE A |
| `8c615be9` | the data: 1,019 shards, 34.6 MB, 2024-01-01 → 2026-10-15 |
| `07b2730d` | the loader: `loadFineRadarDay`, bounded 12-day cache, fine day-index, all shards rebuilt with the magic |
| `2016b8a9` | the render: `ringsToDegrees` takes the grid step; fine drawn at 0.01°; 3,000-ring ceiling |
| `b40f476e` | QA proves it is fetched *and* drawn — **and commits the production `radarSource.dayFor`, which had been sitting unstaged** |
| `a54e569a` | QA stages at roof altitude too, not only regional |

- [x] 0.25° artifacts byte-identical across the rebuild — 1,038 payloads compared
      in `dist`, 0 differ, with and without the Cesium token
- [x] Every shard decodes to the manifest's totals: 1,019 present, 0 missing, 0
      without magic, 0 with a bad length, 9,491,586 records, 0 orphans
- [x] Full suite green at every gate — 7,152 pass, 0 fail
- [x] A single-day window **fetches** the fine shard and **draws** it at 0.01°,
      in both regimes. Colorado 2026-06-01: 2,153 radar polygons, smallest
      spanning 0.0100°
- [x] Multi-day windows stay coarse and ask for no fine day
- [x] A failing fine fetch falls back to the coarse field, not to nothing
- [x] `DATA_SOURCES.md` and the storm `README.md` document the family, the magic,
      the index space and the retention floor

Two things worth keeping, because both were found the hard way:

- **The production `radarSource.dayFor` was uncommitted** while the loader
  commit's message claimed it shipped. Every test passed either way — they inject
  their own source — and the app worked only because the dirty file was on disk.
  The new fetch check is what makes that omission visible; it is the check that
  should have existed before.
- **Drawing the fine field at the coarse step does not look wrong, it kills the
  renderer.** 25×-too-large ground-clamped polygons over the whole ingest domain
  take the tab down (`Target closed`), so the failure is a hang rather than a
  visual. A pixel metric alone would never have caught it, and neither would a
  unit test of `ringsToDegrees` — that tests the function, not the caller.

### The look question, and how it was answered

At regional and even near-roof altitudes a single fine day read as a broad flat
wash rather than a crisp band mosaic. Measured, at 1.7 km over the densest part
of Colorado 2026-06-01: 2,153 polygons covering 99.94% of the frame. The
geometry was never the problem — the smallest drawn polygon spans exactly
0.0100°, and the largest single ring is 6.6% of that day's cells. With a 19 mm
floor the ≥0.75 in region on a big day genuinely is large and contiguous, and at
map scale a 1 km cell is sub-pixel, so same-band polygons stack.

Decided: **1 km close up, 0.25 degrees from altitude**, above
`SWATH_FINE_MAX_ALTITUDE_M` (12 km). That is what the 0.25° field is for, and it
restores the approved band mosaic at regional scale while 1 km is kept for the
roof-level case it actually serves. The alpha ceiling eases 0.72 → 0.52 between
12 km and 60 km so the wash stays dominant without flattening the basemap.

- [x] Fine drawn below the threshold, coarse above — asserted on the drawn
      geometry, not on a flag
- [x] A zoom crossing the boundary redraws the wash (`moveEnd`, tier-guarded)
- [x] `destroy()` unsubscribes the camera listener
- [x] Both tiers verified in the shipping tiles regime, 2026-06-01: 3 km → 0.0100°,
      40 km → 0.2500°, one fine shard fetched at each
- [x] QA is altitude-aware (`QA_SWATH_EXPECT_TIER`) rather than hard-coded, so a
      regional run no longer fails for drawing the coarse field correctly

The fine shard is still **fetched** above the threshold — a day is ~34 KB and
cached twelve deep, and paying that once makes a zoom-down instant instead of a
fetch. The choice is about what to draw, not what to load.

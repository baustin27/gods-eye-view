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

**GATE D:** full suite green; live check for both toggles.

### Phase E — Category details (agents 7 and 8, in parallel)

- **E1** _(agent 7: `src/layers/stormReports/model.js` + its tests)_ — size→object
  nicknames: quarter, golf ball, tennis ball, hen egg. `trimInches` already
  exists at `model.js:214`.
- **E2** _(agent 8: `src/layers/stormReports/index.js` + tests)_ — impacted
  places list from the county/city fields every report already carries; and
  multi-date combine riding the **existing** date-range slider.

**GATE E:** full suite green, format, token checker, import directions.

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
- **Live checks are orchestrator-only**, via `scripts/gev-control.mjs`. Nothing
  that navigates or reloads a CDP target aimed at the Pinokio shell.

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

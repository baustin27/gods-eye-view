# Path B — the layer under the claim

**Status:** agreed direction, not yet built. This file is the brief for a fresh
session. Read it before touching anything.

**Decision:** we are **not** competing with HailTrace / Hail Recon / HailStrike
as a map vendor. We are the reproducible, citable source of truth that sits
*under* the claim — the thing an adjuster, an insurer, or a data vendor's own
operational team needs but cannot produce themselves.

---

## 1. Why Path B, and not Path A

The research (2026-10-20) found the market splits cleanly:

- **HailTrace** — "meteorologist-produced" maps, $229 per storm, $40/$150/$1,000
  per report, contact data from Cole Information and OneClick Code.
- **Hail Recon** (Interactive Hail Maps) — "forensic-grade" swaths, $999/yr one
  state → $1,999/yr nationwide, +$799/yr for homeowner contact data, +$799/yr
  for bulk download, meteorologist-verified.
- **HailStrike** — patented hail-intensity scale, AniSwath animated swaths,
  Street View, partners with CertainTeed / RoofScope / EagleView.
- **HailMate** — the disruptor: $79/mo, maps + canvassing + CRM in one.

The intelligence is a commodity. The **artifact** (a map PNG) and the
**workflow** (a CRM, a phone app, contact data) are what carry the price.

Path B takes the position the market's own vocabulary points at: *forensic*.
Hail Recon already sells "forensic-grade" to adjusters and insurers. Their
forensic-grade swaths are hand-verified by meteorologists — expensive,
unreproducible, and not citable. Ours are derived, reproducible, sourced, and
the uncertainty is stated rather than hidden. That is a strictly better
product for an adjuster who has to defend it, and it does not require us to
outspend HailMate on software.

**We do not build:** homeowner contact data (a commercial purchase), a
meteorologist-authored map (we cannot and should not), a native mobile app
(the desk is a phone browser).

---

## 2. Where we already are, honestly

### Ahead of the market

| | ours |
|---|---|
| Radar resolution | **MRMS MESH 1 km** — finer than the NEXRAD-derived swaths they sell |
| Provenance | objective and reproducible; **no human in the loop** |
| Structures under the hail | **ACS housing units at tract level**, with the source |
| Street level | **TIGER streets ranked by addresses under the hail** — free, from public data |
| Realised damage | **FEMA Individual Assistance register** — nobody else publishes this |
| Lead signal | **PROSPECT**: the radar reached it and nobody called it in |
| Price | free, local, no account |

### Behind the market

| gap | detail |
|---|---|
| **No address lookup** | every competitor's app is built around "was this house hit?" |
| **No per-storm artifact** | they ship a map PNG per storm; we have a globe and a table |
| **No workflow** | no marking, no notes, no "already knocked", no team, no assignment |
| **History** | house-count radar is 2024-01-01 →; they have 10–15 years |
| **Replay granularity** | ours is 6-hourly frames; Hail Replay is 2–3 minute radar frames |
| **Never verified** | the desk's phone layout |

### The one thing we cannot fix alone

Homeowner contact data. Every one of them sells it, for $799/yr to $1,999/yr.
It is a commercial purchase (Cole Information, OneClick Code). Until it is
bought, our knock list stops at the street and the house-number range — which
is genuinely enough to knock, but it is not enough to dial.

---

## 3. The work, in order

### 3.1 Address lookup — the missing centrepiece *(do first)*

`GET /api/desk/address?q=…` → geocode → the fine radar cell → the days and
frames the hail was over it → the street, the tract, the ACS household count,
the FEMA record, and every storm in the report archive.

We already hold TIGER streets and the 1 km field server-side. The work is a
reverse geocode plus a point-in-cell test plus the archive join. This is the
feature that makes the product usable *in the field*, and it is the one every
competitor's reviews praise.

### 3.2 The per-storm artifact — the thing you can attach to a claim

Render one storm's swath as a **banded PNG**: the 1 km cells coloured by the
product bands, the town and tract list, the house counts, the sources and the
date. Every input already exists; this is a renderer plus a stable share URL.

This is also the *proof* of Path B: an adjuster can attach it, and it is
citable because it is reproducible.

### 3.3 Close the history gap

The fine 1 km field starts 2024-01-01, so the house counts are 2.8 years old.
The MRMS MESH archive reaches back to 2014. Rebuilding 2014 → 2023 at 1 km is
the same build we already ran (32 min per 2.8 years → ~2 hours, ~130 MB) and
takes the house-count history to **12 years**, matching Hail Recon and beating
HailTrace.

This is a long build that can run unattended while the rest is done.

### 3.0 What has since been BUILT (the registry is the record)

- **The completion guard** — `scripts/task-registry.json`, `scripts/check-task-completion.mjs`,
  `src/tooling/taskCompletion.test.mjs`, a tracked `AGENTS.md`, and a CI step.
- **The swath** — on by default, five stops of violet to magenta to white,
  outlined in the next hotter band, the bands TILE (one interpolated line
  between two bands, not two), and a third LOD tier between the 1 km field
  and the 0.25 degree one.
- **The globe's chrome** — the porthole is off, the HUD is a telemetry strip,
  the ring hugs the globe, and the map is full-bleed.
- **The desk** — one drill-down panel with a stack behind it, a state picker
  that is a chip row (with a MORE chip for the rest), the table windowed
  rather than copied, every sort header a control, and the places carrying
  their centres.
- **The desk's MAP** — a canvas, Web Mercator, Esri's imagery, and the
  county's own streets from a new tile API, in the `GEVS` format.
- **The per-storm artifact** — one storm as a picture, with its sources on it.

### 3.4 The workflow layer

Mark a street, "already knocked", assign to a rep, note, team sharing. This is
the original "a team sharing views" requirement and it is still open. It is
what turns a data tool into a tool a team uses. Decide first where the state
lives: a file-backed store on the desk server (free, LAN, one office) or a
hosted one (accounts, sync, real infrastructure).

### 3.5 Finer replay

Ours is 6-hourly; Hail Replay is 2–3 minute radar frames. The MRMS archive
has `MESH_Max_30min` (verified present). Our bitmask record holds 16 frames,
so **2-hourly (12 frames)** fits exactly and costs 3× the build of 6-hourly;
30-minute (48 frames) needs a wider mask. The cost is build time and size,
not architecture.

### 3.6 The phone layout

The desk is served for LAN use and the field workflow is a phone in one hand.
The layout has never been checked. Verify before anything else ships.

---

## 4. State of the repository

Branch `contrib/storm-scope-20261015`. **Nothing pushed.** 8 commits this
session, all local. `npm test` → 7,285 pass, 0 fail, 1 skipped (a known
load-sensitive allocation probe).

### Landed and committed

| commit | what |
|---|---|
| `13c304bd` | the knock list ranked by what fell on it (street→cell, share-of-length apportionment) |
| `c6ebd346` | the tract list, and streets inside a tract |
| `415b4b92` | the note about how not to enable a layer |
| `0bfdf3aa` | the timeline: a day of hail in six-hour frames |
| `6ba23400` | the timeline, three ways it was not working |
| `fa19fd28` | a frame missing from the archive is an absence, not a failure |
| `c83b5d38` | the sub-daily field, 1,019 days (37.3 MB) |

### Landed earlier in the session

`fbfdaf4a` Census housing units ETL · `517848ca` the desk SPA · `908a00e9` the
globe→desk HAIL DESK chip · `c4ba297e` the CITY view · `286a2295` the
place→storm-day drill-down · `b3bc673a` houses under the hail + PROSPECT ·
`257e668a` the street knock list + the desk server · `5ab48e5f` FEMA realised
damage by ZIP.

### The desk rebuild, landed after that table was written

The desk was rebuilt around one idea: **the storm is the map**. The storm-day
list is now the desk's first view, the place dots are a layer that is off by
default, and a day is a link.

| commit | what |
|---|---|
| `a03f652f` | the map stops lying: the zoom is a whole number, the cursor is the anchor (0.000 m of drift), the latitude is clamped, the failed tiles are remembered |
| `921f2929` | the storm-day list, the union of the report days and the radar days; `d`, `dsort`, `ddir` and `view` in the URL; the recent days as chips; the frame chips; the dots as an optional layer |
| `97bb4647` | the houses: the tract choropleth under the swath, the county the storm fell in, and the FIPS the tile routes wanted |
| `4a1fe5b4` | a day opens its tracts, and a tract opens its streets with the addresses under the hail |
| `39d97ed0` | the lead list (the PROSPECT scope), the scale bar, the zoom readout, the keyboard |
| `ac63fcab` | the desk opens on a storm, with the row marked in the list |
| `4010570a` | one ramp for the globe, the desk, the artifact and the gallery |

`npm test` → **7,356 pass, 0 fail**. `npm run check:tasks` → 49 tasks, 0
open.

### Known open items

- `swaths.json.gz` was **not** rebuilt for the tract list — the desk reuses
  the rows the artifact already had. The tract rows carry no name; the desk
  derives it from the GEOID.
- The per-tract **ZIP** is still absent. The 529 MB national ZCTA520 download
  was skipped because the tract→street drill-down carries the ZIP for free
  through TIGER EDGES. The data is verified reachable if it is ever wanted on
  the tract row itself.
- The globe's storm layers were confirmed working on a clean boot of the
  production build (`:4173`): OFF → ON, all five storm assets 200, no errors.
- The **ISOLATE** control (the globe's "show me only this storm") has not
  been ported to the desk. The desk's equivalent - the storm list's own
  filters and the selected day - covers most of it, but not all of it.
- The **phone layout** has never been checked. The desk is a desktop product
  and it says so, and nobody has looked at it on a small screen.
- The desk's map draws **one county's** streets and tracts, and the 500k
  cartographic boundary file DROPS the small urban tracts, so a rural county
  draws almost no houses. Both are in `docs/KNOWN-ISSUES.md`.

---

## 5. How to drive it

Two servers, both already used in the last session:

```bash
# the globe (production build)
npm run build
npx vite preview --port 4173 --host 127.0.0.1

# the desk
npm run build:desk
node server/desk/server.mjs --port 5234 --host 0.0.0.0   # 0.0.0.0 for the phone
```

### Where the storm tracks are

- **The globe, swaths** — enable *Hail & Wind — Observed* for the county
  surface and the ranked county list, or *Hail & Wind — Individual Reports*
  and turn on the **RADAR** chip for the contoured swath.
- **The globe, the timeline** — on *Hail & Wind — Individual Reports*, pick a
  single storm day from the date chips and the row grows `DAY · 06Z · 12Z ·
  18Z · 00Z`. Those are the six-hour frames of that day.
- **The desk** — `http://localhost:5234/` → click a city → its storm days →
  **tracts** → **streets**. The street list is ranked by *addresses under the
  hail*.

### The numbers worth quoting

Colorado Springs, El Paso County CO, 2024-07-08 — 494 street segments with
something under the hail, 26,476 addresses; the independent tract path says 10
tracts and 14,524 housing units for the same storm.

---

## 6. The single hardest-won lesson

`38.83 / 0.01` is `3882.9999999999995` in a double. Taking the floor of it
puts every point in the wrong grid row, which moved every street in the country
one cell off the hail — and the knock list came back **empty with no error
anywhere**. The arithmetic was exact, and it was exactly wrong.

All 4,405,145 hit cells across the 1,019 days now round-trip through the
lookup with zero mismatches, and there is a test that pins it.

Never trust a cell lookup that has not been round-tripped.

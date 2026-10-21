# The desk: the storm is the map

**The flow, as described:** open the desk → see the 2D map → pick the state →
see the storm dates in a list with **how many houses were hit** → click one →
the swath turns on → see every area hit → zoom in → see which streets and
houses.

Everything below is measured from the artifacts, not estimated.

---

## 1. What the numbers actually are

### 1.1 Colorado's storm days and the houses under them

From `swaths.json.gz` and `cities.json.gz`:

- **160** days the 1 km radar reached something in Colorado; **175** days
  people filed hail in Colorado.
- The biggest Colorado days, by houses under the hail:

| radar day | houses | tracts | places | largest |
|---|---|---|---|---|
| 2024-06-01 | **323,867** | 165 | 22 | 3.40″ |
| 2026-06-02 | 183,986 | 94 | 6 | 2.25″ |
| 2025-06-18 | 137,198 | 69 | 30 | 2.89″ |
| 2026-06-26 | 48,699 | 29 | 12 | 2.42″ |
| 2024-07-22 | 47,116 | 22 | 7 | 1.91″ |
| 2025-07-07 | 40,221 | 24 | 3 | 2.17″ |

Those are the numbers the date list shows. **323,867 houses under the hail in
Colorado on one June day** is the headline a canvasser acts on, and it is
exact: the sum of the ACS B25001 housing units of the tracts the 1 km field
reached.

### 1.1a The house count is a RADAR ESTIMATE, and it must be labelled as one

This matters more than the arithmetic. The count is exact **as a computation**
— it is the sum of the ACS B25001 housing units of the tracts the 1 km MRMS
MESH field reached, and MESH is a *hail equivalent* derived from radar
signatures, not a measurement of a stone. The REPORT is the measurement.

The two are not the same thing, and on the biggest day in the record the
gap is stark: **2024-07-17's radar day reaches 3,740 tracts holding
6,125,335 houses, and the 24 hours it covers have 24 hail reports
nationally.** The radar said "hail was possible over a very large area";
the people said "twenty-four stones fell". Both are true and they are
answers to different questions.

**So the column is called "HOUSES IN REACH", not "houses hit",** and the
info line says what it is: *the houses in the tracts the radar reached —
a footprint, not a claim that any roof was damaged.* The swaths artifact
already words it this way ("a tract the radar reached is a tract to work and
every house in it is a candidate") and the desk must not lose that
distinction by shortening it to a headline.

**And the artifact is complete — nothing is lost.** Checked against the raw
files: the artifact holds **22,853 hail and 39,385 wind reports = 62,238**,
which is **exactly** the number of reports the build placed in a place. The
other 93,500 raw reports are in open country, outside any city or town
boundary, and are not in the market table by design.

### 1.2 The house count is the right one — checked

For 2025-07-07 in Colorado the artifact says **40,221 houses in 24 tracts**;
an independent bbox test over the fine field says 43,973 in 24 tracts. The
artifact's is the exact one (a cell counts in the tract whose boundary
contains it; the bbox test also catches a cell that merely overlaps). The
number stands.

**And it is honest about what it is:** the houses in the tracts the RADAR
reached. Where people reported but the radar did not reach, the houses are
not counted — and that is the right answer, because we cannot claim a roof
was hit where the radar saw nothing.

### 1.3 The day convention — and it is NOT a fudge

MRMS names a file for the window **ending** at its timestamp, so the shard
for day D covers **D−1 06:00 → D 00:00 UTC**. The measured pairing of
report days to radar days in Colorado:

| offset | report days the radar reached | houses |
|---|---|---|
| −2 | 27 of 175 (15%) | 162,816 |
| −1 | 34 (19%) | 754,302 |
| **0** | 46 (26%) | 753,500 |
| **+1** | **67 (38%)** | **1,447,290** |
| +2 | 59 (34%) | 1,049,300 |

**+1 dominates by a factor of two** — a report day R is covered by the radar
shard **R+1** ✓ (the shard covers 18 of R's 24 hours).

**So the join is: report day R → radar shard R+1.** The house count for a
report day is the swaths artifact's rows for **R+1**.

**The date list is therefore built on REPORT days** — the market language, the
days a storm happened — and each row shows the houses under the hail for the
radar day that covers it. A row with no radar reach shows "no radar reach"
rather than a number, and 38% of rows have one.

### 1.3a HOW WE KNOW THE REPORT DAYS — and the two spines

**The provenance.** `cities.json.gz` carries `cityDays` — one row per place
per day. The build makes them from the six per-year report files
(`REPORT_FILES = [2021…2026]`, `build-hail-desk-data.mjs`), and **a report
only becomes a row if its lat/lon falls inside a city or town boundary**
(`placeAt(grid, lat, lon)`). So:

> **A report day is a day on which at least one hail report was filed from
> inside a city or town boundary.**

**The counts, measured:**

| | days | from | to |
|---|---|---|---|
| **report days** (`cityDays`, a hail report inside a place) | **1,248** | 2021-01-06 | 2026-10-13 |
| **radar days** (the swaths) | **782** | 2024-01-05 | 2026-10-15 |
| days with **both** | 553 | | |
| days with **reports and no radar reach** | **695** | 2021-01-06 | 2026-10-08 |
| days with **radar reach and no reports** | **229** | 2024-01-05 | 2026-10-15 |

**So the list cannot be built on the report days alone.** 695 of the 1,248
report days — **56%** — have no swath to draw: the whole of 2021 to 2023
(the fine field starts 2024-01-01) and the days the radar missed. A row
that names a storm the map cannot display is a dead row.

**The list is the UNION of the two spines**, with the two kinds of day
distinguished:

- **a radar day** — the storm's footprint, the houses in reach, and the
  reports that came with it. 229 of them have no reports at all: the radar
  saw hail where nobody called in, which is the PROSPECT thesis.
- **a report day** — people filed stones and the radar did not reach
  anything: no footprint to draw, but a real market.

**And the default order is CHRONOLOGICAL, newest first** — the same as the
globe, whose date chips are the twelve most recent storm days and whose
storm list is in date order. It is also what a canvasser wants: the most
recent storms are the open leads, and the storms before them are claims
already worked. **The houses are one click away** — the column sorts, and
so does every other one.

### 1.4 The two datasets are not the same thing

- `swaths.json.gz` — the **radar's reach**: tract, place, day, max reading,
  cells reached, housing units. 14,475 (place, day) pairs, 782 days, 5,294
  places. **It is the work list.**
- `cities.json.gz` → `cityDays` — every place with a report on a day. It
  **enumerates the market** and the swaths do not: of the 5,227 places with a
  report since 2024, **3,237 (62%) never appear in the swaths** — the radar
  missed them or did not reach a tract inside them.

Both are needed. The list is built from the reports; the house count and the
swath come from the radar, joined at +1.

---

## 2. The date list — the thing that does not exist yet

### 2.1 The panel

Beside the map, under the ranked list:

| column | from | notes |
|---|---|---|
| **Date** | the report day | the market day |
| **Houses** | the swaths' rows for day+1 | the headline; "—" when the radar did not reach |
| **Reports** | `cityDays` for the day | the count of reports, and how many were ≥1″ |
| **Largest** | the swaths' `m`, else the reports' `max` | in inches |
| **Places** | the count of places with a report | and how many the radar reached |

**Sorted by the houses under the hail, descending** — the work-list order —
with a **date** sort available. The recent days are also on the map as a row
of chips, the globe's pattern, so "the recent ones" are one click away
without hunting through a list.

### 2.1a The columns, and every one of them sorts

The list is a TABLE, and every header sorts it — the same table machinery the
city table uses (`table.js`'s `renderTable` with its header buttons, its
`SORTERS` and its `sortRows`), so a click on a header re-sorts the rows and
nothing else in the app has to learn about it.

| column | from | what it means |
|---|---|---|
| **Date** | the report day | the day the storm happened |
| **Houses in reach** | the swaths' `u` for **day+1**, summed over the state's rows | **the houses in the tracts the radar reached** — a footprint, not a claim of damage |
| **Reports** | `cityDays`' `n` for the day | every hail report filed that day |
| **≥1″** | `cityDays`' `n1` for the day | the reports of an inch or more — the market measure |
| **Largest** | the swaths' `m`, else `cityDays`' `max` | the largest stone, in inches |
| **Places** | the distinct `k` in the swaths' rows, and the places with a report | the breadth of the storm |

**Every one of these is already in the two artifacts the desk has** — no new
data, no new build. The swaths' rows carry the tract, the place, the day, the
max reading in millimetres, the cells reached and the housing units; the
cities' `cityDays` carry the day, the report count, the ≥1″ count, the ≥2″
count, the largest stone and the wind.

**The default order is THE STORM IN TIME: the date, descending** — the most
recent storm at the top, which is the globe's order and the order a canvasser
works in. Ties break on the houses, descending, so the biggest of two storms
on the same day comes first.

**A row can have a report count and no radar reach**, and the other way
round: the radar and the reports do not line up day for day, because the
radar's day is the 24 hours ENDING at that morning and the reports are filed
against a calendar day. So a row shows "—" for a column it has nothing for,
and the list is never quietly empty.

**And every column sorts both ways**, so a person who wants the most recent
days, or the most reports, or the biggest stones, or the broadest storms, can
get them without the list being rebuilt:

| sort | the order it gives |
|---|---|
| **date** (the default) | the recent storms first, newest at the top — the globe's order, and the open leads |
| **houses** | the biggest radar footprints first — the work list |
| **reports** | the busiest report days first — the market as the public filed it |
| **severe** (≥1″) | the days with real stones in them, not hail dust |
| **largest** | the days with the biggest stone |
| **places** | the broadest days — the ones that hit a whole region |

**The sort lives in the URL**, as two more options beside the ones the desk
already has: `dsort` (which column) and `ddir` (which way). They are
SEPARATE from the city table's `sort` and `dir`, because the two tables have
different columns and one `sort` key would have to mean two different things
in two different places. A shared link then carries both: the market view
sorted its way, and the storm list sorted its way.

### 2.2 Selecting a day

Clicking a row:
- sets the selected day (a new **URL option**, so a day can be linked to);
- draws the **radar shard for day+1** on the map;
- **fits the map to the swath**, not to the places;
- turns the place dots into a layer, off by default, because the swath is
  the map now;
- puts the day's places in the list beside the map.

### 2.3 The URL needs a day

The desk's codec (`src/data/layerState.js:508-558`) has `fromYear`,
`toYear`, `state`, `minHailTenths`, `sort`, `dir`, `q` — and **nothing for a
day**. That is the gap: a storm cannot be linked to. One more option, `d` for
the day, and the share link carries the storm.

---

## 3. Zooming in to the streets and the houses

### 3.1 The streets — DONE, and it works

`/api/desk/tiles/{state}/{county}/{z}/{x}/{y}` serves the county's street
centrelines in the `GEVS` format, cut from the **raw EDGES records** so the
map has all 55,540 named centrelines rather than the 1,494 the knock list
can see. Denver's index builds in 800 ms and a tile answers in 4 ms.

### 3.2 The houses — a tract layer is needed

The map needs to say **which houses** are under the hail, and the house
counts are per **TRACT**. The tracts' geometry is 29.7 MB — far too much to
ship to a browser — so the tracts need the same treatment as the streets:

**`/api/desk/tracts/{state}/{county}/{z}/{x}/{y}`** — the tracts that touch
the tile, with their house counts, in the same `GEVS` format.

The server already has everything: `server/providers/tracts.js` loads the
tracts pack and indexes it by GEOID, and `server/providers/hailStreets.js`
already joins the tracts to the radar and the housing units. The tile builder
is the same one as the streets', over a different source.

### 3.3 What the zoom shows, by level

| zoom | the map shows |
|---|---|
| state | the swath, the places, the state outline |
| county | the swath, the counties, the places with a report |
| city | the swath, the tracts with their house counts, the streets |
| neighbourhood | the streets with the addresses under the hail, the tracts |

The globe's LOD is fine/mid/coarse at 60 km/600 km of altitude; the desk's
is zoom-based, and the tiers are the same idea.

---

## 4. The map stops lying — the fixes, in order

### 4.1 The two zoom bugs

**(a) The fractional zoom.** One wheel notch makes the zoom `11.321928`.
`clampZoom` clamps the range and never the integrality, so the tile index is
computed on a **2560-column grid**, and Esri **truncates the fraction**
rather than rejecting it — measured: `/tile/11.32/978/533` is byte-identical
(md5 `bacf17e9b4ca`) to `/tile/11/978/533`. The browser is given the z=11
tile for column 533 — the ground at lon −86.3° — and paints it where
lon −105.0° belongs. **18.7° of longitude and 31° of latitude off, and
24.8% undersized.** The street tiles 404 outright (the route regex is
`(\d{1,2})` for z).

**FIX.** The zoom is an integer. Quantise it in `zoomAround`
(`viewport.js:224`) — the one funnel that also anchors the zoom to the
cursor — and in `createViewport` (`:84`), `goTo` (`map.js:286`) and `fitTo`
(`map.js:277`).

**Round, not floor**: floor gives in → 11, 11, 11, 11 against out → 11, 10,
so zooming IN is four times slower. Round gives 11, 11, 12 both ways. The
wheel handler keeps a fractional `zoomTarget` accumulator and commits
`Math.round(zoomTarget)`, so a notch always moves.

**(b) The Antarctica, and it is a DIFFERENT bug — it happens at integer
zooms too.** `zoomAround` (`viewport.js:223-238`) computes `world` on line
227 and **never uses it**; the new centre is
`centreWorld + (cursor − canvasCentre)` in world pixels, so the map is
displaced by the cursor's offset from the middle of the canvas. Simulating the
handler exactly as written, cursor at the bottom, zooming out from Colorado:
notch 1 lat 38.65 → notch 15 13.84 → notch 18 −13.79 → notch 21 −56.29 →
notch 22 **−68.35° — Antarctica.**

**FIX** (`viewport.js:233-236`):
`worldPoint(world.x - (x - width/2), world.y - (y - height/2), next)`.
Verified: 0.000 px drift for the cursor at (400,600), (0,0) and (800,300).

**(c) The map can stick at the Antarctic edge**, because `worldPoint`
(`viewport.js:61-67`) does not clamp the latitude. Clamp the centre in
`panBy` and `zoomAround`.

**(d) `fitTo` compares a latitude span against a longitude formula**,
ignoring the Mercator stretch — 1/cos(lat) is **1.28×** at 38.85°N — so
the fit can be a whole level too tight (measured: a 1° × 2° extent fits at
zoom 8 instead of 7). It also clamps to zoom 3, below `MIN_ZOOM` = 4.

### 4.2 The jank

| # | where | symptom | fix |
|---|---|---|---|
| 1 | `map.js:67-74` | **the desk has NO window-resize listener.** After a resize the backing store and the viewport size are stale: the bitmap is CSS-stretched and the projection uses the old size | a `ResizeObserver` on the canvas → `resize()` + `scheduleDraw()` |
| 2 | `map.js:68` vs `:87` | the device pixel ratio is read twice — the backing store's and the draw's — so they disagree across monitors | remember the ratio the backing store was made at; re-resize when it changes |
| 3 | `basemap.js:86`, `:126` | a tile that FAILS is never cached, so it is re-requested every frame | negative-cache the failures with a TTL |
| 4 | `main.js:256` | `pane.draw()` is called directly on every debounced keystroke, bypassing the frame | `scheduleDraw()` |
| 5 | `map.js:174` vs `:141` | the pick radius is 12 px against dots of 2.5–7 px, so clicking bare ground opens a place | the hit radius is the DRAWN radius + 4 px |
| 6 | `map.js:183-207` | no `pointercancel` (a drag stays latched), no button check (a right-drag pans, a right-click picks), `moved < 4` sums the deltas so 2 px still counts as a click | handle `pointercancel`, primary button only, a distance threshold |
| 7 | `map.js:208-222` | **no keyboard support at all** — no arrow-pan, no +/− | `tabindex="0"`, a keydown handler, an aria-live zoom readout |
| 8 | the map | no scale bar, no zoom readout | draw both |
| 9 | `map.js:141-144` | the dot radius and alpha are relative to the FILTERED worst, so every dot re-sizes as you type and one outlier flattens the rest | an absolute scale by rank quantile, times a zoom factor |
| 10 | `swath.js:86-97`, `:129` | the swath re-implements the projection instead of importing `project`, and the import sits at the BOTTOM of the file — two copies of the Mercator maths | import `project`; drop the dead getter |
| 11 | `panBy` | the maths is EXACT — 100.000000000 px for a 100 px pan, at every zoom. The pan feels wrong only because the view it starts from is wrong | fixed by 4.1 |

---

## 5. The build order

**Wave A — the map stops lying.** Small, and everything else depends on it.

| id | task | files |
|---|---|---|
| A1 | the zoom is an integer: quantise in `zoomAround`, `createViewport`, `goTo`, `fitTo`; a fractional `zoomTarget` in the wheel handler; `Math.round` | `apps/hail-desk/src/map/viewport.js`, `map.js` |
| A2 | the cursor anchor: `worldPoint(world.x - (x - w/2), world.y - (y - h/2), next)` | `viewport.js` |
| A3 | clamp the centre's latitude in `panBy` and `zoomAround` | `viewport.js` |
| A4 | `fitTo` uses the Mercator stretch and `clampZoom` | `map.js` |
| A5 | a `ResizeObserver`; the device pixel ratio read once | `map.js` |
| A6 | the failed tiles are negative-cached; `main.js` uses `scheduleDraw` | `basemap.js`, `streets.js`, `main.js` |
| A7 | the pick radius is the drawn radius + 4; `pointercancel`; primary button only; a distance threshold | `map.js` |
| A8 | the swath imports `project` | `swath.js` |

**Wave B — the storm drives the map.**

| id | task |
|---|---|
| B1 | the **date list** panel: a table of the days, with the houses under the hail, the reports, the ≥1″ count, the largest stone and the places — every header sorts it, and the default is the houses, descending |
| B2 | the list's sort in the URL as `dsort` and `ddir`, beside the market's own `sort` and `dir` |
| B3 | a **selected day** in the URL codec (`d`), so a storm can be linked to |
| B4 | clicking a day draws the radar shard for **day+1** and **fits the map to the swath** |
| B5 | the **recent days as chips** on the map, the globe's pattern |
| B6 | the place dots become an optional layer, off by default |
| B7 | the info line: the reports count, the largest stone, the houses under the hail, the day convention |
| B8 | the **frame** chips** (DAY/06Z/12Z/18Z/00Z) from the sub-daily shards the desk already has and never used |

**Wave C — the houses.**

| id | task |
|---|---|
| C1 | `/api/desk/tracts/{state}/{county}/{z}/{x}/{y}` — the tracts with their house counts, in the same `GEVS` format |
| C2 | the desk draws the tract house counts as a choropleth over the swath |
| C3 | at street level, the houses under the hail per street — the knock list already computes it, and the map needs it per segment |

**Wave D — the rest of the globe's storm features**, in the order they matter
to a canvasser: the **REPORTED** wash, the **PROSPECT** difference, the
thresholds (1″/1.5″/2″/2.5″/3″), the county **DAMAGE** surface (the
counties' polygons), the storm **EVENTS**, and the **ISOLATE** control.

**Wave E — the finish.** Keyboard, a scale bar, a zoom readout, a pinch
handler, the phone, and **one shared mark style** for the bands so the map,
the artifact and the gallery cannot drift.

---

## 5a. What has landed

Every wave below is done except the two marked open, and the registry
(`scripts/task-registry.json`) carries the commit for each one.

**Wave A — the map stops lying.** Landed. The zoom is a whole number and the
wheel keeps a fractional target; the cursor is the anchor, and the drift of
the point under it is **0.000 metres** (it was growing with every notch, and
twenty-two notches out of Colorado put the map in Antarctica); the latitude
is clamped so the map cannot stick at the pole; the Mercator stretch is in
the fit; there is a resize listener; the pixel ratio is read once; a failed
tile is remembered; the pick radius is the drawn radius; a drag can be
cancelled and only the primary button drags; and the swath shares the
viewport's projection instead of keeping a second copy of the Mercator maths.

**Wave B — the storm drives the map.** Landed. The date list is the desk's
first view, built on the union of the report days and the radar days
(1,248 + 782, 1,477 together), with the houses under the hail joined from
the shard that covers the day (+1). `dsort`, `ddir`, `d` and `view` are in
the URL, separate from the market's own `sort` and `dir`. Clicking a day
draws the shard and fits the map to the swath, clipped to the market's
state. The recent days are chips over the map, the info line says what is on
it, the place dots are a layer and off by default, and the frame chips
(DAY/06Z/12Z/18Z/00Z) come from the sub-daily shards the desk had and never
used.

**Wave C — the houses.** Landed, with one caveat written down. The tract
tile API returns the tracts that touch a tile in the street tiles' own
format, with the housing units in the county's tract list; the desk draws
them as a cyan choropleth under the swath with the boundaries over it; and
the county it draws is the county the storm fell in. A day opens its tracts
— the biggest Colorado storm opens as 165 tracts and 323,867 houses — and a
tract opens its streets, which now say how many of the addresses were under
the hail (25,803 of 25,803 for the first one).

**Wave D — the rest of the storm features.** The **PROSPECT** scope is
landed: the days the radar reached and nobody called in, which in Colorado
is 114 days and 1,141,661 houses in reach with no reports at all. The
globe's REPORTED wash, the county DAMAGE surface and the storm EVENTS are
**globe** features and were not ported to the desk: the desk's equivalent of
the REPORTED wash is the "—" in the report columns, and the EVENTS are a
list, not a map. The ISOLATE control is **open** — a person looking at a
storm cannot yet drop everything else and keep only that storm.

**Wave E — the finish.** The scale bar, the zoom readout and the keyboard
are landed. The **one shared mark style** is landed: the ramp is in
`src/data/stormRamp.js` — the thresholds, the colours, the labels and the
colour of each band's own edge — and the globe, the desk, the per-storm
artifact and the gallery all read it, with a test that says the artifact's
bands ARE the shared ramp rather than a copy of it. The desk also draws the
band edges now, which it did not: its bands were flat fills with no
boundaries. The phone was never checked, which is a known gap and not a
surprise.

---

## 6. Two decisions I will make unless you say otherwise

1. **The date list is built on REPORT days**, with the houses under the hail
   joined from the radar day that covers it (+1), and a row that says "no
   radar reach" where there is none. The alternative — listing the radar
   days — is simpler but dates the storms by the radar's clock, which is not
   the day a storm happened.

2. **The dots go.** They become an optional layer, off by default. The map is
   the swath; the places are a list beside it, and a dot for every place in
   a market of thousands is not a map of anything.

Tell me if either is wrong.

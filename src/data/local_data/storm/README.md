# Storm hail & wind history

Bundled, offline, zero-credential snapshots answering one narrow question: **where
in the United States have homes historically been damaged by hail and wind, and
where is a hail-and-wind inspection effort worth spending first?**

Everything here is derived from US-government sources plus FEMA's National Risk
Index, aggregated offline by `scripts/build-storm-snapshots.mjs` from ~976,552
raw severe-weather reports. Nothing in this folder is fetched at runtime.

## ⚠️ License — commercial use is cleared

This dataset is **not** restricted, unlike several sibling folders in
`src/data/local_data/`:

- **NOAA/NWS Storm Prediction Center** severe-weather database and **US Census
  Bureau** cartographic boundaries are **US Government public domain**. No
  permission needed, no attribution legally required.
- **FEMA National Risk Index** is **free to use, including commercially**,
  conditional on reproducing FEMA's disclaimer verbatim wherever the data is
  displayed or derived from. The app renders it from
  `FEMA_NRI_DISCLAIMER` in `src/data/stormAttribution.js`.

Keep the FEMA disclaimer intact (see `DATA_SOURCES.md`). Unlike TeleGeography,
nothing here needs to be deleted for a commercial deployment.

## Files

| File | Geometry | Contents | Records |
|---|---|---|---|
| `storm_cells_025.geojsonl` | Point | 0.25° damage-score grid — the fine grid the scoring surface runs on | 12,119 cells |
| `storm_cells_050.geojsonl` | Point | 0.5° recurrence grid — coarser, honest frequency view over the whole record | 3,507 cells |
| `storm_events.geojsonl` | Point or 2-point LineString | Individual significant events (hail ≥ 2.00 in, wind ≥ 75 kt) with tracks where SPC recorded a final location | 37,727 events |
| `storm_counties.geojsonl` | Polygon / MultiPolygon | County polygons joined to FEMA NRI attributes and to per-county observed storm statistics | 3,234 counties |
| `storm_radar_hail.geojsonl` | Point | 0.25° radar hail-core grid from NOAA MRMS, on the same index space as `storm_cells_025` | see `storm-radar-sources.json` |
| `storm-sources.json` | — | Build metadata: record counts, per-decade completeness, thresholds, source list with licenses | — |
| `storm_radar_hail_<year>.geojsonl.gz` | Point | 0.25° radar hail cores for **one year**, year-scoped: `mx`, `cp` and `dy` are that year's peak, core-point count and distinct hail days | 2021:11,918 · 2022:15,364 · 2023:13,321 · 2024:14,836 · 2025:14,401 · 2026:14,850 |
| `storm-radar-sources_<year>.json` | — | Build metadata for that year's radar file: window, cell count, caveat | — |
| `storm-radar-sources.json` | — | Build metadata for the radar snapshot: window, cell count, caveat | — |

### Report-level files

Produced by `node scripts/build-storm-reports.mjs` (alias: `npm run build:storm-reports`).
These power the **Individual Reports** layer, which is a different surface from the
aggregate Hail & Wind grid above: it draws individual severe reports rather than a
scored climatology, and it loads only the years the current date window touches.

| File | Contents | Size |
|---|---|---|
| `storm_reports_<year>.json.gz` | Every SPC report in that year as a positional tuple: date, minute, hazard, magnitude, lat/lon, FIPS, state, county, loss, comment, sources, trace, and **`stormRef`** | 155,738 reports, 2021–2026 |
| `storm_events_<year>.json.gz` | Storm events. `identitySource: 'ncei'` where NCEI published the episode (with narrative and damage dollars); `'clustered'` where it had not and the reports were grouped by proximity and time — a display grouping, not a claim of NCEI-equivalent identity | 21,948 events |
| `storm_report_index.json.gz` | Per-day hail/wind counts; the only file loaded up front | 1,572 days |
| `storm_report_sources.json` | Build metadata and provenance | — |

**`stormRef` is the 14th tuple field**: an integer ordinal into *that year's*
`storm_events_<year>` array, or `-1` for a report belonging to no event. It is what
makes "which storm was this report part of" answerable on a day carrying several.
An ordinal is only meaningful inside its own year, so consumers must apply a
per-year base offset rather than indexing the concatenated event list directly.
Snapshots built before this field existed read `-1` on every row and consumers must
fall back to matching on date.

### Rebuilding the report-level files

```bash
npm run build:storm-reports                    # 2021-2026, warm cache ~40s
node scripts/build-storm-reports.mjs --dry-run # counts only, writes nothing
node scripts/build-storm-reports.mjs --from 2024 --to 2026
```

Downloads are cached under `.gev-cache/build/`, so a rebuild does not re-fetch
unless the upstream archives changed. Note this script has no `--refresh`: it always
reads the cache.

Both grid files carry every report that landed in a cell; the fine grid is small
because only damage-relevant cells are materialised. A cell's centre is at
`i * d + d/2` (latitude) and `j * d + d/2` (longitude).

## Sources

| Source | Coverage | Download | License |
|---|---|---|---|
| NOAA/NWS Storm Prediction Center Severe Weather Database | hail + wind reports, 1955–2025 | `https://www.spc.noaa.gov/wcm/data/1955-2025_hail.csv.zip`, `https://www.spc.noaa.gov/wcm/data/1955-2025_wind.csv.zip` | US Government public domain |
| FEMA National Risk Index for Natural Hazards v1.20 (Dec 2025) | US counties; hail + strong-wind expected annual loss | ArcGIS `FeatureServer/0/query` (read-only, no key) | Free to use with FEMA-mandated disclaimer |
| US Census Bureau cartographic boundary counties (500k) | US counties and equivalents | `https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_county_500k.zip` | US Government public domain |
| NOAA/NSSL Multi-Radar/Multi-Sensor (MRMS) `MESH_Max_1440min_00.50` | daily max estimated hail size, 2021–present | `s3://noaa-mrms-pds` (keyless, no AWS account, no egress charge) | US Government public domain |

SPC `mag` is hail diameter in inches and wind gust in knots; SPC `loss` is
thousands of dollars. The ETL reads county FIPS from `stf` + `f1` (never the
sibling `f2` column, which is `0` and silently produces keys like `00025`).

## Property-key encoding

The snapshots ship in-repo, so every property block is abbreviated. Consumers
go through `src/data/stormDatasets.js` (`toCellRecord`, `toEventRecord`,
`toCountyRecord`), which maps these keys to named fields. Do not read the raw
keys from consumer code.

### Grid cells (`storm_cells_025`, `storm_cells_050`)

| Key | Meaning |
|---|---|
| `i`, `j` | latitude / longitude cell index; join key `"i:j"` |
| `d` | grid step in degrees (`0.25` or `0.5`) |
| `hn` | hail report count |
| `hs` | hail reports ≥ 1.00 in (SPC severe) |
| `hg` | hail reports ≥ 2.00 in (SPC significant) |
| `hx` | largest hail diameter, inches (`null` if never measured) |
| `hw` | sum of hail severity 0..1 across reports |
| `wn` | wind report count |
| `ws` | wind reports ≥ 58 kt (severe) |
| `wc` | wind reports ≥ 75 kt (severe structural) |
| `wx` | strongest wind gust, knots (`null` if never measured) |
| `ww` | sum of wind severity 0..1 across reports |
| `cd` | compound days — days with **both** hail and wind in this cell |
| `y0`, `y1` | first and last year observed in the cell |
| `pl` | reported property loss, USD (SPC `loss` × 1000; omitted when zero) |
| `in` | reported injuries (omitted when zero) |
| `ft` | reported fatalities (omitted when zero) |
| `dc` | decade histogram — see below |

`cd` is the strongest single signal for residential damage, because the roof
envelope is already breached when the wind arrives. It is counted as real day
overlap, not two independent marginals added together.

### `dc` — the decade histogram

`dc` maps a **four-digit decade key** to `[hailCount, windCount]`:

```json
"dc": { "1950": [1, 1], "1960": [0, 1], "2000": [7, 11], "2020": [5, 47] }
```

Keys are the **full** four-digit decade start (`1950`, `2000`). Storing decade
totals instead of year histograms is what keeps the snapshot small enough to
commit to the repo.

> A two-digit form (`"50"`) was tried first and is a trap: `"50"` is ambiguous
> with the 2050s, and decoding it with a `+ 2000` heuristic silently maps every
> pre-2000 bucket to a year outside the record — deleting roughly 118,000 hail
> reports with no visible error. `stormScoring.js` still accepts two-digit keys
> and infers the century conservatively (`>= 50` → 1900s) for safety, but the
> builder only ever emits four-digit keys.

**Limitation:** this bounds the resolution of any time filter. A window narrower
than a decade has no year-level distribution in the payload, so
`apportionDecade` / `windowCellCounts` in `src/data/stormScoring.js` estimate the
in-window count as the decade total scaled by the window's **linear overlap in
years**.

The overlap is measured against the part of each decade the record actually
covers, not a nominal ten years. This matters at both ends: hail and wind data
begin in 1955 and the build ends mid-2020s, so treating every bucket as a full
decade would halve the most recent six years — the data people care about most —
and quietly drop the first few years of the record. With the boundary clamp, a
window spanning the whole record reproduces the ETL's totals exactly (asserted by
`src/data/stormSnapshot.test.mjs`), while an interior window is still apportioned
proportionally.

An apportioned result is flagged `partial`, and `WINDOW_RESOLUTION.note` is shown
to the user. Never present an apportioned count as an exact one. The individual
`storm_events.geojsonl` points **are** year-exact.

### Events (`storm_events.geojsonl`)

| Key | Meaning |
|---|---|
| `id` | `H-`/`W-` + year + month + stable content hash (see below) |
| `t` | `hail` or `wind` |
| `y`, `m` | year, month |
| `mag` | hail inches, or wind knots |
| `sev` | severity 0..1 (same curve as the grid sums) |
| `cf`, `st` | county FIPS, state abbreviation |
| `lat`, `lon` | initial location |
| `pl` | reported property loss, USD |

Ids are a FNV-1a hash of the report's own coordinates, magnitude, day, month,
end point, path length and segment number — **not** a running index. An
index-based id renumbers every later event each time upstream gains a record,
which would silently repoint any saved selection or share link at a different
storm after a data refresh.

The published SPC database contains a small number of exact duplicate rows
(SPC rounds report coordinates to ~1 km, so two reports can collapse onto the
same point, size and month). The builder collapses them and records the number as
`duplicateEventsCollapsed` in `storm-sources.json` rather than dropping the fact.
| `len`, `wid` | path length / width, km (from SPC miles) |

Geometry is a `LineString` from start to end location when SPC recorded both,
and a bare `Point` otherwise. A missing track is normal for point reports — do
not assume one exists.

### Counties (`storm_counties.geojsonl`)

Identity: `fips`, `name`, `st` (postal), `stn` (full state name).

NRI (countyRisk in the ETL): `pop`, `bld` (building value), `eal` (total expected
annual loss), and for each of `h*` (hail) and `w*` (strong wind): `Eal`, `Rate`
(expected annual loss **per dollar of building value** — the actuarial form,
already normalised for exposure), `Rating`, `Risk`, `Events`, `Freq`,
`LossRatio`.

Observed storms: `hn`, `hs`, `hg`, `hx`, `wn`, `ws`, `wx`, `y0`, `y1`, `pl`,
`dc` — the same keys as the grid, aggregated by county centroid so a storm
straddling a boundary does not double-count a whole cell. Counties with no
matches carry the identity keys and NRI fields only.

NRI is **modelled** output on Hazus 6.0 exposure, not adjudicated insurance
loss. It is kept deliberately separate from observed report counts in
`src/data/stormScoring.js` so the two are never conflated.

## ⚠️ Data-completeness caveat — read before comparing decades

**Report density is not uniform across the record.** This is the single most
misleading thing about this data, and raw decade-over-decade comparisons are
wrong because of it.

From `storm-sources.json` → `completeness`:

| Decade | Hail reports | Wind reports | Wind with a measured speed |
|---|---|---|---|
| 1950s | 2,214 | 3,205 | 902 |
| 1960s | 7,532 | 10,114 | 3,824 |
| 1970s | 10,979 | 18,707 | 5,338 |
| 1980s | 26,566 | 39,604 | 11,057 |
| 1990s | 71,400 | 84,328 | 33,989 |
| 2000s | 137,278 | 128,809 | 116,710 |
| 2010s | 107,261 | 161,244 | 161,244 |
| 2020s | 51,251 | 116,060 | 116,060 |

The 2000s carry **~62×** the hail reports of the 1950s. Almost all of that is a
change in **reporting**, not in weather: spotters, radar, media, and automated
stations did not exist in 1957. The 2020s figure is low only because the bucket
is partial through 2025.

Consequences:

- **Never read "more reports in the 2000s" as "more hail in the 2000s."**
- Historical decades are reliable as *geography* — hail alley counties really do
  light up — but not as *frequency over time*.
- Wind magnitudes were rarely recorded before the 1990s (902 of 3,205 1950s wind
  reports carry a speed), so pre-1990 wind severity is systematically
  understated while the count is not.
- SPC reports are point observations from spotters, stations, and media. Dense
  coverage in a county means better reporting, not a worse hit.

The scoring code leans on this: frequency enters as `log10(1 + count)` rather
than linearly, so a fringe cell with one report is not collapsed to zero next to
a hail-alley cell with hundreds. `STORM_METHOD_CAVEATS` in
`src/data/stormAttribution.js` carries the same warnings into the UI.

## Scoring

`src/data/stormScoring.js` blends three quantities that are deliberately kept
apart, with user-visible weights (default 0.5 observed / 0.3 modelled / 0.2
exposure, 25-year recency half-life):

1. **Observed** — `0.34 × log hail freq + 0.28 × log wind freq + 0.20 × worst severity + 0.18 × compound days`, windowed through `dc`.
2. **Modelled** — FEMA NRI `hRate` / `wRate`, log-normalised.
3. **Exposure** — county `bld` building value, log-normalised.

Output is 0..1 and banded red/orange/yellow/blue on the same thresholds as the
FIRMS heat layer. `describeCellScore` returns the inputs and the caveats behind
any given number so a user can disagree with it.

Severity curves: hail 0.75 in (damaging) → 1.0 (severe) → 2.0 (significant) →
saturates at 3.0; wind 50 kt → 58 → 75 → saturates at 100. A `null` magnitude
scores 0 rather than discarding the event — an unmeasured hail report is still
evidence hail fell.

## Radar hail cores (MRMS)

`storm_radar_hail.geojsonl` is a separate, optional enrichment. It answers a
question the report record structurally cannot: **where did hail fall that
nobody filed a report about?** SPC's database is a file of human reports, so it
is blind by construction wherever storms happen without a witness who bothers
to call it in. MRMS is a national 1 km multi-radar mosaic and sees those storms
too.

The comparison is the whole point. A cell that radar shows a large hail core on
40 days but that has 4 filed reports is not low-risk — it is **under-reported**,
and the UI flags it as such rather than quietly showing a comfortable low
number.

Properties (abbreviated, decoded by `toRadarRecord`):

| Key | Meaning |
|---|---|
| `i`, `j`, `d` | grid index and step — identical space to `storm_cells_025`, so the join is a string key |
| `mx` | largest hail core seen, in **millimetres** (MRMS's native unit) |
| `cp` | 1 km points in the cell that reached the core threshold |
| `dy` | distinct days with a core |
| `y0`, `y1` | first and last year with a core |

### ⚠️ Three reasons radar is weighted low

1. **MESH over-reports.** NSSL documents Maximum Estimated Size of Hail running
   large against ground reports. It is good evidence of *where* hail fell and
   poor evidence of *how big* each stone was, so it is never used as a severity
   measure against reported hail size.
2. **Different record length.** MRMS starts in 2021; the report record starts in
   1955. A cell is not "half as risky" because the last five years are better
   observed.
3. **It measures a different thing.** Reports are "somebody filed one". Radar is
   "a core was detected". Neither is a substitute for the other.

It therefore enters the blend at a small weight, and only when the snapshot is
present — a missing file leaves every score exactly as it was rather than
silently deflating the whole map.

### Rebuilding

```bash
node scripts/build-storm-radar-snapshots.mjs                    # full archive
node scripts/build-storm-radar-snapshots.mjs --days 30          # recent month
node scripts/build-storm-radar-snapshots.mjs --from 2023-01-01 --to 2023-12-31
node scripts/build-storm-radar-snapshots.mjs --refresh          # bypass HTTP cache
```

A bare run reproduces the committed snapshot exactly (archive start
2021-01-01 through yesterday). Files are GRIB2 with PNG data packing, decoded
in-process by `scripts/lib/grib2.mjs` and `scripts/lib/png.mjs` — no
dependencies, no `wgrib2`, no `eccodes`.

> **The MRMS GRIB2 layout is compact and undocumented.** Its field offsets do
> *not* match the standard template 3.0 / 5.0 octet positions; they were
> established empirically against the archive and cross-checked with an
> independent decoder. `src/data/stormRadar.test.mjs` pins every one of those
> offsets with a synthetic fixture, including the 16-bit PNG variant that the
> rolling-maximum products use. Do not "fix" the offsets to the standard ones.

## Rebuilding

```bash
node scripts/build-storm-snapshots.mjs              # normal build
node scripts/build-storm-snapshots.mjs --refresh    # ignore the HTTP cache, re-download
node scripts/build-storm-snapshots.mjs --out <dir>  # write elsewhere
```

The script downloads the SPC archives, reads the Census shapefile (via
`scripts/lib/binary-geo.mjs`), pages the FEMA NRI feature service one state at a
time, and rewrites all five files in place. `--refresh` bypasses the cached
downloads in `scripts/lib/storm-fetch.mjs`, so use it when upstream data has
changed (the SPC archives are reissued annually) rather than on every run.
Rebuilding overwrites `storm-sources.json`, so its `builtAt`, `recordCounts`,
and `completeness` always describe the shipped files — review the count deltas
in the diff.

Upstream notes: Census is fetched newest-vintage-first (2025 → 2024 → 2023) and
falls back to older vintages; SPC coverage is published as 1955–2025.
# Next Iteration — Storm Reports, Storm Events, and a Timeline

Approved plan for the roofing-canvassing work. Supersedes the earlier
three-item list (HUD place readout, storm tracking, timeline).

The audience is a roofing company identifying hail and wind damage severe
enough to damage a home. **Hail size and location are the priority.** Storm
events, narratives and radar comparison follow behind them.

---

## What we verified

Read-only investigation against the live sources, 2026-10-15.

**We already discard precision we have.** The SPC bulk archive carries a full
ISO `date` and clock `time` on 100% of rows, plus start/end fields. The
existing build script maps `dy` into a field it calls `hour` and drops
`date`. Day-level data has always been available.

**The track endpoints are placeholders.** `elat`/`elon` look populated
(48–57% non-zero) but only **0.9% of hail** and **1.7% of wind** have genuine
start→end displacement. Tracks cannot come from SPC. Storm identity must be
derived, or taken from NCEI.

**SPC and NCEI are the same reports, differently shaped.** Verified at ~100%
0.1°-cell overlap across 270 matched days in 2025. 2025-06-29: SPC 211 rows,
NCEI 211 events, 151/151 cells shared. They join; they do not cross-check.

**IEM ASOS has no hail.** 719,576 observations across six busy 2025 severe
days produced **zero** valid METAR hail reports. An initial count of 584 "GR"
hits were false positives — `GRB` is Grabill, Arkansas; `GRN` is "green".
Airports do not report hail. ASOS is wind-only.

### Sources

| #   | Source            | Independent type   | Window             | Provides                                     |
| --- | ----------------- | ------------------ | ------------------ | -------------------------------------------- |
| 1   | SPC bulk archive  | human observation  | 2021–2025          | hail ″, wind kt, date, time, lat/lon, county |
| 2   | SPC daily CSVs    | human observation  | 2015 → Oct 14 2026 | same + verbatim `Comments`                   |
| 3   | NCEI Storm Events | agency narrative   | → Jun 30 2026      | `EPISODE_ID`, narrative, damage $            |
| 4   | MRMS radar        | **remote sensing** | 2021 → Oct 13 2026 | independent hail cores (already built)       |
| 5   | IEM ASOS          | **instrument**     | live               | measured peak wind — no hail                 |

Sources 1–3 are one underlying dataset in three shapes. Sources 4 and 5 are
genuinely independent.

### Rejected, with reason

- **CoCoRaHS** — independent volunteer network, would be valuable; bulk export
  is registration-gated and could not be verified.
- **NCEI Global Hourly / ISD** — directory listing not publicly accessible;
  IEM serves CONUS station data better.
- **NWS warning polygons** — warned areas are real storm footprints and
  independent of reports, but the IEM VTEC endpoint returned a form with no
  data rows. Worth another attempt.
- **FEMA NFIP** — flood only, no hail or wind.

### The actionable insight

Radar and instruments never pass through a human reporting pipeline, so their
disagreement with reports is signal, not noise. A cell with a strong MESH hail
core but **no filed report** means hail fell where nobody called it in — no
homeowner knows they have damage. That region is the canvassing map.

---

## Scale

Hail reports, 2021–2025, from the bulk archive:

| ≥     | reports | share |
| ----- | ------- | ----- |
| 0.75″ | 43,404  | 99.6% |
| 1.00″ | 36,436  | 83.6% |
| 1.25″ | 18,750  | 43.0% |
| 1.50″ | 14,447  | 33.1% |
| 2.00″ | 4,911   | 11.3% |
| 3.00″ | 817     | 1.9%  |

43,582 hail + 96,752 wind across 1,166 hail days; ~6,000 more hail reports in 2026. **Storage is not a constraint** — store the full range and filter in the
UI, so thresholds can always be tightened but never capped away.

---

## Data model

```
storm_reports_{2021..2026}.json.gz
  id, date, time, lat, lon, magnitude, hazard, countyFips, state,
  loss, comment, sources[], radarCoreMmes?, inWarning?

storm_events_{2021..2026}.json.gz
  id, name, begin, end, maxHail, maxWind, counties[], polygon,
  identitySource: 'ncei' | 'clustered', narrative, damageTotal

storm_cells_{2021..2026}.json.gz
  date, i, j, mmes, reportMax, reportCount, delta

storm_day_index.json
  date → eventIds[], reportCount
```

Every report carries `sources[]` so the UI can filter to "radar and reports
agree", or "radar says hail, no report exists".

Per-year files, lazy-loaded: opening a 2023 date pulls ~4 MB, not the whole
set. Only the day index loads up front.

---

## Coverage by era

| Source               | 2021–2025    | 2026 Jan–Jun | 2026 Jul–Oct            |
| -------------------- | ------------ | ------------ | ----------------------- |
| SPC bulk             | full         | —            | —                       |
| SPC daily            | full         | full         | full                    |
| NCEI                 | full         | full         | **not yet** (~3 mo lag) |
| MRMS                 | full         | full         | full                    |
| **→ storm identity** | real         | real         | **clustered**           |
| **→ narratives**     | daily + NCEI | daily + NCEI | daily only (~50%)       |

The only degradation is storm identity for Jul–Oct 2026. It self-heals: a
quarterly rebuild upgrades those to real `EPISODE_ID`s once NCEI publishes.

---

## Pipeline

1. Fetch SPC bulk → filter 2021–2025.
2. Fetch NCEI per-year gz → episodes, narratives, damage.
3. Fetch ~2,600 daily SPC CSVs → 2021–2026, same schema + comments.
4. Normalise. Daily `Size` is hundredths of an inch (`100` = 1.00″);
   bulk `mag` is already inches. Flag sub-1″ traces rather than dropping.
5. Join SPC ↔ NCEI on day + 0.1° cell + time proximity.
6. Cluster only the Jul–Oct 2026 residue (6 h / 150 km union-find); tag
   `identitySource: 'clustered'`.
7. Hull each event; rasterise the size-threshold grid.
8. Emit per-year files + day index, recording provenance per row.

---

## UI

- **Date control** — day / month / season scrubber over the day index
- **Map** — points sized and coloured by hail diameter, over the existing
  aggregate layer (which is retained)
- **Filters** — size range (default ≥1.0″, adjustable live), date, county, state
- **Sort** — by size descending
- **Source toggles** — each source independently on/off, plus a comparison
  mode showing agreement/disagreement between any two
- **Event drill-down** — report list, outline, narrative, damage total, and an
  identity-source badge so inferred identity is never shown as observed

---

## Build order

1. **`getScope` regression test.** 6,696 passing tests missed a fatal startup
   error (`Error: Unknown source: getScope`) because every fixture passed no
   source overrides. Close that gap first.
2. SPC bulk + daily CSVs → normalised reports.
3. MRMS cross-reference grid.
4. NCEI join → episodes, narratives, damage.
5. Cluster Jul–Oct 2026, validated against NCEI where both exist.
6. Swaths, timeline, source toggles.

---

## Risks

- **Daily/bulk mismatch.** Same reports, different shapes, but counts differ on
  some days (2025-06-29 matched 211/211; 2025-02-13 did not). The join is
  reliable, not guaranteed 1:1. Log unmatched rows rather than dropping them.
- **Clustering quality.** Jul–Oct 2026 events are inferred. Validate against
  NCEI episodes where both exist and tune to agreement before trusting it.
- **Narrative coverage.** NCEI carries narrative on 100% of events; daily
  `Comments` only on roughly half — many rows read just `(MEG)`, a forecast
  office code, with no text.

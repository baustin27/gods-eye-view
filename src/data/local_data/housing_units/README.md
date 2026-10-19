# Housing units

Housing-unit counts by county, place, tract and ZCTA, for the same question the
storm data answers: not *where did hail fall*, but *how many roofs are under
it*.

Everything in this folder is **derived offline** from the US Census Bureau's
American Community Survey 5-year table **B25001 (Housing Units)**. Nothing here
is fetched at runtime, and the app needs no Census key and no network to use it.
A free Census API key is used by `npm run build:housing-units` at build time
only, and never reaches the browser — the same rule the storm dataset follows.

## The files

| File | Geography | Rows | Key |
|---|---|---|---|
| `housing_units_county.json.gz` | county | 3,222 | `state` + `county` (5 digits) |
| `housing_units_place.json.gz` | place (city, town, CDP) | 32,325 | `state` + `place` (6 digits) |
| `housing_units_tract.json.gz` | census tract | per state | `state` + `county` + `tract` (11 digits) |
| `housing_units_zcta.json.gz` | ZIP code tabulation area | 33,772 | ZCTA (5 digits) |
| `housing-units-sources.json` | — | — | provenance, counts, verification record |

Each artifact is gzipped JSON:

```json
{
  "meta": { "vintage": 2023, "variable": "B25001_001E", "rows": 3212, ... },
  "rows": [ { "id": "08001", "name": "Adams County, Colorado", "units": 191765, "moe": 125 } ]
}
```

`moe` is the 90% margin of error from the ACS. It is `null` where the Census
published an estimate without one. **Do not drop it.** B25001 is a SAMPLE
estimate, and a county with 1,900 housing units can carry a margin of 125 —
a number without its margin is a claim the data does not support.

## Three things that are load-bearing

**The variable is B25001, and it was nearly not.** The first candidate was
B25031, which is *Median Gross Rent by Bedrooms* — a dollar figure. It returns
a plausible number for every county (1,713 for Adams County, Colorado) with a
tight margin of error, and a state-wide SUM of those is 80,000 against a true
total near 2.4 million. Nothing about it looks wrong on its own. The only
thing that caught it was comparing the sum against the population.

So the build **verifies the table against two other ACS totals** before it
writes anything: B25002 (occupancy status) must EQUAL B25001, and B25003
(tenure) covers occupied units only so it must be less than or equal. A build
that checks its own arithmetic against two independent totals cannot ship a
number that is a rent figure wearing a count's name. The verification record is
in `housing-units-sources.json`.

**The no-data sentinel is dropped, and the count of drops is published.** The
Census publishes `-666666666` for a geography it could not estimate. That is
not a negative count. A SUM over those sentinels produces a large negative
number that looks like a real total and propagates into everything built on
top. Rows carrying it are dropped and the count is written to the manifest,
because a coverage gap that is not stated is a coverage gap that is invisible.

**ZCTA is attributed to a state by a join, not by the API.** The ACS publishes
ZCTA only as a *national* list with no state hierarchy — `in=state:` is
rejected for that geography and the wildcard is the only form that works. So
each ZCTA's gazetteer internal point is tested against the county polygons this
repository already bundles, and the county it lands in is recorded alongside
the count. ZCTAs that fall outside every county in the state are not in the
state.

## What the totals look like

Colorado, 2023 ACS 5-year:

| Cut | Housing units |
|---|---|
| 64 counties | 2,545,124 |
| 1,447 tracts | 2,545,124 — **identical**, because tracts partition the counties |
| 482 places | 2,185,912 — lower, because unincorporated land is not a place |
| 527 ZCTAs | 2,537,193 — 99.7% of the county total |

The tract and county totals matching exactly is the end-to-end check that the
whole pipeline is sound: 1,447 independently-estimated tracts sum to the same
number as 64 independently-estimated counties.

## Attribution

US Census Bureau, American Community Survey 5-year estimates, table B25001.
**Public domain** (17 U.S.C. § 105). The ZCTA gazetteer is likewise a US
Government work.

## Rebuilding

```bash
npm run build:housing-units -- --state 08
```

`--state` takes a two-digit state FIPS, or `all` for every state. The key
comes from `CENSUS_API_KEY` in `.env`; the script refuses to run without one
rather than producing an empty artifact that would read as "no housing units
anywhere".

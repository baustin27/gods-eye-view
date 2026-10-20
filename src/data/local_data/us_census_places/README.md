# Census places

The boundaries of US **cities, towns, villages and census-designated places**,
from the Census Bureau's cartographic boundary files (500k simplification).

## Why these are here

The storm dataset answers "where did hail fall" at county and grid-cell
level. A canvasser works in a **town** — "is Fort Collins worth a day?" — so
this pack is what turns 155,738 point reports into a list of places with
counts in them.

The GEOID is the **seven-digit state+place FIPS**, which is the same key the
ACS housing-unit artifact (`../housing_units/`) is keyed by, so a place joins
to its housing count with no crosswalk at all.

They also replace an approximation: the globe used to treat a city as a
**0.25-degree box** around its name, because no city boundary shipped with
these bundles. `src/data/isolation.js` still does that, and this pack is what
lets it stop.

## The file

`places.json` — one feature per place, in the same delta-ring format as
`../us_census_counties/counties.json`:

```
features[]: name, full (NAMELSAD), lsad? (City, town, CDP, …),
            state (name), st (USPS), geoid (7-digit state+place FIPS),
            d? (decimals when not meta.decimals),
            polygons[][ring] (first ring outer, rest holes; each ring open and
            encoded as integers in 10^-d degrees, first vertex absolute then
            [dLon, dLat] deltas)
```

## Attribution

US Census Bureau, cartographic boundary files, 2023 vintage, 500k
simplification. **Public domain** (17 U.S.C. § 105).

## Rebuilding

```bash
node scripts/build-admin-packs.mjs --only census-places
```

The source is pinned by SHA-256 in `scripts/build-admin-packs.mjs`, so a
changed upstream file fails the build rather than silently changing the
geometry.

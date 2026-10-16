# Natural Earth packs

Offline named-region polygons for the voice-annotation resolver
(`src/data/naturalEarthRegions.js`) — "outline the Alps" resolves to the real
range geometry with no network dependency.

| File | Source dataset | Features |
|------|----------------|----------|
| `regions.json` | `ne_10m_geography_regions_polys` (ranges, deserts, plateaus, peninsulas, islands, …) | 1,046 named |
| `marine.json` | `ne_10m_geography_marine_polys` (seas, gulfs, straits, bays, …) | 292 named |
| `countries.json` | `ne_10m_admin_0_countries` (countries) | 256 |
| `states_provinces.json` | `ne_10m_admin_1_states_provinces` (states, provinces and other first-level units) | 4,587 named |
| `places.json` | `ne_10m_populated_places_simple` (city and town points — no outlines) | 6,491 places |

**Source:** Natural Earth 10m physical vectors, via the canonical
[nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
GitHub repo, commit `ca96624a56bd078437bca8184e78163e5039ad19` (fetched
2026-07-28T01:36:39Z — exact provenance is in each file's `meta` header).

**License:** public domain (https://www.naturalearthdata.com/about/terms-of-use/).
No attribution legally required; we credit "Made with Natural Earth" anyway.
See DATA_SOURCES.md.

**Curation** (script not committed — parameters recorded in `meta.curation`):

- Named features only; the `Dragons-be-here` joke feature ("Null Island") dropped.
- Outer rings only (holes are irrelevant at country-scale outline zoom).
- Douglas-Peucker simplification at 0.01°, coordinates rounded to 3 decimals
  (~110 m), rings stored open (no closing duplicate vertex).
- MultiPolygon crumbs under 20 km² dropped (largest part always kept);
  rings that survive with fewer than 8 distinct vertices are midpoint-densified
  (shape-identical) so every ring has ≥8 vertices.
- Zero-area sliver artifacts dropped. Two marine features are ONLY slivers in
  the source and are therefore absent: **Drake Passage** and **Luzon Strait**.
- Result: 7.3 MB source → 2.5 MB pack (budget ≤3 MB, enforced by
  `src/data/naturalEarthRegions.test.mjs`).

Duplicate names exist upstream (two "Cordillera Oriental", a sliver + real
"Canadian Shield", …); the lookup module resolves ties by largest area.

## States and provinces (`states_provinces.json`)

Worldwide first-level administrative units for area annotations ("outline
Texas", "outline Bavaria"), read by `src/data/adminBoundaries.js`.

**Source:** `geojson/ne_10m_admin_1_states_provinces.geojson` from
[nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
at commit `ca96624a56bd078437bca8184e78163e5039ad19` (SHA-256
`22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5`), fetched
2026-09-25. `geojson/ne_10m_populated_places_simple.geojson` from the same
commit (SHA-256
`fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f`) is read to
mark ambiguous names — "Georgia" is a country and a state, "New York" is a state
and a city — and is separately emitted as `places.json` (below).

**License:** public domain, as above.

**Regenerate:** `node scripts/build-admin-packs.mjs --only admin1` downloads
the pinned files (to the system temp directory, or `--cache <dir>`), checks
their SHA-256 and rewrites the pack byte for byte. Parameters are in the
script's `PARAMS` and in the pack's `meta.curation`.

**Schema:** `meta` (source, URLs, hashes, license, curation) and `features[]`
with `name`, `nameEn` (when it differs), `alt[]` (Latin-script `name_alt`
variants and abbreviations), `postal`, `type` (`type_en`), `rank`
(`min_label`), `country` (`admin`), `iso2`, `iso` (ISO 3166-2), `amb[]`,
`ambAbroad[]`, `cityState`, `label` ([lon, lat] label point) and
`polygons`. `polygons` is a list of parts, largest first, each
`[outer, ...holes]`; every ring is open and stored as integers in units of
10^-3 degrees (10^-`d` when a feature carries `d`), the first vertex absolute
and each later one as a `[dLon, dLat]` delta.

**Curation:**

- The 7 unnamed features and 2 degenerate Nauru districts are dropped
  (4,596 → 4,587).
- Douglas-Peucker per ring at 0.004 × √(unit area in km²) km, clamped to
  0.005°–0.02° (Texas ≈ 0.02°, Bavaria ≈ 0.01°); coordinates rounded to
  3 decimals. The 75 units too small to survive (Maldives atolls, Malta's
  councils) keep 4 decimals at 0.001° (`d: 4`); 3 smaller still (Vatican
  City) keep their source rings at 5 decimals (`d: 5`).
- Parts under 20 km² or under 0.03% of the unit's largest part are dropped;
  holes under 20 km² are dropped. Outers are counter-clockwise, holes
  clockwise.
- `amb` lists names that are also a country (`admin`/`geonunit` of any
  unit), a populated place of 200,000+ (`pop_max`) inside the unit's box
  when the unit is larger than 1,000 km², or a populated place of 50,000+
  elsewhere in the same country; `ambAbroad` lists names shared only with a
  populated place of 50,000+ in another country. `cityState` marks a unit of
  at most 1,000 km² that contains its namesake city (Berlin, Vienna, Paris).
  548 units carry `amb`, 108 `ambAbroad`, 138 `cityState`.
- Result: 3,648,916 bytes (1,260,545 with gzip -9); 6,492 parts, 80 holes,
  407,339 vertices.

## Countries (`countries.json`)

Natural Earth 10m admin-0 countries, public domain under the terms above.
Source: `geojson/ne_10m_admin_0_countries.geojson` at the same pinned commit;
SHA-256 `239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255`.
Regenerate with `node scripts/build-admin-packs.mjs --only countries`.
Uses the state/province encoding and simplification, retaining parts of at least
20 km² and 0.003% of the largest part (including Alaska and Hawaii); the largest
part always stays. Holes under 20 km² are dropped.
Includes England, Scotland, Wales and Northern Ireland from
`ne_10m_admin_0_map_units.geojson` at the same commit (SHA-256
`57da82be755f4afccd8f3b14251bb2752f5df1395f47d2d86f817470c4a48862`).
Result: 945,843 bytes; 260 features, 2,088 parts, 122,788 vertices.

## Populated places (`places.json`)

Worldwide city and town POINTS, so "isolate to Denver" resolves a city with no
network lookup and "cities in Oklahoma" can list a box. Read by
`src/data/places.js`.

**A city has no boundary in this dataset.** `ne_10m_populated_places_simple`
carries no city geometry at all, so the pack holds a point and a population and
nothing else. Isolating to a city means a box scaled by population around the
point; that box is an approximation — a guess at how far out to frame a camera,
not a surveyed edge — and the module says so on every result
(`boundary: null`, `approxRadiusKm`).

**Source:** `geojson/ne_10m_populated_places_simple.geojson` at the same pinned
commit; SHA-256
`fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f` — the same
file `states_provinces.json` already reads to mark ambiguous names, now read a
second time for the pack itself. `geojson/ne_10m_admin_1_states_provinces.geojson`
at the same commit (SHA-256 `22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5`)
supplies each place's two-letter subdivision code.

**License:** public domain, as above.

**Regenerate:** `node scripts/build-admin-packs.mjs --only places`.

**Schema:** `meta` (source, URLs, hashes, license, curation, and the
`approximate` warning) and `features[]` with `name`, `lat`, `lon`, `population`
(`pop_max`, the row's largest published figure), `country` (`adm0name`),
`region` (`adm1name`, `null` where the source has none), `scale` (`scalerank`,
Natural Earth's label prominence — lower is more prominent), `iso`, `iso2`,
`adm1code?` (the subdivision's two-letter code, absent where the source has none)
and `id`.

**Curation:**

- Rows under **5,000** people are dropped, except a national capital, which is
  kept however small (Vatican City has 832 people in this data and is still a
  place people name). The source spans 7,342 rows from megacities down to
  single-farm settlements, and the tail below 5,000 is where the noise lives;
  the floor keeps 6,488 of the 7,340 real rows, including 668 of the 769 US ones
  and every county seat of a small county, so a rural map is not left empty.
  6,491 rows survive (7,340 → 6,488 by population, plus 3 small capitals).
- Two rows whose `pop_max` is Natural Earth's `-99` "population unknown"
  sentinel are dropped; it is not a population.
- Names are stripped of the invisible marks Natural Earth writes some with, and
  coordinates are rounded to 3 decimals (~110 m).
- `id` is the name slug plus the ISO alpha-3 country (`denver-usa`), plus the
  region where one country has two of that name (`springfield-usa-oregon`).
- Result: 1,146,305 bytes (254,347 with gzip -9).

## Populated places (`places.json`)

City and town **points** — no outlines — used as the third rung of the isolation
resolver, behind countries and states. Read by `src/data/places.js`
(`findPlace`, `placesForBox`) and consumed by `src/data/isolation.js`.

This file is not new work. `build-admin-packs.mjs` already downloaded
`ne_10m_populated_places_simple` on every run, used it to mark ambiguous state
names, and threw it away. It now emits it.

| | |
|---|---|
| Features | 6,491 places |
| Uncompressed | 1,146,305 bytes |
| Gzipped | 254,347 bytes |
| Population floor | 5,000 |
| Exception | national capitals are kept regardless of population (Vatican City is 832 people and still a place people name) |

**A place has no boundary in this data**, so isolating one is a box scaled by
population around the point. Every result therefore carries `boundary: null`, and
`describeIsolation()` says "approximate: point with a radius, no boundary data"
everywhere the label appears. Denver resolves to roughly a 48 km × 48 km box;
the box is the answer rather than a frame around a real shape, so a report just
outside the metro counts as inside. That is the honest limit of this rung, stated
in the UI rather than hidden.

**Ambiguity.** `findPlace` settles duplicate names the way `adminBoundaries`
does — population, then a two-letter subdivision code — so the five Springfields
and the several Denvers are separable ("Denver, CO" vs "Denver, NC").

**Regenerate:** `node scripts/build-admin-packs.mjs --only places`

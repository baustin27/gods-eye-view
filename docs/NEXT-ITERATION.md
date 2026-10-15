# Next Iteration — Requested Changes

A list, captured before any of it is built. Nothing here is implemented.

The Storm hail & wind layer as it stands is a per-cell aggregate surface: useful
groundwork, but not the product. These three items are what would make it
worth having, and item 3 in particular is the one that changes what the rest
of the layer is for.

---

## 1. HUD place readout — country, state, city, county, ZIP

**Want:** the heads-up display shows where the camera is, by place, updating as
you pan.

**Today:** there is no place readout at all. The HUD carries `hud-latlon`,
MGRS, GSD, altitude and a bottom line — nothing that names a place.

**What it needs:** reverse geocoding. Nominatim's `/reverse` returns all five
levels in one response, but that is a network call per pan, so it needs
debouncing and a cache. There is no reverse-geocoding path in the app today;
the existing geocoders are forward-search only.

**Open questions:**

- Update on pan-end, or throttled during the pan?
- How far in do you zoom for locality detail? ZIP is very local — at country
  scale the honest answer is "United States / Colorado" and nothing finer.

---

## 2. Individual storm tracking, not aggregate heatmaps

**Want:** track individual storms — the way HailTrace-style products do — rather
than a per-cell surface.

**Today:** the layer paints one blended score per 0.25° cell and colour-bands
the country. There is no storm entity, so nothing to follow.

**What exists:** 37,245 significant events in `storm_events.geojsonl`, each with
hazard, magnitude, county, state, date, position and — where the SPC recorded
one — a track. Each is standalone. Nothing clusters them into episodes, so there
is no storm identity, no "this storm moved through these counties on this date".

**What it needs:** storm grouping (events into episodes, by time and geography),
then a per-storm detail view — cells affected, reports, damage, track, duration.

This is the largest gap between the layer and the products it is competing
with, and it is the prerequisite for item 3 being useful.

---

## 3. Timeline — view the app as of a given moment

**Want:** a scrubber that puts the whole application into a particular moment in
time, with the map, layers and readouts all following.

**Today:** no global timeline. The files matching "timeline" are unrelated
features (BhoteKoshi media, launches replay, contact playback).

**The constraint that matters.** Granularity in the snapshot is not daily:

| Source                  | Granularity                                                  | Coverage                |
| ----------------------- | ------------------------------------------------------------ | ----------------------- |
| Bundled SPC snapshot    | decade buckets, plus the per-year buckets added in `74f41f0` | 1955–2025               |
| Radar hail cores (MRMS) | per day                                                      | 2021-01-01 → 2026-10-13 |

So "as of this date" cannot be answered at cell resolution from what is bundled.
Either the snapshot is rebuilt with finer buckets, or recent dates are assembled
live — SPC publishes daily CSVs, which `storm-recent` already fetches for today
and yesterday but not for arbitrary days.

**Design call to make when this starts:** rebuild the snapshot finer, or fetch
per day. Rebuilding is a one-off cost and gives instant scrubbing across the
whole record; live fetching keeps the artefact small but makes every scrub a
network round trip.

---

## Notes on the current state

- Everything from the current storm work is committed but **not pushed**: 11
  commits ahead of `origin/main`.
- The branch is **487 commits behind `origin/main`**. All 11 commits sit on a
  stale base, so rebasing should happen before the next item is built on top —
  some of what was just fixed may already be fixed upstream.
- `npm test` is at 4322/4325; the three failures are pre-existing and unrelated
  (key-setup 403, dev/preview server smoke test, and one tooling check).

# KNOWN ISSUES

Updated: September 22, 2026

This file tracks active runtime issues only.

For the roadmap and open backlog, see the repository issue tracker.

---

## Open

### The registered work is open
Status: Open (work in progress)

Context: the outstanding work for this repository is in
`scripts/task-registry.json`, and `npm run check:tasks` fails on any task
that is not `done`. The point of the file rather than a paragraph is that an
incomplete piece of work must be visible in a place a machine reads, so
that "stopped halfway" is a failed check rather than something nobody
notices.

Next iteration candidates: drain the registry. The waves are in
`.opencode/plans/PATH-B-REGISTRY.md` and the rules are in `AGENTS.md`.

---


### Street traffic can be slow/uneven when panning across dense city blocks
Status: Open (partially mitigated)

Context:
- Current traffic loader fetches one clamped viewport tile at a time (major pass, then full pass).
- In dense cores, some visible roads can appear late after city jumps or fast pans.
- Zooming into adjacent streets does not always immediately trigger higher-detail coverage for all visible roads.

Current mitigation in runtime:
- Fair per-road dot budget allocation (reduces hard starvation under global `MAX_DOTS` cap).
- Center-shift threshold (reduces stale overlap lock while panning).

Next iteration candidates:
- Prioritize currently visible road segments inside the active viewport before off-center segments.
- Add neighbor prefetch ring for nearby tiles after jump-to-city actions.
- Add adaptive dot cap by frame time (coverage first, density second).
- Promote sync chip from loading indicator to true multi-phase progress.

---

### CCTV panel can appear "missing"
Status: Open (workaround available)

Context:
- The rails lay their panels out themselves. No panel is dragged into place at
  startup and no stored position is read, so a panel that looks missing is
  collapsed or its layer is off rather than parked off-screen. The CCTV panel
  starts collapsed and stays that way until you open it or a camera activates.

Workaround:
- Check that the CCTV layer is enabled in the Layers panel, then open the panel
  from its header control; it also opens on its own when a camera activates.
- To force it open on an ordinary load, store the expanded state and reload. In
  the browser console:
  - `localStorage.setItem('godsEyeView.v6.panelCollapsed.cctv-panel', '0');`
  - `location.reload();`
- Removing that key instead returns the panel to its default, which is collapsed:
  - `localStorage.removeItem('godsEyeView.v6.panelCollapsed.cctv-panel');`
  - `location.reload();`
- Neither console line changes anything when the page was opened from a share
  link: a shared view is laid out from the link, not from what this browser has
  stored, so open the panel from its header control instead.

Related keys (current versions):
- Panel collapsed state: `godsEyeView.v6.panelCollapsed.<panel-id>` — `'0'` open,
  `'1'` closed, absent means the panel's own default. A view opened from a share
  link ignores the stored value entirely.
- Panel positions: `godsEyeView.v8.panelPos.<panel-id>` — written only for a
  floating portable panel (CCTV, Street Level). Deleting it, or double-clicking
  the panel header, docks the panel again.
- CCTV calibration: `godsEyeView.cctv.calibration.v2`

---

### Height-datum residuals (branch `feat/height-datum`, pending merge)
Status: Open (owner-accepted 2026-07-08, documented)

- **Cold-start floor latency:** at a freshly-visited airport, grounded/low aircraft
  float low for ~1–2 poll cycles (30–60 s) and rise as terrain floors resolve;
  a few stragglers take one more poll.
- **Born-grounded first poll:** a contact first seen on the ground with no altitude
  data renders at the geoid for ≤1 poll until its floor cell warms.
- Full context, improvement ideas, and the verification oracle
  (`scripts/qa-floor-verify.mjs`):
  `docs/superpowers/reports/2026-07-08-height-datum-handover.md`.

---

### Weather layers: coverage and meaning
Status: Open (source limits, by design)

- **Rain radar covers the contiguous United States only.** It shows MRMS
  reflectivity in dBZ, not rainfall rate or a forecast; a gap in coverage does not
  mean no precipitation.
- **Lightning density is a ground-network grid, not GLM flashes.** It is NOAA's
  15-minute density product derived from Vaisala NLDN/GLD360 on an approximately
  8 km grid, for the Americas and Pacific only (110°E across the dateline to 0°,
  25°S–80°N). It is not a live strike counter or an all-clear.
- **Cyclone advisories cover NOAA's basins only:** the Atlantic and the
  eastern/central North Pacific (NHC and CPHC). Storms elsewhere do not appear.
  The cone is forecast-center uncertainty, not storm size.
- **Satellite clouds:** global infrared is hourly with typically 2–3 hours of
  source latency. Clouds only is a brightness filter, not a cloud mask.
- **Wind is a forecast.** The animation flows through one forecast on an
  approximately 1° grid and does not advance forecast time or follow the
  observed-history timeline.
- **History is not shared.** Share links carry the weather layers and their
  settings but open at Latest.
- **3D Tiles detail window during history playback:** when a frame's detail image
  is slow to arrive, the window may fall back to the coarser full-extent image
  until it does.
- Native hardware GPU behavior of the wind and weather renderers is not yet
  verified.

---

### Satellite passes and analyst answers
Status: Open (by design)

- Pass predictions search the next 24 hours for satellites in the loaded catalog.
  Visibility is a geometric estimate (satellite sunlit, observer's Sun at or
  below −6°); it ignores weather, satellite brightness and orbital-element age.
- Analyst counts and ranks cover a bounded set of loaded records (by default
  2,000 per layer for satellites, datacenters and dams), so omitted records can
  change a nearest or count answer. Satellite distance is ground distance.

---

### Live camera video (HLS)
Status: Open (limits)

- At most two live-video sessions run at once. RTMP-only sources and encrypted,
  fMP4 or byte-range playlists are not supported.
- When live video fails, the camera falls back to its labeled still, Street View
  or placeholder frame, which is not live video.

---

### The desk's tract layer: simplified boundaries, and a count that is sometimes absent
Status: Open (by design)

Context:
- The tract outlines the desk draws come from the Census cartographic boundary
  file at 500k (`cb_2025_us_tract_500k`), which the Census SIMPLIFIES. A ring on
  the map can be tens of metres from the true boundary of the tract, so a
  property line drawn from it is a line the Census drew, not a survey.
- The housing-unit count is the ACS 5-year B25001 estimate, and the artifact
  covers 52 states, DC and Puerto Rico. Arizona's tracts and the four US
  territories (60, 66, 69, 78) have no count, and 141 tracts across the
  territories and New York have no row. The desk reports that as NO ESTIMATE
  (`units: null`) and never as zero: a zero is a number, and an absence is not.
- The count is a SAMPLE estimate and carries a margin of error. The margin
  travels with it in the tract list (`moe`), and a number without its margin is
  a claim the data does not support.

Validation target:
- `server/providers/deskTracts.js`
- `src/data/local_data/housing_units/README.md`

---

## Closed / Intentional (for clarity)

### Proxy SSRF and error-surface hardening gaps
Status: Closed as fixed on `main`

Context:
- Proxy middleware previously allowed broader error/internal surface area and looser upstream handling.
- Current `main` includes hardened proxy behavior in `vite.config.js`:
  - CCTV upstream URL no longer accepted from client query params.
  - Error payloads are sanitized.
  - OpenSky cache stores successful responses only.
  - OpenSky token refresh is coalesced.
  - GBFS/CCTV memory growth is bounded.

Validation target:
- `vite.config.js`

---

### NVG vignette edge color bleed
Status: Closed as fixed in current shader composite

Context:
- Earlier builds leaked original scene colors near the NVG tube edge.
- Current composite now masks NVG output with tube falloff before final blend, removing the color edge bleed.

Validation target:
- `src/styles/surveillance.js`

---

### Wildfires layer unavailable / static bundled snapshot
Status: Closed — live FIRMS integration shipped (2026-07-16)

Context:
- Wildfires (NASA FIRMS) were removed from runtime in v0.5.3, returned June 2026 as a
  bundled-snapshot layer (`local-firms`, 2026-05-25 data, ~58 MB in-repo), and were
  converted to **live NASA FIRMS data** on 2026-07-16: the `/api/firms` proxy merges
  three VIIRS NRT sources (trailing 24 h, 30 min cache, serve-stale-on-failure) and the
  bundled snapshot was deleted. Requires a free server-side `FIRMS_MAP_KEY`; without it
  the layer row reads "Needs FIRMS_MAP_KEY — add it in Provider Settings".

---

### Weather radar held out of the open-source release
Status: Closed — observed rain radar shipped (September 2026)

Context:
- Rain radar, Satellite clouds, Lightning density, Wind and Cyclone advisories
  are in the Weather group of Data Layers. Their current limits are listed under
  "Weather layers: coverage and meaning" above.

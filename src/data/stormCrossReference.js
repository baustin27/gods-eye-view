/**
 * Radar-versus-report cross-reference.
 *
 * Radar and human reports are independent observations, which is the only
 * reason disagreement between them means anything. Every other pair in this
 * pipeline — SPC bulk, SPC daily, NCEI — is the same reports in different
 * shapes, so they cannot cross-check each other.
 *
 * That disagreement is the actionable part:
 *
 *   radar core, no report   hail fell and nobody called it in. No homeowner
 *                            knows they have damage. This is the canvassing
 *                            map.
 *   report, no radar core    likely marginal hail, or a cell the core threshold
 *                            missed. Low priority.
 *   both                    confirmed.
 *
 * All three classes are emitted. A report-only cell used to be dropped on the
 * way out, which did not merely lose the cell: the headline share counted only
 * `both` and `radar-only`, so the denominator quietly shrank and the one number
 * this module exists to produce was computed over a biased sample.
 *
 * Both datasets share the 0.25-degree grid, floored rather than rounded, so a
 * report and a radar core attribute to the same `i,j`. Rounding shifts a
 * report half a cell north-east and the two can never be joined — that was
 * fixed once already and is why {@link gridCell} floors.
 *
 * Pure: no I/O.
 * @module data/stormCrossReference
 */

/** The grid both datasets use. */
export const GRID_DEG = 0.25;

/**
 * Floored grid index. Floor, not round: the emitted cell centre is
 * `index * step + step / 2`, so rounding would put every report half a cell
 * north-east of the cell it belongs to and break the join.
 * @param {number} value
 * @param {number} [step]
 * @returns {number}
 */
export function gridCell(value, step = GRID_DEG) {
  return Math.floor(value / step);
}

/**
 * Read a radar snapshot into a cell lookup.
 *
 * The feature properties are the short keys the builder emits: `i`, `j` for
 * grid indices, `mx` the peak hail millimetres, `cp` the count of 1km cores.
 * @param {string} text GeoJSONL.
 * @returns {{cells: Map<string, {mx: number, cores: number}>, days: number}}
 */
export function indexRadarCells(text) {
  const cells = new Map();
  let days = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let feature;
    try {
      feature = JSON.parse(line);
    } catch {
      continue;
    }
    const p = feature?.properties;
    if (!p || p.i === undefined || p.j === undefined) continue;
    cells.set(`${p.i}:${p.j}`, {
      mx: Number(p.mx) || 0,
      cores: Number(p.cp) || 0,
    });
    if (Number(p.dy) > days) days = Number(p.dy) || 0;
  }
  return { cells, days };
}

/**
 * Read a decoded per-day radar field into the same cell lookup
 * {@link indexRadarCells} produces.
 *
 * The point is the shape, not the source. `crossReference`,
 * `summariseAgreement` and `canvassTargets` read `{mx, cores}` and nothing else,
 * so a per-day field indexed here is indistinguishable from the GeoJSONL index
 * and none of them needs a change. `mx` is the strongest reading for the cell
 * across the days handed in.
 *
 * Input is the loader's `Map<dayIndex, Map<'i:j', number>>`, a single day's
 * `Map<'i:j', number>`, or an iterable of `[key, mm]` pairs. Millimetres are
 * taken as measured — the loader already applied the artifact's scale, so none
 * is applied here.
 *
 * `cores` is NOT the 1km core count that `indexRadarCells` carries from `cp`.
 * The per-day artifact stores one peak per cell per day and no core tally, so
 * this is a presence flag: 1 when the cell's peak reaches {@link HAIL_CORE_MM}
 * on a day in the input, else 0. Every consumer reads `mx`; the flag exists so
 * the object keeps the shape they key on rather than growing a second one.
 *
 * @param {Map|Array} dayCells
 * @returns {{cells: Map<string, {mx: number, cores: number}>, days: number}}
 */
export function indexRadarDays(dayCells) {
  const cells = new Map();
  let days = 0;
  const absorb = (readings) => {
    days += 1;
    for (const [key, value] of readings) {
      const mx = Number(value);
      if (!Number.isFinite(mx)) continue;
      const seen = cells.get(key);
      if (!seen) {
        cells.set(key, { mx, cores: mx >= HAIL_CORE_MM ? 1 : 0 });
        continue;
      }
      if (mx > seen.mx) seen.mx = mx;
      if (mx >= HAIL_CORE_MM) seen.cores = 1;
    }
  };
  if (dayCells instanceof Map) {
    // A year map nests a day map per entry; a single day is flat. Detect rather
    // than require a wrapper, so the loader's output passes straight through.
    if ([...dayCells.values()].some((value) => value instanceof Map))
      for (const day of dayCells.values()) absorb(day);
    else absorb(dayCells);
  } else if (Array.isArray(dayCells)) {
    absorb(dayCells);
  }
  return { cells, days };
}

/**
 * How a cell's two observations agree, or fail to.
 * @typedef {Object} CrossCell
 * @property {string} key       `i:j`.
 * @property {number|null} lat  Cell centre.
 * @property {number|null} lon
 * @property {number|null} radarMaxMm  Peak radar hail.
 * @property {number} reportCount
 * @property {number|null} reportMax  Largest reported magnitude.
 * @property {'both'|'radar-only'|'report-only'} agreement
 * @property {boolean} implausible  The radar estimate is beyond what hail
 *   actually reaches, so this cell is a radar artefact rather than evidence.
 */

/**
 * Above this, MESH is reporting something hail does not do.
 *
 * MESH is a vertically-integrated liquid estimate derived from reflectivity,
 * not a measurement of a stone. Applied per day — the scale at which a canvasser
 * acts, and the scale at which {@link indexRadarDays} feeds this — a 100mm
 * reading is a credible extreme day: of the 1,407,918 cell-days in the 2021-2026
 * per-day artifact, 3,036 (0.22%) reach 100mm, about 1.4 cells on an average
 * day. Against a six-year lifetime maximum the same threshold is far less
 * selective and far less credible as a stone: 2,386 of 21,947 cells (10.9%) in
 * the combined file exceed it. The 1.4% once quoted here was a 2026-only figure
 * and is wrong for the archive. The constant stays at 100mm; only its meaning —
 * per day rather than per lifetime — changes.
 *
 * Those cells are kept so the grid does not develop holes, but flagged, and
 * they are never ranked as canvass targets.
 *
 * This is why `radarMaxMm` must never be shown next to `reportMax`: one is an
 * estimate from reflectivity, the other is a measured stone. Reading them as
 * the same quantity would send someone to drive after a radar artefact.
 */
export const RADAR_IMPLAUSIBLE_MM = 100;

/**
 * The core strength, in millimetres, at which a radar cell is a hail core at
 * all.
 *
 * This is the read side of `HAIL_CORE_MM` in
 * `scripts/build-storm-radar-snapshots.mjs`. The builder decides which cells are
 * written; this decides which written cells count as evidence. The two must
 * track each other: if the builder is lowered without this, a 20mm core lands
 * in the file and this module calls it no hail at all, and the radar-only count
 * — the canvassing map — goes quietly blank.
 */
export const HAIL_CORE_MM = 25;

/**
 * Join reports onto radar cores and classify every cell either side touched.
 *
 * All three classes are returned: `both`, `report-only` and `radar-only`. Only
 * cells that at least one source knows about appear, so a quiet month produces
 * an empty list rather than a sparse one. `lat`/`lon` are the cell centre,
 * because that is where the hail actually fell as far as the grid is concerned.
 *
 * @param {Array} packedReports From {@link module:data/stormReports.loadStormReports}.
 * @param {Map<string, {mx: number, cores: number}>} radarCells
 * @param {{minSize?: number, hazard?: 'hail'}} [filter]
 * @returns {CrossCell[]}
 */
export function crossReference(packedReports, radarCells, filter = {}) {
  const { minSize = 0, hazard = 'hail' } = filter;
  const byCell = new Map();
  for (const row of packedReports) {
    const [, , hazardCode, size, lat, lon] = row;
    if ((hazardCode === 0 ? 'hail' : 'wind') !== hazard) continue;
    if (!size || size < minSize) continue;
    const key = `${gridCell(lat)}:${gridCell(lon)}`;
    let cell = byCell.get(key);
    if (!cell) {
      cell = {
        key,
        lat: gridCell(lat) * GRID_DEG + GRID_DEG / 2,
        lon: gridCell(lon) * GRID_DEG + GRID_DEG / 2,
        reportCount: 0,
        reportMax: null,
      };
      byCell.set(key, cell);
    }
    cell.reportCount += 1;
    if (size > (cell.reportMax ?? 0)) cell.reportMax = size;
  }
  const out = [];
  for (const cell of byCell.values()) {
    const radar = radarCells.get(cell.key);
    // A cell a person telephoned in about and the radar has no core for is
    // still an observation, and dropping it biases the very comparison this
    // module exists to make: the headline share divides by the number of cells
    // that survived, so a missing class does not just vanish, it inflates what
    // is left. It is emitted as `report-only`, with `radarMaxMm: null` so an
    // absent estimate is never read as a small one, and never implausible —
    // there is no radar value here to be beyond what hail does.
    out.push({
      key: cell.key,
      lat: cell.lat,
      lon: cell.lon,
      radarMaxMm: radar ? radar.mx : null,
      reportCount: cell.reportCount,
      reportMax: cell.reportMax,
      agreement: radar ? 'both' : 'report-only',
      implausible: radar ? radar.mx >= RADAR_IMPLAUSIBLE_MM : false,
    });
  }
  // Radar-only cells have no report at all, so they cannot come from the report
  // side of the join; they are found by walking the radar index directly.
  for (const [key, radar] of radarCells) {
    if (byCell.has(key)) continue;
    if (radar.mx < HAIL_CORE_MM) continue;
    const [i, j] = key.split(':').map(Number);
    out.push({
      key,
      lat: i * GRID_DEG + GRID_DEG / 2,
      lon: j * GRID_DEG + GRID_DEG / 2,
      radarMaxMm: radar.mx,
      reportCount: 0,
      reportMax: null,
      agreement: 'radar-only',
      implausible: radar.mx >= RADAR_IMPLAUSIBLE_MM,
    });
  }
  return out;
}

/**
 * The headline: how much of the radar hail never reached a report.
 *
 * `total` is the union of all three classes, which is the only denominator that
 * does not flatter the radar. Dividing by `both + radarOnly` alone makes the
 * share of unreported hail a function of how many report-only cells were thrown
 * away, so the number moved for a reason that had nothing to do with hail.
 *
 * `artefacts` counts implausible radar-only cells and nothing else: an
 * implausible core with a report in it is a disagreement the report already
 * speaks to, and a cell with no radar value cannot be an artefact at all.
 * @param {CrossCell[]} cells
 * @returns {{total: number, both: number, radarOnly: number, reportOnly: number,
 *            radarOnlyShare: number, reportOnlyShare: number, artefacts: number}}
 */
export function summariseAgreement(cells) {
  let both = 0;
  let radarOnly = 0;
  let reportOnly = 0;
  let artefacts = 0;
  // The class counts are CELLS. A 0.25 degree cell is 25 miles across, so eight
  // reports in one county collapse to one cell, and reporting the cell count
  // as though it were a report count understates it several-fold.
  let reportsWithCore = 0;
  let reportsWithoutCore = 0;
  for (const cell of cells) {
    if (cell.agreement === 'both') {
      both += 1;
      reportsWithCore += cell.reportCount || 0;
    } else if (cell.agreement === 'radar-only') {
      radarOnly += 1;
      if (cell.implausible) artefacts += 1;
    } else if (cell.agreement === 'report-only') {
      reportOnly += 1;
      reportsWithoutCore += cell.reportCount || 0;
    }
  }
  const total = both + radarOnly + reportOnly;
  return {
    total,
    both,
    radarOnly,
    reportOnly,
    // Report-weighted, which is the number a canvasser can act on: how many of
    // the reports in front of me had a radar core behind them.
    reportsWithCore,
    reportsWithoutCore,
    reportsCompared: reportsWithCore + reportsWithoutCore,
    radarOnlyShare: total ? radarOnly / total : 0,
    reportOnlyShare: total ? reportOnly / total : 0,
    artefacts,
  };
}

/**
 * The cells worth driving to, worst unreported hail first.
 *
 * A radar-only cell with a strong core and no report is a street where hail
 * fell, nobody telephoned it in, and no homeowner is looking at their roof.
 *
 * Report-only cells are excluded deliberately, not incidentally. There, the
 * radar estimate is below the core threshold or absent, which usually means the
 * hail was marginal — and a cell where somebody already called it in needs no
 * canvassing, because someone already knows. Offering them here would put a
 * visit on the map for no new information.
 * @param {CrossCell[]} cells
 * @param {{limit?: number, minRadarMm?: number}} [options]
 * @returns {CrossCell[]}
 */
export function canvassTargets(cells, options = {}) {
  const { limit = 200, minRadarMm = HAIL_CORE_MM } = options;
  return (
    cells
      // `report-only` never qualifies: it has no radar value to rank by, and
      // its absence of a core is not evidence of damage.
      .filter((c) => c.agreement === 'radar-only' && c.radarMaxMm >= minRadarMm)
      // Artefacts are excluded rather than ranked low: a cell whose only evidence
      // is an impossible radar value is not a lead, it is a false one.
      .filter((c) => !c.implausible)
      .sort((a, b) => b.radarMaxMm - a.radarMaxMm)
      .slice(0, limit)
  );
}

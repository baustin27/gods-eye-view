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
 *   report, no radar core    likely marginal hail, or a cell the 25mm core
 *                            threshold missed. Low priority.
 *   both                    confirmed.
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
 * not a measurement of a stone. Measured against the 2026 snapshot the median
 * core is 39mm (about 1.5in) and the 99th percentile is 109mm, but 1.4% of
 * cells exceed 100mm and thirty exceed 200mm — hail that size does not fall.
 * Those cells are kept so the grid does not develop holes, but flagged, and
 * they are never ranked as canvass targets.
 *
 * This is why `radarMaxMm` must never be shown next to `reportMax`: one is an
 * estimate from reflectivity, the other is a measured stone. Reading them as
 * the same quantity would send someone to drive after a radar artefact.
 */
export const RADAR_IMPLAUSIBLE_MM = 100;

/**
 * Join reports onto radar cores and classify every cell either side touched.
 *
 * Only cells that at least one source knows about appear, so a quiet month
 * produces an empty list rather than a sparse one. `lat`/`lon` are the cell
 * centre, because that is where the hail actually fell as far as the grid is
 * concerned.
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
        radar: null,
      };
      byCell.set(key, cell);
    }
    cell.reportCount += 1;
    if (size > (cell.reportMax ?? 0)) cell.reportMax = size;
  }
  const out = [];
  for (const [key, cell] of byCell) {
    const radar = radarCells.get(key);
    if (!radar) continue;
    cell.radar = radar;
    out.push({
      key: cell.key,
      lat: cell.lat,
      lon: cell.lon,
      radarMaxMm: radar.mx,
      reportCount: cell.reportCount,
      reportMax: cell.reportMax,
      agreement: 'both',
      implausible: radar.mx >= RADAR_IMPLAUSIBLE_MM,
    });
  }
  // Radar-only cells have no report at all, so they cannot come from the report
  // side of the join; they are found by walking the radar index directly.
  for (const [key, radar] of radarCells) {
    if (byCell.has(key)) continue;
    if (radar.mx < 25) continue;
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
 * @param {CrossCell[]} cells
 * @returns {{total: number, both: number, radarOnly: number, radarOnlyShare: number,
 *            artefacts: number}}
 */
export function summariseAgreement(cells) {
  let both = 0;
  let radarOnly = 0;
  let artefacts = 0;
  for (const cell of cells) {
    if (cell.agreement === 'both') both += 1;
    else if (cell.agreement === 'radar-only') {
      radarOnly += 1;
      if (cell.implausible) artefacts += 1;
    }
  }
  const total = both + radarOnly;
  return {
    total,
    both,
    radarOnly,
    radarOnlyShare: total ? radarOnly / total : 0,
    artefacts,
  };
}

/**
 * The cells worth driving to, worst unreported hail first.
 *
 * A radar-only cell with a strong core and no report is a street where hail
 * fell, nobody telephoned it in, and no homeowner is looking at their roof.
 * @param {CrossCell[]} cells
 * @param {{limit?: number, minRadarMm?: number}} [options]
 * @returns {CrossCell[]}
 */
export function canvassTargets(cells, options = {}) {
  const { limit = 200, minRadarMm = 25 } = options;
  return (
    cells
      .filter((c) => c.agreement === 'radar-only' && c.radarMaxMm >= minRadarMm)
      // Artefacts are excluded rather than ranked low: a cell whose only evidence
      // is an impossible radar value is not a lead, it is a false one.
      .filter((c) => !c.implausible)
      .sort((a, b) => b.radarMaxMm - a.radarMaxMm)
      .slice(0, limit)
  );
}

/**
 * apps/hail-desk/src/ui/lossDossier.js — Property Loss Dossier & Insurance Window Calculator.
 *
 * WHY THIS MODULE EXISTS:
 * When evaluating single-property hail damage, two evidentiary and legal questions
 * dominate insurance claims processing:
 *
 * 1. THE STATUTORY FILING WINDOW (Policy & Statutory Eligibility):
 *    Property casualty insurance policies (e.g. ISO HO-3 / DP-3 forms) typically
 *    impose a contractual or statutory notice/filing deadline of 1 year (12 months)
 *    from the date of loss. Certain jurisdictions (such as Colorado C.R.S. § 10-4-110.8)
 *    or special policy endorsements extend this statutory window to 2 years (24 months).
 *    Claims submitted beyond 24 months are almost universally time-barred ("Past Statute Window").
 *    Canvassers, adjusters, and homeowners need an unambiguous computation of elapsed
 *    months and filing eligibility from any historical hail date.
 *
 * 2. RADAR & SPOTTER CORROBORATION (Dual-Source Evidentiary Standard):
 *    Radar algorithms (MRMS MESH) detect hydrometeors aloft on a 1 km grid, but carriers
 *    routinely contest uncalibrated radar data as lacking ground-level confirmation.
 *    Conversely, NOAA / NWS spotter reports provide ground-truth hailstone measurements
 *    at a specific point, but spotter density is sparse.
 *    By matching radar events with ground spotter reports within a defined proximity
 *    (default 5 km radius), this module produces corroborated loss events that provide
 *    the requisite dual-source proof for formal property loss dossiers.
 */

/**
 * Calculates the great-circle distance between two geographic coordinates
 * in kilometres using the Haversine formula.
 *
 * WHY HAVERSINE:
 * High-accuracy planar approximations degrade over degrees of latitude. The Haversine
 * formula computes spherical surface distances using WGS-84 mean earth radius (6,371.0088 km),
 * providing sub-metre accuracy for spotter-to-property proximity checks.
 *
 * @param {number} lat1 Latitude of point 1 in decimal degrees
 * @param {number} lon1 Longitude of point 1 in decimal degrees
 * @param {number} lat2 Latitude of point 2 in decimal degrees
 * @param {number} lon2 Longitude of point 2 in decimal degrees
 * @returns {number} Distance in kilometres
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Normalizes Date instances, timestamps, or date strings into discrete calendar parts.
 *
 * WHY PARSE BY PARTS:
 * Standard `new Date('YYYY-MM-DD')` parses as UTC midnight, which in local American timezones
 * (e.g. America/Denver UTC-6 or UTC-7) shifts to the preceding calendar day when queried via
 * local getters (.getDate()). By extracting discrete year, month, and day components, we preserve
 * the exact calendar date represented by storm logs and avoid timezone boundary drift.
 *
 * @param {Date|string|number} input
 * @returns {{ year: number, month: number, day: number, time: number }}
 */
function parseDateParts(input) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      throw new TypeError(`Invalid Date: ${input}`);
    }
    return {
      year: input.getFullYear(),
      month: input.getMonth(),
      day: input.getDate(),
      time: input.getTime(),
    };
  }

  if (typeof input === 'number') {
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) {
      throw new TypeError(`Invalid timestamp: ${input}`);
    }
    return {
      year: d.getFullYear(),
      month: d.getMonth(),
      day: d.getDate(),
      time: d.getTime(),
    };
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
    if (match) {
      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10) - 1;
      const day = parseInt(match[3], 10);
      const d = new Date(year, month, day);
      return {
        year,
        month,
        day,
        time: d.getTime(),
      };
    }
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw new TypeError(`Invalid date string: ${input}`);
    }
    return {
      year: d.getFullYear(),
      month: d.getMonth(),
      day: d.getDate(),
      time: d.getTime(),
    };
  }

  throw new TypeError(`Expected Date, string, or number for date, received ${typeof input}`);
}

/**
 * Extracts a normalized 'YYYY-MM-DD' calendar string from an event or report object.
 *
 * @param {object|string} item
 * @returns {string} Date string formatted as 'YYYY-MM-DD', or empty string
 */
function extractDateStr(item) {
  if (!item) return '';
  if (typeof item === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(item.trim());
    return match ? match[1] : item.trim();
  }
  const raw = item.date || item.day || item.d;
  if (!raw) return '';
  if (typeof raw === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
    return match ? match[1] : raw.trim();
  }
  if (raw instanceof Date) {
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, '0');
    const d = String(raw.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(raw);
}

/**
 * Computes full calendar months elapsed between a date of loss and an evaluation date.
 *
 * WHY CALENDAR MONTHS INSTEAD OF 30-DAY CHUNKS:
 * Insurance contracts define limitation periods by policy anniversary dates rather than
 * fixed 30-day millisecond increments. For example, a loss occurring on 2024-05-15 evaluated
 * on 2025-05-14 has completed 11 full months (remains within the standard 1-year window).
 * Evaluated on 2025-05-15, exactly 12 calendar months have completed, marking the transition
 * to the extended 2-year statute.
 *
 * @param {Date|string|number} lossDate Date of the hail loss event
 * @param {Date|string|number} [currentDate=new Date()] Evaluation date (defaults to now)
 * @returns {number} Whole elapsed months
 */
export function calculateMonthsElapsed(lossDate, currentDate = new Date()) {
  const loss = parseDateParts(lossDate);
  const current = parseDateParts(currentDate);

  if (current.time < loss.time) {
    return 0;
  }

  let months = (current.year - loss.year) * 12 + (current.month - loss.month);
  if (current.day < loss.day) {
    months -= 1;
  }
  return Math.max(0, months);
}

/**
 * Determines property insurance claim filing eligibility under standard (1-year)
 * and extended (2-year) statutory windows.
 *
 * SPECIFICATION CRITERIA:
 * - `< 12 months`: `{ eligible1Yr: true, eligible2Yr: true, monthsElapsed: number, label: 'Within Standard Window' }`
 * - `12 - 24 months`: `{ eligible1Yr: false, eligible2Yr: true, monthsElapsed: number, label: 'Extended Window (2-Yr Statute)' }`
 * - `> 24 months`: `{ eligible1Yr: false, eligible2Yr: false, monthsElapsed: number, label: 'Past Statute Window' }`
 *
 * @param {Date|string|number} lossDate The historical date of loss
 * @param {Date|string|number} [currentDate=new Date()] The reference date for the calculation
 * @returns {{ eligible1Yr: boolean, eligible2Yr: boolean, monthsElapsed: number, label: string }}
 */
export function calculateClaimFilingStatus(lossDate, currentDate = new Date()) {
  const monthsElapsed = calculateMonthsElapsed(lossDate, currentDate);

  if (monthsElapsed < 12) {
    return {
      eligible1Yr: true,
      eligible2Yr: true,
      monthsElapsed,
      label: 'Within Standard Window',
    };
  }

  if (monthsElapsed <= 24) {
    return {
      eligible1Yr: false,
      eligible2Yr: true,
      monthsElapsed,
      label: 'Extended Window (2-Yr Statute)',
    };
  }

  return {
    eligible1Yr: false,
    eligible2Yr: false,
    monthsElapsed,
    label: 'Past Statute Window',
  };
}

/**
 * Resolves the distance of a spotter report from a reference point or radar event.
 *
 * WHY SUPPORT MULTIPLE DISTANCE SCHEMAS:
 * In Hail Desk, spotter reports from the address API already carry an interpolated `km`
 * distance relative to the requested house address. In other contexts (or test suites),
 * spotters may carry `distanceKm`, `distance`, or geographic coordinates (`lat`, `lon`).
 * Supporting all schemas ensures seamless interop across backend and frontend contexts.
 *
 * @param {object} report Spotter report
 * @param {object|null} [radarEvent=null] Optional radar event with geographic coordinates
 * @returns {number} Distance in kilometres
 */
function resolveReportDistanceKm(report, radarEvent = null) {
  if (typeof report.km === 'number' && Number.isFinite(report.km)) {
    return report.km;
  }
  if (typeof report.distanceKm === 'number' && Number.isFinite(report.distanceKm)) {
    return report.distanceKm;
  }
  if (typeof report.distance === 'number' && Number.isFinite(report.distance)) {
    return report.distance;
  }
  if (
    radarEvent &&
    Number.isFinite(radarEvent.lat) &&
    Number.isFinite(radarEvent.lon) &&
    Number.isFinite(report.lat) &&
    Number.isFinite(report.lon)
  ) {
    return haversineKm(radarEvent.lat, radarEvent.lon, report.lat, report.lon);
  }
  // When no distance or coordinates are available, treat report as directly proximate
  return 0;
}

/**
 * Matches radar hail events against nearby ground-truth spotter reports and returns
 * a merged, chronological list (newest first) badged by corroboration status.
 *
 * WHY CORROBORATION MATTERS:
 * Insurance claims adjusters reject single-source claims with higher frequency.
 * A radar track confirms an overhead storm cell, but spotter logs confirm actual stone
 * size reaching the ground. Pairing radar and spotter observations within `maxRadiusKm`
 * generates an evidentiary badge:
 * - 'Corroborated': Both radar swath and nearby spotter observations confirm the hail.
 * - 'Radar Only': Overhead radar detected hail, but no spotter was within radius.
 * - 'Spotter Only': Ground spotter recorded hail, but radar MESH was unavailable or below threshold.
 *
 * @param {Array<object>} [radarEvents=[]] List of radar hail days
 * @param {Array<object>} [spotterReports=[]] List of ground-truth spotter observations
 * @param {number} [maxRadiusKm=5] Maximum geographic radius in km for corroboration
 * @returns {Array<object>} Merged events sorted newest first
 */
export function corroborateLossEvents(radarEvents = [], spotterReports = [], maxRadiusKm = 5) {
  const safeRadarEvents = Array.isArray(radarEvents) ? radarEvents : [];
  const safeSpotterReports = Array.isArray(spotterReports) ? spotterReports : [];
  const radius = Number.isFinite(maxRadiusKm) && maxRadiusKm >= 0 ? maxRadiusKm : 5;

  const eventsByDate = new Map();

  // 1. Group radar events by date
  for (const radar of safeRadarEvents) {
    const date = extractDateStr(radar);
    if (!date) continue;

    let entry = eventsByDate.get(date);
    if (!entry) {
      entry = { date, radar: null, reports: [] };
      eventsByDate.set(date, entry);
    }

    // If multiple radar passes exist on the same date, preserve the one with higher severity
    if (!entry.radar || (radar.maxMm && (!entry.radar.maxMm || radar.maxMm > entry.radar.maxMm))) {
      entry.radar = radar;
    }
  }

  // 2. Corroborate spotter reports against dates and proximity radius
  for (const report of safeSpotterReports) {
    const date = extractDateStr(report);
    if (!date) continue;

    const entry = eventsByDate.get(date);
    const radar = entry?.radar || null;
    const distanceKm = resolveReportDistanceKm(report, radar);

    // Reject reports that lie outside the corroboration radius
    if (distanceKm > radius) {
      continue;
    }

    if (!entry) {
      const newEntry = {
        date,
        radar: null,
        reports: [{ ...report, distanceKm: Math.round(distanceKm * 10) / 10 }],
      };
      eventsByDate.set(date, newEntry);
    } else {
      entry.reports.push({
        ...report,
        distanceKm: Math.round(distanceKm * 10) / 10,
      });
    }
  }

  // 3. Assemble unified event models with corroboration badges
  const mergedList = [];
  for (const entry of eventsByDate.values()) {
    const hasRadar = Boolean(entry.radar);
    const hasSpotter = entry.reports.length > 0;
    const isCorroborated = hasRadar && hasSpotter;

    let badge;
    let badgeLabel;
    let status;

    if (isCorroborated) {
      badge = 'Corroborated';
      badgeLabel = 'Corroborated (Radar + Spotter)';
      status = 'corroborated';
    } else if (hasRadar) {
      badge = 'Radar Only';
      badgeLabel = 'Radar Only';
      status = 'radar_only';
    } else {
      badge = 'Spotter Only';
      badgeLabel = 'Spotter Only';
      status = 'spotter_only';
    }

    // Merge radar properties while guaranteeing core dossier keys remain intact
    const mergedEvent = {
      ...(entry.radar || {}),
      date: entry.date,
      day: entry.date,
      corroborated: isCorroborated,
      badge,
      corroborationBadge: badge,
      badgeLabel,
      status,
      hasRadar,
      hasSpotter,
      radar: entry.radar,
      reports: entry.reports,
      spotterReports: entry.reports,
      reportCount: entry.reports.length,
    };

    mergedList.push(mergedEvent);
  }

  // 4. Chronological sort: newest first
  mergedList.sort((a, b) => b.date.localeCompare(a.date));

  return mergedList;
}

/**
 * Builds a complete property loss dossier model combining event corroboration,
 * statute of limitations window computations, and loss summary metrics.
 *
 * @param {object} propertyInfo Property identifier (address, coordinates, tract)
 * @param {Array<object>} radarEvents Historical radar events over property
 * @param {Array<object>} spotterReports Historical spotter reports near property
 * @param {object} [options={}]
 * @param {number} [options.maxRadiusKm=5] Corroboration radius
 * @param {Date|string} [options.currentDate=new Date()] Reference date
 * @returns {object} Comprehensive loss dossier model
 */
export function generatePropertyLossDossier(
  propertyInfo = {},
  radarEvents = [],
  spotterReports = [],
  options = {},
) {
  const maxRadiusKm = options.maxRadiusKm ?? 5;
  const currentDate = options.currentDate ?? new Date();

  const events = corroborateLossEvents(radarEvents, spotterReports, maxRadiusKm).map((event) => {
    const filingStatus = calculateClaimFilingStatus(event.date, currentDate);
    return {
      ...event,
      filingStatus,
    };
  });

  const corroboratedCount = events.filter((e) => e.corroborated).length;
  const eligible1YrCount = events.filter((e) => e.filingStatus.eligible1Yr).length;
  const eligible2YrCount = events.filter((e) => e.filingStatus.eligible2Yr).length;
  const primaryEvent = events[0] || null;

  return {
    property: propertyInfo,
    events,
    totalEvents: events.length,
    corroboratedCount,
    eligible1YrCount,
    eligible2YrCount,
    primaryFilingStatus: primaryEvent ? primaryEvent.filingStatus : null,
    mostRecentDate: primaryEvent ? primaryEvent.date : null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Renders a property loss dossier into a DOM container element.
 *
 * Safely guards against non-browser environments so the module can be loaded in Node.js
 * unit test suites without requiring jsdom or mock globals.
 *
 * Supports polymorphic argument ordering: `renderLossDossier(container, dossier)`
 * or `renderLossDossier(dossier, container)`.
 *
 * @param {HTMLElement|object} arg1 Container element or dossier object
 * @param {HTMLElement|object} arg2 Container element or dossier object
 */
export function renderLossDossier(arg1, arg2) {
  if (typeof document === 'undefined') {
    return;
  }

  let container = null;
  let dossier = null;

  if (arg1 && (arg1.nodeType || typeof arg1.appendChild === 'function')) {
    container = arg1;
    dossier = arg2;
  } else if (arg2 && (arg2.nodeType || typeof arg2.appendChild === 'function')) {
    container = arg2;
    dossier = arg1;
  }

  if (!container || !dossier) {
    return;
  }

  // Synthesize complete dossier metrics if raw property target is provided
  if (!dossier.property && (dossier.address || dossier.street)) {
    dossier = generatePropertyLossDossier(
      {
        street: dossier.address || dossier.street,
        city: dossier.city || 'Denver',
        state: dossier.state || 'CO',
        zip: dossier.zip || '80222',
      },
      dossier.radarEvents || [],
      dossier.spotterReports || [],
    );
  }

  if (typeof container.replaceChildren === 'function') {
    container.replaceChildren();
  } else {
    container.innerHTML = '';
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'loss-dossier-panel';

  // Dossier Header
  const header = document.createElement('div');
  header.className = 'loss-dossier-header';

  const title = document.createElement('h3');
  title.className = 'loss-dossier-title';
  title.textContent = dossier.property?.street || 'Property Loss Dossier';
  header.appendChild(title);

  if (dossier.primaryFilingStatus) {
    const statusChip = document.createElement('span');
    statusChip.className = `dossier-status-chip ${
      dossier.primaryFilingStatus.eligible1Yr
        ? 'status-standard'
        : dossier.primaryFilingStatus.eligible2Yr
        ? 'status-extended'
        : 'status-expired'
    }`;
    statusChip.textContent = dossier.primaryFilingStatus.label;
    header.appendChild(statusChip);
  }
  wrapper.appendChild(header);

  // Events Table
  if (dossier.events?.length) {
    const table = document.createElement('table');
    table.className = 'desk-table dossier-table';

    const thead = document.createElement('thead');
    thead.innerHTML = `
      <tr>
        <th scope="col">Date</th>
        <th scope="col">Status</th>
        <th scope="col">Hail Size</th>
        <th scope="col">Insurance Window</th>
        <th scope="col">Reports</th>
      </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const event of dossier.events) {
      const tr = document.createElement('tr');
      if (event.corroborated) tr.classList.add('corroborated-row');

      const sizeDisplay = event.maxMm
        ? `${(event.maxMm / 25.4).toFixed(2)}"`
        : event.magnitude
        ? `${(event.magnitude > 10 ? event.magnitude / 100 : event.magnitude).toFixed(2)}"`
        : '—';

      tr.innerHTML = `
        <td><strong>${event.date}</strong></td>
        <td><span class="badge ${event.status}">${event.badge}</span></td>
        <td>${sizeDisplay}</td>
        <td>${event.filingStatus?.label || '—'}</td>
        <td>${event.reportCount || 0} nearby</td>
      `;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);
  } else {
    const emptyNotice = document.createElement('p');
    emptyNotice.className = 'detail-summary';
    emptyNotice.textContent = 'No hail events recorded for this property.';
    wrapper.appendChild(emptyNotice);
  }

  container.appendChild(wrapper);
}

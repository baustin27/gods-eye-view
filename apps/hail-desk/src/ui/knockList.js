/**
 * apps/hail-desk/src/ui/knockList.js — Street Canvassing Knock List & CRM Lead Export.
 *
 * A storm restoration canvasser does not work from a map; they work from a clipboard
 * or a tablet walking down a street. When the Hail Desk identifies a street segment
 * under a severe hail core (e.g. 1.75"+ radar hail), that segment becomes a work list
 * of door-to-door leads.
 *
 * This module manages:
 *   1. The canonical canvassing workflow states (`KNOCK_STATUSES`):
 *      uncontacted -> knocked -> appointment -> claim -> closed.
 *   2. Progress metrics calculation (`calculateKnockProgress`):
 *      tracks conversion rates through the field funnel to measure street coverage.
 *   3. Safe CSV export for CRM import (`exportKnockListCsv`):
 *      generates clean lead spreadsheets with formula injection defusal (DDE protection)
 *      and standard RFC 4180 CSV escaping.
 *   4. An interactive DOM component (`renderKnockList`) to track status and notes in the field.
 */

/**
 * Standard line ending for CSV exports.
 *
 * Excel on Windows expects CRLF (\r\n) line terminators. Emitting bare LF causes
 * older versions of Excel to treat the entire file as a single malformed row or
 * prompt the user with import configuration dialogs.
 */
const CRLF = '\r\n';

/**
 * Canonical stages of a door-to-door storm restoration canvassing funnel.
 *
 * Every lead begins as 'uncontacted'. When a rep visits a home, it transitions
 * to 'knocked'. If the homeowner agrees to a roof damage assessment, an 'appointment'
 * is set. If hail impact is confirmed and insurance is engaged, it becomes a 'claim'.
 * Once the restoration contract or work is finalized, the lead is 'closed'.
 */
export const KNOCK_STATUSES = Object.freeze([
  'uncontacted',
  'knocked',
  'appointment',
  'claim',
  'closed',
]);

/**
 * Validates whether a candidate string is an approved canvassing status.
 *
 * Prevents typos or arbitrary strings from corrupting filter aggregations and CRM
 * pipeline stages.
 *
 * @param {unknown} status - Candidate status value
 * @returns {boolean} True if the status is one of the 5 canonical statuses
 */
export function isValidKnockStatus(status) {
  return typeof status === 'string' && KNOCK_STATUSES.includes(status);
}

/**
 * Calculates canvassing completion and conversion metrics across a set of house records.
 *
 * In storm restoration sales, an 'appointment' is the milestone where a ladder is put
 * against the gutter and the roof is assessed; therefore both 'appointment' and
 * 'inspected' map directly to the `inspected` metric count. Any lead marked 'uncontacted'
 * (or lacking an assigned status) represents remaining opportunity on the street.
 *
 * Progress percentage measures street coverage: how many houses have been engaged
 * out of the total houses identified under the hail core.
 *
 * @param {Array<object>} [records=[]] - Array of house records with optional .status
 * @returns {{
 *   total: number,
 *   knocked: number,
 *   inspected: number,
 *   claim: number,
 *   remaining: number,
 *   percentage: number
 * }} Aggregated progress metrics
 */
export function calculateKnockProgress(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return {
      total: 0,
      knocked: 0,
      inspected: 0,
      claim: 0,
      remaining: 0,
      percentage: 0,
    };
  }

  const total = records.length;
  let knocked = 0;
  let inspected = 0;
  let claim = 0;
  let remaining = 0;

  for (const record of records) {
    const rawStatus = record && typeof record === 'object' ? record.status : null;
    const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : 'uncontacted';

    switch (status) {
      case 'knocked':
        knocked += 1;
        break;
      case 'appointment':
      case 'inspected':
        inspected += 1;
        break;
      case 'claim':
        claim += 1;
        break;
      case 'closed':
        // 'closed' represents a completed conversion; it is not 'remaining',
        // so it contributes to total progress coverage without inflating earlier funnel steps.
        break;
      case 'uncontacted':
      default:
        // Any door that has not yet been knocked or carries an undefined/unrecognized
        // state remains on the to-do list for canvassers.
        remaining += 1;
        break;
    }
  }

  // Percentage of the street completed (worked leads vs total available doors).
  // Rounded to integer percentage per Hail Desk UI conventions.
  const contacted = total - remaining;
  const percentage = total > 0 ? Math.round((contacted / total) * 100) : 0;

  return {
    total,
    knocked,
    inspected,
    claim,
    remaining,
    percentage,
  };
}

/**
 * Defuses spreadsheet formula injection (CSV/DDE Injection) and applies RFC 4180 quoting.
 *
 * Spreadsheet applications (Microsoft Excel, LibreOffice Calc, Apple Numbers, Google Sheets)
 * automatically execute formulas if a cell begins with '=', '+', '-', or '@'. A malicious
 * or accidental input in a homeowner's name or notes (e.g. '=cmd|...` or `-2+3*cmd`) can
 * trigger arbitrary process execution or external data exfiltration when opened by a sales
 * manager.
 *
 * Prefixing a formula trigger character with a single quote (') forces spreadsheet engines
 * to treat the cell strictly as plain text literal.
 *
 * Furthermore, RFC 4180 requires that any cell containing double quotes, commas, or line
 * breaks must be wrapped in double quotes, and internal quotes must be doubled ("").
 *
 * @param {unknown} value - Value to escape
 * @returns {string} Sanitized CSV field string
 */
export function escapeCsvField(value) {
  if (value === null || value === undefined) return '';

  let text = String(value);

  // A leading =, +, -, or @ (even preceded by leading whitespace) instructs
  // spreadsheets to interpret the cell as a dynamic formula. Neutralize it
  // with a single quote prefix.
  if (/^\s*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }

  // If the string contains double quotes, commas, or line breaks, enclose it
  // in quotes and double any internal quotes per RFC 4180.
  if (/[",\r\n]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

/**
 * Formats a street's canvassing records into a standard CSV suitable for CRM lead import.
 *
 * CRMs (e.g. JobNimbus, Roofr, AccuLynx, Salesforce) ingest leads via CSV matching:
 * Street, Address, RadarHailInches, Status, Notes.
 *
 * Every value is passed through `escapeCsvField` to prevent formula injection attacks
 * and parse errors from commas in addresses or multi-line notes.
 *
 * @param {string} streetName - Name of the street (e.g. "Federal Blvd")
 * @param {Array<object>} houseRecords - Array of house records on this street
 * @returns {string} Formatted CSV text with CRLF line endings
 */
export function exportKnockListCsv(streetName, houseRecords) {
  const records = Array.isArray(houseRecords) ? houseRecords : [];
  const defaultStreet = typeof streetName === 'string' ? streetName : '';

  // Standard CSV headers matching CRM lead import requirements.
  const headers = ['Street', 'Address', 'RadarHailInches', 'Status', 'Notes'];
  const lines = [headers.map(escapeCsvField).join(',')];

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;

    const street = record.street ?? defaultStreet;
    const address = record.address ?? record.houseNumber ?? record.number ?? '';
    
    // Hail size can be supplied as a number of inches, maxMm converted to inches,
    // or string. If absent, output empty string.
    let hailInches = '';
    if (record.radarHailInches !== undefined && record.radarHailInches !== null) {
      hailInches = record.radarHailInches;
    } else if (record.radarHail !== undefined && record.radarHail !== null) {
      hailInches = record.radarHail;
    } else if (record.hailInches !== undefined && record.hailInches !== null) {
      hailInches = record.hailInches;
    } else if (typeof record.maxMm === 'number') {
      hailInches = (record.maxMm / 25.4).toFixed(2);
    }

    const status = record.status || 'uncontacted';
    const notes = record.notes ?? record.note ?? '';

    const row = [
      escapeCsvField(street),
      escapeCsvField(address),
      escapeCsvField(hailInches),
      escapeCsvField(status),
      escapeCsvField(notes),
    ];

    lines.push(row.join(','));
  }

  // Always end with CRLF for standard compliance with spreadsheet parsers.
  return `${lines.join(CRLF)}${CRLF}`;
}

/**
 * Renders an interactive street canvassing knock list into a DOM container.
 *
 * Provides a field-optimized UI for reps:
 *   - Live progress bar showing contacted % and stage breakdown.
 *   - Quick-change status selector for each door.
 *   - Direct notes input for property details (dog in yard, copper gutters, etc.).
 *   - One-click CRM lead export button.
 *
 * @param {HTMLElement} container - Target DOM container
 * @param {object} options
 * @param {string} options.streetName - Name of the street being canvassed
 * @param {Array<object>} options.records - Array of house records
 * @param {(index: number, newStatus: string) => void} [options.onStatusChange] - Status update callback
 * @param {(index: number, newNotes: string) => void} [options.onNotesChange] - Notes update callback
 * @param {() => void} [options.onExport] - Optional export override
 * @returns {{ update: (nextRecords: Array<object>) => void, destroy: () => void }}
 */
export function renderKnockList(container, options = {}) {
  if (!container || typeof container.appendChild !== 'function') {
    return { update() {}, destroy() {} };
  }

  const streetName = options.streetName || 'Street Canvassing List';
  let currentRecords = Array.isArray(options.records) ? [...options.records] : [];

  const wrapper = document.createElement('div');
  wrapper.className = 'knock-list-container';

  function render() {
    wrapper.innerHTML = '';

    const progress = calculateKnockProgress(currentRecords);

    // Header & Summary Controls
    const header = document.createElement('div');
    header.className = 'knock-list-header';

    const title = document.createElement('h3');
    title.className = 'knock-list-title';
    title.textContent = streetName;

    const stats = document.createElement('div');
    stats.className = 'knock-list-stats';
    stats.textContent =
      `Progress: ${progress.percentage}% (${progress.total - progress.remaining}/${progress.total}) | ` +
      `Knocked: ${progress.knocked} | Inspected: ${progress.inspected} | Claims: ${progress.claim}`;

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'knock-list-export-btn';
    exportBtn.textContent = 'Export CSV for CRM';
    exportBtn.addEventListener('click', () => {
      if (typeof options.onExport === 'function') {
        options.onExport();
        return;
      }
      const csvText = exportKnockListCsv(streetName, currentRecords);
      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `knock-list-${streetName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`;
      link.hidden = true;
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
    });

    header.append(title, stats, exportBtn);
    wrapper.appendChild(header);

    // Table of addresses
    const table = document.createElement('table');
    table.className = 'knock-list-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const heading of ['Address', 'Radar Hail', 'Status', 'Notes']) {
      const th = document.createElement('th');
      th.textContent = heading;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    currentRecords.forEach((record, index) => {
      const tr = document.createElement('tr');

      // Address Cell
      const addrCell = document.createElement('td');
      addrCell.textContent = String(record.address ?? record.houseNumber ?? `House #${index + 1}`);
      tr.appendChild(addrCell);

      // Radar Hail Cell
      const hailCell = document.createElement('td');
      const hailVal = record.radarHailInches ?? record.radarHail ?? (record.maxMm ? (record.maxMm / 25.4).toFixed(2) : '—');
      hailCell.textContent = typeof hailVal === 'number' ? `${hailVal}"` : String(hailVal);
      tr.appendChild(hailCell);

      // Status Selector Cell
      const statusCell = document.createElement('td');
      const select = document.createElement('select');
      select.className = 'knock-status-select';
      for (const st of KNOCK_STATUSES) {
        const opt = document.createElement('option');
        opt.value = st;
        opt.textContent = st.charAt(0).toUpperCase() + st.slice(1);
        if ((record.status || 'uncontacted') === st) {
          opt.selected = true;
        }
        select.appendChild(opt);
      }
      select.addEventListener('change', (e) => {
        const nextStatus = e.target.value;
        record.status = nextStatus;
        if (typeof options.onStatusChange === 'function') {
          options.onStatusChange(index, nextStatus);
        }
        render();
      });
      statusCell.appendChild(select);
      tr.appendChild(statusCell);

      // Notes Input Cell
      const notesCell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'knock-notes-input';
      input.value = record.notes ?? record.note ?? '';
      input.placeholder = 'Add field notes...';
      input.addEventListener('change', (e) => {
        const nextNotes = e.target.value;
        record.notes = nextNotes;
        if (typeof options.onNotesChange === 'function') {
          options.onNotesChange(index, nextNotes);
        }
      });
      notesCell.appendChild(input);
      tr.appendChild(notesCell);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrapper.appendChild(table);
  }

  render();
  container.appendChild(wrapper);

  return {
    update(nextRecords) {
      currentRecords = Array.isArray(nextRecords) ? [...nextRecords] : [];
      render();
    },
    destroy() {
      wrapper.remove();
    },
  };
}

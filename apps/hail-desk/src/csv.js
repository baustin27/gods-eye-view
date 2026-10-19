/**
 * CSV export.
 *
 * The export is the point of the tool: a filtered view that cannot leave the
 * browser is a screenshot, and a screenshot is not a work list. What comes out
 * is the table, in the order the table is in, with the SAME numbers - the
 * export is computed from the rows, not recomputed, so a number in the file is
 * provably the number on screen.
 *
 * Two details that are easy to get wrong and expensive to get wrong:
 *
 * A leading `=` or `+` or `-` in a cell makes a spreadsheet treat the cell as
 * a FORMULA. A county called "- Nowhere" is not a thing, but a value like
 * "-1" is, and a spreadsheet would try to evaluate it. Every cell is quoted,
 * and a formula-leading cell is prefixed with an apostrophe.
 *
 * The line ending is CRLF, because that is what Excel reads without a
 * double-click prompt, and this file is going into Excel.
 */

const CRLF = '\r\n';

/**
 * Quote one CSV field.
 * @param {unknown} value
 * @returns {string}
 */
function field(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  // A spreadsheet reads a leading =, +, - or @ as the start of a formula.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Build the CSV text for a set of rows.
 *
 * @param {Array<object>} rows
 * @param {Array<{label: string, get: (row: object) => unknown}>} columns
 * @returns {string}
 */
export function toCsv(rows, columns) {
  const lines = [columns.map((column) => field(column.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => field(column.get(row))).join(','));
  }
  return `${lines.join(CRLF)}${CRLF}`;
}

/**
 * Offer the CSV as a download.
 *
 * The filename says what the file IS, because a file called `export.csv` in a
 * downloads folder is a file nobody can find again.
 *
 * @param {string} text
 * @param {string} filename
 */
export function downloadCsv(text, filename) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

/**
 * The filename for an export: the filters are in it, so two exports of two
 * different views do not fight over the same name in a downloads folder.
 *
 * @param {object} filters
 * @returns {string}
 */
export function csvFilename(filters) {
  const state = filters.state ? `-${filters.state}` : '';
  const years = `-${filters.fromYear}-${filters.toYear}`;
  return `hail-desk${state}${years}.csv`;
}

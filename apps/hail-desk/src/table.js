/**
 * The market tables.
 *
 * A table, not a map, and not a list of names. Every cell is a number a
 * salesperson can act on, every number carries its caveat, and every column
 * sorts.
 *
 * The caveats are IN the table rather than in a notes panel, because a number
 * read without its caveat is a number read wrong. The housing-unit column
 * carries its margin of error, and the score column carries the fact that it
 * is a model.
 */

/** The columns a CITY row has. */
export const CITY_COLUMNS = Object.freeze([
  {
    key: 'name',
    label: 'City',
    align: 'left',
    get: (row) => row.full || row.name,
    title:
      'The Census place: a city, town, village or CDP. A canvasser works in ' +
      'a town, not a county, and this is the row that says what fell in it.',
  },
  {
    key: 'st',
    label: 'St',
    align: 'left',
    get: (row) => row.st || '',
    title: 'Two-letter state code.',
  },
  {
    key: 'severe',
    label: 'Hail ≥1"',
    align: 'right',
    get: (row) => row.severe,
    format: (value) => value.toLocaleString(),
    title:
      'Hail reports of an inch or more, in this town, inside the selected ' +
      'window. Counted from the individual reports - this is what was ' +
      'reported, not what a model thinks.',
  },
  {
    key: 'severe15',
    label: '≥1.5"',
    align: 'right',
    get: (row) => row.severe15,
    format: (value) => value.toLocaleString(),
    title:
      'Reports of an inch and a half or more. The insurance threshold: an inch ' +
      'is cosmetic damage, an inch and a half is a repair.',
  },
  {
    key: 'big',
    label: '≥2"',
    align: 'right',
    get: (row) => row.big,
    format: (value) => value.toLocaleString(),
    title: 'Reports of two inches or more - a replacement, not a repair.',
  },
  {
    key: 'max',
    label: 'Max hail',
    align: 'right',
    get: (row) => row.max,
    format: (value) => (value ? `${value.toFixed(2)}"` : '-'),
    title:
      'The largest stone REPORTED in this town inside the window, in inches. ' +
      'A measured stone, not a radar estimate - radar is sound about where ' +
      'hail fell and unsound about how big each stone was.',
  },
  {
    key: 'hail',
    label: 'All hail',
    align: 'right',
    get: (row) => row.hail,
    format: (value) => value.toLocaleString(),
    title: 'Every hail report in the window, at any size.',
  },
  {
    key: 'units',
    label: 'Housing units',
    align: 'right',
    get: (row) => row.units ?? null,
    format: (value) => (value === null ? '-' : value.toLocaleString()),
    title:
      'How many roofs are in this town: Census ACS 5-year table B25001. This ' +
      'is the MARKET SIZE - the number of possible customers - and it is NOT ' +
      'the number of houses that were hit.',
  },
  {
    key: 'umoe',
    label: '±',
    align: 'right',
    get: (row) => row.umoe ?? null,
    format: (value) => (value === null ? '-' : `±${value.toLocaleString()}`),
    title:
      'The 90% margin of error on the housing-unit count. B25001 is a SAMPLE ' +
      'estimate, and a town with 1,900 units can carry a margin of 125. A ' +
      'number without its margin is a claim the data does not support.',
  },
  {
    key: 'pop',
    label: 'Population',
    align: 'right',
    get: (row) => row.pop ?? null,
    format: (value) => (value === null ? '-' : value.toLocaleString()),
    title: 'How many people live in this town.',
  },
]);

/** The columns a COUNTY row has. */
export const COUNTY_COLUMNS = Object.freeze([
  {
    key: 'name',
    label: 'County',
    align: 'left',
    get: (row) => row.name,
    title: 'The county name, as the Census publishes it.',
  },
  {
    key: 'st',
    label: 'St',
    align: 'left',
    get: (row) => row.st || '',
    title: 'Two-letter state code.',
  },
  {
    key: 'score',
    label: 'Score',
    align: 'right',
    get: (row) => row.score,
    format: (value) => value.toFixed(3),
    title:
      'Blended hail-and-wind damage likelihood for this county over the ' +
      'selected window: observed hazard, FEMA National Risk Index modelled ' +
      'loss, and exposure, in that order of weight. It is a MODEL of ' +
      'likelihood, not a measurement of damage, and it is the number to sort ' +
      'by - not the number to quote.',
  },
  {
    key: 'band',
    label: 'Band',
    align: 'left',
    get: (row) => row.band || '',
    title: 'The band the score falls in.',
  },
  {
    key: 'hail',
    label: 'Hail events',
    align: 'right',
    get: (row) => row.window?.hailCount ?? 0,
    format: (value) => value.toLocaleString(),
    title:
      'Hail events recorded in this county inside the selected window. ' +
      'Counted from the per-year tallies, so a one-year window answers with ' +
      'that year and not with a fraction of a seventy-year average.',
  },
  {
    key: 'severe',
    label: 'Severe',
    align: 'right',
    get: (row) => row.window?.hailEvents ?? 0,
    format: (value) => Math.round(value).toLocaleString(),
    title:
      'Events of an inch or more, scaled to the window. The scale is the ' +
      'share of the record inside the window, so a one-year window shows a ' +
      'one-year share and not a lifetime count.',
  },
  {
    key: 'maxHail',
    label: 'Max hail',
    align: 'right',
    get: (row) => row.maxHailIn || 0,
    format: (value) => (value ? `${value.toFixed(2)}"` : '-'),
    title:
      'The largest stone EVER recorded in this county, in inches. Lifetime, ' +
      'not window: a county that had one softball in 1993 still shows it here.',
  },
  {
    key: 'units',
    label: 'Housing units',
    align: 'right',
    get: (row) => row.units ?? null,
    format: (value) => (value === null ? '-' : value.toLocaleString()),
    title:
      'How many roofs are in this county: Census ACS 5-year table B25001. ' +
      'Market size, not houses hit.',
  },
  {
    key: 'umoe',
    label: '±',
    align: 'right',
    get: (row) => row.umoe ?? null,
    format: (value) => (value === null ? '-' : `±${value.toLocaleString()}`),
    title: 'The 90% margin of error on the housing-unit count.',
  },
  {
    key: 'pop',
    label: 'Population',
    align: 'right',
    get: (row) => row.pop ?? null,
    format: (value) => (value === null ? '-' : value.toLocaleString()),
    title: 'County population, from the FEMA National Risk Index.',
  },
  {
    key: 'bld',
    label: 'Expected loss / yr',
    align: 'right',
    get: (row) => row.bld ?? null,
    format: (value) =>
      value === null ? '-' : `$${Math.round(value).toLocaleString()}`,
    title:
      'The county\u2019s EXPECTED ANNUAL LOSS from hail and wind, from the ' +
      'FEMA National Risk Index. Not a dollar amount lost last year - a ' +
      'modelled yearly figure.',
  },
]);

/** How each sort reads, per view. */
const SORTERS = {
  city: {
    severe: (row) => row.severe,
    severe15: (row) => row.severe15,
    max: (row) => row.max,
    units: (row) => row.units ?? -1,
    pop: (row) => row.pop ?? -1,
    hail: (row) => row.hail,
  },
  county: {
    score: (row) => row.score,
    units: (row) => row.units ?? -1,
    hail: (row) => row.window?.hailCount ?? 0,
    pop: (row) => row.pop ?? -1,
  },
};

/**
 * Sort the rows for the table.
 *
 * Ties break on the name, so the order is STABLE: two rows with the same
 * score must not swap places between renders, because a list that reorders
 * itself under the cursor is a list nobody can read a row out of.
 *
 * @param {Array<object>} rows
 * @param {string} view 'city' or 'county'
 * @param {string} sort
 * @param {string} dir 'asc' or 'desc'
 * @returns {Array<object>}
 */
export function sortRows(rows, view, sort, dir) {
  const table = SORTERS[view] || SORTERS.city;
  const key = table[sort] || Object.values(table)[0];
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (typeof left === 'string' || typeof right === 'string') {
      const compared = String(left).localeCompare(String(right));
      if (compared !== 0) return compared * sign;
    } else if (left !== right) {
      return (left - right) * sign;
    }
    return String(a.name ?? a.full ?? '').localeCompare(
      String(b.name ?? b.full ?? ''),
    );
  });
}

/**
 * Render the table into a container.
 *
 * @param {HTMLElement} container
 * @param {Array<object>} rows
 * @param {Array<object>} columns
 * @param {object} state
 * @param {(key: string) => void} onSort
 */
export function renderTable(container, rows, columns, state, onSort, onRowClick) {
  container.replaceChildren();
  const table = document.createElement('table');
  table.className = 'desk-table';

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of columns) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'desk-sort';
    if (state.sort === column.key) {
      cell.setAttribute(
        'aria-sort',
        state.dir === 'asc' ? 'ascending' : 'descending',
      );
      button.classList.add('active');
    }
    button.textContent = column.label;
    if (column.title) button.title = column.title;
    button.addEventListener('click', () => onSort(column.key));
    cell.appendChild(button);
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    if (onRowClick) {
      tr.className = 'clickable';
      tr.tabIndex = 0;
      tr.title = 'Show the storms in this place';
      tr.addEventListener('click', () => onRowClick(row));
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onRowClick(row);
        }
      });
    }
    for (const column of columns) {
      const cell = document.createElement('td');
      // The card layout on a phone has no header row, so the label travels
      // with the cell. A table that turns into cards without its labels is
      // just a list of numbers.
      cell.dataset.label = column.label;
      const value = column.get(row);
      cell.textContent =
        value === null || value === undefined
          ? '-'
          : column.format
            ? column.format(value, row)
            : String(value);
      if (column.align === 'right') cell.className = 'num';
      tr.appendChild(cell);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  container.appendChild(table);
}

/**
 * The one-line summary of a filtered view.
 *
 * It names the COUNT of places and the size of the market underneath them,
 * because those are the two numbers that say whether a market is worth a day:
 * how many places were hit, and how many roofs are in them.
 *
 * @param {Array<object>} rows
 * @param {object} filters
 * @param {string} view
 * @returns {string}
 */
export function summarise(rows, filters, view = 'city') {
  if (!rows.length) return 'No places match these filters.';
  const units = rows.reduce((total, row) => total + (row.units || 0), 0);
  const withUnits = rows.filter((row) => row.units !== null).length;
  const noun = view === 'city' ? 'place' : 'county';
  const parts = [
    `${rows.length.toLocaleString()} ${rows.length === 1 ? noun : `${noun}s`}`,
    `${filters.fromYear}–${filters.toYear}`,
  ];
  if (withUnits) {
    parts.push(`${units.toLocaleString()} housing units across them`);
  }
  return parts.join(' · ');
}

/** The names of the worst few places, for the line under the table. */
export function topNames(rows, limit = 4) {
  return rows
    .slice(0, limit)
    .map((row) => row.full || row.name)
    .join(', ');
}

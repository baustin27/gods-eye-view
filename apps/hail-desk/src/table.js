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

/**
 * The columns a STORM DAY row has.
 *
 * The storm list is the desk's work list: the days a storm happened, and how
 * many roofs were standing under it. Every column sorts both ways.
 *
 * A column the day has nothing for says so with a dash, not a zero. A zero
 * claims the radar reached nothing and there were no houses, which is a
 * CLAIM; a dash says the radar did not reach here, which is the truth - and
 * the difference is the difference between "there were no houses" and "we do
 * not know", which on a hail map is the difference between a market and a
 * blank.
 */
export const STORM_COLUMNS = Object.freeze([
  {
    key: 'date',
    label: 'Date',
    align: 'left',
    get: (row) => row.date,
    title:
      'The day the hail was REPORTED. The radar day that covers it is the ' +
      'next one, because MRMS names a file for the window ENDING at its ' +
      'timestamp.',
  },
  {
    key: 'houses',
    label: 'Houses in reach',
    align: 'right',
    get: (row) => row.houses,
    format: (value) => value.toLocaleString(),
    title:
      'The housing units in the census tracts the 1 km radar field reached ' +
      'that day. This is a FOOTPRINT: the houses standing under the hail, ' +
      'not the houses a stone landed on. The radar says where hail fell and ' +
      'is unsound about how big each stone was.',
  },
  {
    key: 'reports',
    label: 'Reports',
    align: 'right',
    get: (row) => (row.kind === 'radar' ? null : row.reports),
    format: (value) => value.toLocaleString(),
    title:
      'The hail reports filed from inside a city or town boundary that day. ' +
      'A dash means the day is on the radar spine only: the radar reached ' +
      'the market and nobody called the hail in, which is the lead list.',
  },
  {
    key: 'severe',
    label: '≥1"',
    align: 'right',
    get: (row) => (row.kind === 'radar' ? null : row.severe),
    format: (value) => value.toLocaleString(),
    title:
      'The reports of an inch or more. An inch is cosmetic damage; an inch ' +
      'and a half is a repair.',
  },
  {
    key: 'largest',
    label: 'Largest',
    align: 'right',
    get: (row) => row.largest,
    format: (value) => `${value.toFixed(2)}"`,
    title:
      'The largest stone, in inches: the radar reading where the radar ' +
      'reached, and the largest stone the reports named where it did not.',
  },
  {
    key: 'places',
    label: 'Places',
    align: 'right',
    get: (row) => (row.kind === 'radar' ? null : row.places),
    format: (value) => value.toLocaleString(),
    title:
      'The number of towns that filed a report that day. The broadest days ' +
      'are the ones that hit a whole region rather than one town.',
  },
]);

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
  // EVERY column a header offers must be in here. They were not, and the
  // sort fell back to the first entry for anything missing - so "Big (>=2\")",
  // "St", "City", "Band", "Max hail" and "Expected loss / yr" were headers that
  // changed the URL and did not move the table. A header that lies about
  // being a control is worse than no header.
  //
  // The DEFAULT SORT IS FIRST in each, because that is the fallback.
  city: {
    severe: (row) => row.severe,
    severe15: (row) => row.severe15,
    big: (row) => row.big,
    max: (row) => row.max,
    hail: (row) => row.hail,
    units: (row) => row.units ?? -1,
    umoe: (row) => row.umoe ?? -1,
    pop: (row) => row.pop ?? -1,
    name: (row) => row.full || row.name,
    st: (row) => row.st || '',
  },
  county: {
    score: (row) => row.score,
    hail: (row) => row.window?.hailCount ?? 0,
    severe: (row) => row.severe,
    maxHail: (row) => row.maxHailIn ?? 0,
    units: (row) => row.units ?? -1,
    umoe: (row) => row.umoe ?? -1,
    pop: (row) => row.pop ?? -1,
    bld: (row) => row.bld ?? -1,
    name: (row) => row.full || row.name,
    st: (row) => row.st || '',
    band: (row) => row.band || '',
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
/**
 * The row height, in pixels.
 *
 * MEASURED, not assumed. The windowing below computes which rows to put in
 * the DOM from the scroll position, and if the row height is wrong the rows
 * drift out of step with the scrollbar - a table that scrolls to the wrong
 * place is worse than a slow one. The height is measured off a rendered row
 * on the first fill, and the CSS pins it so the two cannot drift.
 */
const ROW_HEIGHT = 30;

/** How many rows beyond the viewport to keep in the DOM either side. */
const OVERSCAN = 12;

/** The live table, so a scroll can refill it without rebuilding the header. */
let _live = null;

/**
 * A row of nothing, the height of the rows it stands in for.
 *
 * The table keeps its real height, so the scrollbar is honest about how far
 * down the list there is.
 */
function spacerRow(height, span) {
  const tr = document.createElement('tr');
  tr.className = 'desk-spacer';
  tr.setAttribute('aria-hidden', 'true');
  const td = document.createElement('td');
  td.colSpan = span;
  td.style.height = `${height}px`;
  tr.appendChild(td);
  return tr;
}

/**
 * Put the rows that are visible into the DOM, and no others.
 *
 * @param {object} live the live table record
 */
function fillWindow(live) {
  const { container, body, rows, columns, state, onSort, onRowClick } = live;
  const total = rows.length;
  if (!total) {
    body.replaceChildren();
    return;
  }
  const viewport = container.clientHeight || 600;
  const first = Math.max(
    0,
    Math.floor(container.scrollTop / ROW_HEIGHT) - OVERSCAN,
  );
  const last = Math.min(
    total,
    first + Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2,
  );
  const fragment = document.createDocumentFragment();
  if (first > 0) fragment.appendChild(spacerRow(first * ROW_HEIGHT, columns.length));
  for (const row of rows.slice(first, last)) {
    fragment.appendChild(
      buildRow(row, columns, state, onSort, onRowClick, live.rowClass),
    );
  }
  if (last < total) {
    fragment.appendChild(spacerRow((total - last) * ROW_HEIGHT, columns.length));
  }
  body.replaceChildren(fragment);
}

/**
 * One table row.
 */
function buildRow(row, columns, state, onSort, onRowClick, rowClass) {
  const tr = document.createElement('tr');
  // The selected row, marked as such. A person looking at a list and a map
  // has to know which row the map is showing, and a table that does not say
  // so makes them read the map's caption to find out.
  if (rowClass?.(row)) tr.classList.add('selected');
  if (onRowClick) {
    // classList, not className: className REPLACES the whole list, and it
    // was wiping the 'selected' class off the row it was marking.
    tr.classList.add('clickable');
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
    cell.dataset.label = column.label;
    const value = column.get(row);
    cell.textContent =
      value === null || value === undefined
        ? '\u2014'
        : column.format
          ? column.format(value, row)
          : String(value);
    if (column.align === 'right') cell.className = 'num';
    tr.appendChild(cell);
  }
  return tr;
}

/**
 * The table: a WINDOW onto the rows, not a copy of them.
 *
 * It used to render every row. The default view is 6,496 places, and that is
 * 64,960 cells and two event listeners on every row, rebuilt from scratch on
 * every keystroke of the search box. The CSV export is unaffected: it reads
 * `state.rows`, never the DOM.
 */
export function renderTable(
  container,
  rows,
  columns,
  state,
  onSort,
  onRowClick,
  rowClass,
) {
  const same =
    _live &&
    _live.container === container &&
    _live.columns === columns;
  if (!same) {
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

  const body = document.createElement('tbody');
    table.appendChild(head);
    table.appendChild(body);
    container.appendChild(table);
    _live = {
      container,
      columns,
      table,
      body,
      rows,
      state,
      onSort,
      onRowClick,
      rowClass,
    };
    // One scroll listener for the life of the table. The body is refilled
    // from the scroll position, so the list is a window and not a copy.
    container.addEventListener(
      'scroll',
      () => {
        if (_live) fillWindow(_live);
      },
      { passive: true },
    );
    // The first fill happens before the layout has settled, so the viewport
    // is not yet the height it will be - and a window sized on a viewport
    // that is about to grow leaves the bottom of the list empty. A resize
    // observer refills when the box actually reaches its size.
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        if (_live) fillWindow(_live);
      });
      observer.observe(container);
      _live.observer = observer;
    }
  } else {
    // The same table, new contents. A NEW result set starts at the top: the
    // old scroll position pointed into a list that no longer exists.
    const changed = _live.rows !== rows;
    _live.rows = rows;
    _live.state = state;
    _live.onSort = onSort;
    _live.onRowClick = onRowClick;
    _live.rowClass = rowClass;
    if (changed) container.scrollTop = 0;
  }
  fillWindow(_live);
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
/**
 * How many places the ranked list names.
 *
 * Twelve, because that is what the globe's county list keeps
 * (`STORM_COUNTY_LIST_LIMIT`): enough to be a market, few enough to read.
 */
export const RANKED_LIST_LIMIT = 12;

/**
 * The ranked list: the places worth the afternoon.
 *
 * This is the desk's answer to "which towns should I drive to", and it is
 * what a table of 6,496 rows cannot say. The shape is the globe's county
 * list (`src/layers/hailwind/index.js:634-658`) exactly, because the two
 * surfaces should say the same thing the same way:
 *
 *   - `lead` is a SHORT, fixed-width marker - the state - so the eye can
 *     scan the column.
 *   - `text` carries the value as a SHARE OF THE MAXIMUM, not as an
 *     absolute. An absolute score is not comparable across windows: 4
 *     severe reports in a week with no hail is a different thing from 4
 *     severe reports in a week with hail everywhere, and the share says so.
 *   - `ordinal` is the rank, and the rank is the point.
 *
 * @param {Array<object>} rows the filtered, sorted rows
 * @param {object} [options]
 * @param {string} [options.view] 'city' or 'county'
 * @param {string|null} [options.currentId] the place the drill-down is on
 * @returns {{ariaLabel: string, items: Array<object>}}
 */
export function rankedList(rows, { view = 'city', currentId = null } = {}) {
  const top = (rows || []).slice(0, RANKED_LIST_LIMIT);
  const measure = view === 'city' ? (r) => r.severe : (r) => r.score;
  const max = top.reduce((m, r) => Math.max(m, Number(measure(r)) || 0), 0);
  return {
    ariaLabel:
      view === 'city'
        ? 'Places by hail reports of an inch or more'
        : 'Counties by hail and wind damage likelihood',
    items: top.map((row, index) => {
      const id = row.id ?? row.fips;
      const share = max > 0 ? Math.round(((Number(measure(row)) || 0) / max) * 100) : 0;
      const worst =
        view === 'city'
          ? row.max
          : row.maxHailIn;
      return {
        id: `${view}-rank:${id}`,
        ordinal: index + 1,
        lead: row.st || '',
        text:
          `${row.full || row.name} · ${share}%` +
          (worst ? ` · max ${Number(worst).toFixed(2)}"` : ''),
        active: false,
        current: id === currentId,
        params: { id },
      };
    }),
  };
}

export function topNames(rows, limit = 4) {
  return rows
    .slice(0, limit)
    .map((row) => row.full || row.name)
    .join(', ');
}

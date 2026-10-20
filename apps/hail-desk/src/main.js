/**
 * The Hail Desk.
 *
 * A table, not a globe. The globe is the right tool for LOOKING at a storm;
 * this is the right tool for WORKING a market, and a market is a list with
 * numbers in it that a person sorts, filters and exports.
 *
 * The CITIES view is the default and the point: one row per town, with the
 * hail that actually fell in it, counted from the 155,738 individual reports.
 * The COUNTIES view is the coarser market view, with the shared core's score.
 *
 * The scores come from the shared core, so a county's score here is the same
 * score the globe shows. That is the whole point of one core: two front ends,
 * one answer.
 */

import {
  cityStorms,
  cityYearBounds,
  indexCities,
  indexSwaths,
  loadGzippedJson,
  queryCities,
  queryCounties,
  radarDays,
  swathFor,
  yearBounds,
} from './data.js';
import { DEFAULT_FILTERS, filtersFromHash, hashFromFilters } from './state.js';
import {
  CITY_COLUMNS,
  COUNTY_COLUMNS,
  renderTable,
  sortRows,
  summarise,
  topNames,
} from './table.js';
import { csvFilename, downloadCsv, toCsv } from './csv.js';

const CITY_DATA_URL = `${import.meta.env.BASE_URL}data/cities.json.gz`;
const COUNTY_DATA_URL = `${import.meta.env.BASE_URL}data/counties.json.gz`;
const SWATH_DATA_URL = `${import.meta.env.BASE_URL}data/swaths.json.gz`;

/** The state of the app. Filters live in the URL, so the URL is the state. */
const state = {
  view: 'city',
  filters: { ...DEFAULT_FILTERS },
  rows: [],
  cityIndex: null,
  countyRows: [],
  swathIndex: null,
};

const CSV_COLUMNS = {
  city: [
    { label: 'City', get: (row) => row.full || row.name },
    { label: 'State', get: (row) => row.st || '' },
    { label: 'Hail reports >= 1 in', get: (row) => row.severe },
    { label: 'Hail reports >= 1.5 in', get: (row) => row.severe15 },
    { label: 'Hail reports >= 2 in', get: (row) => row.big },
    { label: 'Largest stone reported (in)', get: (row) => row.max },
    { label: 'All hail reports', get: (row) => row.hail },
    { label: 'Wind reports', get: (row) => row.wind },
    { label: 'Housing units', get: (row) => row.units ?? '' },
    { label: 'Housing units MOE', get: (row) => row.umoe ?? '' },
    { label: 'Population', get: (row) => row.pop ?? '' },
  ],
  county: [
    { label: 'County', get: (row) => row.name },
    { label: 'State', get: (row) => row.st || '' },
    { label: 'Score', get: (row) => row.score?.toFixed(4) ?? '' },
    { label: 'Band', get: (row) => row.band || '' },
    { label: 'Hail events in window', get: (row) => row.window?.hailCount ?? 0 },
    {
      label: 'Severe hail events in window',
      get: (row) => Math.round(row.window?.hailEvents ?? 0),
    },
    { label: 'Max hail ever (in)', get: (row) => row.maxHailIn || '' },
    { label: 'Housing units', get: (row) => row.units ?? '' },
    { label: 'Housing units MOE', get: (row) => row.umoe ?? '' },
    { label: 'Population', get: (row) => row.pop ?? '' },
    {
      label: 'Expected annual loss (FEMA NRI)',
      get: (row) => row.bld ?? '',
    },
  ],
};

/** The elements, looked up once. */
const el = {
  filters: document.getElementById('filters'),
  state: document.getElementById('state'),
  fromYear: document.getElementById('fromYear'),
  toYear: document.getElementById('toYear'),
  minHail: document.getElementById('minHail'),
  q: document.getElementById('q'),
  summary: document.getElementById('summary'),
  worst: document.getElementById('worst'),
  tableWrap: document.getElementById('tableWrap'),
  loading: document.getElementById('loading'),
  source: document.getElementById('source'),
  export: document.getElementById('export'),
  copyLink: document.getElementById('copyLink'),
  views: document.getElementById('views'),
  detail: document.getElementById('detail'),
};

/** The columns for the current view. */
const columns = () => (state.view === 'city' ? CITY_COLUMNS : COUNTY_COLUMNS);

/** Repaint from the current filters. */
function render() {
  const rows =
    state.view === 'city'
      ? queryCities(state.cityIndex, state.filters)
      : queryCounties(state.countyRows, state.filters);
  state.rows = sortRows(rows, state.view, state.filters.sort, state.filters.dir);
  renderTable(
    el.tableWrap,
    state.rows,
    columns(),
    state.filters,
    onSort,
    state.view === 'city' ? onCityClick : null,
  );
  el.summary.textContent = summarise(state.rows, state.filters, state.view);
  const names = topNames(state.rows);
  el.worst.textContent = names ? `Worst first: ${names}` : '';
  el.export.disabled = state.rows.length === 0;
  el.views.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view);
    button.setAttribute(
      'aria-pressed',
      button.dataset.view === state.view ? 'true' : 'false',
    );
  });
}

/** Write the filters into the URL, then repaint. */
function applyFilters(next) {
  state.filters = { ...state.filters, ...next };
  const hash = hashFromFilters(state.filters);
  if (window.location.hash !== hash) {
    window.history.replaceState(null, '', hash);
  }
  syncControls();
  render();
}

/** Put the filters back into the controls. */
function syncControls() {
  const { fromYear, toYear, state: st, minHailTenths, q } = state.filters;
  if (document.activeElement !== el.fromYear) el.fromYear.value = fromYear;
  if (document.activeElement !== el.toYear) el.toYear.value = toYear;
  if (document.activeElement !== el.q) el.q.value = q;
  // The codec lower-cases every string option, and the option VALUES here are
  // the USPS codes, which are upper case. Assigning a lower-case code to a
  // select with upper-case options finds no match, the control renders BLANK,
  // and the filter keeps working on a value the user cannot see. A dropdown
  // that disagrees with the filter is worse than no dropdown.
  el.state.value = String(st || '').toUpperCase();
  el.minHail.value = String(minHailTenths);
}

/** Sort by a column, toggling the direction when it is already sorted by. */
function onSort(key) {
  const same = state.filters.sort === key;
  applyFilters({
    sort: key,
    dir: same && state.filters.dir === 'desc' ? 'asc' : 'desc',
  });
}

/**
 * The storms in one place, worst first.
 *
 * This is the drill-down that makes the table a work list: the market view
 * says a town was hit, and this says on which days and by how much, which is
 * the list a canvasser actually works from.
 */
function onCityClick(row) {
  const reported = cityStorms(state.cityIndex, row.id, state.filters);
  const radar = radarDays(state.swathIndex, row.id, state.filters);
  // The union of the two. A day the radar reached but nobody reported is not
  // missing - it is the LEAD: the hail fell, and the only people who know are
  // the people who did not call it in.
  const byDay = new Map(reported.map((storm) => [storm.d, { ...storm, reported: true }]));
  for (const day of radar) {
    const existing = byDay.get(day.d);
    if (existing) existing.swath = day;
    else byDay.set(day.d, { d: day.d, n: 0, n1: 0, n15: 0, n2: 0, max: 0, wind: 0, reported: false, swath: day });
  }
  const storms = [...byDay.values()].sort(
    (a, b) =>
      (b.swath?.houses ?? 0) - (a.swath?.houses ?? 0) ||
      b.n1 - a.n1 ||
      b.max - a.max ||
      a.d.localeCompare(b.d),
  );
  el.detail.replaceChildren();
  el.detail.hidden = false;

  const head = document.createElement('div');
  head.className = 'detail-head';
  const title = document.createElement('h2');
  title.textContent = `${row.full || row.name}, ${row.st || ''}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'secondary';
  close.textContent = 'Close';
  close.addEventListener('click', () => {
    el.detail.hidden = true;
    el.detail.replaceChildren();
  });
  head.append(title, close);

  const summary = document.createElement('p');
  summary.className = 'detail-summary';
  const worst = storms[0];
  const swathed = storms.filter((storm) => storm.swath);
  const unreported = swathed.filter((storm) => !storm.reported);
  const houses = swathed.reduce(
    (total, storm) =>
      total + (swathFor(state.swathIndex, row.id, storm.d)?.houses || 0),
    0,
  );
  summary.textContent = worst
    ? `${storms.length} ${storms.length === 1 ? 'day' : 'days'} with hail reported in this place. ` +
      `Worst: ${worst.d} with ${worst.n1} of an inch or more and a largest stone of ${worst.max.toFixed(2)}\". ` +
      `${(row.units ?? 0).toLocaleString()} housing units in the place. ` +
      (swathed.length
        ? `${houses.toLocaleString()} of them were under the radar on ` +
          `${swathed.length} of these days` +
          (unreported.length
            ? `, and nobody called in ${unreported.length} of them - ` +
              'that is the lead list.'
            : '.')
        : 'The 1 km radar field does not reach back far enough to say how ' +
          'many of them were under the hail.')
    : 'No hail reported in this place inside the selected window.';

  const table = document.createElement('table');
  table.className = 'desk-table storm-table';
  const head2 = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const [label, title2] of [
    ['Date', 'The day the hail was reported.'],
    ['≥1"', 'Reports of an inch or more that day.'],
    ['≥1.5"', 'Reports of an inch and a half or more.'],
    ['≥2"', 'Reports of two inches or more.'],
    ['Max', 'The largest stone reported that day, in inches.'],
    ['Wind', 'Wind reports that day.'],
    [
      'Houses',
      'Housing units in the tracts the RADAR reached in this place that ' +
        'day. A tract the radar reached is a tract to work and every house ' +
        'in it is a candidate: the radar is sound about where hail fell and ' +
        'unsound about how big each stone was. Blank before 2024-01-01, ' +
        'which is where the 1 km radar field starts.',
    ],
    [
      'Lead',
      'The radar reached this place and nobody called it in. A day with ' +
        'houses under it and no reports is where the canvassing is.',
    ],
  ]) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    cell.title = title2;
    hr.appendChild(cell);
  }
  head2.appendChild(hr);
  table.appendChild(head2);
  const body = document.createElement('tbody');
  for (const storm of storms) {
    const tr = document.createElement('tr');
    const swath = storm.swath;
    for (const value of [
      storm.d,
      storm.n1.toLocaleString(),
      storm.n15.toLocaleString(),
      storm.n2.toLocaleString(),
      `${storm.max.toFixed(2)}"`,
      storm.wind.toLocaleString(),
      swath ? swath.houses.toLocaleString() : '—',
      swath && !storm.reported ? 'nobody called it in' : '',
    ]) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      tr.appendChild(cell);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  el.detail.append(head, summary, table);
  el.detail.scrollIntoView({ block: 'nearest' });
}

/** Populate the state dropdown from the states the data actually covers. */
function fillStates(rows, key) {
  const states = new Map();
  for (const row of rows) {
    const code = String(row[key] || '').trim();
    if (!code) continue;
    states.set(code, (states.get(code) || 0) + 1);
  }
  for (const code of [...states.keys()].sort()) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = `${code} (${states.get(code)})`;
    el.state.appendChild(option);
  }
}

async function main() {
  try {
    const [citiesPayload, countiesPayload, swathPayload] = await Promise.all([
      loadGzippedJson(CITY_DATA_URL),
      loadGzippedJson(COUNTY_DATA_URL),
      loadGzippedJson(SWATH_DATA_URL),
    ]);
    state.cityIndex = indexCities(citiesPayload);
    state.countyRows = countiesPayload.rows || [];
    state.swathIndex = indexSwaths(swathPayload);

    const cityBounds = cityYearBounds(state.cityIndex);
    const countyBounds = yearBounds(state.countyRows);
    el.fromYear.min = String(Math.min(cityBounds.min, countyBounds.min));
    el.fromYear.max = String(Math.max(cityBounds.max, countyBounds.max));
    el.toYear.min = el.fromYear.min;
    el.toYear.max = el.fromYear.max;

    // The URL wins over the defaults: a shared link is the point.
    state.filters = {
      ...DEFAULT_FILTERS,
      ...filtersFromHash(window.location.hash),
    };
    state.filters.fromYear = clamp(
      state.filters.fromYear,
      Number(el.fromYear.min),
      Number(el.fromYear.max),
    );
    state.filters.toYear = clamp(
      state.filters.toYear,
      Number(el.fromYear.min),
      Number(el.fromYear.max),
    );
    if (state.filters.fromYear > state.filters.toYear) {
      state.filters.fromYear = state.filters.toYear;
    }

    fillStates(state.cityIndex.cities, 'st');
    syncControls();
    render();

    el.loading.remove();
    const cityCount = state.cityIndex.byYear.size;
    el.source.textContent =
      `${cityCount.toLocaleString()} places with hail · ` +
      `${state.countyRows.length.toLocaleString()} counties · ` +
      `ACS ${citiesPayload.meta?.housingVintage ?? ''} housing units`;
  } catch (error) {
    el.loading.textContent = `Could not load the county data: ${error.message}`;
    el.loading.className = 'loading error';
  }

  el.filters.addEventListener('submit', (event) => event.preventDefault());
  el.filters.addEventListener('change', (event) => {
    const target = event.target;
    if (target === el.state) applyFilters({ state: el.state.value });
    else if (target === el.fromYear)
      applyFilters({ fromYear: Number(el.fromYear.value) });
    else if (target === el.toYear)
      applyFilters({ toYear: Number(el.toYear.value) });
    else if (target === el.minHail)
      applyFilters({ minHailTenths: Number(el.minHail.value) });
  });
  el.q.addEventListener('input', () => {
    applyFilters({ q: el.q.value });
  });
  el.views.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (!button) return;
    state.view = button.dataset.view;
    // The sort key is per-view, so switching views resets it to that view's
    // best column rather than leaving a column that does not exist.
    const first = columns()[0];
    state.filters.sort =
      state.view === 'city' ? 'severe' : 'score';
    state.filters.dir = 'desc';
    void first;
    syncControls();
    render();
  });
  el.export.addEventListener('click', () => {
    downloadCsv(
      toCsv(state.rows, CSV_COLUMNS[state.view]),
      csvFilename(state.filters),
    );
  });
  el.copyLink.addEventListener('click', async () => {
    const url = `${window.location.origin}${window.location.pathname}${hashFromFilters(state.filters)}`;
    try {
      await navigator.clipboard.writeText(url);
      el.copyLink.textContent = 'Copied';
    } catch {
      el.copyLink.textContent = url;
    }
    setTimeout(() => {
      el.copyLink.textContent = 'Copy link';
    }, 2000);
  });
  window.addEventListener('hashchange', () => {
    state.filters = {
      ...DEFAULT_FILTERS,
      ...filtersFromHash(window.location.hash),
    };
    syncControls();
    render();
  });
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

main();

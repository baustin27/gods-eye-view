/**
 * The Hail Desk.
 *
 * A table, not a globe. The globe is the right tool for LOOKING at a storm;
 * this is the right tool for WORKING a market, and a market is a list with
 * numbers in it that a person sorts, filters and exports.
 *
 * The scores come from the shared core, so a county's score here is the same
 * score the globe shows. That is the whole point of one core: two front ends,
 * one answer.
 */

import { loadDeskData, queryCounties, yearBounds } from './data.js';
import { DEFAULT_FILTERS, filtersFromHash, hashFromFilters } from './state.js';
import { COLUMNS, renderTable, sortRows, summarise, topNames } from './table.js';
import { csvFilename, downloadCsv, toCsv } from './csv.js';

/**
 * The data URL.
 *
 * The artifact is in `public/`, so it is fetched at a plain path rather than
 * through a bundler asset reference: a .gz referenced from source is a thing
 * the bundler wants to transform, and the one transform it would apply is to
 * make it not-a-.gz.
 */
const DATA_URL = `${import.meta.env.BASE_URL}data/counties.json.gz`;

/** The state of the app. Filters live in the URL, so the URL is the state. */
const state = {
  filters: { ...DEFAULT_FILTERS },
  rows: [],
  allRows: [],
};

/**
 * The columns the CSV carries.
 *
 * The SAME columns the table shows, in the same order, with the same values.
 * A file whose columns differ from the screen is a file nobody can reconcile.
 */
const CSV_COLUMNS = [
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
  { label: 'First year', get: (row) => row.y0 ?? '' },
  { label: 'Last year', get: (row) => row.y1 ?? '' },
];

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
  tagline: document.getElementById('tagline'),
  export: document.getElementById('export'),
  copyLink: document.getElementById('copyLink'),
};

/** Repaint from the current filters. */
function render() {
  const rows = queryCounties(state.allRows, state.filters);
  state.rows = sortRows(rows, state.filters.sort, state.filters.dir);
  renderTable(el.tableWrap, state.rows, state.filters, onSort);
  el.summary.textContent = summarise(state.rows, state.filters);
  const names = topNames(state.rows);
  el.worst.textContent = names ? `Worst first: ${names}` : '';
  el.export.disabled = state.rows.length === 0;
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
  el.state.value = st;
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

/** Populate the state dropdown from the states the data actually covers. */
function fillStates(rows) {
  const states = new Map();
  for (const row of rows) {
    const code = String(row.st || '').trim();
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
    const { meta, rows } = await loadDeskData(DATA_URL);
    state.allRows = rows;
    const bounds = yearBounds(rows);

    // The year control cannot offer a window the record does not cover.
    el.fromYear.min = String(bounds.min);
    el.fromYear.max = String(bounds.max);
    el.toYear.min = String(bounds.min);
    el.toYear.max = String(bounds.max);

    // The URL wins over the defaults: a shared link is the point.
    state.filters = { ...DEFAULT_FILTERS, ...filtersFromHash(window.location.hash) };
    state.filters.fromYear = clamp(state.filters.fromYear, bounds.min, bounds.max);
    state.filters.toYear = clamp(state.filters.toYear, bounds.min, bounds.max);
    if (state.filters.fromYear > state.filters.toYear) {
      state.filters.fromYear = state.filters.toYear;
    }

    fillStates(rows);
    syncControls();
    render();

    el.loading.remove();
    el.source.textContent =
      `${rows.length.toLocaleString()} counties · ACS ${meta.housingVintage ?? ''} ` +
      `housing units (${meta.housingVariable ?? 'B25001_001E'}) · built ${String(meta.builtAt ?? '').slice(0, 10)}`;
  } catch (error) {
    el.loading.textContent = `Could not load the county data: ${error.message}`;
    el.loading.className = 'loading error';
  }

  el.filters.addEventListener('submit', (event) => event.preventDefault());
  el.filters.addEventListener('change', (event) => {
    const target = event.target;
    if (target === el.state) applyFilters({ state: el.state.value });
    else if (target === el.fromYear) applyFilters({ fromYear: Number(el.fromYear.value) });
    else if (target === el.toYear) applyFilters({ toYear: Number(el.toYear.value) });
    else if (target === el.minHail)
      applyFilters({ minHailTenths: Number(el.minHail.value) });
  });
  el.q.addEventListener('input', () => {
    applyFilters({ q: el.q.value });
  });
  el.export.addEventListener('click', () => {
    downloadCsv(toCsv(state.rows, CSV_COLUMNS), csvFilename(state.filters));
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
    state.filters = { ...DEFAULT_FILTERS, ...filtersFromHash(window.location.hash) };
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

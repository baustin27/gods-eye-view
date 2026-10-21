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
  indexFema,
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
  rankedList,
  renderTable,
  sortRows,
  summarise,
} from './table.js';
import { csvFilename, downloadCsv, toCsv } from './csv.js';

const CITY_DATA_URL = `${import.meta.env.BASE_URL}data/cities.json.gz`;
const COUNTY_DATA_URL = `${import.meta.env.BASE_URL}data/counties.json.gz`;
const SWATH_DATA_URL = `${import.meta.env.BASE_URL}data/swaths.json.gz`;
const FEMA_DATA_URL = `${import.meta.env.BASE_URL}data/fema_damage.json.gz`;

/** The state of the app. Filters live in the URL, so the URL is the state. */
const state = {
  view: 'city',
  filters: { ...DEFAULT_FILTERS },
  rows: [],
  cityIndex: null,
  countyRows: [],
  swathIndex: null,
  femaIndex: null,
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
  stateChips: document.getElementById('stateChips'),
  fromYear: document.getElementById('fromYear'),
  toYear: document.getElementById('toYear'),
  minHail: document.getElementById('minHail'),
  q: document.getElementById('q'),
  summary: document.getElementById('summary'),
  ranked: document.getElementById('ranked'),
  tableWrap: document.getElementById('tableWrap'),
  loading: document.getElementById('loading'),
  source: document.getElementById('source'),
  export: document.getElementById('export'),
  copyLink: document.getElementById('copyLink'),
  views: document.getElementById('views'),
  detail: document.getElementById('detail'),
  drillBody: document.getElementById('drillBody'),
  drillTitle: document.getElementById('drillTitle'),
  drillBack: document.getElementById('drillBack'),
  drillClose: document.getElementById('drillClose'),
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
  renderRankedList();
  rankStateChips(state.rows);
  el.export.disabled = state.rows.length === 0;
  el.drillBack.addEventListener('click', () => popDrill());
  el.drillClose.addEventListener('click', () => {
    drillStack.length = 0;
    renderDrill();
  });
  el.views.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view);
    button.setAttribute(
      'aria-pressed',
      button.dataset.view === state.view ? 'true' : 'false',
    );
  });
}

/** Write the filters into the URL, then repaint. */
/**
 * The ranked list: the places worth the afternoon.
 *
 * A table of 6,496 rows cannot say which towns to drive to. This can, and it
 * is the same shape the globe's county list uses - a short fixed-width lead,
 * the value as a share of the maximum, and the rank.
 */
function renderRankedList() {
  const list = rankedList(state.rows, { view: state.view });
  el.ranked.replaceChildren();
  for (const item of list.items) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'data-row-list-item';
    button.dataset.listItemId = item.id;
    button.setAttribute('aria-pressed', String(Boolean(item.active)));
    if (item.current) button.setAttribute('aria-current', 'step');
    button.title = item.text;
    const lead = document.createElement('span');
    lead.className = 'data-row-list-lead';
    lead.textContent = item.lead;
    const text = document.createElement('span');
    text.className = 'data-row-list-text';
    text.textContent = item.text;
    button.append(lead, text);
    button.addEventListener('click', () => {
      const row = state.rows.find(
        (candidate) => (candidate.id ?? candidate.fips) === item.params.id,
      );
      if (row && state.view === 'city') onCityClick(row);
    });
    li.appendChild(button);
    el.ranked.appendChild(li);
  }
}

function applyFilters(next) {
  state.filters = { ...state.filters, ...next };
  // The drill-down is about a particular place in a particular list. Change the
  // list and it is about nothing, so the stack is emptied rather than left
  // pointing at a row that may not be there any more.
  drillStack.length = 0;
  renderDrill();
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
  syncStateChips();
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
/**
 * The drill-down stack.
 *
 * The desk had THREE panels - the storms, the tracts, the streets - as
 * siblings in the flow, and all three could be open at once. The page grew
 * downwards and the thing you were reading was always below the fold, which
 * is what "hard to control" felt like.
 *
 * There is ONE panel now and a stack behind it. A drill-down REPLACES what
 * was there, and the Back button walks back up - the same shape as the
 * globe's panels, where one thing is on screen at a time.
 */
const drillStack = [];

/**
 * Put a view on the drill panel, or take it off.
 *
 * @param {{title: string, render: (panel: HTMLElement) => void}|null} view
 */
function pushDrill(view) {
  drillStack.push(view);
  renderDrill();
}

/** Step back up the stack. */
function popDrill() {
  drillStack.pop();
  renderDrill();
}

/** Draw the top of the stack, and nothing else. */
function renderDrill() {
  const top = drillStack[drillStack.length - 1];
  el.drillBody.replaceChildren();
  if (!top) {
    el.detail.hidden = true;
    return;
  }
  el.detail.hidden = false;
  el.drillTitle.textContent = top.title;
  el.drillBack.hidden = drillStack.length < 2;
  top.render(el.drillBody);
  el.detail.scrollIntoView({ block: 'nearest' });
}

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
  pushDrill({
    title: `${row.full || row.name}, ${row.st || ''}`,
    render: (panel) => {
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
    ['Tracts', 'The neighbourhoods the radar reached that day.'],
    ['Streets', 'The street list for the ZIP under the hail.'],
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
    const values = [
      storm.d,
      storm.n1.toLocaleString(),
      storm.n15.toLocaleString(),
      storm.n2.toLocaleString(),
      `${storm.max.toFixed(2)}"`,
      storm.wind.toLocaleString(),
      swath ? swath.houses.toLocaleString() : '—',
      swath && !storm.reported ? 'nobody called it in' : '',
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      tr.appendChild(cell);
    }
    // The knock list. The street service is a SEPARATE thing from this app -
    // it is a server, not a file - so the button asks for it and shows what
    // comes back, and says so if the county is not the one you think.
    //
    // TWO cells for TWO columns. They were one cell, so the row was a cell
    // short: the Streets column had no cell at all and both buttons landed
    // under the Tracts header.
    const tractCell = document.createElement('td');
    const streetCell = document.createElement('td');
    if (swath && swath.state && swath.county) {
      // The neighbourhoods first, then the streets. A canvasser works in a
      // tract, and the tract is the level the radar is meaningful at.
      const tractButton = document.createElement('button');
      tractButton.type = 'button';
      tractButton.className = 'link-button';
      tractButton.textContent = 'tracts';
      tractButton.addEventListener('click', () =>
        showTracts(swath.list || [], storm.d),
      );
      tractCell.appendChild(tractButton);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link-button';
      button.textContent = 'streets';
      button.addEventListener('click', () =>
        showStreets(swath.state, swath.county, storm.d),
      );
      streetCell.appendChild(button);
    }
    tr.append(tractCell, streetCell);
    body.appendChild(tr);
  }
  table.appendChild(body);
  panel.append(summary, table);
    },
  });
}

/**
 * The neighbourhoods the radar reached, for one storm.
 *
 * A town's number says a town was hit. A canvasser works in a neighbourhood,
 * so the tract is the row that decides the afternoon: how many houses are in
 * it, how hard the hail was there, and a link through to the streets inside
 * it.
 */
function showTracts(tracts, day) {
  pushDrill({
    title: `Tracts under the hail on ${day}`,
    render: (panel) => {
  const note = document.createElement('p');
  note.className = 'detail-summary';
  const houses = tracts.reduce((total, tract) => total + tract.units, 0);
  note.textContent =
    `${tracts.length.toLocaleString()} tracts, ` +
    `${houses.toLocaleString()} housing units. ` +
    'A tract the radar reached is a tract to work and every house in it is a ' +
    'candidate: the radar is sound about where hail fell and unsound about ' +
    'how big each stone was. The number is the Census count of HOUSING ' +
    'UNITS, which is not the same as the addresses in the street ranges.';
  panel.append(note);
  if (!tracts.length) {
    return;
  }

  const table = document.createElement('table');
  table.className = 'desk-table storm-table';
  const head = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const [label, title2] of [
    ['Tract', 'The census tract number.'],
    [
      'Houses',
      'The housing units in this tract, from the ACS. Every one of them is ' +
        'a candidate.',
    ],
    [
      'Hail',
      'The largest radar reading inside this tract that day, in inches.',
    ],
    [
      'Cells',
      'The number of 1 km radar cells inside this tract that were over the ' +
        'threshold. How much of the tract the hail covered.',
    ],
    ['Streets', 'The streets inside this tract.'],
  ]) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    th.title = title2;
    hr.appendChild(th);
  }
  head.appendChild(hr);
  table.appendChild(head);
  const body = document.createElement('tbody');
  for (const tract of tracts.slice(0, 300)) {
    const tr = document.createElement('tr');
    for (const value of [
      tract.name,
      tract.units.toLocaleString(),
      `${(tract.maxMm / 25.4).toFixed(2)}"`,
      tract.cells.toLocaleString(),
    ]) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.appendChild(td);
    }
    const streetCell = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link-button';
    button.textContent = 'streets';
    button.addEventListener('click', () =>
      showStreets(
        tract.geoid.slice(0, 2),
        tract.geoid.slice(2, 5),
        day,
        tract.geoid,
      ),
    );
    streetCell.appendChild(button);
    tr.appendChild(streetCell);
    body.appendChild(tr);
  }
  table.appendChild(body);
  panel.append(table);
    },
  });
}

/**
 * The street list for a ZIP, from the Census TIGER files.
 *
 * It comes from a service rather than from this app's data, because the
 * street files are a third of a gigabyte a county and are fetched per county
 * the first time they are asked for. The service is the desk's own server, so
 * it is the same origin and there is nothing to allow.
 *
 * The DAY is what makes the list a work list. Without it the streets come
 * back sorted by how many addresses they carry, which is a list of long
 * streets. With it the service lays the day's 1 km radar field over the
 * streets and says how many of each street's addresses were under the hail.
 *
 * The state parameter is `stateCode` and NOT `state`, because `state` is the
 * module's state object and a parameter of that name shadows it for the whole
 * function. It did, and the shadowing made `state.femaIndex` undefined - so
 * every ZIP came back with no households, the filter that keeps only ZIPs
 * with households kept nothing, and the whole realised-damage table could
 * never render. The globe made the same mistake and fixed it the same way
 * (src/layers/hailwind/index.js:1399).
 */
async function showStreets(stateCode, county, day, tract) {
  const note = document.createElement('p');
  note.className = 'detail-summary';
  note.textContent = 'Loading the Census street list for this ZIP…';
  const query = new URLSearchParams({ state: stateCode, county });
  if (day) query.set('day', day);
  if (tract) query.set('tract', tract);
    let payload = null;
    let failure = null;
    try {
      const response = await fetch(`/api/desk/streets?${query}`);
      payload = await response.json();
      if (!response.ok || payload.error) {
        failure = payload.error || response.status;
      }
    } catch (error) {
      failure = error.message;
      console.error('[desk] street list failed', error);
    }
    const title = tract
      ? `Streets in tract ${tract.slice(5)}, county ${stateCode}${county}`
      : `Streets in county ${stateCode}${county}`;
    pushDrill({
      title,
      render: (panel) => {
        const note = document.createElement('p');
        note.className = 'detail-summary';
        if (failure) {
          note.textContent = `Could not load the street list: ${failure}`;
          panel.append(note);
          return;
        }
        note.textContent = 'Loading the Census street list for this ZIP…';
      // The realised damage, by ZIP, for the ZIPs in this county.
        const byZip = new Map();
      for (const street of payload.streets) {
        let entry = byZip.get(street.zip);
        if (!entry) {
          // Optional, because the damage file is a separate download and the
          // street list must still work when it is not there. A missing index
          // is an absence, not a crash.
          const fema = state.femaIndex?.get(String(street.zip));
          entry = {
            zip: street.zip,
            segments: 0,
            addresses: 0,
            underHail: 0,
            households: fema?.households ?? 0,
            damage: fema?.damage ?? 0,
            approved: fema?.approved ?? 0,
          };
          byZip.set(street.zip, entry);
        }
        entry.segments += 1;
        entry.addresses += street.addresses || 0;
        entry.underHail += street.underHail || 0;
      }
      const zips = byZip.size;
      note.textContent =
        `${payload.count.toLocaleString()} street segments across ` +
        `${zips} ZIPs, ${payload.addresses.toLocaleString()} addresses in the ` +
        `ranges. ` +
        'A range is the stretch of the street the Census edge covers, which can ' +
        'be more than one block, and the number is ADDRESSES in it - the count ' +
        'of HOUSES in a ZIP comes from the Census, and the two are never added ' +
        'together.';
      // The hail on the day, when the service was asked about a day.
      if (payload.hail) {
        const hailNote = document.createElement('p');
        hailNote.className = 'detail-summary';
        if (!payload.hail.found) {
          hailNote.textContent =
            `There is no 1 km radar field for ${payload.hail.day} - the fine ` +
            'field starts on 2024-01-01 - so this list cannot be ranked by what ' +
            'fell.';
        } else {
          const underStreets = payload.streets.filter(
            (street) => street.underHail > 0,
          ).length;
          hailNote.textContent =
            `Under the hail on ${payload.hail.day}: ` +
            `${payload.underHail.toLocaleString()} of ` +
            `${payload.addresses.toLocaleString()} addresses, over ` +
            `${underStreets.toLocaleString()} street segments. ` +
            `The threshold is ${(payload.hail.thresholdMm / 25.4).toFixed(2)} ` +
            'inches, the largest reading that day was ' +
            `${(payload.hail.maxMm / 25.4).toFixed(2)} inches, and the field ` +
            `reached ${payload.hail.cells.toLocaleString()} cells over it. ` +
            'A street is a LINE and a hail cell is an AREA, so each street is ' +
            'measured by the share of its length that was under the hail, and ' +
            'that share is applied to the addresses in its range. It is not a ' +
            'claim that those roofs were damaged - it is the number of ' +
            'addresses on a street that were UNDER hail on a day.';
          panel.append(hailNote);
        }
      }
      // Inside a tract, the numbers are the tract's own.
      if (payload.tract) {
        const tractNote = document.createElement('p');
        tractNote.className = 'detail-summary';
        const centred = payload.cellsCentred ?? 0;
        if (payload.underHailInTract > 0) {
          tractNote.textContent =
            `In tract ${payload.tract.name}: ` +
            `${payload.underHailInTract.toLocaleString()} of ` +
            `${payload.addressesInTract.toLocaleString()} addresses were under ` +
            `the hail, over ${payload.count.toLocaleString()} street segments. ` +
            'A street on a tract boundary is in both tracts, for different parts ' +
            'of itself, so the two columns are measured against the tract: the ' +
            'addresses on the part of the street that is inside it, and how many ' +
            'of those were under the hail.';
        } else {
          // The hail reached the tract but no street inside it lies under a cell
          // that was over the threshold. The tract list counts a cell that
          // only clips the tract's CORNER as reaching it, so a tract can be a
          // candidate with no street under the hail in it. Saying so is better
          // than showing a column of zeroes and letting it look like a bug.
          tractNote.textContent =
            `In tract ${payload.tract.name}: no street inside it lies under a ` +
            'cell that was over the threshold. ' +
            (centred > 0
              ? `${centred} of the day's hail cells are centred inside the ` +
                'tract, so the hail fell on ground with no street on it. '
              : 'The radar reached the tract at its edge rather than over its ' +
                'streets, because a cell that clips a corner counts as ' +
                'reaching it. ') +
            'The tract is on the work list and its houses are candidates all ' +
            'the same: work the streets nearest the hail.';
        }
        panel.append(tractNote);
      }
      // The damage table first: the street list is the navigation, and this is
      // the reason to navigate. Sorted by damage, because a ZIP nobody applied
      // for help in is a ZIP to drive past.
      const damaged = [...byZip.values()].sort((a, b) => b.damage - a.damage);
      const withDamage = damaged.filter((zip) => zip.households > 0);
      if (withDamage.length) {
        const zipTable = document.createElement('table');
        zipTable.className = 'desk-table storm-table';
        const zh = document.createElement('thead');
        const zhr = document.createElement('tr');
        for (const label of [
          'ZIP',
          'Households helped',
          'Damage reported',
          'Approved',
          'Street segments',
          ...(payload.hail ? ['Addresses under the hail'] : []),
        ]) {
          const th = document.createElement('th');
          th.scope = 'col';
          th.textContent = label;
          zhr.appendChild(th);
        }
        zh.appendChild(zhr);
        zipTable.appendChild(zh);
        const zbody = document.createElement('tbody');
        for (const zip of withDamage.slice(0, 60)) {
          const tr = document.createElement('tr');
          for (const value of [
            zip.zip,
            zip.households.toLocaleString(),
            `$${zip.damage.toLocaleString()}`,
            `$${zip.approved.toLocaleString()}`,
            zip.segments.toLocaleString(),
            ...(payload.hail ? [zip.underHail.toLocaleString()] : []),
          ]) {
            const td = document.createElement('td');
            td.textContent = String(value);
            tr.appendChild(td);
          }
          zbody.appendChild(tr);
        }
        zipTable.appendChild(zbody);
        const caption = document.createElement('p');
        caption.className = 'detail-summary';
        caption.textContent =
          'Realised damage, from FEMA Individual Assistance registrations - ' +
          'households that applied for help, the damage they reported and what ' +
          'they were approved. It is a FLOOR: most people with hail damage ' +
          'never apply for anything.';
        panel.append(caption, zipTable);
      }

      const table = document.createElement('table');
      table.className = 'desk-table storm-table';
      const head = document.createElement('thead');
      const hr = document.createElement('tr');
      // Inside a tract the two numbers are the tract's own: the addresses on the
      // street that are inside the tract, and how many of those were under the
      // hail. Outside one they are the county's.
      const hailColumns = payload.tract
        ? ['In the tract', 'Under the hail']
        : payload.hail
          ? ['Under the hail', 'Share']
          : [];
      for (const label of [
        'Street',
        'ZIP',
        'From',
        'To',
        'Side',
        'Addresses',
        ...hailColumns,
      ]) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = label;
        hr.appendChild(th);
      }
      head.appendChild(hr);
      table.appendChild(head);
      const body = document.createElement('tbody');
      for (const street of payload.streets.slice(0, 400)) {
        const tr = document.createElement('tr');
        for (const value of [
          street.name,
          street.zip,
          street.from,
          street.to,
          street.side === 'L' ? 'left' : 'right',
          street.addresses.toLocaleString(),
          ...(payload.tract
            ? [
                street.addressesInTract.toLocaleString(),
                street.underHailInTract.toLocaleString(),
              ]
            : payload.hail
              ? [
                  street.underHail.toLocaleString(),
                  `${Math.round((street.hailShare || 0) * 100)}%`,
                ]
              : []),
        ]) {
          const td = document.createElement('td');
          td.textContent = String(value);
          tr.appendChild(td);
        }
        body.appendChild(tr);
      }
      table.appendChild(body);
      panel.appendChild(table);
      },
    });
  }

/** Populate the state dropdown from the states the data actually covers. */
/**
 * The state picker: chips for the biggest markets, and the dropdown kept
 * behind them for the rest.
 *
 * The twelve biggest are the chips, because a chip row of fifty would be a
 * wall, and the wall would be the first thing on the page. The dropdown is
 * still there - it is how the other thirty-eight are reached, and it is
 * hidden from the eye and from the tab order rather than removed, so the
 * form still submits a state and the URL still carries one.
 *
 * @param {Array<object>} rows
 * @param {string} key the column holding the state
 */
function fillStates(rows, key) {
  const states = new Map();
  for (const row of rows) {
    const code = String(row[key] || '').trim();
    if (!code) continue;
    states.set(code, (states.get(code) || 0) + 1);
  }
  const ordered = [...states.entries()].sort((a, b) => b[1] - a[1]);
  for (const [code, count] of ordered) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = `${code} (${count})`;
    el.state.appendChild(option);
  }
  // The chips are re-ranked on every render, by the MARKET and not by the
  // number of places: a state with three thousand places and no hail is not a
  // market, and a chip that ranks it above Colorado is a chip that costs the
  // person a click to undo.
  el.stateChips.replaceChildren();
  for (const [code] of ordered.slice(0, 12)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'data-toggle-chip chip-idle';
    button.dataset.chipId = `state:${code}`;
    button.setAttribute('aria-pressed', 'false');
    button.textContent = code;
    button.addEventListener('click', () => {
      applyFilters({ state: code });
    });
    el.stateChips.appendChild(button);
  }
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'data-toggle-chip chip-idle';
  all.dataset.chipId = 'state:';
  all.setAttribute('aria-pressed', 'false');
  all.textContent = 'ALL';
  all.addEventListener('click', () => applyFilters({ state: '' }));
  el.stateChips.prepend(all);
}

/**
 * Re-rank the state chips by the size of the market, and mark the current one.
 *
 * @param {Array<object>} rows the filtered rows
 */
function rankStateChips(rows) {
  const counts = new Map();
  for (const row of rows || []) {
    const code = String(row.st || '').trim();
    if (!code) continue;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const chips = [...el.stateChips.querySelectorAll('.data-toggle-chip')];
  const wanted = String(state.filters.state || '').toUpperCase();
  const ranked = [];
  for (const chip of chips) {
    const code = String(chip.dataset.chipId || '').replace(/^state:/, '');
    if (!code) {
      ranked.push(chip);
      continue;
    }
    chip.title = `${code} — ${(counts.get(code) || 0).toLocaleString()} places in the market`;
    ranked.push(chip);
  }
  const market = ordered.slice(0, 12).map(([code]) => code);
  const byCode = new Map(
    ranked
      .filter((chip) => chip.dataset.chipId !== 'state:')
      .map((chip) => [
        String(chip.dataset.chipId || '').replace(/^state:/, ''),
        chip,
      ]),
  );
  const all = ranked.find((chip) => chip.dataset.chipId === 'state:');
  const next = [];
  if (all) next.push(all);
  for (const code of market) {
    const chip = byCode.get(code);
    if (chip) next.push(chip);
  }
  // Any state that is not in the top twelve but IS the current one keeps its
  // chip, so a link to it does not lose the control.
  if (wanted && !market.includes(wanted) && byCode.has(wanted)) {
    next.push(byCode.get(wanted));
  }
  for (const chip of ranked) {
    if (!next.includes(chip) && chip !== all) next.push(chip);
  }
  el.stateChips.replaceChildren(...next);
  syncStateChips();
}

function syncStateChips() {
  const wanted = String(state.filters.state || '').toUpperCase();
  for (const chip of el.stateChips.querySelectorAll('.data-toggle-chip')) {
    const code = String(chip.dataset.chipId || '').replace(/^state:/, '');
    const on = code === wanted;
    chip.classList.toggle('chip-active', on);
    chip.classList.toggle('chip-idle', !on);
    chip.setAttribute('aria-pressed', String(on));
  }
}

async function main() {
  try {
    const [
      citiesPayload,
      countiesPayload,
      swathPayload,
      femaPayload,
    ] = await Promise.all([
      loadGzippedJson(CITY_DATA_URL),
      loadGzippedJson(COUNTY_DATA_URL),
      loadGzippedJson(SWATH_DATA_URL),
      loadGzippedJson(FEMA_DATA_URL),
    ]);
    state.cityIndex = indexCities(citiesPayload);
    state.countyRows = countiesPayload.rows || [];
    state.swathIndex = indexSwaths(swathPayload);
    state.femaIndex = indexFema(femaPayload);

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

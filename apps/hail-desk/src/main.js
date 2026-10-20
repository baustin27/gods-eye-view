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
  renderTable,
  sortRows,
  summarise,
  topNames,
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
  el.detail.append(head, summary, table);
  el.detail.scrollIntoView({ block: 'nearest' });
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
  const panel = document.getElementById('tracts');
  panel.hidden = false;
  panel.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = `Tracts under the hail on ${day}`;
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
  panel.append(heading, note);
  if (!tracts.length) {
    panel.append(note);
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
  panel.scrollIntoView({ block: 'nearest' });
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
  const panel = document.getElementById('streets');
  panel.hidden = false;
  panel.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = tract
    ? `Streets in tract ${tract.slice(5)}, county ${stateCode}${county}`
    : `Streets in county ${stateCode}${county}`;
  const note = document.createElement('p');
  note.className = 'detail-summary';
  note.textContent = 'Loading the Census street list for this ZIP…';
  panel.append(heading, note);
  const query = new URLSearchParams({ state: stateCode, county });
  if (day) query.set('day', day);
  if (tract) query.set('tract', tract);
  try {
    const response = await fetch(`/api/desk/streets?${query}`);
    const payload = await response.json();
    if (!response.ok || payload.error) {
      note.textContent = `Could not load the street list: ${payload.error || response.status}`;
      return;
    }
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
  } catch (error) {
    note.textContent = `Could not load the street list: ${error.message}`;
    console.error('[desk] street list failed', error);
  }
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

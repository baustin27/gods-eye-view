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
  STORM_COLUMNS,
  rankedList,
  renderTable,
  sortRows,
  summarise,
} from './table.js';
import { buildStormDays, sortStormDays } from './storms.js';
import { csvFilename, downloadCsv, toCsv } from './csv.js';
import { createMapPane } from './map/map.js';
import { loadFrameBands, loadSwathBands } from './map/swath.js';
import { subDailyFrameTimes } from '../../../src/data/subDailyRadar.js';

const CITY_DATA_URL = `${import.meta.env.BASE_URL}data/cities.json.gz`;
const COUNTY_DATA_URL = `${import.meta.env.BASE_URL}data/counties.json.gz`;
const SWATH_DATA_URL = `${import.meta.env.BASE_URL}data/swaths.json.gz`;
const FEMA_DATA_URL = `${import.meta.env.BASE_URL}data/fema_damage.json.gz`;

/** The state of the app. Filters live in the URL, so the URL is the state. */
const state = {
  // THE STORM LIST IS THE DESK'S CENTRE. A person opens the desk to find the
  // day, not the town: the town is somewhere inside the storm, and the
  // storm is what the map can actually draw.
  view: 'storm',
  filters: { ...DEFAULT_FILTERS },
  rows: [],
  cityIndex: null,
  countyRows: [],
  swathIndex: null,
  femaIndex: null,
  // The raw artifacts, kept for the storm list. The indexes above throw the
  // day rows away into maps keyed by place, and the storm list needs them
  // the other way round: by day.
  cityPayload: null,
  swathPayload: null,
  // The storm days for the state in the filters.
  stormRows: [],
  // The day whose swath the map is showing. It is set when a place is opened -
  // to its biggest storm - and when a storm day is picked.
  mapDay: null,
  mapBands: [],
  // Whether the place dots are drawn. Null means "the view decides": on for
  // the market views, off for the storm view, where the swath is the map.
  dots: null,
  // The day the map is showing, and the row it came from.
  shownDay: null,
  selectedDay: null,
  // Which SIX-HOUR frame of the day is shown: null is the whole day, and
  // 0 to 3 are the windows ending at 06Z, 12Z, 18Z and 00Z.
  frame: null,
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
  storm: [
    { label: 'Date', get: (row) => row.date },
    { label: 'Houses in reach', get: (row) => row.houses ?? '' },
    { label: 'Reports', get: (row) => row.reports || '' },
    { label: 'Reports >= 1 in', get: (row) => row.severe || '' },
    { label: 'Largest stone (in)', get: (row) => row.largest?.toFixed(2) ?? '' },
    { label: 'Places', get: (row) => row.places || '' },
    { label: 'Radar day', get: (row) => row.radarDay },
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
  stateMenu: document.getElementById('stateMenu'),
  mapPane: document.getElementById('mapPane'),
  mapCanvas: document.getElementById('mapCanvas'),
  mapCaption: document.getElementById('mapCaption'),
  mapInfo: document.getElementById('mapInfo'),
  dayChips: document.getElementById('dayChips'),
  frameChips: document.getElementById('frameChips'),
  scopeChips: document.getElementById('scopeChips'),
  dotsToggle: document.getElementById('dotsToggle'),
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
  if (state.view === 'storm') renderStormView();
  else renderMarketView();
  el.export.disabled =
    state.view === 'storm' ? state.stormRows.length === 0 : state.rows.length === 0;
  el.views.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view);
    button.setAttribute(
      'aria-pressed',
      button.dataset.view === state.view ? 'true' : 'false',
    );
  });
  el.dotsToggle.setAttribute('aria-pressed', String(dotsOn()));
  el.dotsToggle.classList.toggle('active', dotsOn());
  drawMap();
}

/** The market views: the places, and the counties. */
function renderMarketView() {
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
  el.scopeChips.hidden = true;
  el.ranked.hidden = false;
  renderRankedList();
  rankStateChips(state.rows);
}

/**
 * THE STORM LIST: the desk's work list.
 *
 * The market table answers "which towns are worth the afternoon". This
 * answers the question a canvasser actually works from - "on which DAYS, and
 * how many roofs were standing under the hail" - and the two spines it is
 * built on are the report days and the radar days, so a storm nobody called
 * in is on the list too.
 */
function renderStormView() {
  const rows = sortStormDays(
    stormDays(),
    state.filters.dsort,
    state.filters.ddir,
  );
  state.stormRows = rows;
  renderTable(
    el.tableWrap,
    rows,
    STORM_COLUMNS,
    { sort: state.filters.dsort, dir: state.filters.ddir },
    onStormSort,
    onStormDayClick,
    (row) => row.date === state.filters.d,
  );
  el.summary.textContent = stormSummary(rows);
  // The scope chips are the storm list's own filter, so they are only
  // meaningful in the storm view.
  el.scopeChips.hidden = false;
  renderScopeChips();
  // The ranked list is the market's list of towns; in the storm view the
  // list beside the map is the list of DAYS, and the days are the table.
  el.ranked.hidden = true;
  renderDayChips();
  // The selected day. A link that carries a day opens on that day; a day
  // that the window has moved out of shows nothing, rather than showing the
  // wrong storm.
  const selected = rows.find((row) => row.date === state.filters.d) || null;
  const dayChanged = state.selectedDay && selected && state.selectedDay.date !== selected.date;
  state.selectedDay = selected;
  if (dayChanged) state.frame = null;
  if (selected) {
    void showStormDay(selected);
  } else if (state.shownDay) {
    // The selected day is gone - the window moved, or the state changed -
    // so the map stops showing a storm that is not in the list any more.
    state.shownDay = null;
    state.mapBands = [];
    state.mapDay = null;
    state.frame = null;
  }
  renderMapInfo(selected);
  renderFrameChips(selected);
}

/**
 * The storm days for the state in the filters, in the year window.
 *
 * The list is built once per state and kept: it is 46,379 place-days and
 * 35,018 swath rows, and a person switching filters should not pay for it
 * again.
 */
let stormDayCache = { key: '', rows: [] };

function stormDays() {
  const key = state.filters.state || '';
  if (stormDayCache.key !== key) {
    stormDayCache = {
      key,
      rows: buildStormDays({
        cities: state.cityPayload,
        swaths: state.swathPayload,
        state: key,
      }),
    };
  }
  const { fromYear, toYear, minHailTenths, dscope } = state.filters;
  return stormDayCache.rows.filter((row) => {
    // The YEAR, not the whole date: '2025-01-18' <= '2025' is FALSE as
    // strings, so comparing the whole date against a bare year silently
    // drops the last year of every window.
    const year = row.date.slice(0, 4);
    if (fromYear && year < String(fromYear)) return false;
    if (toYear && year > String(toYear)) return false;
    // THE SPINE. 'prospect' is the days the radar reached and nobody called
    // the hail in, which is the list the product is for.
    if (dscope === 'prospect' && row.kind !== 'radar') return false;
    if (dscope === 'reported' && row.kind === 'radar') return false;
    // The hail that counts. The same control the market table uses, because
    // it means the same thing there: an inch is cosmetic damage, an inch and
    // a half is a repair.
    const floor = (Number(minHailTenths) || 0) / 10;
    if (floor > 0) {
      const largest = row.largest === null || row.largest === undefined
        ? null
        : row.largest;
      if (largest === null || largest + 1e-9 < floor) return false;
    }
    return true;
  });
}

/**
 * The scope chips: every day, the days somebody called in, the days nobody
 * did.
 */
function renderScopeChips() {
  el.scopeChips.replaceChildren();
  const scopes = [
    { key: 'all', label: 'ALL', title: 'Every storm day: the reports and the radar.' },
    {
      key: 'reported',
      label: 'REPORTED',
      title: 'The days somebody measured a stone inside a town.',
    },
    {
      key: 'prospect',
      label: 'PROSPECT',
      title:
        'The days the radar reached and nobody called the hail in. The hail ' +
        'fell, and the only people who know are the people who did not call ' +
        'it in. This is the lead list.',
    },
  ];
  for (const scope of scopes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scope-chip';
    if ((state.filters.dscope || 'all') === scope.key) button.classList.add('active');
    button.textContent = scope.label;
    button.title = scope.title;
    button.setAttribute('aria-pressed', String((state.filters.dscope || 'all') === scope.key));
    button.addEventListener('click', () => applyFilters({ dscope: scope.key }));
    el.scopeChips.appendChild(button);
  }
}

/** The one line that says what the list holds. */
function stormSummary(rows) {
  if (!rows.length) return 'No storm days match these filters.';
  const withRadar = rows.filter((row) => row.houses !== null).length;
  const houses = rows.reduce((total, row) => total + (row.houses || 0), 0);
  const reports = rows.reduce((total, row) => total + (row.reports || 0), 0);
  return (
    `${rows.length.toLocaleString()} storm days · ` +
    `${withRadar.toLocaleString()} with the radar reaching them · ` +
    `${houses.toLocaleString()} houses in reach · ` +
    `${reports.toLocaleString()} reports filed`
  );
}

/** Sort the storm list, and toggle the direction when it is already sorted. */
function onStormSort(key) {
  const same = state.filters.dsort === key;
  applyFilters({
    dsort: key,
    ddir: same && state.filters.ddir === 'desc' ? 'asc' : 'desc',
  });
}

/**
 * Pick a day.
 *
 * The day goes into the URL, so a storm can be linked to, and the map draws
 * the radar shard that COVERS the day - the one named the day after, because
 * MRMS names a file for the window ENDING at its timestamp.
 */
function onStormDayClick(row) {
  applyFilters({ d: row.date });
  // THE WORK LIST: the tracts the hail fell in, with the houses in them.
  //
  // A day is a row in a table - a fact. A day with its tracts is an
  // afternoon: these are the neighbourhoods, here are the houses, and here
  // is the street list under them. A canvasser works in a tract, and the
  // tract is the level the radar is meaningful at.
  const entry = state.swathIndex.byDay.get(row.radarDay);
  // The radar field is NATIONAL, so the day's tracts are the whole country's
  // - and the desk is about one state. The tract list is scoped to the
  // state's FIPS prefix, which is the same state the list's house counts
  // are scoped to.
  const fips = stateFips();
  const tracts = entry
    ? entry.list.filter((tract) => !fips || tract.geoid.startsWith(fips))
    : [];
  if (tracts.length) showTracts(tracts, row.date, row.radarDay);
}

/**
 * Draw the storm, and fit the map to it.
 *
 * A frame of the day is the same storm six hours at a time. The whole day is
 * the default, because that is what a person wants when they are looking for
 * a storm, and the frames are there because a person who wants to know WHERE
 * it was at four in the afternoon needs to say so.
 */
async function showStormDay(row) {
  const frame = state.frame ?? null;
  const key = `${row.date}:${frame === null ? 'day' : frame}`;
  if (state.shownDay === key && state.mapBands.length) return;
  state.shownDay = key;
  state.mapDay = row.radarDay;
  if (frame === null) {
    state.mapBands = await loadSwathBands(row.radarDay);
  } else {
    const bands = await loadFrameBands(row.radarDay, frame);
    if (bands.length) {
      state.mapBands = bands;
    } else {
      // NO FRAME FOR THIS DAY, so the map keeps the whole day rather than
      // going blank. A day whose frames were never published - the sub-daily
      // archive is a window like every other - still has its day, and a map
      // that empties itself because a finer answer is missing is worse than
      // a map with the coarser one.
      state.frame = null;
      state.mapBands = await loadSwathBands(row.radarDay);
    }
  }
  fitToSwath(state.mapBands);
  drawMap();
  renderMapInfo(row);
  renderFrameChips(row);
}

/**
 * The frame chips: the whole day, and the six-hour windows inside it.
 *
 * The desk had the sub-daily shards and never used them, and a map that says
 * "here is where the hail fell on Tuesday" is a claim about eighteen hours of
 * weather. A storm is an hour of weather.
 */
function renderFrameChips(row) {
  el.frameChips.replaceChildren();
  if (!row) return;
  const times = subDailyFrameTimes(row.radarDay);
  const frames = [
    { key: null, label: 'DAY', title: 'the whole day, every frame together' },
    { key: 0, label: '06Z', title: `the six hours ending ${times[0]}` },
    { key: 1, label: '12Z', title: `the six hours ending ${times[1]}` },
    { key: 2, label: '18Z', title: `the six hours ending ${times[2]}` },
    { key: 3, label: '00Z', title: `the six hours ending ${times[3]}` },
  ];
  for (const frame of frames) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'frame-chip';
    if ((state.frame ?? null) === frame.key) button.classList.add('active');
    button.textContent = frame.label;
    button.title = frame.title;
    button.addEventListener('click', () => {
      state.frame = frame.key;
      void showStormDay(row);
    });
    el.frameChips.appendChild(button);
  }
}

/**
 * Fit the map to the SWATH, not to the places.
 *
 * A storm that fell over open country has no towns in it and is still worth
 * looking at, and the map is the swath now.
 */
function fitToSwath(bands) {
  if (!bands || !bands.length) return;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const band of bands) {
    for (const ring of [band.outer, ...(band.holes || [])]) {
      if (!ring || !ring.length) continue;
      for (const point of ring) {
        // The ring points are {lat, lon} objects, the same shape the swath
        // painter projects.
        const lon = point?.lon;
        const lat = point?.lat;
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    }
  }
  if (!Number.isFinite(west)) return;
  // THE STATE, clipped in.
  //
  // The radar field is NATIONAL, so the swath of a big outbreak runs from
  // the Gulf to the Dakotas - and fitting the map to all of it when the desk
  // is about Colorado leaves the Colorado storm a purple smudge in the
  // middle of the country. The map is fitted to the part of the storm that
  // fell in the market, and to the market itself when the storm was bigger
  // than it.
  const box = stateBox();
  if (box) {
    west = Math.max(west, box.west);
    east = Math.min(east, box.east);
    south = Math.max(south, box.south);
    north = Math.min(north, box.north);
  }
  if (east <= west || north <= south) return;
  // A little air around the storm, so the edge of the hail is not exactly on
  // the edge of the frame.
  const padLon = Math.max(0.05, (east - west) * 0.08);
  const padLat = Math.max(0.05, (north - south) * 0.08);
  createTheMap().fitBounds(
    west - padLon,
    south - padLat,
    east + padLon,
    north + padLat,
  );
}

/**
 * The FIPS prefix of the state in the filters: two digits.
 *
 * The tile routes and the tract GEOIDs are in FIPS, and the desk's filters
 * are in postal codes, and the two have to meet somewhere.
 *
 * @returns {string} the two-digit prefix, or '' for every state
 */
function stateFips() {
  const code = String(state.filters.state || '').toUpperCase();
  if (!code) return '';
  const county = state.countyRows.find((row) => row.st === code);
  if (!county) return '';
  return String(county.fips).slice(0, 2);
}

/**
 * The box around the state in the filters.
 *
 * The counties carry their centroids, so this is a box around the counties
 * rather than the state outline - close enough to frame a storm in, and it
 * is the same data the map already has.
 */
function stateBox() {
  // The codec lower-cases every string option, so the state arrives as 'co'
  // and the counties carry 'CO'. Comparing them as they are finds nothing,
  // and a box of nothing is a box of everywhere.
  const code = String(state.filters.state || '').toUpperCase();
  if (!code) return null;
  const rows = state.countyRows.filter((row) => row.st === code);
  if (!rows.length) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const row of rows) {
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
    if (row.lon < west) west = row.lon;
    if (row.lon > east) east = row.lon;
    if (row.lat < south) south = row.lat;
    if (row.lat > north) north = row.lat;
  }
  if (!Number.isFinite(west)) return null;
  return { west, south, east, north };
}

/**
 * The recent storm days, as chips over the map.
 *
 * The globe's pattern: the open leads are the recent storms, and the ones
 * before them are claims. A chip is one click, and the chips are the same
 * twelve every time, so a person learns where to look.
 */
function renderDayChips() {
  el.dayChips.replaceChildren();
  const days = [...stormDays()].reverse().slice(0, 12);
  for (const row of days) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'day-chip';
    if (row.date === state.filters.d) button.classList.add('active');
    button.textContent = row.date.slice(5);
    button.title =
      row.houses !== null
        ? `${row.date} - ${row.houses.toLocaleString()} houses in reach` +
          (row.reports ? `, ${row.reports} reports` : ', nobody called it in')
        : `${row.date} - reports only, the radar did not reach here`;
    button.addEventListener('click', () => applyFilters({ d: row.date }));
    el.dayChips.appendChild(button);
  }
}

/**
 * The line under the map that says what is on it.
 *
 * It says the day, the reports, the largest stone, the houses in reach, and
 * the day convention - because a person looking at a map of a storm needs to
 * know which clock the day is on before they can believe any of it.
 */
function renderMapInfo(row) {
  if (!row) {
    el.mapInfo.textContent = '';
    return;
  }
  const parts = [row.date];
  parts.push(row.reports ? `${row.reports} reports` : 'no reports filed');
  if (row.largest !== null && row.largest !== undefined) {
    parts.push(`largest ${row.largest.toFixed(2)}"`);
  }
  parts.push(
    row.houses !== null && row.houses !== undefined
      ? `${row.houses.toLocaleString()} houses in reach`
      : 'the 1 km radar did not reach here',
  );
  if (row.radarDay && row.radarDay !== row.date) {
    parts.push(`radar day ${row.radarDay}`);
  }
  el.mapInfo.textContent = parts.join(' · ');
}

/** Whether the place dots are drawn. */
function dotsOn() {
  if (state.dots !== null) return state.dots;
  return state.view !== 'storm';
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

/**
 * The map pane, created once.
 *
 * The places it draws are the FILTERED rows - the same rows the table shows -
 * so the map and the table can never disagree about which places are the
 * market. The dots are sized and coloured by the number of severe reports,
 * which is the column the table is sorted by.
 */
let mapPane = null;

function createTheMap() {
  if (mapPane) return mapPane;
  mapPane = createMapPane({
    canvas: el.mapCanvas,
    // The place dots are a LAYER now, and the storm view leaves them off: the
    // map is the swath, and a dot for every place in a market of thousands is
    // not a map of anything.
    places: () => (dotsOn() ? state.rows : []),
    // The worst severe count in the market, so the dots are sized by RANK and
    // do not all resize every time the list is filtered.
    worstSevere: () =>
      state.rows.reduce(
        (max, row) => Math.max(max, Number(row.severe) || 0),
        0,
      ),
    swath: () => (state.mapBands || []).slice(),
    scope: () => {
      // The street tiles and the tract tiles are a COUNTY's, so the map has
      // to name one.
      //
      // It used to take the county from the market's rows, which is empty in
      // the storm view - so the storm view had no streets and no tracts on
      // it at all - and then it took the biggest county in the state, which
      // is a different place from the one the storm fell in.
      //
      // So: the county the SELECTED STORM fell in, and the biggest county in
      // the state when there is no storm. The codec lower-cases the state,
      // so it is upper-cased here.
      const code = String(state.filters.state || '').toUpperCase();
      if (!code) return {};
      // The tile routes are in FIPS, not in postal codes: the state is two
      // digits and the county is three. The desk was asking for 'CO' and
      // '08031' and the route wanted '08' and '031', so the streets and the
      // tracts were never drawn at all - and a 404 from a tile route is
      // indistinguishable from an empty place.
      const counties = state.countyRows.filter((row) => row.st === code);
      if (!counties.length) return {};
      const stateFips = String(counties[0].fips).slice(0, 2);
      const day = state.shownDay
        ? String(state.shownDay).split(':')[0]
        : null;
      const dayEntry = day ? state.swathIndex.byDay.get(day) : null;
      if (dayEntry && dayEntry.counties.size) {
        let best = null;
        let bestHouses = -1;
        for (const [fips, houses] of dayEntry.counties) {
          // The county has to be IN THE STATE. The radar field is national,
          // so the day's counties are the whole country's, and the biggest
          // of them was in New York while the state on the other half of
          // the path was Colorado.
          if (stateFips && !fips.startsWith(stateFips)) continue;
          if (houses > bestHouses) {
            best = fips;
            bestHouses = houses;
          }
        }
        if (best) return { state: best.slice(0, 2), county: best.slice(2) };
      }
      // The biggest county in the state, which is the one a map of the state
      // is mostly about.
      counties.sort((a, b) => (b.units ?? 0) - (a.units ?? 0));
      const fips = String(counties[0].fips);
      return { state: fips.slice(0, 2), county: fips.slice(2, 5) };
    },
    onPick: (row) => onCityClick(row),
  });
  return mapPane;
}

/**
 * Redraw the map, and say what it is showing.
 */
let mapFittedState = null;

function drawMap() {
  const pane = createTheMap();
  // The map FITS itself to what is being shown, but ONLY when the state
  // changes. Refitting on every render meant that every keystroke in the
  // search box moved the camera, and the camera moving means new tiles, and
  // new tiles means a fetch storm - which is what made the desk feel broken.
  // After this the search filters the map and the list, and the map stays
  // where the person put it.
  const wanted = state.filters.state || '';
  if (mapFittedState !== wanted) {
    pane.fitTo(state.rows);
    mapFittedState = wanted;
  }
  pane.draw();
  if (state.view === 'storm') {
    // The storm view's map is a storm, and the caption says so. "No places to
    // show" was true and useless: the places are in the list, and the map is
    // the hail.
    // The caption is SHORT in the storm view: the map's own attribution runs
    // along the bottom, and a caption long enough to reach it turns two
    // pieces of text into one unreadable line.
    el.mapCaption.textContent = 'drag to pan - wheel to zoom';
    const tagline = document.getElementById('tagline');
    if (tagline) tagline.textContent = 'Storm days';
    return;
  }
  const tagline = document.getElementById('tagline');
  if (tagline) {
    tagline.textContent = state.view === 'city' ? 'Market view' : 'Counties';
  }
  const codes = new Set(
    state.rows.map((row) => String(row.st || '')).filter(Boolean),
  );
  const where = codes.size === 1 ? [...codes][0] : `${codes.size} states`;
  el.mapCaption.textContent = codes.size
    ? `${state.rows.length.toLocaleString()} places in ${where} - ` +
      'drag to pan, wheel to zoom, click a dot'
    : 'no places to show';
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
  renderStateMenu();
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
 * Whether a query is an address rather than a place.
 *
 * A house number and a street name. Not a ZIP (that is a place question),
 * not a street name on its own (there are a hundred Main Streets in a
 * county and the county has to be named).
 *
 * @param {string} query
 * @returns {boolean}
 */
function looksLikeAddress(query) {
  return /^\s*\d+\s+\S/.test(String(query || ''));
}

/**
 * Look an address up and show what fell on it.
 *
 * @param {string} query
 * @returns {Promise<void>}
 */
async function searchAddress(query) {
  const params = new URLSearchParams({ q: query });
  // The place in the query names the county; the state's filter narrows the
  // search when the query does not name one.
  if (state.filters.state) params.set('state', state.filters.state);
  let result = null;
  let failure = null;
  try {
    const response = await fetch(`/api/desk/address?${params}`);
    result = await response.json();
    if (!response.ok || result.error) {
      failure = result.error || response.status;
    }
  } catch (error) {
    failure = error.message;
  }
  if (failure) {
    pushDrill({
      title: 'The address',
      render: (panel) => {
        const note = document.createElement('p');
        note.className = 'detail-summary';
        note.textContent = `The address could not be looked up: ${failure}`;
        panel.append(note);
      },
    });
    return;
  }
  showAddress(result);
}

/**
 * What fell on an address.
 *
 * The panel leads with the day that matters: the hail was over THIS cell on
 * these days. The days the radar reached the TRACT are also here, because
 * the difference between the two is the whole product in the rural case - a
 * tract can be four thousand square kilometres, and the hail can have
 * crossed one cell of it.
 */
function showAddress(result) {
  const address = result.address || {};
  const days = result.days || [];
  const over = days.filter((day) => day.over);
  pushDrill({
    title: address.street
      ? `${address.street}, ${address.zip || ''}`.trim()
      : 'The address',
    render: (panel) => {
      const note = document.createElement('p');
      note.className = 'detail-summary';
      const parts = [];
      if (address.from !== undefined) {
        parts.push(`the house numbers ${address.from} to ${address.to}`);
      }
      if (result.tract) {
        parts.push(`census tract ${result.tract.name || result.tract.geoid}`);
        if (result.tract.units !== null && result.tract.units !== undefined) {
          parts.push(`${result.tract.units.toLocaleString()} housing units`);
        }
      }
      parts.push(
        over.length
          ? `the hail was over this spot on ${over.length} of the days the radar reached the tract`
          : 'the hail never reached this spot on any of the days the radar reached the tract',
      );
      note.textContent = `${parts.join('. ')}.`;
      panel.append(note);

      if (days.length) {
        const table = document.createElement('table');
        table.className = 'desk-table storm-table';
        const head = document.createElement('thead');
        const hr = document.createElement('tr');
        for (const [label, title] of [
          ['Day', 'The day the radar reached the tract.'],
          [
            'Over this spot',
            'Whether the hail was over the kilometre the address is in, and not merely over the tract.',
          ],
          ['Hail', 'The largest reading in the tract that day, in inches.'],
          ['Houses', 'The houses under the hail in the tract.'],
        ]) {
          const th = document.createElement('th');
          th.scope = 'col';
          th.textContent = label;
          th.title = title;
          hr.appendChild(th);
        }
        head.appendChild(hr);
        table.appendChild(head);
        const body = document.createElement('tbody');
        for (const day of days) {
          const tr = document.createElement('tr');
          if (day.over) tr.classList.add('selected');
          for (const value of [
            day.day,
            day.over ? 'YES' : 'no',
            day.maxMm ? `${(day.maxMm / 25.4).toFixed(2)}"` : '—',
            day.houses.toLocaleString(),
          ]) {
            const td = document.createElement('td');
            td.textContent = String(value);
            tr.appendChild(td);
          }
          body.appendChild(tr);
        }
        table.appendChild(body);
        panel.append(table);
      }

      const reports = result.reports || [];
      if (reports.length) {
        const list = document.createElement('p');
        list.className = 'detail-summary';
        list.textContent = `${reports.length} severe reports within five kilometres of the address:`;
        panel.append(list);
        const reportTable = document.createElement('table');
        reportTable.className = 'desk-table storm-table';
        const head = document.createElement('thead');
        const hr = document.createElement('tr');
        for (const [label, title] of [
          ['Date', 'The day the report was filed.'],
          ['Size', 'The reported size, in inches.'],
          ['Away', 'How far the report was from the address, in kilometres.'],
          ['What was reported', 'The report as it was filed.'],
        ]) {
          const th = document.createElement('th');
          th.scope = 'col';
          th.textContent = label;
          th.title = title;
          hr.appendChild(th);
        }
        head.appendChild(hr);
        reportTable.appendChild(head);
        const body = document.createElement('tbody');
        for (const report of reports) {
          const tr = document.createElement('tr');
          for (const value of [
            report.date,
            report.magnitude ? `${(report.magnitude / 100).toFixed(2)}"` : '—',
            `${report.km} km`,
            report.comment,
          ]) {
            const td = document.createElement('td');
            td.textContent = String(value);
            tr.appendChild(td);
          }
          body.appendChild(tr);
        }
        reportTable.appendChild(body);
        panel.append(reportTable);
      }
    },
  });
}

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
  // The pane knows whether a drill-down is open, so the stylesheet can give
  // the panel the room: a drill-down and the table sharing it equally is a
  // table with half a table's height and a panel with half a panel's.
  el.detail.parentElement?.classList.toggle('drilling', Boolean(top));
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

async function onCityClick(row) {
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
  // The map shows the biggest storm in this place, because a map with no
  // swath on it when there is hail to look at is a map of nothing.
  const biggest = storms[0];
  state.mapDay = biggest ? biggest.d : null;
  state.mapBands = state.mapDay
    ? await loadSwathBands(state.mapDay)
    : [];
  // And the map is told. Without this the bands are loaded and nothing
  // redraws, so the map carries on showing the ground.
  drawMap();
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
    // A storm day can be put on the map by clicking it, which is the fastest
    // way to see where that day's hail actually fell.
    tr.className = 'clickable';
    tr.tabIndex = 0;
    tr.title = 'Show this storm on the map';
    const showThisStorm = async () => {
      state.mapDay = storm.d;
      state.mapBands = await loadSwathBands(storm.d);
      drawMap();
    };
    tr.addEventListener('click', showThisStorm);
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void showThisStorm();
      }
    });
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
function showTracts(tracts, day, fieldDay) {
  pushDrill({
    title: `Tracts under the hail on ${day}`,
    render: (panel) => {
  const note = document.createElement('p');
  note.className = 'detail-summary';
  const houses = tracts.reduce(
    (total, tract) => total + (tract.houses ?? tract.units),
    0,
  );
  const units = tracts.reduce((total, tract) => total + tract.units, 0);
  note.textContent =
    `${tracts.length.toLocaleString()} tracts, ` +
    `${houses.toLocaleString()} houses under the hail, out of ` +
    `${units.toLocaleString()} housing units in them. ` +
    'The hail-covered share of each tract is what turns a market into a ' +
    'work list: a tract the radar clipped at one corner is a few houses, ' +
    'not all of them. The radar is sound about where hail fell and unsound ' +
    'about how big each stone was. The street list under a tract is the ' +
    'precise version of this number, and the address count in it is not the ' +
    'same as a count of houses.';
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
      'The houses that were UNDER THE HAIL in this tract: the share of the ' +
        'tract the 1 km field covered, times the units in it. This is the ' +
        'number to work.',
    ],
    [
      'Share',
      'The share of the tract the hail covered. A rural tract the hail ' +
        'clipped at one corner is a small share and a small number of ' +
        'houses, and that is the point: the work list is a list of places ' +
        'the hail actually reached.',
    ],
    [
      'Units',
      'Every housing unit in the tract, from the ACS. The market, not a ' +
        'claim.',
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
      (tract.houses ?? tract.units).toLocaleString(),
      `${Math.round((tract.share ?? 0) * 100)}%`,
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
        // The RADAR day, not the report day. The street service lays the
        // day's 1 km field over the streets, and the field for a report day
        // is named the day after - so asking for the report day laid a
        // DIFFERENT storm's field over the streets and found no hail under
        // them at all.
        fieldDay || day,
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
let stateNames = [];

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
  // The states' NAMES, so a query can name a state and not only its code.
  stateNames = [];
  for (const city of state.cityIndex.cities) {
    const code = String(city.st || '').trim();
    const name = String(city.state || '').trim();
    if (code && name && !stateNames.some(([st]) => st === code)) {
      stateNames.push([code, name]);
    }
  }
  // The chips are re-ranked on every render, by the MARKET and not by the
  // number of places: a state with three thousand places and no hail is not a
  // market, and a chip that ranks it above Colorado is a chip that costs the
  // person a click to undo.
  el.stateChips.replaceChildren();
  // A chip for EVERY state, not just the biggest twelve: the row decides
  // which ones to SHOW, and a state that is current but not in the top
  // twelve has to have a chip to keep - otherwise the rule that keeps it
  // cannot fire, because the chip was never made.
  for (const [code] of ordered) {
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

  // The chips are the twelve biggest markets, and a chip row of fifty would
  // be a wall. So the rest are behind a chip that opens them - because a
  // dropdown that is HIDDEN is a state nobody can reach, and Colorado is not
  // in the top twelve on hail alone.
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'data-toggle-chip chip-idle';
  more.dataset.chipId = 'state:more';
  more.setAttribute('aria-pressed', 'false');
  more.textContent = 'MORE';
  more.addEventListener('click', () => {
    const open = el.stateMenu.hidden;
    el.stateMenu.hidden = !open;
    more.classList.toggle('chip-active', open);
    more.setAttribute('aria-pressed', String(open));
    renderStateMenu();
  });
  el.stateChips.appendChild(more);
}

/**
 * The states the chips do not show.
 *
 * Built fresh each time it opens, because the list is the states in the
 * CURRENT market and the market changes with the filters.
 */
function renderStateMenu() {
  const menu = el.stateMenu;
  if (!menu || menu.hidden) return;
  const counts = stateMarketCounts();
  const shown = new Set(
    [...el.stateChips.querySelectorAll('.data-toggle-chip')]
      .map((chip) => String(chip.dataset.chipId || '').replace(/^state:/, '')),
  );
  menu.replaceChildren();
  for (const [code, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (shown.has(code)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'data-toggle-chip chip-idle';
    button.textContent = code;
    button.title = `${count.toLocaleString()} places in the market`;
    button.addEventListener('click', () => {
      menu.hidden = true;
      applyFilters({ state: code });
    });
    menu.appendChild(button);
  }
  if (!menu.children.length) {
    const empty = document.createElement('span');
    empty.className = 'state-menu-empty';
    empty.textContent = 'every state in the market is a chip';
    menu.appendChild(empty);
  }
}

/**
 * Re-rank the state chips by the size of the market, and mark the current one.
 *
 * @param {Array<object>} rows the filtered rows
 */
/**
 * The state a query names, if it names one.
 *
 * "Typing Colorado" is a reasonable thing for a person to do and it has to
 * do SOMETHING, because the box says "place or state". A query that is a
 * state's code, or the whole of its name, filters to that state - and the
 * place search carries on inside it.
 *
 * @param {string} query
 * @returns {string} the two-letter code, or ''
 */
function stateForQuery(query) {
  const text = String(query || '').trim();
  if (!text) return '';
  const code = text.toUpperCase();
  const counts = stateMarketCounts();
  if (counts.has(code)) return code;
  for (const [st, name] of stateNames) {
    if (name.toLowerCase() === text.toLowerCase()) return st;
    if (name.toLowerCase().startsWith(text.toLowerCase()) && text.length >= 3) {
      return st;
    }
  }
  return '';
}

/**
 * The market in each state, for the chip row.
 *
 * The counts are of the WHOLE market - the places that pass the year window
 * and the hail floor - and NOT of the filtered one. The chip row is a way of
 * CHOOSING a state, so a row ranked by the state that is already selected is
 * a row of one, and the other forty-nine become unreachable.
 *
 * Cached, because counting the market is a scan of every place and the chips
 * are rebuilt on every render - but the count only changes when the year
 * window or the hail floor does.
 */
let marketCounts = null;
let marketCountsKey = '';

function stateMarketCounts() {
  const key = [
    state.filters.fromYear,
    state.filters.toYear,
    state.filters.minHailTenths,
  ].join('|');
  if (marketCounts && marketCountsKey === key) return marketCounts;
  const counts = new Map();
  const floor = state.filters.minHailTenths || 0;
  for (const city of state.cityIndex.cities) {
    const rows = state.cityIndex.byYear.get(city.id);
    if (!rows || !rows.length) continue;
    let years = 0;
    let max = 0;
    for (const row of rows) {
      if (row.y < state.filters.fromYear || row.y > state.filters.toYear) continue;
      years += 1;
      if (row.max > max) max = row.max;
    }
    if (!years) continue;
    if (floor && max * 10 < floor) continue;
    const code = String(city.st || '').trim();
    if (!code) continue;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  marketCounts = counts;
  marketCountsKey = key;
  return counts;
}

function rankStateChips(rows) {
  const counts = stateMarketCounts();
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
  // A state that is not in the top twelve but IS the current one keeps its
  // chip, so a link to it does not lose the control. ONLY that one - the rest
  // are behind the MORE chip, because a row of fifty chips is a wall and the
  // point of the row is that it is readable.
  if (wanted && !market.includes(wanted) && byCode.has(wanted)) {
    next.push(byCode.get(wanted));
  }
  // The MORE chip is always last.
  const more = ranked.find((chip) => chip.dataset.chipId === 'state:more');
  if (more) next.push(more);
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
    // The raw artifacts, for the storm list. The indexes above keep the day
    // rows keyed by place; the storm list needs them keyed by day.
    state.cityPayload = citiesPayload;
    state.swathPayload = swathPayload;

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
    // The view, from the link. A link that names a market view opens on it.
    if (['storm', 'city', 'county'].includes(state.filters.view)) {
      state.view = state.filters.view;
    } else {
      state.filters.view = state.view;
    }

    fillStates(state.cityIndex.cities, 'st');
    syncControls();
    render();
    // OPEN ON A STORM.
    //
    // The desk's whole argument is that the storm is the map, and a desk
    // that opens on a list of dates and an empty map of the state is making
    // that argument badly. The day it opens on is the most recent one the
    // radar actually reached - a day with reports and no radar reach has no
    // storm to draw, and opening on it would show the same empty map.
    //
    // The day goes into the URL, so the link a person copies carries the
    // storm they were looking at.
    if (state.view === 'storm' && !state.filters.d) {
      // The list comes out in DATE ORDER, oldest first, so the newest day
      // with a radar reach is the LAST one and not the first.
      const withRadar = stormDays().filter((row) => row.houses !== null);
      if (withRadar.length) {
        applyFilters({ d: withRadar[withRadar.length - 1].date });
      }
    }

    createTheMap();
  drawMap();
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
  // The search is DEBOUNCED, and it has to be. Every keystroke re-rendered
  // the table, rebuilt the chip row and refitted the map, and the map moving
  // means new tiles, and new tiles means the desk was unusable while you
  // typed. A hundred and fifty milliseconds is below the threshold where a
  // person notices the wait and above the threshold where it matters.
  let searchTimer = null;
  el.q.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      const value = el.q.value;
      // AN ADDRESS is a different kind of query: a house number and a street
      // is not a place, and the answer is not a filtered list but the storms
      // that were over that spot.
      //
      // It is checked FIRST, because an address often names a city and the
      // city name contains a state name - "123 Main St, Colorado Springs"
      // is an address, and a state filter would have swallowed it and
      // cleared the box.
      if (looksLikeAddress(value)) {
        void searchAddress(value);
        return;
      }
      // A query that names a state filters to that state, and the place
      // search carries on inside it.
      const named = stateForQuery(value);
      if (named) {
        applyFilters({ state: named, q: '' });
        el.q.value = '';
        return;
      }
      applyFilters({ q: value });
    }, 150);
  });
  el.views.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (!button) return;
    const view = button.dataset.view;
    if (view === state.view) return;
    state.view = view;
    // The sort key is per-view, so switching views resets it to that view's
    // best column rather than leaving a column that does not exist. The
    // storm list's default is the storm IN TIME, newest first, which is the
    // globe's order and the order a canvasser works in.
    const next =
      view === 'storm'
        ? { dsort: 'date', ddir: 'desc' }
        : { sort: view === 'city' ? 'severe' : 'score', dir: 'desc' };
    applyFilters({ view, ...next });
  });
  // The drill panel's buttons. These used to be wired inside every render,
  // so after a hundred renders the Back button fired a hundred times.
  el.drillBack.addEventListener('click', () => popDrill());
  el.drillClose.addEventListener('click', () => {
    drillStack.length = 0;
    renderDrill();
  });
  el.dotsToggle.addEventListener('click', () => {
    state.dots = !dotsOn();
    el.dotsToggle.setAttribute('aria-pressed', String(dotsOn()));
    el.dotsToggle.classList.toggle('active', dotsOn());
    drawMap();
  });
  el.export.addEventListener('click', () => {
    const rows = state.view === 'storm' ? state.stormRows : state.rows;
    downloadCsv(
      toCsv(rows, CSV_COLUMNS[state.view]),
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

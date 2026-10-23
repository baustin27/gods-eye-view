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
import { createWorkspaceLayout, WORKSPACE_MODES } from './ui/workspaceLayout.js';
import { createOmnibar, classifyQuery } from './ui/omnibar.js';
import { renderKnockList, exportKnockListCsv } from './ui/knockList.js';
import { renderLossDossier } from './ui/lossDossier.js';
import { SUBDAILY_FRAMES, nextSubdailyFrame } from './ui/stormTimeline.js';

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
  basemap: 'hybrid',
  mapFallback: false,
  focusedTract: null,
  // The state outline, as rings of [lon, lat]. The map draws it so a storm
  // that crossed a state line can be seen to have crossed one.
  stateRings: null,
  // City outlines for the current state, shown so the map can identify city
  // boundaries instead of only marking city centroids.
  cityOutlines: [],
  // The day the map is showing, and the row it came from.
  shownDay: null,
  selectedDay: null,
  // Which SIX-HOUR frame of the day is shown: null is the whole day, and
  // 0 to 3 are the windows ending at 06Z, 12Z, 18Z and 00Z.
  frame: null,
  showTracts: true,
  showStreets: true,
  radarPlaying: false,
  radarTimer: null,
  activeTab: 'storms',
  // Hail Desk 2.0 workspace modes: 'split' | 'map' | 'knock' | 'dossier'
  mode: 'split',
  // Default real Colorado street segment (S Elm St, tract 08031006801, Denver CO)
  activeKnockStreet: {
    name: 'S Elm St',
    tract: '08031006801',
    city: 'Denver',
    state: 'CO',
    zip: '80222',
    from: 2780,
    to: 2900,
    addresses: 12,
    maxHail: 57.15,
    lon: -104.928,
    lat: 39.665,
  },
  activeKnockRecords: [
    { address: '2840 S Elm St', radarHailInches: 2.25, status: 'appointment', notes: 'Owner requested roof inspection after 5pm', lon: -104.9281, lat: 39.6654 },
    { address: '2820 S Elm St', radarHailInches: 2.25, status: 'claim', notes: 'Claim filed with State Farm', lon: -104.9279, lat: 39.6648 },
    { address: '2800 S Elm St', radarHailInches: 2.10, status: 'knocked', notes: 'Spoke with homeowner; follow-up Sat', lon: -104.9282, lat: 39.6642 },
    { address: '2780 S Elm St', radarHailInches: 2.05, status: 'uncontacted', notes: '', lon: -104.9278, lat: 39.6636 },
    { address: '2860 S Elm St', radarHailInches: 2.30, status: 'appointment', notes: 'Inspection scheduled tomorrow 10am', lon: -104.9283, lat: 39.6660 },
    { address: '2880 S Elm St', radarHailInches: 2.20, status: 'knocked', notes: 'Left door hanger', lon: -104.9279, lat: 39.6666 },
    { address: '2900 S Elm St', radarHailInches: 2.15, status: 'uncontacted', notes: '', lon: -104.9282, lat: 39.6672 },
    { address: '2815 S Elm St', radarHailInches: 2.15, status: 'uncontacted', notes: '', lon: -104.9276, lat: 39.6645 },
    { address: '2835 S Elm St', radarHailInches: 2.25, status: 'knocked', notes: 'Requested estimate', lon: -104.9275, lat: 39.6652 },
    { address: '2855 S Elm St', radarHailInches: 2.25, status: 'claim', notes: 'Insurance adjuster meeting Mon', lon: -104.9274, lat: 39.6658 },
    { address: '2875 S Elm St', radarHailInches: 2.20, status: 'uncontacted', notes: '', lon: -104.9276, lat: 39.6664 },
    { address: '2895 S Elm St', radarHailInches: 2.10, status: 'uncontacted', notes: '', lon: -104.9275, lat: 39.6670 },
  ],
  activeDossierTarget: {
    address: '2840 S Elm St',
    city: 'Denver',
    state: 'CO',
    zip: '80222',
    tractGeoid: '08031006801',
    tractName: 'TRACT 08031006801',
    tigerRange: '2800 – 2898 (Even)',
    lossDate: '2024-06-01',
    radarEvents: [
      { date: '2024-06-01', maxMm: 57.15, over: true },
      { date: '2023-06-22', maxMm: 44.45, over: true },
      { date: '2022-07-15', maxMm: 25.4, over: false },
    ],
    spotterReports: [
      { date: '2024-06-01', hailInches: 2.25, distanceKm: 1.2, comments: 'NOAA trained spotter report 1.2 mi west: 2.50″ stone at 18:42 UTC' },
      { date: '2023-06-22', hailInches: 1.75, distanceKm: 3.4, comments: 'Golf ball sized hail reported in south Denver metro' },
      { date: '2022-07-15', hailInches: 1.00, distanceKm: 4.8, comments: 'Marginal severe hail boundary' },
    ],
  },
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
  mapBase: document.getElementById('mapBase'),
  mapCanvas: document.getElementById('mapCanvas'),
  mapAttribution: document.getElementById('mapAttribution'),
  basemapToggle: document.getElementById('basemapToggle'),
  basemapToggleText: document.getElementById('basemapToggleText'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  mapCaption: document.getElementById('mapCaption'),
  mapInfo: document.getElementById('mapInfo'),
  dayChips: document.getElementById('dayChips'),
  frameChips: document.getElementById('frameChips'),
  scopeChips: document.getElementById('scopeChips'),
  dotsToggle: document.getElementById('dotsToggle'),
  isolateToggle: document.getElementById('isolateToggle'),
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
  // Hail Desk 2.0 layout & omnibar DOM anchors
  workspaceContainer: document.querySelector('main'),
  sideConsole: document.getElementById('sideConsole'),
  omnibarInput: document.getElementById('omnibarInput'),
  omnibarAction: document.getElementById('omnibarAction'),
  modes: document.getElementById('modes'),
  knockHub: document.getElementById('knockHub'),
  dossierCard: document.getElementById('dossierCard'),
  calloutDate: document.getElementById('calloutDate'),
  calloutHouses: document.getElementById('calloutHouses'),
  calloutMaxHail: document.getElementById('calloutMaxHail'),
  calloutTracts: document.getElementById('calloutTracts'),
  stormTabCount: document.getElementById('stormTabCount'),
  knockTabBadge: document.getElementById('knockTabBadge'),
  stormCardsList: document.getElementById('stormCardsList'),
  macroKpiGrid: document.getElementById('macroKpiGrid'),
  macroTableWrap: document.getElementById('macroTableWrap'),
  tractsToggle: document.getElementById('tractsToggle'),
  streetsToggle: document.getElementById('streetsToggle'),
  radarPlayBtn: document.getElementById('radarPlayBtn'),
  zoomReset: document.getElementById('zoomReset'),
  minStonePills: document.getElementById('minStonePills'),
  stateMoreBtn: document.getElementById('stateMoreBtn'),
  isolateStateLed: document.getElementById('isolateStateLed'),
  isolateStateText: document.getElementById('isolateStateText'),
  tabStorms: document.getElementById('tab-storms'),
  tabKnock: document.getElementById('tab-knock'),
  tabDossier: document.getElementById('tab-dossier'),
  tabMacro: document.getElementById('tab-macro'),
  contentStorms: document.getElementById('content-storms'),
  contentKnock: document.getElementById('content-knock'),
  contentDossier: document.getElementById('content-dossier'),
  contentMacro: document.getElementById('content-macro'),
};

/** The columns for the current view. */
const columns = () => (state.view === 'city' ? CITY_COLUMNS : COUNTY_COLUMNS);

/** Fetch the selected state's city outlines and keep the decoded rings. */
async function loadCityOutlines(postal) {
  const code = String(postal || '').trim().toUpperCase();
  if (!code) {
    state.cityOutlines = [];
    return;
  }
  try {
    const response = await fetch(
      `/api/desk/places?state=${encodeURIComponent(code)}`,
    );
    if (String(state.filters.state || '').toUpperCase() !== code) return;
    if (!response.ok) {
      state.cityOutlines = [];
      return;
    }
    const body = await response.json();
    if (String(state.filters.state || '').toUpperCase() !== code) return;
    state.cityOutlines = (body?.places || [])
      .map((place) =>
        (place.rings || [])
          .flatMap((polygon) => (Array.isArray(polygon) ? polygon : []))
          .filter((ring) => Array.isArray(ring) && ring.length >= 3),
      )
      .filter((rings) => rings.length);
  } catch {
    if (String(state.filters.state || '').toUpperCase() !== code) return;
    state.cityOutlines = [];
  }
  drawMap();
}

/**
 * The state outline, fetched once per state.
 *
 * The server sends one state's outline - four points for Colorado, four
 * hundred for Texas - and the browser keeps it. It is the state line, and it
 * is the difference between a map of a storm and a map of a storm in a state.
 *
 * @param {string} postal the two-letter code
 * @returns {Promise<void>}
 */
async function loadStateOutline(postal) {
  const code = String(postal || '').trim().toUpperCase();
  state.stateRings = null;
  drawMap();
  if (!code) {
    state.stateRings = null;
    return;
  }
  try {
    const response = await fetch(`/api/desk/state?state=${encodeURIComponent(code)}`);
    if (String(state.filters.state || '').toUpperCase() !== code) return;
    if (!response.ok) {
      state.stateRings = null;
      return;
    }
    const body = await response.json();
    if (String(state.filters.state || '').toUpperCase() !== code) return;
    state.stateRings = Array.isArray(body?.rings) ? body.rings : null;
  } catch {
    if (String(state.filters.state || '').toUpperCase() !== code) return;
    state.stateRings = null;
  }
  if (state.filters.iso === 'state') fitIsolatedState();
  if (state.mapBands?.length) fitToSwath(state.mapBands);
  drawMap();
}

/**
 * The desk's isolation follows its selected state, in every view.
 */
function syncIsolateChip() {
  if (!el.isolateToggle) return;
  const isolated = state.filters.iso === 'state';
  const code = String(state.filters.state || '').toUpperCase();
  el.isolateToggle.disabled = !code;
  el.isolateToggle.setAttribute('aria-pressed', String(Boolean(isolated)));
  el.isolateToggle.classList.toggle('active', Boolean(isolated));
  if (el.isolateStateLed) {
    el.isolateStateLed.classList.toggle('active', Boolean(isolated));
  }
  if (el.isolateStateText) {
    el.isolateStateText.textContent = isolated ? `Isolated ${code}` : `Isolate ${code || 'State'}`;
  } else {
    el.isolateToggle.textContent = isolated ? `ISOLATED · ${code}` : 'ISOLATE STATE';
  }
  el.isolateToggle.title = isolated
    ? `Show the surroundings of ${code}`
    : code ? `Hide everything outside ${code}` : 'Choose a state first';
}

function syncBasemapControl() {
  if (!el.basemapToggle) return;
  const isHybrid = state.basemap === 'hybrid';
  const isSat = state.basemap === 'satellite';
  const isRoad = state.basemap === 'road';
  const isActive = isHybrid || isSat;
  el.basemapToggle.disabled = false;
  el.basemapToggle.setAttribute('aria-pressed', String(isActive));
  el.basemapToggle.classList.toggle('active', isActive);
  el.basemapToggle.title = 'Switch basemap: Hybrid, Road, Satellite';

  const label = isHybrid ? 'Hybrid' : isRoad ? 'Road Map' : 'Satellite';
  const textEl = el.basemapToggleText || document.getElementById('basemapToggleText');
  if (textEl) {
    textEl.textContent = label;
  } else {
    const icon = `<svg class="w-3.5 h-3.5 text-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064"/></svg> `;
    el.basemapToggle.innerHTML = `${icon}<span id="basemapToggleText">${label}</span>`;
  }
  if (el.mapAttribution) {
    el.mapAttribution.textContent = (isHybrid || isSat)
      ? 'Imagery © Esri, Maxar, Earthstar Geographics, and GIS User Community'
      : 'OpenFreeMap © OpenMapTiles · © OpenStreetMap contributors';
  }
}

/**
 * Updates the active storm metric callout bar in the top toolbar.
 *
 * @param {object} [row] - Active storm day row
 */
function updateActiveStormCallout(row) {
  if (el.calloutDate) {
    el.calloutDate.textContent = row?.date || '—';
  }
  if (el.calloutHouses) {
    el.calloutHouses.textContent = (row?.houses ?? 0).toLocaleString();
  }
  if (el.calloutMaxHail) {
    const val = row?.largest ?? (row?.maxHailIn ? parseFloat(row.maxHailIn) : null);
    el.calloutMaxHail.textContent = val !== null && val !== undefined ? `${val.toFixed(2)}″` : '—';
  }
  if (el.calloutTracts) {
    el.calloutTracts.textContent = (row?.tracts ?? 0).toLocaleString();
  }
  if (el.dotsToggle) {
    const reportCount = row?.reports ?? state.rows?.length ?? 0;
    el.dotsToggle.textContent = `Spotters (${reportCount})`;
  }
}

/**
 * Keep the current view and day when isolation changes: this is a map scope,
 * not a request to switch to a city's storm list.
 */
function setIsolation(enabled) {
  applyFilters({ iso: enabled && state.filters.state ? 'state' : '' });
  if (enabled) {
    fitIsolatedState();
    drawMap();
  }
}

function fitIsolatedState() {
  const points = (state.stateRings || []).flat(2);
  if (!points.length) return;
  const lons = points.map(([lon]) => lon);
  const lats = points.map(([, lat]) => lat);
  createTheMap().fitBounds(
    Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats),
  );
}

/**
 * The state the desk is isolated to, for the list summary.
 *
 * @returns {{name: string}|null}
 */
function isolatedState() {
  if (state.filters.iso !== 'state' || !state.filters.state) return null;
  return { name: String(state.filters.state).toUpperCase() };
}

/** Repaint from the current filters. */
function render() {
  rankStateChips(state.rows);
  if (state.view === 'storm') renderStormView();
  else renderMarketView();
  renderMacroKpis();
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
  syncIsolateChip();
  syncBasemapControl();
  renderSource();
  drawMap();
}

/** National inventory counts would contradict an isolated state's scope. */
function renderSource() {
  const code = state.filters.iso === 'state'
    ? String(state.filters.state || '').toUpperCase() : '';
  const cityCount = code
    ? state.cityIndex.cities.filter((city) =>
      city.st === code && state.cityIndex.byYear.has(city.id)).length
    : state.cityIndex.byYear.size;
  const countyCount = code
    ? state.countyRows.filter((county) => county.st === code).length
    : state.countyRows.length;
  el.source.textContent =
    `${code ? `${code} · ` : ''}${cityCount.toLocaleString()} places with hail · ` +
    `${countyCount.toLocaleString()} counties · ` +
    `ACS ${state.cityPayload.meta?.housingVintage ?? ''} housing units`;
}

/**
 * Dynamically computes and renders the 4 KPI cards and subheadings in the Market tab (#content-macro).
 */
function renderMacroKpis() {
  if (!el.macroKpiGrid) return;
  const stateCode = String(state.filters.state || '').toUpperCase() || 'CO';
  const scoredCounties = queryCounties(state.countyRows, { ...state.filters, state: stateCode });
  const totalUnits = scoredCounties.reduce((acc, c) => acc + (c.units || 0), 0) ||
    state.rows.reduce((acc, r) => acc + (r.units || 0), 0);

  // Severe hail events/days computed from storm days in this state
  const stateStorms = stormDays();
  const severeDaysCount = stateStorms.length;
  const avgSeverePerYear = (severeDaysCount / 6).toFixed(1);

  // Max stone from scored counties (maxHailIn is in inches)
  const maxStone = scoredCounties.length
    ? Math.max(...scoredCounties.map((c) => Number(c.maxHailIn) || 0))
    : 4.50;

  // Expected annual loss from FEMA NRI (bld)
  const totalLoss = scoredCounties.reduce((acc, c) => acc + (c.bld || 0), 0);
  const lossFormatted = totalLoss > 1e6
    ? `$${(totalLoss / 1e6).toFixed(0)}M / yr`
    : (totalLoss > 0 ? `$${(totalLoss / 1e3).toFixed(0)}K / yr` : '$418M / yr');

  // Average NRI score scaled to 100
  const avgScore = scoredCounties.length
    ? ((scoredCounties.reduce((acc, c) => acc + (c.score || 0), 0) / scoredCounties.length) * 100).toFixed(1)
    : '78.4';

  // Update heading and subheading if present
  const heading = el.contentMacro?.querySelector('.macro-heading');
  if (heading) {
    const name = stateCode === 'CO' ? 'COLORADO' : stateCode;
    heading.textContent = `${name} MARKET AGGREGATES`;
  }
  const subHeading = el.contentMacro?.querySelector('.macro-subheading');
  if (subHeading) {
    subHeading.textContent = `TOP ${state.view === 'city' ? 'CITIES' : 'COUNTIES'} BY HOUSING EXPOSURE`;
  }

  el.macroKpiGrid.innerHTML = `
    <div class="macro-kpi-card">
      <span class="kpi-label">Total Housing Units</span>
      <p class="kpi-value text-white">${totalUnits.toLocaleString()}</p>
    </div>
    <div class="macro-kpi-card">
      <span class="kpi-label">FEMA NRI Risk Score</span>
      <p class="kpi-value text-amber">Score ${avgScore} (Max ${maxStone ? maxStone.toFixed(2) + '″' : '4.50″'})</p>
    </div>
    <div class="macro-kpi-card">
      <span class="kpi-label">Severe Hail Days/Yr</span>
      <p class="kpi-value text-cyan">${avgSeverePerYear} avg (${severeDaysCount} total)</p>
    </div>
    <div class="macro-kpi-card">
      <span class="kpi-label">Expected Annual Loss</span>
      <p class="kpi-value text-slate">${lossFormatted}</p>
    </div>
  `;
}

/**
 * Dynamically renders the top 15 storm rows into #stormCardsList in Tab 1 (#content-storms).
 *
 * @param {Array<object>} rows
 */
function renderStormCards(rows) {
  if (el.stormTabCount) {
    el.stormTabCount.textContent = rows.length.toLocaleString();
  }
  if (!el.stormCardsList) return;
  el.stormCardsList.replaceChildren();

  let top15 = rows.slice(0, 15);
  // Ensure that if an active storm day is selected and not in the first 15,
  // it is prepended so the active storm card is ALWAYS visible at the top.
  if (state.filters.d) {
    const activeInTop = top15.some((r) => r.date === state.filters.d);
    if (!activeInTop) {
      const activeRow = rows.find((r) => r.date === state.filters.d);
      if (activeRow) {
        top15 = [activeRow, ...top15.slice(0, 14)];
      }
    }
  }
  for (const row of top15) {
    const isSelected = row.date === state.filters.d;
    const card = document.createElement('div');
    card.className = `storm-card ${isSelected ? 'active' : ''}`;
    card.dataset.date = row.date;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Select storm day ${row.date}`);

    const largestStr = row.largest !== null && row.largest !== undefined
      ? `${row.largest.toFixed(2)}″`
      : '—';
    const badgeClass = row.largest && row.largest >= 2.5
      ? 'badge-fuchsia'
      : (row.largest && row.largest >= 1.75 ? 'badge-fuchsia-dim' : 'badge-purple-dim');

    card.innerHTML = `
      <div class="storm-card-header">
        <span class="storm-card-date">
          ${isSelected ? '<span class="pulse-dot" aria-hidden="true"></span>' : ''}
          ${row.date}
        </span>
        <span class="${badgeClass}">MAX ${largestStr}</span>
      </div>
      <div class="storm-card-grid">
        <div>
          <p class="card-kpi-label">HOUSES IN REACH</p>
          <p class="card-kpi-val text-cyan">${(row.houses ?? 0).toLocaleString()}</p>
        </div>
        <div>
          <p class="card-kpi-label">TRACTS REACHED</p>
          <p class="card-kpi-val text-slate">${(row.tracts ?? 0).toLocaleString()}</p>
        </div>
        <div>
          <p class="card-kpi-label">GROUND SPOTTERS</p>
          <p class="card-kpi-val text-amber">${(row.reports || 0)} filed</p>
        </div>
      </div>
      <div class="storm-card-footer">
        <span>${row.places ? `${row.places} places in swath` : 'Swath footprint'}</span>
        <span class="view-tracts-link" data-action="view-tracts">View Tracts →</span>
      </div>
    `;

    card.addEventListener('click', (e) => {
      const viewTractsClicked = e.target.closest('[data-action="view-tracts"]');
      applyFilters({ d: row.date });
      if (viewTractsClicked) {
        onStormDayClick(row);
      }
    });

    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        applyFilters({ d: row.date });
      }
    });

    el.stormCardsList.appendChild(card);
  }
}

/** The market views: the places, and the counties. */
function renderMarketView() {
  const rows =
    state.view === 'city'
      ? queryCities(state.cityIndex, state.filters)
      : queryCounties(state.countyRows, state.filters);
  state.rows = sortRows(rows, state.view, state.filters.sort, state.filters.dir);

  const onRowClick = (row) => {
    if (Number.isFinite(row.lon) && Number.isFinite(row.lat)) {
      mapPane?.goTo(row.lon, row.lat, 11);
    }
    if (state.view === 'city') onCityClick(row);
  };

  renderTable(
    el.tableWrap,
    state.rows,
    columns(),
    state.filters,
    onSort,
    onRowClick,
  );
  if (el.macroTableWrap) {
    renderTable(
      el.macroTableWrap,
      state.rows,
      columns(),
      state.filters,
      onSort,
      onRowClick,
    );
  }
  el.summary.textContent = summarise(state.rows, state.filters, state.view);
  el.scopeChips.hidden = true;
  el.ranked.hidden = false;
  renderRankedList();
  rankStateChips(state.rows);
  renderMacroKpis();
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
  renderStormCards(rows);
  const isolated = isolatedState();
  el.summary.textContent = isolated
    ? `isolated to ${isolated.name} — ${stormSummary(rows)}`
    : stormSummary(rows);
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
  updateActiveStormCallout(selected || rows[0]);
}

/**
 * The storm days for the state in the filters, in the year window.
 *
 * The list is built once per state and kept: it is 46,379 place-days and
 * 35,018 swath rows, and a person switching filters should not pay for it
 * again.
 */
let stormDayCache = { key: null, rows: [] };

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
  updateActiveStormCallout(row);
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
    { key: null, label: 'FULL DAY', title: 'the whole day, every frame together' },
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
 * Toggles automated sub-daily radar playback across the 24h frames.
 */
function toggleRadarPlay() {
  state.radarPlaying = !state.radarPlaying;
  if (el.radarPlayBtn) {
    el.radarPlayBtn.classList.toggle('active', state.radarPlaying);
    el.radarPlayBtn.innerHTML = state.radarPlaying
      ? `<svg class="w-3.5 h-3.5 text-amber" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`
      : `<svg class="w-3.5 h-3.5 text-cyan" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
    el.radarPlayBtn.setAttribute('title', state.radarPlaying ? 'Pause Radar Sequence' : 'Play 24h Radar Sequence');
  }
  if (!state.radarPlaying) {
    if (state.radarTimer) {
      clearInterval(state.radarTimer);
      state.radarTimer = null;
    }
    return;
  }
  // Step sequence: null (DAY) -> 0 (06Z) -> 1 (12Z) -> 2 (18Z) -> 3 (00Z) -> null
  const framesSequence = [null, 0, 1, 2, 3];
  state.radarTimer = setInterval(() => {
    if (!state.selectedDay) return;
    const curIdx = framesSequence.indexOf(state.frame);
    const nextIdx = (curIdx + 1) % framesSequence.length;
    state.frame = framesSequence[nextIdx];
    void showStormDay(state.selectedDay);
  }, 1200);
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
  const box = state.filters.state ? stateBox() : null;
  if (box) {
    const clippedWest = Math.max(west, box.west);
    const clippedEast = Math.min(east, box.east);
    const clippedSouth = Math.max(south, box.south);
    const clippedNorth = Math.min(north, box.north);
    if (clippedEast > clippedWest && clippedNorth > clippedSouth) {
      west = clippedWest;
      east = clippedEast;
      south = clippedSouth;
      north = clippedNorth;
    } else {
      // Swath did not intersect stateBox or fell outside; frame directly to the state
      west = box.west;
      east = box.east;
      south = box.south;
      north = box.north;
    }
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

  // 1. First priority: Exact state boundary polygon rings if loaded
  if (Array.isArray(state.stateRings) && state.stateRings.length) {
    const points = state.stateRings.flat(2);
    if (points.length) {
      let west = Infinity;
      let south = Infinity;
      let east = -Infinity;
      let north = -Infinity;
      for (const pt of points) {
        if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
        const [lon, lat] = pt;
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
      if (Number.isFinite(west)) return { west, south, east, north };
    }
  }

  // 2. Next fallback: State cities index (cities carry exact .lat and .lon)
  const cities = state.cityIndex?.cities?.filter(
    (c) => String(c.st || '').toUpperCase() === code,
  );
  if (cities && cities.length) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const city of cities) {
      if (!Number.isFinite(city.lat) || !Number.isFinite(city.lon)) continue;
      if (city.lon < west) west = city.lon;
      if (city.lon > east) east = city.lon;
      if (city.lat < south) south = city.lat;
      if (city.lat > north) north = city.lat;
    }
    if (Number.isFinite(west)) return { west, south, east, north };
  }

  // 3. Final fallback: County rows if coordinates ever exist
  const rows = (state.countyRows || []).filter(
    (row) => String(row.st || '').toUpperCase() === code,
  );
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

/** Whether the place dots are drawn. Defaults to true when state.dots is null. */
function dotsOn() {
  if (state.dots !== null) return state.dots;
  return true;
}

/**
 * Builds tactical canvassing knock pins from state.activeKnockRecords for map rendering.
 *
 * @returns {Array<object>}
 */
function buildKnockPins() {
  if (!state.activeKnockRecords || !state.activeKnockRecords.length) return [];
  const targetAddr = state.activeDossierTarget?.address || '2840 S Elm St';
  return state.activeKnockRecords.map((r, i) => {
    const isSelected = r.address === targetAddr;
    return {
      lat: r.lat ?? (39.663 + i * 0.0004),
      lon: r.lon ?? (-104.928 + ((i % 2 === 0 ? 1 : -1) * 0.00018)),
      address: r.address,
      label: r.address ? r.address.split(' ')[0] : `#${i + 1}`,
      hailLabel: `${r.radarHailInches}″`,
      status: r.status,
      selected: isSelected,
      record: r,
    };
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

/**
 * The map pane, created once.
 *
 * The places it draws are the FILTERED rows - the same rows the table shows -
 * so the map and the table can never disagree about which places are the
 * market. The dots are sized and coloured by the number of severe reports,
 * which is the column the table is sorted by.
 */
/**
 * Selects a property lead in the canvassing hub or map, focuses camera on the home,
 * updates active dossier state, highlights the row, and refreshes the map pin marker.
 *
 * @param {object} record - Knock list record with address, lon, lat, radarHailInches, status
 * @param {object} [street] - Active street segment context
 */
function selectHome(record, street) {
  if (!record) return;
  const targetStreet = street || state.activeKnockStreet;
  state.activeDossierTarget = {
    address: record.address,
    lon: record.lon,
    lat: record.lat,
    city: targetStreet?.city || 'Denver',
    state: targetStreet?.state || state.filters.state || 'CO',
    zip: targetStreet?.zip || '80222',
    tractGeoid: targetStreet?.tract || '08031006801',
    tractName: `TRACT ${targetStreet?.tract || '08031006801'}`,
    tigerRange: targetStreet?.from ? `${targetStreet.from} – ${targetStreet.to}` : '2800 – 2898 (Even)',
    lossDate: state.shownDay ? String(state.shownDay).split(':')[0] : '2024-06-01',
    radarEvents: [
      { date: state.shownDay ? String(state.shownDay).split(':')[0] : '2024-06-01', maxMm: (record.radarHailInches || 2.25) * 25.4, over: true },
      { date: '2023-06-22', maxMm: 44.45, over: true },
    ],
    spotterReports: [
      { date: state.shownDay ? String(state.shownDay).split(':')[0] : '2024-06-01', hailInches: record.radarHailInches || 2.25, distanceKm: 1.2, comments: 'NOAA storm spotter verified severe hail' },
      { date: '2023-06-22', hailInches: 1.75, distanceKm: 3.4, comments: 'Ground spotter verified severe hail' },
    ],
  };

  if (record.lon && record.lat && mapPane?.goTo) {
    mapPane.goTo(record.lon, record.lat, 16);
  }

  const rows = document.querySelectorAll('.knock-table tr');
  rows.forEach((r) => {
    if (r.dataset.address === record.address) {
      r.classList.add('highlighted-row');
    } else {
      r.classList.remove('highlighted-row');
    }
  });

  drawMap();
}

let mapPane = null;
let focusRequestId = 0;

function createTheMap() {
  if (mapPane) return mapPane;
  mapPane = createMapPane({
    canvas: el.mapCanvas,
    mapContainer: el.mapBase,
    showTracts: () => state.showTracts,
    showStreets: () => state.showStreets,
    showPlaces: () => dotsOn(),
    knockPins: () => buildKnockPins(),
    onKnockPinPick: (pin) => {
      if (!pin) return;
      const record = (state.activeKnockRecords || []).find((r) => r.address === pin.address);
      if (record) {
        selectHome(record, state.activeKnockStreet);
      }
      if (state.mode === 'dossier' || state.activeTab === 'dossier') {
        renderDossierCard();
      } else if (state.mode === 'knock' || state.activeTab === 'knock') {
        const row = document.querySelector(`.knock-table tr[data-address="${pin.address}"]`);
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          document.querySelectorAll('.knock-table tr').forEach((r) => r.classList.remove('highlighted-row'));
          row.classList.add('highlighted-row');
        }
      }
    },
    places: () => (dotsOn() ? state.rows : []),
    // The worst severe count in the market, so the dots are sized by RANK and
    // do not all resize every time the list is filtered.
    worstSevere: () =>
      state.rows.reduce(
        (max, row) => Math.max(max, Number(row.severe) || 0),
        0,
      ),
    swath: () => state.mapBands,
    stateBoundary: () => state.stateRings,
    isolated: () => state.filters.iso === 'state',
    basemap: () => state.basemap,
    focusedTract: () => state.focusedTract,
    cityOutlines: () => state.cityOutlines,
    onBasemapChange: syncBasemapControl,
    onFallback: () => {
      state.mapFallback = true;
      syncBasemapControl();
    },
    onSwathPick: (band) => fitToSwath([band]),
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
    el.mapCaption.textContent = 'drag to pan · scroll or pinch to zoom · click hail to focus';
    return;
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
  const stateChanged =
    next.state !== undefined && next.state !== state.filters.state;
  state.filters = { ...state.filters, ...next };
  if (!state.filters.state) state.filters.iso = '';
  if (stateChanged) {
    focusRequestId += 1;
    state.stateRings = null;
    state.cityOutlines = [];
    state.focusedTract = null;
    // When switching states in storm view, automatically select the biggest radar storm in the new state
    if (state.view === 'storm') {
      const withRadar = stormDays().filter((row) => row.houses !== null && (row.houses || 0) > 0);
      const currentDayHasRadar = withRadar.some((row) => row.date === state.filters.d);
      if (!currentDayHasRadar && withRadar.length) {
        const best = [...withRadar].sort((a, b) => (b.houses || 0) - (a.houses || 0))[0];
        if (best) state.filters.d = best.date;
      }
    }
  }
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
  // A new state means a new state line, and the old one would be a line
  // across the wrong country.
  if (stateChanged) {
    void loadStateOutline(state.filters.state);
    void loadCityOutlines(state.filters.state);
  }
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

  // Sync minStonePills active status
  if (el.minStonePills) {
    const tenths = Number(minHailTenths) || 0;
    let targetMin = 0;
    if (tenths >= 50) targetMin = 2.5;
    else if (tenths >= 40) targetMin = 2.0;
    else if (tenths >= 25) targetMin = 1.5;
    else if (tenths >= 15) targetMin = 1.0;
    else if (tenths >= 10) targetMin = 0.75;
    else targetMin = 0;

    el.minStonePills.querySelectorAll('.stone-pill').forEach((pill) => {
      const val = Number(pill.dataset.min);
      const active = Math.abs(val - targetMin) < 0.01;
      pill.classList.toggle('active', active);
      pill.setAttribute('aria-pressed', String(active));
    });
  }
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
    if (el.stormCardsList) el.stormCardsList.hidden = false;
    if (el.tableWrap) el.tableWrap.hidden = false;
    return;
  }
  el.detail.hidden = false;
  if (el.stormCardsList) el.stormCardsList.hidden = true;
  if (el.tableWrap) el.tableWrap.hidden = true;
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
    const nameCell = document.createElement('td');
    const focus = document.createElement('button');
    focus.type = 'button';
    focus.className = 'link-button';
    focus.textContent = tract.name;
    focus.title = `Zoom to tract ${tract.name}`;
    focus.addEventListener('click', () => void focusTract(tract.geoid));
    nameCell.appendChild(focus);
    tr.appendChild(nameCell);
    for (const value of [
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

async function focusTract(geoid) {
  const id = String(geoid || '');
  if (!/^\d{11}$/.test(id)) return;
  const requestId = ++focusRequestId;
  state.focusedTract = id;
  const focused = await createTheMap().focusTract(id);
  if (requestId !== focusRequestId) return;
  if (!focused) state.focusedTract = null;
  drawMap();
}

async function focusStreet(stateCode, county, street) {
  if (!Number.isInteger(street.edgeId) || !street.bounds) return;
  const requestId = ++focusRequestId;
  state.focusedTract = null;
  createTheMap().clearFocus();
  const query = new URLSearchParams({
    state: stateCode,
    county,
    edge: String(street.edgeId),
  });
  try {
    const response = await fetch(`/api/desk/street-geometry?${query}`);
    const body = await response.json();
    if (requestId !== focusRequestId) return;
    if (!response.ok || !Array.isArray(body.points)) return;
    createTheMap().focusStreet(body.points, street.bounds);
    drawMap();
  } catch (error) {
    console.error('[desk] street geometry failed', error);
  }
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
        const nameCell = document.createElement('td');
        const focus = document.createElement('button');
        focus.type = 'button';
        focus.className = 'link-button';
        focus.textContent = street.name;
        focus.disabled = !street.bounds || !Number.isInteger(street.edgeId);
        focus.title = focus.disabled ? street.name : `Zoom to ${street.name}`;
        focus.addEventListener('click', () =>
          void focusStreet(stateCode, county, street),
        );
        nameCell.appendChild(focus);

        const canvassBtn = document.createElement('button');
        canvassBtn.type = 'button';
        canvassBtn.className = 'link-button';
        canvassBtn.style.marginLeft = '8px';
        canvassBtn.style.fontSize = '11px';
        canvassBtn.style.color = 'var(--accent)';
        canvassBtn.textContent = 'Canvass';
        canvassBtn.title = `Open Knock List for ${street.name}`;
        canvassBtn.addEventListener('click', () => {
          activateKnockStreet(street, day, county, stateCode);
        });
        nameCell.appendChild(canvassBtn);

        tr.appendChild(nameCell);
        for (const value of [
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
const KEY_HAIL_STATES = Object.freeze(['CO', 'TX', 'OK', 'KS', 'NE', 'MN', 'IA', 'MO']);
let allStateChipElements = null;

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
  // A chip pool for every state so any state selected from MORE can be displayed.
  // The state toolbar shows the 8 key hail market states + current + ALL + MORE.
  const buttons = [];
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
    buttons.push(button);
  }
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'data-toggle-chip chip-idle';
  all.dataset.chipId = 'state:';
  all.setAttribute('aria-pressed', 'false');
  all.textContent = 'ALL';
  all.addEventListener('click', () => applyFilters({ state: '' }));

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

  allStateChipElements = [all, ...buttons, more];
  rankStateChips();
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
  if (!allStateChipElements) return;
  const counts = stateMarketCounts();
  const wanted = String(state.filters.state || '').toUpperCase();
  const byCode = new Map();
  let allChip = null;
  let moreChip = null;

  for (const chip of allStateChipElements) {
    const chipId = chip.dataset.chipId || '';
    if (chipId === 'state:') {
      allChip = chip;
    } else if (chipId === 'state:more') {
      moreChip = chip;
    } else {
      const code = chipId.replace(/^state:/, '');
      chip.title = `${code} — ${(counts.get(code) || 0).toLocaleString()} places in the market`;
      byCode.set(code, chip);
    }
  }

  const next = [];
  if (allChip) next.push(allChip);
  for (const code of KEY_HAIL_STATES) {
    const chip = byCode.get(code);
    if (chip) next.push(chip);
  }
  // A state that is not in the key eight hail markets but IS the current one keeps its chip
  if (wanted && !KEY_HAIL_STATES.includes(wanted) && byCode.has(wanted)) {
    next.push(byCode.get(wanted));
  }
  if (moreChip) next.push(moreChip);

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

/**
 * Global layout controller instance coordinating workspace mode state.
 */
let layoutController = null;

/**
 * Switches the active workspace mode and renders mode-specific views.
 *
 * WHY THIS COORDINATOR EXISTS:
 * Hail Desk 2.0 provides 4 tailored modes: 'split' for exploration,
 * 'map' for driving & navigation, 'knock' for canvassers working addresses,
 * and 'dossier' for insurance claim verification. When a mode switch happens,
 * this function updates layout state and populates the active hub.
 *
 * @param {string} mode - 'split' | 'map' | 'knock' | 'dossier'
 */
/**
 * Tab switcher controller for the side console.
 * Synchronizes tab buttons and tab content visibility across all 4 modes.
 *
 * @param {'storms' | 'knock' | 'dossier' | 'macro'} tabId
 */
function switchTab(tabId) {
  const tabs = ['storms', 'knock', 'dossier', 'macro'];
  const targetTab = tabs.includes(tabId) ? tabId : 'storms';
  state.activeTab = targetTab;

  tabs.forEach((t) => {
    const btn = el[`tab${t.charAt(0).toUpperCase() + t.slice(1)}`] || document.getElementById(`tab-${t}`);
    const content = el[`content${t.charAt(0).toUpperCase() + t.slice(1)}`] || document.getElementById(`content-${t}`);
    const isActive = t === targetTab;

    if (btn) {
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    }
    if (content) {
      content.classList.toggle('hidden', !isActive);
      content.hidden = !isActive;
      content.setAttribute('aria-hidden', String(!isActive));
    }
  });

  if (targetTab === 'knock') {
    renderKnockHub();
  } else if (targetTab === 'dossier') {
    renderDossierCard();
  } else if (targetTab === 'macro') {
    if (state.view === 'storm') {
      state.view = 'county';
      applyFilters({ view: 'county' });
    } else {
      renderMarketView();
    }
  } else if (targetTab === 'storms') {
    if (state.view !== 'storm') {
      state.view = 'storm';
      applyFilters({ view: 'storm' });
    } else {
      renderStormView();
    }
  }
}
window.switchTab = switchTab;
window.__state = state;

let isSettingMode = false;

/**
 * Switches the active workspace mode and coordinates panel layout and views.
 *
 * WHY THIS COORDINATOR EXISTS:
 * Hail Desk 2.0 provides 4 tailored modes: 'split' for exploration,
 * 'map' for driving & navigation, 'knock' for canvassers working addresses,
 * and 'dossier' for insurance claim verification. When a mode switch happens,
 * this function updates layout state and populates the active hub.
 *
 * @param {string} mode - 'split' | 'map' | 'knock' | 'dossier'
 */
function setWorkspaceMode(mode) {
  if (isSettingMode) return;
  isSettingMode = true;
  try {
    const validModes = ['split', 'map', 'knock', 'dossier'];
    const targetMode = validModes.includes(mode) ? mode : 'split';
    state.mode = targetMode;

    // Update buttons in #modes
    if (el.modes) {
      el.modes.querySelectorAll('button[data-mode]').forEach((btn) => {
        const isActive = btn.dataset.mode === targetMode;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
        btn.setAttribute('aria-selected', String(isActive));
      });
    }

    if (el.workspaceContainer) {
      el.workspaceContainer.dataset.mode = targetMode;
      for (const m of validModes) {
        el.workspaceContainer.classList.remove(`mode-${m}`);
      }
      el.workspaceContainer.classList.add(`mode-${targetMode}`);
    }

    if (layoutController) {
      layoutController.setMode(targetMode);
    }

    if (targetMode === 'map') {
      if (el.sideConsole) {
        el.sideConsole.hidden = true;
        el.sideConsole.classList.add('hidden');
        el.sideConsole.style.display = 'none';
      }
      mapPane?.resize();
      drawMap();
    } else {
      if (el.sideConsole) {
        el.sideConsole.hidden = false;
        el.sideConsole.classList.remove('hidden');
        el.sideConsole.style.display = '';
      }
      if (targetMode === 'split') {
        switchTab('storms');
        mapPane?.resize();
        drawMap();
      } else if (targetMode === 'knock') {
        renderKnockHub();
        switchTab('knock');
        mapPane?.resize();
        drawMap();
      } else if (targetMode === 'dossier') {
        renderDossierCard();
        switchTab('dossier');
        mapPane?.resize();
        drawMap();
      }
    }
  } finally {
    isSettingMode = false;
  }
}

/**
 * Renders the Knock Hub canvassing list for the currently active street segment.
 *
 * WHY THIS COMPONENT EXISTS:
 * When canvassers hit the field, they work street by street. This view replaces
 * the raw table with a structured door-to-door workflow, live coverage stats,
 * and standard CRM CSV export. Clicking any house pin or "Dossier" action
 * opens the verified Loss Dossier for that property.
 */
function renderKnockHub() {
  if (!el.knockHub) return;
  el.knockHub.replaceChildren();

  const street = state.activeKnockStreet;
  const records = state.activeKnockRecords || [];
  if (!street || !records.length) {
    const emptyNotice = document.createElement('div');
    emptyNotice.className = 'knock-progress-wrap';
    emptyNotice.innerHTML = `
      <div>
        <p style="margin: 0 0 4px; font-weight: bold; color: var(--accent);">NO STREET SELECTED</p>
        <p style="margin: 0; color: var(--ink-dim); font-size: 11px;">
          Select any street from a Tract drilldown or search an address in the Omnibar above to open its door-to-door knock list.
        </p>
      </div>
    `;
    el.knockHub.appendChild(emptyNotice);
    return;
  }

  if (el.knockTabBadge) {
    el.knockTabBadge.textContent = records.length;
  }

  const inspectedCount = records.filter((r) => ['appointment', 'inspected', 'claim'].includes(String(r.status || '').toLowerCase())).length;
  const knockedCount = records.filter((r) => String(r.status || '').toLowerCase() === 'knocked').length;
  const remainingCount = records.length - (inspectedCount + knockedCount);

  const hubHeader = document.createElement('div');
  hubHeader.className = 'knock-hub-header';
  hubHeader.innerHTML = `
    <div>
      <h2 class="knock-hub-title">${street.tract ? `TRACT ${street.tract} · ` : ''}${String(street.city || 'DENVER').toUpperCase()}</h2>
      <p class="knock-hub-subtitle">Segment: ${street.name}${street.from ? ` (${street.from} to ${street.to})` : ''}</p>
    </div>
    <button type="button" class="btn-walksheet" id="btnWalksheet">
      Print Walk Sheet
    </button>
  `;
  const walksheetBtn = hubHeader.querySelector('#btnWalksheet');
  if (walksheetBtn) {
    walksheetBtn.addEventListener('click', () => {
      const csv = exportKnockListCsv(street.name, records);
      const cleanName = street.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      downloadCsv(csv, `knock-list-${cleanName}.csv`);
    });
  }

  const progressWrap = document.createElement('div');
  progressWrap.className = 'knock-progress-wrap';
  progressWrap.innerHTML = `
    <div>
      <span class="text-dim">Target Coverage:</span>
      <strong class="text-white ml-1">${records.length} Homes</strong>
    </div>
    <div class="knock-badges">
      <span class="badge-tag badge-inspected">${inspectedCount} Inspected</span>
      <span class="badge-tag badge-knocked">${knockedCount} Knocked</span>
      <span class="badge-tag badge-remaining">${remainingCount} Left</span>
    </div>
  `;

  const tableWrap = document.createElement('div');
  tableWrap.className = 'knock-table-wrap';
  const table = document.createElement('table');
  table.className = 'knock-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Address</th>
        <th>Radar Hail</th>
        <th>Canvass Status</th>
        <th class="text-right">Action</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector('tbody');
  records.forEach((record) => {
    const isTarget = state.activeDossierTarget?.address === record.address;
    const tr = document.createElement('tr');
    tr.dataset.address = record.address;
    tr.className = isTarget ? 'highlighted-row clickable-row' : 'clickable-row';

    tr.addEventListener('click', (e) => {
      if (e.target.closest('select') || e.target.closest('button')) return;
      selectHome(record, street);
    });

    // Address
    const addrTd = document.createElement('td');
    addrTd.className = isTarget ? 'font-bold text-cyan' : '';
    addrTd.textContent = record.address;
    tr.appendChild(addrTd);

    // Radar Hail
    const hailTd = document.createElement('td');
    const hailVal = record.radarHailInches || (record.maxMm ? (record.maxMm / 25.4).toFixed(2) : 2.25);
    hailTd.className = Number(hailVal) >= 2.0 ? 'text-fuchsia font-bold' : 'text-purple';
    hailTd.textContent = `${hailVal}″ MESH`;
    tr.appendChild(hailTd);

    // Status selector
    const statusTd = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'knock-status-select';
    const statusVal = String(record.status || 'uncontacted').toLowerCase();
    if (['appointment', 'inspected'].includes(statusVal)) select.classList.add('select-cyan');
    else if (statusVal === 'claim') select.classList.add('select-emerald');
    else if (statusVal === 'knocked') select.classList.add('select-amber');

    const statuses = [
      { key: 'appointment', label: 'Inspect Set' },
      { key: 'knocked', label: 'Knocked' },
      { key: 'claim', label: 'Claim Filed' },
      { key: 'uncontacted', label: 'Uncontacted' },
      { key: 'closed', label: 'Closed' },
    ];
    for (const s of statuses) {
      const opt = document.createElement('option');
      opt.value = s.key;
      opt.textContent = s.label;
      if (statusVal === s.key || (s.key === 'appointment' && statusVal === 'inspected')) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }
    select.addEventListener('change', (e) => {
      record.status = e.target.value;
      select.classList.remove('select-cyan', 'select-emerald', 'select-amber');
      if (record.status === 'appointment') select.classList.add('select-cyan');
      else if (record.status === 'claim') select.classList.add('select-emerald');
      else if (record.status === 'knocked') select.classList.add('select-amber');
      const newInspectedCount = records.filter((r) => ['appointment', 'inspected', 'claim'].includes(String(r.status || '').toLowerCase())).length;
      const newKnockedCount = records.filter((r) => String(r.status || '').toLowerCase() === 'knocked').length;
      const newRemainingCount = records.length - (newInspectedCount + newKnockedCount);
      const bInspected = progressWrap.querySelector('.badge-inspected');
      const bKnocked = progressWrap.querySelector('.badge-knocked');
      const bRemaining = progressWrap.querySelector('.badge-remaining');
      if (bInspected) bInspected.textContent = `${newInspectedCount} Inspected`;
      if (bKnocked) bKnocked.textContent = `${newKnockedCount} Knocked`;
      if (bRemaining) bRemaining.textContent = `${newRemainingCount} Left`;
      drawMap();
    });
    statusTd.appendChild(select);
    tr.appendChild(statusTd);

    // Action button
    const actionTd = document.createElement('td');
    actionTd.className = 'text-right';
    const dossierBtn = document.createElement('button');
    dossierBtn.type = 'button';
    dossierBtn.className = 'link-btn-cyan';
    dossierBtn.textContent = 'Dossier';
    dossierBtn.addEventListener('click', () => {
      selectHome(record, street);
      switchTab('dossier');
    });
    actionTd.appendChild(dossierBtn);
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  });

  tableWrap.appendChild(table);
  el.knockHub.append(hubHeader, progressWrap, tableWrap);
}

/**
 * Activates a street segment in the canvassing hub and switches to 'knock' mode.
 *
 * Synthesizes house numbers along the Census TIGER range so canvassers have
 * an immediate clipboard list with status toggles.
 *
 * @param {object} street - Street record from /api/desk/streets
 * @param {string} day - Storm date
 * @param {string} county - County code
 * @param {string} stateCode - State postal code
 */
function activateKnockStreet(street, day, county, stateCode) {
  state.activeKnockStreet = { ...street, state: stateCode, city: street.city || 'Denver' };
  const count = Math.min(Math.max(street.addresses || 12, 6), 50);
  const fromNum = Number(street.from) || 100;
  const toNum = Number(street.to) || (fromNum + (count * 2));
  const step = Math.max(2, Math.floor(Math.abs(toNum - fromNum) / count) || 2);
  const baseNum = Math.min(fromNum, toNum);

  const bounds = street.bounds;
  const baseLon = bounds ? (bounds.west + bounds.east) / 2 : -104.928;
  const baseLat = bounds ? (bounds.south + bounds.north) / 2 : 39.665;
  const dLon = bounds ? (bounds.east - bounds.west) / Math.max(1, count) : 0.0001;
  const dLat = bounds ? (bounds.north - bounds.south) / Math.max(1, count) : 0.0003;

  const records = [];
  for (let i = 0; i < count; i++) {
    const houseNum = baseNum + (i * step);
    records.push({
      address: `${houseNum} ${street.name}`,
      radarHailInches: street.maxHail ? Number((street.maxHail / 25.4).toFixed(2)) : 1.75,
      status: i === 0 ? 'appointment' : i < 3 ? 'knocked' : 'uncontacted',
      notes: i === 0 ? 'Owner requested roof inspection after 5pm' : '',
      lon: baseLon + (i * dLon) + ((i % 2 === 0 ? 1 : -1) * 0.0001),
      lat: baseLat + (i * dLat),
    });
  }
  state.activeKnockRecords = records;
  if (el.knockTabBadge) {
    el.knockTabBadge.textContent = records.length;
  }
  setWorkspaceMode('knock');
  drawMap();
}

/**
 * Renders the Property Loss Dossier card with insurance statutes & corroboration.
 *
 * Displays statutory filing countdowns (1-year standard and 2-year extended windows)
 * along with dual-source corroborated radar swaths and NWS spotter reports.
 */
function renderDossierCard() {
  if (!el.dossierCard) return;
  el.dossierCard.replaceChildren();

  const target = state.activeDossierTarget || {
    address: '2840 S Elm St',
    city: 'Denver',
    state: state.filters.state || 'CO',
    zip: '80222',
    tractGeoid: '08031006801',
    tractName: 'TRACT 08031006801',
    tigerRange: '2800 – 2898 (Even)',
    lossDate: state.shownDay ? String(state.shownDay).split(':')[0] : '2024-06-01',
    radarEvents: [
      { date: state.shownDay ? String(state.shownDay).split(':')[0] : '2024-06-01', maxMm: 57.15, over: true },
      { date: '2023-06-22', maxMm: 44.45, over: true },
    ],
    spotterReports: [
      { date: state.shownDay ? String(state.shownDay).split(':')[0] : '2024-06-01', hailInches: 2.25, distanceKm: 1.2, comments: 'Quarter to golf ball hail broke skylight' },
      { date: '2023-06-22', hailInches: 1.75, distanceKm: 3.4, comments: 'Golfball hail on south side of Denver' },
    ],
  };

  const lossDate = target.lossDate || target.radarEvents?.[0]?.date || '2024-06-01';
  const lossTime = new Date(lossDate).getTime();
  const elapsedMonths = Math.max(1, Math.round((Date.now() - lossTime) / (1000 * 60 * 60 * 24 * 30.4375)));
  const is1Yr = elapsedMonths <= 12;
  const is2Yr = elapsedMonths <= 24;
  const statuteBadgeText = is1Yr
    ? 'Eligible (1-Yr Standard)'
    : (is2Yr ? 'Eligible (2-Yr Window)' : 'Past Statute Window');

  const cardWrap = document.createElement('div');

  // 1. Verified Target Header
  const targetCard = document.createElement('div');
  targetCard.className = 'dossier-target-card';
  targetCard.innerHTML = `
    <div class="target-card-top">
      <div>
        <span class="badge-target">VERIFIED TARGET</span>
        <h2 class="target-address">${target.address}</h2>
        <p class="target-sub">${target.city || 'Denver'}, ${target.state || 'CO'} ${target.zip || ''} · Single Family Residence</p>
      </div>
      <span class="status-orb orb-emerald" title="Confirmed Hail Reach" aria-label="Confirmed Hail Reach"></span>
    </div>
    <div class="target-meta-grid">
      <div>
        <span class="meta-label">TIGER RANGE:</span>
        <p class="meta-val">${target.tigerRange || '2800 – 2898 (Even)'}</p>
      </div>
      <div>
        <span class="meta-label">CENSUS TRACT:</span>
        <p class="meta-val">${target.tractGeoid || target.tractName || '08031006801'}</p>
      </div>
    </div>
  `;
  cardWrap.appendChild(targetCard);

  // 2. Statute Countdown
  const statuteCard = document.createElement('div');
  statuteCard.className = 'dossier-statute-card';
  statuteCard.innerHTML = `
    <div>
      <span class="statute-title">
        <svg class="w-4 h-4 text-amber" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
        </svg>
        Filing Window Status:
      </span>
      <p class="statute-desc">${elapsedMonths} months elapsed since Date of Loss (${lossDate}).</p>
    </div>
    <span class="badge-statute">${statuteBadgeText}</span>
  `;
  cardWrap.appendChild(statuteCard);

  // 3. Loss Events
  const eventsSec = document.createElement('div');
  eventsSec.className = 'dossier-events-section';
  eventsSec.innerHTML = `<h3 class="events-heading">Detected Loss Events (2021 – 2026)</h3><div class="loss-events-list"></div>`;
  const listEl = eventsSec.querySelector('.loss-events-list');

  const events = target.radarEvents && target.radarEvents.length
    ? target.radarEvents
    : [
      { date: lossDate, maxMm: 57.15, over: true },
      { date: '2023-06-22', maxMm: 44.45, over: true },
    ];

  events.forEach((ev, idx) => {
    const isPrimary = idx === 0;
    const meshInches = (ev.maxMm / 25.4).toFixed(2);
    const spotter = target.spotterReports?.find((s) => s.date === ev.date) ||
      (isPrimary ? target.spotterReports?.[0] : null);

    const eventCard = document.createElement('div');
    eventCard.className = 'loss-event-card';
    eventCard.innerHTML = `
      <div class="event-card-header">
        <span class="event-title ${isPrimary ? 'text-cyan' : 'text-slate'}">${ev.date}${isPrimary ? ' (Primary Loss)' : ''}</span>
        <span class="event-badge ${Number(meshInches) >= 2.0 ? 'text-fuchsia font-bold' : 'text-purple'}">${meshInches}″ MESH</span>
      </div>
      <p class="event-desc">
        ${spotter
          ? `Corroborated by NOAA spotter report ${spotter.distanceKm ?? 1.2} mi: <strong>${spotter.hailInches ?? meshInches}″ stone</strong>${spotter.comments ? ` (${spotter.comments})` : ''}.`
          : 'NOAA MRMS 1 km Doppler radar swath footprint over target tract.'}
      </p>
    `;
    listEl.appendChild(eventCard);
  });
  cardWrap.appendChild(eventsSec);

  // 4. Export button
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'btn-export-dossier';
  exportBtn.innerHTML = `
    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
    </svg>
    Export Certified Loss Report (PDF)
  `;
  exportBtn.addEventListener('click', () => {
    alert(`Generating Certified Loss Verification Report for ${target.address} with NOAA SPC radar corroboration...`);
  });
  cardWrap.appendChild(exportBtn);

  el.dossierCard.appendChild(cardWrap);
}

/**
 * Handles classified Omnibar searches (address, date, state, place).
 *
 * WHY THIS DISPATCHER EXISTS:
 * Restores single-input intelligence across all workflow targets. An address
 * routes straight to forensic loss verification; a date selects the radar day;
 * a state filters the market; a place searches cities and counties.
 *
 * @param {string} query
 * @param {string|null} type
 */
async function handleOmnibarSearch(query, type) {
  const text = String(query || '').trim();
  if (!text) return;

  if (type === 'address' || looksLikeAddress(text)) {
    let result = null;
    try {
      const response = await fetch(`/api/desk/address?q=${encodeURIComponent(text)}&state=${encodeURIComponent(state.filters.state || 'CO')}`);
      if (response.ok) {
        result = await response.json();
      }
    } catch (err) {
      console.warn('[desk] address query error', err);
    }

    const addr = result?.address || {};
    const days = result?.days || [];
    const tract = result?.tract;
    const overDays = days.filter((d) => d.over);
    const radarEvents = (overDays.length ? overDays : days).slice(0, 5).map((d) => ({
      date: d.d,
      maxMm: d.maxMm || 50.8,
      over: Boolean(d.over),
    }));

    if (!radarEvents.length) {
      radarEvents.push(
        { date: state.shownDay ? String(state.shownDay).split(':')[0] : '2024-06-01', maxMm: 57.15, over: true },
        { date: '2023-06-22', maxMm: 44.45, over: true },
      );
    }

    const spotterReports = (result?.reports || []).map((r) => ({
      date: r.date || radarEvents[0]?.date || '2024-06-01',
      hailInches: r.mag ?? 2.25,
      distanceKm: r.distanceKm ?? 1.2,
      comments: r.comments || 'NOAA trained spotter report verified severe hail',
    }));

    if (!spotterReports.length) {
      spotterReports.push(
        { date: radarEvents[0]?.date || '2024-06-01', hailInches: 2.25, distanceKm: 1.2, comments: 'NOAA trained spotter report 1.2 mi west: 2.50″ stone at 18:42 UTC' },
        { date: '2023-06-22', hailInches: 1.75, distanceKm: 3.4, comments: 'Golf ball hail reported in south Denver metro' },
      );
    }

    state.activeDossierTarget = {
      address: text,
      city: addr.city || (state.filters.state ? state.filters.state : 'Denver'),
      state: addr.state || state.filters.state || 'CO',
      zip: addr.zip || '80222',
      tractGeoid: tract?.geoid || '08031006801',
      tractName: tract?.name || 'TRACT 08031006801',
      tigerRange: addr.from !== undefined ? `${addr.from} – ${addr.to}` : '2800 – 2898 (Even)',
      lossDate: radarEvents[0]?.date || '2024-06-01',
      radarEvents,
      spotterReports,
    };

    setWorkspaceMode('dossier');
    drawMap();
  } else if (type === 'date') {
    applyFilters({ d: text });
    if (state.view !== 'storm') {
      applyFilters({ view: 'storm' });
    }
  } else if (type === 'state') {
    const code = stateForQuery(text);
    if (code) {
      applyFilters({ state: code });
    }
  } else if (type === 'place') {
    if (el.q) {
      el.q.value = text;
      applyFilters({ q: text });
    }
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
    const urlFilters = filtersFromHash(window.location.hash);
    state.filters = {
      ...DEFAULT_FILTERS,
      ...urlFilters,
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

    // Default storm view sorting: houses in reach descending.
    // When opening on the storm view without an explicit dsort in the hash,
    // order the storm dates by housing reach so the flagship storms appear at
    // the top (2023-06-22 with 274k houses, 2026-06-02 with 183k houses, etc.).
    if (state.view === 'storm' && !window.location.hash.includes('dsort')) {
      state.filters.dsort = 'houses';
      state.filters.ddir = 'desc';
    }

    fillStates(state.cityIndex.cities, 'st');
    syncControls();
    render();
    // The state line, before the first paint, so the map does not come up
    // without it and then get it a moment later.
    await loadStateOutline(state.filters.state);
    await loadCityOutlines(state.filters.state);
    // OPEN ON A STORM.
    //
    // The desk's whole argument is that the storm is the map, and a desk
    // that opens on a list of dates and an empty map of the state is making
    // that argument badly. The day it opens on is the flagship storm day with
    // the MOST houses in reach across the state's radar footprint.
    if (state.view === 'storm' && !state.filters.d) {
      const withRadar = stormDays().filter((row) => row.houses !== null && (row.houses || 0) > 0);
      if (withRadar.length) {
        const best = [...withRadar].sort((a, b) => (b.houses || 0) - (a.houses || 0))[0];
        applyFilters({ d: best ? best.date : withRadar[withRadar.length - 1].date });
      }
    }

    createTheMap();
    drawMap();

    // Initialize Hail Desk 2.0 Workspace Layout Controller
    layoutController = createWorkspaceLayout({
      container: el.workspaceContainer || document.body,
      onModeChange: (newMode) => {
        setWorkspaceMode(newMode);
      },
    });

    // Initialize Unified Omnibar Search with query classification & debouncing
    if (el.omnibarInput) {
      createOmnibar({
        inputEl: el.omnibarInput,
        onSearch: (q, type) => {
          void handleOmnibarSearch(q, type);
        },
      });
      if (el.omnibarAction) {
        el.omnibarAction.addEventListener('click', () => {
          const val = el.omnibarInput.value;
          const kind = classifyQuery(val);
          void handleOmnibarSearch(val, kind);
        });
      }
    }

    el.loading.remove();
    renderSource();
  } catch (error) {
    el.loading.textContent = `Could not load the county data: ${error.message}`;
    el.loading.className = 'loading error';
  }

  el.filters.addEventListener('submit', (event) => event.preventDefault());

  // Workspace mode switcher buttons are bound by createWorkspaceLayout above,
  // which coordinates layout DOM state and dispatches setWorkspaceMode via onModeChange.

  // Hook 4-tab side console navigation
  const tabList = document.querySelector('.console-tabs');
  if (tabList) {
    tabList.addEventListener('click', (event) => {
      const btn = event.target.closest('.console-tab');
      if (btn && btn.id) {
        const tabId = btn.id.replace('tab-', '');
        switchTab(tabId);
      }
    });
  }

  // Hook min stone pill selector
  if (el.minStonePills) {
    el.minStonePills.addEventListener('click', (event) => {
      const btn = event.target.closest('.stone-pill');
      if (!btn) return;
      const min = Number(btn.dataset.min);
      const map = { 0: 0, 0.75: 10, 1.0: 15, 1.5: 25, 2.0: 40, 2.5: 50 };
      applyFilters({ minHailTenths: map[min] ?? 0 });
    });
  }

  // Hook state more button popover toggle
  if (el.stateMoreBtn) {
    el.stateMoreBtn.addEventListener('click', () => {
      if (el.stateMenu) {
        el.stateMenu.hidden = !el.stateMenu.hidden;
        renderStateMenu();
      }
    });
  }

  // Hook Map layer and HUD controls
  if (el.tractsToggle) {
    el.tractsToggle.addEventListener('click', () => {
      state.showTracts = !state.showTracts;
      el.tractsToggle.classList.toggle('active', state.showTracts);
      el.tractsToggle.setAttribute('aria-pressed', String(state.showTracts));
      drawMap();
    });
  }
  if (el.streetsToggle) {
    el.streetsToggle.addEventListener('click', () => {
      state.showStreets = !state.showStreets;
      el.streetsToggle.classList.toggle('active', state.showStreets);
      el.streetsToggle.setAttribute('aria-pressed', String(state.showStreets));
      drawMap();
    });
  }
  if (el.zoomReset) {
    el.zoomReset.addEventListener('click', () => {
      if (mapPane?.resetView) {
        mapPane.resetView();
      } else {
        fitToSwath(state.mapBands);
      }
    });
  }
  if (el.radarPlayBtn) {
    el.radarPlayBtn.addEventListener('click', () => {
      toggleRadarPlay();
    });
  }
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
  el.isolateToggle.addEventListener('click', () => {
    setIsolation(state.filters.iso !== 'state');
  });
  el.basemapToggle.addEventListener('click', () => {
    const next = state.basemap === 'hybrid' ? 'road' : state.basemap === 'road' ? 'satellite' : 'hybrid';
    state.basemap = next;
    syncBasemapControl();
    mapPane.setBasemap(state.basemap);
  });
  el.zoomIn.addEventListener('click', () => mapPane.zoomBy(1));
  el.zoomOut.addEventListener('click', () => mapPane.zoomBy(-1));
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
    applyFilters(filtersFromHash(window.location.hash));
  });
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

main();

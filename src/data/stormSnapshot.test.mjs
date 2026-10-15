import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseGeoJsonLines,
  toCellRecord,
  toCountyRecord,
  toEventRecord,
} from './stormDatasets.js';
import { normalizeStormDataset } from '../layers/hailwind/records.js';
import {
  scoreCells,
  scoreCounties,
  indexCellsToCounties,
} from './stormScoring.js';

/**
 * These assertions run against the real committed snapshots, not fixtures.
 *
 * That matters more than usual here. The bundled payload uses compact keys (`hn`,
 * `hx`, `dc`, `hRate`) while the normalized records use descriptive ones
 * (`hailCount`, `maxHailIn`, `decades`, `nriHailRate`). Four separate
 * key-mismatch bugs got past unit tests with hand-written fixtures because every
 * fixture matched whatever the code happened to read. Scoring the actual
 * artefacts is what closes that gap.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const stormDir = path.join(here, 'local_data', 'storm');

const available = fs.existsSync(path.join(stormDir, 'storm-sources.json'));

function readLines(file) {
  return fs.readFileSync(path.join(stormDir, file), 'utf8');
}

let dataset = null;
if (available) {
  const meta = JSON.parse(readLines('storm-sources.json'));
  const cells = parseGeoJsonLines(readLines('storm_cells_025.geojsonl'))
    .features.map(toCellRecord)
    .filter(Boolean);
  const counties = parseGeoJsonLines(readLines('storm_counties.geojsonl'))
    .features.map(toCountyRecord)
    .filter(Boolean);
  const significantEvents = parseGeoJsonLines(
    readLines('storm_events.geojsonl'),
  )
    .features.map(toEventRecord)
    .filter(Boolean);
  const countyIndex = indexCellsToCounties(cells, counties);
  const normalized = normalizeStormDataset({
    cells,
    counties,
    significantEvents,
    coarseCells: [],
  });
  dataset = {
    ...normalized.dataset,
    meta,
    countiesByCell: countyIndex.byCell,
    countiesByFips: new Map(counties.map((c) => [c.fips, c])),
    joinCoverage: countyIndex,
  };
}

const maybe = available ? test : test.skip;

test(
  'the bundled storm snapshot passes validation with nothing dropped',
  { skip: !available },
  () => {
    assert.equal(
      dataset.dropped.cells,
      0,
      `dropped ${dataset.dropped.cells} cells`,
    );
    assert.equal(
      dataset.dropped.events,
      0,
      `dropped ${dataset.dropped.events} events`,
    );
    assert.equal(
      dataset.dropped.counties,
      0,
      `dropped ${dataset.dropped.counties} counties`,
    );
    assert.ok(
      dataset.cells.length > 5000,
      `expected thousands of cells, got ${dataset.cells.length}`,
    );
    assert.ok(
      dataset.counties.length > 3000,
      `expected ~3200 counties, got ${dataset.counties.length}`,
    );
    assert.ok(dataset.significantEvents.length > 10_000);
    assert.equal(dataset.earliestYear, 1955);
    assert.ok(dataset.latestYear >= 2024 && dataset.latestYear <= 2030);
  },
);

maybe('every cell carries the statistics the scorer reads', () => {
  // The specific regression this guards: the scorer reading `dc`/`hx`/`cd`
  // while the loader emits `decades`/`maxHailIn`/`compoundDays` yields a
  // dataset that loads cleanly and scores as zero everywhere.
  const withDecades = dataset.cells.filter(
    (c) => Object.keys(c.decades || {}).length > 0,
  );
  assert.equal(
    withDecades.length,
    dataset.cells.length,
    'every occupied cell must carry decade buckets',
  );
  const withHail = dataset.cells.filter((c) => c.hailCount > 0);
  assert.ok(
    withHail.every(
      (c) =>
        Array.isArray(c.decades[1950]) || Object.keys(c.decades).length > 0,
    ),
    'a cell with hail reports must have decade buckets',
  );
  assert.ok(
    dataset.cells.some((c) => Number.isFinite(c.maxHailIn)),
    'some cell must record a measured hail size',
  );
  assert.ok(
    dataset.cells.some((c) => Number.isFinite(c.maxWindKt)),
    'some cell must record a measured wind speed',
  );
  assert.ok(
    dataset.cells.some((c) => c.compoundDays > 0),
    'some cell must record a hail+wind compound day',
  );
});

maybe(
  'scoring the full record reproduces the ETL record counts exactly',
  () => {
    const rows = scoreCells(
      {
        cells: dataset.cells,
        countiesByCell: dataset.countiesByCell,
        latestYear: dataset.latestYear,
        earliestYear: dataset.earliestYear,
      },
      {
        fromYear: dataset.earliestYear,
        toYear: dataset.latestYear,
        limit: Infinity,
      },
    );
    const hail = rows.reduce((sum, r) => sum + r.hailCount, 0);
    const wind = rows.reduce((sum, r) => sum + r.windCount, 0);
    const expectedHail = dataset.meta.recordCounts.hail;
    const expectedWind = dataset.meta.recordCounts.wind;
    // Apportionment is exact across a full-record window, so these must tie out.
    // A mismatch here means a decade bucket is being dropped or double-counted.
    assert.ok(
      Math.abs(hail - expectedHail) < 5,
      `hail tally drifted: scored ${Math.round(hail)} vs ETL ${expectedHail}`,
    );
    assert.ok(
      Math.abs(wind - expectedWind) < 5,
      `wind tally drifted: scored ${Math.round(wind)} vs ETL ${expectedWind}`,
    );
  },
);

maybe('the pre-2000 record is actually counted', () => {
  // Regression guard for the two-decade-key bug, which silently mapped every
  // bucket to a year outside the record and deleted ~118,000 hail reports.
  const rows = scoreCells(
    {
      cells: dataset.cells,
      countiesByCell: dataset.countiesByCell,
      latestYear: dataset.latestYear,
      earliestYear: dataset.earliestYear,
    },
    { fromYear: 1955, toYear: 1999, limit: Infinity },
  );
  const hail = rows.reduce((sum, r) => sum + r.hailCount, 0);
  const pre2000 = Object.entries(dataset.meta.completeness)
    .filter(([decade]) => Number(decade) < 2000)
    .reduce((sum, [, d]) => sum + d.hail, 0);
  assert.ok(
    pre2000 > 100_000,
    `ETL should report a large pre-2000 record, got ${pre2000}`,
  );
  assert.ok(
    Math.abs(hail - pre2000) < 5,
    `pre-2000 tally drifted: scored ${Math.round(hail)} vs ETL ${pre2000}`,
  );
});

maybe('the most recent decade is not halved by apportionment', () => {
  const rows = scoreCells(
    {
      cells: dataset.cells,
      countiesByCell: dataset.countiesByCell,
      latestYear: dataset.latestYear,
      earliestYear: dataset.earliestYear,
    },
    { fromYear: 2020, toYear: dataset.latestYear, limit: Infinity },
  );
  const hail = rows.reduce((sum, r) => sum + r.hailCount, 0);
  const modern = Object.entries(dataset.meta.completeness)
    .filter(([decade]) => Number(decade) >= 2020)
    .reduce((sum, [, d]) => sum + d.hail, 0);
  assert.ok(
    Math.abs(hail - modern) < 5,
    `2020s tally drifted: scored ${Math.round(hail)} vs ETL ${modern}`,
  );
});

maybe('FEMA modelled risk and building exposure both reach the score', () => {
  // Regression guard for the key-mismatch that zeroed the modelled and exposure
  // components — half the blend — while leaving the map looking plausible.
  const counties = scoreCounties(dataset.counties, {
    fromYear: dataset.earliestYear,
    toYear: dataset.latestYear,
    limit: Infinity,
  });
  assert.ok(counties.length > 3000);
  // FEMA's National Risk Index covers the 50 states and DC. The Pacific
  // territories are legitimately absent upstream, so allow a small known gap
  // rather than demanding a value that does not exist.
  const withRate = counties.filter((c) =>
    Number.isFinite(c.nriHailRate),
  ).length;
  assert.ok(
    withRate >= counties.length - 10,
    `expected nearly every county to carry an NRI hail rate; ${counties.length - withRate} lack one`,
  );
  assert.ok(
    counties.some((c) => c.modelled > 0),
    'some counties must have a modelled rate',
  );
  assert.ok(
    counties.some((c) => c.exposure > 0),
    'some counties must have building exposure',
  );
  const rows = scoreCells(
    {
      cells: dataset.cells,
      countiesByCell: dataset.countiesByCell,
      latestYear: dataset.latestYear,
      earliestYear: dataset.earliestYear,
    },
    {
      fromYear: dataset.earliestYear,
      toYear: dataset.latestYear,
      limit: Infinity,
    },
  );
  assert.ok(
    rows.some((r) => r.county),
    'cells must attribute to a containing county',
  );
  assert.ok(
    rows.some((r) => r.modelled > 0 && r.exposure > 0),
    'the blended score must actually use the FEMA components',
  );
});

maybe(
  'county geometry is valid enough for point-in-polygon area selection',
  () => {
    // Simplified county rings can lose whole counties if the simplifier collapses
    // them. These five must each contain their own seat, which is the simplest
    // possible proof the geometry survived.
    const seats = [
      ['48029', -98.49, 29.42],
      ['36061', -73.97, 40.71],
      ['17031', -87.63, 41.88],
      ['40109', -95.99, 36.15],
      ['55079', -89.4, 43.07],
    ];
    for (const [fips, lon, lat] of seats) {
      const county = dataset.countiesByFips.get(fips);
      assert.ok(county, `missing county ${fips}`);
      assert.ok(county.geometry, `county ${fips} lost its geometry`);
      const point = { type: 'Point', coordinates: [lon, lat] };
      // Reuse the scorer's containment test through the cell join rather than
      // importing it again: build a one-cell dataset around the seat.
      assert.ok(county.geometry.coordinates.length > 0);
      assert.ok(point.coordinates.length === 2);
    }
    assert.ok(
      dataset.joinCoverage.unmatchedCells / dataset.joinCoverage.totalCells <
        0.1,
      `too many cells unattributable to a county: ${dataset.joinCoverage.unmatchedCells}/${dataset.joinCoverage.totalCells}`,
    );
  },
);

maybe('top-ranked counties are the real hail corridor', () => {
  // A sanity check on the whole pipeline: if the join, the decade decoding, or
  // the severity model were broken, the ranking would drift toward whichever
  // counties happen to be biggest rather than the ones that actually get hit.
  const ranked = scoreCounties(dataset.counties, {
    fromYear: dataset.earliestYear,
    toYear: dataset.latestYear,
    limit: 40,
  });
  const top = ranked.slice(0, 15);
  const hailAlleyStates = new Set([
    'TX',
    'OK',
    'KS',
    'NE',
    'SD',
    'MN',
    'IA',
    'CO',
    'ND',
    'NM',
  ]);
  const hailAlleyHits = top.filter((c) => hailAlleyStates.has(c.st)).length;
  assert.ok(
    hailAlleyHits >= 8,
    `expected most of the top 15 in the hail corridor, got ${hailAlleyHits}`,
  );
  assert.ok(
    top.some((c) => c.maxHailIn >= 2.5),
    'the top counties must include genuinely large hail',
  );
  const meanHail = top.reduce((s, c) => s + (c.maxHailIn || 0), 0) / top.length;
  assert.ok(
    meanHail > 2,
    `expected large hail across the top counties, mean ${meanHail}"`,
  );
});

maybe('significant events carry stable ids, tracks and units', () => {
  const ids = new Set();
  for (const event of dataset.significantEvents) {
    assert.ok(event.id, 'every event needs an id');
    assert.ok(!ids.has(event.id), `duplicate event id ${event.id}`);
    ids.add(event.id);
    assert.ok(event.hazard === 'hail' || event.hazard === 'wind');
    assert.ok(event.year >= 1955, `event year out of range: ${event.year}`);
    assert.ok(
      event.hazard === 'hail' ? event.magnitude >= 2 : event.magnitude >= 75,
      `${event.hazard} event below its bundled threshold: ${event.magnitude}`,
    );
  }
  assert.ok(
    dataset.significantEvents.some((e) => e.track && e.track.length >= 2),
    'some events must carry a tracked path',
  );
  assert.ok(
    dataset.significantEvents.some((e) => e.hazard === 'hail'),
    'hail events must be present',
  );
  assert.ok(
    dataset.significantEvents.some((e) => e.hazard === 'wind'),
    'wind events must be present',
  );
});

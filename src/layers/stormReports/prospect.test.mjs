import assert from 'node:assert/strict';
import test from 'node:test';

import { GRID_DEG, gridCell } from '../../data/stormCrossReference.js';
import {
  GRID_DEG_FINE,
  PROSPECT_BANDS,
  PROSPECT_MM_FLOOR,
  PROSPECT_RADIUS_KM,
  gridAreaKm2,
  prospectBand,
  prospectSwathCells,
  radarSwathCells,
} from './model.js';

/**
 * The prospecting view: radar cells that cleared an inch of hail where nobody
 * reported an inch.
 *
 * The function has exactly two inputs that could be wrong in opposite
 * directions - the radar floor and the report floor - and the test set below
 * pins both, plus the radius, which is the one that decides whether the view
 * says anything at all.
 */

/** A swath cell on the coarse grid at a lat/lon, at a radar reading. */
const cellAt = (lat, lon, peakMm, over = {}) => ({
  key: `${gridCell(lat, GRID_DEG)}:${gridCell(lon, GRID_DEG)}`,
  i: gridCell(lat, GRID_DEG),
  j: gridCell(lon, GRID_DEG),
  peakMm,
  ...over,
});

/** A decoded report. `hazard: 0` is hail. */
const reportAt = (lat, lon, size, over = {}) => ({
  hazard: 'hail',
  lat,
  lon,
  size,
  ...over,
});

test('a cell over an inch with nobody in it is unclaimed', () => {
  const out = prospectSwathCells(
    [cellAt(35.1, -97.4, 40)],
    [reportAt(40, -100, 2)],
  );
  assert.equal(out.length, 1, 'the lone cell survives');
  assert.ok(out[0].band, 'and it is banded');
});

test('a report inside the radius claims the cell', () => {
  // Same cell as above, but the report is now ~2 km away.
  const out = prospectSwathCells(
    [cellAt(35.1, -97.4, 40)],
    [reportAt(35.118, -97.4, 2)],
  );
  assert.equal(out.length, 0, 'claimed inside the radius');
});

test('the claim is a radius on the FINE grid, not the report own cell', () => {
  // The bug this kills: testing each report against its OWN grid cell instead
  // of against its distance to each radar cell.
  //
  // On the coarse grid that bug is invisible, and an earlier version of this
  // test ran on the coarse grid and passed against a deliberately broken
  // implementation. It is invisible because a 0.25-degree cell is about 28 km
  // across, so anything within a 9 km radius of a cell centre IS in that cell -
  // the two implementations agree on every single input. They only diverge on
  // the 1 km grid, where the radius spans about eight cells, which is the grid
  // the layer uses whenever you are close enough to care about a lead.
  //
  // Here the report is in the NEXT FINE CELL - roughly 5.6 km north, a different
  // row - so cell-claiming keeps the cell and radius-claiming takes it.
  const fine = cellAt(35.515, -97.395, 40, {
    i: 3551,
    j: -9740,
  });
  const report = reportAt(35.565, -97.395, 2);
  assert.notEqual(
    Math.floor(report.lat / GRID_DEG_FINE),
    fine.i,
    'the report really is in another fine row',
  );
  const out = prospectSwathCells([fine], [report], { stepDeg: GRID_DEG_FINE });
  assert.equal(out.length, 0, 'a report 5.6 km away claims the cell');
});

test('a report far outside the radius does not claim the cell', () => {
  const out = prospectSwathCells(
    [cellAt(35.1, -97.4, 40), cellAt(38.6, -101.2, 45)],
    [reportAt(35.1, -97.4, 2)],
  );
  assert.equal(out.length, 1, 'only the report neighbourhood is claimed');
  assert.equal(out[0].key, cellAt(38.6, -101.2, 45).key);
});

test('the radius is a radius, not the report cell', () => {
  const centre = [35.125, -97.375]; // centre of the 0.25 cell holding 35.1/-97.4
  // A little over 9 km north of that centre.
  const justOutside = [35.208, -97.375];
  const justInside = [35.205, -97.375];

  const out = prospectSwathCells(
    [cellAt(35.1, -97.4, 40)],
    [reportAt(justOutside[0], justOutside[1], 2)],
  );
  assert.equal(out.length, 1, 'just past the radius does not claim');

  const out2 = prospectSwathCells(
    [cellAt(35.1, -97.4, 40)],
    [reportAt(justInside[0], justInside[1], 2)],
  );
  assert.equal(out2.length, 0, 'just inside the radius does');
});

test('the radar floor is one inch, not twenty-five', () => {
  // 25 mm reads as a round number on the colour ramp and is a whole
  // millimetre UNDER an inch. A cell at 25.2 must not be a lead.
  const out = prospectSwathCells([cellAt(35.1, -97.4, 25.2)], []);
  assert.equal(out.length, 0, '25.2 mm is under an inch');
  assert.equal(PROSPECT_MM_FLOOR, 25.4);
  assert.equal(prospectBand(25.4).min, PROSPECT_MM_FLOOR);
});

test('a cell exactly on the inch is included', () => {
  const out = prospectSwathCells([cellAt(35.1, -97.4, 25.4)], []);
  assert.equal(out.length, 1, 'the floor is inclusive');
});

test('a report under an inch cannot claim a cell', () => {
  // Hail the size of a golf ball is real hail and worth a dot on the map, but it
  // is not the claim this view is making: people do not report it.
  const out = prospectSwathCells(
    [cellAt(35.1, -97.4, 60)],
    [reportAt(35.118, -97.4, 0.75)],
  );
  assert.equal(out.length, 1, 'a sub-inch report leaves the cell unclaimed');
});

test('a report of exactly an inch can claim a cell', () => {
  const out = prospectSwathCells(
    [cellAt(35.1, -97.4, 60)],
    [reportAt(35.118, -97.4, 1.0)],
  );
  assert.equal(out.length, 0, 'one inch is the claiming floor');
});

test('wind cannot claim a cell', () => {
  const out = prospectSwathCells(
    [cellAt(35.1, -97.4, 60)],
    [reportAt(35.118, -97.4, 90, { hazard: 'wind' })],
  );
  assert.equal(out.length, 1, 'a gale is not a hail report');
});

test('an implausible reading is never a lead', () => {
  const out = prospectSwathCells(
    [cellAt(35.1, -97.4, 200, { implausible: true })],
    [],
  );
  assert.equal(out.length, 0, 'nobody measured it, so it is not evidence');
});

test('the worst unsuppressed cell comes first', () => {
  const out = prospectSwathCells(
    [cellAt(35.1, -97.4, 30), cellAt(38.6, -101.2, 95), cellAt(33.4, -95.2, 45)],
    [],
  );
  assert.deepEqual(
    out.map((c) => c.peakMm),
    [95, 45, 30],
    'sorted worst first, so the lead is the one you act on',
  );
});

test('the bands are the inch bands the product settled on', () => {
  assert.deepEqual(
    PROSPECT_BANDS.map((b) => b.min),
    [88.9, 38.1, 25.4],
    '3.5", 1.5" and 1 inch',
  );
  assert.equal(prospectBand(89).min, 88.9);
  assert.equal(prospectBand(40).min, 38.1);
  assert.equal(prospectBand(30).min, 25.4);
  assert.equal(prospectBand(25.3), null, 'under an inch has no band');
});

test('a multi-day window does not silently claim the whole map', () => {
  // The bbox fast-path in the claim loop must be conservative: it may admit a
  // few extra pairs to the haversine, but it must never drop a real one. This
  // is the case a short-circuit that rounded the box wrong would break.
  const cells = [];
  for (let lat = 30; lat < 45; lat += 0.25) {
    for (let lon = -120; lon < -70; lon += 0.25) cells.push(cellAt(lat, lon, 40));
  }
  const report = reportAt(35.118, -97.4, 2);
  const out = prospectSwathCells(cells, [report]);
  const claimed = cells.length - out.length;
  assert.equal(claimed, 1, 'exactly the cell nearest the report is claimed');
});

test('no radar source yields no leads rather than every cell', () => {
  assert.deepEqual(prospectSwathCells([], [reportAt(35.1, -97.4, 2)]), []);
  assert.deepEqual(prospectSwathCells(null, []), []);
});

test('it reads straight off a real radar swath', () => {
  // The integration that matters: the cells the layer hands it are the ones
  // `radarSwathCells` produced, not something shaped to suit this test.
  const day = { date: '2026-08-10' };
  const cells = new Map([
    ['1:1', 40],
    ['2:2', 95],
    ['3:3', 10],
  ]);
  const swath = radarSwathCells({ date: day.date, cells }, day);
  // Cell `1:1` has its centre at 0.375/0.375, so that is where the report goes.
  const out = prospectSwathCells(swath, [reportAt(0.375, 0.375, 2)]);
  assert.deepEqual(
    out.map((c) => c.peakMm),
    [95],
    'the 10 mm cell is under an inch and the reported cell is claimed',
  );
});

test('the fine grid is honoured, so a lead is 1 km and not 25 miles', () => {
  const cells = radarSwathCells(
    { date: '2026-08-10', cells: new Map([['3551:-9740', 45]]) },
    { date: '2026-08-10' },
  );
  const out = prospectSwathCells(cells, [], { stepDeg: GRID_DEG_FINE });
  assert.equal(out.length, 1);
  // Row 3551 on the fine grid: 3551 * 0.01 + half a step.
  assert.ok(
    Math.abs(out[0].lat - 35.515) < 1e-9,
    `cell centre on the fine grid, got ${out[0].lat}`,
  );
});

test('area grows with latitude, because a degree does', () => {
  const near = gridAreaKm2([{ lat: 25 }], GRID_DEG);
  const far = gridAreaKm2([{ lat: 45 }], GRID_DEG);
  assert.ok(
    near / far > 1.2,
    `25N should be appreciably bigger than 45N, got ${near}/${far}`,
  );
  assert.equal(gridAreaKm2([], GRID_DEG), 0);
});

test('the default radius is a township', () => {
  assert.equal(PROSPECT_RADIUS_KM, 9);
});
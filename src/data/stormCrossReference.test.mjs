import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RADAR_IMPLAUSIBLE_MM,
  canvassTargets,
  crossReference,
  gridCell,
  indexRadarCells,
  summariseAgreement,
} from './stormCrossReference.js';

/** A packed report row. */
const HAIL = (lat, lon, size) => [
  '2026-05-16',
  600,
  0,
  size,
  lat,
  lon,
  '40027',
  'OK',
  '',
  0,
  '',
  's',
  0,
];

/** A radar feature line, as the builder emits it. */
const RADAR = (i, j, mx) =>
  JSON.stringify({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [j * 0.25 + 0.125, i * 0.25 + 0.125],
    },
    properties: { i, j, d: 0.25, mx, cp: 12, dy: 30, y0: 2026, y1: 2026 },
  });

test('the grid floors, because rounding would break the join', () => {
  // -95.875 is the exact centre of cell j=-384 under floor semantics. Under
  // rounding it would land in -383, half a cell off, and a report could never
  // match the radar core beside it.
  assert.equal(gridCell(-95.875), -384);
  assert.equal(gridCell(-95.8749), -384);
  assert.equal(gridCell(-95.7), -383);
  assert.equal(gridCell(35.125), 140);
});

test('radar cells index on the grid keys the builder emits', () => {
  const { cells, days } = indexRadarCells(
    [RADAR(140, -384, 40), RADAR(141, -384, 30)].join('\n'),
  );
  assert.equal(cells.size, 2);
  assert.equal(cells.get('140:-384').mx, 40);
  assert.equal(days, 30);
});

test('malformed radar lines are skipped rather than killing the file', () => {
  const { cells } = indexRadarCells(
    [
      RADAR(140, -384, 40),
      '{not json',
      '',
      JSON.stringify({ properties: {} }),
    ].join('\n'),
  );
  assert.equal(cells.size, 1);
});

test('a report and a radar core in the same cell agree', () => {
  // 35.125 is the centre of cell i=140.
  const radar = indexRadarCells(RADAR(140, -384, 45)).cells;
  const cells = crossReference([HAIL(35.125, -95.875, 2)], radar);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].agreement, 'both');
  assert.equal(cells[0].reportCount, 1);
  assert.equal(cells[0].reportMax, 2);
  assert.equal(cells[0].radarMaxMm, 45);
});

test('radar with no report is exactly the canvassing lead', () => {
  const radar = indexRadarCells(
    [RADAR(140, -384, 45), RADAR(200, -384, 60)].join('\n'),
  ).cells;
  const cells = crossReference([HAIL(35.125, -95.875, 2)], radar);
  const only = cells.filter((c) => c.agreement === 'radar-only');
  assert.equal(only.length, 1);
  assert.equal(only[0].reportCount, 0);
  assert.equal(only[0].reportMax, null, 'no report means no measured size');
  assert.equal(only[0].radarMaxMm, 60);
});

test('a report below the size bar does not count as agreement', () => {
  const radar = indexRadarCells(RADAR(140, -384, 45)).cells;
  const cells = crossReference([HAIL(35.125, -95.875, 0.75)], radar, {
    minSize: 1.0,
  });
  assert.equal(cells[0].reportCount, 0);
  assert.equal(
    cells[0].agreement,
    'radar-only',
    '0.75in does not satisfy a 1.0in question',
  );
});

test('several reports in one cell collapse to one cell with the largest size', () => {
  const radar = indexRadarCells(RADAR(140, -384, 45)).cells;
  const cells = crossReference(
    [
      HAIL(35.13, -95.87, 1.5),
      HAIL(35.14, -95.86, 2.75),
      HAIL(35.12, -95.88, 1.0),
    ],
    radar,
  );
  assert.equal(cells.length, 1);
  assert.equal(cells[0].reportCount, 3);
  assert.equal(cells[0].reportMax, 2.75);
});

test('a radar estimate beyond what hail does is flagged, not treated as a lead', () => {
  const radar = indexRadarCells(
    [RADAR(140, -384, 428), RADAR(200, -384, 99), RADAR(210, -384, 60)].join(
      '\n',
    ),
  ).cells;
  const cells = crossReference([], radar);
  const artefacts = cells.filter((c) => c.implausible);
  assert.equal(artefacts.length, 1);
  assert.equal(artefacts[0].radarMaxMm, 428);
  const targets = canvassTargets(cells);
  assert.ok(
    !targets.some((t) => t.radarMaxMm === 428),
    'an impossible core must never be offered as somewhere to drive',
  );
  assert.equal(targets[0].radarMaxMm, 99, 'strongest credible core leads');
  assert.equal(RADAR_IMPLAUSIBLE_MM, 100);
});

test('wind is never cross-referenced against hail radar cores', () => {
  const wind = [
    '2026-05-16',
    600,
    1,
    70,
    35.125,
    -95.875,
    '40027',
    'OK',
    '',
    0,
    '',
    's',
    0,
  ];
  const radar = indexRadarCells(RADAR(140, -384, 45)).cells;
  assert.equal(crossReference([wind], radar, { hazard: 'hail' }).length, 1);
  assert.equal(
    crossReference([wind], radar, { hazard: 'hail' })[0].agreement,
    'radar-only',
  );
});

test('the summary separates agreement from artefacts', () => {
  const radar = indexRadarCells(
    [RADAR(140, -384, 45), RADAR(200, -384, 60), RADAR(210, -384, 300)].join(
      '\n',
    ),
  ).cells;
  const cells = crossReference([HAIL(35.125, -95.875, 2)], radar);
  const s = summariseAgreement(cells);
  assert.equal(s.both, 1);
  assert.equal(s.radarOnly, 2);
  assert.equal(s.artefacts, 1);
  assert.equal(s.total, 3);
});

test('an empty comparison summarises to zero rather than dividing by zero', () => {
  const s = summariseAgreement([]);
  assert.deepEqual(s, {
    total: 0,
    both: 0,
    radarOnly: 0,
    radarOnlyShare: 0,
    artefacts: 0,
  });
});

test('canvass targets rank by core strength and respect a limit', () => {
  const radar = indexRadarCells(
    [RADAR(1, 1, 30), RADAR(2, 2, 90), RADAR(3, 3, 55), RADAR(4, 4, 70)].join(
      '\n',
    ),
  ).cells;
  const cells = crossReference([], radar);
  assert.deepEqual(
    canvassTargets(cells, { limit: 2 }).map((c) => c.radarMaxMm),
    [90, 70],
  );
});

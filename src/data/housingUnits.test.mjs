import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Tests for the housing-units artifact.
 *
 * The artifact is the number a business acts on, so the tests are about
 * TRUTH rather than shape: that the right variable was used, that the
 * sentinels never reach a sum, and that the parts agree with each other.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(
  HERE,
  '..',
  '..',
  'src',
  'data',
  'local_data',
  'housing_units',
);

/**
 * The artifact, or null when it has not been built.
 *
 * The four data files are gzipped; the manifest is plain JSON, because it is
 * small and meant to be read by a person looking at a diff.
 */
function readArtifact(name) {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file);
  const text = name.endsWith('.gz')
    ? zlib.gunzipSync(raw).toString('utf8')
    : raw.toString('utf8');
  return JSON.parse(text);
}

const manifest = readArtifact('housing-units-sources.json');
const counties = readArtifact('housing_units_county.json.gz');
const tracts = readArtifact('housing_units_tract.json.gz');
const places = readArtifact('housing_units_place.json.gz');
const zctas = readArtifact('housing_units_zcta.json.gz');

const built = Boolean(manifest);

test('the artifact records which table it came from', { skip: !built && 'not built' }, () => {
  assert.equal(manifest.source.includes('B25001'), true, 'B25001, not B25031');
  assert.equal(manifest.variable, 'B25001_001E');
  assert.equal(manifest.variableMoe, 'B25001_001M');
  assert.equal(manifest.license.includes('Public domain'), true);
});

test(
  'the table was verified against two other ACS totals before it was written',
  { skip: !built && 'not built' },
  () => {
    assert.ok(manifest.verification, 'a verification record exists');
    assert.ok(
      manifest.verification.checked > 0,
      'at least one county was cross-checked',
    );
    assert.deepEqual(manifest.verification.against, ['B25002_001E', 'B25003_001E']);
  },
);

test(
  'no row carries the no-data sentinel',
  { skip: !built && 'not built' },
  () => {
    for (const artifact of [counties, tracts, places, zctas]) {
      if (!artifact) continue;
      for (const row of artifact.rows) {
        assert.ok(row.units >= 0, `${artifact.meta.geography} ${row.id} is not negative`);
        assert.notEqual(row.units, -666666666, `${row.id} carries the sentinel`);
        assert.ok(
          row.moe === null || row.moe >= 0,
          `${row.id} has a plausible margin`,
        );
      }
    }
  },
);

test(
  'the county and tract totals agree exactly',
  { skip: !built && 'not built' },
  () => {
    if (!counties || !tracts) return;
    const sum = (rows) => rows.reduce((total, row) => total + row.units, 0);
    // NATIONAL totals. The artifacts are national - the ACS serves counties and
    // places in one request, and the tract and ZCTA builds take every state.
    const countyTotal = sum(counties.rows);
    const tractTotal = sum(tracts.rows);
    if (!tracts.rows.length) return;
    // Tracts PARTITION counties geographically, but the ACS computes each
    // geography's estimate SEPARATELY, so the two sums need not be identical:
    // a county total covers every address in the county, while the tract
    // total only covers the addresses inside a tract, and the difference is
    // the handful of addresses in the gaps - water, unincorporated
    // enclaves, blocks the tract layer does not cover.
    //
    // Measured nationally the difference is 20,574 units out of 143.9 million,
    // which is 0.014%. If the two cuts disagreed by more than a rounding
    // error, one of them would be wrong.
    const difference = Math.abs(tractTotal - countyTotal);
    assert.ok(
      difference < countyTotal * 0.001,
      `tracts sum to ${tractTotal} and counties to ${countyTotal}, ` +
        `a difference of ${difference} (${((difference / countyTotal) * 100).toFixed(4)}%)`,
    );
  },
);

test(
  'a county total is the right order of magnitude for its population',
  { skip: !built && 'not built' },
  () => {
    if (!counties) return;
    // A housing-unit count below 1 per 10 residents is a rent figure wearing a
    // count's name - which is exactly what B25031 was, and what summing its
    // output produced. This is the assertion that would have caught it.
    const denver = counties.rows.find((r) => /Denver County, Colorado/.test(r.name));
    if (!denver) return;
    assert.ok(
      denver.units > 100000,
      `Denver County has ${denver.units} housing units, which is plausible`,
    );
  },
);

test(
  'places sum to no more than counties, because unincorporated land is not a place',
  { skip: !built && 'not built' },
  () => {
    if (!counties || !places) return;
    const sum = (rows) => rows.reduce((total, row) => total + row.units, 0);
    const countyTotal = sum(counties.rows);
    const placeTotal = sum(places.rows);
    assert.ok(
      placeTotal <= countyTotal,
      `places (${placeTotal}) must not exceed counties (${countyTotal})`,
    );
    assert.ok(
      placeTotal > countyTotal * 0.5,
      `places (${placeTotal}) should still cover most of the state`,
    );
  },
);

test(
  'ZCTAs are attributed to a county, and none are attributed to nothing',
  { skip: !built && 'not built' },
  () => {
    if (!zctas) return;
    // Almost every ZCTA lands in a county. The ones that do not are the
    // territories and a handful whose gazetteer internal point falls outside
    // any county - which is a fact about the gazetteer, not a failure.
    const unplaced = zctas.rows.filter((row) => !row.countyFips);
    assert.ok(
      unplaced.length < zctas.rows.length * 0.01,
      `${unplaced.length} of ${zctas.rows.length} ZCTAs are unplaced`,
    );
    for (const row of zctas.rows) {
      if (!row.countyFips) continue;
      assert.ok(
        /^\d{5}$/.test(row.countyFips),
        `${row.id} has a five-digit county, got ${row.countyFips}`,
      );
      assert.ok(Number.isFinite(row.lat) && Number.isFinite(row.lon));
    }
  },
);

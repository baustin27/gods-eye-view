// Bundled populated places: name matching, the point-not-outline contract,
// duplicate-name disambiguation, box queries and lazy loading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import {
  approxRadiusKm,
  findPlace,
  packLoads,
  parsePlaceQuery,
  placeBox,
  placesForBox,
} from './places.js';

const PACK = new URL('./local_data/natural_earth/places.json', import.meta.url);

const DENVER = { lat: 39.739, lon: -104.99 };
const PORTLAND = { lat: 44.05, lon: -122.98 };
const BOSTON = { lat: 42.36, lon: -71.06 };

// Runs first: importing the module loads nothing, and one lookup loads the pack
// exactly once.
test('the pack loads lazily, once, and only on a lookup', async () => {
  assert.deepEqual(packLoads, { places: 0 });
  assert.deepEqual(parsePlaceQuery('Denver').qualifiers, [], 'parsing is free');
  assert.deepEqual(packLoads, { places: 0 });
  assert.ok(await findPlace('Denver'));
  assert.deepEqual(packLoads, { places: 1 });
  await findPlace('Oklahoma City');
  await findPlace('Springfield, Illinois');
  await placesForBox([-180, -90, 180, 90]);
  assert.deepEqual(packLoads, { places: 1 }, 'one load serves every lookup');
});

test('a city resolves to a point, and never claims to be an outline', async () => {
  const denver = await findPlace('Denver');
  assert.equal(denver.name, 'Denver');
  assert.equal(denver.kind, 'place');
  assert.equal(denver.id, 'denver-usa');
  assert.equal(denver.country, 'United States of America');
  assert.equal(denver.region, 'Colorado');
  assert.equal(denver.population, 2_313_000);
  assert.ok(Math.abs(denver.lat - 39.741) < 0.01, `lat ${denver.lat}`);
  assert.ok(Math.abs(denver.lon + 104.986) < 0.01, `lon ${denver.lon}`);
  // The honesty contract: this dataset has no city geometry, and the result
  // says so rather than letting a caller assume an outline.
  assert.equal(denver.boundary, null);
  assert.equal(denver.polygons, undefined);
  assert.ok(
    denver.approxRadiusKm > 10 && denver.approxRadiusKm < 40,
    `approxRadiusKm ${denver.approxRadiusKm}`,
  );
  const [west, south, east, north] = denver.bbox;
  assert.ok(west < denver.lon && denver.lon < east);
  assert.ok(south < denver.lat && denver.lat < north);
  assert.ok(
    Math.abs(north - south - (denver.approxRadiusKm * 2) / 111.32) < 1e-9,
  );
});

test('a radius grows with population and stays a guess, not an edge', () => {
  assert.equal(approxRadiusKm(0), 5, 'an unknown population is the floor');
  assert.equal(approxRadiusKm(832), 5, 'Vatican City sits at the floor');
  assert.equal(approxRadiusKm(1_000_000_000), 120, 'and at the ceiling');
  let previous = 0;
  for (const population of [5_000, 50_000, 500_000, 5_000_000, 35_000_000]) {
    const radius = approxRadiusKm(population);
    assert.ok(radius > previous, `${population} widens`);
    previous = radius;
  }
  // Damped, not linear: ten times the people is not ten times the box.
  assert.ok(approxRadiusKm(1_000_000) < 5 * approxRadiusKm(100_000));
  const tokyo = placeBox({ lat: 35.69, lon: 139.69, population: 35_676_000 });
  assert.ok(tokyo[2] - tokyo[0] > 1, 'a big city gets a wide box');
  assert.deepEqual(
    placeBox({ lat: 0, lon: 0, population: 10_000 }, { radiusKm: 111.32 }),
    [-1, -1, 1, 1],
    'an explicit radius is honoured, in degrees not km',
  );
  // A box near a pole would otherwise run away to the antimeridian.
  const arctic = placeBox({ lat: 84, lon: 20, population: 100_000 });
  assert.ok(
    arctic[2] - arctic[0] < 180,
    `arctic width ${arctic[2] - arctic[0]}`,
  );
});

test('one name, one place: the city people type finds the city NE holds', async () => {
  // Natural Earth calls the largest US city "New York"; people write
  // "New York City".
  assert.equal((await findPlace('New York'))?.id, 'new-york-usa');
  assert.equal((await findPlace('New York City'))?.id, 'new-york-usa');
  // "Oklahoma City" is a name in its own right, not an alias of "Oklahoma".
  const okc = await findPlace('Oklahoma City');
  assert.equal(okc.id, 'oklahoma-city-usa');
  assert.equal(okc.region, 'Oklahoma');
  assert.equal(okc.population, 788_000);
  assert.equal(await findPlace('Oklahoma'), null, 'no such place');
  // Accents and case normalize exactly as administrative names do.
  assert.equal((await findPlace('SÃO PAULO'))?.id, 'sao-paulo-bra');
  assert.equal((await findPlace('Québec City'))?.id, 'quebec-can');
  assert.equal((await findPlace('  dEnVeR  '))?.id, 'denver-usa');
});

test('a miss is a miss, and it is never a throw', async () => {
  for (const query of [
    'Flurpy',
    'Not A Real Place At All',
    'Texas',
    'Bavaria',
    'Denver County',
    'Alps',
    'Denver Colorado USA Denver',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
  ])
    assert.equal(await findPlace(query), null, String(query));
  // A qualifier that places nothing rejects the whole ask rather than
  // silently answering with the unqualified city.
  assert.equal(await findPlace('Denver, Nowhere'), null);
  assert.equal(await findPlace('Denver, Colorado, Texas'), null);
});

test('duplicate names settle on a qualifier, then the camera, then size', async () => {
  // Five Springfields, all in the United States, so a qualifier is the only
  // thing but the camera that can tell them apart.
  const bare = await findPlace('Springfield');
  assert.equal(bare.candidates, 5);
  assert.equal(bare.region, 'Massachusetts', 'largest wins without a camera');
  assert.equal((await findPlace('Springfield, Illinois'))?.region, 'Illinois');
  assert.equal((await findPlace('Springfield, Missouri'))?.region, 'Missouri');
  assert.equal((await findPlace('Springfield, Oregon'))?.region, 'Oregon');
  // The code a person actually types.
  assert.equal((await findPlace('Springfield, MO'))?.adm1code, 'MO');
  assert.equal((await findPlace('Springfield, MO'))?.region, 'Missouri');
  assert.equal((await findPlace('Springfield, IL'))?.region, 'Illinois');
  assert.equal(await findPlace('Springfield, MO, Oregon'), null);
  // The camera settles what the words do not.
  assert.equal(
    (await findPlace('Springfield', { near: PORTLAND }))?.region,
    'Oregon',
  );
  assert.equal(
    (await findPlace('Springfield', { near: BOSTON }))?.region,
    'Massachusetts',
  );
  // A qualifier that names no Springfield settles nothing.
  assert.equal(await findPlace('Springfield, AK'), null);
  // minPopulation is a filter applied before ranking, not after.
  assert.equal(
    (await findPlace('Springfield', { minPopulation: 200_000 }))?.region,
    'Massachusetts',
  );
  assert.equal(
    await findPlace('Springfield', { minPopulation: 500_000 }),
    null,
  );
});

test('qualifiers place a city in its own country too', async () => {
  assert.equal((await findPlace('Naples'))?.candidates, 2);
  assert.equal((await findPlace('Naples, Italy'))?.id, 'naples-ita');
  assert.equal((await findPlace('Naples, Florida'))?.region, 'Florida');
  assert.equal((await findPlace('Naples, ITA'))?.id, 'naples-ita');
  assert.equal((await findPlace('Naples, US'))?.id, 'naples-usa');
  // A city-state and a subdivision code.
  assert.equal((await findPlace('Berlin, DE'))?.id, 'berlin-deu');
  assert.equal((await findPlace('Toronto, ON'))?.region, 'Ontario');
  assert.equal((await findPlace('Cologne, NW'))?.country, 'Germany');
  // A country or region name matches in any case; a code must be written as a
  // code, because "Springfield, Missouri" and "Springfield, MO" are the same
  // ask and a lowercase "mo" is not Missouri.
  assert.equal(await findPlace('springfield, mo'), null);
  assert.equal(await findPlace('Denver, co'), null);
  assert.equal(await findPlace('Naples, usa'), null);
  assert.equal((await findPlace('Springfield, missouri'))?.region, 'Missouri');
});

test('the ask is split into a name and what places it', () => {
  assert.equal(parsePlaceQuery('Denver').name, 'denver');
  assert.deepEqual(parsePlaceQuery('Denver, Colorado').qualifiers, [
    { raw: 'Colorado', key: 'colorado' },
  ]);
  assert.deepEqual(
    parsePlaceQuery('New York City').aliases,
    ['new york'],
    'the "City" spelling is a second try, not the name',
  );
  assert.deepEqual(parsePlaceQuery('Oklahoma City').aliases, ['oklahoma']);
  assert.deepEqual(parsePlaceQuery('Springfield, MO, USA').qualifiers, [
    { raw: 'MO', key: 'mo' },
    { raw: 'USA', key: 'usa' },
  ]);
  assert.equal(parsePlaceQuery(''), null);
  assert.equal(parsePlaceQuery(' , '), null);
});

test('every place in a box, largest first', async () => {
  const oklahoma = await placesForBox([-102.05, 33.6, -94.4, 37.0]);
  assert.ok(oklahoma.length > 10, `${oklahoma.length} places in Oklahoma`);
  assert.equal(oklahoma[0].name, 'Tulsa', 'largest first');
  assert.equal(oklahoma[1].name, 'Oklahoma City');
  for (let i = 1; i < oklahoma.length; i += 1)
    assert.ok(
      oklahoma[i - 1].population >= oklahoma[i].population,
      `${oklahoma[i - 1].name} then ${oklahoma[i].name}`,
    );
  // Both ends are inclusive, and `candidates` counts the box, not the answer.
  assert.equal(oklahoma[0].candidates, oklahoma.length);
  const limited = await placesForBox([-102.05, 33.6, -94.4, 37.0], {
    limit: 2,
  });
  assert.deepEqual(
    limited.map((p) => p.name),
    ['Tulsa', 'Oklahoma City'],
  );
  assert.equal(limited[0].candidates, oklahoma.length, 'still reports the box');
  const floored = await placesForBox([-102.05, 33.6, -94.4, 37.0], {
    minPopulation: 500_000,
  });
  assert.deepEqual(
    floored.map((p) => p.name),
    ['Tulsa', 'Oklahoma City'],
  );
  // A tight box finds the metro, not the state.
  assert.deepEqual(
    (await placesForBox([-105.2, 39.2, -104.2, 40.2])).map((p) => p.name),
    ['Denver', 'Aurora'],
  );
  assert.deepEqual(
    await placesForBox([10, 50, 5, 20]),
    [],
    'a north-wound box',
  );
  assert.deepEqual(
    await placesForBox([-140, -40, -139, -39]),
    [],
    'the empty South Pacific',
  );
});

test('a box is a span, so it crosses the antimeridian', async () => {
  // Alaska at -150° is 40° east of 171°: the box has to say so.
  const alaska = await placesForBox([171, 51, 215, 66]);
  assert.ok(
    alaska.some((p) => p.name === 'Anchorage'),
    `${alaska.length} places`,
  );
  assert.deepEqual(await placesForBox([171, 51, 189, 56]), [], 'short of it');
  // A box spanning the whole world holds every place, and no wrapping drops
  // the ones near ±180°.
  const pack = JSON.parse(readFileSync(PACK, 'utf8'));
  assert.equal(
    (await placesForBox([-180, -90, 180, 90])).length,
    pack.features.length,
  );
});

test('pack: public-domain provenance, curation, and a sane payload', () => {
  const pack = JSON.parse(readFileSync(PACK, 'utf8'));
  assert.match(pack.meta.license, /public domain/i);
  assert.match(pack.meta.sha256, /^[0-9a-f]{64}$/);
  assert.match(pack.meta.subdivisionSha256, /^[0-9a-f]{64}$/);
  assert.equal(pack.meta.script, 'scripts/build-admin-packs.mjs');
  assert.equal(pack.meta.decimals, 3);
  assert.equal(pack.meta.curation.minPopulation, 5_000);
  assert.equal(pack.meta.curation.keepNationalCapitals, true);
  // The pack says out loud that it is points, not outlines.
  assert.match(pack.meta.approximate, /POINT, NOT AN OUTLINE/);

  const floor = pack.meta.curation.minPopulation;
  const { features } = pack;
  assert.ok(features.length > 6_000, `${features.length} places`);
  assert.ok(features.length < 7_000, 'the floor has to bite something');
  const ids = new Set();
  for (const feature of features) {
    assert.ok(feature.name, 'named');
    assert.ok(feature.lat > -90 && feature.lat < 90, `${feature.name} lat`);
    assert.ok(feature.lon > -180 && feature.lon < 180, `${feature.name} lon`);
    assert.ok(feature.population >= 0, `${feature.name} population`);
    assert.ok(Number.isFinite(feature.scale), `${feature.name} scale`);
    assert.equal(feature.polygons, undefined, 'a place has no geometry');
    assert.equal(
      Math.round(feature.lat * 1000) / 1000,
      feature.lat,
      `${feature.name} lat rounded to meta.decimals`,
    );
    assert.ok(!ids.has(feature.id), `${feature.id} is unique`);
    ids.add(feature.id);
  }
  // Only a national capital is kept below the floor, and the capitals that are
  // below it are tiny (Vatican City, Palikir, Funafuti).
  const below = features.filter((f) => f.population < floor);
  assert.ok(below.length < 10, `${below.length} below the floor`);
  assert.ok(
    below.every((f) => f.population < 5_000),
    'an exemption is a capital nobody would call a city anyway',
  );
  // A national capital that is small is still here.
  assert.ok(
    features.some((f) => f.name === 'Vatican City' && f.population < floor),
    'Vatican City is kept',
  );
  // Natural Earth's -99 "population unknown" sentinel is not a population.
  assert.equal(
    features.some((f) => f.population < 0),
    false,
  );
  // Rural coverage: a floor that emptied the plains would be the wrong floor.
  const unitedStates = features.filter((f) => f.iso === 'USA');
  assert.ok(unitedStates.length > 600, `${unitedStates.length} US places`);
  assert.ok(
    unitedStates.filter((f) => f.population < 50_000).length > 200,
    'small US towns survive',
  );
  assert.ok(statSync(PACK).size <= 1.25 * 1024 * 1024, 'place pack ≤ 1.25 MB');
});

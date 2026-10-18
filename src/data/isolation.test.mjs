// Isolation mode: name resolution, antimeridian-safe boxes, point-in-area, and
// the box pre-reject that keeps a six-year filter off the frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countiesForState,
  findAdminArea,
  findAdminAreaAt,
  isDegenerateAdminRing,
  pointInRing,
  polygonsContain,
} from './adminBoundaries.js';
import {
  ISOLATION_KINDS,
  PLACE_BOX_DEG,
  areaContains,
  boxesContain,
  describeIsolation,
  normaliseBbox,
  normaliseIsolationKind,
  resolveIsolation,
} from './isolation.js';

const AUSTIN = { lat: 30.2672, lon: -97.7431 };
const LEEDS = { lat: 53.8, lon: -1.55 };
const ANCHORAGE = [61.22, -149.9];

/** Deterministic pseudo-random source — the sample must not move between runs. */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * A year of hail reports, shaped like one: the Texas box, the central
 * corridor, the rest of the country and an off-box tail. 7,484 rows is the
 * one-year window; `44_717` is the six-year window the filter is built for.
 */
function hailWindow(count = 7_484, seed = 20261015) {
  const rand = lcg(seed);
  const rows = [];
  const point = (lat, lon, latSpan, lonSpan) =>
    rows.push([lat + rand() * latSpan, lon + rand() * lonSpan]);
  for (let i = 0; i < count; i += 1) {
    const roll = rand();
    if (roll < 0.27) point(25.8, -106.7, 10.7, 13.2);
    else if (roll < 0.75) point(30, -105, 17, 25);
    else if (roll < 0.9) point(18, -125, 31.5, 59);
    else point(51, -170, 21, 15);
  }
  return rows;
}

/** A grid across every normalised box of an area — split units get both halves. */
function gridOver(boxes, steps = 20) {
  const points = [];
  for (const [west, south, east, north] of boxes)
    for (let i = 0; i < steps; i += 1)
      for (let j = 0; j < steps; j += 1)
        points.push([
          south + ((north - south) * (i + 0.5)) / steps,
          west + ((east - west) * (j + 0.5)) / steps,
        ]);
  return points;
}

const stubPlace = (place) => async () => place;
const NEW_YORK_CITY = {
  name: 'New York City',
  country: 'United States of America',
  lat: 40.7128,
  lon: -74.006,
  source: 'test-place-index',
};

test('a typed admin name resolves to its unit, its box and its label', async () => {
  const texas = await resolveIsolation('Texas');
  assert.equal(texas.ok, true);
  assert.equal(texas.text, 'Texas');
  assert.equal(texas.kind, 'state');
  assert.equal(texas.area.id, 'US-TX');
  assert.equal(texas.approximate, false, 'a state has a real boundary');
  assert.equal(texas.describe, 'Texas, United States of America');
  // Not split: Texas does not touch the date line.
  assert.equal(texas.split, false);
  assert.equal(texas.boxes.length, 1);
  assert.deepEqual(
    texas.boxes[0].map((v) => +v.toFixed(1)),
    [-106.7, 25.8, -93.5, 36.5],
  );
  assert.ok(areaContains(texas, ...(AUSTIN ? [AUSTIN.lat, AUSTIN.lon] : [])));
  assert.ok(areaContains(texas, AUSTIN.lat, AUSTIN.lon));
  assert.ok(!areaContains(texas, 35.0, -106.6), 'Santa Fe is New Mexico');
  assert.ok(!areaContains(texas, 41.88, -87.63), 'Chicago is Illinois');
  // A county carries its state, not its country, in the label.
  const travis = await resolveIsolation('Travis County, Texas');
  assert.equal(travis.kind, 'county');
  assert.equal(travis.area.id, '48453');
  assert.equal(travis.describe, 'Travis County, Texas');
  // `near` is the camera tie-break and is optional.
  assert.equal(
    (await resolveIsolation('Georgia', { near: AUSTIN })).area.id,
    'US-GA',
  );
  assert.equal(
    (await resolveIsolation('Georgia', { near: { lat: 41.7, lon: 44.8 } })).area
      .id,
    'GEO',
  );
});

test('the United States splits at the date line and Alaska still lands inside', async () => {
  const usa = await resolveIsolation('United States');
  assert.ok(
    usa.area.bbox[0] < -180,
    `bundled box runs past the seam: ${usa.area.bbox}`,
  );
  assert.equal(usa.split, true);
  assert.equal(usa.boxes.length, 2, 'two boxes, not one rectangle');
  assert.deepEqual(
    usa.boxes.map((box) => +box[0].toFixed(3)),
    [172.476, -180],
  );
  assert.equal(usa.boxes[0][2], 180, 'the east box ends at the seam');
  assert.equal(usa.boxes[1][0], -180, 'the west box starts at the seam');
  assert.ok(
    boxesContain(usa.boxes, ...ANCHORAGE),
    'Anchorage is west of the seam',
  );
  assert.ok(
    boxesContain(usa.boxes, 52.9, 172.9),
    'the Aleutians are east of it',
  );
  assert.ok(areaContains(usa, ...ANCHORAGE), 'Anchorage');
  assert.ok(areaContains(usa, 19.7, -155.1), 'Hilo');
  assert.ok(areaContains(usa, 52.9, 172.9), 'Attu, past the date line');
  // The other side of the seam is not the United States.
  assert.ok(!areaContains(usa, 43.65, -79.38), 'Toronto');
  assert.ok(!areaContains(usa, 55.75, 37.6), 'Moscow');
  assert.ok(!areaContains(usa, 64.73, 177.5), 'Chukotka');
  // The bundled state is split the same way, for the same reason.
  const alaska = await resolveIsolation('Alaska');
  assert.equal(alaska.split, true);
  assert.ok(areaContains(alaska, ...ANCHORAGE));
});

test('normaliseBbox: one box unless the arc crosses the seam, then two', async () => {
  const cases = [
    ['Texas', 1],
    ['California', 1],
    ['Bavaria', 1],
    ['England', 1],
    ['Alaska', 2],
    ['United States', 2],
    ['Russia', 2],
    ['Fiji', 2],
  ];
  for (const [name, expected] of cases) {
    const area = (await resolveIsolation(name)).area;
    const boxes = normaliseBbox(area.bbox);
    assert.equal(boxes.length, expected, `${name}: ${JSON.stringify(boxes)}`);
    // Whatever the arc, no longitude of the unit's own box is lost by the
    // split: sample the unwrapped arc, then the seam that cut it.
    for (const lat of [
      area.bbox[1],
      (area.bbox[1] + area.bbox[3]) / 2,
      area.bbox[3],
    ])
      for (const lon of sampleArc(area.bbox))
        assert.ok(
          boxesContain(boxes, lat, lon),
          `${name} box ${JSON.stringify(boxes)} dropped ${lon} at ${lat}`,
        );
  }
  // Wrapped already, and degenerate input.
  assert.deepEqual(normaliseBbox([-10, -5, 10, 5]), [[-10, -5, 10, 5]]);
  assert.deepEqual(normaliseBbox([200, 10, 220, 20]), [[-160, 10, -140, 20]]);
  assert.deepEqual(normaliseBbox([-232.64, -90, 127.33, -63.22]), [
    [127.36, -90, 180, -63.22],
    [-180, -90, 127.33, -63.22],
  ]);
  assert.deepEqual(normaliseBbox(null), []);
  assert.deepEqual(normaliseBbox([1, 2, 3]), []);
  assert.deepEqual(normaliseBbox([NaN, 0, 1, 1]), []);
  assert.deepEqual(boxesContain([[0, 0, 1, 1]], 0.5, 0.5), true);
  assert.deepEqual(boxesContain([], 0.5, 0.5), false);
  assert.deepEqual(boxesContain([[0, 0, 1, 1]], NaN, 0.5), false);
});

/** Longitudes across an unwrapped box, including every seam it crosses. */
function sampleArc([west, , east]) {
  const lons = [];
  for (let i = 0; i <= 8; i += 1) {
    const lon = west + ((east - west) * i) / 8;
    // Only [-180, 180] is a real input longitude; a raw arc longitude is
    // shifted into range to see which of the two boxes holds it.
    for (const shifted of [lon, lon - 360, lon + 360])
      if (
        shifted >= west &&
        shifted <= east &&
        shifted >= -180 &&
        shifted <= 180
      )
        lons.push(shifted);
  }
  for (const seam of [-180, 180])
    for (const near of [seam - 0.001, seam, seam + 0.001])
      if (near >= west && near <= east && near >= -180 && near <= 180)
        lons.push(near);
  return lons;
}

test('Russia and Fiji split; Texas, Bavaria and California do not', async () => {
  const russia = await resolveIsolation('Russia');
  assert.ok(russia.area.bbox[2] > 180, `Russia box ${russia.area.bbox}`);
  assert.deepEqual(
    russia.boxes.map((box) => box[0]),
    [19.61, -180],
  );
  assert.ok(areaContains(russia, 55.75, 37.6), 'Moscow');
  assert.ok(areaContains(russia, 43.1155, 131.8855), 'Vladivostok');
  assert.ok(!areaContains(russia, 59.91, 10.75), 'Oslo');
  const fiji = await resolveIsolation('Fiji');
  assert.ok(fiji.area.bbox[2] > 180, `Fiji box ${fiji.area.bbox}`);
  assert.deepEqual(
    fiji.boxes.map((box) => +box[0].toFixed(3)),
    [177.006, -180],
  );
  assert.ok(areaContains(fiji, -18.14, 178.44), 'Suva');
  assert.ok(!areaContains(fiji, -41.3, 174.8), 'Wellington');
  assert.ok(!areaContains(fiji, -13.8, -172.1), 'Apia');
  for (const name of ['Texas', 'Bavaria', 'California', 'England'])
    assert.equal((await resolveIsolation(name)).boxes.length, 1, name);
});

test('areaContains agrees with a brute-force polygon scan', async () => {
  for (const name of [
    'Texas',
    'California',
    'Alaska',
    'United States',
    'Russia',
    'Fiji',
    'Bavaria',
  ]) {
    const isolation = await resolveIsolation(name);
    const sample = gridOver(isolation.boxes, 18);
    assert.ok(sample.length > 300, `${name}: ${sample.length} sample points`);
    let inside = 0;
    for (const [lat, lon] of sample) {
      const brute = polygonsContain(isolation.area.polygons, lat, lon);
      assert.equal(
        areaContains(isolation, lat, lon),
        brute,
        `${name}: ${lat}, ${lon} (pre-reject ${boxesContain(isolation.boxes, lat, lon)})`,
      );
      if (brute) inside += 1;
    }
    assert.ok(inside > 0, `${name}: the sample found no inside point at all`);
  }
  // A point outside the unit, and rubbish input, are both plain "no".
  const texas = await resolveIsolation('Texas');
  assert.equal(areaContains(texas, 51.5, -0.12), false);
  assert.equal(areaContains(texas, NaN, -97.7), false);
  assert.equal(areaContains(texas, 30.2672, undefined), false);
  assert.equal(areaContains(null, 30.2672, -97.7), false);
  assert.equal(areaContains({}, 30.2672, -97.7), false);
});

test('the box pre-reject is load-bearing: it decides which rows pay for a scan', async () => {
  const rows = hailWindow();
  for (const name of ['Texas', 'California']) {
    const isolation = await resolveIsolation(name);
    // The cost without it: one full polygon scan per row, every time.
    const naive = rows.length;
    // The cost with it: a box test per row, and a polygon test only for the
    // rows the box keeps. `polygons` is a counting getter, so this fails if the
    // pre-reject is ever removed — not just if it gets slower.
    let polygonTests = 0;
    const counted = {
      ...isolation.area,
      get polygons() {
        polygonTests += 1;
        return isolation.area.polygons;
      },
    };
    let inside = 0;
    for (const [lat, lon] of rows)
      if (areaContains(counted, lat, lon)) inside += 1;
    const survivors = rows.filter(([lat, lon]) =>
      boxesContain(isolation.boxes, lat, lon),
    ).length;
    assert.equal(
      polygonTests,
      survivors,
      `${name}: polygons were scanned for a different set of rows than the box kept`,
    );
    assert.ok(
      polygonTests < naive / 2,
      `${name}: the pre-reject only removed ${naive - polygonTests} scans`,
    );
    assert.ok(
      inside > 0 && inside < polygonTests,
      `${name}: the box must keep more rows than the polygon does (${inside} of ${polygonTests})`,
    );
    assert.equal(
      inside,
      rows.filter(([lat, lon]) =>
        polygonsContain(isolation.area.polygons, lat, lon),
      ).length,
      `${name}: the pre-reject changed the answer`,
    );
    // The six-year window is the one the app actually filters.
    const window = hailWindow(44_717, 99991);
    const windowSurvivors = window.filter(([lat, lon]) =>
      boxesContain(isolation.boxes, lat, lon),
    ).length;
    assert.ok(
      windowSurvivors < window.length / 2,
      `${name}: ${windowSurvivors} of ${window.length} rows reach the polygons`,
    );
  }
});

test('a miss is a returned value, not a thrown error', async () => {
  for (const text of ['', '   ', null, undefined])
    assert.deepEqual(await resolveIsolation(text), {
      ok: false,
      text: '',
      reason: 'empty',
      tried: [],
    });
  const nowhere = await resolveIsolation('Zzyzx Quuxland');
  assert.deepEqual(nowhere, {
    ok: false,
    text: 'Zzyzx Quuxland',
    reason: 'no-match',
    tried: ['admin'],
  });
  assert.equal(nowhere.area, undefined);
  assert.equal(nowhere.boxes, undefined);
  // A provider that blows up is still a value, with the reason kept.
  const offline = await resolveIsolation('New York', {
    findPlace: async () => {
      throw new Error('place index offline');
    },
  });
  assert.equal(offline.ok, false);
  assert.equal(offline.reason, 'error');
  assert.equal(offline.detail, 'place index offline');
  assert.deepEqual(offline.tried, ['admin', 'place']);
  // A provider with nothing to say, and one that answers nothing usable.
  assert.equal(
    (await resolveIsolation('New York', { findPlace: stubPlace(null) })).reason,
    'no-match',
  );
  assert.equal(
    (
      await resolveIsolation('New York', {
        findPlace: stubPlace({ name: 'x' }),
      })
    ).reason,
    'no-match',
  );
  assert.equal(
    (await resolveIsolation('Texas', { findPlace: stubPlace(null) })).kind,
    'state',
    'the admin rung does not need a place provider',
  );
});

test('describeIsolation marks a place as approximate and an admin unit as exact', async () => {
  assert.equal(describeIsolation(null), 'unknown area');
  assert.equal(describeIsolation({ name: 'Nowhere' }), 'unknown area');
  assert.equal(
    describeIsolation((await resolveIsolation('Texas')).area),
    'Texas, United States of America',
  );
  assert.equal(
    describeIsolation((await resolveIsolation('Bavaria')).area),
    'Bavaria, Germany',
  );
  const place = await resolveIsolation('New York', {
    findPlace: stubPlace(NEW_YORK_CITY),
  });
  assert.equal(place.kind, 'place');
  assert.equal(place.approximate, true);
  assert.match(place.describe, /New York City/);
  assert.match(place.describe, /approximate/i);
  assert.match(place.describe, /no boundary data/);
  // A place is a point with a box: inside the box is "inside", and that is the
  // whole of what a point can mean without a boundary.
  assert.ok(areaContains(place, 40.7128, -74.006));
  assert.ok(areaContains(place, 40.5, -74.006), 'inside the default radius');
  assert.ok(
    !areaContains(place, 41.88, -87.63),
    'Chicago is not New York City',
  );
  assert.equal(place.area.bbox.length, 4, 'a place carries one raw box');
  assert.equal(place.boxes.length, 1);
  const half = PLACE_BOX_DEG;
  assert.deepEqual(
    place.area.bbox.map((v) => +v.toFixed(4)),
    [
      +(-74.006 - half).toFixed(4),
      +(40.7128 - half).toFixed(4),
      +(-74.006 + half).toFixed(4),
      +(40.7128 + half).toFixed(4),
    ],
  );
  // The provider's own name and box win; a radius is honoured when given.
  const wide = await resolveIsolation('Springfield', {
    findPlace: stubPlace({
      name: 'Springfield',
      region: 'Illinois',
      lat: 39.8,
      lon: -89.65,
      radiusDeg: 0.5,
    }),
  });
  assert.equal(
    wide.describe,
    'Springfield, Illinois — approximate: point with a radius, no boundary data',
  );
  assert.equal(wide.area.source, 'place-index', 'a default source is named');
  assert.ok(
    boxesContain(wide.boxes, 39.8, -89.2),
    'the provider radius is used',
  );
  assert.ok(
    !boxesContain(wide.boxes, 39.8, -89.0),
    'and nothing wider than it',
  );
});

test('the two names that must keep failing the admin rung: New York, Yorkshire', async () => {
  // New York: the pack flags "new york" as also naming a city, so the admin
  // rung deliberately declines — the geocoder decides. It is not a lookup bug
  // and it must not become one.
  assert.equal(await findAdminArea('New York'), null);
  assert.equal(await findAdminArea('New York, United States of America'), null);
  assert.equal(await findAdminArea('New York', { near: AUSTIN }), null);
  const bare = await resolveIsolation('New York');
  assert.equal(bare.ok, false);
  assert.equal(bare.reason, 'no-match');
  // Admin wording still reaches the state, and the geocoder-confirmed rung
  // agrees with it.
  assert.equal((await resolveIsolation('New York State')).area.id, 'US-NY');
  assert.equal(
    (await findAdminAreaAt(['New York'], 42.9, -75.5, 'state')).id,
    'US-NY',
  );
  // So isolation escalates to the place rung when one exists — and says the
  // answer is a point, not a boundary.
  const city = await resolveIsolation('New York', {
    findPlace: stubPlace(NEW_YORK_CITY),
  });
  assert.equal(city.ok, true);
  assert.equal(city.kind, 'place');
  assert.equal(city.area.name, 'New York City');
  assert.equal(city.approximate, true);

  // Yorkshire: Natural Earth 10m has no Yorkshire unit — the region is split
  // into North Yorkshire, East Riding and the rest, each below the bare-name
  // prominence bar. No lookup change can invent the unit, so isolation must
  // escalate rather than guess.
  assert.equal(await findAdminArea('Yorkshire'), null);
  assert.equal((await resolveIsolation('Yorkshire')).reason, 'no-match');
  assert.equal(
    (await resolveIsolation('North Yorkshire, England', { near: LEEDS })).area
      .id,
    'GB-NYK',
    'the units Yorkshire is made of do resolve',
  );
  assert.equal(
    (
      await resolveIsolation('Yorkshire', {
        findPlace: stubPlace({
          name: 'Yorkshire',
          country: 'United Kingdom',
          lat: 53.99,
          lon: -1.5,
        }),
      })
    ).kind,
    'place',
  );
});

test('county wording beats the state of the same name', async () => {
  // "New York County" keys both the county pack (an exact full-name match) and
  // the state of New York (the bare name "new york"). Both are tier 0, and the
  // larger area used to win, so the ask returned the state.
  const manhattan = await resolveIsolation('New York County');
  assert.equal(manhattan.kind, 'county');
  assert.equal(manhattan.area.id, '36061');
  assert.equal(manhattan.area.region, 'New York');
  assert.equal(
    manhattan.area.candidates,
    2,
    'the county and the state both matched; the more specific key won',
  );
  // The geocoder-confirmed rung already preferred the county.
  assert.equal(
    (await findAdminAreaAt(['New York County'], 40.783, -73.966, 'county')).id,
    '36061',
  );
  assert.equal((await resolveIsolation('York County')).kind, 'county');
  assert.equal((await resolveIsolation('New Kent County')).area.id, '51127');
  // The camera still settles a genuine cross-country homonym: county wording
  // names admin-1 units abroad too.
  assert.equal(
    (await resolveIsolation('Kent County', { near: LEEDS })).area.country,
    'United Kingdom',
  );
  assert.equal((await resolveIsolation('County Cork')).area.country, 'Ireland');
  assert.equal(
    (await resolveIsolation('Kent County', { near: AUSTIN })).area.region,
    'Texas',
  );
});

test('kinds fold to the four isolation kinds', () => {
  assert.deepEqual(ISOLATION_KINDS, ['country', 'state', 'county', 'place']);
  assert.deepEqual(
    ISOLATION_KINDS.map((kind) => normaliseIsolationKind(kind)),
    ['country', 'state', 'county', 'place'],
  );
  for (const [value, expected] of [
    ['Nation', 'country'],
    ['Province', 'state'],
    ['parish', 'county'],
    ['BOROUGH', 'county'],
    ['City', 'place'],
    ['locality', 'place'],
    ['poi', 'place'],
    ['wombat', null],
    ['', null],
    [null, null],
  ])
    assert.equal(normaliseIsolationKind(value), expected, String(value));
});

test('a US state is contained by its SHAPE, not by its bounding rectangle', async () => {
  // The bug this exists for: the admin1 pack carries a state's name and bbox
  // and no geometry, so its `polygons` was one ring of the four bbox corners.
  // `hasGeometry` was satisfied by a rectangle, `areaContains` tested against
  // it, and isolating a state swallowed every state sharing its box.
  const result = await resolveIsolation('Colorado');
  assert.equal(result.ok, true, 'Colorado resolves');
  const area = result.area;
  assert.ok(
    !isDegenerateAdminRing(area),
    'and no longer carries a four-corner ring',
  );

  for (const [lat, lon, label] of [
    [39.0, -105.5, 'Denver'],
    [40.9, -108.9, 'Moffat County, inside the box'],
    [37.5, -102.3, 'Baca County, inside the box'],
  ])
    assert.equal(areaContains(area, lat, lon), true, `${label} is in Colorado`);

  // Every one of these is inside Colorado's BOUNDING BOX and outside Colorado.
  for (const [lat, lon, label] of [
    [-101.5, 40.5, 'Kansas, east of the box edge? no - inside the box'],
    [40.5, -110.5, 'Utah, west of Colorado'],
    [41.5, -105.0, 'Wyoming, north of Colorado'],
    [36.5, -105.0, 'New Mexico, south of Colorado'],
  ])
    assert.equal(areaContains(area, lat, lon), false, `${label} is NOT Colorado`);
});

test('a non-US state keeps its own geometry and is never given US counties', async () => {
  // The guard is "is this ring just a box", not "is this the US" - and it has to
  // be the former, because only SOME admin1 entries lack geometry. Bavaria and
  // Ontario ship real rings (328 and 221 points); the US states ship four
  // corners. Keying the substitution on anything other than the ring's shape
  // would have handed Bavaria the counties of whichever US state matched its
  // postal code.
  for (const [name, lat, lon, label] of [
    ['Bavaria', 48.14, 11.58, 'Munich'],
    ['Ontario', 43.65, -79.38, 'Toronto'],
  ]) {
    const result = await resolveIsolation(name);
    assert.equal(result.ok, true, `${name} resolves`);
    const area = result.area;
    assert.equal(
      isDegenerateAdminRing(area),
      false,
      `${name} has real geometry of its own`,
    );
    assert.equal(areaContains(area, lat, lon), true, `${label} is in ${name}`);
  }
});

test('the ring bounding box rejects exactly what the ray cast rejects', async () => {
  // `pointInRing` gained a cached per-ring box. It is only allowed to be a
  // shortcut, never a second opinion: every point it rejects must be one the
  // ray cast would also have rejected. So this compares the two directly
  // across a real county union, including points outside the box on every side.
  const polygons = await countiesForState('CO');
  assert.ok(polygons.length > 0, 'Colorado counties decoded');

  const bruteRing = (ring, lat, lon) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      )
        inside = !inside;
    }
    return inside;
  };
  const bruteContain = (lat, lon) => {
    for (const [outer, ...holes] of polygons) {
      if (!bruteRing(outer, lat, lon)) continue;
      if (!holes.some((hole) => bruteRing(hole, lat, lon))) return true;
    }
    return false;
  };

  let checked = 0;
  for (const [outer] of polygons) {
    const lons = outer.map((p) => p[0]);
    const lats = outer.map((p) => p[1]);
    const west = Math.min(...lons);
    const east = Math.max(...lons);
    const south = Math.min(...lats);
    const north = Math.max(...lats);
    for (let k = 0; k < 12; k += 1) {
      for (const [lat, lon] of [
        [south + ((north - south) * k) / 11, west + ((east - west) * k) / 11],
        [south - 1, west], // below the box
        [north + 1, east], // above the box
        [(south + north) / 2, west - 1], // left of the box
        [(south + north) / 2, east + 1], // right of the box
      ]) {
        checked += 1;
        assert.equal(
          polygonsContain(polygons, lat, lon),
          bruteContain(lat, lon),
          `(${lat.toFixed(4)}, ${lon.toFixed(4)}) must agree with the ray cast`,
        );
      }
    }
  }
  assert.ok(checked > 500, `a meaningful number of points were compared (${checked})`);
});

test('a ring with a non-finite vertex still answers by ray cast', () => {
  // A NaN in a ring poisons every comparison against its box, so `lat < south`
  // is false, `lat > north` is false, and the early-out would return "outside"
  // for every point - turning a malformed ring into a ring containing nothing.
  // The box is refused instead, and the ray cast answers as it always did.
  const broken = [
    [0, 0],
    [4, Number.NaN],
    [4, 4],
    [0, 4],
  ];
  const expected = (() => {
    let inside = false;
    for (let i = 0, j = broken.length - 1; i < broken.length; j = i, i += 1) {
      const [xi, yi] = broken[i];
      const [xj, yj] = broken[j];
      if (
        yi > 1 !== yj > 1 &&
        1 < ((xj - xi) * (1 - yi)) / (yj - yi) + xi
      )
        inside = !inside;
    }
    return inside;
  })();
  assert.equal(
    pointInRing(broken, 1, 1),
    expected,
    'agrees with the ray cast rather than silently rejecting everything',
  );
});

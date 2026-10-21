import { normalizeIdSwitches, patchRequestedIdSwitches } from './idSwitches.js';
import reservationRows from './layerStateTokenReservations.json' with { type: 'json' };

const VALID_DISPOSITIONS = new Set([
  'enabled-only',
  'enabled+options',
  'enabled+mirrored-options',
]);

export const LAYER_STATE_VERSION = 2;
export const LAYER_STATE_TOKEN_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyz';
const LAYER_STATE_TOKEN_PATTERN = /^[a-z0-9]{1,2}$/;
const NEW_SINGLE_CHARACTER_TOKEN_PATTERN = /^[0-9]$/;
/**
 * A tracking ID is a transponder address, not free text: 6 hex digits for an
 * ICAO24, with slack for TIS-B (`~abc123`) and similar prefixed forms. Bounding
 * it at the codec keeps an arbitrarily long string out of durable state, the
 * generated URL, and local storage. Identity is never TRUNCATED to fit — an
 * out-of-grammar ID is rejected outright, because half an address is a
 * DIFFERENT aircraft, not a shorter name for the same one.
 */
const TRACKING_ID_GRAMMAR = /^[0-9a-z~_-]{1,16}$/;
/**
 * Ceilings for the untrusted v2 layer fields. The layer ceiling covers the
 * complete reserved one-character space plus every two-character base-36
 * allocation, while the option ceiling covers a dozen short assignments.
 * Reject the WHOLE payload, matching the unknown-token rule — never salvage a
 * prefix.
 */
const MAX_ENABLED_LAYERS_CHARS = 4_096;
const MAX_LAYER_OPTIONS_CHARS = 512;
export const LAYER_STATE_STORAGE_KEY = 'gev:layer-state:v2';
export const LAYER_RESTORE_ORIGINS = Object.freeze({
  share: 'share-restore',
  local: 'local-restore',
});

const RADIO_FILTER_CODES = Object.freeze({
  all: 'a',
  news: 'n',
  talk: 't',
  weather: 'w',
  'public-safety': 'p',
  'aviation-marine': 'v',
  'traffic-transit': 'x',
  music: 'm',
  other: 'o',
});
const RADIO_CODE_FILTERS = Object.freeze(
  Object.fromEntries(
    Object.entries(RADIO_FILTER_CODES).map(([key, value]) => [value, key]),
  ),
);

function normalizeBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function normalizeEnum(values, value) {
  return values.includes(value) ? value : null;
}

export function normalizeRadioFilter(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (Object.hasOwn(RADIO_FILTER_CODES, normalized)) return normalized;
  if (/^genre:[a-z0-9][a-z0-9 &-]{0,31}$/.test(normalized)) return normalized;
  return null;
}

function encodeRadioFilter(value) {
  return RADIO_FILTER_CODES[value] || `g-${value.slice('genre:'.length)}`;
}

function decodeRadioFilter(value) {
  if (Object.hasOwn(RADIO_CODE_FILTERS, value))
    return RADIO_CODE_FILTERS[value];
  if (/^g-[a-z0-9][a-z0-9 &-]{0,31}$/.test(value))
    return `genre:${value.slice(2)}`;
  return null;
}

function normalizeVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(Math.max(0, Math.min(1, numeric)) * 100) / 100;
}

function booleanOption(
  key,
  token,
  defaultValue,
  { absentValue = defaultValue } = {},
) {
  return Object.freeze({
    key,
    token,
    defaultValue,
    absentValue,
    normalize: normalizeBoolean,
    encode: (value) => (value ? '1' : '0'),
    decode: (value) => (value === '1' ? true : value === '0' ? false : null),
  });
}

/**
 * What an ABSENT token means for this option inside the CURRENT schema version.
 *
 * Usually that is simply the default: the encoder omits default-valued fields to
 * keep the URL short and the decoder fills the default back in. But a DEFAULT CAN
 * MOVE while the schema version does not, and every link already in the wild was
 * authored under the old one. `absentValue` is that frozen historical meaning —
 * what an omitted token meant when links like it were being written — so a
 * default flip cannot silently rewrite what an existing link SAYS. A share link
 * is authored state; the only honest reading of `v=2&l=f` is the one its author
 * saw.
 *
 * The consequence is not cosmetic: once `absentValue` and `defaultValue` differ,
 * the NEW default has to be emitted EXPLICITLY, or one omission would mean two
 * different things inside a single schema version. Both sides of the codec read
 * this function so they cannot disagree about which it is.
 *
 * (This is the same rule `scf` follows in sharelink.js by hand. `models3d` is the
 * first option in THIS codec to need it — flipped to default-ON on 2026-08-22.)
 */
function absentTokenValue(spec) {
  return Object.hasOwn(spec, 'absentValue')
    ? spec.absentValue
    : spec.defaultValue;
}

function trackingIdOption(key, token, defaultValue = null) {
  const bounded = (candidate) => {
    if (candidate === null || candidate === undefined) return null;
    const raw =
      typeof candidate === 'number' && Number.isFinite(candidate)
        ? String(candidate)
        : typeof candidate === 'string'
          ? candidate
          : null;
    if (raw === null) return null;
    const normalized = raw.trim().toLowerCase();
    return TRACKING_ID_GRAMMAR.test(normalized) ? normalized : null;
  };
  return Object.freeze({
    key,
    token,
    defaultValue,
    normalize: bounded,
    encode: (value) => String(value),
    decode: bounded,
  });
}

function stringOption(key, token, defaultValue) {
  return Object.freeze({
    key,
    token,
    defaultValue,
    normalize: (value) => {
      if (typeof value === 'number' && Number.isFinite(value))
        return String(value).trim().toLowerCase();
      if (typeof value !== 'string') return null;
      const normalized = value.trim().toLowerCase();
      return normalized ? normalized : null;
    },
    encode: (value) => String(value),
    decode: (value) =>
      typeof value === 'string' && value.trim()
        ? value.trim().toLowerCase()
        : null,
  });
}

/**
 * A free-text value that KEEPS ITS CASE, unlike `stringOption`.
 *
 * Used for the isolation area, which is a name a person typed. Lowercasing it
 * would not break resolution - `resolveIsolation` is case-insensitive - but a
 * link that reopened "New York State" in a field reading "new york state"
 * would look like the app had mangled it, and that reads as a bug even when
 * the behaviour is identical.
 *
 * The grammar is deliberately permissive but bounded: an area name is a short
 * phrase, and an unbounded string in a URL is a way to put a megabyte in
 * someone's address bar.
 */
function areaNameOption(key, token, defaultValue = null) {
  const MAX = 80;
  return Object.freeze({
    key,
    token,
    defaultValue,
    absentValue: null,
    normalize: (value) => {
      const raw =
        typeof value === 'number' && Number.isFinite(value)
          ? String(value)
          : typeof value === 'string'
            ? value
            : null;
      if (raw === null) return null;
      const trimmed = raw.trim();
      if (!trimmed) return null;
      // Newlines and control characters have no business in a name and would
      // make the encoded value ambiguous to read in a URL.
      if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
      return trimmed.length > MAX ? trimmed.slice(0, MAX) : trimmed;
    },
    encode: (value) => String(value),
    decode: (value) => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
      return trimmed.length > MAX ? trimmed.slice(0, MAX) : trimmed;
    },
  });
}

function enumOption(
  key,
  token,
  defaultValue,
  values,
  codes,
  { absentValue = defaultValue } = {},
) {
  const reverse = Object.fromEntries(
    Object.entries(codes).map(([name, code]) => [code, name]),
  );
  return Object.freeze({
    key,
    token,
    defaultValue,
    absentValue,
    normalize: (value) => normalizeEnum(values, value),
    encode: (value) => codes[value],
    decode: (value) => reverse[value] || null,
  });
}

function integerOption(key, token, defaultValue, { absentValue } = {}) {
  return Object.freeze({
    key,
    token,
    defaultValue,
    // The value that means "this option was not in the link". It defaults to
    // the option's own default, which is right UNTIL the default is also a
    // legal value: the desk's `toYear` default is 2025 and 2025 is a year a
    // person can ask for, so a link that said "to 2025" was written as "no
    // toYear at all" and read back as the desk's default - which, once the
    // desk's default moved to 2026, meant a person asking for the year 2025
    // got 2026. The absent value has to be a number the option can never
    // hold, and an integer option can never hold zero.
    ...(absentValue === undefined ? {} : { absentValue }),
    normalize: (value) => {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0)
        return value;
      const candidate = typeof value === 'string' ? value.trim() : '';
      const parsed = Number(candidate);
      if (!candidate || !Number.isInteger(parsed) || parsed <= 0) return null;
      return parsed;
    },
    encode: (value) => String(Math.trunc(value)),
    decode: (value) => {
      const candidate = Number(value);
      if (!Number.isInteger(candidate) || candidate <= 0) return null;
      return candidate;
    },
  });
}

/**
 * A share-link-only option: the whole-state codec carries it, but the stored
 * local blob always holds its default.
 */
function shareOnlyOption(spec) {
  return Object.freeze({ ...spec, shareOnly: true });
}

/**
 * A signed integer in `[min, max]`, rejected (never clamped) outside it: a
 * clamped box edge would be a different box, not a shorter spelling.
 */
function boundedIntegerOption(key, token, defaultValue, { min, max }) {
  const parse = (value) => {
    const number =
      typeof value === 'number'
        ? value
        : /^-?\d{1,9}$/.test(String(value).trim())
          ? Number(String(value).trim())
          : NaN;
    return Number.isInteger(number) && number >= min && number <= max
      ? number
      : null;
  };
  return Object.freeze({
    key,
    token,
    defaultValue,
    normalize: parse,
    encode: (value) => String(value),
    decode: parse,
  });
}

/**
 * Recent Imagery day: runtime key `S30:2026-09-18`, URL form `S20260918`.
 * The calendar is checked both ways, and "today" is never consulted, so a
 * link decodes the same whenever it is opened.
 */
const IMAGERY_LETTERS = Object.freeze({ S30: 'S', L30: 'L', VIIRS: 'V' });
const IMAGERY_PRODUCTS = Object.freeze({ S: 'S30', L: 'L30', V: 'VIIRS' });

function imageryKey(product, year, month, day) {
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const iso = Number.isFinite(time)
    ? new Date(time).toISOString().slice(0, 10)
    : '';
  return product && iso === `${year}-${month}-${day}`
    ? `${product}:${iso}`
    : null;
}

function imageryPinOption(key, token) {
  return Object.freeze({
    key,
    token,
    defaultValue: null,
    normalize: (value) => {
      const match = /^(S30|L30|VIIRS):(\d{4})-(\d{2})-(\d{2})$/.exec(
        typeof value === 'string' ? value.trim() : '',
      );
      return match ? imageryKey(match[1], match[2], match[3], match[4]) : null;
    },
    encode: (value) => {
      const [product, day] = value.split(':');
      return `${IMAGERY_LETTERS[product]}${day.replaceAll('-', '')}`;
    },
    decode: (value) => {
      const match = /^([SLV])(\d{4})(\d{2})(\d{2})$/.exec(
        typeof value === 'string' ? value : '',
      );
      return match
        ? imageryKey(IMAGERY_PRODUCTS[match[1]], match[2], match[3], match[4])
        : null;
    },
  });
}

const OPTION_GROUPS = Object.freeze({
  // The area is encoded as the NAME, never as geometry: a link carrying New
  // York's boundary would put kilobytes of coordinates in a URL and would
  // break the next time the boundaries pack is rebuilt. Re-resolving a name is
  // deterministic and costs one lookup.
  isolation: Object.freeze([areaNameOption('area', 'a', null)]),
  traffic: Object.freeze([
    enumOption('roadMode', 'r', null, ['tomtom', 'osm', 'hybrid'], {
      tomtom: 't',
      osm: 'o',
      hybrid: 'h',
    }),
  ]),
  'weather-lightning': Object.freeze([
    enumOption('opacity', 'o', 'strong', ['light', 'strong'], {
      light: 'l',
      strong: 's',
    }),
  ]),
  'weather-radar': Object.freeze([
    enumOption('opacity', 'o', 'strong', ['light', 'strong'], {
      light: 'l',
      strong: 's',
    }),
  ]),
  'weather-satellite': Object.freeze([
    enumOption('infrared', 'i', 'filtered', ['filtered', 'full'], {
      filtered: 'f',
      full: 'a',
    }),
    enumOption('opacity', 'o', 'strong', ['light', 'strong'], {
      light: 'l',
      strong: 's',
    }),
    enumOption(
      'product',
      'p',
      'clouds-regional',
      ['clouds', 'clouds-regional'],
      { clouds: 'g', 'clouds-regional': 'r' },
    ),
  ]),
  wind: Object.freeze([
    enumOption('model', 'm', 'gfs', ['gfs', 'ifs'], { gfs: 'g', ifs: 'i' }),
    enumOption(
      'overlay',
      'o',
      'none',
      ['none', 'speed', 'temperature', 'pressure'],
      { none: 'n', speed: 's', temperature: 't', pressure: 'p' },
      { absentValue: 'speed' },
    ),
    enumOption('units', 'u', 'km/h', ['km/h', 'm/s', 'mph'], {
      'km/h': 'k',
      'm/s': 'm',
      mph: 'i',
    }),
    booleanOption('paused', 'p', false),
  ]),
  flights: Object.freeze([
    // Owner directive 2026-08-22: the fleet's 3D models are DEFAULT-ON in
    // PROXIMITY mode. Proximity is itself the altitude/count gate — models only
    // materialize once the camera is close enough and only for the nearest
    // contacts in view — so "on" costs nothing at globe scale, and an operator
    // who wants every in-view plane still opts into `all` deliberately.
    // This default must stay in lockstep with `_models3dEnabled` in BOTH flight
    // layers, `this._models3dEnabled` in ui.js, and the `active` / `visible`
    // classes in index.html: the fresh-boot path skips restoration entirely (see
    // `start()` below), so nothing ever pushes this value into the layers — those
    // four initializers ARE the agreement, and they are pinned together in
    // layerState.test.mjs.
    //
    // `absentValue: false` is what keeps the flip out of links already in the
    // wild. Schema v2 shipped with OFF as the omitted default, so `v=2&l=f`
    // MEANS off — and it has to keep meaning that. Moving the default without
    // this would have silently turned 3D on for every existing v2 link, and
    // `v=2&l=f&lo=f.m.a` (an OFF link that remembered mode All) would have come
    // back as ON+All. The price is that ON is now written explicitly (`f.e.1`)
    // instead of ridden in on the omission; see `absentTokenValue`.
    booleanOption('models3d', 'e', true, { absentValue: false }),
    enumOption('models3dMode', 'm', 'proximity', ['proximity', 'all'], {
      proximity: 'p',
      all: 'a',
    }),
    trackingIdOption('selectedFlightsTrackingId', 't', null),
    trackingIdOption('selectedMilitaryTrackingId', 'u', null),
  ]),
  satellites: Object.freeze([
    enumOption('catalog', 'c', 'core', ['core', 'dense'], {
      core: 'c',
      dense: 'd',
    }),
    integerOption('selectedSatTrackingId', 't', null),
  ]),
  cctv: Object.freeze([
    enumOption('coverageMode', 'c', 'on', ['off', 'on', 'viewshed'], {
      off: '0',
      on: '1',
      viewshed: 'v',
    }),
    booleanOption('showProjection', 'p', true),
    booleanOption('autoHop', 'a', false),
  ]),
  'recent-imagery': Object.freeze([
    // Box edges in degrees × 100000; latitudes stop at the Web-Mercator limit.
    boundedIntegerOption('west', 'w', null, { min: -18000000, max: 18000000 }),
    boundedIntegerOption('south', 's', null, { min: -8505110, max: 8505110 }),
    boundedIntegerOption('east', 'e', null, { min: -18000000, max: 18000000 }),
    boundedIntegerOption('north', 'n', null, { min: -8505110, max: 8505110 }),
    imageryPinOption('a', 'a'),
    imageryPinOption('b', 'b'),
    // 0 one image, 1 image against the basemap, 2 two images A / B.
    boundedIntegerOption('mode', 'm', 0, { min: 0, max: 2 }),
    // The swipe position is one comparison's framing, not a preference: a
    // stored split resurfaced in the next session's first comparison.
    shareOnlyOption(
      boundedIntegerOption('split', 'p', 50, { min: 0, max: 100 }),
    ),
    booleanOption('viirs', 'v', false),
  ]),
  'street-level': Object.freeze([
    // Preserve the published Mapillary token; custom switches use stable IDs.
    booleanOption('mapillary', 'm', true),
    Object.freeze({
      key: 'providerSwitches',
      patchRequested: patchRequestedIdSwitches,
      token: 'r',
      defaultValue: '',
      normalize: (value) => normalizeIdSwitches(value, ['mapillary']),
      encode: normalizeIdSwitches,
      decode: (value) => normalizeIdSwitches(value, ['mapillary']),
    }),
    enumOption('pano', 'p', 'all', ['all', 'pano', 'flat'], {
      all: 'a',
      pano: 'p',
      flat: 'f',
    }),
    // Relative days, so a link means the same next year. The max matches
    // MAX_SINCE_DAYS in streetLevel/policy.js (pinned by layerState.test).
    boundedIntegerOption('sinceDays', 's', 0, { min: 0, max: 36500 }),
  ]),
  'storm-observed': Object.freeze([
    // The year window is an option rather than panel-only state because the
    // whole point of the decade chips is that the answer depends on it: a link
    // that shows "2010 onward" is a different claim from one showing the whole
    // record, and the reader cannot see which they were given.
    integerOption('fromYear', 'f', 1955),
    booleanOption('includeHail', 'h', true),
    booleanOption('includeWind', 'w', true),
    enumOption(
      'surface',
      's',
      'damage',
      ['damage', 'radar-gap', 'vs-expected'],
      { damage: 'd', 'radar-gap': 'g', 'vs-expected': 'v' },
    ),
  ]),
  // The Hail Desk is a second front end over the same data, so its filters
  // are LAYER state like any other: a desk link and a globe link then differ
  // only in which application reads them, and a globe can hand a selected
  // county straight to the desk without inventing a second URL format.
  //
  // Hail is in tenths of an inch for the same reason the storm layer's is: the
  // codec has integer options only, and 1.75 must survive a round trip.
  'hail-desk': Object.freeze([
    integerOption('fromYear', 'f', 1955),
    // 0 is not a year, so it can be the absent value and the year 2025 can
    // still be asked for by name.
    integerOption('toYear', 't', 2025, { absentValue: 0 }),
    stringOption('state', 's', ''),
    integerOption('minHailTenths', 'm', 10),
    // THE DAY, so a storm can be linked to. The desk could not link a storm
    // before this: its codec had the market's year window, its state and its
    // search, and nothing that said WHICH STORM.
    stringOption('d', 'y', ''),
    // WHICH VIEW the link opens on. The desk has three, and a link that
    // carried a storm's day but opened on the market table would show a
    // person a list of towns and no storm.
    stringOption('view', 'v', 'storm'),
    // The storm list's sort, SEPARATE from the market table's `sort` and
    // `dir`. One sort key meaning two different things in two different
    // tables is a link that reads back as the wrong list.
    enumOption(
      'dsort',
      'D',
      'date',
      [
        'date',
        'houses',
        'reports',
        'severe',
        'largest',
        'places',
        'radarPlaces',
        'tracts',
      ],
      {
        date: 't',
        houses: 'h',
        reports: 'r',
        severe: 's',
        largest: 'l',
        places: 'p',
        radarPlaces: 'c',
        tracts: 'x',
      },
    ),
    enumOption('ddir', 'E', 'desc', ['asc', 'desc'], { asc: 'a', desc: 'd' }),
    enumOption(
      'sort',
      'o',
      'score',
      // EVERY sort key a column header offers, so every header round-trips
      // through a link. The city view's own default sort is 'severe', which
      // was not in this list - so it encoded as the literal string
      // "undefined" and every city link read back sorted by something else.
      // 'loss' was here too and matched no column at all; the column is
      // 'bld', and 'l' stays its code so old links keep their meaning.
      [
        'score',
        'units',
        'hail',
        'bld',
        'pop',
        'name',
        'st',
        'severe',
        'severe15',
        'big',
        'max',
        'maxHail',
        'band',
        'umoe',
      ],
      {
        score: 's',
        units: 'u',
        hail: 'h',
        bld: 'l',
        pop: 'p',
        name: 'n',
        st: 't',
        severe: '1',
        severe15: '2',
        big: '3',
        max: '4',
        maxHail: '5',
        band: 'b',
        umoe: 'e',
      },
    ),
    enumOption('dir', 'd', 'desc', ['asc', 'desc'], { asc: 'a', desc: 'd' }),
    stringOption('q', 'q', ''),
  ]),
  'storm-reports': Object.freeze([
    // Shareable because the layer's whole claim is which size it is asserting:
    // a link showing "1 inch and up" is a different statement from one showing
    // the whole record. Hail is held in tenths of an inch, because the codec
    // has integer options only and 1.75 must survive a round trip.
    integerOption('minHailTenths', 'm', 10),
    integerOption('minWindKt', 'w', 50),
    enumOption('hazard', 'z', 'hail', ['hail', 'wind'], {
      hail: 'h',
      wind: 'd',
    }),
  ]),
  radio: Object.freeze([
    Object.freeze({
      key: 'filter',
      token: 'f',
      defaultValue: 'all',
      normalize: normalizeRadioFilter,
      encode: encodeRadioFilter,
      decode: decodeRadioFilter,
    }),
    Object.freeze({
      key: 'volume',
      token: 'v',
      defaultValue: 0.8,
      normalize: normalizeVolume,
      encode: (value) => String(Math.round(value * 100)),
      decode: (value) =>
        /^\d{1,3}$/.test(value) ? normalizeVolume(Number(value) / 100) : null,
    }),
  ]),
});

export const SHARE_TRACKING_RESTORE_POLICIES = Object.freeze({
  flights: Object.freeze({
    optionOwner: 'flights',
    optionKey: 'selectedFlightsTrackingId',
    expiryWindowMs: 90_000,
    label: 'flight',
  }),
  military: Object.freeze({
    optionOwner: 'flights',
    optionKey: 'selectedMilitaryTrackingId',
    expiryWindowMs: 45_000,
    label: 'military flight',
  }),
  satellites: Object.freeze({
    optionOwner: 'satellites',
    optionKey: 'selectedSatTrackingId',
    expiryWindowMs: 300_000,
    label: 'satellite',
  }),
});

/**
 * The original single-character assignments are a closed compatibility set.
 * Keep their exact mapping pinned by the independent snapshot in the tests.
 */
export const LEGACY_LAYER_STATE_TOKENS = Object.freeze({
  'ais-live-vessels': 'a',
  'alpr-cameras': 'p',
  'bhote-koshi-2026': 'h',
  'bhote-koshi-locator': 'z',
  bikeshare: 'b',
  cctv: 'c',
  directions: 'n',
  earthquakes: 'e',
  'fire-perimeters': '2',
  flights: 'f',
  'local-dams': 'q',
  'local-datacenters': 'd',
  'local-firms': 'w',
  military: 'm',
  'military-awareness': 'g',
  'military-installations': 'i',
  radio: 'r',
  'recent-imagery': '1',
  'rocket-launches': 'x',
  satellites: 's',
  'telegeography-submarine-cables': 'u',
  traffic: 't',
  transit: 'j',
  'weather-cyclones': 'y',
  'weather-lightning': 'l',
  'weather-radar': 'v',
  'weather-satellite': 'o',
  wind: 'k',
});

/**
 * Permanent token ownership. Existing share links are public authored state,
 * so an allocation stays here even if its layer is later removed. The JSON
 * ledger is also read directly from the published Git base by the checker.
 */
export function parseLayerStateTokenReservations(rows) {
  if (!Array.isArray(rows)) {
    throw new Error('Layer-state token ledger must be an array');
  }
  const reservations = Object.create(null);
  const reservedIdsByToken = new Map();
  for (const row of rows) {
    if (
      !Array.isArray(row) ||
      row.length !== 2 ||
      typeof row[0] !== 'string' ||
      typeof row[1] !== 'string'
    ) {
      throw new Error('Invalid layer-state token ledger row');
    }
    const [id, token] = row;
    if (!/^[a-z0-9-]+$/.test(id) || !LAYER_STATE_TOKEN_PATTERN.test(token)) {
      throw new Error(`Invalid layer-state token reservation: ${id}`);
    }
    if (Object.hasOwn(reservations, id)) {
      throw new Error(`Duplicate layer-state token reservation id: ${id}`);
    }
    if (reservedIdsByToken.has(token)) {
      throw new Error(`Duplicate layer-state token reservation: ${token}`);
    }
    if (
      (Object.hasOwn(LEGACY_LAYER_STATE_TOKENS, id) &&
        token !== LEGACY_LAYER_STATE_TOKENS[id]) ||
      (token.length === 1 &&
        !NEW_SINGLE_CHARACTER_TOKEN_PATTERN.test(token) &&
        LEGACY_LAYER_STATE_TOKENS[id] !== token)
    ) {
      throw new Error(`Legacy layer-state token is immutable: ${id}`);
    }
    reservations[id] = token;
    reservedIdsByToken.set(token, id);
  }
  for (const [id, token] of Object.entries(LEGACY_LAYER_STATE_TOKENS)) {
    if (reservations[id] !== token) {
      throw new Error(`Missing or changed legacy layer-state token: ${id}`);
    }
  }
  return Object.freeze(reservations);
}

export const LAYER_STATE_TOKEN_RESERVATIONS =
  parseLayerStateTokenReservations(reservationRows);

/**
 * Canonical serialization registry. Its order, not runtime registration order,
 * owns stable URL ordering.
 */
export const LAYER_STATE_REGISTRY = Object.freeze([
  Object.freeze({
    id: 'ais-live-vessels',
    token: 'a',
    disposition: 'enabled-only',
  }),
  Object.freeze({
    id: 'alpr-cameras',
    token: 'p',
    disposition: 'enabled-only',
  }),
  Object.freeze({
    id: 'bhote-koshi-2026',
    token: 'h',
    disposition: 'enabled-only',
  }),
  Object.freeze({
    id: 'bhote-koshi-locator',
    token: 'z',
    disposition: 'enabled-only',
  }),
  Object.freeze({ id: 'bikeshare', token: 'b', disposition: 'enabled-only' }),
  Object.freeze({
    id: 'cctv',
    token: 'c',
    disposition: 'enabled+options',
    optionOwner: 'cctv',
  }),
  Object.freeze({ id: 'directions', token: 'n', disposition: 'enabled-only' }),
  Object.freeze({ id: 'earthquakes', token: 'e', disposition: 'enabled-only' }),
  Object.freeze({
    id: 'fire-perimeters',
    token: '2',
    disposition: 'enabled-only',
  }),
  Object.freeze({
    id: 'flights',
    token: 'f',
    disposition: 'enabled+options',
    optionOwner: 'flights',
  }),
  // Isolation encodes its area in the share link, so it IS an options layer.
  // An earlier version shipped as enabled-only with no option group and the
  // codec silently dropped the area: the layer round-tripped its own
  // getParams/setParams perfectly in isolation and the URL still reopened
  // with nothing isolated. The layer-level test passed the whole time.
  Object.freeze({
    id: 'isolation',
    token: '6',
    disposition: 'enabled+options',
    optionOwner: 'isolation',
  }),
  Object.freeze({ id: 'local-dams', token: 'q', disposition: 'enabled-only' }),
  Object.freeze({
    id: 'local-datacenters',
    token: 'd',
    disposition: 'enabled-only',
  }),
  Object.freeze({ id: 'local-firms', token: 'w', disposition: 'enabled-only' }),
  Object.freeze({
    id: 'military',
    token: 'm',
    disposition: 'enabled+mirrored-options',
    optionOwner: 'flights',
  }),
  Object.freeze({
    id: 'military-awareness',
    token: 'g',
    disposition: 'enabled-only',
  }),
  Object.freeze({
    id: 'military-installations',
    token: 'i',
    disposition: 'enabled-only',
  }),
  Object.freeze({
    id: 'radio',
    token: 'r',
    disposition: 'enabled+options',
    optionOwner: 'radio',
  }),
  Object.freeze({
    id: 'recent-imagery',
    token: '1',
    disposition: 'enabled+options',
    optionOwner: 'recent-imagery',
  }),
  Object.freeze({
    id: 'rocket-launches',
    token: 'x',
    disposition: 'enabled-only',
  }),
  Object.freeze({
    id: 'satellites',
    token: 's',
    disposition: 'enabled+options',
    optionOwner: 'satellites',
  }),
  Object.freeze({
    // FEMA NRI expected-loss surface. Split from storm-observed on the
    // analytical axis (what happened vs what the model says should), so the
    // comparison is the point of having two layers rather than a mode.
    //
    // Mirrors storm-observed's options rather than owning its own: the two
    // layers are read side by side, so a link that says "hail only, since
    // 2010" must mean the same thing on both. `surface` arrives here too and
    // is ignored — there is no cell grid to switch.
    id: 'storm-expected',
    token: '4',
    disposition: 'enabled+mirrored-options',
    optionOwner: 'storm-observed',
  }),
  Object.freeze({
    // Never published on main, so no historic share link needs to keep reading:
    // these take the next free numeric tokens.
    id: 'storm-observed',
    token: '3',
    disposition: 'enabled+options',
    optionOwner: 'storm-observed',
  }),
  Object.freeze({
    id: 'storm-reports',
    token: '5',
    disposition: 'enabled+options',
    optionOwner: 'storm-reports',
  }),
  Object.freeze({
    id: 'street-level',
    token: '0',
    disposition: 'enabled+options',
    optionOwner: 'street-level',
  }),
  Object.freeze({
    id: 'telegeography-submarine-cables',
    token: 'u',
    disposition: 'enabled-only',
  }),
  Object.freeze({
    id: 'traffic',
    token: 't',
    disposition: 'enabled+options',
    optionOwner: 'traffic',
  }),
  Object.freeze({ id: 'transit', token: 'j', disposition: 'enabled-only' }),
  Object.freeze({
    id: 'weather-cyclones',
    token: 'y',
    disposition: 'enabled-only',
  }),
  Object.freeze({
    id: 'weather-lightning',
    token: 'l',
    disposition: 'enabled+options',
    optionOwner: 'weather-lightning',
  }),
  Object.freeze({
    id: 'weather-radar',
    token: 'v',
    disposition: 'enabled+options',
    optionOwner: 'weather-radar',
  }),
  Object.freeze({
    id: 'weather-satellite',
    token: 'o',
    disposition: 'enabled+options',
    optionOwner: 'weather-satellite',
  }),
  Object.freeze({
    id: 'wind',
    token: 'k',
    disposition: 'enabled+options',
    optionOwner: 'wind',
  }),
]);

export const REGISTERED_LAYER_IDS = Object.freeze(
  LAYER_STATE_REGISTRY.map((entry) => entry.id),
);

/** Consume unreserved digits before the two-character base-36 namespace. */
export function nextLayerStateToken(
  reservations = LAYER_STATE_TOKEN_RESERVATIONS,
) {
  const occupied = new Set(Object.values(reservations || {}));
  for (const digit of '0123456789') {
    if (!occupied.has(digit)) return digit;
  }
  for (const first of LAYER_STATE_TOKEN_ALPHABET) {
    for (const second of LAYER_STATE_TOKEN_ALPHABET) {
      const candidate = `${first}${second}`;
      if (!occupied.has(candidate)) return candidate;
    }
  }
  throw new Error('Layer-state token namespace exhausted');
}

function allocationRank(token) {
  if (NEW_SINGLE_CHARACTER_TOKEN_PATTERN.test(token)) return Number(token);
  if (typeof token !== 'string' || token.length !== 2) return Infinity;
  const first = LAYER_STATE_TOKEN_ALPHABET.indexOf(token[0]);
  const second = LAYER_STATE_TOKEN_ALPHABET.indexOf(token[1]);
  return first < 0 || second < 0 ? Infinity : 10 + first * 36 + second;
}

/** Check a proposed ledger against the published merge-time base. */
export function validateLayerStateAllocations(
  baseReservations,
  reservations = LAYER_STATE_TOKEN_RESERVATIONS,
) {
  if (!baseReservations || typeof baseReservations !== 'object') {
    throw new Error('Base layer-state token reservations are required');
  }
  for (const [id, token] of Object.entries(baseReservations)) {
    if (reservations[id] !== token) {
      throw new Error(`Published layer-state token changed or removed: ${id}`);
    }
  }
  const newlyReserved = Object.entries(reservations)
    .filter(([id]) => !Object.hasOwn(baseReservations, id))
    .sort((left, right) => allocationRank(left[1]) - allocationRank(right[1]));
  const occupied = { ...baseReservations };
  for (const [id, token] of newlyReserved) {
    const expected = nextLayerStateToken(occupied);
    if (token !== expected) {
      throw new Error(
        `Layer-state token for ${id} must be the next free token ${expected}`,
      );
    }
    occupied[id] = token;
  }
  return true;
}

export const REGISTRY_BY_ID = new Map(
  LAYER_STATE_REGISTRY.map((entry) => [entry.id, entry]),
);
const REGISTRY_BY_TOKEN = new Map(
  LAYER_STATE_REGISTRY.map((entry) => [entry.token, entry]),
);
const OPTION_OWNER_IDS = Object.freeze([
  ...new Set(
    LAYER_STATE_REGISTRY.map((entry) => entry.optionOwner).filter(Boolean),
  ),
]);

export function optionSpecs(ownerId) {
  return OPTION_GROUPS[ownerId] || [];
}

function defaultsForOwner(ownerId) {
  return Object.fromEntries(
    optionSpecs(ownerId).map((spec) => [spec.key, spec.defaultValue]),
  );
}

function normalizeOwnerOptions(ownerId, candidate = {}) {
  const input = candidate && typeof candidate === 'object' ? candidate : {};
  const normalized = {};
  for (const spec of optionSpecs(ownerId)) {
    const value = Object.hasOwn(input, spec.key)
      ? spec.normalize(input[spec.key])
      : null;
    normalized[spec.key] = value === null ? spec.defaultValue : value;
  }
  return normalized;
}

/** Return whether an event origin represents durable direct intent. */
export function isExplicitLayerStateOrigin(origin) {
  return origin === 'user' || origin === 'voice' || origin === 'tool';
}

/** Validate the static registry itself before it is used to seal a manager. */
export function validateLayerStateRegistry(
  registry = LAYER_STATE_REGISTRY,
  reservations = LAYER_STATE_TOKEN_RESERVATIONS,
) {
  if (!Array.isArray(registry) || registry.length === 0) {
    throw new Error('Layer-state registry must be a non-empty array');
  }
  if (
    !reservations ||
    typeof reservations !== 'object' ||
    Array.isArray(reservations)
  ) {
    throw new Error('Layer-state token reservations must be an object');
  }
  const reservedIdsByToken = new Map();
  for (const [id, token] of Object.entries(reservations)) {
    if (!/^[a-z0-9-]+$/.test(id) || !LAYER_STATE_TOKEN_PATTERN.test(token)) {
      throw new Error(`Invalid layer-state token reservation: ${id}`);
    }
    if (
      (Object.hasOwn(LEGACY_LAYER_STATE_TOKENS, id) &&
        token !== LEGACY_LAYER_STATE_TOKENS[id]) ||
      (token.length === 1 &&
        !NEW_SINGLE_CHARACTER_TOKEN_PATTERN.test(token) &&
        LEGACY_LAYER_STATE_TOKENS[id] !== token)
    ) {
      throw new Error(`Legacy layer-state token is immutable: ${id}`);
    }
    if (reservedIdsByToken.has(token)) {
      throw new Error(`Duplicate layer-state token reservation: ${token}`);
    }
    reservedIdsByToken.set(token, id);
  }
  const ids = new Set();
  const tokens = new Set();
  for (const entry of registry) {
    if (!entry || typeof entry.id !== 'string' || !entry.id)
      throw new Error('Layer-state entry missing id');
    if (!/^[a-z0-9-]+$/.test(entry.id))
      throw new Error(`Invalid layer-state id: ${entry.id}`);
    if (ids.has(entry.id))
      throw new Error(`Duplicate layer-state id: ${entry.id}`);
    ids.add(entry.id);
    if (!LAYER_STATE_TOKEN_PATTERN.test(entry.token || ''))
      throw new Error(`Invalid layer-state token: ${entry.id}`);
    if (reservations[entry.id] !== entry.token) {
      throw new Error(`Unreserved layer-state token: ${entry.id}`);
    }
    if (reservedIdsByToken.get(entry.token) !== entry.id) {
      throw new Error(`Layer-state token reservation mismatch: ${entry.token}`);
    }
    if (tokens.has(entry.token))
      throw new Error(`Duplicate layer-state token: ${entry.token}`);
    tokens.add(entry.token);
    if (!VALID_DISPOSITIONS.has(entry.disposition)) {
      throw new Error(`Invalid layer-state disposition: ${entry.id}`);
    }
    if (entry.disposition !== 'enabled-only') {
      if (!entry.optionOwner || optionSpecs(entry.optionOwner).length === 0) {
        throw new Error(`Layer-state option owner missing: ${entry.id}`);
      }
    } else if (entry.optionOwner) {
      throw new Error(`Enabled-only layer cannot own options: ${entry.id}`);
    }
  }
  return true;
}

validateLayerStateRegistry();

/** Produce the complete durable default state. */
export function createDefaultLayerState() {
  return {
    version: LAYER_STATE_VERSION,
    enabledLayerIds: [],
    options: Object.fromEntries(
      OPTION_OWNER_IDS.map((ownerId) => [ownerId, defaultsForOwner(ownerId)]),
    ),
  };
}

/** Sanitize and canonicalize an externally supplied layer-state object. */
export function normalizeLayerState(candidate) {
  const input = candidate && typeof candidate === 'object' ? candidate : {};
  const requestedEnabled = new Set(
    Array.isArray(input.enabledLayerIds)
      ? input.enabledLayerIds.map(String)
      : [],
  );
  const enabledLayerIds = REGISTERED_LAYER_IDS.filter((id) =>
    requestedEnabled.has(id),
  );
  const enabled = new Set(enabledLayerIds);
  const options = Object.fromEntries(
    OPTION_OWNER_IDS.map((ownerId) => [
      ownerId,
      normalizeOwnerOptions(ownerId, input.options?.[ownerId]),
    ]),
  );
  // A selected entity cannot outlive an explicitly disabled owner layer.
  // Keeping these IDs would resurrect tracking when that layer is enabled
  // later, even though OFF was newer explicit intent.
  if (!enabled.has('flights')) options.flights.selectedFlightsTrackingId = null;
  if (!enabled.has('military'))
    options.flights.selectedMilitaryTrackingId = null;
  if (!enabled.has('satellites'))
    options.satellites.selectedSatTrackingId = null;
  // The codec has no cross-family recency field, so multiple tracking IDs are
  // ambiguous rather than an ordered handoff. Fail closed instead of letting
  // asynchronous feed arrival decide which tracker and camera owner wins.
  const trackingSelectionCount = [
    options.flights.selectedFlightsTrackingId,
    options.flights.selectedMilitaryTrackingId,
    options.satellites.selectedSatTrackingId,
  ].filter((value) => value !== null).length;
  if (trackingSelectionCount > 1) {
    options.flights.selectedFlightsTrackingId = null;
    options.flights.selectedMilitaryTrackingId = null;
    options.satellites.selectedSatTrackingId = null;
  }
  return {
    version: LAYER_STATE_VERSION,
    enabledLayerIds,
    options,
  };
}

export function cloneLayerState(state) {
  const normalized = normalizeLayerState(state);
  return {
    ...normalized,
    enabledLayerIds: [...normalized.enabledLayerIds],
    options: Object.fromEntries(
      Object.entries(normalized.options).map(([id, options]) => [
        id,
        { ...options },
      ]),
    ),
  };
}

/** Append the compact v2 layer fields to an existing URLSearchParams object. */
export function encodeLayerStateParams(params, state) {
  const normalized = normalizeLayerState(state);
  const enabled = new Set(normalized.enabledLayerIds);
  params.set(
    'l',
    LAYER_STATE_REGISTRY.filter((entry) => enabled.has(entry.id))
      .map((entry) => entry.token)
      .join('.'),
  );
  const encodedOptions = [];
  for (const ownerId of OPTION_OWNER_IDS) {
    const ownerEntry = REGISTRY_BY_ID.get(ownerId);
    encodedOptions.push(
      ...encodeOwnerOptions(
        ownerId,
        ownerEntry.token,
        normalized.options[ownerId],
      ),
    );
  }
  if (encodedOptions.length) params.set('lo', encodedOptions.join('_'));
  else params.delete('lo');
  return params;
}

/**
 * Encode one option owner's values as `owner.spec.value` triples.
 *
 * Split out of {@link encodeLayerStateParams} so a second front end can
 * produce the SAME format. The Hail Desk is a second front end over the same
 * data, and it is not a layer in the globe's catalog - so it cannot be an entry
 * in the layer-state registry, and therefore cannot be reached through the
 * registry-driven encoder. But its options are expressed with the same option
 * SPECS, so the tokens it writes are the same tokens, and a link that means
 * one thing in the desk means the same thing in the globe.
 *
 * @param {string} ownerId
 * @param {string} ownerToken the owner's token from the reservation ledger
 * @param {object} options
 * @returns {string[]} the encoded triples
 */
export function encodeOwnerOptions(ownerId, ownerToken, options) {
  const encoded = [];
  for (const spec of optionSpecs(ownerId)) {
    // Omit against what an ABSENT token means to a DECODER, not against the
    // current default — those are the same thing for every option whose
    // default never moved, and deliberately different for one whose did.
    if (options?.[spec.key] === absentTokenValue(spec)) continue;
    // NEVER encode an unknown value as `undefined`.
    //
    // The spec's encoder is called WITHOUT normalising the value first, so a
    // key an enum does not know became the literal string "undefined" in the
    // link - and the link then decoded to the default, silently. That is how
    // the city view's own default sort vanished from every link it produced.
    // An unknown value falls back to the spec's default, which is a visible
    // wrong answer rather than an invisible one.
    const encodedValue = spec.encode(options[spec.key]);
    encoded.push(
      `${ownerToken}.${spec.token}.` +
        (encodedValue === undefined || encodedValue === null
          ? spec.encode(spec.defaultValue)
          : encodedValue),
    );
  }
  return encoded;
}

/**
 * Decode one option owner's values from `owner.spec.value` triples.
 *
 * @param {string} ownerId
 * @param {string} ownerToken
 * @param {string[]} tokens
 * @returns {object} the decoded options, and only the ones that were present
 */
export function decodeOwnerOptions(ownerId, ownerToken, tokens) {
  const out = {};
  for (const token of tokens) {
    const [owner, specToken, ...rest] = String(token).split('.');
    if (owner !== ownerToken) continue;
    const spec = optionSpecs(ownerId).find(
      (entry) => entry.token === specToken,
    );
    if (!spec) continue;
    const value = spec.decode(rest.join('.'));
    if (value !== null && value !== undefined) out[spec.key] = value;
  }
  return out;
}

/** Decode v2 fields. Null means that the layer payload is absent. */
export function decodeLayerStateParams(params) {
  const layerFields = params.getAll('l');
  if (
    params.get('v') !== String(LAYER_STATE_VERSION) ||
    layerFields.length !== 1
  )
    return null;
  const rawLayers = layerFields[0];
  const rawOptionsField = String(params.get('lo') || '');
  // Fail closed on an oversized payload rather than decoding a truncated one.
  if (rawLayers.length > MAX_ENABLED_LAYERS_CHARS) return null;
  if (rawOptionsField.length > MAX_LAYER_OPTIONS_CHARS) return null;
  const layerTokens = rawLayers ? rawLayers.split('.') : [];
  // `l=` is the one valid explicit-empty representation. Reject repeated
  // fields, empty members, duplicate members, or unknown members; silently
  // removing one would turn a malformed share into a different state.
  if (
    layerTokens.some((token) => !token || !REGISTRY_BY_TOKEN.has(token)) ||
    new Set(layerTokens).size !== layerTokens.length
  )
    return null;
  const enabledLayerIds = layerTokens.map(
    (token) => REGISTRY_BY_TOKEN.get(token).id,
  );
  const rawOptions = {};
  for (const assignment of rawOptionsField.split('_')) {
    if (!assignment) continue;
    const [layerToken, optionToken, encodedValue, ...extra] =
      assignment.split('.');
    if (extra.length) continue;
    const entry = REGISTRY_BY_TOKEN.get(layerToken);
    const ownerId = entry?.optionOwner || null;
    if (!ownerId) continue;
    const spec = optionSpecs(ownerId).find(
      (candidate) => candidate.token === optionToken,
    );
    if (!spec) continue;
    const decoded = spec.decode(encodedValue);
    if (decoded === null) continue;
    if (!rawOptions[ownerId]) rawOptions[ownerId] = {};
    rawOptions[ownerId][spec.key] = decoded;
  }
  // Fill every token the link did NOT carry with its absent-meaning before
  // normalization, which would otherwise substitute the CURRENT default. For all
  // but one option those are identical and this is a no-op; for `models3d` it is
  // the whole point — an omitted `e` is a v2 author saying OFF, not a v2 author
  // saying "whatever the default happens to be today". See `absentTokenValue`.
  for (const ownerId of OPTION_OWNER_IDS) {
    for (const spec of optionSpecs(ownerId)) {
      if (rawOptions[ownerId] && Object.hasOwn(rawOptions[ownerId], spec.key))
        continue;
      if (!rawOptions[ownerId]) rawOptions[ownerId] = {};
      rawOptions[ownerId][spec.key] = absentTokenValue(spec);
    }
  }
  return normalizeLayerState({ enabledLayerIds, options: rawOptions });
}

/** Options with share-link-only values reset to their defaults. */
function withoutShareOnlyOptions(options) {
  const out = {};
  for (const ownerId of OPTION_OWNER_IDS) {
    out[ownerId] = { ...(options?.[ownerId] || {}) };
    for (const spec of optionSpecs(ownerId)) {
      if (spec.shareOnly) out[ownerId][spec.key] = spec.defaultValue;
    }
  }
  return out;
}

/**
 * Stable local-storage representation (full IDs for debuggability), with
 * share-link-only options at their defaults.
 */
export function serializeStoredLayerState(state) {
  const normalized = normalizeLayerState(state);
  return JSON.stringify({
    v: LAYER_STATE_VERSION,
    l: normalized.enabledLayerIds,
    o: withoutShareOnlyOptions(normalized.options),
  });
}

export function parseStoredLayerState(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.v !== LAYER_STATE_VERSION || !Array.isArray(parsed.l))
      return null;
    return normalizeLayerState({
      enabledLayerIds: parsed.l,
      options: withoutShareOnlyOptions(parsed.o),
    });
  } catch {
    return null;
  }
}

/** Return sanitized options to apply to one registered module. */
export function layerOptionsForRestore(state, layerId) {
  const entry = REGISTRY_BY_ID.get(layerId);
  if (!entry?.optionOwner) return null;
  return { ...normalizeLayerState(state).options[entry.optionOwner] };
}

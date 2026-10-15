import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAGNITUDE_UNITS,
  STORM_HAZARDS,
  countyFipsFromSpc,
  isPlottable,
  normalizeSpcBulkRow,
  normalizeSpcDailyRow,
  packReport,
  parseLocalTime,
  sortReports,
  unpackReport,
} from './storm-report-normalize.mjs';

test('the bulk archive keeps the day the existing build threw away', () => {
  // The row that motivated this whole pipeline: `date` has always been there.
  const row = {
    om: '327',
    yr: '1955',
    mo: '10',
    dy: '16',
    date: '1955-10-16',
    time: '13:15:00',
    tz: '3',
    st: 'NJ',
    stf: '34',
    stn: '0',
    mag: '1.0',
    inj: '0',
    fat: '0',
    loss: '0.0',
    closs: '0.0',
    slat: '40.2',
    slon: '-74.08',
    elat: '0.0',
    elon: '0.0',
    len: '0',
    wid: '0',
    ns: '0',
    sn: '0',
    sg: '0',
    f1: '25',
    f2: '0',
    f3: '0',
    f4: '0',
    edat: '',
    etime: '',
  };
  const report = normalizeSpcBulkRow(row, 'hail');
  assert.equal(report.date, '1955-10-16');
  assert.equal(report.minute, 13 * 60 + 15);
  assert.equal(report.size, 1.0);
  assert.equal(report.hazard, 'hail');
  assert.equal(report.countyFips, '34025');
  assert.equal(report.state, 'NJ');
  assert.deepEqual(report.sources, ['spc-bulk']);
});

test('a bulk row at 0,0 is SPC null island, not a real report', () => {
  const base = {
    om: '1',
    date: '2021-05-16',
    time: '12:00',
    mag: '2.0',
    stf: '20',
    f1: '1',
  };
  assert.equal(
    normalizeSpcBulkRow({ ...base, slat: '0', slon: '0' }, 'hail'),
    null,
  );
  assert.equal(
    normalizeSpcBulkRow({ ...base, slat: '40.2', slon: '-74.08' }, 'hail').lat,
    40.2,
  );
});

test('a bulk row with no usable date is refused rather than dated by hand', () => {
  const row = {
    om: '1',
    yr: '2021',
    mo: '5',
    dy: '16',
    date: '',
    time: '12:00',
    mag: '2.0',
    slat: '40',
    slon: '-74',
    stf: '20',
    f1: '1',
  };
  assert.equal(normalizeSpcBulkRow(row, 'hail'), null);
});

test('county FIPS is null when either half is a placeholder', () => {
  assert.equal(countyFipsFromSpc({ stf: '20', f1: '1' }), '20001');
  assert.equal(
    countyFipsFromSpc({ stf: '00', f1: '1' }),
    null,
    'state 0 is a placeholder',
  );
  assert.equal(
    countyFipsFromSpc({ stf: '20', f1: '000' }),
    null,
    'county 0 is a placeholder',
  );
  assert.equal(
    countyFipsFromSpc({ stf: '20', f1: '999' }),
    null,
    'county 999 is a placeholder',
  );
  assert.equal(countyFipsFromSpc({ stf: '', f1: '1' }), null);
  assert.equal(countyFipsFromSpc({ stf: '20', f1: '' }), null);
});

test('loss in the bulk database is thousands of dollars', () => {
  const row = {
    om: '1',
    date: '2021-05-16',
    time: '12:00',
    mag: '2.0',
    slat: '40',
    slon: '-74',
    loss: '5',
    stf: '20',
    f1: '1',
  };
  assert.equal(normalizeSpcBulkRow(row, 'hail').loss, 5000);
});

test('a degenerate hail size is flagged as a trace, not read as a real stone', () => {
  const base = {
    om: '1',
    date: '2021-05-16',
    time: '12:00',
    slat: '40',
    slon: '-74',
    stf: '20',
    f1: '1',
  };
  // 0.13in is the smallest the archive records: a real measured stone.
  const measured = normalizeSpcBulkRow({ ...base, mag: '0.13' }, 'hail');
  assert.equal(measured.trace, false);
  assert.equal(measured.size, 0.13);

  // A bare hundredths value from a daily file means a trace, not four hundredths.
  const trace = normalizeSpcDailyRow(
    { Time: '1200', Size: '3', Lat: '40', Lon: '-74' },
    'hail',
    '2021-05-16',
  );
  assert.equal(trace.trace, true, 'four hundredths is not a measurable stone');
  assert.equal(trace.size, 0.03, 'the value is still carried');
});

test('daily hail Size is hundredths of an inch', () => {
  const row = {
    Time: '1208',
    Size: '100',
    Location: '1 SSW Berea',
    County: 'Madison',
    State: 'KY',
    Lat: '37.57',
    Lon: '-84.3',
    Comments: '(LMK)',
  };
  const report = normalizeSpcDailyRow(row, 'hail', '2025-05-16');
  assert.equal(report.size, 1.0, '100 hundredths is one inch');
  assert.equal(report.date, '2025-05-16', 'the day comes from the URL stamp');
  assert.equal(report.minute, 12 * 60 + 8);
  assert.deepEqual(report.sources, ['spc-daily']);
});

test('daily wind Speed is knots and is not divided by a hundred', () => {
  const row = {
    Time: '1243',
    Speed: '58',
    Location: '3 N Elsewhere',
    County: 'Cook',
    State: 'IL',
    Lat: '41.9',
    Lon: '-87.6',
    Comments: '',
  };
  assert.equal(normalizeSpcDailyRow(row, 'wind', '2025-05-16').size, 58);
});

test('a forecast-office code alone is not a narrative', () => {
  const base = {
    Time: '1208',
    Size: '100',
    Location: 'X',
    County: 'Y',
    State: 'KY',
    Lat: '37.57',
    Lon: '-84.3',
  };
  assert.equal(
    normalizeSpcDailyRow({ ...base, Comments: '(LMK)' }, 'hail', '2025-05-16')
      .comment,
    null,
    '(LMK) is provenance, not a description',
  );
  assert.equal(
    normalizeSpcDailyRow(
      {
        ...base,
        Comments: 'Reported quarter size hail in Tiptonville... TN. (MEG)',
      },
      'hail',
      '2025-05-16',
    ).comment,
    'Reported quarter size hail in Tiptonville... TN. (MEG)',
  );
});

test('the daily path refuses to guess its day', () => {
  const row = { Time: '1', Size: '100', Lat: '37', Lon: '-84' };
  assert.throws(() => normalizeSpcDailyRow(row, 'hail', ''), /ISO day/);
  assert.throws(() => normalizeSpcDailyRow(row, 'hail', '20250516'), /ISO day/);
  assert.throws(() => normalizeSpcDailyRow(row, 'hail', null), /ISO day/);
});

test('an unplottable daily row is dropped', () => {
  assert.equal(
    normalizeSpcDailyRow(
      { Time: '1', Size: '100', Lat: '0', Lon: '0' },
      'hail',
      '2025-05-16',
    ),
    null,
  );
  assert.equal(
    normalizeSpcDailyRow(
      { Time: '1', Speed: '50', Lat: '', Lon: '' },
      'wind',
      '2025-05-16',
    ),
    null,
  );
});

test('times parse, and rubbish does not', () => {
  assert.equal(parseLocalTime('13:15:00'), 795, 'bulk archive format');
  assert.equal(parseLocalTime('06:30'), 390, 'bulk archive, seconds omitted');
  assert.equal(parseLocalTime('1208'), 728, 'per-day files carry no colon');
  assert.equal(parseLocalTime('0000'), 0);
  assert.equal(
    parseLocalTime('123'),
    83,
    'a short stamp pads to 0123, i.e. 01:23',
  );
  assert.equal(parseLocalTime(''), null);
  assert.equal(parseLocalTime(null), null);
  assert.equal(parseLocalTime('not a time'), null);
  assert.equal(parseLocalTime('99:99'), null);
  assert.equal(
    parseLocalTime('2560'),
    null,
    'an impossible clock is not clamped',
  );
});

test('isPlottable rejects null island and out-of-range', () => {
  assert.equal(isPlottable(40, -74), true);
  assert.equal(isPlottable(0, 0), false);
  assert.equal(isPlottable(91, 0), false);
  assert.equal(isPlottable(0, 181), false);
  assert.equal(isPlottable(NaN, 5), false);
});

test('hazards carry their own unit so a wind speed is never read as inches', () => {
  assert.equal(MAGNITUDE_UNITS.hail, 'in');
  assert.equal(MAGNITUDE_UNITS.wind, 'kt');
  assert.deepEqual([...STORM_HAZARDS], ['hail', 'wind']);
});

test('sorting is chronological and stable enough to rebuild byte-identically', () => {
  const make = (date, lat, lon, minute) => ({
    id: `${date}-${lat}-${lon}`,
    date,
    lat,
    lon,
    minute,
    hazard: 'hail',
    size: 1,
    loss: 0,
    trace: false,
    sources: ['spc-bulk'],
    comment: null,
    countyFips: null,
    county: null,
    state: null,
    injuries: null,
    fatalities: null,
  });
  const sorted = sortReports([
    make('2021-05-17', 30, -90, 60),
    make('2021-05-16', 40, -74, 600),
    make('2021-05-16', 40, -74, 60),
    make('2021-05-16', 35, -80, 60),
  ]);
  assert.deepEqual(
    sorted.map((r) => `${r.date} ${r.minute} ${r.lat}`),
    [
      '2021-05-16 60 40',
      '2021-05-16 60 35',
      '2021-05-16 600 40',
      '2021-05-17 60 30',
    ],
    'same minute sorts north first, then east',
  );
});

test('packing round-trips without losing a field the UI needs', () => {
  const original = {
    id: 'x',
    date: '2025-05-16',
    minute: 728,
    hazard: 'hail',
    size: 1.75,
    lat: 37.57,
    lon: -84.3,
    countyFips: '21021',
    state: 'KY',
    county: 'Fayette',
    loss: 5000,
    injuries: null,
    fatalities: null,
    trace: false,
    sources: ['spc-bulk', 'spc-daily'],
    comment: 'quarter size hail',
  };
  const back = unpackReport(packReport(original));
  assert.equal(back.date, original.date);
  assert.equal(back.minute, original.minute);
  assert.equal(back.hazard, 'hail');
  assert.equal(back.size, 1.75);
  assert.equal(back.lat, original.lat);
  assert.equal(back.countyFips, original.countyFips);
  assert.equal(back.county, original.county);
  assert.equal(back.loss, original.loss);
  assert.equal(back.comment, original.comment);
  assert.deepEqual(back.sources, ['spc-bulk', 'spc-daily']);
  assert.equal(back.trace, false);
});

test('packing keeps an absent magnitude as absent rather than as zero inches', () => {
  const packed = packReport({
    date: '2025-05-16',
    minute: null,
    hazard: 'wind',
    size: null,
    lat: 1,
    lon: 2,
    loss: 0,
    trace: true,
    sources: [],
    comment: null,
  });
  assert.equal(packed[1], -1, 'an unknown time is -1');
  assert.equal(packed[3], 0, 'zero reads back as null, not as 0in of hail');
  assert.equal(unpackReport(packed).size, null);
  assert.equal(unpackReport(packed).minute, null);
  assert.equal(unpackReport(packed).trace, true);
});

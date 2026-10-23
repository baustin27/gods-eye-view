/**
 * apps/hail-desk/src/ui/knockList.test.mjs — Unit tests for Knock List and CRM Export.
 *
 * Verifies that canvassing workflow metrics and spreadsheet exports conform
 * to field requirements:
 *   - The 5 canonical statuses protect pipeline reporting from typos.
 *   - Conversion metrics map both appointments and inspections to the inspected count.
 *   - CSV export applies DDE / formula injection protection to prevent code execution
 *     in Excel / Google Sheets when sales reps download lead lists.
 *   - Quoting follows RFC 4180 for commas, double quotes, and line breaks.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KNOCK_STATUSES,
  calculateKnockProgress,
  escapeCsvField,
  exportKnockListCsv,
  isValidKnockStatus,
  renderKnockList,
} from './knockList.js';

test('KNOCK_STATUSES exports the canonical 5 canvassing stages in pipeline order', () => {
  assert.deepStrictEqual(KNOCK_STATUSES, [
    'uncontacted',
    'knocked',
    'appointment',
    'claim',
    'closed',
  ]);
  assert.ok(Object.isFrozen(KNOCK_STATUSES), 'status list is immutable');
});

test('isValidKnockStatus validates approved canvassing stages and rejects invalid inputs', () => {
  for (const status of KNOCK_STATUSES) {
    assert.strictEqual(isValidKnockStatus(status), true, `valid status: ${status}`);
  }

  assert.strictEqual(isValidKnockStatus('random_status'), false);
  assert.strictEqual(isValidKnockStatus(''), false);
  assert.strictEqual(isValidKnockStatus(null), false);
  assert.strictEqual(isValidKnockStatus(undefined), false);
  assert.strictEqual(isValidKnockStatus(123), false);
  assert.strictEqual(isValidKnockStatus({}), false);
});

test('calculateKnockProgress handles empty or non-array inputs cleanly', () => {
  const emptyExpected = {
    total: 0,
    knocked: 0,
    inspected: 0,
    claim: 0,
    remaining: 0,
    percentage: 0,
  };

  assert.deepStrictEqual(calculateKnockProgress([]), emptyExpected);
  assert.deepStrictEqual(calculateKnockProgress(null), emptyExpected);
  assert.deepStrictEqual(calculateKnockProgress(undefined), emptyExpected);
});

test('calculateKnockProgress accurately maps records across all funnel stages', () => {
  const records = [
    { address: '101 Main St', status: 'uncontacted' },
    { address: '103 Main St', status: 'knocked' },
    { address: '105 Main St', status: 'appointment' },
    { address: '107 Main St', status: 'inspected' }, // alternate nomenclature also counted as inspected
    { address: '109 Main St', status: 'claim' },
    { address: '111 Main St', status: 'closed' },
    { address: '113 Main St' }, // default missing status treated as uncontacted
  ];

  const progress = calculateKnockProgress(records);

  // Total: 7 records
  // Knocked: 1 ('knocked')
  // Inspected: 2 ('appointment' + 'inspected')
  // Claim: 1 ('claim')
  // Remaining: 2 ('uncontacted' + missing status)
  // Contacted = 7 - 2 = 5
  // Percentage = Math.round((5 / 7) * 100) = 71%
  assert.strictEqual(progress.total, 7);
  assert.strictEqual(progress.knocked, 1);
  assert.strictEqual(progress.inspected, 2);
  assert.strictEqual(progress.claim, 1);
  assert.strictEqual(progress.remaining, 2);
  assert.strictEqual(progress.percentage, 71);
});

test('calculateKnockProgress calculates 0% for virgin streets and 100% for fully canvassed streets', () => {
  const allUncontacted = [
    { address: '101 Elm', status: 'uncontacted' },
    { address: '103 Elm', status: 'uncontacted' },
  ];
  const p0 = calculateKnockProgress(allUncontacted);
  assert.strictEqual(p0.total, 2);
  assert.strictEqual(p0.remaining, 2);
  assert.strictEqual(p0.percentage, 0);

  const allCompleted = [
    { address: '101 Oak', status: 'knocked' },
    { address: '103 Oak', status: 'appointment' },
    { address: '105 Oak', status: 'claim' },
    { address: '107 Oak', status: 'closed' },
  ];
  const p100 = calculateKnockProgress(allCompleted);
  assert.strictEqual(p100.total, 4);
  assert.strictEqual(p100.remaining, 0);
  assert.strictEqual(p100.percentage, 100);
});

test('escapeCsvField defuses formula injection attacks with a leading single quote', () => {
  // Formula triggers: =, +, -, @
  assert.strictEqual(escapeCsvField('=SUM(A1:B10)'), "'=SUM(A1:B10)");
  assert.strictEqual(escapeCsvField('+12345'), "'+12345");
  assert.strictEqual(escapeCsvField('-500'), "'-500");
  assert.strictEqual(escapeCsvField('@cmd|/c calc'), "'@cmd|/c calc");

  // Leading whitespace before trigger character must also be defused
  assert.strictEqual(escapeCsvField('   =cmd'), "'   =cmd");

  // Formula with comma gets both single quote defusal and RFC 4180 double quote wrapping
  assert.strictEqual(escapeCsvField('=HYPERLINK("http://evil.com", "Click")'), `"'=HYPERLINK(""http://evil.com"", ""Click"")"`);
});

test('escapeCsvField quotes commas, quotes, and newlines per RFC 4180', () => {
  assert.strictEqual(escapeCsvField('123 Main St, Suite 4'), '"123 Main St, Suite 4"');
  assert.strictEqual(escapeCsvField('Has "shake" roof'), '"Has ""shake"" roof"');
  assert.strictEqual(escapeCsvField('Line1\nLine2'), '"Line1\nLine2"');
  assert.strictEqual(escapeCsvField('Line1\r\nLine2'), '"Line1\r\nLine2"');

  // Safe strings without special characters remain unquoted
  assert.strictEqual(escapeCsvField('123 Main St'), '123 Main St');
  assert.strictEqual(escapeCsvField('2.25'), '2.25');

  // Null and undefined produce empty strings
  assert.strictEqual(escapeCsvField(null), '');
  assert.strictEqual(escapeCsvField(undefined), '');
});

test('exportKnockListCsv outputs properly formatted CRM CSV with defused formulas and CRLF', () => {
  const street = 'Colorado Blvd';
  const records = [
    {
      address: '1200 Colorado Blvd',
      radarHailInches: 2.25,
      status: 'appointment',
      notes: 'Hail hit south gable; owner home after 5pm',
    },
    {
      address: '1204 Colorado Blvd, Apt B',
      radarHailInches: 2.0,
      status: 'claim',
      notes: '=SUM(1,2)', // Formula injection test in notes
    },
    {
      address: '1208 Colorado Blvd',
      radarHail: 1.75, // Alternate property name
      status: 'knocked',
      notes: 'No answer; left flyer with "storm" badge', // Quotes test
    },
  ];

  const csv = exportKnockListCsv(street, records);

  // Headers check
  assert.ok(csv.startsWith('Street,Address,RadarHailInches,Status,Notes\r\n'));

  // Ensure CRLF is used consistently across rows
  const lines = csv.split('\r\n');
  assert.strictEqual(lines.length, 5); // header + 3 rows + trailing empty line
  assert.strictEqual(lines[0], 'Street,Address,RadarHailInches,Status,Notes');

  // Row 1: standard row
  assert.strictEqual(
    lines[1],
    'Colorado Blvd,1200 Colorado Blvd,2.25,appointment,Hail hit south gable; owner home after 5pm',
  );

  // Row 2: Address with comma and notes with formula injection
  assert.ok(lines[2].includes('"1204 Colorado Blvd, Apt B"'), 'quoted address with comma');
  assert.ok(lines[2].includes(`"'=SUM(1,2)"`), 'defused formula with comma in quotes');

  // Row 3: Quotes in notes escaped by doubling
  assert.ok(lines[3].includes('"No answer; left flyer with ""storm"" badge"'), 'doubled internal quotes');
});

test('exportKnockListCsv handles empty record sets and missing fields safely', () => {
  const csvEmpty = exportKnockListCsv('Empty St', []);
  assert.strictEqual(csvEmpty, 'Street,Address,RadarHailInches,Status,Notes\r\n');

  // Record with sparse fields defaults status to uncontacted
  const csvSparse = exportKnockListCsv('Sparse St', [{ address: '100 Sparse' }]);
  const lines = csvSparse.split('\r\n');
  assert.strictEqual(lines[1], 'Sparse St,100 Sparse,,uncontacted,');
});

test('renderKnockList safely mounts and returns lifecycle hooks', () => {
  // Verify renderKnockList gracefully returns no-op hooks when no container is passed
  const handles = renderKnockList(null);
  assert.strictEqual(typeof handles.update, 'function');
  assert.strictEqual(typeof handles.destroy, 'function');
  handles.update([]);
  handles.destroy();
});

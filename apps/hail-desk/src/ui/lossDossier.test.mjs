/**
 * apps/hail-desk/src/ui/lossDossier.test.mjs — Unit tests for Property Loss Dossier & Insurance Window.
 *
 * WHY THESE TESTS ARE ESSENTIAL:
 * Insurance claim filings are governed by strict contractual and statutory limitation windows.
 * Off-by-one errors in month calculation can misclassify a time-barred claim as active or vice-versa,
 * leading to litigation or improper claim denials.
 * Similarly, radar-to-spotter corroboration must strictly enforce geographic radius limits (5 km default)
 * so distant storms do not create false dual-source confirmation for an unaffected property.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateClaimFilingStatus,
  calculateMonthsElapsed,
  corroborateLossEvents,
  generatePropertyLossDossier,
  haversineKm,
  renderLossDossier,
} from './lossDossier.js';

test('calculateMonthsElapsed: accurately counts calendar month intervals', () => {
  // Same calendar day: 0 elapsed months
  assert.equal(calculateMonthsElapsed('2024-05-15', '2024-05-15'), 0);

  // Less than 1 month elapsed (e.g. 20 days later)
  assert.equal(calculateMonthsElapsed('2024-05-15', '2024-06-04'), 0);

  // Exactly 1 full calendar month
  assert.equal(calculateMonthsElapsed('2024-05-15', '2024-06-15'), 1);

  // 6 months
  assert.equal(calculateMonthsElapsed('2024-05-15', '2024-11-15'), 6);

  // Future loss date evaluates safely to 0 elapsed months
  assert.equal(calculateMonthsElapsed('2025-05-15', '2024-05-15'), 0);
});

test('calculateClaimFilingStatus: verifies 12-month standard window boundary', () => {
  const lossDate = '2024-05-15';

  // 1 day before the 1-year mark (11 full calendar months elapsed)
  const dayBefore1Yr = calculateClaimFilingStatus(lossDate, '2025-05-14');
  assert.equal(dayBefore1Yr.monthsElapsed, 11);
  assert.equal(dayBefore1Yr.eligible1Yr, true);
  assert.equal(dayBefore1Yr.eligible2Yr, true);
  assert.equal(dayBefore1Yr.label, 'Within Standard Window');

  // Exactly at the 12-month mark (transitions out of 1-year standard window into 2-year extended statute)
  const exactly1Yr = calculateClaimFilingStatus(lossDate, '2025-05-15');
  assert.equal(exactly1Yr.monthsElapsed, 12);
  assert.equal(exactly1Yr.eligible1Yr, false);
  assert.equal(exactly1Yr.eligible2Yr, true);
  assert.equal(exactly1Yr.label, 'Extended Window (2-Yr Statute)');
});

test('calculateClaimFilingStatus: verifies 24-month extended window and past statute boundary', () => {
  const lossDate = '2024-05-15';

  // 18 months elapsed: firmly in extended window
  const eighteenMonths = calculateClaimFilingStatus(lossDate, '2025-11-15');
  assert.equal(eighteenMonths.monthsElapsed, 18);
  assert.equal(eighteenMonths.eligible1Yr, false);
  assert.equal(eighteenMonths.eligible2Yr, true);
  assert.equal(eighteenMonths.label, 'Extended Window (2-Yr Statute)');

  // Exactly at the 24-month mark: final month of extended statute
  const exactly2Yr = calculateClaimFilingStatus(lossDate, '2026-05-15');
  assert.equal(exactly2Yr.monthsElapsed, 24);
  assert.equal(exactly2Yr.eligible1Yr, false);
  assert.equal(exactly2Yr.eligible2Yr, true);
  assert.equal(exactly2Yr.label, 'Extended Window (2-Yr Statute)');

  // 25 months elapsed: past 24-month statute window
  const pastStatute = calculateClaimFilingStatus(lossDate, '2026-06-15');
  assert.equal(pastStatute.monthsElapsed, 25);
  assert.equal(pastStatute.eligible1Yr, false);
  assert.equal(pastStatute.eligible2Yr, false);
  assert.equal(pastStatute.label, 'Past Statute Window');

  // 36 months elapsed
  const threeYears = calculateClaimFilingStatus(lossDate, '2027-05-15');
  assert.equal(threeYears.monthsElapsed, 36);
  assert.equal(threeYears.eligible1Yr, false);
  assert.equal(threeYears.eligible2Yr, false);
  assert.equal(threeYears.label, 'Past Statute Window');
});

test('calculateClaimFilingStatus: supports Date objects, string formats, and numeric timestamps', () => {
  const lossStr = '2024-05-15';
  const lossDate = new Date(2024, 4, 15);
  const lossEpoch = lossDate.getTime();
  const evalDate = new Date(2024, 10, 15); // 6 months later

  const resStr = calculateClaimFilingStatus(lossStr, evalDate);
  const resDate = calculateClaimFilingStatus(lossDate, evalDate);
  const resEpoch = calculateClaimFilingStatus(lossEpoch, evalDate);

  assert.equal(resStr.monthsElapsed, 6);
  assert.equal(resDate.monthsElapsed, 6);
  assert.equal(resEpoch.monthsElapsed, 6);
  assert.equal(resStr.label, 'Within Standard Window');

  // Invalid date inputs throw descriptive TypeError
  assert.throws(() => calculateClaimFilingStatus('not-a-date'), TypeError);
  assert.throws(() => calculateClaimFilingStatus(null), TypeError);
});

test('haversineKm: computes accurate spherical distance between known coordinates', () => {
  // Denver, CO (39.7392, -104.9903) to Boulder, CO (40.0150, -105.2705) ~ 38-40 km
  const km = haversineKm(39.7392, -104.9903, 40.0150, -105.2705);
  assert.ok(km > 38 && km < 41, `Expected ~39 km, got ${km}`);

  // Same point is 0 km
  assert.equal(haversineKm(39.7392, -104.9903, 39.7392, -104.9903), 0);
});

test('corroborateLossEvents: corroborates dual-source radar and spotter events within radius', () => {
  const radarEvents = [
    { date: '2024-05-30', maxMm: 38.1, over: true, houses: 240 },
    { date: '2024-06-15', maxMm: 25.4, over: true, houses: 90 },
  ];

  const spotterReports = [
    // Matches 2024-05-30 within 2.3 km (< 5 km default radius)
    { date: '2024-05-30', magnitude: 150, km: 2.3, comment: '1.5 inch hail' },
    // Disqualified report on 2024-06-15: 8.5 km away (> 5 km default radius)
    { date: '2024-06-15', magnitude: 100, km: 8.5, comment: '1.0 inch hail 8.5 km away' },
  ];

  const merged = corroborateLossEvents(radarEvents, spotterReports, 5);

  assert.equal(merged.length, 2);

  // Newest first order
  assert.equal(merged[0].date, '2024-06-15');
  assert.equal(merged[1].date, '2024-05-30');

  // 2024-06-15: Radar only because spotter report was outside 5 km radius
  assert.equal(merged[0].corroborated, false);
  assert.equal(merged[0].badge, 'Radar Only');
  assert.equal(merged[0].reports.length, 0);

  // 2024-05-30: Corroborated dual-source
  assert.equal(merged[1].corroborated, true);
  assert.equal(merged[1].badge, 'Corroborated');
  assert.equal(merged[1].reports.length, 1);
  assert.equal(merged[1].reports[0].distanceKm, 2.3);
  assert.equal(merged[1].houses, 240);
});

test('corroborateLossEvents: handles spotter-only events and coordinate-based distance checks', () => {
  const radarEvents = [
    // Radar event with geographic coordinates
    { date: '2024-05-30', maxMm: 45.0, lat: 39.75, lon: -104.98 },
  ];

  const spotterReports = [
    // Spotter report near radar coordinates (~1.5 km away)
    { date: '2024-05-30', magnitude: 175, lat: 39.76, lon: -104.97, comment: 'Golf ball hail' },
    // Spotter report on day with no radar event (~3 km away from property)
    { date: '2024-07-20', magnitude: 100, km: 3.1, comment: 'Quarter hail' },
    // Spotter report on independent day too far away (> 5 km)
    { date: '2024-08-01', magnitude: 100, km: 12.0, comment: 'Far hail' },
  ];

  const merged = corroborateLossEvents(radarEvents, spotterReports, 5);

  // Should have 2 events: 2024-07-20 (spotter only) and 2024-05-30 (corroborated)
  // The 2024-08-01 report was dropped due to exceeding radius
  assert.equal(merged.length, 2);

  // Sorted newest first
  assert.equal(merged[0].date, '2024-07-20');
  assert.equal(merged[0].corroborated, false);
  assert.equal(merged[0].badge, 'Spotter Only');
  assert.equal(merged[0].hasRadar, false);
  assert.equal(merged[0].hasSpotter, true);

  assert.equal(merged[1].date, '2024-05-30');
  assert.equal(merged[1].corroborated, true);
  assert.equal(merged[1].badge, 'Corroborated');
  assert.equal(merged[1].hasRadar, true);
  assert.equal(merged[1].hasSpotter, true);
  assert.ok(merged[1].reports[0].distanceKm < 5);
});

test('corroborateLossEvents: handles empty and malformed inputs gracefully', () => {
  assert.deepEqual(corroborateLossEvents([], []), []);
  assert.deepEqual(corroborateLossEvents(null, null), []);
  assert.deepEqual(corroborateLossEvents(undefined, undefined), []);
});

test('renderLossDossier: gracefully handles headless environments and renders with mock DOM', () => {
  const dossier = {
    property: { street: '100 Main St' },
    primaryFilingStatus: { label: 'Within Standard Window', eligible1Yr: true, eligible2Yr: true },
    events: [
      {
        date: '2024-05-15',
        badge: 'Corroborated',
        status: 'corroborated',
        corroborated: true,
        maxMm: 38.1,
        filingStatus: { label: 'Within Standard Window' },
        reportCount: 2,
      },
    ],
  };

  // Safe execution when document is undefined
  assert.doesNotThrow(() => {
    renderLossDossier(dossier, null);
  });

  // Test with mock DOM structure
  const elementsCreated = [];
  const mockContainer = {
    innerHTML: '',
    appendChild(child) {
      this.child = child;
    },
  };

  globalThis.document = {
    createElement(tag) {
      const el = {
        tagName: tag,
        className: '',
        children: [],
        appendChild(c) {
          this.children.push(c);
        },
        classList: {
          add(cls) {
            el.className += ` ${cls}`;
          },
        },
      };
      elementsCreated.push(el);
      return el;
    },
  };

  try {
    renderLossDossier(dossier, mockContainer);
    assert.ok(mockContainer.child);
    assert.ok(elementsCreated.some((el) => el.className.includes('loss-dossier-panel')));
  } finally {
    delete globalThis.document;
  }
});

test('generatePropertyLossDossier: integrates events with insurance windows and aggregates metrics', () => {
  const property = { street: '450 S Broadway', city: 'Denver', state: 'CO' };
  const radarEvents = [
    { date: '2024-05-15', maxMm: 50.8, over: true },
    { date: '2022-01-10', maxMm: 30.0, over: true },
  ];
  const spotterReports = [
    { date: '2024-05-15', magnitude: 200, km: 1.5 },
  ];

  const evalDate = '2025-01-15'; // 8 months after May 2024, 36 months after Jan 2022
  const dossier = generatePropertyLossDossier(property, radarEvents, spotterReports, {
    currentDate: evalDate,
    maxRadiusKm: 5,
  });

  assert.equal(dossier.property.street, '450 S Broadway');
  assert.equal(dossier.totalEvents, 2);
  assert.equal(dossier.corroboratedCount, 1);
  assert.equal(dossier.eligible1YrCount, 1);
  assert.equal(dossier.eligible2YrCount, 1);

  // May 2024 event is primary (newest)
  const recent = dossier.events[0];
  assert.equal(recent.date, '2024-05-15');
  assert.equal(recent.corroborated, true);
  assert.equal(recent.filingStatus.label, 'Within Standard Window');

  // Jan 2022 event is past statute (> 24 months)
  const older = dossier.events[1];
  assert.equal(older.date, '2022-01-10');
  assert.equal(older.corroborated, false);
  assert.equal(older.filingStatus.label, 'Past Statute Window');
});

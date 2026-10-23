/**
 * apps/hail-desk/src/ui/omnibar.test.mjs — unit tests for Omnibar classifier & typeahead controller.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyQuery, createOmnibar, US_STATE_CODES, US_STATE_NAMES } from './omnibar.js';

test('classifyQuery classifies addresses correctly', () => {
  // Classic street addresses with cardinal direction and street suffix
  assert.equal(classifyQuery('2840 S Elm St'), 'address');
  // Ordinal numbered street (critical for Denver, NYC, Chicago grid streets)
  assert.equal(classifyQuery('1042 16th St'), 'address');
  // Simple numbered street name
  assert.equal(classifyQuery('100 Main Street'), 'address');
  // Subunit/unit letter house number
  assert.equal(classifyQuery('12-A Baker St'), 'address');
  // Multi-word street name
  assert.equal(classifyQuery('742 Evergreen Terrace'), 'address');
  // Full address with city and state tokens
  assert.equal(classifyQuery('450 5th Ave, New York, NY'), 'address');
  // Leading and trailing whitespace should be tolerated
  assert.equal(classifyQuery('   2840 S Elm St   '), 'address');
  assert.equal(classifyQuery('\t1042 16th St\n'), 'address');
});

test('classifyQuery classifies ISO dates correctly', () => {
  assert.equal(classifyQuery('2024-06-01'), 'date');
  assert.equal(classifyQuery('1990-07-11'), 'date');
  assert.equal(classifyQuery('2025-12-31'), 'date');
  // Whitespace-padded ISO dates
  assert.equal(classifyQuery('  2024-06-01  '), 'date');
  assert.equal(classifyQuery('\n2025-05-18\t'), 'date');
});

test('classifyQuery classifies states correctly', () => {
  // 2-letter uppercase postal codes
  assert.equal(classifyQuery('CO'), 'state');
  assert.equal(classifyQuery('TX'), 'state');
  assert.equal(classifyQuery('CA'), 'state');
  assert.equal(classifyQuery('FL'), 'state');
  assert.equal(classifyQuery('NY'), 'state');

  // Case insensitivity on postal codes
  assert.equal(classifyQuery('co'), 'state');
  assert.equal(classifyQuery('tx'), 'state');
  assert.equal(classifyQuery('wy'), 'state');

  // Full state names (case-insensitive)
  assert.equal(classifyQuery('Colorado'), 'state');
  assert.equal(classifyQuery('colorado'), 'state');
  assert.equal(classifyQuery('COLORADO'), 'state');
  assert.equal(classifyQuery('Texas'), 'state');
  assert.equal(classifyQuery('California'), 'state');
  assert.equal(classifyQuery('New York'), 'state');
  assert.equal(classifyQuery('puerto rico'), 'state');
  assert.equal(classifyQuery('Washington DC'), 'state');

  // Whitespace around state queries
  assert.equal(classifyQuery('   CO   '), 'state');
  assert.equal(classifyQuery('   Colorado   '), 'state');
});

test('classifyQuery classifies places (cities, towns, counties) correctly', () => {
  assert.equal(classifyQuery('Denver'), 'place');
  assert.equal(classifyQuery('Aurora'), 'place');
  assert.equal(classifyQuery('El Paso County'), 'place');
  assert.equal(classifyQuery('Adams County'), 'place');
  assert.equal(classifyQuery('Fort Collins'), 'place');
  assert.equal(classifyQuery('Boulder'), 'place');
  assert.equal(classifyQuery('Colorado Springs'), 'place');
  assert.equal(classifyQuery('St. Louis'), 'place');
  assert.equal(classifyQuery('Winston-Salem'), 'place');

  // Whitespace around place queries
  assert.equal(classifyQuery('   Denver   '), 'place');
  assert.equal(classifyQuery('  El Paso County  '), 'place');
});

test('classifyQuery handles edge cases: empty strings, whitespace, punctuation, numbers', () => {
  // Empty strings & whitespace
  assert.equal(classifyQuery(''), null);
  assert.equal(classifyQuery('   '), null);
  assert.equal(classifyQuery('\t\n\r'), null);

  // Pure punctuation & symbols
  assert.equal(classifyQuery('???'), null);
  assert.equal(classifyQuery('---'), null);
  assert.equal(classifyQuery('!@#$%^&*()'), null);
  assert.equal(classifyQuery(',.-_'), null);
  assert.equal(classifyQuery('   ???   '), null);

  // Pure numbers (not dates, no street names)
  assert.equal(classifyQuery('12345'), null);
  assert.equal(classifyQuery('80202'), null);
  assert.equal(classifyQuery('42'), null);
  assert.equal(classifyQuery('123 456'), null);

  // Non-string values
  assert.equal(classifyQuery(null), null);
  assert.equal(classifyQuery(undefined), null);
  assert.equal(classifyQuery(12345), null);
  assert.equal(classifyQuery({}), null);
  assert.equal(classifyQuery([]), null);
});

/**
 * Mock input element simulating an HTMLInputElement in Node.js test environment.
 */
class MockInputElement extends EventTarget {
  constructor(initialValue = '') {
    super();
    this.value = initialValue;
  }

  type(text) {
    this.value = text;
    this.dispatchEvent(new Event('input'));
  }

  pressEnter() {
    let defaultPrevented = false;
    const event = new Event('keydown');
    event.key = 'Enter';
    event.preventDefault = () => {
      defaultPrevented = true;
    };
    this.dispatchEvent(event);
    return defaultPrevented;
  }
}

test('createOmnibar validates input element', () => {
  assert.throws(() => createOmnibar({}), TypeError);
  assert.throws(() => createOmnibar({ inputEl: null }), TypeError);
  assert.throws(() => createOmnibar({ inputEl: {} }), TypeError);
});

test('createOmnibar debounces input events and passes query and type', async () => {
  const inputEl = new MockInputElement();
  const searches = [];

  const cleanup = createOmnibar({
    inputEl,
    onSearch: (query, type) => {
      searches.push({ query, type });
    },
    debounceMs: 50,
  });

  // Type rapid keystrokes: "D", "De", "Den", "Denver"
  inputEl.type('D');
  inputEl.type('De');
  inputEl.type('Den');
  inputEl.type('Denver');

  // Immediately after typing, debounced search must NOT have executed yet
  assert.equal(searches.length, 0);

  // Wait for debounce window (50ms + margin)
  await new Promise((resolve) => setTimeout(resolve, 80));

  // Should have executed exactly once with final input and classification
  assert.equal(searches.length, 1);
  assert.deepEqual(searches[0], { query: 'Denver', type: 'place' });

  cleanup();
});

test('createOmnibar triggers search immediately on Enter key and cancels pending debounce', async () => {
  const inputEl = new MockInputElement();
  const searches = [];

  const cleanup = createOmnibar({
    inputEl,
    onSearch: (query, type) => {
      searches.push({ query, type });
    },
    debounceMs: 100,
  });

  // Type address
  inputEl.type('2840 S Elm St');
  assert.equal(searches.length, 0);

  // Press Enter immediately
  const prevented = inputEl.pressEnter();
  assert.equal(prevented, true, 'Enter key should prevent default form submission');

  // Immediately fired
  assert.equal(searches.length, 1);
  assert.deepEqual(searches[0], { query: '2840 S Elm St', type: 'address' });

  // Wait longer than debounce window to verify pending timer was cancelled
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Still exactly 1 search call
  assert.equal(searches.length, 1);

  cleanup();
});

test('createOmnibar cleanup cancels timer and unregisters listeners', async () => {
  const inputEl = new MockInputElement();
  const searches = [];

  const cleanup = createOmnibar({
    inputEl,
    onSearch: (query, type) => {
      searches.push({ query, type });
    },
    debounceMs: 50,
  });

  inputEl.type('2024-06-01');

  // Destroy immediately before debounce timer resolves
  cleanup.destroy();

  // Wait past debounce time
  await new Promise((resolve) => setTimeout(resolve, 80));

  // No search should have been executed
  assert.equal(searches.length, 0);

  // Subsequent events should be ignored
  inputEl.type('Colorado');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(searches.length, 0);

  inputEl.pressEnter();
  assert.equal(searches.length, 0);
});

// Tests for lib/salesFilterChips.js — the "which Additional filters are
// set" snapshot behind the Sales Analysis warning badge and count-line
// note. One chip per control that is away from its default.
//
// Run: cd web && node test/salesFilterChips.test.js

import assert from 'node:assert/strict';
import { salesFilterChips, salesFilterChipText, rangeLabel } from '../src/lib/salesFilterChips.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** The controls exactly as a fresh page has them. */
function defaults(overrides = {}) {
  return {
    priceLow: '', priceHigh: '', sizeLow: '', sizeHigh: '', streetName: '',
    farFlungKm: '', farFlungExclude: false, n1: 'any',
    yearLow: '', yearHigh: '', bldgLow: '', bldgHigh: '',
    ...overrides,
  };
}
const keys = (chips) => chips.map((c) => c.key);

console.log('salesFilterChips');

test('a fresh page has nothing set', () => {
  assert.deepEqual(salesFilterChips(defaults()), []);
  assert.deepEqual(salesFilterChips({}), []);
  assert.deepEqual(salesFilterChips(), []);
});

test('whitespace-only text and junk numbers are not set', () => {
  assert.deepEqual(salesFilterChips(defaults({ streetName: '  \t', priceLow: 'abc', sizeHigh: '-' })), []);
});

test('price bounds format as money', () => {
  assert.equal(salesFilterChips(defaults({ priceLow: '250000' }))[0].label, 'Price ≥ $250,000');
  assert.equal(salesFilterChips(defaults({ priceHigh: '2000000' }))[0].label, 'Price ≤ $2,000,000');
  assert.equal(salesFilterChips(defaults({ priceLow: '1', priceHigh: '2' }))[0].label, 'Price $1–$2');
});

test('lot size bounds read in square feet', () => {
  const chips = salesFilterChips(defaults({ sizeLow: '5000', sizeHigh: '10000' }));
  assert.deepEqual(keys(chips), ['size']);
  assert.equal(chips[0].label, 'Lot size 5,000–10,000 sf');
});

test('street name carries the typed value', () => {
  const chips = salesFilterChips(defaults({ streetName: ' MAIN ' }));
  assert.equal(chips[0].label, 'Street MAIN');
  assert.match(chips[0].detail, /contains "MAIN"/);
});

test('Far-Flung counts only when Exclude is on with a positive threshold', () => {
  assert.deepEqual(salesFilterChips(defaults({ farFlungKm: '15' })), []);
  assert.deepEqual(salesFilterChips(defaults({ farFlungExclude: true })), []);
  assert.deepEqual(salesFilterChips(defaults({ farFlungKm: '0', farFlungExclude: true })), []);
  const chips = salesFilterChips(defaults({ farFlungKm: '15', farFlungExclude: true }));
  assert.equal(chips[0].label, 'Far-Flung > 15 km excluded');
});

test('the N1 select counts when moved off Any', () => {
  assert.equal(salesFilterChips(defaults({ n1: 'matched' }))[0].label, 'N1 matched');
  assert.equal(salesFilterChips(defaults({ n1: 'unmatched' }))[0].label, 'N1 unmatched');
});

test('a retired control contributes nothing', () => {
  // The Rise filter is gone; a stale snapshot key must not resurrect a chip.
  assert.deepEqual(salesFilterChips(defaults({ rise: 'mid' })), []);
});

test('controls OUTSIDE the disclosure are not chipped', () => {
  // Year built and Bldg size live above the disclosure, always visible, and
  // the count line names each by how many sales it removed. A chip would be
  // a warning about something the user can already see, filed under a
  // heading it is not part of.
  assert.deepEqual(salesFilterChips(defaults({ yearLow: '1950', yearHigh: '1970' })), []);
  assert.deepEqual(salesFilterChips(defaults({ bldgLow: '1200', bldgHigh: '2500' })), []);
});

test('chips come out in control order, top of the disclosure to bottom', () => {
  const chips = salesFilterChips(defaults({
    n1: 'matched', farFlungExclude: true, farFlungKm: '30',
    streetName: 'A', sizeLow: '1', priceLow: '1',
  }));
  assert.deepEqual(keys(chips), ['price', 'size', 'street', 'farFlung', 'n1']);
  assert.ok(chips.every((c) => c.active));
});

test('salesFilterChipText joins the labels with a middot', () => {
  assert.equal(salesFilterChipText(salesFilterChips(defaults({ streetName: 'B', n1: 'matched' }))), 'Street B · N1 matched');
  assert.equal(salesFilterChipText([]), '');
  assert.equal(salesFilterChipText(null), '');
});

test('rangeLabel covers both, either, and neither bound', () => {
  assert.equal(rangeLabel(1, 2, 'sf'), '1–2 sf');
  assert.equal(rangeLabel(1, null, 'sf'), '≥ 1 sf');
  assert.equal(rangeLabel(null, 2, 'sf'), '≤ 2 sf');
  assert.equal(rangeLabel(null, null, 'sf'), '');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

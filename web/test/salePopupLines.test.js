// lib/salePopupLines.js — the building / sale block of the parcel popup.
// Run with `node test/salePopupLines.test.js` or via `npm test`.
//
// The rule worth locking is the one that decides WHICH rate a parcel gets:
// land sells by the square foot and the acre, everything else by the
// building. Getting it backwards puts a confident $/Bldg SF on a vacant lot,
// which is the number an appraiser would carry straight into a comp set.
import assert from 'node:assert/strict';
import {
  isLandCategory, areaText, yearText, buildingLines, saleLines,
} from '../src/lib/salePopupLines.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// The real formatter's contract, small enough to mirror exactly: 0 and
// negatives are not prices and come back null.
const money = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return '$' + Math.round(n).toLocaleString('en-US');
};

console.log('salePopupLines');

test('areaText — formats with separators, rejects zero / junk', () => {
  assert.equal(areaText(2140), '2,140 sf');
  assert.equal(areaText('177079'), '177,079 sf');
  for (const v of [0, -5, null, undefined, '', 'n/a']) assert.equal(areaText(v), null);
});

test('yearText — rejects the roll’s "unknown" sentinels', () => {
  assert.equal(yearText(1962), '1962');
  assert.equal(yearText('2011'), '2011');
  // 0 and blank both mean nobody recorded one; "Year Built 0" is worse
  // than no line at all.
  for (const v of [0, '', null, undefined, 'n/a', 1500, 9999]) {
    assert.equal(yearText(v), null, `${JSON.stringify(v)} should not render`);
  }
});

test('isLandCategory — exact, and only the corrected category', () => {
  assert.equal(isLandCategory('Land'), true);
  assert.equal(isLandCategory(' Land '), true);
  for (const c of ['Residential', 'Office', 'land', '', null, undefined]) {
    assert.equal(isLandCategory(c), false);
  }
});

test('buildingLines — both fields, in order, on an ordinary parcel', () => {
  assert.deepEqual(buildingLines({ year_built: 1962, total_living_area: 2140 }), [
    { label: 'Year Built', value: '1962' },
    { label: 'Living Area', value: '2,140 sf' },
  ]);
});

test('buildingLines — each degrades on its own; a bare lot yields none', () => {
  assert.deepEqual(buildingLines({ total_living_area: 900 }), [
    { label: 'Living Area', value: '900 sf' },
  ]);
  assert.deepEqual(buildingLines({ year_built: 1988 }), [
    { label: 'Year Built', value: '1988' },
  ]);
  assert.deepEqual(buildingLines({}), []);
  assert.deepEqual(buildingLines(), []);
});

test('saleLines — an improved sale gets $/Bldg SF and NOT the land rates', () => {
  const lines = saleLines({
    _saleDate: '2025-04-10',
    _salePrice: 425000,
    _saleCategory: 'Residential',
    _pricePerBldgSf: 198.6,
    _pricePerSf: 70.26,
    _pricePerAcre: 3060000,
  }, money);
  assert.deepEqual(lines, [
    { label: 'Sale Date', value: '2025-04-10' },
    { label: 'Sale Price', value: '$425,000' },
    { label: '$/Bldg SF', value: '$199' },
  ]);
});

test('saleLines — a land sale gets $/Lot SF + $/Acre and NOT $/Bldg SF', () => {
  const lines = saleLines({
    _saleDate: '2025-02-14',
    _salePrice: 310000,
    _saleCategory: 'Land',
    _pricePerSf: 25.83,
    _pricePerAcre: 1125000,
    // Even if something upstream put one here, a land sale must not show it.
    _pricePerBldgSf: 999,
  }, money);
  assert.deepEqual(lines, [
    { label: 'Sale Date', value: '2025-02-14' },
    { label: 'Sale Price', value: '$310,000' },
    { label: '$/Lot SF', value: '$26' },
    { label: '$/Acre', value: '$1,125,000' },
  ]);
});

test('saleLines — a parcel with no sale contributes nothing (Property tab)', () => {
  assert.deepEqual(saleLines({ roll_number: '123', year_built: 1950 }, money), []);
  assert.deepEqual(saleLines({}, money), []);
  assert.deepEqual(saleLines(undefined, money), []);
});

test('saleLines — a nominal transfer shows what the grid shows', () => {
  // A $1 non-arms-length transfer reports "$1", because that is the
  // recorded consideration and it is exactly what the Sale Price COLUMN
  // renders (both go through formatDollars, which rejects 0 and negatives
  // but not 1). The popup and the row must never disagree about a price.
  // These rows are excluded from the set by default anyway; when the user
  // ticks them back in, $1 is the honest figure and the tell-tale.
  assert.deepEqual(saleLines({
    _saleDate: '2024-06-19', _salePrice: 1, _saleCategory: 'Residential',
  }, money), [
    { label: 'Sale Date', value: '2024-06-19' },
    { label: 'Sale Price', value: '$1' },
  ]);
  // $0 genuinely has no price to show; the date still stands.
  assert.deepEqual(saleLines({
    _saleDate: '2024-06-19', _salePrice: 0, _saleCategory: 'Residential',
  }, money), [{ label: 'Sale Date', value: '2024-06-19' }]);
});

test('saleLines — a withheld rate simply omits its line', () => {
  // Mixed sales have their land rates withheld upstream; the popup must
  // show the sale without inventing a rate to fill the gap.
  const lines = saleLines({
    _saleDate: '2025-03-03', _salePrice: 3300000, _saleCategory: 'Land',
    _pricePerSf: null, _pricePerAcre: null,
  }, money);
  assert.deepEqual(lines, [
    { label: 'Sale Date', value: '2025-03-03' },
    { label: 'Sale Price', value: '$3,300,000' },
  ]);
});

test('saleLines — an unclassified category is treated as improved', () => {
  // Falling to the land rates would put a $/Lot SF on something nobody
  // has established is land; $/Bldg SF at least requires a living area.
  const lines = saleLines({
    _saleDate: '2025-01-20', _salePrice: 5400000, _saleCategory: '(unclassified)',
    _pricePerBldgSf: 120, _pricePerSf: 58,
  }, money);
  assert.deepEqual(lines.at(-1), { label: '$/Bldg SF', value: '$120' });
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

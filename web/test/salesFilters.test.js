// Enforcing tests for lib/salesFilters.js — the Sales-tab size and
// street-name filters. Plain-node runner; run with
//   cd web && npm test
// or
//   node test/salesFilters.test.js
//
// The two rules worth locking, because getting either backwards is a
// silent corruption of a comp set rather than a visible bug:
//   1. EMPTY IS OFF — a blank bound disables that side; both blank is a
//      complete no-op.
//   2. MISSING IS EXCLUDED — an active filter drops rows it cannot test,
//      rather than passing unknowns through into a constrained set.
// Plus the one that cost real money in the Manitoba app: size compares
// against the SALE-GROUP total, and an incomplete group is untestable.

import assert from 'node:assert/strict';
import {
  parseBound, saleGroupLandSf, passesSizeFilter,
  saleAddressText, normalizeStreetQuery, passesStreetFilter,
  salePriceOf, passesRange, passesPriceFilter,
  saleZoningCodes, passesZoningFilter,
} from '../src/lib/salesFilters.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed += 1;
  }
}

console.log('salesFilters');

/** Minimal SaleRecord. */
function sale(instrument, landSf, addr = {}) {
  return {
    instrument,
    landSf,
    streetNumber: addr.number ?? null,
    streetDirection: addr.dir ?? null,
    streetName: addr.name ?? null,
  };
}
/** groups map from a list of sales, keyed by instrument. */
function groupsOf(...sales) {
  const g = new Map();
  for (const s of sales) {
    if (!g.has(s.instrument)) g.set(s.instrument, []);
    g.get(s.instrument).push(s);
  }
  return g;
}

// 1. parseBound ============================================================
test('parseBound — blank / null / whitespace is off, not zero', () => {
  for (const v of [null, undefined, '', '   ']) assert.equal(parseBound(v), null);
});

test('parseBound — parses plain and formatted numbers', () => {
  assert.equal(parseBound('5000'), 5000);
  assert.equal(parseBound(' 5,000 '), 5000);
  assert.equal(parseBound('$5,000'), 5000);
  assert.equal(parseBound('1234.5'), 1234.5);
  assert.equal(parseBound(0), 0);
});

test('parseBound — junk and negatives are off', () => {
  for (const v of ['abc', '-1', '-0.5']) assert.equal(parseBound(v), null);
});

// 2. Group land total ======================================================
test('saleGroupLandSf — single-parcel sale is its own area', () => {
  const a = sale('I1', 4000);
  assert.deepEqual(saleGroupLandSf(a, groupsOf(a)), { landSf: 4000, complete: true });
});

test('saleGroupLandSf — multi-parcel sale sums the whole group', () => {
  // The point of the whole function: a 3-lot assembly is one 12,000 sf
  // deal, and BOTH member rows must report the same total.
  const a = sale('I1', 4000);
  const b = sale('I1', 5000);
  const c = sale('I1', 3000);
  const g = groupsOf(a, b, c);
  assert.deepEqual(saleGroupLandSf(a, g), { landSf: 12000, complete: true });
  assert.deepEqual(saleGroupLandSf(b, g), { landSf: 12000, complete: true });
});

test('saleGroupLandSf — a member missing its area marks the group incomplete', () => {
  const a = sale('I1', 4000);
  const b = sale('I1', 0);
  const res = saleGroupLandSf(a, groupsOf(a, b));
  assert.equal(res.complete, false);
  assert.equal(res.landSf, 4000, 'the partial sum is still reported, just flagged');
});

test('saleGroupLandSf — a sale with no group entry falls back to itself', () => {
  const a = sale('I1', 4000);
  assert.deepEqual(saleGroupLandSf(a, new Map()), { landSf: 4000, complete: true });
  assert.deepEqual(saleGroupLandSf(a, null), { landSf: 4000, complete: true });
});

// 3. Size filter ===========================================================
test('passesSizeFilter — both bounds null is a no-op, even for untestable rows', () => {
  const a = sale('I1', 0);
  assert.equal(passesSizeFilter(a, groupsOf(a), null, null), true);
});

test('passesSizeFilter — lo only / hi only bound one side', () => {
  const a = sale('I1', 5000);
  const g = groupsOf(a);
  assert.equal(passesSizeFilter(a, g, 4000, null), true);
  assert.equal(passesSizeFilter(a, g, 6000, null), false);
  assert.equal(passesSizeFilter(a, g, null, 6000), true);
  assert.equal(passesSizeFilter(a, g, null, 4000), false);
});

test('passesSizeFilter — bounds are inclusive', () => {
  const a = sale('I1', 5000);
  const g = groupsOf(a);
  assert.equal(passesSizeFilter(a, g, 5000, 5000), true);
});

test('passesSizeFilter — an incomplete group fails while the filter is on', () => {
  // The trap: the partial sum (4,000) would sneak a large assembly into
  // a small-lot search. Untestable must mean excluded.
  const a = sale('I1', 4000);
  const b = sale('I1', 0);
  const g = groupsOf(a, b);
  assert.equal(passesSizeFilter(a, g, null, 4500), false);
  assert.equal(passesSizeFilter(b, g, null, 4500), false);
});

test('passesSizeFilter — a zero-area sale fails an active filter', () => {
  const a = sale('I1', 0);
  assert.equal(passesSizeFilter(a, groupsOf(a), null, 999999), false);
});

test('passesSizeFilter — both members of a group pass or fail together', () => {
  const a = sale('I1', 4000);
  const b = sale('I1', 5000);
  const g = groupsOf(a, b);
  // 9,000 total: inside a 8k-10k window even though neither lot is.
  assert.equal(passesSizeFilter(a, g, 8000, 10000), true);
  assert.equal(passesSizeFilter(b, g, 8000, 10000), true);
  // And neither passes a window sized for the individual lots.
  assert.equal(passesSizeFilter(a, g, 3000, 6000), false);
  assert.equal(passesSizeFilter(b, g, 3000, 6000), false);
});

// 4. Street filter =========================================================
test('saleAddressText composes and normalizes the CSV parts', () => {
  assert.equal(saleAddressText(sale('I1', 0, { number: '185', name: 'bannerman' })),
    '185 BANNERMAN');
  assert.equal(saleAddressText(sale('I1', 0, { number: '12', dir: 'w', name: 'portage' })),
    '12 W PORTAGE');
  assert.equal(saleAddressText(sale('I1', 0, { name: '  main   street ' })), 'MAIN STREET');
  assert.equal(saleAddressText(sale('I1', 0)), '');
});

test('normalizeStreetQuery — blank is off, otherwise upper + collapsed', () => {
  for (const v of [null, undefined, '', '   ']) assert.equal(normalizeStreetQuery(v), null);
  assert.equal(normalizeStreetQuery('  bannerman  ave '), 'BANNERMAN AVE');
});

test('passesStreetFilter — blank query passes everything', () => {
  assert.equal(passesStreetFilter(sale('I1', 0), null), true);
  assert.equal(passesStreetFilter(sale('I1', 0), ''), true);
});

test('passesStreetFilter — case-insensitive substring match', () => {
  const a = sale('I1', 0, { number: '185', name: 'BANNERMAN' });
  assert.equal(passesStreetFilter(a, normalizeStreetQuery('bannerman')), true);
  assert.equal(passesStreetFilter(a, normalizeStreetQuery('BANNER')), true);
  assert.equal(passesStreetFilter(a, normalizeStreetQuery('185')), true);
  assert.equal(passesStreetFilter(a, normalizeStreetQuery('main')), false);
});

test('passesStreetFilter — a sale with no address fails an active query', () => {
  assert.equal(passesStreetFilter(sale('I1', 0), normalizeStreetQuery('main')), false);
});

// 5. Price ================================================================
/** SaleRecord with a price. */
function priced(instrument, salePrice, landSf) {
  return { instrument, salePrice, landSf };
}

test('salePriceOf — reads the sale total, rejects 0 and the $1 sentinel', () => {
  assert.equal(salePriceOf(priced('I1', 250000, 5000)), 250000);
  assert.equal(salePriceOf(priced('I1', 0, 5000)), null);
  // SABRE's nominal $1 on a non-arms-length transfer is not a price, and
  // must not satisfy an "under $50,000" search as though it were one.
  assert.equal(salePriceOf(priced('I1', 1, 5000)), null);
  assert.equal(salePriceOf({}), null);
});

test('salePriceOf is NOT summed across a group', () => {
  // SABRE repeats the whole sale price on every component row; summing
  // would treble a three-lot sale.
  const a = priced('I1', 600000, 4000);
  const b = priced('I1', 600000, 4000);
  groupsOf(a, b);
  assert.equal(salePriceOf(a), 600000);
  assert.equal(salePriceOf(b), 600000);
});

test('passesPriceFilter — bounds, inclusivity, and missing-excluded', () => {
  const a = priced('I1', 250000, 5000);
  assert.equal(passesPriceFilter(a, null, null), true);
  assert.equal(passesPriceFilter(a, 200000, 300000), true);
  assert.equal(passesPriceFilter(a, 250000, 250000), true);
  assert.equal(passesPriceFilter(a, 300000, null), false);
  assert.equal(passesPriceFilter(a, null, 200000), false);
  assert.equal(passesPriceFilter(priced('I1', 1, 5000), 0, 999999), false);
});

// 6. Shared range semantics =============================================
test('passesRange — shared semantics', () => {
  assert.equal(passesRange(null, null, null), true);
  assert.equal(passesRange(null, 1, null), false);
  assert.equal(passesRange(5, 5, 5), true);
  assert.equal(passesRange(NaN, 1, 10), false);
});

// 7. Zoning ================================================================
const strip = (v) => (v == null || v === '' ? v : String(v).split(' - ')[0].trim());
/** Joined feature carrying zoning from either/both sources. */
function zoned({ sale, top1, top2 } = {}) {
  return { properties: { _saleZoning: sale, zoning_top1: top1, zoning_top2: top2 } };
}

test('saleZoningCodes reads BOTH the sale zoning and the current zoning', () => {
  // The two disagree after a rezoning, and the filter has to see both:
  // current zoning is blank until the Zoning overlay runs, and sale
  // zoning ignores a rezoning.
  const f = zoned({ sale: 'R2', top1: 'C2 - Commercial', top2: 'M1' });
  assert.deepEqual([...saleZoningCodes(f, strip)].sort(), ['C2', 'M1', 'R2']);
});

test('saleZoningCodes strips the " - Description" suffix and upper-cases', () => {
  const f = zoned({ top1: 'r2 - Two Family Residential' });
  assert.deepEqual([...saleZoningCodes(f, strip)], ['R2']);
});

test('saleZoningCodes de-duplicates when both sources agree', () => {
  const f = zoned({ sale: 'R2', top1: 'R2 - Two Family Residential' });
  assert.deepEqual([...saleZoningCodes(f, strip)], ['R2']);
});

test('saleZoningCodes drops blanks and nulls', () => {
  assert.equal(saleZoningCodes(zoned({ sale: '', top1: null }), strip).size, 0);
  assert.equal(saleZoningCodes(null, strip).size, 0);
});

test('passesZoningFilter — null selection is no filter', () => {
  assert.equal(passesZoningFilter(zoned({ sale: 'R2' }), null, strip), true);
  assert.equal(passesZoningFilter(zoned({}), null, strip), true);
});

test('passesZoningFilter — matches if ANY of the sale’s codes is ticked', () => {
  const f = zoned({ sale: 'R2', top1: 'C2' });
  assert.equal(passesZoningFilter(f, new Set(['C2']), strip), true, 'current zoning ticked');
  assert.equal(passesZoningFilter(f, new Set(['R2']), strip), true, 'sale zoning ticked');
  assert.equal(passesZoningFilter(f, new Set(['M1']), strip), false);
});

test('passesZoningFilter — a sale with no zoning fails an active filter', () => {
  assert.equal(passesZoningFilter(zoned({}), new Set(['R2']), strip), false);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

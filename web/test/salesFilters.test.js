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
  saleUseCodeOf, isVacantUseCode, groupVacancy, passesVacantFilter,
  groupSpreadKm, isFarFlung,
  isLandSetUseCode, resolveMixedSales,
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

// ---- Vacant / improved ----------------------------------------------------
const useCode = (code, inst = 'I1', live = null) => ({
  properties: { _saleUseCode: code, property_use_code: live, _saleInstrument: inst },
});

test('saleUseCodeOf prefers the CSV code and strips the live description', () => {
  assert.equal(saleUseCodeOf(useCode('VCOMM')), 'VCOMM');
  assert.equal(saleUseCodeOf(useCode(null, 'I1', 'VRES1 - VACANT RESIDENTIAL 1')), 'VRES1');
  assert.equal(saleUseCodeOf(useCode('resmc')), 'RESMC');
  assert.equal(saleUseCodeOf({ properties: {} }), '');
});

test('isVacantUseCode — any V-prefixed code, plus CNVAC', () => {
  for (const c of ['VRES1', 'VRES2', 'VCOMM', 'VINDU', 'VAGRI', 'VAPRK', 'CNVAC']) {
    assert.equal(isVacantUseCode(c), true, c);
  }
  // Prefix rule, not a fixed list: a vacant code the City adds later
  // is picked up without a code change.
  assert.equal(isVacantUseCode('VXYZ9'), true, 'unknown V-code still reads vacant');
  assert.equal(isVacantUseCode('vcomm'), true, 'case-insensitive');
  assert.equal(isVacantUseCode('RESMC'), false);
  assert.equal(isVacantUseCode('CNRES'), false, 'other condo codes are not vacant');
  assert.equal(isVacantUseCode(''), false);
  assert.equal(isVacantUseCode(null), false);
});

test('groupVacancy — a group is vacant only when EVERY parcel is', () => {
  const v = groupVacancy([
    useCode('VCOMM', 'A'), useCode('VINDU', 'A'),   // all vacant
    useCode('VCOMM', 'B'), useCode('RESMC', 'B'),   // one improvement
    useCode('', 'C'),                                // nothing to read
  ]);
  assert.equal(v.get('A'), 'vacant');
  assert.equal(v.get('B'), 'improved');
  assert.equal(v.get('C'), 'unknown');
});

test('groupVacancy — an improved verdict is not undone by a later vacant parcel', () => {
  const v = groupVacancy([useCode('RESMC', 'A'), useCode('VCOMM', 'A')]);
  assert.equal(v.get('A'), 'improved');
});

test('groupVacancy — a blank code does not downgrade a known verdict', () => {
  assert.equal(groupVacancy([useCode('VCOMM', 'A'), useCode('', 'A')]).get('A'), 'vacant');
  assert.equal(groupVacancy([useCode('RESMC', 'A'), useCode('', 'A')]).get('A'), 'improved');
});

test('passesVacantFilter — unknown drops out of BOTH narrowed modes', () => {
  const v = groupVacancy([useCode('VCOMM', 'A'), useCode('RESMC', 'B'), useCode('', 'C')]);
  assert.equal(passesVacantFilter(useCode('VCOMM', 'A'), 'all', v), true, 'all is off');
  assert.equal(passesVacantFilter(useCode('VCOMM', 'A'), 'vacant', v), true);
  assert.equal(passesVacantFilter(useCode('VCOMM', 'A'), 'improved', v), false);
  assert.equal(passesVacantFilter(useCode('RESMC', 'B'), 'improved', v), true);
  assert.equal(passesVacantFilter(useCode('', 'C'), 'vacant', v), false);
  assert.equal(passesVacantFilter(useCode('', 'C'), 'improved', v), false);
});

// ---- Far-flung ------------------------------------------------------------
const at = (lon, lat, inst) => ({ properties: { _saleInstrument: inst, centroid_lon: lon, centroid_lat: lat } });
const centroidOf = (f) => {
  const lon = Number(f.properties.centroid_lon);
  const lat = Number(f.properties.centroid_lat);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
};
// Flat-earth stand-in: 1 unit of longitude == 1 km. Enough to test the
// group arithmetic without importing main.js's haversine.
const fakeKm = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

test('groupSpreadKm — a single-parcel sale spans 0, not null', () => {
  const spans = groupSpreadKm([at(0, 0, 'A')], centroidOf, fakeKm);
  assert.equal(spans.get('A'), 0);
});

test('groupSpreadKm — the widest internal gap wins', () => {
  const spans = groupSpreadKm(
    [at(0, 0, 'A'), at(3, 0, 'A'), at(10, 0, 'A')], centroidOf, fakeKm,
  );
  assert.equal(spans.get('A'), 10);
});

test('groupSpreadKm — a multi-parcel sale with under two centroids is unmeasurable', () => {
  const spans = groupSpreadKm(
    [at(0, 0, 'A'), { properties: { _saleInstrument: 'A' } }], centroidOf, fakeKm,
  );
  assert.equal(spans.get('A'), null, 'null means unknown, not zero');
});

test('isFarFlung — strictly beyond the threshold, and off when blank or 0', () => {
  assert.equal(isFarFlung(10, 5), true);
  assert.equal(isFarFlung(5, 5), false, 'exactly at the threshold is not far-flung');
  assert.equal(isFarFlung(10, null), false, 'blank threshold is off');
  assert.equal(isFarFlung(10, 0), false, '0 is off, not "everything"');
});

test('isFarFlung — an unmeasurable span is never far-flung (fails OPEN)', () => {
  // The one deliberate inversion of "missing is excluded": this filter
  // REMOVES comps, so an unchecked sale must not be thrown away.
  assert.equal(isFarFlung(null, 5), false);
  assert.equal(isFarFlung(NaN, 5), false);
  assert.equal(isFarFlung(undefined, 5), false);
});

// ---- isLandSetUseCode: the gate the build instruments use ------------------
// Every build pass used to gate on isVacantUseCode, so it policed the V-codes
// and nothing else. saleCategory files a sale under Land by CATEGORY, and one
// code reaches Land without being vacant-coded: CMPSP, surface parking. 17
// sales sat in the Land set that no instrument could ever judge.

test('isLandSetUseCode — every vacant code still counts', () => {
  for (const c of ['VRES1', 'VRES2', 'VCOMM', 'VINDU', 'VAGRI', 'CNVAC']) {
    assert.equal(isLandSetUseCode(c), true, c);
  }
});

test('isLandSetUseCode — CMPSP is the one code this adds', () => {
  // Measured: exactly 11 codes have category Land, and surface parking is the
  // only one of them that is not vacant-coded. This widens by that and nothing
  // else, which is why the change moved zero rows out of Land.
  assert.equal(isLandSetUseCode('CMPSP'), true);
  assert.equal(isVacantUseCode('CMPSP'), false, 'and it is still NOT vacant');
});

test('isLandSetUseCode — improved codes stay out', () => {
  for (const c of ['RESSD', 'CMOFF', 'INWWH', 'RESMC', 'CMRST']) {
    assert.equal(isLandSetUseCode(c), false, c);
  }
});

test('isLandSetUseCode — an UNKNOWN vacant code still counts', () => {
  // The reason this is a union and not just a category test. pucsCategory
  // returns null for a code it has never been taught, so gating on the
  // category alone would silently STOP judging any future V-code -- narrowing
  // the gate while appearing to widen it.
  assert.equal(isLandSetUseCode('VZZZZ'), true);
});

test('isLandSetUseCode — junk decides nothing', () => {
  for (const c of ['', null, undefined, '   ']) assert.equal(isLandSetUseCode(c), false, JSON.stringify(c));
});

test('isVacantUseCode is NOT replaced by it', () => {
  // isVacantUseCode still answers "the assessor marked this vacant" and still
  // owns the vacant FILTER and groupVacancy, where a surface parking lot is
  // emphatically not vacant. The two questions must stay different.
  assert.equal(isVacantUseCode('CMPSP'), false);
  assert.equal(isLandSetUseCode('CMPSP'), true);
});

// ---- resolveMixedSales: one deal, one verdict -----------------------------
// Jason's rule, 2026-08-22: if any parcel in a multi-parcel sale is not
// parking or vacant land, the WHOLE transaction is an improved sale. Left
// uncorrected the vacant parcel of a $6,650,000 VINDU+INWWH deal sat in Land
// reading $16.63 per lot square foot -- a number that prices the warehouse.

const row = (inst, cat) => ({ properties: { _saleInstrument: inst, _saleCategory: cat } });

test('resolveMixedSales — Land beside one improved parcel forces the group', () => {
  const { force, mixed } = resolveMixedSales([row('A', 'Land'), row('A', 'Industrial')]);
  assert.equal(force.get('A'), 'Industrial');
  assert.ok(mixed.has('A'));
});

test('resolveMixedSales — a TEARDOWN assembly is not mixed, and needs no exception', () => {
  // This is why it judges the FINAL category rather than the use code.
  // demoVerdict has already pulled the improved parcel to Land, so the group
  // spans one category and nothing fires. A warehouse sold with a vacant lot
  // for its land stays a land deal.
  const { force, mixed } = resolveMixedSales([row('B', 'Land'), row('B', 'Land')]);
  assert.equal(force.size, 0);
  assert.equal(mixed.size, 0);
});

test('resolveMixedSales — a wholly improved sale is left alone', () => {
  const { mixed } = resolveMixedSales([row('C', 'Industrial'), row('C', 'Office')]);
  assert.equal(mixed.size, 0, 'no Land member, so this rule has nothing to say');
});

test('resolveMixedSales — a single-parcel sale can never be mixed', () => {
  const { mixed } = resolveMixedSales([row('D', 'Land')]);
  assert.equal(mixed.size, 0);
});

test('resolveMixedSales — MORE than one improved category names none, but still marks it', () => {
  // It cannot say which improved type the deal was, so it declines to pick.
  // The sale is still mixed and the caller still withholds its land rates --
  // silence about the category is not permission to keep a blended rate.
  const { force, mixed } = resolveMixedSales([
    row('E', 'Land'), row('E', 'Industrial'), row('E', 'Office'),
  ]);
  assert.equal(force.has('E'), false);
  assert.ok(mixed.has('E'), 'still mixed');
});

test('resolveMixedSales — rows with no category yet are ignored, not treated as a category', () => {
  const { mixed } = resolveMixedSales([row('F', 'Land'), row('F', null), row('F', undefined)]);
  assert.equal(mixed.size, 0);
});

test('resolveMixedSales — groups are independent', () => {
  const { force, mixed } = resolveMixedSales([
    row('G', 'Land'), row('G', 'Residential'),
    row('H', 'Land'), row('H', 'Land'),
  ]);
  assert.equal(force.get('G'), 'Residential');
  assert.ok(mixed.has('G'));
  assert.ok(!mixed.has('H'));
});

test('resolveMixedSales — empty and junk input never throws', () => {
  for (const input of [[], null, undefined, [{}, { properties: null }]]) {
    const { force, mixed } = resolveMixedSales(input);
    assert.equal(force.size, 0);
    assert.equal(mixed.size, 0);
  }
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

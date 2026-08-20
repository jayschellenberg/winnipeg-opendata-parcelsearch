// Unit tests for src/lib/sales.js — the pure CSV dedup/group logic the
// Sales Analysis tab is built on (extracted from main.js, which can't be
// imported under Node). Plain-node runner; run with
//   cd web && npm test
// or
//   node test/sales.test.js

import assert from 'node:assert/strict';
import {
  normalizeRoll, dedupAndGroupSales, buildSaleFeatures, parseNumeric,
} from '../src/lib/sales.js';

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

console.log('sales');

// A realistic City-exporter row; override per test.
function row(overrides = {}) {
  return {
    'Parcel ID': '6070731000',
    'Instrument Number': 'INST-1',
    'Sale Dates': '2024-03-01',
    'Sold Price': '350000',
    'Land Actual sqft': '5000',
    'Land Assessed sqft': '5000',
    'Living Area': '1200',
    'Year Built': '2012',
    'Par Use Code': 'RESSD',
    'Property Type': 'Residential',
    'Property Sub Type': '',
    'Street Number': '123',
    'Street Direction': '',
    'Street Name': 'MAIN ST',
    'Number of Unit': '1',
    ...overrides,
  };
}

test('dedupAndGroupSales — one record per (roll, instrument); rolls are 11-digit padded', () => {
  const out = dedupAndGroupSales([row(), row()]);
  assert.equal(out.sales.length, 1);
  assert.deepEqual([...out.rolls], ['06070731000']);
  assert.equal(out.sales[0].salePrice, 350000);
  assert.equal(out.sales[0].saleDate, '2024-03-01');
});

test('dedupAndGroupSales — multi-building rows sum living area and keep the oldest year built', () => {
  const out = dedupAndGroupSales([
    row({ 'Living Area': '1200', 'Year Built': '2012' }),
    row({ 'Living Area': '800', 'Year Built': '2008' }),
    row({ 'Living Area': '500', 'Year Built': '2012' }),
  ]);
  assert.equal(out.sales.length, 1);
  assert.equal(out.sales[0].livingArea, 2500);
  assert.equal(out.sales[0].yearBuilt, '2008');
});

test('dedupAndGroupSales — use code falls back to the first non-empty value', () => {
  const out = dedupAndGroupSales([
    row({ 'Par Use Code': '' }),
    row({ 'Par Use Code': 'COMME' }),
  ]);
  assert.equal(out.sales[0].useCode, 'COMME');
});

test('dedupAndGroupSales — rows missing roll or instrument are skipped', () => {
  const out = dedupAndGroupSales([
    row({ 'Parcel ID': '' }),
    row({ 'Instrument Number': '' }),
  ]);
  assert.equal(out.sales.length, 0);
  assert.equal(out.rolls.size, 0);
  assert.equal(out.groups.size, 0);
});

test('dedupAndGroupSales — groups collect every parcel on one instrument (multi-parcel sale)', () => {
  const out = dedupAndGroupSales([
    row({ 'Parcel ID': '6070731000' }),
    row({ 'Parcel ID': '6070732000' }),
    row({ 'Parcel ID': '9999999999', 'Instrument Number': 'INST-2' }),
  ]);
  assert.equal(out.sales.length, 3);
  assert.equal(out.groups.get('INST-1').length, 2);
  assert.equal(out.groups.get('INST-2').length, 1);
});

test('normalizeRoll — pads / strips formatting / null on no digits', () => {
  assert.equal(normalizeRoll('6070731000'), '06070731000');
  assert.equal(normalizeRoll('01-000-001-000'), '01000001000');
  assert.equal(normalizeRoll('13052686500'), '13052686500');
  assert.equal(normalizeRoll(null), null);
  assert.equal(normalizeRoll('n/a'), null);
});

// ---------- buildSaleFeatures ----------
// Audit F2: the old roll-keyed stamping rendered one row per PARCEL, so a
// parcel that sold twice in the study period silently lost one of its two
// transactions (a 3-sale CSV showed "2 sales shown"). These pin the
// one-feature-per-SALE contract.

function liveFeature(roll, extra = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
    properties: { roll_number: roll, full_address: `${roll} TEST ST`, ...extra },
  };
}

function liveMap(...features) {
  return new Map(features.map((f) => [String(f.properties.roll_number), f]));
}

test('buildSaleFeatures — a resale renders BOTH transactions, not just the last CSV row', () => {
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Instrument Number': 'INST-2019', 'Sale Dates': '2019-05-01', 'Sold Price': '400000' }),
    row({ 'Instrument Number': 'INST-2023', 'Sale Dates': '2023-08-15', 'Sold Price': '550000' }),
  ]);
  const live = liveFeature('06070731000', { total_assessed_value: '500000' });
  const features = buildSaleFeatures(sales, liveMap(live), groups);
  assert.equal(features.length, 2);
  assert.deepEqual(
    features.map((f) => [f.properties._saleInstrument, f.properties._salePrice]).sort(),
    [['INST-2019', 400000], ['INST-2023', 550000]]
  );
  // Both share the live parcel's geometry + attributes.
  assert.equal(features[0].geometry, live.geometry);
  assert.equal(features[1].properties.full_address, '06070731000 TEST ST');
  // Clones, not mutations: the live feature never gets sale fields.
  assert.equal(live.properties._saleInstrument, undefined);
});

test('buildSaleFeatures — sale with no live match becomes a synthetic _noLiveMatch row', () => {
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Parcel ID': '9999999999', 'Street Number': '55', 'Street Name': 'NOWHERE RD' }),
  ]);
  const [f] = buildSaleFeatures(sales, liveMap(), groups);
  assert.equal(f.geometry, null);
  assert.equal(f.properties._noLiveMatch, true);
  assert.equal(f.properties.roll_number, '09999999999');
  assert.equal(f.properties.full_address, '55 NOWHERE RD');
  assert.equal(f.properties._saleDate, '2024-03-01');
});

test('buildSaleFeatures — multi-parcel sale divides by group land + group assessment sums', () => {
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Parcel ID': '6070731000', 'Sold Price': '1000000', 'Land Actual sqft': '4000' }),
    row({ 'Parcel ID': '6070732000', 'Sold Price': '1000000', 'Land Actual sqft': '6000' }),
  ]);
  const lm = liveMap(
    liveFeature('06070731000', { total_assessed_value: '300000' }),
    liveFeature('06070732000', { total_assessed_value: '500000' }),
  );
  const features = buildSaleFeatures(sales, lm, groups);
  assert.equal(features.length, 2);
  for (const f of features) {
    assert.equal(f.properties._saleGroupSize, 2);
    assert.equal(f.properties._pricePerSf, 1000000 / 10000);          // group land
    assert.equal(f.properties._saleToAsmt, (1000000 / 800000) * 100); // group asmt
  }
});

test('buildSaleFeatures — single-parcel sale uses its own land + assessment', () => {
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Sold Price': '350000', 'Land Actual sqft': '5000' }),
  ]);
  const lm = liveMap(liveFeature('06070731000', { total_assessed_value: '340000' }));
  const [f] = buildSaleFeatures(sales, lm, groups);
  assert.equal(f.properties._pricePerSf, 350000 / 5000);
  assert.equal(f.properties._saleToAsmt, (350000 / 340000) * 100);
  assert.equal(f.properties._saleGroupSize, 1);
});

// ---- parseNumeric ---------------------------------------------------------
// The formatting bug this closes was silent and expensive, so the cases
// are pinned individually rather than in one loop.

test('parseNumeric — plain numbers and whitespace', () => {
  assert.equal(parseNumeric('1234567'), 1234567);
  assert.equal(parseNumeric(' 1234567 '), 1234567);
  assert.equal(parseNumeric('1234.56'), 1234.56);
  assert.equal(parseNumeric(1234567), 1234567);
});

test('parseNumeric — thousands separators (the dangerous case)', () => {
  // A bare parseFloat returns 1 here: it stops at the first comma. A
  // $1.29M sale then looked exactly like SABRE's nominal $1
  // non-arms-length sentinel, and the "Hide $0 / $1" filter removed the
  // whole transaction from the comp set without a word.
  assert.equal(parseNumeric('1,234,567'), 1234567);
  assert.equal(parseNumeric('1,234,567.00'), 1234567);
  assert.equal(parseNumeric('1,290,000'), 1290000);
});

test('parseNumeric — currency symbols', () => {
  // These returned NaN -> 0, which is what left Sworn Value blank on
  // rows that plainly had a value.
  assert.equal(parseNumeric('$1,234,567'), 1234567);
  assert.equal(parseNumeric('$1234567'), 1234567);
  assert.equal(parseNumeric('1,234,567 CAD'), 1234567);
});

test('parseNumeric — accounting negatives', () => {
  assert.equal(parseNumeric('(1,234)'), -1234);
  assert.equal(parseNumeric('-1234'), -1234);
});

test('parseNumeric — non-numbers are null, NOT zero', () => {
  // Keeping "absent" distinct from "zero" is what lets each caller
  // decide; collapsing them is how a missing land area became 0 sf.
  for (const v of [null, undefined, '', '   ', 'N/A', 'SEE DOCUMENT', '$', '-', '.']) {
    assert.equal(parseNumeric(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test('dedupAndGroupSales — a comma-formatted price survives the import', () => {
  // End-to-end guard on the same bug, through the real entry point.
  const { sales } = dedupAndGroupSales([
    row({ 'Sold Price': '1,290,000', 'Sworn Value': '$1,290,000', 'Land Actual sqft': '5,757' }),
  ]);
  assert.equal(sales[0].salePrice, 1290000);
  assert.equal(sales[0].swornValue, 1290000);
  assert.equal(sales[0].landSf, 5757);
});

test('buildSaleFeatures — sworn value is shown even when it equals the price', () => {
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Sold Price': '350000', 'Sworn Value': '350000' }),
  ]);
  const [f] = buildSaleFeatures(sales, new Map(), groups);
  assert.equal(f.properties._saleSwornValue, 350000);
  // …and is still never substituted into the price.
  assert.equal(f.properties._salePrice, 350000);
});

test('buildSaleFeatures — a nominal $1 keeps its price and surfaces the sworn value', () => {
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Sold Price': '1', 'Sworn Value': '4,080,000' }),
  ]);
  const [f] = buildSaleFeatures(sales, new Map(), groups);
  // The $1 is stamped as-is — it's the "Hide $0 / $1" filter, not the
  // stamping, that keeps a nominal transfer out of the comp set.
  assert.equal(f.properties._salePrice, 1);
  assert.equal(f.properties._saleSwornValue, 4080000, 'the real figure rides alongside it');
});

test('buildSaleFeatures — _saleSwornMismatch flags only a genuine disagreement', () => {
  const mism = (price, sworn) => {
    const { sales, groups } = dedupAndGroupSales([
      row({ 'Sold Price': price, 'Sworn Value': sworn }),
    ]);
    return buildSaleFeatures(sales, new Map(), groups)[0].properties._saleSwornMismatch;
  };
  assert.equal(mism('1', '4080000'), true, 'nominal price vs real sworn value');
  assert.equal(mism('350000', '350000'), false, 'ordinary sale: the two agree');
  // One side missing is not a disagreement — it's an incomplete export,
  // and flagging it would cry wolf on every row of a CSV with no sworn
  // column at all.
  assert.equal(mism('350000', ''), false, 'no sworn value');
  assert.equal(mism('', '350000'), false, 'no sale price');
});

test('buildSaleFeatures — _saleGroupRollIds lists every sibling roll, on every member', () => {
  // Drives the map's group-hover: hovering any parcel must be able to
  // find all of its siblings, so the list is stamped on each of them.
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Parcel ID': '06070731000', 'Instrument Number': 'I1' }),
    row({ 'Parcel ID': '06070732000', 'Instrument Number': 'I1' }),
  ]);
  const feats = buildSaleFeatures(sales, new Map(), groups);
  assert.equal(feats.length, 2);
  for (const f of feats) {
    // JSON, because MapLibre stringifies non-primitive properties on the
    // way back out of queryRenderedFeatures.
    const rolls = JSON.parse(f.properties._saleGroupRollIds);
    assert.deepEqual(rolls.sort(), ['06070731000', '06070732000']);
  }
});

test('buildSaleFeatures — a single-parcel sale lists just itself', () => {
  const { sales, groups } = dedupAndGroupSales([row({})]);
  const [f] = buildSaleFeatures(sales, new Map(), groups);
  assert.deepEqual(JSON.parse(f.properties._saleGroupRollIds), ['06070731000']);
});

test('dedupAndGroupSales — N1 ID: first non-blank wins across component rows', () => {
  const out = dedupAndGroupSales([
    row({ 'N1 ID': '' }),
    row({ 'N1 ID': '4471' }),
    row({ 'N1 ID': '9999' }),   // a later stamped copy must not overwrite
  ]);
  assert.equal(out.sales.length, 1);
  assert.equal(out.sales[0].n1Id, '4471');
});

test('dedupAndGroupSales — no N1 column at all leaves n1Id null', () => {
  const out = dedupAndGroupSales([row()]);
  assert.equal(out.sales[0].n1Id, null);
});

test('buildSaleFeatures — _n1Id stamped from the record; null when absent', () => {
  const { sales, groups } = dedupAndGroupSales([row({ 'N1 ID': ' 4471 ' })]);
  const [f] = buildSaleFeatures(sales, liveMap(), groups);
  assert.equal(f.properties._n1Id, '4471');
  const bare = dedupAndGroupSales([row()]);
  const [g] = buildSaleFeatures(bare.sales, liveMap(), bare.groups);
  assert.equal(g.properties._n1Id, null);
});

test('buildSaleFeatures — land metrics: acres, $/acre, $/lot', () => {
  // 43,560 sf is exactly one acre, which makes the arithmetic checkable
  // by eye rather than by repeating the formula in the assertion.
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Land Actual sqft': '43560', 'Sold Price': '1200000' }),
  ]);
  const [f] = buildSaleFeatures(sales, liveMap(), groups);
  assert.equal(f.properties._saleAcres, 1);
  assert.equal(f.properties._pricePerAcre, 1200000);
  assert.equal(f.properties._pricePerLot, 1200000, 'a single-parcel sale prices one lot');
});

test('buildSaleFeatures — a multi-parcel sale divides by the GROUP total', () => {
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Parcel ID': '1111111111', 'Instrument Number': 'M1', 'Sold Price': '900000', 'Land Actual sqft': '21780' }),
    row({ 'Parcel ID': '2222222222', 'Instrument Number': 'M1', 'Sold Price': '900000', 'Land Actual sqft': '21780' }),
  ]);
  const [f] = buildSaleFeatures(sales, liveMap(), groups);
  assert.equal(f.properties._saleAcres, 1, 'two half-acre parcels are one acre of deal');
  assert.equal(f.properties._pricePerAcre, 900000);
  assert.equal(f.properties._pricePerLot, 450000, 'the consideration splits across the two lots');
});

test('buildSaleFeatures — $/Bldg SF uses the CSV living area, group-summed', () => {
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Sold Price': '500000', 'Living Area': '2000' }),
  ]);
  const [f] = buildSaleFeatures(sales, liveMap(), groups);
  assert.equal(f.properties._pricePerBldgSf, 250);
});

test('buildSaleFeatures — $/Bldg SF falls back to the live record', () => {
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Sold Price': '500000', 'Living Area': '' }),
  ]);
  const live = liveFeature('06070731000', { total_living_area: '2500' });
  const [f] = buildSaleFeatures(sales, liveMap(live), groups);
  assert.equal(f.properties._pricePerBldgSf, 200);
});

test('buildSaleFeatures — vacant land gets no building rate, not a zero', () => {
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Sold Price': '120000', 'Living Area': '0', 'Par Use Code': 'VRES1' }),
  ]);
  const [f] = buildSaleFeatures(sales, liveMap(), groups);
  assert.equal(f.properties._pricePerBldgSf, undefined);
});

test('buildSaleFeatures — a vacant sale never inherits the live building area', () => {
  // The lot sold bare and has since been built on. The live record
  // describes it TODAY, so falling back to it would invent a confident
  // $/Bldg SF for a transaction that had no building in it.
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Sold Price': '120000', 'Living Area': '', 'Par Use Code': 'VCOMM' }),
  ]);
  const live = liveFeature('06070731000', { total_living_area: '3000' });
  const [f] = buildSaleFeatures(sales, liveMap(live), groups);
  assert.equal(f.properties._pricePerBldgSf, undefined);
  // ...while the same sale under an improved code does take the fallback.
  const improved = dedupAndGroupSales([
    row({ 'Sold Price': '120000', 'Living Area': '', 'Par Use Code': 'RESMC' }),
  ]);
  const [g] = buildSaleFeatures(improved.sales, liveMap(live), improved.groups);
  assert.equal(g.properties._pricePerBldgSf, 40);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

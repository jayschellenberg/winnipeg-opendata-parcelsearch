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

test('dedupAndGroupSales — multi-building rows sum living area and list every section year', () => {
  const out = dedupAndGroupSales([
    row({ 'Living Area': '1200', 'Year Built': '2012' }),
    row({ 'Living Area': '800', 'Year Built': '2008' }),
    row({ 'Living Area': '500', 'Year Built': '2012' }),
  ]);
  assert.equal(out.sales.length, 1);
  assert.equal(out.sales[0].livingArea, 2500);
  // The HIGGINS rows. They used to report just 2008 — the oldest — which
  // threw away the fact that two of the three sections went up in 2012.
  // Distinct, so the repeated 2012 appears once.
  assert.equal(out.sales[0].yearBuilt, '2008, 2012');
  assert.equal(out.sales[0].yearBuiltNumeric, 2008, 'the oldest, as a number, for sorting');
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

// ---------- SABRE's blank-Zoning twin rows ----------
// SABRE exports a component row TWICE inside one (Parcel ID, Instrument
// Number): once zoned, once with the Zoning cell blank and every other
// cell identical. The merge read that as two buildings and summed the
// area. 1,022 such rows across 785 sales in the 52-file archive; 609 of
// those sales reported EXACTLY 2.00x their real living area (16,681,358
// sf against a true 8,340,679), which halves $/Bldg SF on every one.

test('dedupAndGroupSales — a blank-Zoning twin collapses instead of doubling living area', () => {
  // 927 DORCHESTER, roll 12030200000 instrument 5145676: a 2,758 sf
  // house that reported 5,516.
  const twin = { 'Parcel ID': '12030200000', 'Instrument Number': '5145676', 'Living Area': '2758' };
  const out = dedupAndGroupSales([
    row({ ...twin, 'Zoning': 'R2' }),
    row({ ...twin, 'Zoning': '' }),
  ]);
  assert.equal(out.sales.length, 1);
  assert.equal(out.sales[0].livingArea, 2758, 'the twin is one row, not a second building');
});

test('dedupAndGroupSales — the zoned twin survives the collapse, in either export order', () => {
  // Prefer the row that carries a zoning: dropping the wrong copy would
  // trade the doubled area for a silently emptied Zoning column.
  const zonedLast = dedupAndGroupSales([row({ 'Zoning': '' }), row({ 'Zoning': 'M2' })]);
  assert.equal(zonedLast.sales[0].zoning, 'M2');
  assert.equal(zonedLast.sales[0].livingArea, 1200);
  const zonedFirst = dedupAndGroupSales([row({ 'Zoning': 'M2' }), row({ 'Zoning': '' })]);
  assert.equal(zonedFirst.sales[0].zoning, 'M2');
  assert.equal(zonedFirst.sales[0].livingArea, 1200);
});

test('dedupAndGroupSales — two zonings on identical rows are not joined into one', () => {
  // Rolls 08005959000 and 08081223180 each export two otherwise
  // identical rows carrying different zonings, which reads like a
  // split-zoned parcel. The City's record says it is not one: roll
  // 08081223180 (694 ST ANNE'S) carries a single zoning, "RMU - RES -
  // MIX USE", and RR5 appears nowhere in it. So the second cell is a
  // stale duplicate, and joining the two would put a district in front
  // of an appraiser that the assessment roll does not carry. Keep the
  // zoning of the row we kept; never manufacture "RMU / RR5".
  const parcel = { 'Parcel ID': '08005959000', 'Living Area': '1400' };
  const out = dedupAndGroupSales([
    row({ ...parcel, 'Zoning': 'RR5' }),
    row({ ...parcel, 'Zoning': 'RMFL' }),
  ]);
  assert.equal(out.sales.length, 1);
  assert.equal(out.sales[0].zoning, 'RR5', 'the surviving row keeps its own zoning');
  assert.ok(!String(out.sales[0].zoning).includes('/'), 'no invented composite district');
  assert.equal(out.sales[0].livingArea, 1400, 'one parcel is not two buildings');
});

test('dedupAndGroupSales — a repeated living area counts ONCE, differing sections still add', () => {
  // SABRE repeats the whole building's area per row far more often than
  // it splits it. 397 HORACE writes 1,950 sf three times, once per
  // suite, and the City says the building is 1,950 sf — so a repeat
  // counts once. Genuinely different areas are real sections and still
  // add up. Measured: summing every row matched the City on 0 of 168
  // checkable sales; summing the DISTINCT areas matched 156.
  const repeated = dedupAndGroupSales([
    row({ 'Number of Unit': '1', 'Living Area': '1950' }),
    row({ 'Number of Unit': '2', 'Living Area': '1950' }),
    row({ 'Number of Unit': '3', 'Living Area': '1950' }),
  ]);
  assert.equal(repeated.sales[0].livingArea, 1950, 'one building written three times is one building');

  const sections = dedupAndGroupSales([
    row({ 'Living Area': '1764', 'Zoning': 'M2' }),
    row({ 'Living Area': '378', 'Zoning': 'M2' }),
    row({ 'Living Area': '1554', 'Zoning': 'M2' }),
  ]);
  assert.equal(sections.sales[0].livingArea, 3696, 'three different sections still add up');
});

test('dedupAndGroupSales — a genuine second section still merges and still sums', () => {
  // The collapse is field-by-field rather than "drop the blank-Zoning
  // rows" precisely so this row survives: it has no zoning either, but
  // it differs on Living Area, so it is a real second building section.
  const out = dedupAndGroupSales([
    row({ 'Living Area': '2758', 'Zoning': 'R2' }),
    row({ 'Living Area': '2758', 'Zoning': '' }),   // the twin
    row({ 'Living Area': '640', 'Zoning': '' }),    // a real garage/addition
  ]);
  assert.equal(out.sales.length, 1);
  assert.equal(out.sales[0].livingArea, 3398, '2,758 counted once, plus the 640 section');
  assert.equal(out.sales[0].zoning, 'R2');
});

// ---------- Year Built across the sections ----------

test('dedupAndGroupSales — Year Built lists every distinct section year, ascending', () => {
  // Roll 13081715000 instrument 5141959: five sections, and the merge
  // used to keep 1911 alone and throw 1913 / 1954 / 1958 / 1962 away.
  const out = dedupAndGroupSales([
    row({ 'Year Built': '1954', 'Living Area': '900' }),
    row({ 'Year Built': '1958', 'Living Area': '800' }),
    row({ 'Year Built': '1962', 'Living Area': '700' }),
    row({ 'Year Built': '1911', 'Living Area': '600' }),
    row({ 'Year Built': '1913', 'Living Area': '500' }),
  ]);
  assert.equal(out.sales[0].yearBuilt, '1911, 1913, 1954, 1958, 1962');
  assert.equal(out.sales[0].yearBuiltNumeric, 1911);
});

test('dedupAndGroupSales — a blank Year Built among the sections adds no empty entry', () => {
  // 538 rows across 224 sales sit in a multi-row group with a blank Year
  // Built, so a naive join would print a leading comma on one sale in six.
  const out = dedupAndGroupSales([
    row({ 'Year Built': '', 'Living Area': '900' }),
    row({ 'Year Built': '1954', 'Living Area': '800' }),
    row({ 'Year Built': 'N/A', 'Living Area': '700' }),
  ]);
  assert.equal(out.sales[0].yearBuilt, '1954');
  assert.equal(out.sales[0].yearBuiltNumeric, 1954);
  assert.ok(!Number.isNaN(out.sales[0].yearBuiltNumeric), 'never NaN');
});

test('dedupAndGroupSales — no usable year anywhere leaves both fields null', () => {
  const out = dedupAndGroupSales([
    row({ 'Year Built': '', 'Living Area': '900' }),
    row({ 'Year Built': '   ', 'Living Area': '800' }),
  ]);
  assert.equal(out.sales[0].yearBuilt, null, 'absent, not a zero-length year');
  assert.equal(out.sales[0].yearBuiltNumeric, null);
});

test('dedupAndGroupSales — a single-section sale still reads plainly', () => {
  const out = dedupAndGroupSales([row({ 'Year Built': '1912' })]);
  assert.equal(out.sales[0].yearBuilt, '1912');
  assert.equal(out.sales[0].yearBuiltNumeric, 1912);
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

test('buildSaleFeatures — _saleYearBuiltNumeric rides alongside the display string', () => {
  // The grid sorts on the numeric field: by text, "1911, 1958" lands
  // nowhere near 1911, so a year sort on the string is meaningless.
  const { sales, groups } = dedupAndGroupSales([
    row({ 'Year Built': '1958', 'Living Area': '900' }),
    row({ 'Year Built': '1911', 'Living Area': '600' }),
  ]);
  const [f] = buildSaleFeatures(sales, liveMap(), groups);
  assert.equal(f.properties._saleYearBuilt, '1911, 1958');
  assert.equal(f.properties._saleYearBuiltNumeric, 1911);
  assert.equal(typeof f.properties._saleYearBuiltNumeric, 'number');
  // Null rather than NaN when the export carries no usable year, so the
  // cell renders blank instead of "NaN".
  const bare = dedupAndGroupSales([row({ 'Year Built': '' })]);
  const [g] = buildSaleFeatures(bare.sales, liveMap(), bare.groups);
  assert.equal(g.properties._saleYearBuilt, null);
  assert.equal(g.properties._saleYearBuiltNumeric, null);
});

test('buildSaleFeatures — the twin collapse un-halves $/Bldg SF', () => {
  // The rate the doubling actually broke, end to end: 927 DORCHESTER
  // sold for $500,000 with 2,758 sf of house, so $181/sf — not the $91
  // the summed twin reported.
  const twin = { 'Sold Price': '500000', 'Living Area': '2758' };
  const { sales, groups } = dedupAndGroupSales([
    row({ ...twin, 'Zoning': 'R2' }),
    row({ ...twin, 'Zoning': '' }),
  ]);
  const [f] = buildSaleFeatures(sales, liveMap(), groups);
  assert.equal(f.properties._pricePerBldgSf, 500000 / 2758);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

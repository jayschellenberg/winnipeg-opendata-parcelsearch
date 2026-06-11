// Unit tests for src/lib/sales.js — the pure CSV dedup/group logic the
// Sales Analysis tab is built on (extracted from main.js, which can't be
// imported under Node). Plain-node runner; run with
//   cd web && npm test
// or
//   node test/sales.test.js

import assert from 'node:assert/strict';
import { normalizeRoll, dedupAndGroupSales } from '../src/lib/sales.js';

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

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

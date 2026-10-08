// lib/assessmentRates.js — the $/DU column. SHARED: byte-identical in the
// Winnipeg app, test too.
//
// Run: cd web && node test/assessmentRates.test.js

import assert from 'node:assert/strict';
import { assessmentPerDu } from '../src/lib/assessmentRates.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('assessment $/DU');

test('divides the assessment by the dwelling units, whole dollars', () => {
  assert.equal(assessmentPerDu(1200000, 8), 150000);
  assert.equal(assessmentPerDu(1000000, 3), 333333);
  assert.equal(assessmentPerDu(350000, 1), 350000);
});

test('reads the source formats: "$1,234,500" and "4"', () => {
  assert.equal(assessmentPerDu('$1,200,000', '4'), 300000);
  assert.equal(assessmentPerDu('1200000', 4), 300000);
});

test('no dwelling units means no rate, not a divide-by-zero', () => {
  assert.equal(assessmentPerDu(500000, 0), null);
  assert.equal(assessmentPerDu(500000, null), null);
  assert.equal(assessmentPerDu(500000, ''), null);
});

test('no or unreadable assessment means no rate', () => {
  assert.equal(assessmentPerDu(null, 4), null);
  assert.equal(assessmentPerDu('', 4), null);
  assert.equal(assessmentPerDu('n/a', 4), null);
  assert.equal(assessmentPerDu(-5, 4), null);
  assert.equal(assessmentPerDu(NaN, 4), null);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

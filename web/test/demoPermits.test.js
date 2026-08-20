// Unit tests for src/lib/demoPermits.js — matching demolition permits to
// sales, and the teardown verdict that is the point of the exercise.
// Plain-node runner; run with `npm test` or `node test/demoPermits.test.js`.

import assert from 'node:assert/strict';
import {
  DEMO_WINDOW_DAYS, demoAddressKey, buildDemoIndex, findDemoPermit,
  demoVerdict, describeDemoPermit,
} from '../src/lib/demoPermits.js';

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

console.log('demoPermits');

const permit = (o = {}) => ({
  issue_date: '2019-11-12T00:00:00.000',
  permit_number: '19-191201 HO',
  work_type: 'Demolish',
  sub_type: 'SFD',
  street_number: '514',
  street_name: 'Beverley',
  street_type: 'ST',
  ...o,
});

test('demoAddressKey folds case, spacing and street type', () => {
  assert.equal(demoAddressKey('514', 'Beverley'), demoAddressKey('514', 'BEVERLEY'));
  assert.equal(demoAddressKey(' 514 ', ' beverley '), '514 BEVERLEY');
  // Directionals and full street types fold, which is the drift between
  // the permit table and a SABRE export.
  assert.equal(demoAddressKey('100', 'PORTAGE AVENUE EAST'), demoAddressKey('100', 'PORTAGE AVE E'));
});

test('demoAddressKey — a missing half yields no key, never a partial match', () => {
  assert.equal(demoAddressKey('', 'BEVERLEY'), '');
  assert.equal(demoAddressKey('514', ''), '');
  assert.equal(demoAddressKey(null, null), '');
});

test('findDemoPermit — matches inside the window, either side', () => {
  const idx = buildDemoIndex([permit()]);
  const before = findDemoPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2020-01-31' }, idx);
  assert.equal(before.date, '2019-11-12');
  assert.equal(before.side, 'before');
  assert.ok(before.offsetDays < 0);
  const after = findDemoPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2019-06-01' }, idx);
  assert.equal(after.side, 'after');
  assert.ok(after.offsetDays > 0);
});

test('findDemoPermit — outside the window is no match', () => {
  const idx = buildDemoIndex([permit()]);
  // Three years after the permit is beyond ±2 years.
  assert.equal(findDemoPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2022-11-12' }, idx), null);
  assert.ok(DEMO_WINDOW_DAYS > 700 && DEMO_WINDOW_DAYS < 740, 'window is ~2 years');
});

test('findDemoPermit — picks the NEAREST permit when an address has several', () => {
  const idx = buildDemoIndex([
    permit({ issue_date: '2018-01-05T00:00:00.000', permit_number: 'OLD' }),
    permit({ issue_date: '2019-11-12T00:00:00.000', permit_number: 'NEAR' }),
  ]);
  const hit = findDemoPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2020-01-31' }, idx);
  assert.equal(hit.permitNumber, 'NEAR');
});

test('findDemoPermit — unknown address or unusable date is null, not a throw', () => {
  const idx = buildDemoIndex([permit()]);
  assert.equal(findDemoPermit({ streetNumber: '999', streetName: 'NOWHERE', saleDate: '2020-01-31' }, idx), null);
  assert.equal(findDemoPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: 'pending' }, idx), null);
  assert.equal(findDemoPermit({ streetNumber: '514', streetName: 'BEVERLEY' }, new Map()), null);
  assert.equal(findDemoPermit(null, idx), null);
});

test('demoVerdict — the finding is a permit on an IMPROVED-coded sale', () => {
  const hit = { date: '2019-11-12', offsetDays: -80, side: 'before' };
  assert.equal(demoVerdict(hit, false), 'teardown', 'improved code + permit = teardown in disguise');
  assert.equal(demoVerdict(hit, true), 'confirms-vacant', 'already vacant = only corroboration');
  assert.equal(demoVerdict(null, false), null);
});

test('describeDemoPermit — spells out the consequence for a teardown', () => {
  const idx = buildDemoIndex([permit()]);
  const hit = findDemoPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2020-01-31' }, idx);
  const text = describeDemoPermit(hit, 'teardown');
  assert.match(text, /19-191201 HO/);
  assert.match(text, /3 months before the sale/);
  assert.match(text, /LAND sale/, 'the reader is told what to do with the row');
  assert.match(describeDemoPermit(hit, 'confirms-vacant'), /only confirms/);
  assert.equal(describeDemoPermit(null), '');
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

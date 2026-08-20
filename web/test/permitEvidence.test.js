// Unit tests for src/lib/permitEvidence.js — matching demolition permits to
// sales, and the teardown verdict that is the point of the exercise.
// Plain-node runner; run with `npm test` or `node test/permitEvidence.test.js`.

import assert from 'node:assert/strict';
import {
  DEMO_WINDOW_DAYS, permitAddressKey, buildPermitIndex, findNearestPermit,
  demoVerdict, describeDemoPermit,
  BUILT_BEFORE_DAYS, buildVerdict, describeBuildPermit,
} from '../src/lib/permitEvidence.js';

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

console.log('permitEvidence');

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

test('permitAddressKey folds case, spacing and street type', () => {
  assert.equal(permitAddressKey('514', 'Beverley'), permitAddressKey('514', 'BEVERLEY'));
  assert.equal(permitAddressKey(' 514 ', ' beverley '), '514 BEVERLEY');
  // Directionals and full street types fold, which is the drift between
  // the permit table and a SABRE export.
  assert.equal(permitAddressKey('100', 'PORTAGE AVENUE EAST'), permitAddressKey('100', 'PORTAGE AVE E'));
});

test('permitAddressKey — a missing half yields no key, never a partial match', () => {
  assert.equal(permitAddressKey('', 'BEVERLEY'), '');
  assert.equal(permitAddressKey('514', ''), '');
  assert.equal(permitAddressKey(null, null), '');
});

test('findNearestPermit — matches inside the window, either side', () => {
  const idx = buildPermitIndex([permit()]);
  const before = findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2020-01-31' }, idx);
  assert.equal(before.date, '2019-11-12');
  assert.equal(before.side, 'before');
  assert.ok(before.offsetDays < 0);
  const after = findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2019-06-01' }, idx);
  assert.equal(after.side, 'after');
  assert.ok(after.offsetDays > 0);
});

test('findNearestPermit — outside the window is no match', () => {
  const idx = buildPermitIndex([permit()]);
  // Three years after the permit is beyond ±2 years.
  assert.equal(findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2022-11-12' }, idx), null);
  assert.ok(DEMO_WINDOW_DAYS > 700 && DEMO_WINDOW_DAYS < 740, 'window is ~2 years');
});

test('findNearestPermit — picks the NEAREST permit when an address has several', () => {
  const idx = buildPermitIndex([
    permit({ issue_date: '2018-01-05T00:00:00.000', permit_number: 'OLD' }),
    permit({ issue_date: '2019-11-12T00:00:00.000', permit_number: 'NEAR' }),
  ]);
  const hit = findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2020-01-31' }, idx);
  assert.equal(hit.permitNumber, 'NEAR');
});

test('findNearestPermit — unknown address or unusable date is null, not a throw', () => {
  const idx = buildPermitIndex([permit()]);
  assert.equal(findNearestPermit({ streetNumber: '999', streetName: 'NOWHERE', saleDate: '2020-01-31' }, idx), null);
  assert.equal(findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: 'pending' }, idx), null);
  assert.equal(findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY' }, new Map()), null);
  assert.equal(findNearestPermit(null, idx), null);
});

test('demoVerdict — the finding is a permit on an IMPROVED-coded sale', () => {
  const hit = { date: '2019-11-12', offsetDays: -80, side: 'before' };
  assert.equal(demoVerdict(hit, false), 'teardown', 'improved code + permit = teardown in disguise');
  assert.equal(demoVerdict(hit, true), 'confirms-vacant', 'already vacant = only corroboration');
  assert.equal(demoVerdict(null, false), null);
});

test('describeDemoPermit — spells out the consequence for a teardown', () => {
  const idx = buildPermitIndex([permit()]);
  const hit = findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2020-01-31' }, idx);
  const text = describeDemoPermit(hit, 'teardown');
  assert.match(text, /19-191201 HO/);
  assert.match(text, /3 months before the sale/);
  assert.match(text, /LAND sale/, 'the reader is told what to do with the row');
  assert.match(describeDemoPermit(hit, 'confirms-vacant'), /only confirms/);
  assert.equal(describeDemoPermit(null), '');
});

// ---- new construction: was the house already there? ----------------------
const buildPermit = (o = {}) => ({
  issue_date: '2019-01-16T00:00:00.000',
  permit_number: '19-000001 HO',
  work_type: 'Construct New',
  permit_type: 'Housing',
  sub_type: 'SFD',
  street_number: '345',
  street_name: 'Amherst',
  ...o,
});

test('buildVerdict — a permit 6+ months before a vacant sale means it was ALREADY BUILT', () => {
  const idx = buildPermitIndex([buildPermit()]);
  // 345 AMHERST: permit Jan 2019, sold Feb 2020 for $329k as VRES1.
  const hit = findNearestPermit({ streetNumber: '345', streetName: 'AMHERST', saleDate: '2020-02-19' }, idx, 3 * 365);
  assert.equal(hit.side, 'before');
  assert.equal(buildVerdict(hit, true), 'already-built');
  assert.match(describeBuildPermit(hit, 'already-built'), /IMPROVED sale/);
});

test('buildVerdict — a permit at or after the sale confirms bare land', () => {
  const idx = buildPermitIndex([buildPermit({ issue_date: '2020-06-22T00:00:00.000' })]);
  const hit = findNearestPermit({ streetNumber: '345', streetName: 'AMHERST', saleDate: '2020-02-27' }, idx, 3 * 365);
  assert.equal(buildVerdict(hit, true), 'land-then-built');
  assert.match(describeBuildPermit(hit, 'land-then-built'), /genuine land comp/);
});

test('buildVerdict — the six-month line, measured not guessed', () => {
  const idx = buildPermitIndex([buildPermit({ issue_date: '2020-01-01T00:00:00.000' })]);
  // Just inside six months before -> still land (house not finished).
  const near = findNearestPermit({ streetNumber: '345', streetName: 'AMHERST', saleDate: '2020-05-01' }, idx, 3 * 365);
  assert.equal(buildVerdict(near, true), 'land-then-built');
  // Comfortably past it -> already built.
  const far = findNearestPermit({ streetNumber: '345', streetName: 'AMHERST', saleDate: '2020-10-01' }, idx, 3 * 365);
  assert.equal(buildVerdict(far, true), 'already-built');
  assert.ok(BUILT_BEFORE_DAYS > 175 && BUILT_BEFORE_DAYS < 190, 'threshold is ~6 months');
});

test('buildVerdict — improved-coded sales are not judged; every house has a permit', () => {
  const idx = buildPermitIndex([buildPermit()]);
  const hit = findNearestPermit({ streetNumber: '345', streetName: 'AMHERST', saleDate: '2020-02-19' }, idx, 3 * 365);
  assert.equal(buildVerdict(hit, false), null);
  assert.equal(buildVerdict(null, true), null);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

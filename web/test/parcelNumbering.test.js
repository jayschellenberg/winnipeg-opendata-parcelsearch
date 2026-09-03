// Enforcing tests for lib/parcelNumbering.js — the stable 1..N sequence
// behind the "Number parcels" toggle. Plain-node runner; run with
//   cd web && npm test
// or
//   node test/parcelNumbering.test.js
//
// What's locked here:
//   1. Roll # sorts NUMERICALLY (the whole reason the module exists —
//      a string sort puts roll 100 before roll 90).
//   2. A multi-parcel sale (one instrument, several rolls) is ONE number.
//   3. A repeat sale (one roll, several instruments) is ONE number.
//   4. Grouping is transitive across both keys, so a polygon can never
//      end up with two badges.
//   5. Assignment is idempotent and independent of input order — that's
//      what lets main.js re-assign on every render without the numbers
//      shifting under a re-sort or an area filter.
//   6. "Entry order" (rollOrder): entered rolls number in entered order,
//      keyed by the canonical 11-digit roll; un-entered rolls follow by
//      roll number; a group takes its first-entered member's number.

import assert from 'node:assert/strict';
import {
  rollNumericValue, rollKey, instrumentKey,
  canonicalRoll, enteredOrderValue,
  orderForNumbering, assignParcelSeq, clearParcelSeq,
} from '../src/lib/parcelNumbering.js';

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

console.log('parcelNumbering');

/** Minimal feature factory — numbering only ever reads `properties`. */
function f(roll, instrument) {
  const properties = { roll_number: roll };
  if (instrument !== undefined) properties._saleInstrument = instrument;
  return { type: 'Feature', properties, geometry: null };
}

const seqs = (features) => features.map((x) => x.properties._seq);
const rolls = (features) => features.map((x) => x.properties.roll_number);

// 1. Numeric roll ordering ==================================================
test('rollNumericValue parses a plain digit roll', () => {
  assert.equal(rollNumericValue({ roll_number: '01000001000' }), 1000001000);
});

test('rollNumericValue sends missing / non-numeric rolls last', () => {
  assert.equal(rollNumericValue({}), Infinity);
  assert.equal(rollNumericValue({ roll_number: '' }), Infinity);
  assert.equal(rollNumericValue({ roll_number: 'PENDING' }), Infinity);
});

test('rollKey / instrumentKey trim and null-out blanks', () => {
  assert.equal(rollKey({ roll_number: ' 12345 ' }), '12345');
  assert.equal(rollKey({ roll_number: '   ' }), null);
  assert.equal(rollKey({}), null);
  assert.equal(instrumentKey({ _saleInstrument: ' 4412345/1 ' }), '4412345/1');
  assert.equal(instrumentKey({ _saleInstrument: '' }), null);
  assert.equal(instrumentKey({}), null);
});

test('orderForNumbering sorts rolls as numbers, not strings', () => {
  // The trap: as strings, '100' < '90'. Numbering must not do that.
  const ordered = orderForNumbering([f('100'), f('90'), f('1000'), f('9')]);
  assert.deepEqual(rolls(ordered), ['9', '90', '100', '1000']);
});

test('orderForNumbering puts rollless features last, in input order', () => {
  const a = f(null);
  const b = f('');
  const ordered = orderForNumbering([a, f('500'), b, f('100')]);
  assert.deepEqual(rolls(ordered), ['100', '500', null, '']);
});

test('orderForNumbering drops features with no properties and does not mutate', () => {
  const input = [f('2'), null, { type: 'Feature' }, f('1')];
  const ordered = orderForNumbering(input);
  assert.equal(ordered.length, 2);
  assert.equal(input.length, 4, 'input array was mutated');
});

// 2. Plain 1..N =============================================================
test('assignParcelSeq numbers 1..N in roll order', () => {
  const list = [f('300'), f('100'), f('200')];
  const ordered = assignParcelSeq(list);
  assert.deepEqual(rolls(ordered), ['100', '200', '300']);
  assert.deepEqual(seqs(ordered), [1, 2, 3]);
});

// 2b. Entry order ===========================================================
/** rollOrder map the way main.js builds it: canonical roll → position. */
const order = (...rollsIn) => new Map(rollsIn.map((r, i) => [canonicalRoll(r), i]));

test('canonicalRoll zero-pads to 11 digits and strips punctuation', () => {
  assert.equal(canonicalRoll('3547800'), '00003547800');
  assert.equal(canonicalRoll('01003547800'), '01003547800');
  assert.equal(canonicalRoll(' 0100-3547-800 '), '01003547800');
  assert.equal(canonicalRoll(1003547800), '01003547800');
  assert.equal(canonicalRoll(''), null);
  assert.equal(canonicalRoll(null), null);
  assert.equal(canonicalRoll('PENDING'), null);
});

test('enteredOrderValue reads the position by canonical roll, Infinity otherwise', () => {
  const ro = order('1003547800', '01003546600');
  assert.equal(enteredOrderValue({ roll_number: '01003547800' }, ro), 0);
  assert.equal(enteredOrderValue({ roll_number: '1003546600' }, ro), 1);
  assert.equal(enteredOrderValue({ roll_number: '01003547000' }, ro), Infinity);
  assert.equal(enteredOrderValue({ roll_number: '01003547800' }, null), Infinity);
  assert.equal(enteredOrderValue({}, ro), Infinity);
});

test('orderForNumbering follows the entered order when a rollOrder is given', () => {
  // Pasted high-to-low; the numeric sort would reverse it.
  const ro = order('01003547800', '01003547600', '01003547400');
  const ordered = orderForNumbering(
    [f('01003547400'), f('01003547600'), f('01003547800')], ro,
  );
  assert.deepEqual(rolls(ordered), ['01003547800', '01003547600', '01003547400']);
});

test('orderForNumbering with no rollOrder is unchanged (roll order)', () => {
  const ordered = orderForNumbering([f('100'), f('90')], null);
  assert.deepEqual(rolls(ordered), ['90', '100']);
});

test('un-entered rolls follow the entered ones, by roll number', () => {
  const ro = order('300');
  const ordered = orderForNumbering([f('50'), f('300'), f('10')], ro);
  assert.deepEqual(rolls(ordered), ['300', '10', '50']);
});

test('assignParcelSeq numbers 1..N in entered order', () => {
  const ro = order('300', '100', '200');
  const list = [f('100'), f('200'), f('300')];
  const ordered = assignParcelSeq(list, { rollOrder: ro });
  assert.deepEqual(rolls(ordered), ['300', '100', '200']);
  assert.deepEqual(seqs(ordered), [1, 2, 3]);
});

test('a multi-parcel sale takes its FIRST-entered member\'s number under entry order', () => {
  // Pasted as 100, 200, 300, 400; 200 + 400 sold together under INST-A.
  const ro = order('100', '200', '300', '400');
  const a = f('100', 'INST-1');
  const b = f('200', 'INST-A');
  const c = f('300', 'INST-3');
  const d = f('400', 'INST-A');
  assignParcelSeq([d, c, b, a], { rollOrder: ro });
  assert.equal(a.properties._seq, 1);
  assert.equal(b.properties._seq, 2);
  assert.equal(c.properties._seq, 3, 'the count advances once for the group');
  assert.equal(d.properties._seq, 2, 'the later-entered partner keeps the group number');
});

test('entry order matches a 10-digit entry to its 11-digit live roll', () => {
  const ro = order('1003547800', '1003546600');
  const list = [f('01003546600'), f('01003547800')];
  const ordered = assignParcelSeq(list, { rollOrder: ro });
  assert.deepEqual(seqs(ordered), [1, 2]);
  assert.deepEqual(rolls(ordered), ['01003547800', '01003546600']);
});

test('entry-order assignment is idempotent and input-order independent', () => {
  const ro = order('300', '100', '200');
  const a = f('100');
  const b = f('200');
  const c = f('300');
  assignParcelSeq([a, b, c], { rollOrder: ro });
  const first = [a, b, c].map((x) => x.properties._seq);
  assignParcelSeq([c, a, b], { rollOrder: ro });
  assert.deepEqual([a, b, c].map((x) => x.properties._seq), first);
  assert.deepEqual(first, [2, 3, 1]);
});

test('switching rollOrder off re-derives roll order on the same features', () => {
  const ro = order('300', '100');
  const a = f('100');
  const b = f('300');
  assignParcelSeq([a, b], { rollOrder: ro });
  assert.deepEqual([a.properties._seq, b.properties._seq], [2, 1]);
  assignParcelSeq([a, b]);
  assert.deepEqual([a.properties._seq, b.properties._seq], [1, 2]);
});

// 3. Multi-parcel sale = one number =========================================
test('rolls sharing an instrument share one number, and the count advances once', () => {
  // 100 + 300 sold together under INST-A; 200 is its own sale.
  const a = f('100', 'INST-A');
  const b = f('300', 'INST-A');
  const c = f('200', 'INST-B');
  assignParcelSeq([a, b, c]);
  assert.equal(a.properties._seq, 1);
  assert.equal(c.properties._seq, 2, 'the standalone sale should be #2, not #3');
  assert.equal(b.properties._seq, 1, 'the assembly partner keeps the group number');
});

// 4. Repeat sale = one number ===============================================
test('a roll that sold twice gets one number, not two', () => {
  // One polygon on the map; two rows in the grid.
  const first  = f('100', 'INST-1');
  const second = f('100', 'INST-2');
  const other  = f('200', 'INST-3');
  assignParcelSeq([first, second, other]);
  assert.equal(first.properties._seq, 1);
  assert.equal(second.properties._seq, 1);
  assert.equal(other.properties._seq, 2);
});

// 5. Transitivity ===========================================================
test('grouping is transitive across roll and instrument', () => {
  // 100+200 sold together (INST-A); 200 later sold alone (INST-B).
  // All three rows describe two polygons that cannot be numbered apart
  // without one of them carrying two badges — so they are one group.
  const a = f('100', 'INST-A');
  const b = f('200', 'INST-A');
  const c = f('200', 'INST-B');
  const d = f('900', 'INST-C');
  assignParcelSeq([a, b, c, d]);
  assert.equal(a.properties._seq, 1);
  assert.equal(b.properties._seq, 1);
  assert.equal(c.properties._seq, 1);
  assert.equal(d.properties._seq, 2);
});

test('a blank instrument never groups rows together', () => {
  // Property-search mode has no instruments at all; every distinct roll
  // must still get its own number.
  const a = f('100', '');
  const b = f('200', '');
  const c = f('300');
  assignParcelSeq([a, b, c]);
  assert.deepEqual([a, b, c].map((x) => x.properties._seq), [1, 2, 3]);
});

test('numbers ascend by the group’s lowest roll', () => {
  // The group containing roll 100 must be #1 even though its OTHER
  // member (900) sorts last overall.
  const a = f('900', 'INST-A');
  const b = f('100', 'INST-A');
  const c = f('500', 'INST-B');
  assignParcelSeq([a, b, c]);
  assert.equal(b.properties._seq, 1);
  assert.equal(a.properties._seq, 1);
  assert.equal(c.properties._seq, 2);
});

// 6. Stability ==============================================================
test('assignment is independent of input order', () => {
  const build = () => [f('300', 'X'), f('100', 'Y'), f('200', 'Y')];
  const forward = build();
  const reversed = build().reverse();
  assignParcelSeq(forward);
  assignParcelSeq(reversed);
  const byRoll = (list) => Object.fromEntries(
    list.map((x) => [`${x.properties.roll_number}|${x.properties._saleInstrument}`, x.properties._seq])
  );
  assert.deepEqual(byRoll(forward), byRoll(reversed));
});

test('re-assigning the same set is a no-op (safe to call every render)', () => {
  const list = [f('300'), f('100'), f('200')];
  assignParcelSeq(list);
  const before = list.map((x) => x.properties._seq);
  assignParcelSeq(list);
  assert.deepEqual(list.map((x) => x.properties._seq), before);
});

// 7. Clearing ===============================================================
test('clearParcelSeq removes the stamp entirely', () => {
  const list = [f('100'), f('200')];
  assignParcelSeq(list);
  clearParcelSeq(list);
  for (const x of list) assert.ok(!('_seq' in x.properties), '_seq survived the clear');
});

test('clearParcelSeq tolerates nulls and featureless entries', () => {
  clearParcelSeq([null, undefined, {}, { properties: null }]);
  clearParcelSeq(null);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

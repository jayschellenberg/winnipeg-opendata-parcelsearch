// Full Address dedupe. The two sources spell the same street
// differently — the assessment record writes "DRIVE", the civic
// address dataset writes "DR" — so an exact-string dedupe let both
// through and the cell read the same address twice.
import assert from 'node:assert/strict';
import {
  normalizeAddressKey,
  addressBaseKey,
  dedupeAddresses,
} from '../src/lib/addressFormat.js';

// ---- normalizeAddressKey --------------------------------------------------
// The reported case.
assert.equal(
  normalizeAddressKey('407 LYNDALE DRIVE'),
  normalizeAddressKey('407 LYNDALE DR'),
);
// Every pair the two datasets actually publish, taken from grouping
// street_type on each: full spelling on the left, abbreviation on the
// right.
const PAIRS = [
  ['AVENUE', 'AVE'], ['STREET', 'ST'], ['DRIVE', 'DR'], ['ROAD', 'RD'],
  ['CRESCENT', 'CRES'], ['BOULEVARD', 'BLVD'], ['PLACE', 'PL'],
  ['HIGHWAY', 'HWY'], ['COURT', 'CRT'], ['POINT', 'PT'], ['PARK', 'PK'],
  ['CIRCLE', 'CIR'], ['PARKWAY', 'PKY'], ['TERRACE', 'TERR'],
  ['PROMENADE', 'PROM'], ['CROSSING', 'CROSS'], ['SQUARE', 'SQ'],
  ['GARDENS', 'GDNS'], ['GARDEN', 'GDN'], ['FREEWAY', 'FWY'],
];
for (const [full, abbr] of PAIRS) {
  assert.equal(
    normalizeAddressKey(`100 SOMEWHERE ${full}`),
    normalizeAddressKey(`100 SOMEWHERE ${abbr}`),
    `${full} == ${abbr}`,
  );
}
// Types both datasets spell identically fold onto themselves.
for (const same of ['BAY', 'WAY', 'COVE', 'LANE', 'TRAIL', 'GATE', 'ROW',
  'CLOSE', 'PATH', 'GROVE', 'WALK', 'BEND', 'KEY', 'RIDGE', 'COMMON',
  'RUN', 'ALLEY', 'MEWS']) {
  assert.equal(normalizeAddressKey(`5 X ${same}`), `5 X ${same}`);
}
// Case, punctuation, whitespace, apostrophes, directionals.
assert.equal(normalizeAddressKey('407 lyndale dr'), '407 LYNDALE DR');
assert.equal(normalizeAddressKey('  407   LYNDALE   DR  '), '407 LYNDALE DR');
assert.equal(normalizeAddressKey('407 LYNDALE DR.'), '407 LYNDALE DR');
assert.equal(normalizeAddressKey("1 ST MARY'S RD"), normalizeAddressKey('1 ST MARYS ROAD'));
assert.equal(normalizeAddressKey('9 PORTAGE AVE EAST'), normalizeAddressKey('9 PORTAGE AVE E'));
// Different addresses must NOT collapse.
assert.notEqual(normalizeAddressKey('407 LYNDALE DR'), normalizeAddressKey('409 LYNDALE DR'));
assert.notEqual(normalizeAddressKey('407 LYNDALE DR'), normalizeAddressKey('407 LYNDALE BAY'));
assert.equal(normalizeAddressKey(''), '');
assert.equal(normalizeAddressKey(null), '');

// ---- addressBaseKey -------------------------------------------------------
assert.equal(addressBaseKey('1000 ALDGATE RD UNIT 101'), '1000 ALDGATE RD');
assert.equal(addressBaseKey('1000 ALDGATE RD'), '1000 ALDGATE RD');
assert.equal(addressBaseKey('1000 ALDGATE RD SUITE 4'), '1000 ALDGATE RD');
// A street literally named "…ROW" must not lose its type to the regex.
assert.equal(addressBaseKey('12 KINGSTON ROW'), '12 KINGSTON ROW');

// ---- dedupeAddresses ------------------------------------------------------
// The reported bug: one address, two spellings, assessment first.
assert.deepEqual(
  dedupeAddresses(['407 LYNDALE DRIVE', '407 LYNDALE DR']),
  ['407 LYNDALE DRIVE'],
  'keeps the first (assessment) spelling',
);
// Order is preserved and the survivor is the caller's preferred one.
assert.deepEqual(
  dedupeAddresses(['170 LYNDALE DR', '170 LYNDALE DRIVE']),
  ['170 LYNDALE DR'],
);
// Genuinely different addresses all survive.
assert.deepEqual(
  dedupeAddresses(['400 HARGRAVE STREET', '440 HARGRAVE ST', '400 HARGRAVE ST']),
  ['400 HARGRAVE STREET', '440 HARGRAVE ST'],
);
// Unit addresses collapse when the base address is present…
assert.deepEqual(
  dedupeAddresses([
    '1000 ALDGATE RD',
    '1000 ALDGATE RD Unit 101',
    '1000 ALDGATE RD Unit 102',
    '1000 ALDGATE RD Unit 501',
  ]),
  ['1000 ALDGATE RD'],
);
// …including when the base appears AFTER its units.
assert.deepEqual(
  dedupeAddresses(['1000 ALDGATE RD Unit 101', '1000 ALDGATE RD']),
  ['1000 ALDGATE RD'],
);
// …and the base still suppresses units spelled the other way.
assert.deepEqual(
  dedupeAddresses(['1000 ALDGATE ROAD', '1000 ALDGATE RD Unit 101']),
  ['1000 ALDGATE ROAD'],
);
// But units are KEPT when no base address exists — folding them to a
// base would invent an address neither source asserted.
assert.deepEqual(
  dedupeAddresses(['1000 ALDGATE RD Unit 101', '1000 ALDGATE RD Unit 102']),
  ['1000 ALDGATE RD Unit 101', '1000 ALDGATE RD Unit 102'],
);
// Blank / degenerate input.
assert.deepEqual(dedupeAddresses([]), []);
assert.deepEqual(dedupeAddresses(null), []);
assert.deepEqual(dedupeAddresses(['', '   ', null, undefined]), []);
assert.deepEqual(dedupeAddresses(['  407 LYNDALE DR  ', '407 LYNDALE DRIVE']), ['407 LYNDALE DR']);

console.log('addressFormat.test.js: all assertions passed');

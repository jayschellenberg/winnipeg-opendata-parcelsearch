// Full Address dedupe. The two sources spell the same street
// differently — the assessment record writes "DRIVE", the civic
// address dataset writes "DR" — so an exact-string dedupe let both
// through and the cell read the same address twice.
import assert from 'node:assert/strict';
import {
  normalizeAddressKey,
  addressBaseKey,
  unitPrefixBaseKey,
  dedupeAddresses,
  addressListTooltip,
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

// ---- unitPrefixBaseKey ----------------------------------------------------
// Winnipeg condo notation. Safe to key off the dash: of 4,000 sampled
// assessment addresses containing one, 3,998 are exactly this form and
// the other 2 are the same form with a space in the unit. No address
// RANGES exist in this dataset.
assert.equal(unitPrefixBaseKey('610-1000 ALDGATE RD'), '1000 ALDGATE RD');
assert.equal(unitPrefixBaseKey('1-480 CHALFONT RD'), '480 CHALFONT RD');
// Units containing spaces — the two real outliers.
assert.equal(unitPrefixBaseKey('116 A-45 GILLSON ST'), '45 GILLSON ST');
assert.equal(unitPrefixBaseKey('3RD FL-45 GILLSON ST'), '45 GILLSON ST');
// Not a unit address.
assert.equal(unitPrefixBaseKey('1000 ALDGATE RD'), null);
assert.equal(unitPrefixBaseKey('407 LYNDALE DR'), null);
assert.equal(unitPrefixBaseKey(''), null);
assert.equal(unitPrefixBaseKey(null), null);

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
// …including when the base appears AFTER its units. (Index 0 here is an
// unrelated address, because the first entry is deliberately never
// dropped — see the invariant below.)
assert.deepEqual(
  dedupeAddresses(['999 OTHER ST', '1000 ALDGATE RD Unit 101', '1000 ALDGATE RD']),
  ['999 OTHER ST', '1000 ALDGATE RD'],
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
// On a condo unit's row the bare building address is dropped — the unit
// address already names the building.
assert.deepEqual(
  dedupeAddresses(['610-1000 ALDGATE ROAD', '1000 ALDGATE RD']),
  ['610-1000 ALDGATE ROAD'],
);
// Works across the two spellings of the street type.
assert.deepEqual(
  dedupeAddresses(['1-480 CHALFONT ROAD', '480 CHALFONT RD']),
  ['1-480 CHALFONT ROAD'],
);
// A unit with a space in it still suppresses the building address.
assert.deepEqual(
  dedupeAddresses(['116 A-45 GILLSON STREET', '45 GILLSON ST']),
  ['116 A-45 GILLSON STREET'],
);
// A DIFFERENT building's address is not touched.
assert.deepEqual(
  dedupeAddresses(['610-1000 ALDGATE ROAD', '990 ALDGATE RD']),
  ['610-1000 ALDGATE ROAD', '990 ALDGATE RD'],
);
// The building's OWN row keeps its address: it is first, and the first
// entry is never dropped, so cross-referenced unit points can't strip a
// parcel's own address off its row.
assert.deepEqual(
  dedupeAddresses(['1000 ALDGATE ROAD', '610-1000 ALDGATE RD']),
  ['1000 ALDGATE ROAD', '610-1000 ALDGATE RD'],
);
// With no unit address present, the building address stands alone.
assert.deepEqual(dedupeAddresses(['1000 ALDGATE RD']), ['1000 ALDGATE RD']);

// Blank / degenerate input.
assert.deepEqual(dedupeAddresses([]), []);
assert.deepEqual(dedupeAddresses(null), []);
assert.deepEqual(dedupeAddresses(['', '   ', null, undefined]), []);
assert.deepEqual(dedupeAddresses(['  407 LYNDALE DR  ', '407 LYNDALE DRIVE']), ['407 LYNDALE DR']);

// ---- addressListTooltip ---------------------------------------------------
// The reported case: 1393 BORDER ST is a real address on roll 07560170500,
// but the City's own search only knows the parcel as 1347 BORDER STREET.
{
  const tip = addressListTooltip(
    '1347 BORDER STREET, 1361 BORDER ST, 1393 BORDER ST, 1872 NOTRE DAME AVE'
  );
  const lines = tip.split('\n');
  assert.equal(lines[0], 'Assessment record: 1347 BORDER STREET');
  assert.match(lines[1], /winnipegassessment\.com/);
  assert.equal(lines[3], 'Also on this parcel (3):');
  assert.deepEqual(lines.slice(4), ['1361 BORDER ST', '1393 BORDER ST', '1872 NOTRE DAME AVE']);
}
// One address is not a list — nothing to disambiguate, so no hover.
assert.equal(addressListTooltip('1636 MCCREARY ROAD'), null);
assert.equal(addressListTooltip(''), null);
assert.equal(addressListTooltip(null), null);
assert.equal(addressListTooltip(undefined), null);
// Stray separators don't invent an entry or a blank line.
assert.equal(addressListTooltip('1636 MCCREARY ROAD, '), null);
assert.equal(
  addressListTooltip('400 HARGRAVE STREET,,440 HARGRAVE ST').split('\n')[3],
  'Also on this parcel (1):',
);

console.log('addressFormat.test.js: all assertions passed');

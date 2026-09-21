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
  properCaseAddress,
  groupAddressesByStreet,
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

// ---- properCaseAddress ----------------------------------------------------
// A DISPLAY transform only: the keys above still uppercase, so casing can
// never move an address into or out of a dedupe bucket.
assert.equal(properCaseAddress('1347 BORDER STREET'), '1347 Border Street');
assert.equal(properCaseAddress('407 LYNDALE DR, 409 LYNDALE DRIVE'),
  '407 Lyndale Dr, 409 Lyndale Drive');
// Directionals are abbreviations, not words.
assert.equal(properCaseAddress('9 PORTAGE AVE E'), '9 Portage Ave E');
assert.equal(properCaseAddress('450 PORTAGE AVE NW'), '450 Portage Ave NW');
// Ordinals lowercase their suffix rather than capitalizing it.
assert.equal(properCaseAddress('221 3RD ST'), '221 3rd St');
// The Mc streets. "Mcphillips" is a misspelling, not a casing choice.
assert.equal(properCaseAddress('1636 MCCREARY ROAD'), '1636 McCreary Road');
assert.equal(properCaseAddress('2200 MCPHILLIPS ST'), '2200 McPhillips St');
// Unit and civic numbers are identifiers — left exactly as written.
assert.equal(properCaseAddress('1000 ALDGATE RD UNIT 101'), '1000 Aldgate Rd Unit 101');
assert.equal(properCaseAddress('610-1000 ALDGATE ROAD'), '610-1000 Aldgate Road');
assert.equal(properCaseAddress('116 A-45 GILLSON STREET'), '116 A-45 Gillson Street');
// Apostrophes don't start a new word.
assert.equal(properCaseAddress("1200 ST MARY'S RD"), "1200 St Mary's Rd");
// Anything a source already cased is left alone, so a correct name can't be
// un-corrected by a second pass.
assert.equal(properCaseAddress('2200 McPhillips St'), '2200 McPhillips St');
assert.equal(properCaseAddress(properCaseAddress('1636 MCCREARY ROAD')), '1636 McCreary Road');
// Empty in, empty out — the cell helpers test for '' to draw the em-dash.
assert.equal(properCaseAddress(''), '');
assert.equal(properCaseAddress(null), '');
assert.equal(properCaseAddress(undefined), '');

// ---- groupAddressesByStreet ----------------------------------------------
// One parcel holding several addresses on one street draws ONE map label.
// At lot scale the separate points stack on top of each other, and
// "511 & 513 Selkirk Ave" is how the addresses get written down anyway.
const P = (display, i = 0) => ({ display, lng: -97.1 + i * 0.0001, lat: 49.9 + i * 0.0001 });
const labels = (pts) => groupAddressesByStreet(pts).map((g) => g.label);

// The reported case, across the two datasets' street-type spellings.
assert.deepEqual(
  labels([P('511 SELKIRK AVE', 0), P('513 SELKIRK AVENUE', 1)]),
  ['511 & 513 SELKIRK AVE'],
);
// Three still list individually; the fourth flips to a range, because a
// strip mall's entries would otherwise outrun the parcel they sit on.
assert.deepEqual(
  labels([P('511 SELKIRK AVE', 0), P('513 SELKIRK AVE', 1), P('515 SELKIRK AVE', 2)]),
  ['511, 513 & 515 SELKIRK AVE'],
);
assert.deepEqual(
  labels([P('1100 PORTAGE AVE', 0), P('1110 PORTAGE AVE', 1),
          P('1120 PORTAGE AVE', 2), P('1140 PORTAGE AVE', 3)]),
  ['1100\u20131140 PORTAGE AVE'],
);
// Input order must not matter — the numbers come out ascending.
assert.deepEqual(
  labels([P('515 SELKIRK AVE', 0), P('511 SELKIRK AVE', 1), P('513 SELKIRK AVE', 2)]),
  ['511, 513 & 515 SELKIRK AVE'],
);
// A letter suffix sorts after its bare number and stays distinct.
assert.deepEqual(
  labels([P('100A MAIN ST', 0), P('100 MAIN ST', 1)]),
  ['100 & 100A MAIN ST'],
);
// A half address is its own entry and does not sort on its trailing "2".
assert.deepEqual(
  labels([P('100 1/2 MAIN ST', 0), P('100 MAIN ST', 1)]),
  ['100 & 100 1/2 MAIN ST'],
);
// A condo's per-unit points share one civic number, so the whole tower
// collapses to the building address rather than one label per unit.
assert.deepEqual(
  labels([P('1000 ALDGATE RD UNIT 101', 0), P('1000 ALDGATE RD UNIT 501', 1),
          P('1000 ALDGATE RD UNIT 902', 2)]),
  ['1000 ALDGATE RD'],
);
// A corner lot fronts two streets. Those are two frontages and must
// stay two labels — merging them would assert something false.
assert.deepEqual(
  labels([P('100 MAIN ST', 0), P('99 OSBORNE ST', 1)]).sort(),
  ['100 MAIN ST', '99 OSBORNE ST'],
);
// A group of one is never reworded: the unit designator survives, and so
// does a legal description that has no civic number to factor out.
assert.deepEqual(labels([P('511 SELKIRK AVE', 0)]), ['511 SELKIRK AVE']);
assert.deepEqual(labels([P('610-1000 ALDGATE ROAD', 0)]), ['610-1000 ALDGATE ROAD']);
assert.deepEqual(labels([P('DESC NE22-21-3E', 0)]), ['DESC NE22-21-3E']);
// The merged label sits at the mean of its points, and remembers what it
// stands for.
const merged = groupAddressesByStreet([P('511 SELKIRK AVE', 0), P('513 SELKIRK AVE', 2)])[0];
assert.equal(merged.lng.toFixed(6), (-97.1 + 0.0001).toFixed(6));
assert.equal(merged.lat.toFixed(6), (49.9 + 0.0001).toFixed(6));
assert.deepEqual(merged.addresses, ['511 SELKIRK AVE', '513 SELKIRK AVE']);
// Junk in: no throw, nothing out. A point with no coordinates is dropped
// rather than poisoning the group's mean with NaN.
assert.deepEqual(groupAddressesByStreet([]), []);
assert.deepEqual(groupAddressesByStreet(null), []);
assert.deepEqual(groupAddressesByStreet(undefined), []);
assert.deepEqual(labels([{ display: '511 SELKIRK AVE' }]), []);
assert.deepEqual(labels([P('', 0), P('   ', 1)]), []);

console.log('addressFormat.test.js: all assertions passed');

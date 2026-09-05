// The map's address box — the pure half. Parsing what was typed, folding
// the street-type tokens cam2-ii3u keeps in their own columns, ranking the
// rows that come back, and turning a pick into the three sidebar values.
//
// Run: cd web && node test/mapAddressSearch.test.js

import assert from 'node:assert/strict';
import {
  parseAddressQuery,
  streetNameFragment,
  rankAddresses,
  addressToFields,
  MAP_ADDRESS_LIMIT,
} from '../src/lib/mapAddressSearch.js';

// ---- parseAddressQuery ----------------------------------------------------

assert.deepEqual(parseAddressQuery('1393 Border St'), { number: '1393', street: 'BORDER ST' });
assert.deepEqual(parseAddressQuery('  1393   border  st '), { number: '1393', street: 'BORDER ST' });
assert.deepEqual(parseAddressQuery('Border'), { number: null, street: 'BORDER' });
assert.deepEqual(parseAddressQuery('1393'), { number: '1393', street: '' });
// Punctuation is separator, not content: "ST. MARY'S" must not lose the S.
assert.deepEqual(parseAddressQuery("100 ST. MARY'S RD"), { number: '100', street: "ST MARY'S RD" });
assert.equal(parseAddressQuery(''), null);
assert.equal(parseAddressQuery('   '), null);
assert.equal(parseAddressQuery(null), null);

// ---- streetNameFragment ---------------------------------------------------
// cam2 keeps the type and direction in their own columns, so street_name for
// "1393 BORDER ST" is just "BORDER" — the tail has to come off the query.

assert.equal(streetNameFragment('BORDER ST'), 'BORDER');
assert.equal(streetNameFragment('PORTAGE AVE E'), 'PORTAGE');
assert.equal(streetNameFragment('NOTRE DAME AVE'), 'NOTRE DAME');
// Never the last token standing: "ST" alone is someone starting ST MARY'S,
// and "PARK" alone is a street name in its own right.
assert.equal(streetNameFragment('ST'), 'ST');
assert.equal(streetNameFragment('PARK'), 'PARK');
assert.equal(streetNameFragment(''), '');

// ---- rankAddresses --------------------------------------------------------

const ROWS = [
  { full_address: '1393 BORDEN AVE', street_number: '1393', street_name: 'BORDEN', street_type: 'AVE' },
  { full_address: '1393 BORDER ST', street_number: '1393', street_name: 'BORDER', street_type: 'ST' },
  { full_address: '1347 BORDER ST', street_number: '1347', street_name: 'BORDER', street_type: 'ST' },
];

// The exact number the user typed outranks a near miss, and among those the
// street whose name actually starts with what was typed comes first.
assert.deepEqual(
  rankAddresses(ROWS, '1393 Border').map((r) => r.full_address),
  ['1393 BORDER ST', '1393 BORDEN AVE', '1347 BORDER ST'],
);

// A street-only query reads in address order rather than service order.
assert.deepEqual(
  rankAddresses(ROWS, 'Border').map((r) => r.full_address),
  ['1347 BORDER ST', '1393 BORDER ST', '1393 BORDEN AVE'],
);

// Duplicate full_address values collapse — a building can carry several
// rows in cam2 and the list should not say the same address twice.
assert.deepEqual(
  rankAddresses([ROWS[1], { ...ROWS[1] }], '1393 Border').map((r) => r.full_address),
  ['1393 BORDER ST'],
);

// The limit holds, and nothing usable in / nothing out.
assert.equal(rankAddresses(new Array(40).fill(0).map((_, i) => ({
  full_address: `${100 + i} MAIN ST`, street_number: String(100 + i), street_name: 'MAIN',
})), 'Main').length, MAP_ADDRESS_LIMIT);
assert.deepEqual(rankAddresses([], '1393 Border'), []);
assert.deepEqual(rankAddresses(null, '1393 Border'), []);
assert.deepEqual(rankAddresses(ROWS, ''), []);
// A row with no address text is not a suggestion.
assert.deepEqual(rankAddresses([{ street_name: 'BORDER' }], 'Border'), []);

// ---- addressToFields ------------------------------------------------------
// From and To are the same number: this box looks up ONE property. The street
// comes from cam2's own column, so what runs is what the dataset asserts.

assert.deepEqual(
  addressToFields({ full_address: '1393 BORDER ST', street_number: '1393', street_name: 'BORDER' }),
  { from: '1393', to: '1393', street: 'BORDER' },
);
// Incomplete rows never produce a half-filled search.
assert.equal(addressToFields({ street_number: '1393' }), null);
assert.equal(addressToFields({ street_name: 'BORDER' }), null);
assert.equal(addressToFields(null), null);

console.log('mapAddressSearch.test.js: all assertions passed');

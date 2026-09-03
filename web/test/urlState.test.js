// Unit tests for src/lib/urlState.js. Plain-node runner; run with
//   cd web && npm test
// or
//   node test/urlState.test.js
//
// Coverage: empty / malformed / out-of-range params, every schema
// type (string, oneOf, int, bool), round-trip, and schema-shape
// invariants. The schema is the single source of truth for what
// the URL encodes — these tests pin it.

import assert from 'node:assert/strict';
import { encodeState, decodeState, SCHEMA } from '../src/lib/urlState.js';

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

console.log('urlState');

// ---------- empty / blank ----------

test('decodeState — null returns empty object', () => {
  assert.deepEqual(decodeState(null), {});
});

test('decodeState — undefined returns empty object', () => {
  assert.deepEqual(decodeState(undefined), {});
});

test('decodeState — empty string returns empty object', () => {
  assert.deepEqual(decodeState(''), {});
});

test('decodeState — bare ? returns empty object', () => {
  assert.deepEqual(decodeState('?'), {});
});

test('encodeState — null state returns empty string', () => {
  assert.equal(encodeState(null), '');
});

test('encodeState — empty object returns empty string', () => {
  assert.equal(encodeState({}), '');
});

test('encodeState — only null/undefined values returns empty string', () => {
  assert.equal(encodeState({ roll: null, lot: undefined, addressFrom: '' }), '');
});

// ---------- happy-path encode + decode (search inputs) ----------

test('encodeState — single string field (lot)', () => {
  const out = encodeState({ lot: '21-25' });
  assert.equal(new URLSearchParams(out).get('l'), '21-25');
});

test('encodeState — every search input', () => {
  const out = encodeState({
    lot: '21', block: 'A', plan: '129', desc: 'PCL G',
    roll: '12082288000', addressFrom: '100', addressTo: '200',
    addressStreet: 'HARGRAVE', zoning: 'R1', duMode: 'min', duMin: 3,
  });
  const params = new URLSearchParams(out);
  assert.equal(params.get('l'),  '21');
  assert.equal(params.get('b'),  'A');
  assert.equal(params.get('p'),  '129');
  assert.equal(params.get('d'),  'PCL G');
  assert.equal(params.get('r'),  '12082288000');
  assert.equal(params.get('af'), '100');
  assert.equal(params.get('at'), '200');
  assert.equal(params.get('as'), 'HARGRAVE');
  assert.equal(params.get('z'),  'R1');
  assert.equal(params.get('du'), 'min');
  assert.equal(params.get('dn'), '3');
});

test('decodeState — every search input round-trip', () => {
  const result = decodeState('l=21&b=A&p=129&d=PCL+G&r=12082288000&af=100&at=200&as=HARGRAVE&z=R1&du=min&dn=3');
  assert.deepEqual(result, {
    lot: '21', block: 'A', plan: '129', desc: 'PCL G',
    roll: '12082288000', addressFrom: '100', addressTo: '200',
    addressStreet: 'HARGRAVE', zoning: 'R1', duMode: 'min', duMin: 3,
  });
});

test('decodeState — leading ? tolerated', () => {
  assert.deepEqual(decodeState('?r=123'), { roll: '123' });
});

test('decodeState — comma-separated roll list preserved', () => {
  assert.deepEqual(decodeState('r=12345,67890,11111'), { roll: '12345,67890,11111' });
});

// ---------- overlay toggles ----------

test('encodeState — toggle true emits 1', () => {
  const out = encodeState({ zoningToggle: true });
  assert.equal(new URLSearchParams(out).get('zo'), '1');
});

test('encodeState — toggle false emits 0', () => {
  const out = encodeState({ assessToggle: false });
  assert.equal(new URLSearchParams(out).get('av'), '0');
});

test('decodeState — toggle 1 parses to true', () => {
  assert.deepEqual(decodeState('zo=1'), { zoningToggle: true });
});

test('decodeState — toggle 0 parses to false', () => {
  assert.deepEqual(decodeState('av=0'), { assessToggle: false });
});

test('decodeState — toggle "true" / "false" tolerated', () => {
  assert.deepEqual(decodeState('zo=true&av=false'), {
    zoningToggle: true, assessToggle: false,
  });
});

test('decodeState — toggle non-boolean dropped', () => {
  assert.deepEqual(decodeState('zo=yes'), {});
  assert.deepEqual(decodeState('zo=2'),   {});
});

test('encodeState — every overlay toggle emits its short code', () => {
  const out = encodeState({
    surveyToggle: true,
    assessToggle: false,
    allParcelsToggle: true,
    dwellingUnitsToggle: true,
    zoningToggle: true,
    trafficToggle: true,
    secondaryPlansToggle: true,
    infillToggle: true,
    mallsCorridorsToggle: true,
    transitToggle: true,
    contamToggle: true,
    dimensionsToggle: true,
  });
  const params = new URLSearchParams(out);
  assert.equal(params.get('sv'), '1');
  assert.equal(params.get('av'), '0');
  assert.equal(params.get('ap'), '1');
  assert.equal(params.get('dl'), '1');
  assert.equal(params.get('zo'), '1');
  assert.equal(params.get('tr'), '1');
  assert.equal(params.get('sp'), '1');
  assert.equal(params.get('if'), '1');
  assert.equal(params.get('mc'), '1');
  assert.equal(params.get('bt'), '1');
  assert.equal(params.get('cn'), '1');
  assert.equal(params.get('dm'), '1');
});

// ---------- sort ----------

test('decodeState — sortCol + sortDir parsed', () => {
  assert.deepEqual(decodeState('sc=address&sd=desc'), { sortCol: 'address', sortDir: 'desc' });
});

test('decodeState — unknown sortCol dropped', () => {
  assert.deepEqual(decodeState('sc=junk&sd=asc'), { sortDir: 'asc' });
});

test('decodeState — bad sortDir dropped', () => {
  assert.deepEqual(decodeState('sc=roll&sd=sideways'), { sortCol: 'roll' });
});

test('encodeState — every valid sortCol round-trips', () => {
  const cols = [
    'lot', 'block', 'plan', 'desc', 'roll', 'address',
    'zoning', 'zoningPct', 'zoning2', 'area',
    'lat', 'lon', 'value', 'walk', 'flood',
    'saleDate', 'salePrice', 'pricePerSf', 'saleToAsmt',
    'dist', 'useCode', 'livingArea', 'yearBuilt',
    'instrument', 'propertyType', 'groupSize',
  ];
  for (const c of cols) {
    const decoded = decodeState(encodeState({ sortCol: c }));
    assert.deepEqual(decoded, { sortCol: c }, `sortCol=${c} failed`);
  }
});

// ---------- malformed / out-of-range / unknown ----------

test('decodeState — unknown param dropped', () => {
  assert.deepEqual(decodeState('xyz=value&r=12345'), { roll: '12345' });
});

test('decodeState — duMin out of range dropped', () => {
  assert.deepEqual(decodeState('du=min&dn=99999'),   { duMode: 'min' });
});

test('decodeState — duMin negative dropped', () => {
  assert.deepEqual(decodeState('du=min&dn=-1'),      { duMode: 'min' });
});

test('decodeState — duMin non-numeric dropped', () => {
  assert.deepEqual(decodeState('du=min&dn=abc'),     { duMode: 'min' });
});

test('decodeState — duMode rejects values outside [zero, min]', () => {
  assert.deepEqual(decodeState('du=any'), {});
});

test('decodeState — duMode zero accepted', () => {
  assert.deepEqual(decodeState('du=zero'), { duMode: 'zero' });
});

test('decodeState — string over 200 chars dropped', () => {
  const long = 'x'.repeat(201);
  assert.deepEqual(decodeState(`r=${long}`), {});
});

test('decodeState — string of exactly 200 chars kept', () => {
  const ok = 'x'.repeat(200);
  assert.deepEqual(decodeState(`r=${ok}`), { roll: ok });
});

test('decodeState — empty-string value treated as missing', () => {
  assert.deepEqual(decodeState('r=&l=21'), { lot: '21' });
});

test('decodeState — whitespace-only string dropped', () => {
  assert.deepEqual(decodeState('r=%20%20'), {});
});

test('decodeState — malformed URL query handled gracefully', () => {
  let threw = false;
  try { decodeState('r=%E0%A4'); } catch { threw = true; }
  assert.equal(threw, false);
});

// ---------- round-trip ----------

test('round-trip — full state survives encode + decode', () => {
  const state = {
    lot: '21-25', block: 'A', plan: '129', desc: 'PCL G',
    roll: '12082288000,12082288100',
    addressFrom: '100', addressTo: '200', addressStreet: 'HARGRAVE',
    zoning: 'R1', duMode: 'min', duMin: 5,
    surveyToggle: true,
    assessToggle: false,
    allParcelsToggle: true,
    dwellingUnitsToggle: true,
    zoningToggle: true,
    trafficToggle: true,
    secondaryPlansToggle: true,
    infillToggle: true,
    mallsCorridorsToggle: true,
    transitToggle: true,
    contamToggle: true,
    dimensionsToggle: true,
    neighbourhoodsMode: 'individual',
    sortCol: 'address',
    sortDir: 'desc',
  };
  const encoded = encodeState(state);
  const decoded = decodeState(encoded);
  assert.deepEqual(decoded, state);
});

test('round-trip — empty state survives', () => {
  const encoded = encodeState({});
  assert.equal(encoded, '');
  assert.deepEqual(decodeState(encoded), {});
});

test('round-trip — partial state preserves only set keys', () => {
  const state = { roll: '12345', sortCol: 'area', sortDir: 'asc' };
  const encoded = encodeState(state);
  const decoded = decodeState(encoded);
  assert.deepEqual(decoded, state);
});

test('round-trip — special chars in address street encoded + decoded', () => {
  const state = { addressStreet: 'ROUGE BAY' };
  const encoded = encodeState(state);
  assert.ok(encoded.includes('%20') || encoded.includes('+'));
  const decoded = decodeState(encoded);
  assert.deepEqual(decoded, state);
});

test('encodeState — extra / unknown keys silently ignored', () => {
  const out = encodeState({ roll: '12345', nonsense: 'value', another: 42 });
  const params = new URLSearchParams(out);
  assert.equal(params.get('r'), '12345');
  assert.equal(params.size, 1);
});

// ---------- schema sanity ----------

test('SCHEMA — every entry has param, validate, format', () => {
  for (const [key, def] of Object.entries(SCHEMA)) {
    assert.ok(typeof def.param === 'string' && def.param.length > 0, `${key} missing param`);
    assert.ok(typeof def.validate === 'function', `${key} missing validate`);
    assert.ok(typeof def.format === 'function', `${key} missing format`);
  }
});

test('SCHEMA — param keys are unique', () => {
  const seen = new Set();
  for (const def of Object.values(SCHEMA)) {
    assert.ok(!seen.has(def.param), `Duplicate param key: ${def.param}`);
    seen.add(def.param);
  }
});

test('SCHEMA — has exactly 33 entries (11 inputs + 13 toggles + 1 neighbourhoods-mode + 2 sort + 1 tab + 2 numbering + 1 subjectRoll + 1 salesN1 + 1 salesRise)', () => {
  assert.equal(Object.keys(SCHEMA).length, 33);
});

test('salesRise round-trips as the rise param; only the three bands are valid', () => {
  assert.equal(encodeState({ salesRise: 'mid' }), 'rise=mid');
  assert.deepEqual(decodeState('?rise=low'), { salesRise: 'low' });
  assert.deepEqual(decodeState('?rise=high'), { salesRise: 'high' });
  // 'any' is the default and never a URL state; garbage is dropped.
  assert.deepEqual(decodeState('?rise=any'), {});
  assert.deepEqual(decodeState('?rise=tower'), {});
});

test('numberingOrder ("Entry order") round-trips as the no param', () => {
  assert.equal(encodeState({ numberingOrder: true }), 'no=1');
  assert.deepEqual(decodeState('?no=1'), { numberingOrder: true });
  assert.deepEqual(decodeState('?no=0'), { numberingOrder: false });
  assert.deepEqual(decodeState('?no=maybe'), {});
  // Both numbering params together, in schema order.
  assert.equal(encodeState({ numberingToggle: true, numberingOrder: true }), 'nu=1&no=1');
});

test('numberingToggle round-trips as the nu param', () => {
  assert.equal(encodeState({ numberingToggle: true }), 'nu=1');
  assert.deepEqual(decodeState('?nu=1'), { numberingToggle: true });
  assert.deepEqual(decodeState('?nu=0'), { numberingToggle: false });
  assert.deepEqual(decodeState('?nu=maybe'), {});
});

// ---------- neighbourhoodsMode (3-state cycle) ----------

test('decodeState — neighbourhoodsMode=clusters accepted', () => {
  assert.deepEqual(decodeState('nh=clusters'), { neighbourhoodsMode: 'clusters' });
});

test('decodeState — neighbourhoodsMode=individual accepted', () => {
  assert.deepEqual(decodeState('nh=individual'), { neighbourhoodsMode: 'individual' });
});

test('decodeState — neighbourhoodsMode=off dropped (default state)', () => {
  assert.deepEqual(decodeState('nh=off'), {});
});

test('decodeState — neighbourhoodsMode=junk dropped', () => {
  assert.deepEqual(decodeState('nh=junk'), {});
});

test('round-trip — neighbourhoodsMode=clusters survives', () => {
  const state = { neighbourhoodsMode: 'clusters', roll: '12345' };
  assert.deepEqual(decodeState(encodeState(state)), state);
});

// ---------- subjectRoll (Phase 7 fu2) ----------

test('decodeState — subjectRoll accepted', () => {
  assert.deepEqual(decodeState('sr=12345678900'), { subjectRoll: '12345678900' });
});

test('decodeState — subjectRoll preserves 10-digit form (normalize is client-side)', () => {
  assert.deepEqual(decodeState('sr=6070731000'), { subjectRoll: '6070731000' });
});

test('round-trip — tab + subjectRoll together', () => {
  const state = { tab: 'sales', subjectRoll: '14030927000' };
  assert.deepEqual(decodeState(encodeState(state)), state);
});

// ---------- tab (Phase 7) ----------

test('decodeState — tab=sales accepted', () => {
  assert.deepEqual(decodeState('t=sales'), { tab: 'sales' });
});

test('decodeState — tab=property accepted', () => {
  assert.deepEqual(decodeState('t=property'), { tab: 'property' });
});

test('decodeState — tab=unknown dropped', () => {
  assert.deepEqual(decodeState('t=junk'), {});
});

test('round-trip — tab=sales survives', () => {
  const state = { tab: 'sales', roll: '12345' };
  assert.deepEqual(decodeState(encodeState(state)), state);
});

test('salesN1 — matched/unmatched round-trip; the default and garbage stay out', () => {
  assert.equal(new URLSearchParams(encodeState({ salesN1: 'unmatched' })).get('n1'), 'unmatched');
  assert.deepEqual(decodeState('n1=matched'), { salesN1: 'matched' });
  assert.deepEqual(decodeState('n1=bogus'), {});
  // 'any' is the default — never emitted, never accepted as state.
  assert.deepEqual(decodeState('n1=any'), {});
  assert.equal(encodeState({}), '');
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

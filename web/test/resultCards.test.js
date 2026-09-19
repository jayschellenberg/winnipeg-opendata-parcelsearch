// cardModel — what a result card shows for one table row.
//
// The DOM side of resultCards.js reads the table; this is the pure step
// that turns one row's columns into title, subtitle, fact strip and the
// expandable detail list. The rules that matter: the headline never
// depends on the column gear, the detail list always does, empty cells
// never appear, and nothing is shown twice. The module is shared with
// the Winnipeg portal, whose columns carry different keys, so the same
// rules are checked against a Winnipeg-shaped key map too.
//
// Run: cd web && node test/resultCards.test.js

import assert from 'node:assert/strict';
import { cardModel, resolveKeys, DEFAULT_KEYS, FACT_KEYS } from '../src/lib/resultCards.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const col = (key, text, extra = {}) => ({
  key, label: key.toUpperCase(), text, hidden: false, empty: text == null || text === '' || text === '—', ...extra,
});

const ROW = [
  col('seq', '3', { hidden: true }),
  col('select', ''),
  col('roll', '100450'),
  col('muniname', 'STEINBACH (CITY)'),
  col('address', '665 MAIN ST'),
  col('zone1', 'CG'),
  col('zone1pct', '100%'),
  col('zone2', '—'),
  col('legal', 'LOT 1 PLAN 12345'),
  col('value', '$412,000'),
  col('acres', '0.42'),
  col('du', '—'),
  col('flood', 'Zone A (12%)', { hidden: true }),
  col('title', '1234567/1'),
];

test('the headline is address, roll and municipality', () => {
  const m = cardModel(ROW);
  assert.equal(m.title, '665 MAIN ST');
  assert.equal(m.sub, 'Roll 100450 · STEINBACH (CITY)');
});

test('the fact strip follows the key map order and folds the coverage % into zoning', () => {
  const m = cardModel(ROW);
  assert.deepEqual(m.facts.map((f) => f.key), ['value', 'zone1', 'acres']);
  assert.equal(m.facts.find((f) => f.key === 'zone1').text, 'CG (100%)');
  for (const f of m.facts) assert.ok(FACT_KEYS.includes(f.key));
});

test('a linked fact keeps its link (Assessment -> the report)', () => {
  const linked = ROW.map((c) => (c.key === 'value' ? { ...c, href: 'https://mao.example/report/100450' } : c));
  const value = cardModel(linked).facts.find((f) => f.key === 'value');
  assert.equal(value.href, 'https://mao.example/report/100450');
  assert.equal(cardModel(ROW).facts.find((f) => f.key === 'value').href, null);
});

test('the detail list holds the rest, skipping empties, hidden and headline keys', () => {
  const m = cardModel(ROW);
  assert.deepEqual(m.rest.map((c) => c.key), ['legal', 'title'],
    'a fallback title key that did not win (legal under an address) stays in the detail');
});

test('a hidden headline column still shows in the headline', () => {
  const m = cardModel(ROW.map((c) => (c.key === 'address' ? { ...c, hidden: true } : c)));
  assert.equal(m.title, '665 MAIN ST');
});

test('the map number shows only when its column is on', () => {
  assert.equal(cardModel(ROW).seq, null);
  const on = ROW.map((c) => (c.key === 'seq' ? { ...c, hidden: false } : c));
  assert.equal(cardModel(on).seq, '3');
});

test('no address falls back to legal, then to the roll', () => {
  const noAddr = ROW.map((c) => (c.key === 'address' ? { ...c, text: '—', empty: true } : c));
  let m = cardModel(noAddr);
  assert.equal(m.title, 'LOT 1 PLAN 12345');
  assert.ok(!m.rest.some((c) => c.key === 'legal'), 'legal shown as title must not repeat in detail');
  const noLegal = noAddr.map((c) => (c.key === 'legal' ? { ...c, text: '—', empty: true } : c));
  m = cardModel(noLegal);
  assert.equal(m.title, 'Roll 100450');
  assert.equal(m.sub, 'STEINBACH (CITY)', 'the roll is the title, so the subtitle must not repeat it');
});

test('duplicate keys (the dual Acres columns) keep the first', () => {
  const dup = [...ROW, col('acres', '9.99')];
  assert.equal(cardModel(dup).facts.find((f) => f.key === 'acres').text, '0.42');
});

// --- A Winnipeg-shaped key map, as its index.html supplies it -------
const WPG = resolveKeys({
  title: ['address', 'desc'],
  sub: ['roll'],
  facts: ['value', 'zoning', 'saleDate', 'salePrice', 'saleAcres', 'area', 'dwellingUnits'],
  pct: { zoning: 'zoningPct' },
  skip: ['select'],
});
const WPG_ROW = [
  col('seq', '7', { hidden: true }),
  col('select', ''),
  col('roll', '12345678900'),
  col('address', '330 SELKIRK AVE'),
  col('saleDate', '2026-03-24'),
  col('salePrice', '$400,000'),
  col('dwellingUnits', '3'),
  col('area', '4,800'),
  col('desc', 'PLAN 123 LOT 4'),
  col('zoning', 'R2'),
  col('zoningPct', '100%'),
  col('value', '$312,000'),
  col('lat', '49.91', { hidden: true }),
];

test('resolveKeys merges a partial map over the defaults', () => {
  assert.deepEqual(WPG.seq, DEFAULT_KEYS.seq);
  assert.deepEqual(WPG.sub, ['roll']);
  assert.equal(resolveKeys(null), DEFAULT_KEYS);
  assert.equal(resolveKeys('junk'), DEFAULT_KEYS);
});

test('the Winnipeg map builds the same shape of card from its own keys', () => {
  const m = cardModel(WPG_ROW, WPG);
  assert.equal(m.title, '330 SELKIRK AVE');
  assert.equal(m.sub, 'Roll 12345678900');
  assert.deepEqual(m.facts.map((f) => f.key), ['value', 'zoning', 'saleDate', 'salePrice', 'area', 'dwellingUnits']);
  assert.equal(m.facts.find((f) => f.key === 'zoning').text, 'R2 (100%)');
  assert.deepEqual(m.rest.map((c) => c.key), ['desc']);
});

test('the Winnipeg map falls back to the description, then the roll', () => {
  const noAddr = WPG_ROW.map((c) => (c.key === 'address' ? { ...c, text: '', empty: true } : c));
  assert.equal(cardModel(noAddr, WPG).title, 'PLAN 123 LOT 4');
  const bare = noAddr.map((c) => (c.key === 'desc' ? { ...c, text: '', empty: true } : c));
  const m = cardModel(bare, WPG);
  assert.equal(m.title, 'Roll 12345678900');
  assert.equal(m.sub, '');
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);

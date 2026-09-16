// lib/categoryColors.js — sale-category colours on the map.
// Run with `node test/categoryColors.test.js` or via `npm test`.
//
// The rule worth locking is STICKINESS. "Colour follows the entity, never
// its rank": a filter that changes the category count must not repaint the
// survivors. If ticking a sixth category re-deals the other five, every
// colour on the map means something different from one click to the next,
// and the map has to be re-read after every change.
import assert from 'node:assert/strict';
import {
  CATEGORY_COLORS, OTHER_COLOR, colorForSlot, assignCategoryColors, legendRows,
} from '../src/lib/categoryColors.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

console.log('categoryColors');

test('the palette is five distinct hues plus a chromaless Other', () => {
  assert.equal(CATEGORY_COLORS.length, 5);
  assert.equal(new Set(CATEGORY_COLORS).size, 5);
  assert.ok(!CATEGORY_COLORS.includes(OTHER_COLOR));
  // Validated at five by the dataviz validator; a sixth fails the
  // normal-vision floor. Pinned so "just add one more" has to read why.
  for (const hex of [...CATEGORY_COLORS, OTHER_COLOR]) {
    assert.match(hex, /^#[0-9a-f]{6}$/);
  }
});

test('colorForSlot — out of range is Other, never a wrapped hue', () => {
  assert.equal(colorForSlot(0), CATEGORY_COLORS[0]);
  assert.equal(colorForSlot(4), CATEGORY_COLORS[4]);
  // Cycling is the failure this guards: slot 5 must NOT be slot 0 again.
  for (const s of [5, 6, -1, null, undefined, 1.5, '2']) {
    assert.equal(colorForSlot(s), OTHER_COLOR, String(s));
  }
});

test('first assignment takes slots in the order given', () => {
  const a = assignCategoryColors(['Land', 'Residential', 'Office']);
  assert.equal(a.get('Land'), 0);
  assert.equal(a.get('Residential'), 1);
  assert.equal(a.get('Office'), 2);
});

test('STICKY — adding a category does not repaint the ones already there', () => {
  const first = assignCategoryColors(['Land', 'Residential']);
  const second = assignCategoryColors(['Land', 'Residential', 'Office'], first);
  assert.equal(second.get('Land'), first.get('Land'));
  assert.equal(second.get('Residential'), first.get('Residential'));
  assert.equal(second.get('Office'), 2);
});

test('STICKY — removing one does not repaint the rest', () => {
  const first = assignCategoryColors(['Land', 'Residential', 'Office']);
  const second = assignCategoryColors(['Land', 'Office'], first);
  assert.equal(second.get('Land'), 0);
  assert.equal(second.get('Office'), 2, 'Office keeps slot 2; it does not slide down to 1');
});

test('a slot freed by a departure is reused by a NEW category', () => {
  const first = assignCategoryColors(['Land', 'Residential', 'Office']);
  // Residential leaves (slot 1 frees), Retail arrives.
  const second = assignCategoryColors(['Land', 'Office', 'Retail-Commercial'], first);
  assert.equal(second.get('Land'), 0);
  assert.equal(second.get('Office'), 2);
  assert.equal(second.get('Retail-Commercial'), 1, 'takes the freed slot, not a sixth');
});

test('past five, the rest go grey — never a generated or reused hue', () => {
  const a = assignCategoryColors(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  assert.deepEqual([...a.values()], [0, 1, 2, 3, 4, null, null]);
  assert.equal(colorForSlot(a.get('F')), OTHER_COLOR);
});

test('a grey category can GAIN a colour when a slot frees — the safe direction', () => {
  const first = assignCategoryColors(['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(first.get('F'), null);
  const second = assignCategoryColors(['A', 'B', 'C', 'D', 'F'], first);
  // Nothing already coloured moved...
  for (const c of ['A', 'B', 'C', 'D']) assert.equal(second.get(c), first.get(c));
  // ...and F picked up the slot E left behind.
  assert.equal(second.get('F'), 4);
});

test('two categories can never share a slot, even from a junk previous', () => {
  const bogus = new Map([['A', 1], ['B', 1], ['C', 1]]);
  const a = assignCategoryColors(['A', 'B', 'C'], bogus);
  const slots = [...a.values()];
  assert.equal(new Set(slots).size, slots.length, `slots collided: ${slots}`);
});

test('a stale previous naming absent categories is ignored', () => {
  const stale = new Map([['Gone', 0], ['AlsoGone', 1]]);
  const a = assignCategoryColors(['Land'], stale);
  assert.equal(a.size, 1);
  assert.equal(a.get('Land'), 0, 'takes the free slot 0');
});

test('junk input never throws', () => {
  for (const args of [[], [[]], [null], [undefined, null], [['A'], 'not a map']]) {
    assert.ok(assignCategoryColors(...args) instanceof Map);
  }
});

test('legendRows — coloured in slot order, grey collapsed to one row', () => {
  const a = assignCategoryColors(['Land', 'Residential', 'Office', 'Retail', 'Industrial', 'Hospitality', 'Farm']);
  const rows = legendRows(a);
  assert.equal(rows.length, 6, '5 coloured + 1 combined Other');
  assert.deepEqual(rows.slice(0, 5).map((r) => r.label),
    ['Land', 'Residential', 'Office', 'Retail', 'Industrial']);
  assert.deepEqual(rows.slice(0, 5).map((r) => r.color), CATEGORY_COLORS);
  // Five identical swatches naming five categories would look like it was
  // distinguishing them; one row naming them does not.
  assert.equal(rows[5].other, true);
  assert.equal(rows[5].color, OTHER_COLOR);
  assert.match(rows[5].label, /^Other \(Hospitality, Farm\)$/);
});

test('legendRows — a single grey category is named plainly, not "Other (x)"', () => {
  const a = assignCategoryColors(['A', 'B', 'C', 'D', 'E', 'F']);
  const rows = legendRows(a);
  assert.equal(rows[5].label, 'F');
  assert.equal(rows[5].other, true);
});

test('legendRows — no grey means no Other row at all', () => {
  const rows = legendRows(assignCategoryColors(['Land', 'Office']));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => !r.other));
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

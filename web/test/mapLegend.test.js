// Unit tests for src/lib/mapLegend.js — the layout arithmetic behind
// "Include legend in map image". Only layoutMapLegends is exercised
// here; readMapLegends needs a DOM and paintMapLegends needs a canvas.
// Plain-node runner; run with `npm test` or `node test/mapLegend.test.js`.

import assert from 'node:assert/strict';
import {
  layoutMapLegends, LEGEND_MAX_WIDTH_RATIO,
} from '../src/lib/mapLegend.js';

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

console.log('mapLegend');

// A stand-in for canvas text measurement: 7 px per character.
const measureText = (t) => String(t).length * 7;

function legend(title, n) {
  return {
    title,
    items: Array.from({ length: n }, (_, i) => ({ color: '#abc', label: `row ${i + 1}` })),
  };
}

const BASE = { width: 1200, height: 800, bottomY: 760, fontSize: 12, measureText };

test('a single legend is placed in the bottom-right, above bottomY', () => {
  const [box] = layoutMapLegends([legend('Zoning', 4)], BASE);
  assert.equal(box.rows.length, 4);
  assert.equal(box.more, 0);
  assert.equal(box.x + box.w, BASE.width - 6, 'right-aligned with a 6px gutter');
  assert.equal(box.y + box.h, BASE.bottomY, 'bottom edge sits on bottomY');
  assert.ok(box.y > 0);
});

test('legends stack upward, each above the last', () => {
  const boxes = layoutMapLegends([legend('Zoning', 3), legend('Traffic', 3)], BASE);
  assert.equal(boxes.length, 2);
  assert.ok(boxes[1].y + boxes[1].h < boxes[0].y, 'second box sits above the first');
});

test('a box never exceeds the width ratio', () => {
  const wide = { title: 'W', items: [{ color: null, label: 'x'.repeat(400) }, { color: null, label: 'y' }] };
  const [box] = layoutMapLegends([wide], BASE);
  assert.ok(box.w <= Math.floor(BASE.width * LEGEND_MAX_WIDTH_RATIO));
});

test('an over-long legend truncates and says how many it dropped', () => {
  // 60 rows cannot fit in 62% of an 800px image at 12px type.
  const [box] = layoutMapLegends([legend('Zoning', 60)], BASE);
  assert.ok(box.rows.length < 60, 'rows were trimmed');
  assert.equal(box.more, 60 - box.rows.length, 'every dropped row is accounted for');
  assert.ok(box.more > 0);
});

test('the height budget is respected once the +N more line is added', () => {
  const [box] = layoutMapLegends([legend('Zoning', 60)], BASE);
  const budgetTop = BASE.bottomY - Math.floor(BASE.height * 0.62);
  assert.ok(box.y >= budgetTop, 'box stays inside the height budget');
});

test('a box with room for fewer than two rows is dropped, not stubbed', () => {
  // bottomY barely above the budget top leaves no usable room.
  const boxes = layoutMapLegends([legend('Zoning', 5)], { ...BASE, bottomY: 30 });
  assert.equal(boxes.length, 0);
});

test('later legends are dropped once the budget is spent', () => {
  const many = [legend('A', 12), legend('B', 12), legend('C', 12), legend('D', 12), legend('E', 12)];
  const boxes = layoutMapLegends(many, BASE);
  assert.ok(boxes.length < many.length, 'not everything fits');
  const budgetTop = BASE.bottomY - Math.floor(BASE.height * 0.62);
  for (const b of boxes) assert.ok(b.y >= budgetTop);
});

test('no legends means no boxes', () => {
  assert.deepEqual(layoutMapLegends([], BASE), []);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

// lib/newPlans.js — dating new survey plans by snapshot diff, and the
// feature / colour / popup rules. Run: cd web && node test/newPlans.test.js
import assert from 'node:assert/strict';
import {
  planWindows, newPlanFeature, newPlanPoints, planWindowList, windowColors,
  windowColorExpression, newPlanPopupParts, planHighWater, isLatePlan, LATE_PLAN_COLOR,
  cleanLotBound, filterByLots,
} from '../src/lib/newPlans.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const SNAPS = [
  { date: '2025-03-14', plans: new Set(['100', '200']) },
  { date: '2026-07-01', plans: new Set(['100', '200', '300']) },
];

console.log('newPlans');

test('baseline plans are never new; later snapshots date the rest', () => {
  const w = planWindows({ snapshots: SNAPS, current: new Set(['100', '300', '400']), today: '2026-11-04' });
  assert.deepEqual([...w.keys()].sort(), ['300', '400']);
  assert.deepEqual(w.get('300'), { after: '2025-03-14', by: '2026-07-01' });
  assert.deepEqual(w.get('400'), { after: '2026-07-01', by: '2026-11-04' });
});

test('a previous build keeps its windows and starts the open window', () => {
  const previous = {
    _meta: { generated_at: '2026-08-01' },
    features: [{ properties: { plan: '400', after: '2026-07-01', by: '2026-08-01' } }],
  };
  const w = planWindows({ snapshots: SNAPS, current: new Set(['400', '500']), today: '2026-11-04', previous });
  assert.deepEqual(w.get('400'), { after: '2026-07-01', by: '2026-08-01' });
  assert.deepEqual(w.get('500'), { after: '2026-08-01', by: '2026-11-04' });
});

test('a previous build older than the last snapshot does not widen the window', () => {
  const previous = { _meta: { generated_at: '2026-01-01' }, features: [] };
  const w = planWindows({ snapshots: SNAPS, current: new Set(['600']), today: '2026-11-04', previous });
  assert.deepEqual(w.get('600'), { after: '2026-07-01', by: '2026-11-04' });
});

test('no snapshots → nothing', () => {
  assert.equal(planWindows({ snapshots: [], current: new Set(['1']), today: '2026-11-04' }).size, 0);
});

const LOT = (x, block = '1') => ({
  type: 'Feature',
  properties: { plan: '300', lot: '1', block },
  geometry: { type: 'MultiPolygon', coordinates: [[[[x, 49], [x + 0.001, 49], [x + 0.001, 49.001], [x, 49], [x, 49]]]] },
});

test('feature: lots merged into one MultiPolygon, counts, label at bbox centre', () => {
  const f = newPlanFeature('300', [LOT(-97.0), LOT(-97.002, '2')], { after: 'a', by: 'b' });
  assert.equal(f.geometry.type, 'MultiPolygon');
  assert.equal(f.geometry.coordinates.length, 2);
  assert.equal(f.properties.lots, 2);
  assert.equal(f.properties.blocks, 2);
  assert.equal(f.properties.lon, -97.0005);
  assert.equal(f.properties.lat, 49.0005);
  assert.equal(newPlanFeature('9', [], null), null);
});

test('points, window list and colours (newest darkest)', () => {
  const fc = { features: [
    newPlanFeature('300', [LOT(-97)], { after: '2025-03-14', by: '2026-07-01' }),
    newPlanFeature('400', [LOT(-96)], { after: '2026-07-01', by: '2026-11-04' }),
    newPlanFeature('401', [LOT(-95)], { after: '2026-07-01', by: '2026-11-04' }),
  ] };
  assert.equal(newPlanPoints(fc).features.length, 3);
  const list = planWindowList(fc);
  assert.deepEqual(list.map((w) => [w.after, w.count]), [['2025-03-14', 1], ['2026-07-01', 2]]);
  const colors = windowColors(list);
  assert.equal(colors.get('2026-07-01|2026-11-04'), '#14532d');
  assert.equal(colors.get('2025-03-14|2026-07-01'), '#86efac');
  const three = windowColors([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  assert.equal(new Set(three.values()).size, 3);
  assert.equal(three.get('c'), '#14532d');
  const expr = windowColorExpression(colors);
  assert.equal(expr[0], 'case');
  assert.ok(expr[3].includes('2025-03-14|2026-07-01'));
});

test('high-water mark ignores six-digit oddities; late = below it', () => {
  assert.equal(planHighWater(new Set(['74496', '640891', '700952', '#946031', '12'])), 74496);
  assert.equal(isLatePlan('2669', 74496), true);
  assert.equal(isLatePlan('74496', 74496), false);
  assert.equal(isLatePlan('76505', 74496), false);
  assert.equal(isLatePlan('#9', 74496), false);
});

test('late plans: flagged, left out of the window list, coloured grey', () => {
  const late = newPlanFeature('2669', [LOT(-97)], { after: '2025-03-14', by: '2026-07-01' }, { late: true });
  assert.equal(late.properties.late, 1);
  assert.deepEqual(planWindowList({ features: [late] }), []);
  const expr = windowColorExpression(new Map());
  assert.deepEqual(expr.slice(0, 3), ['case', ['==', ['get', 'late'], 1], LATE_PLAN_COLOR]);
  assert.ok(newPlanPopupParts(late.properties).lines.some((l) => l.includes('added late')));
});

test('simplification drops collinear points but keeps rings closed', () => {
  const ring = [[-97, 49]];
  for (let i = 1; i <= 50; i++) ring.push([-97 + i * 0.00001, 49]);
  ring.push([-97 + 0.0005, 49.0005], [-97, 49]);
  const f = newPlanFeature('1', [{ properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }], null);
  const out = f.geometry.coordinates[0][0];
  assert.ok(out.length < 10, `kept ${out.length}`);
  assert.deepEqual(out[0], out[out.length - 1]);
});

test('lot-count filter: open bounds, inclusive, swapped range', () => {
  const fc = { _meta: { x: 1 }, features: [1, 2, 5, 40, 207].map((n) => ({ properties: { plan: String(n), lots: n } })) };
  const plans = (r) => r.features.map((f) => f.properties.lots);
  assert.deepEqual(plans(filterByLots(fc, '', '')), [1, 2, 5, 40, 207]);
  assert.deepEqual(plans(filterByLots(fc, '2', '')), [2, 5, 40, 207]);
  assert.deepEqual(plans(filterByLots(fc, '', '5')), [1, 2, 5]);
  assert.deepEqual(plans(filterByLots(fc, '2', '2')), [2]);
  assert.deepEqual(plans(filterByLots(fc, '50', '3')), [5, 40]);
  assert.equal(filterByLots(fc, '10', '')._meta.x, 1);
  assert.equal(cleanLotBound('0'), null);
  assert.equal(cleanLotBound('2.5'), null);
  assert.equal(cleanLotBound(' 12 '), 12);
  assert.equal(cleanLotBound('10000'), null);
});

test('popup parts', () => {
  const p = newPlanPopupParts({ plan: '77085', lots: 12, blocks: 2, after: '2026-07-01', by: '2026-11-04' });
  assert.equal(p.heading, 'Plan 77085');
  assert.equal(p.lines[0], '12 lots in 2 blocks');
  assert.equal(p.lines[1], 'First appeared in City data between 2026-07-01 and 2026-11-04');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }

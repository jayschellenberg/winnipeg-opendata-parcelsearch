// Snapshot value history for the Winnipeg report.
// Run: cd web && node test/snapshotValues.test.js
import assert from 'node:assert/strict';
import { parseValue, snapshotRows, neighbourhoodSlug } from '../src/lib/snapshotValues.js';

let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); } };
console.log('snapshot values');

test('both value formats parse', () => {
  assert.equal(parseValue('22,422,000.00'), 22422000);
  assert.equal(parseValue('20363000'), 20363000);
  assert.equal(parseValue(''), null);
  assert.equal(parseValue('n/a'), null);
});

test('rows are oldest first, current last, with % change', () => {
  const rows = snapshotRows({
    '2026-07-01': { total_assessed_value: '21605000' },
    '2023-11-13': { total_assessed_value: '22,422,000.00' },
    '2025-02-26': { total_assessed_value: '20363000' },
  }, { total: 21605000, year: '2027' });
  assert.deepEqual(rows.map((r) => r.date), ['2023-11-13', '2025-02-26', '2026-07-01', 'current']);
  assert.ok(Math.abs(rows[1].pct - (-9.18)) < 0.01);
  assert.equal(rows[3].pct, 0);
  assert.equal(rows[3].label, 'Current (2027 roll)');
});

test('neighbourhood slug matches the shard names', () => {
  assert.equal(neighbourhoodSlug('CIVIC CENTRE'), 'CIVIC-CENTRE');
});

process.exit(failed ? 1 : 0);

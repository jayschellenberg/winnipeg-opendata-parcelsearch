// Census area for the Winnipeg report: neighbourhood, else its cluster.
// Run: cd web && node test/censusArea.test.js
import assert from 'node:assert/strict';
import { censusArea } from '../src/lib/censusArea.js';

let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); } };
console.log('census area');

const regions = [
  { uid: 'WPG_NB:Agassiz', name: 'Agassiz', level: 'WPG_Nbhd' },
  { uid: 'WPG_Cluster:Downtown East', name: 'Downtown East', level: 'WPG_Cluster' },
  { uid: 'WPG_Cluster:Agassiz', name: 'Agassiz', level: 'WPG_Cluster' },
];

test('a neighbourhood with a profile uses it, case-insensitively', () => {
  assert.deepEqual(censusArea(regions, 'AGASSIZ', 'Downtown East'), { uid: 'WPG_NB:Agassiz', level: 'neighbourhood', name: 'Agassiz' });
});

test('a neighbourhood without one falls back to its cluster', () => {
  assert.deepEqual(censusArea(regions, 'Civic Centre', 'Downtown East'), { uid: 'WPG_Cluster:Downtown East', level: 'cluster', name: 'Downtown East' });
});

test('the cluster level is never mistaken for a neighbourhood of the same name', () => {
  assert.equal(censusArea(regions.slice(1), 'Agassiz', null)?.level, undefined);
});

test('nothing matched gives null', () => {
  assert.equal(censusArea(regions, 'Nowhere', 'Nowhere'), null);
  assert.equal(censusArea(null, 'Agassiz', null), null);
});

process.exit(failed ? 1 : 0);

// lib/trafficFlowMap.js — the City's Traffic Flow Map as a Traffic source,
// plus a sanity check of the extracted public/traffic-flow-<year>.geojson.
// Run: cd web && node test/trafficFlowMap.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRAFFIC_FLOW_YEAR, cleanTrafficSource, toTrafficFeatures, flowPopupParts, fetchTrafficFlow,
} from '../src/lib/trafficFlowMap.js';

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('trafficFlowMap');

await test('source dropdown cleans to flow', () => {
  assert.equal(cleanTrafficSource('counts'), 'counts');
  assert.equal(cleanTrafficSource('x'), 'flow');
});

await test('features carry the styled properties; estimated pieces are unlabelled', () => {
  const fc = toTrafficFeatures({
    metadata: { year: 2024 },
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { volume: 24000, exact: 1 } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { volume: 5000, exact: 0 } },
      { type: 'Feature', geometry: null, properties: { volume: 100, exact: 1 } },
    ],
  });
  assert.equal(fc.features.length, 2);
  assert.deepEqual(fc.features[0].properties, { traffic_kind: 'flow', avg_daily_volume: 24000, volume_label: '24,000', exact: 1, latest_year: 2024 });
  assert.equal(fc.features[1].properties.volume_label, '');
});

await test('popup says when a figure is estimated', () => {
  const exact = flowPopupParts({ avg_daily_volume: 24000, exact: 1, latest_year: 2024 });
  assert.equal(exact.heading, '2024 Traffic Flow Map');
  assert.match(exact.lines[0], /^24,000 vehicles per weekday/);
  const est = flowPopupParts({ avg_daily_volume: 5000, exact: 0, latest_year: 2024 });
  assert.match(est.lines[0], /^About 5,000/);
  assert.match(est.lines[1], /estimated from its line width/);
});

await test('fetch maps and memoises; a failure can be retried', async () => {
  let calls = 0;
  const bad = () => { calls++; return Promise.resolve({ ok: false, status: 404 }); };
  await assert.rejects(fetchTrafficFlow(bad, '/x'));
  const good = () => { calls++; return Promise.resolve({ ok: true, json: () => ({ features: [] }) }); };
  const a = await fetchTrafficFlow(good, '/x');
  const b = await fetchTrafficFlow(good, '/x');
  assert.equal(a, b);
  assert.equal(calls, 2);
});

await test('the shipped flow-map file is sane', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, '..', 'public', `traffic-flow-${TRAFFIC_FLOW_YEAR}.geojson`);
  const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(fc.metadata.year, TRAFFIC_FLOW_YEAR);
  assert.ok(fc.features.length > 300, `${fc.features.length} features`);
  const exact = fc.features.filter((f) => f.properties.exact === 1);
  assert.ok(exact.length / fc.features.length > 0.5, 'most lines carry a printed figure');
  for (const f of fc.features) {
    const v = f.properties.volume;
    assert.ok(Number.isInteger(v) && v >= 100 && v <= 150000 && v % 100 === 0, `volume ${v}`);
    const coords = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates;
    for (const [lon, lat] of coords) {
      // Winnipeg and the flow map's surrounding provincial roads.
      assert.ok(lon > -97.45 && lon < -96.85 && lat > 49.65 && lat < 50.1, `coordinate ${lon},${lat}`);
    }
  }
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');

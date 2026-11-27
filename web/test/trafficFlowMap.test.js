// lib/trafficFlowMap.js — the City's Traffic Flow Map as a Traffic source,
// plus a sanity check of the extracted public/traffic-flow-<year>.geojson.
// Run: cd web && node test/trafficFlowMap.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRAFFIC_FLOW_YEARS, TRAFFIC_SOURCES, cleanTrafficSource, sourceYear, toTrafficFeatures,
  flowPopupParts, fetchTrafficFlow, bearingNear, flowValueNear, flowHistory, flowGrowth,
} from '../src/lib/trafficFlowMap.js';

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('trafficFlowMap');

await test('sources: newest flow map by default, earlier years, live counts', () => {
  assert.deepEqual(TRAFFIC_SOURCES, ['flow', 'flow-2023', 'flow-2022', 'flow-2019', 'flow-2018', 'flow-2015', 'flow-2012', 'flow-2009', 'flow-2008', 'counts']);
  assert.equal(cleanTrafficSource('counts'), 'counts');
  assert.equal(cleanTrafficSource('FLOW-2019'), 'flow-2019');
  assert.equal(cleanTrafficSource('flow-2020'), 'flow');
  assert.equal(sourceYear('flow'), 2024);
  assert.equal(sourceYear('flow-2022'), 2022);
  assert.equal(sourceYear('counts'), null);
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

// Two years of one east-west street (at 49.9 N) plus a north-south cross street.
const line = (coords, volume, exact = 1, year = 2024) => ({
  type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
  properties: { avg_daily_volume: volume, exact, latest_year: year },
});
const EW = [[-97.20, 49.9], [-97.10, 49.9]];
const NS = [[-97.15, 49.85], [-97.15, 49.95]];
const Y2024 = { features: [line(EW, 22000), line(NS, 9000)] };
const Y2019 = { features: [line([[-97.20, 49.90015], [-97.10, 49.90015]], 20000, 1, 2019), line(NS, 8000, 1, 2019)] };   // ~17 m north
const Y2022 = { features: [line(EW, 21000, 0, 2022)] };

await test('same street in another year: nearest line running the same way', () => {
  const at = [-97.1503, 49.9];   // on the east-west street, 20 m from the cross street
  const b = bearingNear(Y2024.features[0].geometry, at);
  assert.ok(Math.abs(b) < 1 || Math.abs(Math.abs(b) - 180) < 1, `bearing ${b}`);
  assert.equal(flowValueNear(Y2019, at, b).volume, 20000, 'not the cross street');
  const nearCross = [-97.1501, 49.9];   // 7 m from the cross street, 17 m from 2019's east-west line
  assert.equal(flowValueNear(Y2019, nearCross, b).volume, 20000, 'the bearing keeps it on its own street');
  assert.equal(flowValueNear(Y2019, nearCross, null).volume, 8000, 'without a bearing the nearer cross street wins');
  assert.equal(flowValueNear({ features: [line([[-97.2, 49.91], [-97.1, 49.91]], 1)] }, at, b), null, 'over 30 m away');
});

await test('history and growth use printed figures only', () => {
  const at = [-97.17, 49.9];
  const rows = flowHistory({ 2024: Y2024, 2019: Y2019, 2022: Y2022, 2023: { features: [] } }, at, 0);
  assert.deepEqual(rows, [
    { year: 2019, volume: 20000, exact: true },
    { year: 2022, volume: 21000, exact: false },
    { year: 2023, volume: null, exact: false },
    { year: 2024, volume: 22000, exact: true },
  ]);
  const g = flowGrowth(rows);
  assert.equal(g.from, 2019);
  assert.equal(g.to, 2024);
  assert.ok(Math.abs(g.pct - 10) < 1e-9);
  assert.ok(Math.abs(g.pctPerYear - 1.924) < 0.01, String(g.pctPerYear));
  assert.equal(flowGrowth(rows.slice(1, 3)), null);
  const parts = flowPopupParts({ avg_daily_volume: 22000, exact: 1, latest_year: 2024 }, rows);
  assert.deepEqual(parts.rows.map((r) => r.text), ['20,000', '~21,000', 'not on the map', '22,000']);
  assert.ok(parts.rows[3].current);
  assert.equal(parts.growth, '2019 to 2024: +10.0% (+1.9% a year)');
  assert.match(parts.source, /~ = estimated from line width/);
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
  await assert.rejects(fetchTrafficFlow(2024, bad, '/x'));
  const good = () => { calls++; return Promise.resolve({ ok: true, json: () => ({ features: [] }) }); };
  const a = await fetchTrafficFlow(2024, good, '/x');
  const b = await fetchTrafficFlow(2024, good, '/x');
  assert.equal(a, b);
  assert.equal(calls, 2);
});

for (const year of TRAFFIC_FLOW_YEARS) await test(`the shipped ${year} flow-map file is sane`, () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, '..', 'public', `traffic-flow-${year}.geojson`);
  const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(fc.metadata.year, year);
  assert.ok(fc.features.length > 300, `${fc.features.length} features`);
  const exact = fc.features.filter((f) => f.properties.exact === 1);
  assert.ok(exact.length / fc.features.length > 0.5, 'most lines carry a printed figure');
  for (const f of fc.features) {
    const v = f.properties.volume;
    assert.ok(Number.isInteger(v) && v >= 100 && v <= 150000 && v % 100 === 0, `volume ${v}`);
    const coords = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates;
    for (const [lon, lat] of coords) {
      // Winnipeg and the surrounding provincial roads. Lines that run off the
      // page edge keep their full (real) length, so allow a margin beyond it.
      assert.ok(lon > -97.5 && lon < -96.8 && lat > 49.6 && lat < 50.2, `coordinate ${lon},${lat}`);
    }
  }
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');

// Unit tests for lib/mlsAreas.js and public/mls-areas.geojson — the MLS
// Areas overlay.
//
// SHARED FILE: kept byte-identical between mb-parcelsearch and the Winnipeg
// ParcelSearch app, like the module it tests.
//
// Run: cd web && node test/mlsAreas.test.js

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  MLS_LAYERS, MLS_SOURCE, MLS_LABEL_SOURCE, mlsLabelPoints, addMlsAreaLayers,
  setMlsAreasData, setMlsAreasVisible, fetchMlsAreas, mlsAreaHtml,
} from '../src/lib/mlsAreas.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const FC = JSON.parse(readFileSync(path.join(dir, '..', 'public', 'mls-areas.geojson'), 'utf8'));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

// A recording stand-in for a MapLibre map.
function fakeMap() {
  const sources = new Map(); const layers = new Map(); const order = [];
  return {
    sources, layers, order,
    getSource: (id) => sources.get(id),
    addSource: (id, s) => sources.set(id, { ...s, setData(d) { this.data = d; } }),
    getLayer: (id) => layers.get(id),
    addLayer: (l, before) => { layers.set(l.id, l); order.push([l.id, before]); },
    setLayoutProperty: (id, k, v) => { layers.get(id).layout[k] = v; },
  };
}

await test('the data file: 141 areas, unique codes, each with a board and a label point', () => {
  assert.equal(FC.type, 'FeatureCollection');
  assert.equal(FC.features.length, 141);
  const codes = FC.features.map((f) => f.properties.area);
  assert.equal(new Set(codes).size, codes.length);
  for (const f of FC.features) {
    assert.match(f.geometry.type, /^(Multi)?Polygon$/, f.properties.area);
    assert.ok(f.properties.board, f.properties.area);
    assert.ok(Number.isFinite(f.properties.lx) && Number.isFinite(f.properties.ly), f.properties.area);
  }
  // The three boards' systems.
  const board = (c) => FC.features.find((f) => f.properties.area === c).properties.board;
  assert.equal(board('1A'), 'Winnipeg Regional Real Estate Board');
  assert.equal(board('R26'), 'Winnipeg Regional Real Estate Board');
  assert.equal(board('B07'), 'Brandon Area REALTORS');
  assert.equal(board('P03'), 'Portage la Prairie Real Estate Board');
});

await test('largest areas come first, so nested ones draw on top', () => {
  // B07 sits inside B06 in the source; B06 must precede it.
  const i = (c) => FC.features.findIndex((f) => f.properties.area === c);
  assert.ok(i('B06') < i('B07'));
});

await test('mlsLabelPoints: one point per area at its label spot', () => {
  const pts = mlsLabelPoints(FC);
  assert.equal(pts.features.length, 141);
  const p = pts.features.find((f) => f.properties.area === '1A');
  assert.deepEqual(p.geometry.coordinates, [-97.123884, 49.865499]);
  assert.deepEqual(mlsLabelPoints(null).features, []);
  assert.equal(mlsLabelPoints({ features: [{ properties: { area: 'X' } }] }).features.length, 0);
});

await test('layers start hidden, labels go on top, and visibility/data setters reach all three', () => {
  const m = fakeMap();
  addMlsAreaLayers(m);
  addMlsAreaLayers(m); // idempotent
  assert.deepEqual([...m.layers.keys()], MLS_LAYERS);
  for (const id of MLS_LAYERS) assert.equal(m.layers.get(id).layout.visibility, 'none');
  assert.equal(m.order.at(-1)[0], 'mls-area-label');
  setMlsAreasVisible(m, true);
  for (const id of MLS_LAYERS) assert.equal(m.layers.get(id).layout.visibility, 'visible');
  setMlsAreasData(m, FC);
  assert.equal(m.sources.get(MLS_SOURCE).data, FC);
  assert.equal(m.sources.get(MLS_LABEL_SOURCE).data.features.length, 141);
});

await test('fetchMlsAreas caches a success and retries after a failure', async () => {
  let calls = 0;
  await assert.rejects(fetchMlsAreas(async () => { calls++; return { ok: false, status: 404 }; }), /404/);
  const fc = await fetchMlsAreas(async () => { calls++; return { ok: true, json: async () => FC }; });
  assert.equal(fc, FC);
  await fetchMlsAreas(async () => { throw new Error('should be cached'); });
  assert.equal(calls, 2);
});

await test('mlsAreaHtml names the area and board, escaped', () => {
  const html = mlsAreaHtml({ area: '1A', board: 'Winnipeg Regional Real Estate Board' });
  assert.match(html, /MLS Area 1A/);
  assert.match(html, /Winnipeg Regional Real Estate Board/);
  assert.doesNotMatch(mlsAreaHtml({ area: '<b>', board: '' }), /<b>/);
});

await test('the module, this test and the data match the sister app (skipped when absent)', () => {
  const here = path.resolve(dir, '..');
  const sisters = [
    'D:/Dropbox/ClaudeCode/MBOpenData/mb-parcelsearch/web',
    'D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch/web',
  ].filter((s) => existsSync(path.join(s, 'src', 'lib', 'mlsAreas.js')) && path.resolve(s) !== here);
  if (!sisters.length) { console.log('    (sister checkout absent; skipped)'); return; }
  for (const s of sisters) {
    for (const f of ['src/lib/mlsAreas.js', 'test/mlsAreas.test.js', 'public/mls-areas.geojson']) {
      assert.equal(readFileSync(path.join(here, f), 'utf8'), readFileSync(path.join(s, f), 'utf8'), `${f} differs from ${s}`);
    }
  }
});

console.log(`\n${passed} passed`);

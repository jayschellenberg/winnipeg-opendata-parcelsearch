// /agents.json and /openapi.json are generated from src/lib/agentsIndex.js
// with the wpg-parcel-history pin read out of src/soda.js. If the pin's form
// changes, readPins() must still find it or the build would publish an index
// naming no commit; this test fails first.
//
// Run: cd web && node test/agentsIndex.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPins, buildAgentsIndex, buildOpenApi } from '../src/lib/agentsIndex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const soda = fs.readFileSync(path.join(here, '..', 'src', 'soda.js'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'vercel.json'), 'utf8'));

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('agents index');
const pins = readPins(soda);

test('the wpg-parcel-history pin is found in soda.js', () => {
  assert.match(pins.history ?? '', /^[0-9a-f]{40}$/);
});

test('history URLs name the pinned commit', () => {
  const ix = buildAgentsIndex(pins);
  for (const d of ix.datasets.filter((x) => x.url_template.includes('wpg-parcel-history'))) {
    assert.ok(d.url_template.includes(`@${pins.history}`), `unpinned: ${d.url_template}`);
  }
});

test('every dataset carries the fields an agent needs, ids unique', () => {
  const ix = buildAgentsIndex(pins);
  const ids = new Set();
  for (const d of ix.datasets) {
    for (const k of ['id', 'title', 'url_template', 'key', 'format', 'fields', 'vintage', 'licence']) {
      assert.ok(d[k] && (!Array.isArray(d[k]) || d[k].length), `${d.id ?? '?'} missing ${k}`);
    }
    assert.ok(!ids.has(d.id), `duplicate id ${d.id}`); ids.add(d.id);
  }
});

test('same top-level shape as the Manitoba index', () => {
  const ix = buildAgentsIndex(pins);
  for (const k of ['schema', 'site', 'usage', 'pins', 'keys', 'recipes', 'datasets', 'live_services', 'not_served']) {
    assert.ok(k in ix, `missing ${k}`);
  }
});

test('a missing pin fails loudly', () => {
  assert.throws(() => buildAgentsIndex({ history: null }));
});

test('openapi is 3.1 and every path is a file this site serves', () => {
  const doc = buildOpenApi(pins);
  assert.equal(doc.openapi, '3.1.0');
  for (const p of Object.keys(doc.paths)) {
    if (p === '/agents.json') continue;
    assert.ok(fs.existsSync(path.join(here, '..', 'public', p.slice(1))), `no public file for ${p}`);
  }
});

test('vercel.json lets other origins read the index and the public data files', () => {
  const sources = vercel.headers
    .filter((h) => h.headers.some((x) => x.key === 'Access-Control-Allow-Origin' && x.value === '*'))
    .map((h) => h.source);
  // Vercel sources are path-to-regexp; "/(.*).json" covers /agents.json too.
  const covers = (file) => sources.some((s) => new RegExp(`^${s.replace(/\./g, '\\.')}$`).test(file));
  for (const f of ['/agents.json', '/openapi.json', '/zoning-amendments.json', '/wpg-neighbourhoods.geojson']) {
    assert.ok(covers(f), `no CORS rule covers ${f}`);
  }
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

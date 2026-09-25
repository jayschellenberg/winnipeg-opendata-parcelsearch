// Every overlay button must be connected to its handler.
//
// WHY THIS EXISTS. The Manitoba app's Traffic Counts overlay shipped with
// its button, its map layers, its legend and its data join all correct —
// and no click listener. Nothing failed: the button rendered, styled and
// aria-pressed itself, and did nothing. Unit tests did not catch it because
// each piece was individually right; the missing thing was the WIRE between
// them. So this test checks the wiring itself: every <button id="X-toggle"
// data-layer-set=…> in index.html must be reached by an
// addEventListener('click', …) in main.js — either through the `const $x =
// getElementById('X-toggle')` it is looked up into, or directly.
//
// Not an allowlist: allowlists rot, and the whole point is to catch the
// button nobody remembered.
//
// Run: cd web && node test/overlayWiring.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** Overlay toggle button ids declared in the markup (data-layer-set marks them). */
function buttonIds() {
  return [...html.matchAll(/<button\b[^>]*\bid="([a-z0-9-]+)-toggle"[^>]*\bdata-layer-set="[^"]+"/g)]
    .map((m) => m[1]);
}

/** id → the `const $x` main.js looks it up into. */
function lookupVars() {
  const varOf = new Map();
  for (const m of main.matchAll(
    /const\s+(\$[A-Za-z0-9_]+)\s*=\s*document\.getElementById\(\s*'([a-z0-9-]+)-toggle'\s*\)/g)) {
    varOf.set(m[2], m[1]);
  }
  return varOf;
}

const listensVia = (v) => new RegExp(`\\${v}\\??\\.addEventListener\\(\\s*'click'`).test(main);
const listensDirect = (id) => new RegExp(
  `getElementById\\(\\s*'${id}-toggle'\\s*\\)\\??\\.addEventListener\\(\\s*'click'`).test(main);

console.log('overlay wiring — index.html <-> main.js');

const buttons = buttonIds();
const varOf = lookupVars();

test('the markup declares the overlays we expect', () => {
  // A canary: if this list shrinks unexpectedly the parser above has drifted.
  assert.ok(buttons.length >= 12, `only found ${buttons.length} overlay buttons: ${buttons}`);
  for (const expected of ['zoning', 'traffic', 'historical', 'all-parcels', 'water']) {
    assert.ok(buttons.includes(expected), `markup missing ${expected}-toggle`);
  }
});

test('every overlay button in the markup has a click handler', () => {
  const unwired = buttons.filter((id) => {
    const v = varOf.get(id);
    if (v && listensVia(v)) return false;
    return !listensDirect(id);
  });
  assert.deepEqual(unwired, [],
    `overlay buttons with no click handler: ${unwired.join(', ')}`);
});

test('every overlay handler main.js names is a function that exists', () => {
  // The listener must point at something: `addEventListener('click', toggleFoo)`
  // with no `function toggleFoo` anywhere is a ReferenceError at init.
  const named = [...main.matchAll(/\$[A-Za-z0-9_]+Toggle\??\.addEventListener\(\s*'click',\s*([a-zA-Z_$][\w$]*)\s*\)/g)]
    .map((m) => m[1]);
  const missing = [...new Set(named)].filter((fn) =>
    !new RegExp(`^(async )?function ${fn}\\(`, 'm').test(main));
  assert.deepEqual(missing, [], `handlers referenced but never defined: ${missing.join(', ')}`);
});

test('toggle state the URL restore reaches is declared before applyUrlState runs', () => {
  // applyUrlState() clicks overlay toggles during init. A module-level const
  // a toggle handler reads, declared further down the file, is still in its
  // temporal dead zone at that moment — and in an async handler the throw is
  // a silently rejected promise, so a shared ?sp=1 link just did nothing.
  const initCall = main.search(/^applyUrlState\(decodeState\(/m);
  assert.ok(initCall > 0, 'could not find the init-time applyUrlState() call');
  for (const name of ['policyOverlayState', 'POLICY_OVERLAY_CONFIG']) {
    const decl = main.search(new RegExp(`^const ${name}\\s*=`, 'm'));
    assert.ok(decl >= 0, `could not find const ${name}`);
    assert.ok(decl < initCall, `const ${name} is declared after applyUrlState() runs at init`);
  }
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

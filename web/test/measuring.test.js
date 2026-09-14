// lib/measuring.js — the "a measurement owns the pointer" flag — and the
// map.js contract that every layer click goes through the gate.
//
// Run: cd web && node test/measuring.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEASURING_CLASS, setMeasuring, isMeasuring } from '../src/lib/measuring.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapJs = fs.readFileSync(path.join(here, '..', 'src', 'map.js'), 'utf8');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** A minimal document with a classList, enough for the flag. */
function fakeDocument() {
  const classes = new Set();
  return {
    body: {
      classList: {
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return classes.has(c); },
        contains: (c) => classes.has(c),
      },
    },
    _classes: classes,
  };
}

console.log('measuring');

test('without a document the flag reads false and setting it is a no-op', () => {
  assert.equal(isMeasuring(), false);
  setMeasuring(true);
  assert.equal(isMeasuring(), false);
});

test('the flag round-trips through the body class', () => {
  globalThis.document = fakeDocument();
  try {
    assert.equal(isMeasuring(), false);
    setMeasuring(true);
    assert.equal(isMeasuring(), true);
    assert.ok(document._classes.has(MEASURING_CLASS));
    setMeasuring(false);
    assert.equal(isMeasuring(), false);
    setMeasuring('yes');   // truthiness, like the panel's open state
    assert.equal(isMeasuring(), true);
  } finally {
    delete globalThis.document;
  }
});

test('map.js registers every layer click through onLayerClick, never map.on directly', () => {
  // Code lines only — the doc comment above onLayerClick names the call too.
  const direct = [...mapJs.matchAll(/^\s*map\.on\(\s*'click'\s*,\s*['a-zA-Z]/gm)];
  // The one allowed direct registration is inside onLayerClick itself.
  assert.equal(direct.length, 1,
    `layer click handlers bypassing the tool gate: ${direct.length - 1}`);
  assert.ok(/^function onLayerClick\(map, layerId, handler\)/m.test(mapJs));
  assert.ok((mapJs.match(/onLayerClick\(map,/g) || []).length >= 15, 'the popups go through the gate');
});

test('the gate defers to both tools, and the handlers no longer ask the shape tool themselves', () => {
  const gate = mapJs.slice(mapJs.indexOf('function clickOwnedByTool'), mapJs.indexOf('function onLayerClick'));
  assert.match(gate, /isMeasuring\(\)/);
  assert.match(gate, /shapeClickHandled\(map, e\)/);
  // A second shapeClickHandled call inside a handler would toggle a
  // committed shape's Include/Exclude twice on one click.
  const inHandlers = (mapJs.match(/shapeClickHandled\(map, e\)/g) || []).length;
  assert.equal(inHandlers, 1, 'shapeClickHandled must be called only from the gate');
});

test('MeasureControl stamps the flag on open and clears it on close', () => {
  const ctl = mapJs.slice(mapJs.indexOf('class MeasureControl'));
  const open = ctl.indexOf('setMeasuring(true)');
  const close = ctl.indexOf('setMeasuring(false)');
  assert.ok(open >= 0 && close >= 0, 'both ends of the panel lifecycle set the flag');
  assert.ok(ctl.slice(0, close).includes('_close() {'), 'the false call sits in _close()');
});

test('the hover handlers stand down while measuring', () => {
  assert.ok((mapJs.match(/isShapeDrawing\(\) \|\| isMeasuring\(\)/g) || []).length >= 2);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

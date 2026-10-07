// The Capture Map capture must wait for the map on a CLOCK.
//
// WHY THIS EXISTS. generateStaticMap() waits for MapLibre's 'idle' before
// reading the WebGL canvas, and 'idle' only fires once EVERY source has
// finished loading. One overlay tile that never resolves — a stalled
// PMTiles range request, an ArcGIS layer retrying, a source that errored —
// means 'idle' never fires at all. The original wait was a bare
//
//     await new Promise((resolve) => { map.on('idle', onIdle); … });
//
// with no timeout, so that case hung the button on "Capturing…" forever
// with captureInFlight stuck true — dead until a page reload, because the
// finally that restores both buttons is downstream of the await. "Map
// w/Legend" is the button that surfaced it: it is only ENABLED when an
// overlay is on, which is exactly when there is an extra source that can
// fail to settle.
//
// lib/snapshotCapture.js already solved this for the bulk snapshot export —
// waitForMapIdle() bounds the wait and stops its clock while the page is
// hidden, so a backgrounded tab (where rAF is throttled and MapLibre cannot
// render, let alone go idle) doesn't manufacture a timeout. This file exists
// because that helper being correct and tested proves nothing about whether
// the capture path actually calls it. Same failure mode as
// overlayWiring.test.js and muniNumberWiring.test.js: every piece
// individually right, the wire between them missing.
//
// Checks, against comment-stripped source:
//   1. waitForMapIdle is imported from lib/snapshotCapture.js;
//   2. generateStaticMap's own body calls it, with an explicit timeout
//      rather than leaning on the helper's export-oriented default;
//   3. no unbounded `new Promise` + `map.on('idle')` wait survives anywhere
//      in main.js;
//   4. a timeout is survivable — the capture still runs its finally, so
//      captureInFlight clears and the buttons come back.
//
// Run: cd web && node test/staticMapIdle.test.js
//      node test/staticMapIdle.test.js <path-to-main.js>   (to check an
//      older copy of the file — used to prove these assertions fail on the
//      unbounded version)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainPath = process.argv[2] || path.join(here, '..', 'src', 'main.js');
const raw = fs.readFileSync(mainPath, 'utf8');

/** Strip comments so the prose above a call — this file's subject matter is
 *  heavily commented, and the fix's own comment quotes the broken code
 *  verbatim — cannot satisfy or trip any assertion below. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(^|[^:])\/\/[^\r\n]*$/gm, '$1');
}
const main = stripComments(raw);

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** The body of a top-level `async function <name>(` … `)`, by brace match.
 *  The parameter list is skipped by paren-matching first: generateStaticMap
 *  destructures its argument (`{ withLegend = false } = {}`), so the first
 *  `{` after the name belongs to the parameters, not the body. */
function functionBody(src, name) {
  const re = new RegExp(`\\b(?:async\\s+)?function ${name}\\s*\\(`);
  const m = re.exec(src);
  assert.ok(m, `${name}() not found in ${path.basename(mainPath)}`);
  let parens = 0;
  let afterParams = -1;
  for (let i = src.indexOf('(', m.index); i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') {
      parens--;
      if (parens === 0) { afterParams = i; break; }
    }
  }
  assert.ok(afterParams > 0, `${name}() has an unbalanced parameter list`);
  const open = src.indexOf('{', afterParams);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`${name}() has no closing brace`);
}

console.log('static map capture cannot hang forever');

test('waitForMapIdle is imported from the snapshot-capture lib', () => {
  assert.match(
    main,
    /import\s*\{[^}]*\bwaitForMapIdle\b[^}]*\}\s*from\s*['"]\.\/lib\/snapshotCapture\.js['"]/,
    'main.js never imports waitForMapIdle — the capture is waiting on a '
    + 'hand-rolled idle listener instead of the bounded helper',
  );
});

test('generateStaticMap actually calls it', () => {
  const body = functionBody(main, 'generateStaticMap');
  assert.match(
    body,
    /\bwaitForMapIdle\s*\(/,
    'generateStaticMap() does not call waitForMapIdle — importing it is not '
    + 'enough, the capture path has to be the thing that uses it',
  );
});

test('the wait is bounded by an explicit timeout, not the helper default', () => {
  const body = functionBody(main, 'generateStaticMap');
  const call = /\bwaitForMapIdle\s*\(([^)]*)\)/.exec(body);
  assert.ok(call, 'no waitForMapIdle call to inspect');
  const args = call[1].split(',').map((a) => a.trim()).filter(Boolean);
  assert.ok(
    args.length >= 2,
    `waitForMapIdle(${call[1].trim()}) passes no timeout — the export's 9 s `
    + 'default is tuned for an unattended batch, not for a button someone is '
    + 'watching',
  );
  assert.match(
    args[1],
    /^(STATIC_MAP_IDLE_TIMEOUT_MS|\d+)$/,
    `waitForMapIdle timeout argument "${args[1]}" is not a plain constant`,
  );
  if (args[1] === 'STATIC_MAP_IDLE_TIMEOUT_MS') {
    const decl = /const STATIC_MAP_IDLE_TIMEOUT_MS\s*=\s*(\d+)/.exec(main);
    assert.ok(decl, 'STATIC_MAP_IDLE_TIMEOUT_MS is used but never declared');
    const ms = Number(decl[1]);
    assert.ok(ms > 0 && ms <= 15000,
      `STATIC_MAP_IDLE_TIMEOUT_MS is ${ms} ms — outside a sane 0–15 s bound`);
  }
});

test('no unbounded idle wait survives anywhere in main.js', () => {
  // A `new Promise` whose body registers an 'idle' listener and nothing
  // else: that is the shape that hangs, wherever it appears.
  const re = /new Promise\s*\(([\s\S]{0,400}?)\}\s*\)/g;
  for (const m of main.matchAll(re)) {
    const body = m[1];
    if (!/\.on\(\s*['"]idle['"]/.test(body)) continue;
    assert.fail(
      'an unbounded new Promise + map.on(\'idle\') wait is still in main.js — '
      + '\'idle\' never fires while any source is stuck loading, so this hangs '
      + `the capture: ${body.replace(/\s+/g, ' ').slice(0, 140)}`,
    );
  }
});

test('a timeout is survivable: the capture still clears its in-flight flag', () => {
  const body = functionBody(main, 'generateStaticMap');
  assert.match(body, /\bfinally\s*\{/,
    'generateStaticMap() has no finally block — a throw from the wait would '
    + 'leave captureInFlight true and both buttons disabled for good');
  const fin = body.slice(body.indexOf('finally'));
  assert.match(fin, /captureInFlight\s*=\s*false/,
    'the finally block does not clear captureInFlight');
  assert.match(fin, /\bdisabled\s*=/,
    'the finally block does not restore the buttons\' disabled state');
});

// --- Capture Map panel + Alt+C (2026-10-07) ---------------------------------
// The capture redraws the map at a higher pixel ratio to hit a fixed
// 1950 x 1050 image. Leaving that ratio raised would make the live map
// render at export resolution for the rest of the session, so the restore
// must be in the finally, not after the await. And the panel / shortcut are
// exactly the "written but never called" shape this file guards against.

console.log('capture map panel is wired');

test('the raised pixel ratio is restored in the finally', () => {
  const body = functionBody(main, 'generateStaticMap');
  assert.match(body, /setPixelRatio\(\s*Math\.max\(/,
    'generateStaticMap() no longer raises the pixel ratio for the export');
  const fin = body.slice(body.indexOf('finally'));
  assert.match(fin, /setPixelRatio\(\s*prevRatio\s*\)/,
    'the finally block does not put the pixel ratio back');
});

test('the capture button opens the Copy / Download panel', () => {
  assert.match(main,
    /\$staticMapBtn\.addEventListener\(\s*'click'[\s\S]{0,120}generateStaticMap\(\)\.then\(\s*openCapturePanel\s*\)/,
    'the Capture Map button does not feed generateStaticMap() into openCapturePanel');
  assert.match(main, /^\s*wireCapturePanel\(\);/m,
    'wireCapturePanel() is never called — Copy / Download would do nothing');
  assert.match(fnBodyOf('openCapturePanel'), /\.showModal\(\)/,
    'openCapturePanel() never shows the dialog');
});

test('Alt+C reaches copyMapToClipboard', () => {
  assert.match(main,
    /e\.altKey[^\n]*e\.code === 'KeyC'[\s\S]{0,200}copyMapToClipboard\(\)/,
    'no Alt+C keydown branch calls copyMapToClipboard()');
  assert.match(fnBodyOf('copyMapToClipboard'), /new ClipboardItem\(/,
    'copyMapToClipboard() never writes to the clipboard');
});

test('the legend box is driven by the legend observer', () => {
  assert.match(fnBodyOf('updateLegendAvailability'), /\$captureLegend\.disabled\s*=/,
    'updateLegendAvailability() no longer enables/disables the Include legend box');
});

// Winnipeg only: a Property Search turns All Assessment Parcels on.
test('runSearch turns All Assessment Parcels on when it finds something', () => {
  const body = fnBodyOf('runSearch');
  // In the finally, so a late throw (the legal join) after the parcels are
  // on the grid still turns the fabric on; the function checks for results.
  const fin = body.slice(body.lastIndexOf('finally'));
  assert.match(fin, /autoEnableCitywideParcels\(\)/,
    'runSearch() no longer calls autoEnableCitywideParcels() from its finally');
  const auto = fnBodyOf('autoEnableCitywideParcels');
  assert.match(auto, /getActiveTab\(\)\s*!==\s*'property'/,
    'the auto-on is no longer limited to the Property Search tab');
  assert.match(auto, /toggleCitywideParcels\(\)/,
    'the auto-on bypasses the layer\'s own toggle (its button state would lie)');
});

function fnBodyOf(name) { return functionBody(main, name); }

const failed = results.filter((r) => r === 0).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);

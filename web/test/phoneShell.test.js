// The phone shell must be WIRED, not merely present.
//
// WHY THIS EXISTS. Code that exists and is never called is the recurring
// bug in both parcel-search apps (see overlayWiring.test.js). The phone
// shell has five parts that only work together: the markup hooks in
// index.html, lib/phoneMode.js, lib/sheetDrag.js, the one call from
// main.js, and the body.phone rules in style.css. Any one of them can
// ship alone and nothing fails — the desktop layout is untouched and a
// phone just keeps getting the old stacked page. So this test reads all
// of them and asserts they name the same ids, the same class names and
// the same breakpoint.
//
// Comments are stripped before matching so a commented-out call or a
// selector that survives only in prose cannot satisfy a check.
//
// Ported from the Manitoba sister app; the two are meant to stay in
// step. Run: cd web && node test/phoneShell.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');

const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

const main = stripJs(read('src', 'main.js'));
const mode = stripJs(read('src', 'lib', 'phoneMode.js'));
const drag = stripJs(read('src', 'lib', 'sheetDrag.js'));
const css = stripCss(read('src', 'style.css'));
const html = stripHtml(read('index.html'));

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('phoneShell');

test('main.js imports initPhoneMode from lib/phoneMode.js and calls it', () => {
  assert.match(main, /import\s*\{[^}]*\binitPhoneMode\b[^}]*\}\s*from\s*'\.\/lib\/phoneMode\.js'/,
    'no initPhoneMode import from ./lib/phoneMode.js');
  assert.match(main, /^\s*initPhoneMode\(/m, 'initPhoneMode is imported but never called');
});

test('the mode change resizes the map (the container changes size)', () => {
  const call = main.match(/initPhoneMode\(([\s\S]*?)\);/);
  assert.ok(call, 'initPhoneMode call not found');
  assert.match(call[1], /map\.resize\(\)/, 'initPhoneMode onChange does not call map.resize()');
});

test('a fresh result set brings a peeked sheet back up', () => {
  assert.match(main, /import\s*\{[^}]*\bensureSheetVisible\b[^}]*\}\s*from\s*'\.\/lib\/phoneMode\.js'/,
    'ensureSheetVisible not imported');
  const fn = main.slice(main.indexOf('function renderTable('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /ensureSheetVisible\(\)/, 'renderTable never calls ensureSheetVisible()');
  // Re-renders pass fullRows back in; only a fresh array may lift the
  // sheet, or a sort or numbering toggle would yank a peeked sheet up.
  assert.match(body, /rows !== fullRows/, 'renderTable lifts the sheet without checking for a new row set');
});

test('index.html carries every hook phoneMode.js looks up by id', () => {
  for (const id of ['topbar-menu-btn', 'topbar-nav', 'sheet-handle', 'phone-results-slot', 'results-wrap', 'workspace']) {
    assert.ok(html.includes(`id="${id}"`), `index.html has no id="${id}"`);
    assert.ok(mode.includes(`'${id}'`), `phoneMode.js never looks up '${id}'`);
  }
});

test('the menu button controls the nav it toggles', () => {
  const btn = html.match(/<button[^>]*id="topbar-menu-btn"[^>]*>/);
  assert.ok(btn, 'menu button not found');
  assert.match(btn[0], /aria-controls="topbar-nav"/, 'menu button does not aria-control topbar-nav');
  assert.match(btn[0], /aria-expanded="false"/, 'menu button has no aria-expanded');
});

test('the results slot and the handle sit inside the sidebar, not the workspace', () => {
  const aside = html.search(/<aside class="(sidebar controls|controls sidebar)"/);
  const asideEnd = html.indexOf('</aside>', aside);
  const slot = html.indexOf('id="phone-results-slot"');
  assert.ok(aside >= 0 && asideEnd > aside, 'sidebar aside not found');
  assert.ok(slot > aside && slot < asideEnd, 'phone-results-slot is not inside the sidebar');
  const handle = html.indexOf('id="sheet-handle"');
  assert.ok(handle > aside && handle < asideEnd, 'sheet-handle is not inside the sidebar');
  const resultsWrap = html.indexOf('id="results-wrap"');
  assert.ok(resultsWrap > asideEnd, 'results-wrap must start life in the workspace, not the sidebar');
});

test('phoneMode.js toggles body.phone and the CSS keys on it', () => {
  assert.match(mode, /classList\.toggle\(\s*'phone'/, "phoneMode.js never toggles the 'phone' body class");
  for (const sel of [
    'body.phone .topbar',
    'body.phone .topbar.menu-open .topbar-nav',
    'body.phone .topbar-menu-btn',
    'body.phone .workspace',
    'body.phone #map',
    'body.phone .sidebar',
    'body.phone .sheet-handle',
    'body.phone .phone-results-slot .table-pane',
    'body.phone .map-address-search',
  ]) {
    assert.ok(css.includes(sel), `style.css has no rule for "${sel}"`);
  }
});

test('every sheet state phoneMode.js can set has a CSS rule', () => {
  const arr = mode.match(/SHEET_STATES\s*=\s*\[([^\]]*)\]/);
  assert.ok(arr, 'SHEET_STATES not found');
  const states = [...arr[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(states.length >= 3, 'fewer than three sheet states');
  for (const s of states) {
    // "half" is the base .sidebar rule; the others must override it.
    if (s === 'half') continue;
    assert.ok(css.includes(`body.phone .sidebar.sheet-${s}`), `no CSS for sheet state "${s}"`);
  }
});

test('the drag gesture is wired, not just written', () => {
  assert.match(mode, /import\s*\{[^}]*\binitSheetDrag\b[^}]*\}\s*from\s*'\.\/sheetDrag\.js'/,
    'phoneMode.js does not import initSheetDrag');
  const call = mode.match(/initSheetDrag\(\{([\s\S]*?)\}\)/);
  assert.ok(call, 'phoneMode.js never calls initSheetDrag');
  assert.match(call[1], /measure:\s*measureSnapHeights/, 'drag has no measure()');
  assert.match(call[1], /onSnap:\s*setSheetState/, 'drag has no onSnap()');
  assert.match(call[1], /grabbers:\s*\[handle,\s*tabs\]/, 'drag grabbers are not the handle and tab strip');
  for (const cls of ['sheet-dragging', 'sheet-settling']) {
    assert.ok(drag.includes(`'${cls}'`), `sheetDrag.js never toggles ${cls}`);
    assert.ok(css.includes(`body.phone .sidebar.${cls}`), `style.css has no rule for .${cls}`);
  }
  const touch = css.match(/body\.phone \.sheet-handle,\s*body\.phone \.sidebar-tabs \{[^}]*touch-action: none/);
  assert.ok(touch, 'handle and tab strip lack touch-action: none');
  const rule = css.match(/body\.phone \.sidebar\.sheet-dragging \{([^}]*)\}/);
  assert.match(rule[1], /transition: none/, 'sheet-dragging must switch transitions off');
  assert.match(mode, /classList\.add\('sheet-dragging'\)[\s\S]*offsetHeight/,
    'measureSnapHeights must measure under sheet-dragging');
});

test('the JS breakpoint and the desktop split breakpoint agree', () => {
  const q = mode.match(/PHONE_QUERY\s*=\s*'\(max-width:\s*(\d+)px\)'/);
  assert.ok(q, 'PHONE_QUERY not found');
  const phoneMax = Number(q[1]);
  // The sidebar/workspace row split turns on at min-width: N px — the
  // phone mode must end exactly one pixel below it.
  const split = css.match(/@media \(min-width: (\d+)px\) \{\s*\.app-shell \{\s*flex-direction: row/);
  assert.ok(split, 'desktop split breakpoint not found');
  assert.equal(phoneMax, Number(split[1]) - 1,
    `phone ends at ${phoneMax}px but the desktop split starts at ${split[1]}px`);
});

test('the Manitoba and Winnipeg phone modules have not drifted', () => {
  // Both apps ship the same two modules; a fix in one belongs in the
  // other. Skipped (not failed) when the sister checkout is absent, as
  // it is in CI.
  const sister = 'D:/Dropbox/ClaudeCode/MBOpenData/mb-parcelsearch/web/src/lib/';
  if (!fs.existsSync(sister + 'phoneMode.js')) { console.log('    (sister checkout absent; skipped)'); return; }
  for (const f of ['phoneMode.js', 'sheetDrag.js']) {
    assert.equal(read('src', 'lib', f), fs.readFileSync(sister + f, 'utf8'),
      `${f} differs from the Manitoba copy`);
  }
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);

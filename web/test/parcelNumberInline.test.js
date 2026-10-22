// The numbered badges go INSIDE a parcel that is big enough on screen,
// just above its label and with no leader (Jason, 2026-10-22: the
// callouts sat on the roll numbers in printed maps); small parcels keep
// their callouts.
//
// lib/calloutPlacement.js is unit-tested on its own, which proves nothing
// about whether map.js wires it in — the recurring bug in these apps is a
// helper that is right and never called. Checks, against comment-stripped
// map.js:
//   1. repositionParcelNumbers offers each badge an inline spot
//      (inlineOffset), lifts a callout's dot off the label, draws
//      INLINE_SLOT badges with no leader, and rebuilds the anchor dots
//      each pass so an inline badge has none;
//   2. the lift is sized from the parcel label and kept inside the parcel;
//   3. turning All Assessment Parcels on or off re-places the badges.
//
// Run: cd web && node test/parcelNumberInline.test.js [path-to-map.js]

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAP = process.argv[2] || path.join(here, '..', 'src', 'map.js');

/** Remove // and /* *\/ comments without touching string contents. */
function stripComments(s) {
  let out = '', i = 0, inS = null;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (inS) {
      if (c === '\\') { out += c + (s[i + 1] ?? ''); i += 2; continue; }
      if (c === inS) inS = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { inS = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

const src = stripComments(readFileSync(MAP, 'utf8'));

/** The body of `function name(` up to its matching close brace. */
function fnBodyOf(name) {
  const m = new RegExp(`function ${name}\\s*\\(`).exec(src);
  assert.ok(m, `${name} is gone from map.js`);
  let i = src.indexOf('{', src.indexOf(')', m.index));
  const start = i;
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced body for ${name}`);
}

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

test('repositionParcelNumbers offers inline spots and draws them without a leader', () => {
  const body = fnBodyOf('repositionParcelNumbers');
  assert.match(body, /inlineOffset\(a, pt, view,/, 'no badge is ever offered an inline spot');
  assert.match(body, /else item\.y \+= calloutDotLift\(a, pt, view,/, 'a callout dot is never lifted off the label');
  assert.match(body, /=== INLINE_SLOT/, 'INLINE_SLOT badges are drawn like callouts');
  assert.match(body, /if \(!isInline\) \{[\s\S]*leaders\.push[\s\S]*dots\.push/, 'inline badges still get a leader or dot');
  assert.match(body, /anchorSrc\.setData\(\{ type: 'FeatureCollection', features: dots \}\)/,
    'the anchor dots are not rebuilt per pass, so inline badges keep a dot');
});

test('the badge and the callout dot sit above the parcel label, inside the parcel', () => {
  assert.match(fnBodyOf('inlineOffset'), /aboveParcelLabel\(a, zoom, a\.radius\)[\s\S]*discFitsParcel\(/,
    'the inline badge is not lifted above the label, or not tested against the parcel');
  assert.match(fnBodyOf('calloutDotLift'), /aboveParcelLabel\(a, zoom, ANCHOR_DOT_PX\)[\s\S]*discFitsParcel\(/,
    'the callout dot lift is not sized from the label, or not kept inside the parcel');
  assert.match(fnBodyOf('discFitsParcel'), /inlineBadgeFits\(/, 'the disc is never tested against the parcel');
  assert.match(fnBodyOf('parcelLabelsShown'), /'citywide-parcels-label'/, 'label visibility is read from the wrong layer');
});

test('All Assessment Parcels on/off re-places the badges', () => {
  assert.match(fnBodyOf('setCitywideParcelsVisible'), /repositionParcelNumbers\(map\)/,
    'toggling the parcel labels leaves the badges where they were');
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);

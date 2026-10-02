// Unit tests for lib/locationMap.js — georeferencing of the Manitoba and
// Winnipeg base maps, the downtown-inset rule, and callout placement.
//
// SHARED FILE: kept byte-identical between mb-parcelsearch and the Winnipeg
// ParcelSearch app, like the modules it tests. Checks that need an SVG the
// app does not ship are skipped there.
//
// Run: cd web && node test/locationMap.test.js

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  BASE_MAPS, DIRECTIONS, PIN,
  locateOnMap, placeCallout, placeTwinCallout, estimateTextWidth,
  pinBox, pinOutline, arrowTipAtPin,
} from '../src/lib/locationMap.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const MB = BASE_MAPS.manitoba;
const WPG = BASE_MAPS.winnipeg;
const near = (a, b, tol, msg) => assert.ok(
  Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol,
  `${msg}: got [${a.map((v) => v.toFixed(2))}], want [${b}] ±${tol}`,
);
const w = estimateTextWidth('SUBJECT') + 16;
const inside = (b, map) => b[0] >= 0 && b[1] >= 0 && b[2] <= map.width && b[3] <= map.height;
const covers = (b, p) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const coveredBy = (box, map) => map.obstacles.reduce((s, o) => s + overlap(box, o), 0);

// ---- Manitoba -------------------------------------------------------------

// The graticule vertices drawn on the page (49th- and 60th-parallel
// borders) — the fit's own control points, reproduced essentially exactly.
for (const [x, y, lat, lng] of [
  [24.69, 464.8, 49, -101], [107.61, 466.35, 49, -98], [162.89, 465.21, 49, -96],
  [23.32, 9.18, 60, -102], [105.25, 11.36, 60, -98], [166.7, 9.61, 60, -95],
]) near(MB.project(lng, lat), [x, y], 0.05, `graticule ${lat},${lng}`);

// Town dots — independent of the fit and nudged by the cartographer.
for (const [name, lng, lat, x, y] of [
  ['Steinbach', -96.68389, 49.52583, 143.8, 443.0],
  ['Brandon', -99.95222, 49.84694, 55.4, 430.1],
  ['Thompson', -97.85528, 55.74333, 109.2, 186.3],
  ['Morden', -98.10056, 49.19194, 105.1, 458.4],
]) near(MB.project(lng, lat), [x, y], 2.5, name);

assert.ok(locateOnMap(MB, -97.1, 49.9), 'Winnipeg is on the Manitoba map');
assert.equal(locateOnMap(MB, -104.6, 50.4), null, 'Regina is not');
assert.equal(locateOnMap(MB, -97.1, 49.9).inset, null, 'the Manitoba map has no inset');

for (const [lng, lat] of [[-96.684, 49.526], [-101.86, 54.77], [-94.19, 58.78], [-95.2, 49.0], [-102, 60]]) {
  const p = MB.project(lng, lat);
  const r = placeCallout(p, w, { map: MB });
  assert.ok(r, `placed at ${lng},${lat}`);
  assert.ok(inside(r.box, MB), `box on page at ${lng},${lat}`);
  assert.ok(!covers(r.box, p), `box clear of the subject at ${lng},${lat}`);
}
const steinbach = placeCallout(MB.project(-96.684, 49.526), w, { map: MB });
assert.ok(coveredBy(steinbach.box, MB) < 1, 'Steinbach callout clear of labels');

// A forced side is honoured when it fits...
const mid = MB.project(-95.5, 54.0);  // mid-page, room on every side
for (const [key, angle] of Object.entries(DIRECTIONS)) {
  const r = placeCallout(mid, w, { map: MB, direction: key });
  const cx = (r.box[0] + r.box[2]) / 2 - mid[0];
  const cy = (r.box[1] + r.box[3]) / 2 - mid[1];
  const got = Math.atan2(cy, cx) * 180 / Math.PI;
  const diff = Math.abs(((got - angle + 540) % 360) - 180);
  assert.ok(diff < 50, `direction ${key}: box at ${got.toFixed(0)}°, want ~${angle}°`);
}
// ...and falls back to auto instead of leaving the page when it can't.
assert.ok(inside(placeCallout(MB.project(-101.9, 59.9), w, { map: MB, direction: 'nw' }).box, MB),
  'forced off-page side falls back');

// ---- Winnipeg -------------------------------------------------------------

// Inset: street intersections (OpenStreetMap) against the crossings drawn
// in the inset — the fit's control points, residual ~0.3 pt.
for (const [name, lng, lat, x, y] of [
  ['Graham & Fort', -97.138738, 49.893011, 440.92, 417.71],
  ['Smith & York', -97.139759, 49.889482, 437.48, 438.32],
  ['Hargrave & Ellice', -97.14556, 49.894759, 414.64, 407.31],
]) near(WPG.inset.project(lng, lat), [x, y], 0.8, name);

// Main map: Portage & Main sits inside the pink downtown circle, and the
// downtown subjects get both points; St. Vital and the airport get one.
const [pcx, pcy, pr] = WPG.inset.source;
const pm = locateOnMap(WPG, -97.1384, 49.8954);
assert.ok(Math.hypot(pm.main[0] - pcx, pm.main[1] - pcy) < pr, 'Portage & Main inside the pink circle');
assert.ok(pm.inset, 'Portage & Main is in the inset');
assert.equal(locateOnMap(WPG, -97.1083, 49.8236).inset, null, 'St. Vital Centre is not in the inset');
assert.equal(locateOnMap(WPG, -97.2266, 49.9045).inset, null, 'the airport is not in the inset');
assert.equal(locateOnMap(WPG, -96.684, 49.526), null, 'Steinbach is off the Winnipeg map');

// Downtown: one box, two arrows, the box on neither circle.
for (const [name, lng, lat] of [['Portage & Main', -97.1384, 49.8954], ['Legislature', -97.146, 49.8847], ['The Forks', -97.131, 49.8873]]) {
  const at = locateOnMap(WPG, lng, lat);
  const r = placeTwinCallout(at.main, at.inset, w, { map: WPG });
  assert.ok(r, `${name}: twin callout placed`);
  assert.equal(r.tails.length, 2, `${name}: two arrows`);
  assert.ok(inside(r.box, WPG), `${name}: box on page`);
  for (const c of [WPG.inset.source, WPG.inset.circle]) {
    const box = [c[0] - c[2], c[1] - c[2], c[0] + c[2], c[1] + c[2]];
    assert.equal(overlap(r.box, box), 0, `${name}: box clear of the circles`);
  }
}
// Elsewhere in the city: one arrow, on the page, off the inset.
for (const [lng, lat] of [[-97.1083, 49.8236], [-97.2266, 49.9045], [-97.0, 49.89]]) {
  const at = locateOnMap(WPG, lng, lat);
  const r = placeCallout(at.main, w, { map: WPG });
  assert.ok(r && inside(r.box, WPG) && !covers(r.box, at.main), `single callout at ${lng},${lat}`);
}

// ---- Map pin ----------------------------------------------------------------

const segDist = (p, a, b) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
// The outline's tip is the subject point and its top is the pin height above.
{
  const p = [200, 200];
  const pts = pinOutline(p);
  assert.deepEqual(pts[0], p, 'pin tip on the subject');
  const top = Math.min(...pts.map((q) => q[1]));
  assert.ok(Math.abs(top - (p[1] - PIN.height)) < 0.05, 'pin top at its height');
  // An arrow from any side stops just outside the pin, never on the point.
  for (let a = 0; a < 360; a += 15) {
    const tail = [p[0] + 60 * Math.cos(a * Math.PI / 180), p[1] - 10 + 60 * Math.sin(a * Math.PI / 180)];
    const tip = arrowTipAtPin(tail, p);
    const d = Math.min(...pts.map((q, i) => segDist(tip, q, pts[(i + 1) % pts.length])));
    assert.ok(d > 0.2 && d <= PIN.gap + 0.05, `arrow at ${a}° ends ${d.toFixed(2)} from the pin outline`);
    assert.ok(Math.hypot(tip[0] - tail[0], tip[1] - tail[1]) < Math.hypot(p[0] - tail[0], p[1] - 10 - tail[1]) + 1,
      `arrow at ${a}° does not overshoot`);
  }
}
// Callout boxes never sit on the pin, on either map or in the inset.
for (const [map, lng, lat] of [[MB, -96.684, 49.526], [WPG, -97.1083, 49.8236], [WPG, -97.2266, 49.9045]]) {
  const at = locateOnMap(map, lng, lat);
  for (const dir of ['auto', ...Object.keys(DIRECTIONS)]) {
    const r = placeCallout(at.main, w, { map, direction: dir });
    assert.equal(overlap(r.box, pinBox(at.main)), 0, `${map.id} ${dir}: box clear of the pin`);
  }
}
{
  const at = locateOnMap(WPG, -97.1384, 49.8954);
  const r = placeTwinCallout(at.main, at.inset, w, { map: WPG });
  assert.equal(overlap(r.box, pinBox(at.main)) + overlap(r.box, pinBox(at.inset)), 0, 'twin box clear of both pins');
}

// ---- Assets and wiring ----------------------------------------------------

for (const map of [MB, WPG]) {
  const file = path.join(dir, '../public', map.svgUrl);
  if (!existsSync(file)) continue;   // this app does not ship that map
  const vb = readFileSync(file, 'utf8').slice(0, 600).match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  assert.ok(vb, `${map.svgUrl} has a viewBox`);
  assert.ok(Math.abs(Number(vb[1]) - map.width) < 0.01 && Math.abs(Number(vb[2]) - map.height) < 0.01,
    `${map.svgUrl} viewBox matches the page constants`);
  // Every namespace prefix in use must be declared, or the browser refuses
  // the whole file as an image ("could not load") — stripping
  // xmlns:inkscape while its layer attributes stayed did exactly that.
  const svgText = readFileSync(file, 'utf8');
  for (const prefix of new Set([...svgText.matchAll(/\s([a-z]+):[a-z]+=/gi)].map((m) => m[1]))) {
    assert.ok(prefix === 'xmlns' || svgText.includes(`xmlns:${prefix}=`), `${map.svgUrl} uses undeclared prefix ${prefix}:`);
  }
}

const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const html = readFileSync(path.join(dir, '../index.html'), 'utf8');
assert.ok(html.includes('id="location-map-btn"'), 'button in index.html');
assert.ok(/\$locationMapBtn\.addEventListener\('click', \(\) => generateLocationMap\(\)\)/.test(main), 'button wired to generateLocationMap');
assert.ok(/showLocationMapPanel\(\{/.test(main), 'generateLocationMap renders through the shared panel');
const maps = main.match(/maps: \[([^\]]*)\]/);
assert.ok(maps, 'the app names the maps it offers');
for (const id of maps[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1))) {
  assert.ok(existsSync(path.join(dir, '../public', BASE_MAPS[id].svgUrl)), `offered map ${id} ships its SVG`);
}

// The shared files must not drift between the two apps. Skipped (not
// failed) when the sister checkout is absent, as it is in CI.
const SISTERS = [
  'D:/Dropbox/ClaudeCode/MBOpenData/mb-parcelsearch/web',
  'D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch/web',
];
const here = path.resolve(dir, '..').replace(/\\/g, '/').toLowerCase();
const sister = SISTERS.find((s) => s.toLowerCase() !== here && existsSync(`${s}/src/lib/locationMap.js`));
if (sister) {
  for (const f of ['src/lib/locationMap.js', 'src/lib/locationMapData.js', 'src/lib/locationMapPanel.js', 'test/locationMap.test.js']) {
    assert.equal(readFileSync(path.join(dir, '..', f), 'utf8'), readFileSync(`${sister}/${f}`, 'utf8'),
      `${f} differs from the copy in ${sister}`);
  }
} else {
  console.log('  (sister checkout absent; shared-file drift check skipped)');
}

console.log('locationMap: all tests passed');

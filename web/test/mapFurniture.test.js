// lib/mapFurniture.js — the scale bar / north arrow maths behind every
// captured exhibit. SHARED: byte-identical in the Winnipeg app, test too.
//
// Run: cd web && node test/mapFurniture.test.js

import assert from 'node:assert/strict';
import {
  haversineMeters, niceLength, scaleBarRows, drawScaleBar, drawNorthArrow, framedBounds,
  localDateStamp,
} from '../src/lib/mapFurniture.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

console.log('map furniture (scale bar, north arrow, exhibit framing)');

test('haversine: one degree of latitude is ~111.2 km', () => {
  near(haversineMeters([-97, 49], [-97, 50]), 111195, 50, '1° lat');
  // A degree of longitude at Winnipeg's latitude is cos(49.9°) of that.
  near(haversineMeters([-97, 49.9], [-96, 49.9]), 111195 * Math.cos(49.9 * Math.PI / 180), 200, '1° lng');
});

test('niceLength picks the largest 1/2/5 x 10^n that fits', () => {
  assert.equal(niceLength(73), 50);
  assert.equal(niceLength(199), 100);
  assert.equal(niceLength(200), 200);
  assert.equal(niceLength(4999), 2000);
  assert.equal(niceLength(0.7), 0.5);
  assert.equal(niceLength(0), 0);
  assert.equal(niceLength(NaN), 0);
});

test('scale bar rows: lengths are real ground distance at the given resolution', () => {
  // 0.5 m per image px, 400 px max → up to 200 m / 656 ft.
  const r = scaleBarRows(0.5, 400);
  assert.equal(r.metric.label, '200 m');
  near(r.metric.px, 400, 1e-9, 'metric px');
  assert.equal(r.imperial.label, '500 ft');
  near(r.imperial.px, (500 * 0.3048) / 0.5, 1e-9, 'imperial px');
  assert.ok(r.metric.px <= 400 && r.imperial.px <= 400, 'both rows fit');
});

test('scale bar switches to km and miles for regional views', () => {
  const r = scaleBarRows(20, 400);   // up to 8 km
  assert.equal(r.metric.label, '5 km');
  assert.equal(r.imperial.label, '2 mi');
  near(r.imperial.px, (2 * 5280 * 0.3048) / 20, 1e-9, 'mile px');
});

test('an unusable resolution draws nothing rather than a wrong bar', () => {
  assert.equal(scaleBarRows(NaN, 400), null);
  assert.equal(scaleBarRows(0, 400), null);
  assert.equal(scaleBarRows(1, 0), null);
});

test('framedBounds: a small lot gets the minimum width, padded', () => {
  // A ~20 m square lot in Winnipeg.
  const [[w, s], [e, n]] = framedBounds([-97.1402, 49.8950, -97.1399, 49.8952], { padFrac: 0.1, minWidthM: 200 });
  const width = haversineMeters([w, (s + n) / 2], [e, (s + n) / 2]);
  near(width, 220, 2, 'framed width');
});

test('framedBounds: a big extent keeps its size plus the pad', () => {
  const bb = [-97.3, 49.8, -97.0, 49.95];
  const [[w], [e]] = framedBounds(bb, { padFrac: 0.2, minWidthM: 100 });
  near(e - w, 0.3 * 1.2, 1e-9, 'padded lng span');
});

// A recording 2D context: enough to prove the draw calls run, place things
// where asked and leave the context as they found it.
function fakeCtx() {
  const calls = [];
  let saved = 0;
  const ctx = new Proxy({ font: '', fillStyle: '', strokeStyle: '', lineWidth: 1 }, {
    get(t, k) {
      if (k === 'measureText') return (s) => ({ width: String(s).length * 10 });
      if (k === 'save') return () => { saved++; };
      if (k === 'restore') return () => { saved--; };
      if (k === '__saved') return saved;
      if (k === '__calls') return calls;
      if (k in t) return t[k];
      return (...args) => { calls.push([k, ...args]); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return ctx;
}

test('drawScaleBar sits its bottom-left at (x, y) and balances save/restore', () => {
  const ctx = fakeCtx();
  const box = drawScaleBar(ctx, { x: 20, y: 1000, metersPerPx: 0.5, maxWidthPx: 400, font: 21 });
  assert.ok(box, 'drew something');
  assert.equal(box.x, 20);
  assert.equal(box.y + box.h, 1000);
  assert.equal(ctx.__saved, 0, 'save/restore balanced');
  const texts = ctx.__calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.deepEqual(texts, ['200 m', '500 ft']);
});

test('drawScaleBar draws nothing for an unusable resolution', () => {
  const ctx = fakeCtx();
  assert.equal(drawScaleBar(ctx, { x: 0, y: 100, metersPerPx: NaN, maxWidthPx: 400, font: 21 }), null);
  assert.equal(ctx.__calls.length, 0);
});

test('drawNorthArrow rotates by -bearing', () => {
  const ctx = fakeCtx();
  drawNorthArrow(ctx, { cx: 100, cy: 100, size: 80, bearing: 30 });
  const rot = ctx.__calls.find((c) => c[0] === 'rotate');
  near(rot[1], (-30 * Math.PI) / 180, 1e-12, 'rotation');
  assert.equal(ctx.__saved, 0);
  assert.ok(ctx.__calls.some((c) => c[0] === 'fillText' && c[1] === 'N'));
});

test('localDateStamp uses local time, not UTC', () => {
  // 11 pm on 7 October local time is already 8 October in UTC west of
  // Greenwich; the stamp must still say the 7th.
  const late = new Date(2026, 9, 7, 23, 30);
  assert.equal(localDateStamp(late), '2026-10-07');
  assert.equal(localDateStamp(new Date(2026, 0, 5, 0, 1)), '2026-01-05');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

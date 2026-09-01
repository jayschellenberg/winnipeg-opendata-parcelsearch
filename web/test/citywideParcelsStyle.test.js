// Unit tests for lib/citywideParcelsStyle.js — the citywide Assessment
// Parcels fabric re-calibrating per basemap: light grey over the Positron
// streets, white over aerial imagery (Esri satellite or a City ortho year).
//
// Run: cd web && node test/citywideParcelsStyle.test.js

import assert from 'node:assert/strict';
import {
  CITYWIDE_PARCELS_LINE_STYLES,
  applyCitywideParcelsBasemapStyle,
} from '../src/lib/citywideParcelsStyle.js';

const ORTHO_LAYERS = [2026, 2024, 2021, 2018, 2016].map((y) => `ortho-${y}`);

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

/** Minimal stub of the MapLibre surface the helper touches. `layers`
 *  maps id → visibility; paint set-calls are recorded per property. */
function stubMap(layers) {
  const paint = {};
  return {
    paint,
    getLayer: (id) => (id in layers ? { id } : undefined),
    getLayoutProperty: (id, prop) => (prop === 'visibility' ? layers[id] : undefined),
    setPaintProperty: (id, prop, value) => { paint[`${id}/${prop}`] = value; },
  };
}

const colorOf = (m) => m.paint['citywide-parcels-line/line-color'];

console.log('applyCitywideParcelsBasemapStyle');

test('streets gets the light preset', () => {
  const m = stubMap({
    'citywide-parcels-line': 'none',
    'pm-background': 'visible',
    'esri-imagery': 'none',
    ...Object.fromEntries(ORTHO_LAYERS.map((id) => [id, 'none'])),
  });
  applyCitywideParcelsBasemapStyle(m, ORTHO_LAYERS);
  assert.equal(colorOf(m), CITYWIDE_PARCELS_LINE_STYLES.light['line-color']);
  assert.deepEqual(m.paint['citywide-parcels-line/line-opacity'],
    CITYWIDE_PARCELS_LINE_STYLES.light['line-opacity']);
  assert.deepEqual(m.paint['citywide-parcels-line/line-width'],
    CITYWIDE_PARCELS_LINE_STYLES.light['line-width']);
});

test('satellite gets the imagery preset', () => {
  const m = stubMap({
    'citywide-parcels-line': 'none',
    'pm-background': 'none',
    'esri-imagery': 'visible',
    ...Object.fromEntries(ORTHO_LAYERS.map((id) => [id, 'none'])),
  });
  applyCitywideParcelsBasemapStyle(m, ORTHO_LAYERS);
  assert.equal(colorOf(m), CITYWIDE_PARCELS_LINE_STYLES.imagery['line-color']);
});

test('every aerial year triggers the imagery preset', () => {
  for (const ortho of ORTHO_LAYERS) {
    const m = stubMap({
      'citywide-parcels-line': 'none',
      'pm-background': 'none',
      // Esri backs the aerials but is explicitly off here, so the ortho
      // layer is the only thing that can flip the preset.
      'esri-imagery': 'none',
      ...Object.fromEntries(ORTHO_LAYERS.map((id) => [id, 'none'])),
      [ortho]: 'visible',
    });
    applyCitywideParcelsBasemapStyle(m, ORTHO_LAYERS);
    assert.equal(colorOf(m), CITYWIDE_PARCELS_LINE_STYLES.imagery['line-color'], ortho);
  }
});

test('no ortho archives configured (inert build) still resolves streets vs satellite', () => {
  const streets = stubMap({ 'citywide-parcels-line': 'none', 'esri-imagery': 'none' });
  applyCitywideParcelsBasemapStyle(streets, []);
  assert.equal(colorOf(streets), CITYWIDE_PARCELS_LINE_STYLES.light['line-color']);

  const sat = stubMap({ 'citywide-parcels-line': 'none', 'esri-imagery': 'visible' });
  applyCitywideParcelsBasemapStyle(sat, []);
  assert.equal(colorOf(sat), CITYWIDE_PARCELS_LINE_STYLES.imagery['line-color']);
});

test('a map without the fabric layer is a no-op (tiles never toggled on)', () => {
  const m = stubMap({ 'esri-imagery': 'visible' });
  applyCitywideParcelsBasemapStyle(m, ORTHO_LAYERS);
  assert.deepEqual(m.paint, {});
});

test('colours match the Manitoba sister app exactly', () => {
  // Jason amended these in mb-parcelsearch (web/src/lib/muniParcelsStyle.js)
  // and wants the two tools consistent — grey on streets, white on aerial.
  assert.equal(CITYWIDE_PARCELS_LINE_STYLES.light['line-color'], '#d1d5db');
  assert.equal(CITYWIDE_PARCELS_LINE_STYLES.imagery['line-color'], '#ffffff');
});

test('the zoom ramps survive the port — no flat values, imagery no wider', () => {
  for (const preset of Object.values(CITYWIDE_PARCELS_LINE_STYLES)) {
    // A flat width/opacity below z14 is a citywide blackout; the ramp is
    // load-bearing, not cosmetic.
    assert.ok(Array.isArray(preset['line-width']), 'width must stay an interpolate expression');
    assert.ok(Array.isArray(preset['line-opacity']), 'opacity must stay an interpolate expression');
    assert.equal(preset['line-width'][0], 'interpolate');
  }
  // White reads heavier than grey, so imagery gains opacity, not width.
  assert.deepEqual(CITYWIDE_PARCELS_LINE_STYLES.imagery['line-width'],
    CITYWIDE_PARCELS_LINE_STYLES.light['line-width']);
  const top = (ramp) => ramp[ramp.length - 1];
  assert.ok(top(CITYWIDE_PARCELS_LINE_STYLES.imagery['line-opacity'])
    > top(CITYWIDE_PARCELS_LINE_STYLES.light['line-opacity']));
});

test('the low-zoom stops stay low — this is the blackout guard, not a look', () => {
  // "The lines are too faint" is recurring feedback, and the tempting fix is
  // to lift the whole ramp. Don't. At z11 roughly 37,000 lots are in view and
  // every boundary overlaps its neighbours, so the z8/z11 stops are what stop
  // the overlay repainting the city solid. Raise the z13+ stops instead, or
  // change the colour. Values pinned at what was measured by eye against the
  // real archive.
  for (const preset of Object.values(CITYWIDE_PARCELS_LINE_STYLES)) {
    const ramp = preset['line-opacity'];
    // ['interpolate', ['linear'], ['zoom'], z, v, z, v, ...] — pairs start at 3.
    const stops = new Map();
    for (let i = 3; i < ramp.length; i += 2) stops.set(ramp[i], ramp[i + 1]);
    assert.ok(stops.get(8) <= 0.15, `z8 opacity ${stops.get(8)} is above the blackout guard`);
    assert.ok(stops.get(11) <= 0.25, `z11 opacity ${stops.get(11)} is above the blackout guard`);
  }
});

test('opacity climbs monotonically with zoom in both presets', () => {
  for (const preset of Object.values(CITYWIDE_PARCELS_LINE_STYLES)) {
    const ramp = preset['line-opacity'];
    let prevZoom = -Infinity;
    let prevOpacity = -Infinity;
    for (let i = 3; i < ramp.length; i += 2) {
      const [zoom, opacity] = [ramp[i], ramp[i + 1]];
      assert.ok(zoom > prevZoom, `zoom stops must ascend, got ${zoom} after ${prevZoom}`);
      assert.ok(opacity > prevOpacity, `opacity must increase with zoom, got ${opacity} after ${prevOpacity}`);
      assert.ok(opacity <= 1, `opacity cannot exceed 1, got ${opacity}`);
      prevZoom = zoom;
      prevOpacity = opacity;
    }
  }
});

const fails = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length > 0) process.exit(1);

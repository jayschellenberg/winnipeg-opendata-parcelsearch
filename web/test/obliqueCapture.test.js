// Unit tests for src/lib/obliqueCapture.js. Plain-node runner; run with
// `npm test` or `node test/obliqueCapture.test.js`.
import assert from 'node:assert/strict';
import {
  obliqueViewerUrl, viewerWindowFeatures, displayMediaOptions, grabDisplayFrame,
  captureErrorMessage, CaptureCancelled, surfaceWarning, heldForSubject,
  obliqueFileBase, obliqueListingNote, HELD_MATCH_M,
} from '../src/lib/obliqueCapture.js';
import { haversineMeters } from '../src/lib/mapFurniture.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed += 1;
  }
}

console.log('obliqueCapture');

await test('obliqueViewerUrl — lat then lon, six decimals, oblique facing north', () => {
  assert.equal(obliqueViewerUrl(49.8915791, -97.1416072),
    'https://legacy.winnipeg.ca/pictometry/ipa.aspx?lat=49.891579&lon=-97.141607&ex_level=20&ex_type=Ob&ex_orientation=N');
});

await test('viewerWindowFeatures — a popup with no opener, 13:7', () => {
  const f = viewerWindowFeatures();
  assert.match(f, /(^|,)popup(,|$)/);
  assert.match(f, /(^|,)noopener(,|$)/);
  assert.match(f, /width=1300,height=700/);
});

await test('displayMediaOptions — tabs only, never this tab, no audio', () => {
  const o = displayMediaOptions();
  assert.equal(o.video.displaySurface, 'browser');
  assert.equal(o.selfBrowserSurface, 'exclude');
  assert.equal(o.monitorTypeSurfaces, 'exclude');
  assert.equal(o.audio, false);
  assert.ok(!('controller' in o));
  const c = {};
  assert.equal(displayMediaOptions(c).controller, c);
});

// A stand-in for the browser: a stream with one stoppable track and a
// document whose <video> reports a size and whose <canvas> records the draw.
function fakeBrowser({ width = 1300, height = 700, surface = 'browser', reject = null } = {}) {
  const track = { stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ displaySurface: surface }) };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const drawn = [];
  let asked = null;
  const doc = {
    createElement(tag) {
      if (tag === 'video') {
        const handlers = {};
        return {
          videoWidth: width, videoHeight: height,
          addEventListener(type, fn) { handlers[type] = fn; },
          play() { queueMicrotask(() => handlers.loadeddata?.()); return Promise.resolve(); },
          requestVideoFrameCallback(fn) { queueMicrotask(fn); },
        };
      }
      return { getContext: () => ({ drawImage: (...a) => drawn.push(a) }) };
    },
  };
  const mediaDevices = {
    getDisplayMedia(opts) { asked = opts; return reject ? Promise.reject(reject) : Promise.resolve(stream); },
  };
  return { track, doc, mediaDevices, drawn, asked: () => asked };
}

await test('grabDisplayFrame — one frame at the stream size, stream stopped after', async () => {
  const b = fakeBrowser({ width: 2600, height: 1400 });
  let focus = null;
  class Controller { setFocusBehavior(v) { focus = v; } }
  const out = await grabDisplayFrame({ mediaDevices: b.mediaDevices, doc: b.doc, Controller });
  assert.equal(out.width, 2600);
  assert.equal(out.height, 1400);
  assert.equal(out.canvas.width, 2600);
  assert.equal(out.surface, 'browser');
  assert.equal(b.drawn.length, 1);
  assert.equal(b.track.stopped, true);
  assert.equal(focus, 'no-focus-change');
  assert.ok(b.asked().controller instanceof Controller);
});

await test('grabDisplayFrame — stops the stream when the frame is empty', async () => {
  const b = fakeBrowser({ width: 0, height: 0 });
  await assert.rejects(grabDisplayFrame({ mediaDevices: b.mediaDevices, doc: b.doc, Controller: null }), /empty/);
  assert.equal(b.track.stopped, true);
});

await test('grabDisplayFrame — no API is NotSupportedError', async () => {
  await assert.rejects(grabDisplayFrame({ mediaDevices: {}, doc: {} }), { name: 'NotSupportedError' });
});

await test('captureErrorMessage — a dismissed prompt is silent, the rest is plain', () => {
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  assert.equal(captureErrorMessage(denied), '');
  assert.equal(captureErrorMessage(new CaptureCancelled()), '');
  const none = Object.assign(new Error('x'), { name: 'NotSupportedError' });
  assert.match(captureErrorMessage(none), /Chrome or Edge/);
  assert.equal(captureErrorMessage(new Error('The capture came back empty.')), 'The capture came back empty.');
});

await test('surfaceWarning — only a non-tab capture is flagged', () => {
  assert.equal(surfaceWarning('browser'), '');
  assert.equal(surfaceWarning(''), '');
  assert.match(surfaceWarning('window'), /browser frame/);
  assert.match(surfaceWarning('monitor'), /whole screen/);
});

await test('heldForSubject — keeps photos taken for this subject, drops the rest', () => {
  const library = [-97.141607, 49.891579];
  const acrossTown = [-97.20, 49.80];
  const held = [{ id: 1, centre: library }, { id: 2, centre: acrossTown }, { id: 3 }];
  // ~70 m east of the library centre.
  const near = [-97.1406, 49.891579];
  assert.ok(haversineMeters(library, near) < HELD_MATCH_M);
  assert.deepEqual(heldForSubject(held, near, haversineMeters).map((h) => h.id), [1]);
  assert.deepEqual(heldForSubject(held, acrossTown, haversineMeters).map((h) => h.id), [2]);
  assert.deepEqual(heldForSubject(held, null, haversineMeters), []);
  assert.deepEqual(heldForSubject(held, [NaN, 49], haversineMeters), []);
});

await test('obliqueFileBase — numbered only when there are several', () => {
  assert.equal(obliqueFileBase(0, 1), 'eagleview-45-air-photo.png');
  assert.equal(obliqueFileBase(0, 3), 'eagleview-45-air-photo-1.png');
  assert.equal(obliqueFileBase(2, 3), 'eagleview-45-air-photo-3.png');
});

await test('obliqueListingNote — says what, where from and how big', () => {
  const note = obliqueListingNote({ label: '251 Donald Street', capturedAt: '2026-11-27 11:40', width: 1300, height: 700 });
  assert.match(note, /251 Donald Street/);
  assert.match(note, /City of Winnipeg viewer, captured 2026-11-27 11:40/);
  assert.match(note, /1300 x 700 px/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

import assert from 'node:assert';
import {
  MapRenderTimeoutError,
  StaleSnapshotFrameError,
  captureSnapshotWithRetry,
  findStaleSnapshotFrame,
  waitForMapIdle,
} from '../src/lib/snapshotCapture.js';

class FakeMap {
  constructor() {
    this.listeners = new Map();
    this.repaintCount = 0;
  }

  on(event, fn) { this.listeners.set(event, fn); }
  off(event, fn) {
    if (this.listeners.get(event) === fn) this.listeners.delete(event);
  }
  triggerRepaint() { this.repaintCount += 1; }
  emit(event) { this.listeners.get(event)?.(); }
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

await test('render timeout rejects instead of accepting a stale frame', async () => {
  const map = new FakeMap();
  await assert.rejects(
    waitForMapIdle(map, 5),
    /did not become idle/i,
  );
  assert.strictEqual(map.listeners.has('idle'), false, 'idle listener cleaned after timeout');
  assert.strictEqual(map.repaintCount, 1);
});

await test('idle resolves readiness and removes its listener', async () => {
  const map = new FakeMap();
  const ready = waitForMapIdle(map, 100);
  map.emit('idle');
  await ready;
  assert.strictEqual(map.listeners.has('idle'), false);
  assert.strictEqual(map.repaintCount, 1);
});

// ---- page-visibility handling ----
//
// A hidden tab throttles requestAnimationFrame, so MapLibre never renders and
// never fires 'idle'. The readiness budget must therefore count VISIBLE time
// only, or an export left running in a background tab fails on a healthy map.

/** Controllable stand-in for document.visibilityState. */
class FakeVisibility {
  constructor(hidden = false) {
    this.hidden = hidden;
    this.subscribers = new Set();
  }

  isHidden() { return this.hidden; }
  subscribe(fn) { this.subscribers.add(fn); return () => this.subscribers.delete(fn); }
  set(hidden) {
    this.hidden = hidden;
    for (const fn of [...this.subscribers]) fn();
  }
}

/** Manual clock so the tests don't have to sleep in real time. */
function fakeClock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

await test('time spent hidden does not count against the readiness budget', async () => {
  const map = new FakeMap();
  const visibility = new FakeVisibility(false);
  const now = fakeClock();
  let rejected = null;
  const ready = waitForMapIdle(map, 50, { visibility, now }).catch((err) => { rejected = err; });

  // Hide almost immediately, then stay hidden well past the 50 ms budget.
  now.advance(10);
  visibility.set(true);
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(rejected, null, 'clock must be stopped while hidden');

  // On return the swallowed repaint is requested again, and the map can still
  // report idle against the 40 ms it has left.
  visibility.set(false);
  assert.strictEqual(map.repaintCount, 2, 'repaint re-requested on becoming visible');
  map.emit('idle');
  await ready;
  assert.strictEqual(rejected, null);
  assert.strictEqual(map.listeners.has('idle'), false);
});

await test('the budget resumes rather than restarts when the tab comes back', async () => {
  const map = new FakeMap();
  const visibility = new FakeVisibility(false);
  const now = fakeClock();
  const ready = waitForMapIdle(map, 40, { visibility, now });

  now.advance(35);            // 5 ms of budget left
  visibility.set(true);
  now.advance(10_000);        // a long stint in the background
  visibility.set(false);

  await assert.rejects(ready, /did not become idle/i, 'the remaining 5 ms still expires');
  assert.strictEqual(map.listeners.has('idle'), false);
});

await test('starting while already hidden does not burn the budget', async () => {
  const map = new FakeMap();
  const visibility = new FakeVisibility(true);
  const now = fakeClock();
  let rejected = null;
  const ready = waitForMapIdle(map, 30, { visibility, now }).catch((err) => { rejected = err; });

  await new Promise((r) => setTimeout(r, 90));
  assert.strictEqual(rejected, null);

  visibility.set(false);
  map.emit('idle');
  await ready;
  assert.strictEqual(rejected, null);
});

await test('the visibility subscription is released when readiness settles', async () => {
  const map = new FakeMap();
  const visibility = new FakeVisibility(false);
  const ready = waitForMapIdle(map, 100, { visibility });
  assert.strictEqual(visibility.subscribers.size, 1);
  map.emit('idle');
  await ready;
  assert.strictEqual(visibility.subscribers.size, 0, 'no listener left on the document');
});

await test('without a visibility source the plain timeout still governs', async () => {
  const map = new FakeMap();
  await assert.rejects(
    waitForMapIdle(map, 5, { visibility: null }),
    /did not become idle/i,
  );
  assert.strictEqual(map.listeners.has('idle'), false);
});

await test('capture retries readiness failures and returns the first valid frame', async () => {
  let prepared = 0;
  let waited = 0;
  let captured = 0;
  const retries = [];
  const result = await captureSnapshotWithRetry({
    attempts: 3,
    prepare: async () => { prepared += 1; },
    waitUntilReady: async () => {
      waited += 1;
      if (waited < 3) throw new MapRenderTimeoutError(5);
    },
    capture: async () => { captured += 1; return 'fresh-frame'; },
    onRetry: ({ nextAttempt }) => retries.push(nextAttempt),
  });

  assert.strictEqual(result, 'fresh-frame');
  assert.strictEqual(prepared, 3);
  assert.strictEqual(waited, 3);
  assert.strictEqual(captured, 1, 'never captures before the map is ready');
  assert.deepStrictEqual(retries, [2, 3]);
});

await test('capture retries an exact stale frame and fails closed at the limit', async () => {
  let captures = 0;
  await assert.rejects(
    captureSnapshotWithRetry({
      attempts: 2,
      prepare: async () => {},
      waitUntilReady: async () => {},
      capture: async () => { captures += 1; return new Uint8Array([1, 2, 3]); },
      validate: async () => { throw new StaleSnapshotFrameError('610-19000.jpg', '610-234600.jpg'); },
    }),
    /duplicated the rendered frame/i,
  );
  assert.strictEqual(captures, 2);
});

await test('non-readiness failures are not retried', async () => {
  let prepared = 0;
  await assert.rejects(
    captureSnapshotWithRetry({
      attempts: 3,
      prepare: async () => { prepared += 1; },
      waitUntilReady: async () => { throw new Error('canvas context lost'); },
      capture: async () => null,
    }),
    /canvas context lost/i,
  );
  assert.strictEqual(prepared, 1);
});

await test('stale-frame detection requires equal bytes and different bounds', () => {
  const prior = {
    name: '610-234600.jpg',
    bounds: [-95.62, 49.15, -95.61, 49.16],
    data: new Uint8Array([10, 20, 30]),
  };
  assert.strictEqual(
    findStaleSnapshotFrame([prior], {
      name: '610-19000.jpg',
      bounds: [-96.05, 49.00, -96.03, 49.01],
      data: new Uint8Array([10, 20, 30]),
    }),
    prior,
  );
  assert.strictEqual(
    findStaleSnapshotFrame([prior], { ...prior, name: '610-234600-2.jpg' }),
    null,
    'a repeated parcel extent may legitimately produce identical bytes',
  );
  assert.strictEqual(
    findStaleSnapshotFrame([prior], {
      name: '610-19000.jpg',
      bounds: [-96.05, 49.00, -96.03, 49.01],
      data: new Uint8Array([10, 20, 31]),
    }),
    null,
  );
});

console.log(`snapshotCapture.test.js: ${passed} passed`);

// Unit tests for src/lib/yieldToPaint.js.
//
// The bug these exist for: Chrome does not fire requestAnimationFrame in a
// HIDDEN tab, and the original helper awaited one unconditionally. A sales
// run in a backgrounded tab deadlocked on the first yield, permanently, with
// the progress line still showing and no error. Measured on the deployed app
// 2026-08-22: rAF did not fire in 3s with the tab hidden, zero requests were
// issued, and a single screenshot -- one composite -- released exactly one
// rAF and let exactly one fetch through before it deadlocked again.
//
// So the third test below is the whole point: rAF is registered and NEVER
// invoked, and yieldToPaint must still resolve.
//
// Plain-node runner; run with `npm test` or `node test/yieldToPaint.test.js`.

import assert from 'node:assert/strict';
import { yieldToPaint, PAINT_TIMEOUT_MS } from '../src/lib/yieldToPaint.js';

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

console.log('yieldToPaint');

/** Swap in a rAF implementation for one test, always restoring it after. */
async function withRaf(impl, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'requestAnimationFrame');
  const prev = globalThis.requestAnimationFrame;
  if (impl === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = impl;
  try { return await fn(); } finally {
    if (had) globalThis.requestAnimationFrame = prev;
    else delete globalThis.requestAnimationFrame;
  }
}

test('resolves when requestAnimationFrame does not exist at all', async () => {
  // Node, or a very old browser. There is no frame to wait for, so a
  // macrotask is the best available yield.
  await withRaf(undefined, async () => {
    const t0 = Date.now();
    await yieldToPaint();
    assert.ok(Date.now() - t0 < PAINT_TIMEOUT_MS,
      'should not have waited for the paint timeout when there is no rAF');
  });
});

test('resolves on the FRAME when the tab is visible, not on the timeout', async () => {
  // A real frame is ~16ms, so a visible tab always wins the race and the
  // timeout costs nothing. Pinned so nobody "simplifies" the helper into a
  // flat setTimeout and silently adds latency to every yield.
  let rafCalls = 0;
  await withRaf((cb) => { rafCalls += 1; setTimeout(cb, 1); }, async () => {
    const t0 = Date.now();
    await yieldToPaint();
    const ms = Date.now() - t0;
    assert.equal(rafCalls, 1, 'rAF should still be the primary path');
    assert.ok(ms < PAINT_TIMEOUT_MS, `resolved in ${ms}ms, expected well under ${PAINT_TIMEOUT_MS}ms`);
  });
});

test('resolves even when requestAnimationFrame NEVER fires -- the hidden tab', async () => {
  // THE REGRESSION TEST. This is the exact shape of a backgrounded Chrome
  // tab: rAF is a function, it accepts the callback, and it never calls it.
  // The old helper hung here forever and took the whole sales run with it.
  let registered = 0;
  await withRaf(() => { registered += 1; /* never invokes the callback */ }, async () => {
    const t0 = Date.now();
    await yieldToPaint();
    const ms = Date.now() - t0;
    assert.equal(registered, 1, 'rAF should have been asked first');
    assert.ok(ms >= PAINT_TIMEOUT_MS - 20, `resolved in ${ms}ms, expected to wait for the timeout`);
    assert.ok(ms < PAINT_TIMEOUT_MS * 10, `resolved in ${ms}ms, far longer than the timeout`);
  });
});

test('resolves exactly once when a late frame arrives after the timeout', async () => {
  // A tab brought back to the foreground fires its queued rAF, which lands
  // after the timeout has already resolved. Resolving twice is harmless to a
  // Promise but the guard also has to stop the callback throwing on a
  // cleared timer, so exercise the path rather than assume it.
  let fire = null;
  await withRaf((cb) => { fire = cb; }, async () => {
    await yieldToPaint();
    assert.ok(typeof fire === 'function', 'rAF callback was captured');
    fire();                                   // the late frame
    await new Promise((r) => setTimeout(r, 5));
    fire();                                   // and again, for good measure
    await new Promise((r) => setTimeout(r, 5));
  });
});

test('does not leave a pending timer once the frame has won', async () => {
  // Without the clearTimeout every yield keeps a timer alive for the full
  // timeout. In node that holds the test process open; in the browser it is
  // a wasted slot on a hot path. Detected by counting live handles.
  await withRaf((cb) => setTimeout(cb, 1), async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    await yieldToPaint();
    await new Promise((r) => setTimeout(r, 5));
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    assert.ok(after <= before + 1,
      `left ${after - before} extra timers pending; the paint-timeout should be cleared`);
  });
});

test('the timeout is short enough to be invisible and long enough for a frame', async () => {
  // A frame is ~16ms. Anything below that would race a slow frame and lose
  // the paint the helper exists to produce; anything large would be felt.
  assert.ok(PAINT_TIMEOUT_MS >= 32, 'must comfortably clear a ~16ms frame');
  assert.ok(PAINT_TIMEOUT_MS <= 250, 'must stay imperceptible on a visible tab');
});

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed += 1;
  }
}

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);

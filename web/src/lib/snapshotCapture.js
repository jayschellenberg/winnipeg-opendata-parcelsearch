/** Browser-independent readiness/retry helpers for parcel snapshots. */

export class MapRenderTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Map did not become idle within ${timeoutMs} ms.`);
    this.name = 'MapRenderTimeoutError';
  }
}

export class StaleSnapshotFrameError extends Error {
  constructor(currentName, priorName) {
    super(`Snapshot ${currentName} duplicated the rendered frame for ${priorName}.`);
    this.name = 'StaleSnapshotFrameError';
  }
}

/**
 * Page-visibility seam. Browsers throttle requestAnimationFrame to a
 * standstill in a hidden or backgrounded tab, so MapLibre stops rendering and
 * never fires 'idle' — a healthy map, just paused. Without this, starting a
 * 30-frame export and switching tabs guarantees a timeout.
 *
 * Returns null outside a browser (node tests), where "hidden" has no meaning
 * and the plain timeout is the whole contract.
 */
function documentVisibility() {
  if (typeof document === 'undefined') return null;
  return {
    isHidden: () => document.visibilityState === 'hidden',
    subscribe: (fn) => {
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
  };
}

/**
 * Wait until MapLibre reports that the current frame is idle. A timeout is a
 * failure, not a substitute for readiness: accepting it would capture the
 * previous parcel still present in the WebGL canvas.
 *
 * The budget is *visible* time, not wall-clock. While the page is hidden the
 * clock stops, because the map isn't rendering and couldn't become idle if it
 * wanted to; on return the repaint that the rAF throttle swallowed is
 * requested again. An export left running in a background tab therefore picks
 * up where it left off instead of failing 27 seconds in.
 *
 * Kept separate from snapshotExport.js so this contract can be tested without
 * importing MapLibre's browser-only CSS in Node.
 *
 * @param {Object} [opts]
 * @param {{isHidden:()=>boolean, subscribe:(fn:Function)=>Function}|null}
 *   [opts.visibility] — injectable for tests; defaults to the document.
 * @param {() => number} [opts.now] — injectable clock, for the same reason.
 */
export function waitForMapIdle(map, timeoutMs = 9000, opts = {}) {
  const { visibility = documentVisibility(), now = Date.now } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let remaining = timeoutMs;
    let startedAt = 0;
    let unsubscribe = null;

    const stopClock = () => {
      if (timer == null) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (now() - startedAt));
    };
    const startClock = () => {
      if (timer != null || settled) return;
      startedAt = now();
      timer = setTimeout(onTimeout, remaining);
    };
    const cleanup = () => {
      map.off('idle', onIdle);
      if (timer != null) clearTimeout(timer);
      timer = null;
      unsubscribe?.();
    };
    function onIdle() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }
    function onTimeout() {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new MapRenderTimeoutError(timeoutMs));
    }
    const onVisibilityChange = () => {
      if (settled) return;
      if (visibility.isHidden()) {
        stopClock();
        return;
      }
      startClock();
      // The repaint requested while hidden never produced a frame — ask again
      // now that the browser is actually rendering.
      map.triggerRepaint();
    };

    map.on('idle', onIdle);
    if (visibility) unsubscribe = visibility.subscribe(onVisibilityChange);
    if (!visibility?.isHidden()) startClock();
    map.triggerRepaint();
  });
}

function retryableCaptureError(err) {
  return err instanceof MapRenderTimeoutError || err instanceof StaleSnapshotFrameError;
}

/**
 * Run one parcel capture with bounded retries for readiness/stale-frame errors.
 * Other failures (canvas encoding, teardown, programming errors) surface
 * immediately instead of being hidden behind repeated attempts.
 */
export async function captureSnapshotWithRetry({
  prepare,
  waitUntilReady,
  capture,
  validate,
  attempts = 3,
  onRetry,
}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('Snapshot capture attempts must be a positive integer.');
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await prepare(attempt);
    try {
      await waitUntilReady(attempt);
      const result = await capture(attempt);
      await validate?.(result, attempt);
      return result;
    } catch (err) {
      if (!retryableCaptureError(err) || attempt === attempts) throw err;
      onRetry?.({ attempt, nextAttempt: attempt + 1, error: err });
    }
  }

  throw new Error('Snapshot capture exhausted its retry loop.');
}

function sameBounds(a, b) {
  return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Return the prior parcel whose exact JPEG bytes were reused for a different
 * geographic extent. Identical bytes are allowed when the input legitimately
 * repeats the same parcel bounds.
 */
export function findStaleSnapshotFrame(priorFrames, candidate) {
  for (const prior of priorFrames || []) {
    if (sameBounds(prior.bounds, candidate.bounds)) continue;
    if (sameBytes(prior.data, candidate.data)) return prior;
  }
  return null;
}

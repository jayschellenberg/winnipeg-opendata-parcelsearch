/*
 * Hand the thread back long enough for one frame to paint.
 *
 * A full sales run fetches thousands of assessment records, two permit
 * tables and a neighbourhood index before a single row appears. On one
 * thread that reads as a hang, so runSalesAnalysis names each step in
 * the status bar — and a textContent assignment inside a synchronous
 * block paints nothing, because the browser never gets the thread back
 * to do it. Hence a yield between the message and the work.
 *
 * WHY IT IS NOT JUST requestAnimationFrame.
 *
 * Chrome does not fire rAF callbacks in a HIDDEN tab. The previous
 * version awaited one unconditionally:
 *
 *     requestAnimationFrame(() => setTimeout(resolve, 0));
 *
 * with a setTimeout fallback only for the case where rAF is ABSENT --
 * never for the case where it exists and simply never fires. So a sales
 * run in a backgrounded tab deadlocked on the first yield, permanently,
 * with the progress line still on screen, no error, and the Search
 * button re-enabled. The only recovery was a reload. That is exactly the
 * "it froze" failure the progress line exists to prevent.
 *
 * It is not a rare corner. runSalesAnalysis yields three times, a whole-
 * archive run takes minutes, and switching tabs while you wait is the
 * natural thing to do.
 *
 * Measured on the deployed app 2026-08-22: with the tab hidden, rAF did
 * not fire in 3 seconds and ZERO network requests were issued. Taking a
 * single screenshot composited the tab, released exactly ONE rAF, and
 * let exactly ONE fetch through (200 in 797ms) before the run deadlocked
 * again on the next yield. One step per composite.
 *
 * So RACE the frame against a timer. A visible tab still yields on a
 * real paint, within a frame; a hidden or throttled one yields on the
 * timeout and the run continues. Both the "hidden when called" and the
 * "backgrounded mid-await" cases are covered, because the timer is armed
 * either way rather than chosen up front from document.hidden -- which
 * would still deadlock a run backgrounded one line later.
 */

/**
 * How long to wait for a frame before giving up on one.
 *
 * A frame is ~16ms, so a visible tab always wins this race and pays
 * nothing. A hidden tab pays the full timeout per yield -- three of them
 * in a sales run, so 300ms against a run measured in minutes. Cheap
 * enough that there is no reason to shorten it and lose the paint on a
 * slow frame.
 */
export const PAINT_TIMEOUT_MS = 100;

/** @returns {Promise<void>} resolves after a paint, or after PAINT_TIMEOUT_MS. */
export function yieldToPaint() {
  return new Promise((resolve) => {
    // No rAF at all (node, or a very old browser): a macrotask is the
    // best available yield and there is no frame to wait for.
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      // Without this the pending timer keeps a node test process alive
      // for PAINT_TIMEOUT_MS after every yield, and keeps a browser
      // timer slot occupied for no reason.
      if (timer !== null) clearTimeout(timer);
      resolve();
    };
    // rAF fires BEFORE paint, so the extra macrotask is what actually
    // puts us after it. Kept from the original -- resolving straight
    // out of the rAF callback would resume before the frame committed
    // and the status line would not be on screen after all.
    requestAnimationFrame(() => setTimeout(finish, 0));
    timer = setTimeout(finish, PAINT_TIMEOUT_MS);
  });
}

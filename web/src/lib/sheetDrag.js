// Drag-to-snap for the phone bottom sheet (body.phone; lib/phoneMode.js).
//
// The sheet's resting heights are its three CSS state classes. A drag
// must not lay the whole sidebar out on every pointer move — with a
// 100-row results table inside, that is the difference between a sheet
// that follows the finger and one that stutters — so the gesture works
// in transform space: at pointerdown the sheet is sized to `full` once
// and every move only changes translateY. On release the nearest snap
// (after a short velocity projection, so a fling lands one state
// further) is animated to in transform, and only then does the state
// class change and the inline styles go away.
//
// A press that never moves more than TAP_SLOP_PX is a tap: nothing here
// reacts, and the element's own click handler runs (the handle cycles,
// a tab selects). After a real drag the click that the browser fires
// anyway is swallowed, so a drag on the tab strip does not also switch
// tabs.

export const PROJECT_MS = 120;   // how far ahead a fling is projected
export const TAP_SLOP_PX = 6;    // less movement than this is a tap
export const SETTLE_MS = 200;    // matches the transform transition in CSS
const STALE_MS = 80;             // finger paused this long: no fling

/**
 * Pure: which snap a release at height `h` (px) with velocity `vel`
 * (px/ms, positive = sheet growing) lands on. `heights` maps state
 * name -> px.
 */
export function chooseSnap(h, vel, heights) {
  const projected = h + (Number.isFinite(vel) ? vel : 0) * PROJECT_MS;
  let best = null;
  let bestD = Infinity;
  for (const [name, px] of Object.entries(heights)) {
    const d = Math.abs(px - projected);
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

/**
 * Wire the gesture.
 *   sheet      the sidebar element
 *   grabbers   elements a drag may start on (the handle, the tab strip)
 *   measure()  -> { state: px } for every snap state at the current
 *                 viewport; called at each pointerdown
 *   onSnap(name) commit a state: set its class and clear inline styles
 */
export function initSheetDrag({ sheet, grabbers, measure, onSnap }) {
  if (!sheet || typeof window === 'undefined' || !('PointerEvent' in window)) return false;
  let active = null;
  let settleTimer = 0;
  let swallowClick = false;

  const clearSettle = () => {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
    sheet.classList.remove('sheet-settling');
  };

  const onDown = (e) => {
    if (active) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    clearSettle();
    const heights = measure();
    if (!heights || !Number.isFinite(heights.full)) return;
    const startH = sheet.getBoundingClientRect().height;
    active = {
      id: e.pointerId, target: e.currentTarget, heights,
      startY: e.clientY, startH, h: startH,
      lastY: e.clientY, lastT: e.timeStamp, vel: 0, moved: false,
    };
    sheet.classList.add('sheet-dragging');
    sheet.style.height = `${heights.full}px`;
    sheet.style.transform = `translateY(${heights.full - startH}px)`;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };

  const onMove = (e) => {
    if (!active || e.pointerId !== active.id) return;
    const dy = active.startY - e.clientY;   // finger up = sheet grows
    if (!active.moved && Math.abs(dy) < TAP_SLOP_PX) return;
    active.moved = true;
    const { peek, full } = active.heights;
    const h = Math.min(full, Math.max(peek, active.startH + dy));
    const dt = e.timeStamp - active.lastT;
    if (dt > 0) active.vel = (active.lastY - e.clientY) / dt;
    active.lastY = e.clientY;
    active.lastT = e.timeStamp;
    active.h = h;
    sheet.style.transform = `translateY(${full - h}px)`;
  };

  const finish = (e, cancelled) => {
    if (!active || e.pointerId !== active.id) return;
    const a = active;
    active = null;
    try { a.target.releasePointerCapture(a.id); } catch {}
    if (!a.moved) {
      // A tap: back to the resting state, then let the click handler act.
      // The inline pair is cleared and laid out while sheet-dragging still
      // holds transitions off; clearing it with transitions on would
      // animate the height down from `full`, a flash to full-screen on
      // every tap.
      sheet.style.height = '';
      sheet.style.transform = '';
      void sheet.offsetHeight;
      sheet.classList.remove('sheet-dragging');
      return;
    }
    sheet.classList.remove('sheet-dragging');
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
    const stale = cancelled || (e.timeStamp - a.lastT) > STALE_MS;
    const target = chooseSnap(a.h, stale ? 0 : a.vel, a.heights);
    // Glide to the snap in transform space, then swap to the state
    // class while transitions are off so the hand-over is invisible.
    sheet.classList.add('sheet-settling');
    sheet.style.transform = `translateY(${a.heights.full - a.heights[target]}px)`;
    settleTimer = setTimeout(() => {
      settleTimer = 0;
      // The swap happens with every transition off: the class sets the
      // resting height, the inline pair is cleared, and a forced layout
      // commits that before transitions return — so nothing animates.
      // Swapping under sheet-settling instead would animate the cleared
      // transform from its glide value, dropping the sheet off-screen
      // and sliding it back up.
      sheet.classList.remove('sheet-settling');
      sheet.classList.add('sheet-dragging');
      onSnap(target);
      void sheet.offsetHeight;
      sheet.classList.remove('sheet-dragging');
    }, SETTLE_MS);
  };

  for (const g of grabbers) {
    if (!g) continue;
    g.addEventListener('pointerdown', onDown);
    g.addEventListener('pointermove', onMove);
    g.addEventListener('pointerup', (e) => finish(e, false));
    g.addEventListener('pointercancel', (e) => finish(e, true));
    g.addEventListener('click', (e) => {
      if (!swallowClick) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }
  return true;
}

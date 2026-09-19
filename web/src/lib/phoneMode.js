// Phone mode — the one switch every narrow-viewport behaviour hangs off.
//
// Below PHONE_QUERY the page becomes map-first: the map fills the
// viewport, the sidebar becomes a bottom sheet (the `body.phone` rules at
// the end of style.css), and the results pane moves INTO the sheet so a
// search and its results share one scrollable surface. This module owns
// the class toggle, the DOM relocation, the sheet snap state and the
// top-bar menu; main.js calls initPhoneMode() once and reacts to onChange
// (the map container changes size, so MapLibre needs a resize()).
//
// Relocation rather than duplication: #results-wrap keeps its identity,
// so every $tbody / paginator / toolbar handle main.js captured at boot
// still points at a live element. Widening the window moves it back to
// exactly where it stood in the workspace.
//
// Sheet states (phase 1: tap the handle to cycle; a drag gesture with
// real snap points is the next step):
//   peek  — just the handle and the tab strip, the map owns the screen
//   half  — the search form, map still visible above (default)
//   full  — the whole sidebar, for long result lists and the layer groups

import { initSheetDrag } from './sheetDrag.js';
import { initResultCards } from './resultCards.js';

export const PHONE_QUERY = '(max-width: 767px)';
export const SHEET_STATES = ['peek', 'half', 'full'];
const DEFAULT_SHEET = 'half';

let mql = null;
// Where #results-wrap sat in the workspace before the first move. A text
// node is fine: insertBefore only needs it to still be a workspace child.
let desktopAnchor = null;
// The result-cards instance (lib/resultCards.js), once initPhoneMode ran.
let cards = null;

/**
 * A parcel tapped on the map: open and scroll to its card, and bring a
 * peeked sheet up so the card is on screen. Returns false when there is
 * no card for the key, so map.js can fall back to its popup.
 */
export function revealResultCard(key) {
  if (!cards || !cards.reveal(key)) return false;
  if (getSheetState() === 'peek') setSheetState(DEFAULT_SHEET);
  return true;
}

export function isPhone() {
  return typeof document !== 'undefined'
    && document.body.classList.contains('phone');
}

function relocateResults(phone) {
  const results = document.getElementById('results-wrap');
  const slot = document.getElementById('phone-results-slot');
  const workspace = document.getElementById('workspace');
  if (!results || !slot || !workspace) return;
  if (phone) {
    if (results.parentElement === slot) return;
    desktopAnchor = results.nextSibling;
    slot.appendChild(results);
  } else if (results.parentElement === slot) {
    const anchor = desktopAnchor && desktopAnchor.parentNode === workspace
      ? desktopAnchor
      : null;
    workspace.insertBefore(results, anchor);
  }
}

// The area-selection draw tools live in the top bar, which folds into a
// menu on the phone. They move onto the map instead (a floating column
// at the bottom-left, CSS under body.phone.sales-mode) and back to their
// exact top-bar position on a widen. drawShapes.js wires the buttons by
// id, so the move is invisible to it.
let shapeToolsHome = null;   // { parent, next } in the top bar
function relocateShapeTools(phone) {
  const tools = document.getElementById('shape-tools');
  const mapEl = document.getElementById('map');
  if (!tools || !mapEl) return;
  if (phone) {
    if (tools.parentElement === mapEl) return;
    shapeToolsHome = { parent: tools.parentElement, next: tools.nextSibling };
    mapEl.appendChild(tools);
  } else if (tools.parentElement === mapEl && shapeToolsHome?.parent) {
    const { parent, next } = shapeToolsHome;
    parent.insertBefore(tools, next && next.parentNode === parent ? next : null);
  }
}

function sidebarEl() {
  return document.querySelector('.sidebar');
}

export function getSheetState() {
  const s = sidebarEl();
  if (!s) return null;
  return SHEET_STATES.find((name) => s.classList.contains(`sheet-${name}`)) || null;
}

export function setSheetState(state) {
  if (!SHEET_STATES.includes(state)) return;
  const s = sidebarEl();
  if (!s) return;
  for (const name of SHEET_STATES) s.classList.toggle(`sheet-${name}`, name === state);
  s.dataset.sheet = state;
  // A drag leaves the sheet sized and translated inline (sheetDrag.js);
  // the state class is the resting truth, so the inline pair goes.
  s.style.height = '';
  s.style.transform = '';
  const handle = document.getElementById('sheet-handle');
  if (handle) {
    const next = SHEET_STATES[(SHEET_STATES.indexOf(state) + 1) % SHEET_STATES.length];
    handle.setAttribute('aria-label', `Search panel: ${state}. Tap to make it ${next}.`);
  }
  // Snapping to peek leaves the sheet's scroll position wherever it was;
  // pull it back to the top so the next expand shows the tab strip and
  // search fields, not the middle of the layer list.
  if (state === 'peek') s.scrollTop = 0;
}

/**
 * Every snap height in px at the current viewport, read from the CSS
 * state classes themselves so the numbers live in one place. Transitions
 * are switched off (the sheet-dragging class) for the measurement, so
 * offsetHeight reports each class's target rather than a mid-animation
 * value; nothing paints between the toggles.
 */
export function measureSnapHeights() {
  const s = sidebarEl();
  if (!s) return null;
  const cur = getSheetState();
  const hadDragging = s.classList.contains('sheet-dragging');
  s.classList.add('sheet-dragging');
  const out = {};
  for (const name of SHEET_STATES) {
    for (const n of SHEET_STATES) s.classList.toggle(`sheet-${n}`, n === name);
    out[name] = s.offsetHeight;
  }
  for (const n of SHEET_STATES) s.classList.toggle(`sheet-${n}`, n === cur);
  // Force the restored height to be computed while transitions are still
  // off. Otherwise the browser's last computed height is the final state
  // measured above, and switching transitions back on animates from
  // there — the sheet would visibly slide in from `full` after every
  // measurement.
  void s.offsetHeight;
  if (!hadDragging) s.classList.remove('sheet-dragging');
  return out;
}

export function cycleSheetState() {
  const cur = getSheetState() || DEFAULT_SHEET;
  const next = SHEET_STATES[(SHEET_STATES.indexOf(cur) + 1) % SHEET_STATES.length];
  setSheetState(next);
}

/** Bring the sheet up to at least `half` — used when results land while
 *  the user has it peeked down to look at the map. */
export function ensureSheetVisible() {
  if (!isPhone()) return;
  if (getSheetState() === 'peek') setSheetState(DEFAULT_SHEET);
}

function initTopbarMenu() {
  const topbar = document.querySelector('.topbar');
  const btn = document.getElementById('topbar-menu-btn');
  const nav = document.getElementById('topbar-nav');
  if (!topbar || !btn || !nav) return;
  const setOpen = (open) => {
    topbar.classList.toggle('menu-open', open);
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', () => setOpen(!topbar.classList.contains('menu-open')));
  // Choosing a link or button inside the menu closes it, so the map is
  // not left under the menu after "Property Data Status" opens its
  // dialog. The Data Sources <summary> is neither, so it can expand in
  // place.
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) setOpen(false);
  });
}

/**
 * Wire phone mode. `onChange(phone)` fires once at boot and again on
 * every crossing of the breakpoint (rotation, split view, desktop
 * resize). Returns a function reporting the current match.
 */
export function initPhoneMode({ onChange } = {}) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => false;
  }
  mql = window.matchMedia(PHONE_QUERY);
  initTopbarMenu();
  const handle = document.getElementById('sheet-handle');
  const tabs = document.querySelector('.sidebar-tabs');
  handle?.addEventListener('click', cycleSheetState);
  // The tab strip is visible in the peek state; picking a tab there means
  // "show me that tab", so bring the sheet up with it.
  tabs?.addEventListener('click', ensureSheetVisible);
  // Drag the handle or the tab strip to any snap; a tap still reaches the
  // click handlers above (sheetDrag.js swallows the click only after a
  // real drag).
  initSheetDrag({
    sheet: sidebarEl(),
    grabbers: [handle, tabs],
    measure: measureSnapHeights,
    onSnap: setSheetState,
  });
  // Result cards mirror the table while phone mode is on. A tapped card
  // has flown the map to its parcel, so a full-height sheet drops to
  // half to show it.
  cards = initResultCards({
    table: document.getElementById('results'),
    container: document.getElementById('result-cards'),
    isPhone,
    onTap: () => { if (getSheetState() === 'full') setSheetState(DEFAULT_SHEET); },
  });
  const apply = () => {
    const phone = mql.matches;
    document.body.classList.toggle('phone', phone);
    relocateResults(phone);
    relocateShapeTools(phone);
    if (phone && !getSheetState()) setSheetState(DEFAULT_SHEET);
    cards?.render();
    if (typeof onChange === 'function') onChange(phone);
  };
  apply();
  mql.addEventListener('change', apply);
  return () => mql.matches;
}

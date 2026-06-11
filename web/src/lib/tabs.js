/*
 * Sidebar tab switcher. Wires the tab buttons to their matching
 * panels, persists the last-active tab to localStorage, and
 * focuses the active tab's primary input on switch (so a keyboard
 * user can start typing immediately).
 *
 * Tabs are identified by their `data-tab` attribute. Panels carry
 * a matching `data-tab` and the `role="tabpanel"` ARIA pairing.
 *
 * Arrow-key support: ← / → cycle through the tab buttons when
 * focus is on one of them. Home / End jump to the first / last.
 */

const STORAGE_KEY = 'wps_sidebar_tab_v1';
const DEFAULT_TAB = 'property';

// Each tab's primary input is what gets focused on activation —
// the field the user is most likely to want to type into first.
// Map layers live in an always-visible section below the tabs,
// so they're not in this map.
const PRIMARY_INPUT_BY_TAB = {
  property: '#address-from',
  sales: '#sales-dropzone',
};

let activeTab = DEFAULT_TAB;
const listeners = new Set();

// Kept available as `_readStored` for the historical-debug case where a
// developer wants to honour the previously-active tab on a fresh load.
// initSidebarTabs deliberately ignores the persisted value (see comment
// at the bottom of this file) — _-prefix marks it as opt-in dead code
// per the lint config's varsIgnorePattern.
function _readStored() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && document.querySelector(`.sidebar-tab[data-tab="${stored}"]`)) {
      return stored;
    }
  } catch { /* localStorage disabled */ }
  return null;
}

function writeStored(name) {
  try { localStorage.setItem(STORAGE_KEY, name); } catch { /* ignore */ }
}

function tabButtons() {
  return Array.from(document.querySelectorAll('.sidebar-tab'));
}

function tabPanels() {
  return Array.from(document.querySelectorAll('.sidebar-tab-panel'));
}

function focusPrimary(name, { skipFocus = false } = {}) {
  if (skipFocus) return;
  const sel = PRIMARY_INPUT_BY_TAB[name];
  if (!sel) return;
  const el = document.querySelector(sel);
  if (!el || el.disabled) return;
  requestAnimationFrame(() => {
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  });
}

/**
 * Activate the named tab. Idempotent — re-activating the current
 * tab still re-applies ARIA + focus state, which is useful when
 * callers want to re-focus the primary input.
 */
export function setActiveTab(name, { skipFocus = false, skipStore = false } = {}) {
  const btns = tabButtons();
  const panels = tabPanels();
  if (!btns.length || !panels.length) return;
  if (!btns.some((b) => b.dataset.tab === name)) name = DEFAULT_TAB;
  activeTab = name;
  for (const btn of btns) {
    const isActive = btn.dataset.tab === name;
    btn.setAttribute('aria-selected', String(isActive));
    btn.tabIndex = isActive ? 0 : -1;
  }
  for (const panel of panels) {
    panel.hidden = panel.dataset.tab !== name;
  }
  if (!skipStore) writeStored(name);
  focusPrimary(name, { skipFocus });
  for (const fn of listeners) {
    try { fn(name); } catch (err) { console.warn('tab listener failed', err); }
  }
}

/** Read the currently-active tab name. */
export function getActiveTab() {
  return activeTab;
}

/** Register a callback for tab changes. Returns an unsubscribe fn. */
export function onTabChange(fn) {
  if (typeof fn === 'function') listeners.add(fn);
  return () => listeners.delete(fn);
}

function onTabKeyDown(e) {
  const btns = tabButtons();
  const idx = btns.indexOf(document.activeElement);
  if (idx < 0) return;
  let target = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    target = btns[(idx + 1) % btns.length];
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    target = btns[(idx - 1 + btns.length) % btns.length];
  } else if (e.key === 'Home') {
    target = btns[0];
  } else if (e.key === 'End') {
    target = btns[btns.length - 1];
  }
  if (target) {
    target.focus();
    setActiveTab(target.dataset.tab);
    e.preventDefault();
  }
}

/**
 * Wire up the sidebar tabs. Returns false if the markup isn't
 * present (so callers can no-op without crashing on stripped-down
 * embeds or test pages).
 *
 * Always boots on the Property Search tab. The user's session can
 * still switch tabs (persisted to localStorage), but a fresh page
 * load never lands on Sales Analysis even if that was the last
 * active tab — avoids the "I last looked at Sales three days ago
 * and the app stays there" footgun. URL state with ?t=sales
 * overrides this since applyUrlState runs after init.
 */
export function initSidebarTabs() {
  const btns = tabButtons();
  if (!btns.length) return false;
  for (const btn of btns) {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
    btn.addEventListener('keydown', onTabKeyDown);
  }
  setActiveTab(DEFAULT_TAB, { skipFocus: true });
  return true;
}

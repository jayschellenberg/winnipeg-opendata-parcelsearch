/*
 * Results-table column visibility. Walks the thead's data-col
 * attributes to enumerate every column, then maintains TWO Sets
 * of visible keys (one per mode: 'property' / 'sales') so the
 * Sales Analysis tab can ship a different default-visible set
 * than the Property Search tab.
 *
 * Each mode's visible-set persists to its own localStorage key —
 * so the appraiser's gear-customizations in sales mode don't
 * trample their property-mode preferences and vice versa.
 *
 * Four presets are baked in:
 *   - Quick lookup:    lot, block, plan, roll, address, area, walk
 *   - Zoning detail:   lot, block, plan, roll, address, zoning,
 *                      zoningPct, zoning2, area, walk
 *   - Full detail:     null (everything)
 *   - Sales analysis:  the sales-mode default (roll, address,
 *                      saleDate, useCode, livingArea, yearBuilt,
 *                      area, propertyType, groupSize, salePrice,
 *                      pricePerSf, saleToAsmt, dist)
 *
 * Quick lookup is the property-mode default; Sales analysis is the
 * sales-mode default. The active mode is controlled via setMode()
 * — main.js calls setMode('sales') from runSalesAnalysis and
 * setMode('property') from runSearch.
 */

const STORAGE_KEY_PROPERTY = 'wps_table_columns_v1';
const STORAGE_KEY_SALES    = 'wps_table_columns_sales_v1';

const QUICK_LOOKUP = ['lot', 'block', 'plan', 'roll', 'address', 'area', 'walk'];
const ZONING_DETAIL = [
  'lot', 'block', 'plan', 'roll', 'address',
  'zoning', 'zoningPct', 'zoning2', 'area', 'walk',
];
const SALES_DEFAULT = [
  'roll', 'address', 'saleDate', 'useCode',
  'livingArea', 'yearBuilt', 'area',
  'propertyType', 'groupSize',
  'salePrice', 'pricePerSf', 'saleToAsmt', 'dist',
];

export const DEFAULT_VISIBLE = new Set(QUICK_LOOKUP);

export const PRESETS = {
  'Quick lookup':    new Set(QUICK_LOOKUP),
  'Zoning detail':   new Set(ZONING_DETAIL),
  'Full detail':     null,
  'Sales analysis':  new Set(SALES_DEFAULT),
};

// Per-mode visible sets. Each entry can be null (Full detail =
// everything visible) or a Set of column keys.
let mode = 'property';
const visibleByMode = {
  property: new Set(QUICK_LOOKUP),
  sales:    new Set(SALES_DEFAULT),
};
const listeners = new Set();

function storageKeyForMode(m) {
  return m === 'sales' ? STORAGE_KEY_SALES : STORAGE_KEY_PROPERTY;
}

function readStored(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed === null) return null;             // Full detail
    if (!Array.isArray(parsed)) return undefined; // malformed -> defaults
    return new Set(parsed);
  } catch { return undefined; }
}

function writeStored() {
  try {
    const v = visibleByMode[mode];
    const payload = v == null ? null : [...v];
    localStorage.setItem(storageKeyForMode(mode), JSON.stringify(payload));
  } catch { /* localStorage quota or disabled — silently no-op */ }
}

function emit() {
  for (const fn of listeners) {
    try { fn(visibleByMode[mode]); } catch (err) { console.warn('columns listener failed', err); }
  }
}

/** Switch the active mode and reapply visibility. Idempotent. */
export function setMode(name) {
  if (name !== 'sales' && name !== 'property') return;
  if (mode === name) return;
  mode = name;
  applyVisibility();
  emit();
}

export function getMode() { return mode; }

/**
 * Enumerate every column key from the thead. Multiple ths can
 * share the same data-col; deduped here.
 */
export function listAllColumns() {
  const seen = new Map();
  for (const th of document.querySelectorAll('#results thead th[data-col]')) {
    const key = th.dataset.col;
    if (!seen.has(key)) {
      seen.set(key, {
        key,
        label: th.textContent.replace(/[⇅▲▼]/g, '').trim() || key,
      });
    }
  }
  return [...seen.values()];
}

export function isColumnVisible(key) {
  // `null` set = full-detail mode; treat as everything visible.
  const v = visibleByMode[mode];
  return v == null ? true : v.has(key);
}

export function setColumnVisible(key, on) {
  if (visibleByMode[mode] == null) visibleByMode[mode] = new Set();
  if (on) visibleByMode[mode].add(key);
  else visibleByMode[mode].delete(key);
  writeStored();
  applyVisibility();
  emit();
}

export function applyPreset(name) {
  const preset = PRESETS[name];
  if (preset === undefined) return; // unknown
  visibleByMode[mode] = preset == null ? null : new Set(preset);
  writeStored();
  applyVisibility();
  emit();
}

/**
 * Apply the active mode's visible-set to the live DOM. Idempotent;
 * safe to call after each table render so newly-built rows pick
 * up the hidden state.
 */
export function applyVisibility() {
  const heads = Array.from(document.querySelectorAll('#results thead th'));
  if (!heads.length) return;
  const hiddenAt = heads.map((th) => {
    const key = th.dataset.col;
    if (!key) return false;
    return !isColumnVisible(key);
  });
  heads.forEach((th, i) => {
    th.classList.toggle('col-hidden', hiddenAt[i]);
  });
  for (const row of document.querySelectorAll('#results tbody tr')) {
    const cells = row.children;
    for (let i = 0; i < cells.length && i < hiddenAt.length; i++) {
      cells[i].classList.toggle('col-hidden', hiddenAt[i]);
    }
  }
}

export function onColumnsChange(fn) {
  if (typeof fn === 'function') listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Wire up the column-visibility gear popover + presets dropdown.
 * Reads stored visibility from localStorage (per-mode); falls back
 * to each mode's preset default on first load. Returns false if
 * the toolbar markup isn't present.
 */
export function initColumns() {
  // Read each mode's persisted set; if missing, keep the default.
  const storedProperty = readStored(STORAGE_KEY_PROPERTY);
  if (storedProperty !== undefined) visibleByMode.property = storedProperty;
  const storedSales = readStored(STORAGE_KEY_SALES);
  if (storedSales !== undefined) visibleByMode.sales = storedSales;

  // One-time additive migration: when Walkscore was added to the
  // default Quick lookup preset, existing localStorage stores didn't
  // include it. Add it to the property-mode stored set (if any)
  // exactly once, gated by a separate flag so the user can still
  // hide it via the gear popover and have that stick.
  try {
    const WALK_FLAG = 'wps_table_columns_walk_migrated_v1';
    if (!localStorage.getItem(WALK_FLAG)) {
      const s = visibleByMode.property;
      if (s instanceof Set && !s.has('walk')) {
        s.add('walk');
        const m0 = mode;
        mode = 'property';
        writeStored();
        mode = m0;
      }
      localStorage.setItem(WALK_FLAG, '1');
    }
  } catch { /* localStorage disabled — first-load defaults already include walk */ }

  const gear = document.getElementById('columns-gear');
  const popover = document.getElementById('columns-popover');
  const presetSelect = document.getElementById('columns-preset');
  if (!gear || !popover) return false;

  function buildChecklist() {
    popover.innerHTML = '';
    for (const { key, label } of listAllColumns()) {
      const wrap = document.createElement('label');
      wrap.className = 'columns-popover-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isColumnVisible(key);
      cb.dataset.colKey = key;
      cb.addEventListener('change', () => setColumnVisible(key, cb.checked));
      const span = document.createElement('span');
      span.textContent = label;
      wrap.appendChild(cb);
      wrap.appendChild(span);
      popover.appendChild(wrap);
    }
  }
  buildChecklist();

  gear.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = popover.classList.toggle('open');
    gear.setAttribute('aria-expanded', String(open));
    if (open) buildChecklist();
  });
  document.addEventListener('click', (e) => {
    if (!popover.classList.contains('open')) return;
    if (popover.contains(e.target) || gear.contains(e.target)) return;
    popover.classList.remove('open');
    gear.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popover.classList.contains('open')) {
      popover.classList.remove('open');
      gear.setAttribute('aria-expanded', 'false');
    }
  });

  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      const name = presetSelect.value;
      if (!name) return;
      applyPreset(name);
      buildChecklist();
      presetSelect.value = '';
    });
  }

  // Rebuild the checklist on mode change so the gear popover stays
  // in sync with whatever set is now active.
  onColumnsChange(() => buildChecklist());

  applyVisibility();
  return true;
}

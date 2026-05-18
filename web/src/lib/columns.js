/*
 * Results-table column visibility. Walks the thead's data-col
 * attributes to enumerate every column, then maintains a Set of
 * visible keys persisted to localStorage. Applies visibility by
 * stamping `.col-hidden` on both the matching th(s) AND every td
 * in those columns (positionally matched, since the tds don't
 * carry their own data-col attribute).
 *
 * Three presets are baked in (Phase 5 decision):
 *   - Quick lookup: lot, block, plan, roll, address, area
 *   - Zoning detail: lot, block, plan, roll, address, zoning,
 *     zoningPct, zoning2, area
 *   - Full detail: null (everything)
 *
 * Quick lookup is also the default-visible set on first load.
 */

const STORAGE_KEY = 'wps_table_columns_v1';

// Phase 5 default-visible set = the Quick lookup preset. Lifted to
// a const so the preset map can re-use it without duplicating.
const QUICK_LOOKUP = ['lot', 'block', 'plan', 'roll', 'address', 'area'];
const ZONING_DETAIL = [
  'lot', 'block', 'plan', 'roll', 'address',
  'zoning', 'zoningPct', 'zoning2', 'area',
];

export const DEFAULT_VISIBLE = new Set(QUICK_LOOKUP);

// Column presets — `null` value means "everything that the current
// mode would show" (Full detail). Keys match the dropdown options.
export const PRESETS = {
  'Quick lookup':  new Set(QUICK_LOOKUP),
  'Zoning detail': new Set(ZONING_DETAIL),
  'Full detail':   null,
};

let visible = new Set(DEFAULT_VISIBLE);
const listeners = new Set();

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return new Set(arr);
  } catch { return null; }
}

function writeStored() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...visible]));
  } catch { /* localStorage quota or disabled — silently no-op */ }
}

function emit() {
  for (const fn of listeners) {
    try { fn(visible); } catch (err) { console.warn('columns listener failed', err); }
  }
}

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
  // `null` preset = full-detail mode; treat as everything visible.
  return visible == null ? true : visible.has(key);
}

export function setColumnVisible(key, on) {
  if (visible == null) visible = new Set();
  if (on) visible.add(key);
  else visible.delete(key);
  writeStored();
  applyVisibility();
  emit();
}

export function applyPreset(name) {
  const preset = PRESETS[name];
  if (preset === undefined) return; // unknown
  visible = preset == null ? null : new Set(preset);
  writeStored();
  applyVisibility();
  emit();
}

/**
 * Apply the current visible-set to the live DOM. Idempotent;
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
 * Reads stored visibility from localStorage; falls back to the
 * default-visible set on first load. Returns false if the toolbar
 * markup isn't present.
 */
export function initColumns() {
  const stored = readStored();
  if (stored) visible = stored;
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

  applyVisibility();
  return true;
}

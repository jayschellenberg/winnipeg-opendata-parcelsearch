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
 * The baked-in presets:
 *   - Quick lookup:    lot, block, plan, roll, address, water, area
 *   - Residential:     roll, address, buildingType, yearBuilt,
 *                      livingArea, rooms, dwellingUnits, area, zoning,
 *                      water, value
 *   - Zoning detail:   lot, block, plan, roll, address, zoning,
 *                      zoningPct, zoning2, area
 *   - Full detail:     null (everything)
 *   - Sales analysis:  the sales-mode default (roll, address,
 *                      saleDate, useCode, livingArea, yearBuilt,
 *                      area, propertyType, groupSize, salePrice,
 *                      pricePerSf, saleToAsmt, dist, n1Id)
 *   - Commercial Sales / Land Sales: comp-set presets, see the
 *                      literals below for what each carries and why
 *
 * The map-badge "#" column (`seq`) is deliberately outside this whole
 * mechanism — see UNGOVERNED below.
 *
 * Quick lookup is the property-mode default; Sales analysis is the
 * sales-mode default. The active mode is controlled via setMode()
 * — main.js calls setMode('sales') from runSalesAnalysis and
 * setMode('property') from runSearch.
 */

const STORAGE_KEY_PROPERTY = 'wps_table_columns_v1';
const STORAGE_KEY_SALES    = 'wps_table_columns_sales_v1';

/*
 * Columns added AFTER a user's stored sales visible-set may have been
 * written. A stored set predating a column cannot contain it, and the
 * stored set wins over SALES_DEFAULT — so a newly-added column would
 * stay invisible for exactly the people who have used the app before.
 * Each key here is added to the stored SALES set once (tracked in
 * ADOPTED_KEY); untick it after that and it stays unticked.
 */
const ADOPTED_KEY = 'wps_table_columns_adopted_v1';
const ADOPT_ONCE_SALES = ['n1Id', 'demo', 'demoDate', 'built', 'builtDate', 'source',
  // Split out of Units, which used to render SABRE's suite identifier as
  // if it were a unit count. Existing users carry a stored set that
  // predates it, so without this the label they lost never comes back.
  'unitLabel',
  // Category is the grouping the comp search now runs on, so it has to
  // reach existing users rather than waiting for them to find the gear.
  // useCodeName rides with it: a code column whose meaning is only
  // available on a tooltip is not much of an answer to "what is RESMC".
  'category', 'useCodeName'];

/*
 * Columns this module does not govern. `seq` (the map badge "#") is gated
 * solely by the "Number parcels" toggle, via a `body.numbering-on` CSS
 * rule — so it must never also be marked col-hidden here, and it isn't
 * offered in the gear popover (a checkbox that can't win is worse than no
 * checkbox).
 *
 * An exemption rather than a membership in every preset, because presets
 * are only half the story: the visible-set PERSISTS to localStorage, so
 * every existing user carries a stored set that predates this column.
 * Adding `seq` to the preset literals would leave the "#" column hidden
 * for exactly the people who have used the app before — which is
 * everyone. The exemption is read at query time and has no such gap.
 */
const UNGOVERNED = new Set(['seq']);

const QUICK_LOOKUP = ['lot', 'block', 'plan', 'roll', 'address', 'water', 'area'];
// Residential property search: what actually matters on a house — the
// dwelling itself (type, age, floor area, rooms, units), the lot, its
// zoning and water influence, and the assessment. Deliberately omits
// the legal-description columns (Lot/Block/Plan) and the sales-only
// columns, neither of which a residential lookup is asking about.
const RESIDENTIAL = [
  'roll', 'address', 'buildingType', 'yearBuilt', 'livingArea',
  'rooms', 'dwellingUnits', 'area', 'zoning', 'water', 'value',
];
const ZONING_DETAIL = [
  'lot', 'block', 'plan', 'roll', 'address',
  'zoning', 'zoningPct', 'zoning2', 'area',
];
const SALES_DEFAULT = [
  // Category leads the classification columns because it is what the
  // sidebar's Category picker filters on — a default preset that hides it
  // would leave the grid being narrowed by a value the grid never shows.
  'roll', 'address', 'cluster', 'water', 'saleDate', 'category', 'useCode', 'useCodeName',
  'livingArea', 'yearBuilt', 'area',
  'propertyType', 'groupSize',
  // Sworn is on by default: it only renders when it DIFFERS from the
  // sale price, so on an ordinary comp set the column sits empty, and
  // when it does fill in it is flagging a nominal-price transfer the
  // appraiser must not read as a market sale.
  'salePrice', 'swornValue', 'pricePerSf', 'saleToAsmt', 'dist',
  // Default-visible because spotting comps not yet in N1 is the point of
  // the crosswalk — a hidden column can't be a work queue.
  'n1Id',
];

// Commercial comp set: identity + the sale + the structure + zoning /
// size / assessment. Deliberately carries NO unit-rate column and no
// Dist — a $/Lot SF invites comparing building-value properties by
// land rate (the MB Commercial Sales preset's rationale, kept here).
const COMMERCIAL_SALES = [
  'roll', 'address', 'cluster', 'saleDate', 'salePrice', 'swornValue',
  'category', 'useCode', 'propertyType', 'buildingType', 'yearBuilt', 'livingArea',
  'pricePerBldgSf',
  // A teardown hiding in an improved comp set is exactly what this
  // preset must not let through unnoticed.
  'demo', 'demoDate',
  'numUnits', 'unitLabel', 'area', 'saleZoning', 'value', 'n1Id', 'instrument',
];
// Bare-land comp set: the lot, its rate, water influence and zoning;
// building columns are noise on a land sale.
const LAND_SALES = [
  'roll', 'address', 'cluster', 'saleDate', 'salePrice', 'swornValue',
  'area', 'saleAcres', 'pricePerSf', 'pricePerAcre', 'pricePerLot',
  // The column that keeps finished houses out of a land comp set.
  'built', 'builtDate',
  'category',
  'saleZoning', 'zoning', 'water',
  'saleToAsmt', 'dist', 'value', 'n1Id',
];

// Commercial comps with the MLS half attached: what it listed for, how
// long it took, and how the building was described — the questions a
// commercial report has to answer and SABRE alone cannot.
const MLS_SALES = [
  'roll', 'address', 'cluster', 'source', 'saleDate', 'mlsDate',
  'salePrice', 'listPrice', 'origPrice', 'dom',
  'useCode', 'propertyType', 'bldgType', 'style', 'siteInfl',
  'yearBuilt', 'livingArea', 'pricePerBldgSf', 'numUnits', 'unitLabel',
  'area', 'saleZoning', 'demo', 'built', 'n1Id', 'mlsNumber',
];

export const DEFAULT_VISIBLE = new Set(QUICK_LOOKUP);

export const PRESETS = {
  'Quick lookup':    new Set(QUICK_LOOKUP),
  'Residential':     new Set(RESIDENTIAL),
  'Zoning detail':   new Set(ZONING_DETAIL),
  'Full detail':     null,
  'Sales analysis':  new Set(SALES_DEFAULT),
  'Commercial Sales': new Set(COMMERCIAL_SALES),
  'MLS Sales':        new Set(MLS_SALES),
  'Land Sales':       new Set(LAND_SALES),
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
    if (UNGOVERNED.has(key)) continue;   // not ours to show or hide
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
  // Ungoverned columns are never marked col-hidden — something else owns
  // their visibility (see UNGOVERNED).
  if (UNGOVERNED.has(key)) return true;
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

  // One-time adoption of columns newer than the stored sales set. Writes
  // STORAGE_KEY_SALES directly rather than via writeStored(): the active
  // mode is still 'property' at init, and writeStored() persists whichever
  // mode is active.
  try {
    const adopted = new Set(JSON.parse(localStorage.getItem(ADOPTED_KEY) || '[]'));
    let changed = false;
    for (const key of ADOPT_ONCE_SALES) {
      if (adopted.has(key)) continue;
      adopted.add(key);
      // A null set is Full detail — the column is already visible there.
      if (visibleByMode.sales != null) visibleByMode.sales.add(key);
      changed = true;
    }
    if (changed) {
      localStorage.setItem(ADOPTED_KEY, JSON.stringify([...adopted]));
      const v = visibleByMode.sales;
      localStorage.setItem(STORAGE_KEY_SALES, JSON.stringify(v == null ? null : [...v]));
    }
  } catch { /* localStorage unavailable — defaults already include the keys */ }

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

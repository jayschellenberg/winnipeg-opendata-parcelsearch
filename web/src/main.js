// Entry point. Wires the seven search inputs, the map, and the results table.
//
// Two search flows:
//
//   Legal-description flow (any of Lot/Block/Plan/Description filled,
//   and no assessment-side field filled):
//     1. Live query Survey Parcels (soda.searchSurveyParcels).
//     2. Immediately render survey results to the map and a placeholder
//        table so the user sees something right away.
//     3. In parallel, fetch Assessment Parcels inside the result bbox and
//        join them to the survey parcels via turf.js.
//     4. Re-render the table with the enriched columns (Roll / Address /
//        Zoning).
//     → Map shows Survey Parcels geometry.
//
//   Assessment-first flow (any of Roll # / Address / Zoning filled):
//     1. Live query Assessment Parcels (soda.searchAssessmentParcels) —
//        any provided roll/address/zoning filters are ANDed together.
//     2. Immediately render assessment results to the map and a table
//        with the roll/address/zoning columns filled in.
//     3. In parallel, fetch Survey Parcels inside the result bbox and
//        join them so the lot/block/plan/description columns can be
//        back-filled.
//     4. Re-render the table.
//     → Map shows Assessment Parcels geometry.
//
// If any assessment-side field is filled, the assessment-first flow wins
// and the legal-description fields are ignored — it's the more specific
// query and the two datasets don't share attribute columns so they can't
// be combined in one SoQL where-clause.

import './lib/tailwind.css';
import { initChipInput } from './lib/chipInput.js';
import { initInfoIcons } from './lib/infoIcon.js';
import { initColumns, applyVisibility as applyColumnVisibility, setMode as setColumnMode } from './lib/columns.js';
import { formatSqFt } from './lib/format.js';
import { encodeState, decodeState } from './lib/urlState.js';
import { initSidebarTabs, setActiveTab, onTabChange } from './lib/tabs.js';
import bbox from '@turf/bbox';
import {
  searchSurveyParcels,
  fetchAssessmentOverlap,
  joinSurveyWithAssessment,
  searchAssessmentParcels,
  searchAssessmentParcelsExpanded,
  fetchSurveyOverlap,
  joinAssessmentWithSurvey,
  fetchZoningOverlap,
  fetchCityZoning,
  computePartialSurveyIds,
  enrichAssessmentAddresses,
  enrichAssessmentZoning,
  filterMatchedSurveys,
  filterMatchedAssessments,
  fetchSecondaryPlans,
  fetchInfillGuidelineArea,
  fetchMallsAndCorridors,
  fetchCityOwnedParcels,
  fetchTransitRoutes,
  fetchTransitStops,
  fetchNeighbourhoods,
  fetchNeighbourhoodClusters,
  fetchTrafficVolumes,
  fetchContaminatedSites,
} from './soda.js';
import {
  initMap, showResults, setZoningData, setZoningVisible, flyToFeature,
  setOverlayData, setOverlayVisible, ZONING_PALETTE, setCivicAddresses,
  setDimensions, setDimensionsVisible, setTrafficData, setTrafficVisible,
  setCitywideParcelsVisible, probeCitywideParcels,
  setContamData, setContamVisible,
  setSubjectData,
} from './map.js';

const $lot = document.getElementById('lot');
const $block = document.getElementById('block');
const $plan = document.getElementById('plan');
const $desc = document.getElementById('desc');
const $roll = document.getElementById('roll');
const $addressFrom = document.getElementById('address-from');
const $addressTo = document.getElementById('address-to');
const $addressStreet = document.getElementById('address-street');
const $zoning = document.getElementById('zoning');
const $duMode = document.getElementById('du-mode');
const $duMin = document.getElementById('du-min');
const $search = document.getElementById('search');
const $clear = document.getElementById('clear');
const $export = document.getElementById('export');
const $zoningToggle = document.getElementById('zoning-toggle');
const $trafficToggle = document.getElementById('traffic-toggle');
const $surveyToggle = document.getElementById('survey-toggle');
const $assessToggle = document.getElementById('assess-toggle');
const $secondaryPlansToggle = document.getElementById('secondary-plans-toggle');
const $infillToggle         = document.getElementById('infill-toggle');
const $mallsCorridorsToggle = document.getElementById('malls-corridors-toggle');
const $cityOwnedParcelsToggle = document.getElementById('city-owned-parcels-toggle');
const $transitToggle        = document.getElementById('transit-toggle');
const $neighbourhoodsToggle = document.getElementById('neighbourhoods-toggle');
const $dimensionsToggle     = document.getElementById('dimensions-toggle');
const $allParcelsToggle     = document.getElementById('all-parcels-toggle');
const $contamToggle         = document.getElementById('contam-toggle');
const $count = document.getElementById('count');
const $tbody = document.querySelector('#results tbody');
const $mapEl = document.getElementById('map');
const $staticMapBtn = document.getElementById('static-map-btn');
const $staticMapOutput = document.getElementById('static-map-output');
const $zoningLegend = document.getElementById('zoning-legend');
const $trafficLegend = document.getElementById('traffic-legend');

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// Most recent table rows, kept around for CSV export.
let currentRows = [];

// Map of row key -> feature for the table-row → map-fly handler. The key
// is the same string we put on data-row-key (e.g. "a:13052686500"); the
// feature we fly to is whichever side has geometry that's most useful
// (assessment if available, else survey). Cleared on every renderTable.
const rowFeatureMap = new Map();

// Zoning overlay state. `enabled` reflects the toggle button; `parcelFc`
// is the most recent parcel FC drawn on the map, kept so the toggle can
// fetch zones for the current results without re-running the search.
let zoningEnabled = false;
let lastParcelFc = null;
let lastSurveyFc = { type: 'FeatureCollection', features: [] };
let trafficEnabled = false;
let trafficLoaded = false;
let contamEnabled = false;
let contamLoaded = false;

// Phase 8 TDZ audit: these three were previously declared mid-file
// next to their toggle handlers. Hoisted up here so the Phase 8 (2/2)
// applyUrlState() can synchronously click any toggle button at init
// without tripping a Cannot access 'X' before initialization throw.
const policyOverlayState = {
  secondaryPlans:    { enabled: false, loaded: false },
  infill:            { enabled: false, loaded: false },
  mallsCorridors:    { enabled: false, loaded: false },
  cityOwnedParcels:  { enabled: false, loaded: false },
};
// Transit (routes + stops) is a single user-facing toggle backed
// by two GeoJSON sources. Kept outside policyOverlayState because
// the framework assumes 1 toggle = 1 source; transit has its own
// dedicated toggle function below.
let transitEnabled = false;
let transitLoaded = false;

// Neighbourhoods 3-state cycle:
//   'off'         — nothing shown (default)
//   'clusters'    — 23 cluster polygons + labels
//   'individual'  — 235 neighbourhood polygons + labels
// Loaded flags are independent because the two GeoJSON files
// are fetched on first reveal of their respective state.
let neighbourhoodsMode = 'off';
let neighbourhoodsLoaded = { clusters: false, individual: false };
let dimensionsEnabled = false;
let citywideParcelsEnabled = false;

// ---------- Column sort ----------

let currentSort = { col: 'roll', dir: 'asc' };

// Maps each data-col key to a function that extracts a comparable value from
// a row. Strings lower-cased; numbers use -Infinity so nulls sort last.
const SORT_KEYS = {
  lot:     (r) => numOrStr(r.survey?.properties?.lot),
  block:   (r) => strKey(r.survey?.properties?.block),
  plan:    (r) => numOrStr(r.survey?.properties?.plan),
  desc:    (r) => strKey(r.survey?.properties?.description),
  roll:    (r) => strKey(r.assess?.properties?.roll_number),
  address: (r) => strKey(r.assess?.properties?.full_address),
  zoning:    (r) => strKey(r.assess?.properties?.zoning_top1 ?? r.assess?.properties?.zoning),
  zoningPct: (r) => finiteOrNeg(r.assess?.properties?.zoning_top1_pct),
  zoning2:   (r) => strKey(r.assess?.properties?.zoning_top2),
  area:    (r) => finiteOrNeg(r.assess?.properties?.assessed_land_area),
  lat:     (r) => finiteOrNeg(r.assess?.properties?.centroid_lat),
  lon:     (r) => finiteOrNeg(r.assess?.properties?.centroid_lon),
  value:   (r) => finiteOrNeg(r.assess?.properties?.total_assessed_value),
  // Walkscore + Flood are link-only columns; they don't sort meaningfully.
  // Use the raw address as a placeholder key so click-to-sort doesn't error.
  walk:    (r) => strKey(r.assess?.properties?.full_address),
  flood:   (r) => strKey(r.assess?.properties?.full_address),
  // Phase 7 sales-mode sortable columns.
  saleDate:     (r) => strKey(r.assess?.properties?._saleDate),
  salePrice:    (r) => finiteOrNeg(r.assess?.properties?._salePrice),
  pricePerSf:   (r) => finiteOrNeg(r.assess?.properties?._pricePerSf),
  saleToAsmt:   (r) => finiteOrNeg(r.assess?.properties?._saleToAsmt),
  dist:         (r) => finiteOrNeg(r.assess?.properties?._dist),
  useCode:      (r) => strKey(r.assess?.properties?._saleUseCode),
  livingArea:   (r) => finiteOrNeg(r.assess?.properties?._saleLivingArea),
  yearBuilt:    (r) => numOrStr(r.assess?.properties?._saleYearBuilt),
  instrument:   (r) => strKey(r.assess?.properties?._saleInstrument),
  propertyType: (r) => strKey(r.assess?.properties?._salePropertyType),
  groupSize:    (r) => finiteOrNeg(r.assess?.properties?._saleGroupSize),
};

// Numeric-smart string key: if the value looks like a number, compare it
// numerically so "9" < "10" instead of "9" > "10" (lexicographic pitfall).
function numOrStr(v) {
  if (v == null || v === '') return '\uffff'; // sort blanks last
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v).toLowerCase();
}

function strKey(v) {
  return (v == null || v === '') ? '\uffff' : String(v).toLowerCase();
}

function finiteOrNeg(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : -Infinity;
}

function sortRows(rows) {
  const { col, dir } = currentSort;
  const key = SORT_KEYS[col];
  if (!key) return rows;
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    // Always push blanks/nulls to the end regardless of sort direction.
    const aBlank = ka === '\uffff' || ka === -Infinity;
    const bBlank = kb === '\uffff' || kb === -Infinity;
    if (aBlank && bBlank) return 0;
    if (aBlank) return 1;
    if (bBlank) return -1;
    if (ka < kb) return -mul;
    if (ka > kb) return mul;
    return 0;
  });
}

// Update aria-sort and visual indicator on all sortable headers.
function updateSortIndicators() {
  for (const th of document.querySelectorAll('#results th[data-col]')) {
    if (th.dataset.col === currentSort.col) {
      th.setAttribute('aria-sort', currentSort.dir === 'asc' ? 'ascending' : 'descending');
    } else {
      th.removeAttribute('aria-sort');
    }
  }
}

const { map, ready: mapReady } = initMap($mapEl, {
  onFeatureClick: scrollToRow,
});

$search.addEventListener('click', runSearch);
$clear.addEventListener('click', clearAll);
$export.addEventListener('click', exportCsv);
$zoningToggle.addEventListener('click', toggleZoning);
$trafficToggle.addEventListener('click', toggleTraffic);
$surveyToggle.addEventListener('click', () => toggleLayer('survey'));
$assessToggle.addEventListener('click', () => toggleLayer('assess'));
$secondaryPlansToggle.addEventListener('click', () => togglePolicyOverlay('secondaryPlans'));
$infillToggle.addEventListener('click',         () => togglePolicyOverlay('infill'));
$mallsCorridorsToggle.addEventListener('click', () => togglePolicyOverlay('mallsCorridors'));
$cityOwnedParcelsToggle.addEventListener('click', () => togglePolicyOverlay('cityOwnedParcels'));
if ($transitToggle) $transitToggle.addEventListener('click', toggleTransit);
if ($neighbourhoodsToggle) $neighbourhoodsToggle.addEventListener('click', cycleNeighbourhoods);
$dimensionsToggle.addEventListener('click', toggleDimensions);
$allParcelsToggle.addEventListener('click', toggleCitywideParcels);
if ($contamToggle) $contamToggle.addEventListener('click', toggleContam);
if ($staticMapBtn) $staticMapBtn.addEventListener('click', generateStaticMap);
// Tab-into-To auto-fill: when the user types a number in From and
// then focuses To (by Tab or click), pre-fill To with the same value
// and select it. Default behaviour for typing a single number is
// thus "exact match"; the user can immediately type to overwrite for
// a range, or clear for an open upper bound. Matches the MB tool.
$addressTo.addEventListener('focus', () => {
  if ($addressTo.value === '' && $addressFrom.value.trim() !== '') {
    $addressTo.value = $addressFrom.value.trim();
    // Defer .select() so it runs after the focus event finishes
    // claiming the field — without the timeout some browsers
    // re-collapse the selection on the trailing focus tick.
    setTimeout(() => $addressTo.select(), 0);
  }
});

// Phase 5: #roll is a chip-input now; the chip wrapper handles its
// own Enter (commit chip) and forwards Enter-on-empty to runSearch
// via the onEnterEmpty callback below. Every other input still binds
// keydown directly so a stray Enter runs the search.
for (const el of [$lot, $block, $plan, $desc, $addressFrom, $addressTo, $addressStreet, $zoning, $duMin]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
}

// Phase 7: sidebar tabs (Property Search + Sales Analysis). The
// tab strip + panels live in index.html; tabs.js wires arrow-key
// navigation, ARIA, focus, and localStorage persistence. Always
// boots on Property Search regardless of stored value.
//
// initSidebarTabs runs BEFORE applyUrlState so the latter can call
// setActiveTab('sales') to honour a shared ?t=sales URL.
initSidebarTabs();

// Phase 8: apply the URL's decoded state to the inputs + toggles
// before initChipInput runs. The chip module renders chips from
// the hidden #roll.value at init time, so the value has to land
// first; toggle clicks fire here too (they run their bookkeeping
// + any associated network fetches, restoring the captured view).
applyUrlState(decodeState(location.search));

// Wire chip input on the Roll # field (initChipInput resolves the
// hidden input via data-target="roll", so soda.js's rollClause still
// reads the canonical comma-separated string).
const $rollChip = document.querySelector('.chip-input[data-target="roll"]');
if ($rollChip) initChipInput($rollChip, { onEnterEmpty: () => runSearch() });

// Walk every .field > .tip and turn it into an info-icon popover.
initInfoIcons();

// Column-visibility gear + presets dropdown above the results
// table. The default-visible set (Quick lookup preset) applies on
// first load; subsequent changes persist to localStorage.
initColumns();
// Tab switches refresh the URL state (tab=sales / no t= for the
// default property tab).
onTabChange(() => queueUrlWrite());

// Wire the Sales Analysis tab — dropzone, subject roll, sentinel
// filter. The CSV is parsed entirely client-side; no upload.
wireSalesTab();

// Wire the parcel-summary close button. The card is populated on
// row click below; the X dismisses without clearing the results.
const $parcelSummary = document.getElementById('parcel-summary');
const $psClose = document.getElementById('ps-close');
if ($psClose && $parcelSummary) {
  $psClose.addEventListener('click', () => { $parcelSummary.hidden = true; });
}

// Hide-map toggle. Adds .map-collapsed to the workspace so the
// .map-pane drops out of layout and the table claims the full
// width. Choice persists to localStorage so a page refresh keeps
// it consistent. Restoring the map needs a deferred map.resize()
// so MapLibre recomputes the canvas dimensions.
const MAP_HIDE_KEY = 'wps_map_collapsed_v1';
const $workspaceEl = document.getElementById('workspace');
const $mapToggleBtn = document.getElementById('map-toggle-btn');
const $mapToggleLabel = $mapToggleBtn?.querySelector('.map-toggle-label');
function applyMapCollapsed(collapsed) {
  if (!$workspaceEl || !$mapToggleBtn) return;
  $workspaceEl.classList.toggle('map-collapsed', collapsed);
  $mapToggleBtn.setAttribute('aria-pressed', String(collapsed));
  if ($mapToggleLabel) $mapToggleLabel.textContent = collapsed ? 'Show map' : 'Hide map';
  if (!collapsed) {
    mapReady.then(() => map.resize());
  }
  try { localStorage.setItem(MAP_HIDE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
}
if ($mapToggleBtn) {
  $mapToggleBtn.addEventListener('click', () => {
    const next = !$workspaceEl?.classList.contains('map-collapsed');
    applyMapCollapsed(next);
  });
  try {
    if (localStorage.getItem(MAP_HIDE_KEY) === '1') applyMapCollapsed(true);
  } catch { /* ignore */ }
}

// Empty-state visible on initial load (before any search). renderTable
// hides it once results land, clearAll re-shows it.
const $resultsEmpty = document.getElementById('results-empty');
function showEmptyState(on) {
  if ($resultsEmpty) $resultsEmpty.hidden = !on;
}
showEmptyState(true);

// The "Min #" input only matters when Min DU is selected. Disable it
// otherwise so users can't type a value that has no effect, and
// pre-fill 1 when switching to Min DU so the filter activates immediately.
$duMode.addEventListener('change', () => {
  const enableMin = $duMode.value === 'min';
  $duMin.disabled = !enableMin;
  if (!enableMin) $duMin.value = '';
  if (enableMin && !$duMin.value) $duMin.value = '1';
});

setExportEnabled(false);
updateSortIndicators();
buildZoningLegend();

// ---------- Phase 8 URL state (encode/decode/apply) ----------
//
// Read all 23 schema fields from the current UI into a plain state
// object. Toggles are only emitted when their state differs from
// the page default (assess defaults ON; everything else OFF), which
// keeps default-state URLs clean.
function captureUrlState() {
  const s = {};
  const v = (el) => (el ? String(el.value || '').trim() : '');
  if (v($lot))           s.lot           = v($lot);
  if (v($block))         s.block         = v($block);
  if (v($plan))          s.plan          = v($plan);
  if (v($desc))          s.desc          = v($desc);
  if (v($roll))          s.roll          = v($roll);
  if (v($addressFrom))   s.addressFrom   = v($addressFrom);
  if (v($addressTo))     s.addressTo     = v($addressTo);
  if (v($addressStreet)) s.addressStreet = v($addressStreet);
  if (v($zoning))        s.zoning        = v($zoning);
  if (v($duMode))        s.duMode        = v($duMode);
  const duMinNum = Number.parseInt(v($duMin), 10);
  if (Number.isFinite(duMinNum) && duMinNum >= 1) s.duMin = duMinNum;

  // Toggle defaults: assess is the only one that ships ON.
  const defaults = {
    surveyToggle: false, assessToggle: true, allParcelsToggle: false,
    zoningToggle: false, trafficToggle: false,
    secondaryPlansToggle: false, infillToggle: false, mallsCorridorsToggle: false,
    cityOwnedParcelsToggle: false,
    transitToggle: false,
    contamToggle: false, dimensionsToggle: false,
  };
  const buttons = {
    surveyToggle: $surveyToggle, assessToggle: $assessToggle,
    allParcelsToggle: $allParcelsToggle, zoningToggle: $zoningToggle,
    trafficToggle: $trafficToggle,
    secondaryPlansToggle: $secondaryPlansToggle,
    infillToggle: $infillToggle, mallsCorridorsToggle: $mallsCorridorsToggle,
    cityOwnedParcelsToggle: $cityOwnedParcelsToggle,
    transitToggle: $transitToggle,
    contamToggle: $contamToggle, dimensionsToggle: $dimensionsToggle,
  };
  for (const [key, btn] of Object.entries(buttons)) {
    if (!btn) continue;
    const on = btn.getAttribute('aria-pressed') === 'true';
    if (on !== defaults[key]) s[key] = on;
  }

  // Neighbourhoods mode: only emit when not in the 'off' default.
  if (neighbourhoodsMode === 'clusters' || neighbourhoodsMode === 'individual') {
    s.neighbourhoodsMode = neighbourhoodsMode;
  }

  if (currentSort?.col) s.sortCol = currentSort.col;
  if (currentSort?.dir) s.sortDir = currentSort.dir;

  // Tab: only emit when on the Sales Analysis tab; Property is
  // the page default and stays out of the URL.
  const salesPanel = document.getElementById('tab-panel-sales');
  if (salesPanel && !salesPanel.hidden) s.tab = 'sales';

  // Subject roll (Sales tab). Emit whatever the user typed — the
  // normalize step happens on read in runSalesAnalysis so 10- or
  // 11-digit shareable URLs both work.
  const subjectRollEl = document.getElementById('subject-roll');
  const subjectRollVal = (subjectRollEl?.value || '').trim();
  if (subjectRollVal) s.subjectRoll = subjectRollVal;

  return s;
}

// Apply a decoded state object to the UI. Inputs get assigned
// synchronously; toggles are flipped by clicking the button so each
// underlying handler runs its full bookkeeping (aria-pressed, button
// label, source fetch, etc.).
function applyUrlState(state) {
  if (!state || Object.keys(state).length === 0) return;
  if ('lot' in state)           $lot.value           = state.lot;
  if ('block' in state)         $block.value         = state.block;
  if ('plan' in state)          $plan.value          = state.plan;
  if ('desc' in state)          $desc.value          = state.desc;
  if ('roll' in state)          $roll.value          = state.roll;
  if ('addressFrom' in state)   $addressFrom.value   = state.addressFrom;
  if ('addressTo' in state)     $addressTo.value     = state.addressTo;
  if ('addressStreet' in state) $addressStreet.value = state.addressStreet;
  if ('zoning' in state)        $zoning.value        = state.zoning;
  if ('duMode' in state) {
    $duMode.value = state.duMode;
    $duMode.dispatchEvent(new Event('change'));
  }
  if ('duMin' in state) $duMin.value = String(state.duMin);

  const toggles = {
    surveyToggle: $surveyToggle, assessToggle: $assessToggle,
    allParcelsToggle: $allParcelsToggle, zoningToggle: $zoningToggle,
    trafficToggle: $trafficToggle,
    secondaryPlansToggle: $secondaryPlansToggle,
    infillToggle: $infillToggle, mallsCorridorsToggle: $mallsCorridorsToggle,
    cityOwnedParcelsToggle: $cityOwnedParcelsToggle,
    transitToggle: $transitToggle,
    contamToggle: $contamToggle, dimensionsToggle: $dimensionsToggle,
  };
  for (const [key, btn] of Object.entries(toggles)) {
    if (!btn || !(key in state)) continue;
    const cur = btn.getAttribute('aria-pressed') === 'true';
    if (cur !== state[key]) btn.click();
  }

  // Neighbourhoods mode (3-state cycle): apply directly rather than
  // simulate N clicks. Validator on the urlState side already
  // restricts to 'clusters' / 'individual'.
  if (state.neighbourhoodsMode === 'clusters' || state.neighbourhoodsMode === 'individual') {
    // Fire-and-forget; the async fetch resolves on its own.
    setNeighbourhoodsMode(state.neighbourhoodsMode);
  }

  if (state.sortCol) {
    currentSort = { col: state.sortCol, dir: state.sortDir === 'desc' ? 'desc' : 'asc' };
    updateSortIndicators();
  }

  if (state.tab && (state.tab === 'sales' || state.tab === 'property')) {
    // skipFocus so a shared URL doesn't yank focus to the dropzone.
    setActiveTab(state.tab, { skipFocus: true });
  }

  if ('subjectRoll' in state) {
    const sr = document.getElementById('subject-roll');
    if (sr) sr.value = String(state.subjectRoll);
    // chipInput hasn't bound to #subject-roll yet at this point in
    // module init — it picks up the value when wireSalesTab runs
    // later. No need to dispatch a render event.
  }
}

// rAF-coalesced replaceState. A rapid sequence of edits collapses
// into a single history write so typing in an input doesn't spam
// browser history.
let urlWritePending = false;
function queueUrlWrite() {
  if (urlWritePending) return;
  urlWritePending = true;
  requestAnimationFrame(() => {
    urlWritePending = false;
    try {
      const qs = encodeState(captureUrlState());
      const url = qs ? `${location.pathname}?${qs}` : location.pathname;
      history.replaceState(null, '', url);
    } catch (err) {
      console.warn('queueUrlWrite failed (non-fatal):', err);
    }
  });
}

// Hook every relevant input + button so each edit refreshes the URL.
// Inputs fire 'input' on every keystroke; selects fire 'change'.
for (const el of [$lot, $block, $plan, $desc, $addressFrom, $addressTo, $addressStreet, $zoning, $duMin]) {
  if (el) el.addEventListener('input', queueUrlWrite);
}
if ($duMode) $duMode.addEventListener('change', queueUrlWrite);
// #roll is a hidden input wrapped by chipInput; the chip module
// dispatches 'input' on the hidden input when chips change, so the
// same listener catches it.
if ($roll) $roll.addEventListener('input', queueUrlWrite);
// Every overlay toggle button — extra listener runs after the
// toggle handler so it sees the post-flip aria-pressed value.
for (const btn of [
  $surveyToggle, $assessToggle, $allParcelsToggle,
  $zoningToggle, $trafficToggle,
  $secondaryPlansToggle, $infillToggle, $mallsCorridorsToggle,
  $cityOwnedParcelsToggle,
  $transitToggle,
  $neighbourhoodsToggle,
  $contamToggle, $dimensionsToggle,
]) {
  if (btn) btn.addEventListener('click', queueUrlWrite);
}

// Wire sortable column headers.
for (const th of document.querySelectorAll('#results th[data-col]')) {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (currentSort.col === col) {
      currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      currentSort = { col, dir: 'asc' };
    }
    updateSortIndicators();
    if (currentRows.length > 0) renderTable(currentRows);
    queueUrlWrite();
  });
}

// The initial decode + apply happens earlier (before initChipInput)
// so the chip module sees the URL-state $roll.value at init time.
// Search-input listeners attached above will start writing back to
// the URL on the user's next edit.

async function runSearch() {
  // Property Search flips the body out of sales mode + restores the
  // property-mode column-visibility set (Quick lookup default or
  // whatever the user has persisted for property mode).
  document.body.classList.remove('sales-mode');
  document.body.classList.remove('subject-set');
  setColumnMode('property');
  // Clear the sales-tab subject highlight when switching to a
  // property search so the blue parcel doesn't linger on the map.
  mapReady.then(() => setSubjectData(map, null));
  const inputs = {
    lot: $lot.value.trim(),
    block: $block.value.trim(),
    plan: $plan.value.trim(),
    desc: $desc.value.trim(),
    roll: $roll.value.trim(),
    addressFrom:   $addressFrom.value.trim(),
    addressTo:     $addressTo.value.trim(),
    addressStreet: $addressStreet.value.trim(),
    zoning: $zoning.value.trim(),
    // DU filter: 'zero' = vacant lots only, 'min' = ≥ N units, '' = no filter.
    // The minimum is captured separately so it persists across mode swaps.
    duMode: $duMode.value,
    duMin: parseInt($duMin.value, 10) || null,
  };

  const anyLegal = inputs.lot || inputs.block || inputs.plan || inputs.desc;
  const anyDu = inputs.duMode === 'zero' || (inputs.duMode === 'min' && inputs.duMin > 0);
  const anyAddress = inputs.addressFrom || inputs.addressTo || inputs.addressStreet;
  const anyAssess = inputs.roll || anyAddress || inputs.zoning || anyDu;

  if (!anyLegal && !anyAssess) {
    setCount('Enter at least one search field.');
    clearTable();
    setParcels(EMPTY_FC);
    return;
  }

  setBusy(true);
  setCount('Searching…');
  clearTable();
  // Clear both layers + civic-address labels from any previous search;
  // each flow repopulates them as data arrives.
  setParcels(EMPTY_FC, EMPTY_FC);
  mapReady.then(() => setCivicAddresses(map, EMPTY_FC));

  try {
    if (anyAssess) {
      await runAssessmentSearch(inputs);
    } else {
      await runLegalSearch(inputs);
    }
  } finally {
    setBusy(false);
  }
}

// ---------- Map / zoning helpers ----------

/**
 * Push a parcel FC onto the map and remember it. The remembered FC lets
 * the zoning toggle refresh without re-running the search. Triggers a
 * zoning refresh if the layer is currently enabled.
 */
function setParcels(surveyFc, assessFc = EMPTY_FC) {
  lastParcelFc = {
    type: 'FeatureCollection',
    features: [...surveyFc.features, ...assessFc.features],
  };
  // Stash the survey FC separately so the dimensions overlay can tie
  // its edge labels to the legal-lot polygons only — assessment-parcel
  // edges describe building footprints, which aren't useful as "lot
  // dimensions" in the appraisal sense.
  lastSurveyFc = surveyFc;
  // Dedupe assess-side polygons by geometry before pushing to the map.
  // Condo buildings (e.g. 635 Ballantrae has 52 units) carry one
  // assessment roll per unit, all with the same building footprint.
  // Without dedupe, 52 stacked translucent fills render as solid dark
  // red and clicking the polygon scrolls the table to whichever unit
  // MapLibre happened to return first — confusing UX. Dedupe the MAP
  // (so the polygon is drawn once) while the TABLE keeps every row.
  const mapAssessFc = dedupeByGeometryHash(assessFc);
  mapReady.then(() => {
    showResults(map, surveyFc, mapAssessFc);
    refreshZoning();
    refreshDimensions();
  });
}

/**
 * Toggle the survey-blue or assessment-red highlights on the map.
 * Lets the user simplify the view when both layers are too busy
 * (especially downtown where 50+ parcels overlap).
 *
 * `which` is 'survey' or 'assess'. Each toggle flips the corresponding
 * pair of fill+line layers on the underlying map source.
 */
function toggleLayer(which) {
  const btn = which === 'survey' ? $surveyToggle : $assessToggle;
  const fillId = which === 'survey' ? 'parcel-fill' : 'assess-context-fill';
  const lineId = which === 'survey' ? 'parcel-line' : 'assess-context-line';
  const labelOn = which === 'survey' ? 'Hide Survey' : 'Hide Assessment';
  const labelOff = which === 'survey' ? 'Survey' : 'Assessment';
  const wasActive = btn.classList.contains('active');
  const nowVisible = !wasActive;
  btn.classList.toggle('active', nowVisible);
  btn.setAttribute('aria-pressed', String(nowVisible));
  btn.textContent = nowVisible ? labelOn : labelOff;
  mapReady.then(() => {
    const v = nowVisible ? 'visible' : 'none';
    if (map.getLayer(fillId)) map.setLayoutProperty(fillId, 'visibility', v);
    if (map.getLayer(lineId)) map.setLayoutProperty(lineId, 'visibility', v);
  });
}

/**
 * Toggle handler. Flips state, updates button text + aria-pressed, then
 * either fetches zoning for the current results (turning on) or hides
 * the layer (turning off). The data sticks around when hidden so a
 * re-toggle is instant if the parcel set hasn't changed.
 */
async function toggleZoning() {
  zoningEnabled = !zoningEnabled;
  $zoningToggle.setAttribute('aria-pressed', String(zoningEnabled));
  $zoningToggle.classList.toggle('active', zoningEnabled);
  await mapReady;
  setZoningVisible(map, zoningEnabled);
  // Floating zoning legend follows the toggle. Built once at startup
  // (see buildZoningLegend below) so flipping is just a hidden flag.
  if ($zoningLegend) $zoningLegend.hidden = !zoningEnabled;
  if (zoningEnabled) {
    // First-load shows a loading state because the citywide fetch is
    // ~10-15s on a cold IndexedDB cache. Subsequent toggles within
    // the 7-day TTL read from disk and resolve in a few hundred ms.
    $zoningToggle.disabled = true;
    $zoningToggle.textContent = 'Loading zoning…';
    try {
      await refreshZoning();
      // Phase 7 deferred zoning enrichment: a CSV upload doesn't
      // run enrichAssessmentZoning eagerly (that would block 10+s
      // on a multi-parcel cold load). When the user actually
      // toggles Zoning on, enrich the current sales FC + re-render
      // so the % / Zoning 2 columns fill in.
      if (document.body.classList.contains('sales-mode')
          && lastParcelFc && lastParcelFc.features?.length
          && salesData) {
        try {
          const enriched = await enrichAssessmentZoning(lastParcelFc);
          if (enriched?.features) {
            lastParcelFc = enriched;
            const rows = enriched.features.map((f) => ({ assess: f, survey: null }));
            renderTable(rows);
          }
        } catch (zErr) {
          console.warn('Sales zoning enrichment failed (non-fatal):', zErr);
        }
      }
      $zoningToggle.textContent = 'Hide Zoning';
    } catch (err) {
      console.warn('zoning toggle failed', err);
      // Roll the toggle back so the user can retry.
      zoningEnabled = false;
      $zoningToggle.classList.remove('active');
      $zoningToggle.setAttribute('aria-pressed', 'false');
      $zoningToggle.textContent = 'Zoning';
      setZoningVisible(map, false);
      if ($zoningLegend) $zoningLegend.hidden = true;
    } finally {
      $zoningToggle.disabled = false;
    }
  } else {
    $zoningToggle.textContent = 'Zoning';
  }
}

// Manitoba Contaminated Sites Registry overlay. Lazy-fetches the
// CSV (filtered to Winnipeg) on first toggle, then caches the FC
// in IndexedDB for 7 days. Toggle is purely a layer-visibility flip
// after the first load. Mirrors the toggleTraffic pattern.
async function toggleContam() {
  contamEnabled = !contamEnabled;
  $contamToggle.setAttribute('aria-pressed', String(contamEnabled));
  $contamToggle.classList.toggle('active', contamEnabled);
  await mapReady;
  setContamVisible(map, contamEnabled);

  if (contamEnabled) {
    if (contamLoaded) {
      $contamToggle.textContent = 'Hide Environmental Sites';
      return;
    }
    $contamToggle.disabled = true;
    $contamToggle.textContent = 'Loading...';
    try {
      const fc = await fetchContaminatedSites();
      setContamData(map, fc);
      contamLoaded = true;
      $contamToggle.textContent = 'Hide Environmental Sites';
    } catch (err) {
      console.warn('contaminated-sites overlay failed', err);
      contamEnabled = false;
      $contamToggle.classList.remove('active');
      $contamToggle.setAttribute('aria-pressed', 'false');
      $contamToggle.textContent = 'Environmental Sites';
      setContamVisible(map, false);
    } finally {
      $contamToggle.disabled = false;
    }
  } else {
    $contamToggle.textContent = 'Environmental Sites';
  }
}

async function toggleTraffic() {
  trafficEnabled = !trafficEnabled;
  $trafficToggle.setAttribute('aria-pressed', String(trafficEnabled));
  $trafficToggle.classList.toggle('active', trafficEnabled);
  await mapReady;
  setTrafficVisible(map, trafficEnabled);
  if ($trafficLegend) $trafficLegend.hidden = !trafficEnabled;

  if (trafficEnabled) {
    if (trafficLoaded) {
      $trafficToggle.textContent = 'Hide Traffic';
      return;
    }
    $trafficToggle.disabled = true;
    $trafficToggle.textContent = 'Loading traffic...';
    try {
      const { lines, stations } = await fetchTrafficVolumes();
      setTrafficData(map, lines, stations);
      trafficLoaded = true;
      $trafficToggle.textContent = 'Hide Traffic';
    } catch (err) {
      console.warn('traffic overlay failed', err);
      trafficEnabled = false;
      $trafficToggle.classList.remove('active');
      $trafficToggle.setAttribute('aria-pressed', 'false');
      $trafficToggle.textContent = 'Traffic';
      setTrafficVisible(map, false);
      if ($trafficLegend) $trafficLegend.hidden = true;
    } finally {
      $trafficToggle.disabled = false;
    }
  } else {
    $trafficToggle.textContent = 'Traffic';
  }
}

/**
 * Fetch the citywide zoning layer (cached for 7 days in IndexedDB) and
 * push it into the map source. No-op when the toggle is off. Failures
 * are logged and re-thrown so toggleZoning can roll back the button
 * state.
 */
async function refreshZoning() {
  if (!zoningEnabled) return;
  const zoningFc = await fetchCityZoning();
  setZoningData(map, zoningFc);
}

/**
 * Generic toggle for the OurWinnipeg policy-area overlays. Each is a
 * small whole-citywide dataset fetched once and cached for the
 * session — see fetchAllAndCache in soda.js — so toggling on/off after
 * the first hit is instant.
 *
 * `name` is one of 'secondaryPlans' / 'infill' / 'mallsCorridors' /
 * 'cityOwnedParcels'.
 */
const POLICY_OVERLAY_CONFIG = {
  secondaryPlans: {
    btn:    () => $secondaryPlansToggle,
    src:    'secondary-plans',
    fetch:  fetchSecondaryPlans,
    onLabel:  'Hide Secondary Plans',
    offLabel: 'Secondary Plans',
  },
  infill: {
    btn:    () => $infillToggle,
    src:    'infill-guideline',
    fetch:  fetchInfillGuidelineArea,
    onLabel:  'Hide Infill Area',
    offLabel: 'Infill Area',
  },
  mallsCorridors: {
    btn:    () => $mallsCorridorsToggle,
    src:    'malls-corridors',
    fetch:  fetchMallsAndCorridors,
    onLabel:  'Hide Malls/Corridors',
    offLabel: 'Malls/Corridors',
  },
  cityOwnedParcels: {
    btn:    () => $cityOwnedParcelsToggle,
    src:    'city-owned-parcels',
    fetch:  fetchCityOwnedParcels,
    onLabel:  'Hide City Owned Parcels',
    offLabel: 'City Owned Parcels',
  },
};

/**
 * Combined transit (routes + stops) toggle. Two GeoJSON sources,
 * one user-facing button. First click fetches both files in
 * parallel, hands them to the matching map sources, and shows
 * both layer groups; subsequent clicks just flip visibility.
 *
 * Failure of either fetch falls back to "off" with the original
 * label restored so the button is never wedged in a broken
 * Loading... state.
 */
async function toggleTransit() {
  if (!$transitToggle) return;
  transitEnabled = !transitEnabled;
  $transitToggle.setAttribute('aria-pressed', String(transitEnabled));
  $transitToggle.classList.toggle('active', transitEnabled);
  await mapReady;
  setOverlayVisible(map, 'transit-routes', transitEnabled);
  setOverlayVisible(map, 'transit-stops',  transitEnabled);

  if (transitEnabled) {
    if (transitLoaded) {
      $transitToggle.textContent = 'Hide Transit';
      return;
    }
    $transitToggle.disabled = true;
    $transitToggle.textContent = 'Loading...';
    try {
      const [routesFc, stopsFc] = await Promise.all([
        fetchTransitRoutes(),
        fetchTransitStops(),
      ]);
      setOverlayData(map, 'transit-routes', routesFc);
      setOverlayData(map, 'transit-stops',  stopsFc);
      transitLoaded = true;
      $transitToggle.textContent = 'Hide Transit';
    } catch (err) {
      console.warn('transit overlay failed', err);
      transitEnabled = false;
      $transitToggle.classList.remove('active');
      $transitToggle.setAttribute('aria-pressed', 'false');
      $transitToggle.textContent = 'Transit';
      setOverlayVisible(map, 'transit-routes', false);
      setOverlayVisible(map, 'transit-stops',  false);
    } finally {
      $transitToggle.disabled = false;
    }
  } else {
    $transitToggle.textContent = 'Transit';
  }
}

// ---------- Neighbourhoods 3-state cycler ----------

const NEIGHBOURHOOD_CLUSTER_LAYERS = [
  'neighbourhood-clusters-fill',
  'neighbourhood-clusters-line-casing',
  'neighbourhood-clusters-line',
  'neighbourhood-clusters-label',
];
const NEIGHBOURHOOD_INDIVIDUAL_LAYERS = [
  'neighbourhoods-fill',
  'neighbourhoods-line-casing',
  'neighbourhoods-line',
  'neighbourhoods-label',
];

/**
 * Area-weighted polygon centroid via the shoelace formula.
 * Input: a closed ring [[lon, lat], ..., [lon0, lat0]].
 * Falls back to unweighted vertex mean if the signed area is
 * effectively zero (degenerate ring) — that case shouldn't fire
 * because cleanPolygon in the build script strips zero-area
 * sub-rings, but the fallback keeps the function total.
 */
function polygonRingCentroid(ring) {
  let sumX = 0, sumY = 0, twoArea = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    const x1 = ring[i][0], y1 = ring[i][1];
    const x2 = ring[i + 1][0], y2 = ring[i + 1][1];
    const cross = x1 * y2 - x2 * y1;
    twoArea += cross;
    sumX += (x1 + x2) * cross;
    sumY += (y1 + y2) * cross;
  }
  if (Math.abs(twoArea) < 1e-12) {
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += ring[i][0]; my += ring[i][1]; }
    return [mx / n, my / n];
  }
  const factor = 1 / (3 * twoArea);
  return [sumX * factor, sumY * factor];
}

/**
 * Build a Point FeatureCollection — one centroid per polygon
 * feature — so a MapLibre symbol layer placed on this FC renders
 * exactly one label per source feature regardless of how many
 * tiles the polygon spans. `labelKey` is the property name copied
 * onto each output point (the text-field reads it).
 */
function buildLabelPointFc(polygonFc, labelKey) {
  if (!polygonFc || !Array.isArray(polygonFc.features)) {
    return { type: 'FeatureCollection', features: [] };
  }
  const features = [];
  for (const f of polygonFc.features) {
    const geom = f.geometry;
    if (!geom) continue;
    let outerRing = null;
    if (geom.type === 'Polygon') {
      outerRing = geom.coordinates?.[0];
    } else if (geom.type === 'MultiPolygon') {
      // Pick the largest-area polygon piece so the label lands on
      // the dominant chunk rather than a tiny outlier island.
      let bestArea = -Infinity, bestRing = null;
      for (const poly of geom.coordinates) {
        const ring = poly?.[0];
        if (!ring || ring.length < 4) continue;
        let twoArea = 0;
        for (let i = 0, m = ring.length - 1; i < m; i++) {
          twoArea += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        }
        const area = Math.abs(twoArea);
        if (area > bestArea) { bestArea = area; bestRing = ring; }
      }
      outerRing = bestRing;
    }
    if (!outerRing || outerRing.length < 4) continue;
    const [lon, lat] = polygonRingCentroid(outerRing);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { [labelKey]: f.properties?.[labelKey] ?? '' },
    });
  }
  return { type: 'FeatureCollection', features };
}

function setNeighbourhoodLayerVisibility(layerIds, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of layerIds) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

function renderNeighbourhoodButton() {
  if (!$neighbourhoodsToggle) return;
  if (neighbourhoodsMode === 'off') {
    $neighbourhoodsToggle.textContent = 'Neighbourhoods';
    $neighbourhoodsToggle.classList.remove('active');
    $neighbourhoodsToggle.setAttribute('aria-pressed', 'false');
  } else if (neighbourhoodsMode === 'clusters') {
    $neighbourhoodsToggle.textContent = 'Clusters';
    $neighbourhoodsToggle.classList.add('active');
    $neighbourhoodsToggle.setAttribute('aria-pressed', 'true');
  } else {
    $neighbourhoodsToggle.textContent = 'Neighbourhoods';
    $neighbourhoodsToggle.classList.add('active');
    $neighbourhoodsToggle.setAttribute('aria-pressed', 'true');
  }
}

/**
 * Cycle the neighbourhoods overlay through Off → Clusters →
 * Individual → Off. Each "on" state lazily fetches its source FC
 * the first time it's reached and caches it for the session.
 */
async function cycleNeighbourhoods() {
  if (!$neighbourhoodsToggle) return;
  const next = neighbourhoodsMode === 'off'
    ? 'clusters'
    : neighbourhoodsMode === 'clusters'
      ? 'individual'
      : 'off';
  await setNeighbourhoodsMode(next);
}

async function setNeighbourhoodsMode(mode) {
  if (!$neighbourhoodsToggle) return;
  if (mode !== 'off' && mode !== 'clusters' && mode !== 'individual') mode = 'off';
  neighbourhoodsMode = mode;
  renderNeighbourhoodButton();
  await mapReady;

  // Visibility first (so a switch from clusters → individual
  // doesn't leave the old layers showing during a fetch).
  setNeighbourhoodLayerVisibility(NEIGHBOURHOOD_CLUSTER_LAYERS,    mode === 'clusters');
  setNeighbourhoodLayerVisibility(NEIGHBOURHOOD_INDIVIDUAL_LAYERS, mode === 'individual');

  if (mode === 'off') return;

  // Lazy-fetch the relevant FC on first reveal.
  const fetchKey = mode === 'clusters' ? 'clusters' : 'individual';
  if (neighbourhoodsLoaded[fetchKey]) return;
  $neighbourhoodsToggle.disabled = true;
  const restoreLabel = $neighbourhoodsToggle.textContent;
  $neighbourhoodsToggle.textContent = 'Loading...';
  try {
    if (mode === 'clusters') {
      const fc = await fetchNeighbourhoodClusters();
      setOverlayData(map, 'wpg-neighbourhood-clusters', fc);
      // Build a 1-point-per-feature FC for the label layer so
      // MapLibre places exactly one label per cluster (rather
      // than one per tile-chunk that the polygon overlaps).
      setOverlayData(map, 'wpg-neighbourhood-cluster-labels',
        buildLabelPointFc(fc, 'cluster'));
    } else {
      const fc = await fetchNeighbourhoods();
      setOverlayData(map, 'wpg-neighbourhoods', fc);
      setOverlayData(map, 'wpg-neighbourhood-labels',
        buildLabelPointFc(fc, 'name'));
    }
    neighbourhoodsLoaded[fetchKey] = true;
    $neighbourhoodsToggle.textContent = restoreLabel;
  } catch (err) {
    console.warn(`neighbourhoods (${mode}) fetch failed`, err);
    // Roll back to off so the button isn't wedged.
    neighbourhoodsMode = 'off';
    renderNeighbourhoodButton();
    setNeighbourhoodLayerVisibility(NEIGHBOURHOOD_CLUSTER_LAYERS, false);
    setNeighbourhoodLayerVisibility(NEIGHBOURHOOD_INDIVIDUAL_LAYERS, false);
  } finally {
    $neighbourhoodsToggle.disabled = false;
  }
}

// ---------- Parcel-edge dimensions toggle ----------
// policyOverlayState + dimensionsEnabled hoisted to the top of the
// module (Phase 8 TDZ audit).

/**
 * Flip the dimension-label layer on or off. When enabling, recompute
 * labels from the current parcel set (survey + assess) and push them
 * into the dimensions source. The labels are LineStrings — one per
 * polygon edge — so MapLibre's symbol-placement:'line' rotates each
 * label along its edge automatically (looks like a survey plat).
 */
async function toggleDimensions() {
  dimensionsEnabled = !dimensionsEnabled;
  $dimensionsToggle.setAttribute('aria-pressed', String(dimensionsEnabled));
  $dimensionsToggle.classList.toggle('active', dimensionsEnabled);
  $dimensionsToggle.textContent = dimensionsEnabled ? 'Hide Dimensions*' : 'Dimensions*';
  await mapReady;
  setDimensionsVisible(map, dimensionsEnabled);
  if (dimensionsEnabled) refreshDimensions();
}

/** Recompute and push the dimension-label FC. Called when the toggle
 *  flips on AND whenever the parcel set changes (via setParcels).
 *  Tied to survey lots only — the legal-lot dimensions are what an
 *  appraiser cares about ("33 ft × 120 ft"). Assessment polygons
 *  describe building footprints / aggregations, so their edges aren't
 *  meaningful as "lot dimensions". */
function refreshDimensions() {
  if (!dimensionsEnabled) return;
  const fc = buildDimensionLabels(lastSurveyFc);
  mapReady.then(() => setDimensions(map, fc));
}

/**
 * For each polygon in `parcelFc`, emit one LineString feature per outer-
 * ring edge with `length_label` already pre-formatted ("98 ft", "1,240
 * ft", etc). Skips edges shorter than 5 ft to avoid stamping near-
 * duplicate labels at digitization waypoints.
 */
function buildDimensionLabels(parcelFc) {
  if (!parcelFc?.features?.length) {
    return { type: 'FeatureCollection', features: [] };
  }
  const features = [];
  // Adjacent survey lots share their side edges — without dedupe, each
  // shared edge would emit two labels at the same midpoint and
  // MapLibre's collision detection would render them as a smeared
  // double-text or drop one arbitrarily. Canonicalising endpoint
  // coordinates so [a,b] keys the same as [b,a] gives us one label
  // per unique geometric edge.
  const seenEdges = new Set();
  for (const f of parcelFc.features) {
    try {
      const geom = f.geometry;
      const rings = [];
      if (geom.type === 'Polygon') {
        rings.push(geom.coordinates[0]);
      } else if (geom.type === 'MultiPolygon') {
        for (const p of geom.coordinates) rings.push(p[0]);
      } else {
        continue;
      }
      for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i];
          const b = ring[i + 1];
          const lenFt = haversineFt(a, b);
          if (lenFt < 5) continue;
          const key = canonicalEdgeKey(a, b);
          if (seenEdges.has(key)) continue;
          seenEdges.add(key);
          features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [a, b] },
            properties: { length_label: `${Math.round(lenFt).toLocaleString('en-US')} ft` },
          });
        }
      }
    } catch { /* skip a single malformed feature; rest of set still labels */ }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Populate the floating zoning legend's <ul> from the same palette
 * map.js uses to colour the zoning fill layer. Run once at startup —
 * the citywide layer always covers all 13 categories so we don't have
 * to recompute on viewport changes. Visibility is flipped by the
 * toggleZoning handler.
 */
function buildZoningLegend() {
  if (!$zoningLegend || !ZONING_PALETTE) return;
  const ul = $zoningLegend.querySelector('ul');
  if (!ul) return;
  ul.innerHTML = '';
  for (let i = 0; i < ZONING_PALETTE.length; i += 2) {
    const name = ZONING_PALETTE[i];
    const color = ZONING_PALETTE[i + 1];
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = color;
    li.appendChild(sw);
    li.appendChild(document.createTextNode(name));
    ul.appendChild(li);
  }
}

/**
 * Dedupe a FeatureCollection by geometry hash. Designed for the
 * map-render side of the assessment flow where multi-unit buildings
 * (condo towers, strip malls) carry one roll per unit — all with the
 * same polygon. The TABLE wants every row, but the MAP wants the
 * polygon drawn once.
 *
 * Each kept feature is decorated with `_unitCount` (≥1) and
 * `_unitAddresses` (top-N comma-joined) so the hover popup can show
 * "PH18-635 BALLANTRAE DRIVE +51 more units" instead of pretending
 * there's only one unit there. The original `_rowKey` carries
 * through (first-seen wins) so clicking the polygon still scrolls
 * the table to a real row.
 */
function dedupeByGeometryHash(fc) {
  if (!fc?.features?.length) {
    return { type: 'FeatureCollection', features: [] };
  }
  const seen = new Map();
  for (const f of fc.features) {
    const key = geometryHash(f);
    if (!key) continue;
    const existing = seen.get(key);
    if (existing) {
      existing.properties._unitCount = (existing.properties._unitCount || 1) + 1;
      const addr = f.properties?.full_address;
      if (addr && existing.properties._unitAddresses.length < 5) {
        existing.properties._unitAddresses.push(addr);
      }
    } else {
      // Clone so we don't mutate the original table-side feature.
      const clone = {
        ...f,
        properties: {
          ...f.properties,
          _unitCount: 1,
          _unitAddresses: f.properties?.full_address ? [f.properties.full_address] : [],
        },
      };
      seen.set(key, clone);
    }
  }
  return { type: 'FeatureCollection', features: [...seen.values()] };
}

/** Geometry hash for a Polygon/MultiPolygon feature. Uses the bbox
 *  rounded to 6 dp (~10 cm) so near-identical condo footprints
 *  collapse to one key without false positives between separate
 *  buildings. */
function geometryHash(f) {
  try {
    const [minLon, minLat, maxLon, maxLat] = bbox(f);
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;
    return `${minLon.toFixed(6)},${minLat.toFixed(6)},${maxLon.toFixed(6)},${maxLat.toFixed(6)}`;
  } catch { return null; }
}

/** Canonical key for an undirected edge between two [lon, lat] points.
 *  Rounding to 6 dp (~10 cm) collapses near-identical endpoints from
 *  digitization noise; sorting ensures [a,b] and [b,a] produce the
 *  same key. */
function canonicalEdgeKey(a, b) {
  const aStr = `${a[0].toFixed(6)},${a[1].toFixed(6)}`;
  const bStr = `${b[0].toFixed(6)},${b[1].toFixed(6)}`;
  return aStr < bStr ? `${aStr}|${bStr}` : `${bStr}|${aStr}`;
}

/** Haversine great-circle distance between two [lon, lat] points,
 *  returned in feet. Cheap inline implementation; avoids a turf dep. */
function haversineFt(a, b) {
  const R_M = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const x = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R_M * c * 3.28084;
}

async function togglePolicyOverlay(name) {
  const cfg = POLICY_OVERLAY_CONFIG[name];
  const state = policyOverlayState[name];
  if (!cfg || !state) return;
  state.enabled = !state.enabled;
  const btn = cfg.btn();
  btn.textContent = state.enabled ? cfg.onLabel : cfg.offLabel;
  btn.setAttribute('aria-pressed', String(state.enabled));
  btn.classList.toggle('active', state.enabled);
  await mapReady;
  setOverlayVisible(map, cfg.src, state.enabled);
  if (state.enabled && !state.loaded) {
    btn.disabled = true;
    try {
      const fc = await cfg.fetch();
      setOverlayData(map, cfg.src, fc);
      state.loaded = true;
    } catch (err) {
      console.warn(`${name} fetch failed`, err);
      // Roll back the toggle so the user can retry.
      state.enabled = false;
      btn.textContent = cfg.offLabel;
      btn.setAttribute('aria-pressed', 'false');
      btn.classList.remove('active');
      setOverlayVisible(map, cfg.src, false);
    } finally {
      btn.disabled = false;
    }
  }
}

/**
 * Toggle the citywide-parcels PMTiles overlay. Different from the
 * policy overlays — there's no GeoJSON to fetch up front; MapLibre
 * pulls vector tiles for whatever's in the viewport on demand. The
 * only thing this handler manages is layer visibility, plus an
 * up-front probe to surface a "tiles not built" message when the
 * .pmtiles archive isn't deployed yet (a fresh fork that hasn't run
 * the offline build pipeline).
 */
// citywideParcelsEnabled hoisted to the top (Phase 8 TDZ audit).
async function toggleCitywideParcels() {
  await mapReady;
  // Probe once on the first toggle attempt — bypasses if already
  // confirmed available.
  const available = await probeCitywideParcels();
  if (!available) {
    setCount(
      'Show All Parcels: tiles not built. Run r/build_parcel_tiles.R + tippecanoe to generate web/public/parcels.pmtiles.'
    );
    return;
  }
  citywideParcelsEnabled = !citywideParcelsEnabled;
  $allParcelsToggle.textContent = citywideParcelsEnabled ? 'Hide All Assessment Parcels' : 'All Assessment Parcels';
  $allParcelsToggle.setAttribute('aria-pressed', String(citywideParcelsEnabled));
  $allParcelsToggle.classList.toggle('active', citywideParcelsEnabled);
  setCitywideParcelsVisible(map, citywideParcelsEnabled);
}

// ---------- Legal-description flow ----------

async function runLegalSearch(inputs) {
  let surveyFc;
  try {
    surveyFc = await searchSurveyParcels(inputs);
  } catch (err) {
    console.error(err);
    setCount(`Search failed: ${err.message}`);
    return;
  }

  const n = surveyFc.features.length;
  if (n === 0) {
    setCount('No parcels found.');
    setParcels(EMPTY_FC, EMPTY_FC);
    return;
  }

  // Stamp a row key onto each feature so clicking on the map can jump
  // straight to the corresponding row in the table. In this flow the map
  // is drawn from Survey Parcels, so we key on survey.id.
  tagFeatures(surveyFc, 'survey');

  const countMsg = parcelCountMsg(n, surveyFc);
  setCount(`${countMsg} · loading roll numbers…`);

  // Show survey-only rows in the table immediately. Assessment overlay
  // is empty until the next async step fetches it.
  renderTable(surveyFc.features.map((f) => ({ survey: f, assess: null })));
  setParcels(surveyFc, EMPTY_FC);

  // Enrichment: Assessment Parcels inside the survey bbox.
  let assessFc;
  try {
    assessFc = await fetchAssessmentOverlap(surveyFc);
  } catch (err) {
    console.error(err);
    setCount(`${countMsg} · enrichment failed: ${err.message}`);
    return;
  }

  // Enrich each assessment with its full civic-address list (e.g. so a
  // multi-address parcel reads "400 HARGRAVE STREET, 440 HARGRAVE ST"
  // and is recognizable from any direction the user might search).
  // Wrapped so any unexpected failure is non-fatal — on failure parcels
  // keep their primary address only, but the join + render still runs.
  let civicAddresses = EMPTY_FC;
  try {
    ({ addresses: civicAddresses } = await enrichAssessmentAddresses(assessFc));
  } catch (err) {
    console.warn('address enrichment threw, continuing without it', err);
  }
  // Area-weighted top-2 zoning fills zoning_top1 / zoning_top2 +
  // their coverage %s. Non-fatal — on failure parcels keep their
  // original `zoning` text only.
  try {
    await enrichAssessmentZoning(assessFc);
  } catch (err) {
    console.warn('zoning enrichment threw, continuing without it', err);
  }

  const rows = joinSurveyWithAssessment(surveyFc, assessFc);
  renderTable(rows);
  mapReady.then(() => setCivicAddresses(map, civicAddresses));
  // Push BOTH layers to the map so the user sees survey lots (blue) AND
  // the assessment parcels (red) that contain them. Assess side is
  // narrowed to those actually overlapping the survey results — the
  // raw assessFc from fetchAssessmentOverlap is a bbox-padded superset.
  const matchedAssessFc = filterMatchedAssessments(assessFc, surveyFc);
  setParcels(surveyFc, matchedAssessFc);
  setCount(countMsg);
}

// ---------- Assessment-first flow (Roll # / Address / Zoning) ----------

async function runAssessmentSearch(inputs) {
  let assessFc, civicAddresses = EMPTY_FC;
  try {
    ({ parcels: assessFc, addresses: civicAddresses } =
      await searchAssessmentParcelsExpanded(inputs));
  } catch (err) {
    console.error(err);
    setCount(`Search failed: ${err.message}`);
    return;
  }

  const n = assessFc.features.length;
  // For a multi-roll paste, surface a "(X of N requested rolls not
  // found)" hint when fewer parcels came back than rolls input. Without
  // this the missing rolls would silently disappear (e.g. exempt
  // properties, stale clipboard data) and the user wouldn't know.
  const requestedRolls = countRollList(inputs.roll);
  const missingHint = requestedRolls > 1 && n < requestedRolls
    ? ` (${requestedRolls - n} of ${requestedRolls} requested roll${requestedRolls === 1 ? '' : 's'} not found)`
    : '';

  if (n === 0) {
    setCount(`No parcels found.${missingHint}`);
    setParcels(EMPTY_FC, EMPTY_FC);
    return;
  }

  // Stamp a row key onto each feature so clicking on the map can jump
  // straight to the matching row. In this flow the map is drawn from
  // Assessment Parcels, so we key on assess.roll_number.
  tagFeatures(assessFc, 'assess');

  const countMsg = parcelCountMsg(n, assessFc) + missingHint;
  setCount(`${countMsg} · loading legal descriptions…`);

  // Show assessment-only rows in the table immediately. Map renders the
  // assessment polygons in red; survey overlay (blue) populates after the
  // back-fill fetch finishes below.
  renderTable(assessFc.features.map((f) => ({ survey: null, assess: f })));
  setParcels(EMPTY_FC, assessFc);

  // Enrichment: Survey Parcels inside the assessment bbox, back-filling
  // the lot/block/plan/description columns.
  let surveyFc;
  try {
    surveyFc = await fetchSurveyOverlap(assessFc);
  } catch (err) {
    console.error(err);
    setCount(`${countMsg} · legal-description lookup failed: ${err.message}`);
    return;
  }

  // First render: legal descriptions filled in, partial markers not yet.
  renderTable(joinAssessmentWithSurvey(assessFc, surveyFc));
  // Now that we have surveyFc, push the matched survey polygons onto
  // the blue layer so the user sees every legal lot that falls inside
  // the address/roll/zoning result — not just the assessment polygon.
  const matchedSurveyFc = filterMatchedSurveys(surveyFc, assessFc);
  setParcels(matchedSurveyFc, assessFc);
  mapReady.then(() => setCivicAddresses(map, civicAddresses));
  setCount(`${countMsg} · checking partial lots…`);

  // Partial detection: a survey lot is "partial" if its polygon overlaps
  // multiple assessment parcels. The search results only contain parcels
  // matching the user's text — so to detect partials whose other half
  // lives outside the search, we need a separate fetch of every assessment
  // overlapping each survey. Non-fatal: on failure, the table just stays
  // unmarked and the user still sees the legal descriptions.
  try {
    const allOverlapAssess = await fetchAssessmentOverlap(surveyFc);
    const partialSurveyIds = computePartialSurveyIds(surveyFc, allOverlapAssess);
    renderTable(joinAssessmentWithSurvey(assessFc, surveyFc, partialSurveyIds));
  } catch (err) {
    console.warn('partial-lot detection failed', err);
  }
  setCount(countMsg);
}

// ---------- UI helpers ----------

function setCount(text) {
  $count.textContent = text;
  // Phase 5: mirror the same message into the prominent status bar
  // above the results table. Hidden when text is empty so a fresh
  // load doesn't show an empty pill.
  const status = document.getElementById('results-status');
  if (status) {
    if (!text) {
      status.hidden = true;
      status.textContent = '';
    } else {
      status.hidden = false;
      status.textContent = text;
    }
  }
}

function parcelCountMsg(n, fc) {
  return fc?.meta?.truncated
    ? `Showing first ${n} parcels (limit reached — refine your search)`
    : `${n} parcels found`;
}

/**
 * Count how many distinct roll-number tokens the user pasted into the
 * Roll # field. Mirrors the split logic in soda.js's rollClause(). When
 * the token count is ≤ 1, the field is in single-value LIKE mode and
 * we don't bother with the multi-roll "not found" UX.
 */
function countRollList(roll) {
  if (!roll) return 0;
  const tokens = String(roll).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  return tokens.length;
}

function setBusy(busy) {
  $search.disabled = busy;
  $search.textContent = busy ? 'Searching…' : 'Search';
}

/** Wipe every search input, the count, the table, and the map overlay,
 *  returning the page to its initial state so the user can start a new
 *  search without manually emptying seven fields. */
/** Hard-reset the page. A full reload guarantees every piece of state —
 *  inputs, table, sort, map zoom, zoning toggle/data, partial markers,
 *  pending in-flight requests — goes back to first-load. Soft resets had
 *  drift bugs where stale state could leak through; a reload sidesteps
 *  the whole class of issue. */
function clearAll() {
  // Navigate to the bare URL (no query string) and reload so URL-
  // state-driven values (roll #, sort, toggles, subject roll, etc.)
  // don't re-populate. Without the pathname rewrite, applyUrlState
  // would re-apply whatever was in ?r=...&zo=1&... on next load.
  window.location.href = window.location.pathname;
}

function clearTable() {
  $tbody.innerHTML = '';
  currentRows = [];
  setExportEnabled(false);
  showEmptyState(true);
  if ($parcelSummary) $parcelSummary.hidden = true;
}

function renderTable(rows) {
  $tbody.innerHTML = '';
  currentRows = rows;
  rowFeatureMap.clear();
  showEmptyState(rows.length === 0);
  const sorted = sortRows(rows);
  // Stamp the dominant assessment year onto the column header so it
  // reads "Assess-2026" (or whatever year the source data carries).
  // Falls back to plain "Assessment" when the data lacks the field.
  const valueHeader = document.getElementById('value-header');
  if (valueHeader) {
    const years = rows
      .map((r) => r.assess?.properties?.current_assessment_year)
      .filter(Boolean);
    if (years.length) {
      const counts = new Map();
      for (const y of years) counts.set(y, (counts.get(y) || 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      valueHeader.textContent = top ? `Assess-${top}` : 'Assessment';
    } else {
      valueHeader.textContent = 'Assessment';
    }
  }
  const frag = document.createDocumentFragment();
  for (let sortedIdx = 0; sortedIdx < sorted.length; sortedIdx++) {
    const row = sorted[sortedIdx];
    // Either side can be null depending on the flow, so optional-chain both.
    const s = row.survey?.properties || {};
    const a = row.assess?.properties || {};
    const tr = document.createElement('tr');
    // Link the row back to whichever feature is drawn on the map in the
    // current flow. `_rowKey` is stamped on by tagFeatures() before render.
    const key = s._rowKey ?? a._rowKey;
    if (key != null) {
      tr.dataset.rowKey = String(key);
      // Track the geometry-bearing feature for this row so a click can
      // fly the map there. Prefer the assessment feature (the building
      // outline is more recognizable than a small survey lot).
      const flyFeature = (row.assess && row.assess.geometry)
        ? row.assess
        : (row.survey && row.survey.geometry ? row.survey : null);
      if (flyFeature) rowFeatureMap.set(String(key), flyFeature);
    }
    tr.classList.add('clickable');
    tr.title = 'Click to zoom map to this parcel';
    tr.addEventListener('click', () => {
      const f = rowFeatureMap.get(tr.dataset.rowKey);
      if (f) mapReady.then(() => flyToFeature(map, f));
      // Phase 5: also populate the parcel-summary card above the
      // table. Closure captures the row's properties so we don't
      // have to reach back into rows[].
      showParcelSummary(a, s);
    });
    // Multi-parcel-sale grouping. When two or more rows in the
    // CURRENT sort order share an Instrument Number, stamp
    // first/middle/last/solo so the table can visually connect
    // them via the data-group-pos CSS in style.css. `solo` =
    // group has >1 parcel but sort order broke the run.
    const inst = a._saleInstrument;
    const gsize = Number(a._saleGroupSize) || 0;
    if (inst && gsize > 1) {
      const prevInst = sortedIdx > 0
        ? sorted[sortedIdx - 1].assess?.properties?._saleInstrument : null;
      const nextInst = sortedIdx < sorted.length - 1
        ? sorted[sortedIdx + 1].assess?.properties?._saleInstrument : null;
      const prevSame = prevInst === inst;
      const nextSame = nextInst === inst;
      let pos;
      if (!prevSame && nextSame) pos = 'first';
      else if (prevSame && nextSame) pos = 'middle';
      else if (prevSame && !nextSame) pos = 'last';
      else pos = 'solo';
      tr.dataset.groupPos = pos;
      tr.dataset.groupSize = String(gsize);
    }
    // Lot cell can run long for multi-lot merges (e.g. "21-25, 68-75,
    // 120-121 (Pl 129); 39-46 (Pl 24208)"). Truncate with full text
    // available on hover so the table column doesn't blow up.
    // Cell-append order MUST match the thead in index.html:
    //   roll, address, saleDate, useCode (PUCS), livingArea,
    //   yearBuilt, area, propertyType, groupSize, salePrice,
    //   pricePerSf, saleToAsmt, dist, instrument,
    //   lot, block, plan, desc,
    //   zoning, zoningPct, zoning2, lat, lon,
    //   value, walk, flood.
    //
    // Roll Number cell links to the same assessment-page record as
    // the Assessment dollar-value column.
    tr.appendChild(linkTd(assessmentUrl(a), a.roll_number));
    // Multi-address parcels can have long comma-joined address lists
    // (e.g. "400 HARGRAVE STREET, 400 HARGRAVE ST, 440 HARGRAVE ST").
    // Truncate at 40 chars with full text on hover.
    tr.appendChild(truncatedTd(a.full_address, 40));
    // Sales-only block (CSS .sales-only hides them in property mode).
    tr.appendChild(td(a._saleDate || null));
    tr.appendChild(badgeTd(a._saleUseCode || null, 'badge-pucs'));
    tr.appendChild(td(formatSqFt(a._saleLivingArea), 'num'));
    tr.appendChild(td(a._saleYearBuilt || null));
    // Lot Size (sf) lives in the lead block per the user's preferred
    // sales-mode order; it's still useful in property mode too.
    tr.appendChild(td(formatSqFt(a.assessed_land_area), 'num'));
    // More sales-only fields.
    tr.appendChild(badgeTd(a._salePropertyType || null, propertyTypeBadgeClass(a._salePropertyType)));
    tr.appendChild(td(a._saleGroupSize != null ? String(a._saleGroupSize) : null, 'num'));
    tr.appendChild(td(formatDollars(a._salePrice), 'num'));
    tr.appendChild(td(formatDollars(a._pricePerSf), 'num'));
    tr.appendChild(td(formatPct(a._saleToAsmt), 'num'));
    tr.appendChild(td(formatDist(a._dist), 'num'));
    tr.appendChild(td(a._saleInstrument || null));
    // Property-mode tail block (legal + zoning + coords + ext links).
    tr.appendChild(truncatedTd(s.lot, 10));
    tr.appendChild(td(s.block));
    tr.appendChild(td(s.plan));
    tr.appendChild(td(s.description));
    // Prefer the area-weighted top-1 zoning code; fall back to the
    // assessment dataset's primary `zoning` text if enrichment hasn't
    // populated zoning_top1. d4mq-wa44 fallback strips the verbose
    // "R1M - RES - S F - MEDIUM" form down to just the code.
    tr.appendChild(badgeTd(stripZoningCode(a.zoning_top1 ?? a.zoning), 'badge-zoning'));
    tr.appendChild(td(formatPct(a.zoning_top1_pct), 'num'));
    tr.appendChild(td(formatZone2(a.zoning_top2, a.zoning_top2_pct)));
    tr.appendChild(td(formatCoord(a.centroid_lat), 'num'));
    tr.appendChild(td(formatCoord(a.centroid_lon), 'num'));
    tr.appendChild(assessmentTd(a));
    tr.appendChild(linkTd(walkscoreUrl(a.full_address), 'Walk'));
    tr.appendChild(linkTd(floodToolUrl(a), 'Flood'));
    frag.appendChild(tr);
  }
  $tbody.appendChild(frag);
  setExportEnabled(rows.length > 0);
  // Phase 5: reapply column visibility so newly-built rows pick up
  // the user's hidden-column choices.
  applyColumnVisibility();
}

// Phase 5: populate the parcel-summary card from a clicked row's
// assessment + survey property objects. Hidden card -> visible;
// verify-this checklist persists per-roll to localStorage.
function showParcelSummary(a, s) {
  if (!$parcelSummary) return;
  const roll = a?.roll_number ?? s?.roll_number ?? '';
  const $title    = document.getElementById('ps-roll');
  const $address  = document.getElementById('ps-address');
  const $area     = document.getElementById('ps-area');
  const $zoning   = document.getElementById('ps-zoning');
  const $asmt     = document.getElementById('ps-asmt');
  const $coords   = document.getElementById('ps-coords');
  if ($title)   $title.textContent   = roll ? `Roll ${roll}` : 'Selected parcel';
  if ($address) $address.textContent = a?.full_address || '—';
  if ($area)    $area.textContent    = formatSqFt(a?.assessed_land_area) ? `${formatSqFt(a?.assessed_land_area)} sf` : '—';
  if ($zoning) {
    const code = stripZoningCode(a?.zoning_top1 ?? a?.zoning);
    const pct  = formatPct(a?.zoning_top1_pct);
    $zoning.textContent = code ? (pct ? `${code} (${pct})` : code) : '—';
  }
  if ($asmt) {
    const dollars = formatDollars(a?.total_assessed_value);
    const year = a?.current_assessment_year;
    $asmt.textContent = dollars ? (year ? `${dollars} · ${year}` : dollars) : '—';
  }
  if ($coords) {
    const lat = formatCoord(a?.centroid_lat);
    const lon = formatCoord(a?.centroid_lon);
    $coords.textContent = (lat && lon) ? `${lat}, ${lon}` : '—';
  }

  // Open-Assessment action: rebuild the URL from the roll # (the
  // other three action links are static and live in index.html).
  const $openAsmt = document.getElementById('ps-open-assessment');
  if ($openAsmt) {
    const url = assessmentUrl(a);
    if (url) {
      $openAsmt.href = url;
      $openAsmt.removeAttribute('aria-disabled');
    } else {
      $openAsmt.href = '#';
      $openAsmt.setAttribute('aria-disabled', 'true');
    }
  }

  // Verify-this checklist: restore the saved ticks for this roll,
  // and persist on change. Storage key includes the roll so each
  // parcel has its own state.
  if (roll) {
    const storageKey = `wps_verify_v1:${roll}`;
    let saved = {};
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) saved = JSON.parse(raw) || {};
    } catch { /* ignore */ }
    const checks = document.querySelectorAll('#ps-verify-list input[type="checkbox"]');
    for (const cb of checks) {
      const k = cb.dataset.key;
      cb.checked = !!saved[k];
      cb.onchange = () => {
        saved[k] = cb.checked;
        try {
          localStorage.setItem(storageKey, JSON.stringify(saved));
        } catch { /* ignore */ }
      };
    }
  }

  $parcelSummary.hidden = false;
}

/**
 * Stamp a stable `_rowKey` property onto each feature in `fc`, so that:
 *  - the map layer carries it through to mouse events (vector tiles flatten
 *    properties, but GeoJSON sources preserve them as-is)
 *  - renderTable() can read it off the same property objects and wire a
 *    matching `data-row-key` onto each <tr>
 *
 * `side` is 'survey' or 'assess' depending on which dataset is being drawn.
 */
function tagFeatures(fc, side) {
  for (const f of fc.features) {
    const p = f.properties || (f.properties = {});
    if (side === 'survey') {
      p._rowKey = p.id != null ? `s:${p.id}` : null;
    } else {
      p._rowKey = p.roll_number != null ? `a:${p.roll_number}` : null;
    }
  }
}

/** Click-on-map handler: scroll the matching row into view and flash it. */
function scrollToRow(key) {
  const tr = $tbody.querySelector(`tr[data-row-key="${cssEscape(String(key))}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (const prev of $tbody.querySelectorAll('tr.row-highlight')) {
    prev.classList.remove('row-highlight');
  }
  // Force-restart the CSS animation if the same row is re-clicked: remove
  // the class, force a reflow, then add it again.
  tr.classList.remove('row-highlight');
  void tr.offsetWidth;
  tr.classList.add('row-highlight');
}

// Minimal CSS.escape polyfill — just enough to handle the characters we
// put into row keys (digits, colons, hyphens).
function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\]/g, '\\$&');
}

// ---------- CSV export ----------

function setExportEnabled(enabled) {
  $export.disabled = !enabled;
}

function exportCsv() {
  if (!currentRows.length) return;
  const header = [
    'Lot', 'Block', 'Plan', 'Description',
    'Roll Number', 'Full Address',
    'Zoning', 'Zoning %', 'Zoning 2', 'Zoning 2 %',
    'Lot Size (sf)', 'Lat', 'Lon',
    'Total Assessed Value', 'Assessment Year', 'Assessment URL',
    'Walkscore URL', 'Flood URL',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const row of currentRows) {
    const s = row.survey?.properties || {};
    const a = row.assess?.properties || {};
    lines.push([
      s.lot, s.block, s.plan, s.description,
      a.roll_number, a.full_address,
      a.zoning_top1 ?? a.zoning ?? '',
      a.zoning_top1_pct ?? '',
      a.zoning_top2 ?? '',
      a.zoning_top2_pct ?? '',
      // Unformatted numeric values in CSV so spreadsheets can treat them
      // as numbers rather than text. Empty cells stay empty.
      a.assessed_land_area ?? '',
      a.centroid_lat ?? '',
      a.centroid_lon ?? '',
      a.total_assessed_value ?? '',
      a.current_assessment_year ?? '',
      assessmentUrl(a) ?? '',
      walkscoreUrl(a.full_address) ?? '',
      floodToolUrl(a) ?? '',
    ].map(csvCell).join(','));
  }
  // BOM so Excel picks up UTF-8 correctly.
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `winnipeg-parcels-${today()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
  // Quote if the value contains a comma, quote, CR, or LF. Inside quotes,
  // double any embedded quotes per RFC 4180.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function td(value, className) {
  const el = document.createElement('td');
  if (value == null || value === '') {
    el.textContent = '—';
    el.classList.add('empty');
  } else {
    el.textContent = value;
  }
  if (className) el.classList.add(className);
  return el;
}

/**
 * Cell with a pill-style categorical badge wrapping its value.
 * Empty values fall back to the em-dash empty cell (no badge).
 * `badgeClass` is the modifier (e.g. "badge-zoning"); a base
 * "badge" class is added automatically. `extraTdClass` lets the
 * caller add a num / left-align class to the td itself.
 */
function badgeTd(value, badgeClass, extraTdClass) {
  const el = document.createElement('td');
  if (extraTdClass) el.classList.add(extraTdClass);
  if (value == null || value === '') {
    el.textContent = '—';
    el.classList.add('empty');
    return el;
  }
  const span = document.createElement('span');
  span.className = `badge ${badgeClass}`;
  span.textContent = String(value);
  el.appendChild(span);
  return el;
}

/**
 * Map a Property Type string (Residential / Industrial / Commercial)
 * to the matching badge-pt-* modifier. Unknown values get the base
 * pill (no colour family).
 */
function propertyTypeBadgeClass(value) {
  if (!value) return 'badge-property-type';
  const v = String(value).trim().toLowerCase();
  if (v === 'residential') return 'badge-property-type badge-pt-residential';
  if (v === 'industrial')  return 'badge-property-type badge-pt-industrial';
  if (v === 'commercial')  return 'badge-property-type badge-pt-commercial';
  return 'badge-property-type';
}

/**
 * Cell variant that truncates long values to `maxChars`, appends an
 * ellipsis, and exposes the full string on hover via the `title`
 * attribute. Used for the Lot column (multi-lot merges run long) and
 * the Full Address column (multi-address parcels concatenate every
 * civic address). Cursor changes to `help` so the truncation is
 * visually discoverable.
 */
function truncatedTd(value, maxChars, className) {
  const el = document.createElement('td');
  if (value == null || value === '') {
    el.textContent = '—';
    el.classList.add('empty');
    return el;
  }
  const str = String(value);
  if (str.length > maxChars) {
    el.textContent = str.slice(0, maxChars) + '…';
    el.title = str;
    el.style.cursor = 'help';
  } else {
    el.textContent = str;
  }
  if (className) el.classList.add(className);
  return el;
}

/**
 * Strip the verbose suffix off d4mq-wa44 zoning text. The fallback
 * value when the area-weighted enrichment doesn't produce a code
 * looks like "R1M - RES - S F - MEDIUM"; we want just "R1M". When
 * the source already has no " - " (the dxrp-w6re top-1 enrichment
 * returns clean codes like "R1-M", "C2", "PR1"), this is a no-op.
 */
function stripZoningCode(value) {
  if (value == null || value === '') return value;
  return String(value).split(' - ')[0].trim();
}

/**
 * Capture the current interactive-map view as a static <img> embedded
 * below the table. Forces a synchronous repaint first (waits for the
 * `idle` event) so the snapshot captures every layer in its final
 * state — without that, mid-loading tiles or a half-finished animation
 * frame can show up in the PNG.
 *
 * The map was created with preserveDrawingBuffer:true so that
 * canvas.toDataURL() returns real bytes; without that flag the buffer
 * is cleared between frames and the read returns transparent black.
 */
async function generateStaticMap() {
  if (!$staticMapOutput) return;
  await mapReady;
  $staticMapBtn.disabled = true;
  const originalLabel = $staticMapBtn.textContent;
  $staticMapBtn.textContent = 'Capturing…';
  try {
    await new Promise((resolve) => {
      const onIdle = () => { map.off('idle', onIdle); resolve(); };
      map.on('idle', onIdle);
      map.triggerRepaint();
    });
    const canvas = map.getCanvas();
    const dataUrl = composeWithAttribution(canvas);
    $staticMapOutput.hidden = false;
    $staticMapOutput.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = 'Static snapshot of the current map view';
    img.title = 'Right-click → Save Image As… to drop into a report';
    $staticMapOutput.appendChild(img);
    $staticMapOutput.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error('static map capture failed', err);
    $staticMapOutput.hidden = false;
    $staticMapOutput.innerHTML = '<p style="color:#c0392b">Capture failed — try toggling the satellite basemap and re-trying. If it persists, check the browser console.</p>';
  } finally {
    $staticMapBtn.disabled = false;
    $staticMapBtn.textContent = originalLabel;
  }
}

/**
 * Compose a new canvas with the map canvas content + a credit pill in
 * the bottom-right. Pulls the live MapLibre attribution string so the
 * pill stays in sync with whichever sources/overlays are visible
 * (basemap + zoning + survey + assess) without us having to enumerate
 * them. Returns a PNG data URL ready for an <img>.src.
 */
function composeWithAttribution(srcCanvas) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(srcCanvas, 0, 0);

  const attribEl = $mapEl.querySelector('.maplibregl-ctrl-attrib-inner') ||
                   $mapEl.querySelector('.maplibregl-ctrl-attrib');
  let text = attribEl ? attribEl.innerText.replace(/\s+/g, ' ').trim() : '';
  if (!text) text = '© OpenStreetMap © CARTO';

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const fontSize = Math.max(11, Math.round(11 * dpr * 0.9));
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  const maxWidth = Math.floor(w * 0.85);
  const lines = wrapToWidth(ctx, text, maxWidth);
  const padX = 8;
  const padY = 5;
  const lineHeight = Math.round(fontSize * 1.25);
  const blockH = lines.length * lineHeight + padY * 2 - (lineHeight - fontSize);
  let blockW = 0;
  for (const line of lines) blockW = Math.max(blockW, ctx.measureText(line).width);
  blockW = Math.ceil(blockW + padX * 2);
  const x0 = w - blockW - 6;
  const y0 = h - blockH - 6;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillRect(x0, y0, blockW, blockH);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, blockW - 1, blockH - 1);
  ctx.fillStyle = '#1a1a1a';
  for (let i = 0; i < lines.length; i++) {
    const yMid = y0 + padY + i * lineHeight + Math.round(fontSize / 2);
    ctx.fillText(lines[i], x0 + padX, yMid);
  }
  return out.toDataURL('image/png');
}

/** Greedy word-wrap on a 2D canvas context. */
function wrapToWidth(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Build a `<td>` containing an external link. `url` is the full URL;
 * `label` is the visible link text. Falls back to an em-dash when no
 * URL can be built (e.g. parcel has no address). Click bubbles up to
 * the row's click-to-fly handler — `stopPropagation` on the anchor
 * prevents that so the user's link click doesn't also fly the map.
 */
function linkTd(url, label) {
  const el = document.createElement('td');
  if (!url) {
    el.textContent = '—';
    el.classList.add('empty');
    return el;
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  a.addEventListener('click', (e) => e.stopPropagation());
  el.appendChild(a);
  return el;
}

/**
 * Build the City's assessment-page URL for a parcel. The d4mq-wa44
 * dataset has a `detail_url` field but it points at
 * `http://www.winnipegassessment.com/...` whose HTTPS redirect lands
 * on a host whose cert has a CN mismatch — Chrome shows a "Your
 * connection is not private" warning (ERR_CERT_COMMON_NAME_INVALID).
 * The City's canonical working host is `assessment.winnipeg.ca` —
 * same AsmtPub path, valid cert. We ignore the dataset's URL and
 * build from `roll_number` directly.
 */
function assessmentUrl(props) {
  if (!props?.roll_number) return null;
  return `https://assessment.winnipeg.ca/AsmtPub/english/propertydetails/details.aspx?pgLang=EN&isRealtySearch=true&RollNumber=${encodeURIComponent(props.roll_number)}`;
}

/**
 * Build a `<td>` for the Assessment column: shows the formatted dollar
 * total as a clickable link to the parcel's record on
 * winnipegassessment.com. Falls back to the dollar amount as plain
 * text when no link can be built; em-dash when even the dollar amount
 * is missing.
 */
function assessmentTd(props) {
  const el = document.createElement('td');
  el.classList.add('num');
  const value = props?.total_assessed_value;
  const formatted = formatDollars(value);
  if (!formatted) {
    el.textContent = '—';
    el.classList.add('empty');
    return el;
  }
  const url = assessmentUrl(props);
  if (!url) {
    el.textContent = formatted;
    return el;
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = formatted;
  a.title = `Open Roll ${props.roll_number} on winnipegassessment.com`;
  a.addEventListener('click', (e) => e.stopPropagation());
  el.appendChild(a);
  return el;
}

/** Format a numeric dollar amount like "$723,000". null on bad input. */
function formatDollars(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return '$' + Math.round(n).toLocaleString('en-US');
}

/**
 * Build a Walk Score URL from a civic address. Walk Score's web page at
 * /score/<address> renders Walk / Transit / Bike scores on arrival, no
 * API key needed. Returns null when the address is missing or only
 * contains the multi-address comma-list — we use just the primary
 * address (text before the first comma) for cleanliness.
 */
function walkscoreUrl(fullAddress) {
  if (!fullAddress) return null;
  // Take only the primary address before any comma-joined extras.
  const primary = String(fullAddress).split(',')[0].trim();
  if (!primary) return null;
  return `https://www.walkscore.com/score/${encodeURIComponent(primary + ', Winnipeg, MB')}`;
}

/**
 * Build a deep-link into the sister Manitoba flood-mapping tool with the
 * parcel's centroid and address pre-filled. Falls back to address-only
 * when centroid is unavailable.
 */
function floodToolUrl(props) {
  if (!props) return null;
  const lat = Number(props.centroid_lat);
  const lon = Number(props.centroid_lon);
  const address = (props.full_address || '').split(',')[0].trim();
  const params = new URLSearchParams();
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set('lat', lat.toFixed(6));
    params.set('lon', lon.toFixed(6));
  }
  if (address) params.set('label', address);
  if (![...params.keys()].length) return null;
  return `https://mb-flood-mapping.vercel.app/?${params.toString()}`;
}

// Format an area-weighted-zoning coverage % for the table cell. Whole
// percent precision keeps the column narrow; sub-1% values are
// suppressed (those are digitization slivers, not real coverage).
function formatPct(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return `${Math.round(n)}%`;
}

// Build the "Zoning 2" cell value. Combines code + % so the user can
// see both at a glance without an extra column dedicated to the
// secondary %. Returns null when there's no top-2 (suppressed at the
// soda.js level when < 1% coverage).
function formatZone2(code, pct) {
  if (!code) return null;
  if (pct == null) return code;
  return `${code} (${Math.round(pct)}%)`;
}

// Assessment land area is now formatted via lib/format.js's
// formatSqFt — same shape (`1,234`) but en-CA locale and shared
// across the eventual Sales Analysis tab. The local formatArea
// helper has been removed; replace any future callers with
// formatSqFt(v).

// Winnipeg serves centroid_lat / centroid_lon as strings with way more
// precision than anyone needs. 6 decimals is ~10 cm at this latitude.
function formatCoord(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(6);
}

// Format a distance in kilometres to one decimal. Used by the
// sales-mode Dist column when a subject roll is set.
function formatDist(km) {
  if (km == null) return null;
  const n = Number(km);
  if (!Number.isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

// ===============================================================
// Phase 7 — Sales Analysis tab
// ===============================================================
//
// CSV upload + dedup + group flow. Phase 7 (1/2) parses + dedups
// + groups and reports the counts in the sidebar. Phase 7 (2/2)
// fetches live d4mq-wa44 data for every distinct roll, renders
// sales-mode columns, applies the sentinel + subject-distance
// filters, and defers zoning enrichment to the Zoning overlay
// toggle.

// Module-scope sales state. salesData stays null until the user
// drops a CSV. The shape is:
//   { sales: SaleRecord[], rolls: Set<string>, groups: Map<inst, SaleRecord[]> }
let salesData = null;

// PUCS multi-select filter state. `null` = no filter (all PUCS
// values pass); otherwise a Set of selected PUCS codes (rows whose
// useCode is in the Set pass). Reset to null on every fresh CSV.
let salesPucsFilter = null;

// Monotonically increasing token so concurrent runSalesAnalysis
// calls (e.g. user rapid-clicking PUCS checkboxes) only let the
// most recent run mutate the DOM. Earlier runs check the token
// before render and abort if a newer run has started.
let salesRunToken = 0;

// Required columns the CSV must contain. The parser is tolerant
// of extra columns and surrounding whitespace, but missing any of
// these surfaces an error in the sidebar status.
const SALES_REQUIRED_COLS = [
  'Parcel ID', 'Sale Dates', 'Sold Price', 'Instrument Number',
];

/**
 * Normalize a Winnipeg roll number to its 11-digit zero-padded
 * canonical form. The CSV strips leading zeros from short rolls
 * (e.g. `6070731000` instead of `06070731000`), but d4mq-wa44
 * stores them padded. soda.js's rollClause already normalizes on
 * the query side; this helper makes the client-side joins
 * (matchedRolls.has, saleByRoll.get, subject lookups) line up.
 */
function normalizeRoll(token) {
  const digits = String(token ?? '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  return digits.length >= 11 ? digits : digits.padStart(11, '0');
}

function wireSalesTab() {
  const $dropzone = document.getElementById('sales-dropzone');
  const $fileInput = document.getElementById('sales-file-input');
  const $salesCount = document.getElementById('sales-count');
  if (!$dropzone || !$fileInput) return;

  // Click anywhere in the dropzone -> open the native file picker.
  // Enter / Space when the dropzone is focused does the same.
  function openPicker() { $fileInput.click(); }
  $dropzone.addEventListener('click', openPicker);
  $dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });

  $fileInput.addEventListener('change', () => {
    const file = $fileInput.files?.[0];
    if (file) loadSalesCsv(file);
    // Reset so re-selecting the same file re-fires change.
    $fileInput.value = '';
  });

  // Drag + drop. dragover must preventDefault for the drop to fire.
  $dropzone.addEventListener('dragenter', (e) => {
    e.preventDefault(); $dropzone.classList.add('drag-over');
  });
  $dropzone.addEventListener('dragover', (e) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  });
  $dropzone.addEventListener('dragleave', (e) => {
    if (e.target === $dropzone) $dropzone.classList.remove('drag-over');
  });
  $dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    $dropzone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) loadSalesCsv(file);
  });

  // Subject-roll chip input. Same lib as #roll; hidden input
  // #subject-roll holds the canonical value. Re-runs the analysis
  // on change so the Dist column populates / clears.
  const $subjectRollChip = document.querySelector('.chip-input[data-target="subject-roll"]');
  if ($subjectRollChip) initChipInput($subjectRollChip);
  const $subjectRoll = document.getElementById('subject-roll');
  if ($subjectRoll) {
    $subjectRoll.addEventListener('input', () => {
      queueUrlWrite();
      if (salesData) runSalesAnalysis();
    });
  }

  // Hide-sentinels toggle. Re-runs the analysis to apply / remove
  // the $0/$1 filter.
  const $hideSentinels = document.getElementById('sales-hide-sentinels');
  if ($hideSentinels) {
    $hideSentinels.addEventListener('change', () => {
      if (salesData) runSalesAnalysis();
    });
  }

  // Sale-date range. Either bound can stay empty for an open-ended
  // filter. Re-runs the analysis on every change.
  const $dateFrom = document.getElementById('sales-date-from');
  const $dateTo   = document.getElementById('sales-date-to');
  if ($dateFrom) {
    $dateFrom.addEventListener('change', () => { if (salesData) runSalesAnalysis(); });
  }
  if ($dateTo) {
    $dateTo.addEventListener('change', () => { if (salesData) runSalesAnalysis(); });
  }

  // PUCS multi-select filter. Button toggles the popover; the
  // popover's checkboxes drive salesPucsFilter and re-run the
  // analysis on change. Click-away + Esc dismiss.
  const $pucsBtn = document.getElementById('pucs-filter-btn');
  const $pucsPopover = document.getElementById('pucs-filter-popover');
  if ($pucsBtn && $pucsPopover) {
    $pucsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if ($pucsBtn.disabled) return;
      const open = $pucsPopover.classList.toggle('open');
      $pucsBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!$pucsPopover.classList.contains('open')) return;
      if ($pucsPopover.contains(e.target) || $pucsBtn.contains(e.target)) return;
      $pucsPopover.classList.remove('open');
      $pucsBtn.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $pucsPopover.classList.contains('open')) {
        $pucsPopover.classList.remove('open');
        $pucsBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  setSalesCount('');
}

/**
 * Rebuild the PUCS filter popover from the current salesData.
 * Each distinct PUCS gets a checkbox + label + per-PUCS count.
 * Selecting / unselecting re-runs the analysis. Empty selection
 * (nothing checked) is treated the same as all-checked: no filter,
 * to avoid the trap of "filtered to zero results."
 */
function rebuildPucsFilter() {
  const $btn = document.getElementById('pucs-filter-btn');
  const $popover = document.getElementById('pucs-filter-popover');
  if (!$btn || !$popover) return;

  if (!salesData || !salesData.sales.length) {
    $btn.disabled = true;
    $btn.querySelector('.sales-pucs-btn-label').textContent = 'Filter by PUCS';
    $popover.innerHTML = '';
    $popover.classList.remove('open');
    $btn.setAttribute('aria-expanded', 'false');
    return;
  }

  // Tally per-PUCS row counts (count distinct sales, not raw CSV
  // rows, because dedup already collapsed multi-building entries).
  const counts = new Map();
  for (const s of salesData.sales) {
    const k = s.useCode || '(blank)';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const codes = [...counts.keys()].sort();

  // Reset filter to "all" whenever the set of codes changes between
  // CSV uploads. salesPucsFilter null means no filter; once the
  // user picks a subset it becomes a Set.
  if (salesPucsFilter == null) {
    // no-op — null is the default, "all selected" rendering
  } else {
    // Drop any codes from the saved selection that no longer exist.
    const valid = new Set(codes);
    for (const c of [...salesPucsFilter]) if (!valid.has(c)) salesPucsFilter.delete(c);
    if (salesPucsFilter.size === codes.length) salesPucsFilter = null;
  }

  $btn.disabled = false;
  const selectedCount = salesPucsFilter == null ? codes.length : salesPucsFilter.size;
  $btn.querySelector('.sales-pucs-btn-label').textContent =
    salesPucsFilter == null
      ? `Filter by PUCS · all ${codes.length}`
      : `Filter by PUCS · ${selectedCount} of ${codes.length}`;

  $popover.innerHTML = '';
  const actions = document.createElement('div');
  actions.className = 'sales-pucs-popover-actions';
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.textContent = 'All';
  allBtn.addEventListener('click', () => {
    salesPucsFilter = null;
    rebuildPucsFilter();
    runSalesAnalysis();
  });
  const noneBtn = document.createElement('button');
  noneBtn.type = 'button';
  noneBtn.textContent = 'None';
  noneBtn.addEventListener('click', () => {
    salesPucsFilter = new Set();
    rebuildPucsFilter();
    runSalesAnalysis();
  });
  actions.appendChild(allBtn);
  actions.appendChild(noneBtn);
  $popover.appendChild(actions);

  for (const code of codes) {
    const label = document.createElement('label');
    label.className = 'sales-pucs-popover-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = salesPucsFilter == null || salesPucsFilter.has(code);
    cb.addEventListener('change', () => {
      // First user-driven change materializes the filter Set.
      if (salesPucsFilter == null) salesPucsFilter = new Set(codes);
      if (cb.checked) salesPucsFilter.add(code);
      else salesPucsFilter.delete(code);
      // If all codes are checked, collapse back to "no filter".
      if (salesPucsFilter.size === codes.length) salesPucsFilter = null;
      // Update the button label inline; no full rebuild needed
      // until the user reopens the popover.
      const sel = salesPucsFilter == null ? codes.length : salesPucsFilter.size;
      $btn.querySelector('.sales-pucs-btn-label').textContent =
        salesPucsFilter == null
          ? `Filter by PUCS · all ${codes.length}`
          : `Filter by PUCS · ${sel} of ${codes.length}`;
      runSalesAnalysis();
    });
    const text = document.createElement('span');
    text.textContent = code;
    const count = document.createElement('span');
    count.className = 'sales-pucs-popover-count';
    count.textContent = `${counts.get(code)}`;
    label.appendChild(cb);
    label.appendChild(text);
    label.appendChild(count);
    $popover.appendChild(label);
  }
}

async function loadSalesCsv(file) {
  try {
    setSalesCount(`Reading ${file.name}…`);
    const text = await file.text();
    const rows = parseSalesCsv(text);
    if (!rows.length) {
      setSalesCount(`No data rows found in ${file.name}.`, true);
      return;
    }
    const missing = SALES_REQUIRED_COLS.filter((c) => !(c in rows[0]));
    if (missing.length) {
      setSalesCount(`CSV is missing required column(s): ${missing.join(', ')}.`, true);
      return;
    }
    salesData = dedupAndGroupSales(rows);
    // Fresh CSV = fresh filter. The user's previous PUCS picks
    // don't carry across uploads (different sale sets, different
    // codes).
    salesPucsFilter = null;
    rebuildPucsFilter();
    await runSalesAnalysis();
  } catch (err) {
    console.warn('Sales CSV load failed:', err);
    setSalesCount(`Couldn't read ${file.name}: ${err.message || 'unknown error'}.`, true);
  }
}

/**
 * Minimal CSV parser. The Winnipeg sales CSV is comma-separated
 * with no embedded commas, no quoting, no escaped newlines —
 * pasted directly from the City's exporter. If a future variant
 * adds quoting we'll swap to PapaParse (a sanctioned new dep
 * conversation, not snuck in here).
 *
 * Returns an array of objects keyed by header name. Leading /
 * trailing whitespace stripped from each cell.
 */
function parseSalesCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length === 1 && !cells[0].trim()) continue; // blank
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cells[j] ?? '').trim();
    }
    out.push(row);
  }
  return out;
}

/**
 * Dedup by (Parcel ID, Instrument Number) — multi-building rows
 * on the same sale roll up into one record. Then group by
 * Instrument Number so multi-parcel sales can compute group
 * aggregates ($/Lot, $/Acre, group size) in Phase 7 (2/2).
 *
 * Returns:
 *   {
 *     sales: SaleRecord[],          // one per (roll, instrument)
 *     rolls: Set<string>,           // distinct rolls
 *     groups: Map<instrument, SaleRecord[]>  // sale-level groups
 *   }
 */
function dedupAndGroupSales(rows) {
  const merged = new Map(); // key = `${roll}|${instrument}`
  for (const r of rows) {
    // 11-digit zero-pad so 10-digit CSV rolls (`6070731000`) match
    // their 11-digit d4mq-wa44 records (`06070731000`).
    const roll = normalizeRoll(r['Parcel ID']);
    const inst = String(r['Instrument Number'] ?? '').trim();
    if (!roll || !inst) continue;
    const key = `${roll}|${inst}`;
    const existing = merged.get(key);
    const livingArea = Number.parseFloat(r['Living Area']) || 0;
    if (!existing) {
      merged.set(key, {
        roll,
        instrument: inst,
        saleDate: r['Sale Dates'] || null,
        salePrice: Number.parseFloat(r['Sold Price']) || 0,
        landSf: Number.parseFloat(r['Land Actual sqft']) || 0,
        landAssessedSf: Number.parseFloat(r['Land Assessed sqft']) || 0,
        livingArea,
        yearBuilt: r['Year Built'] || null,
        useCode: r['Par Use Code'] || null,
        propertyType: r['Property Type'] || null,
        propertySubType: r['Property Sub Type'] || null,
        streetNumber: r['Street Number'] || null,
        streetDirection: r['Street Direction'] || null,
        streetName: r['Street Name'] || null,
        numUnits: Number.parseInt(r['Number of Unit'], 10) || null,
      });
    } else {
      // Merge: same Parcel ID + same Instrument Number = multiple
      // building components on one sale. Sum living area across
      // them; keep the OLDEST (smallest) Year Built so e.g. the
      // HIGGINS rows at 2008 / 2012 / 2012 report 2008. Use code
      // falls back to the first non-empty value.
      existing.livingArea += livingArea;
      const yb = Number.parseInt(r['Year Built'], 10);
      const existingYb = Number.parseInt(existing.yearBuilt, 10);
      if (Number.isFinite(yb) && (!Number.isFinite(existingYb) || yb < existingYb)) {
        existing.yearBuilt = r['Year Built'];
      }
      if (!existing.useCode && r['Par Use Code']) existing.useCode = r['Par Use Code'];
    }
  }
  const sales = Array.from(merged.values());
  const rolls = new Set(sales.map((s) => s.roll));
  const groups = new Map();
  for (const s of sales) {
    if (!groups.has(s.instrument)) groups.set(s.instrument, []);
    groups.get(s.instrument).push(s);
  }
  return { sales, rolls, groups };
}

function setSalesCount(text, isError = false) {
  const el = document.getElementById('sales-count');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('results-status-error', !!isError && !!text);
}

/**
 * Phase 7 (2/2): join the parsed CSV against live d4mq-wa44 data
 * and render in sales mode. Re-runs on every relevant change
 * (sentinel toggle, subject roll). Sales rows that don't match a
 * live record are still rendered, flagged with _noLiveMatch.
 */
async function runSalesAnalysis() {
  if (!salesData || !salesData.sales.length) return;
  const myToken = ++salesRunToken;
  const hideSentinels = document.getElementById('sales-hide-sentinels')?.checked;
  let visibleSales = hideSentinels
    ? salesData.sales.filter((s) => s.salePrice > 1)
    : salesData.sales.slice();
  // PUCS multi-select. null = no filter; empty Set = "no codes
  // selected" which we treat as a deliberate "show nothing" (the
  // status message hints to use the All button).
  if (salesPucsFilter != null) {
    visibleSales = visibleSales.filter((s) => salesPucsFilter.has(s.useCode || '(blank)'));
  }
  // Sale-date range. CSV dates are ISO YYYY-MM-DD so lexical >= / <=
  // comparison works without parsing.
  const dateFrom = (document.getElementById('sales-date-from')?.value || '').trim();
  const dateTo   = (document.getElementById('sales-date-to')?.value || '').trim();
  if (dateFrom) visibleSales = visibleSales.filter((s) => s.saleDate && s.saleDate >= dateFrom);
  if (dateTo)   visibleSales = visibleSales.filter((s) => s.saleDate && s.saleDate <= dateTo);
  if (!visibleSales.length) {
    let msg;
    if (salesPucsFilter && salesPucsFilter.size === 0) {
      msg = `No PUCS selected — click All in the Filter by PUCS popover, or pick one or more codes.`;
    } else if (dateFrom || dateTo) {
      msg = `${salesData.sales.length} sales loaded, but none fall inside the selected date range.`;
    } else if (salesPucsFilter) {
      msg = `${salesData.sales.length} sales loaded, but none match the current PUCS filter.`;
    } else {
      msg = `All ${salesData.sales.length} sales are $0 / $1 transfers — uncheck "Hide non-arms-length" to view.`;
    }
    setSalesCount(msg, true);
    document.body.classList.remove('sales-mode');
    setColumnMode('property');
    clearTable();
    setParcels(EMPTY_FC, EMPTY_FC);
    return;
  }
  setSalesCount(`Fetching live data for ${visibleSales.length} parcels…`);
  document.body.classList.add('sales-mode');
  // Swap the column-visibility set to the Sales Analysis default
  // (or whatever the user's persisted sales-mode customization is).
  setColumnMode('sales');

  const rolls = [...new Set(visibleSales.map((s) => s.roll))];
  let assessFc;
  try {
    // Phase 7 deferral: use the non-expanded search so zoning +
    // civic-address enrichment doesn't fire on every CSV upload
    // (those add ~10s on a cold cache for 100+ rolls). The Zoning
    // overlay toggle picks it up later via the deferred-enrichment
    // hook in toggleZoning.
    assessFc = await searchAssessmentParcels({ roll: rolls.join(',') });
  } catch (err) {
    console.warn('Sales live-data fetch failed:', err);
    setSalesCount(`Couldn't fetch live data: ${err.message || 'unknown error'}.`, true);
    return;
  }

  // Resolve the subject parcel's centroid (if any) — pulled from
  // the result set first, then from a one-off fetch when the
  // subject isn't in the CSV. Normalize the raw subject input to
  // the 11-digit canonical form so it lines up with d4mq-wa44's
  // roll_number values.
  const subjectRollRaw = (document.getElementById('subject-roll')?.value || '').trim();
  const subjectRoll = normalizeRoll(subjectRollRaw);
  let subjectCentroid = null;
  let subjectFeature = null;
  if (subjectRoll) {
    const hit = assessFc.features.find((f) => String(f.properties?.roll_number) === subjectRoll);
    if (hit) {
      subjectFeature = hit;
      subjectCentroid = featureCentroid(hit);
    } else {
      try {
        const subFc = await searchAssessmentParcels({ roll: subjectRoll });
        const sf = subFc.features[0];
        if (sf) {
          subjectFeature = sf;
          subjectCentroid = featureCentroid(sf);
        }
      } catch (err) {
        console.warn('Subject roll fetch failed:', err);
      }
    }
  }
  document.body.classList.toggle('subject-set', subjectCentroid != null);

  // Paint the subject parcel as a blue highlight over the yellow
  // sale-results assess-context layer. Push the geometry-bearing
  // feature (not just the centroid) so the polygon outline lights
  // up — appraisers like to see the subject's footprint, not just
  // a point. Clear the layer when no subject is set.
  mapReady.then(() => {
    setSubjectData(map, subjectFeature
      ? { type: 'FeatureCollection', features: [subjectFeature] }
      : null);
  });

  // Stamp sale + computed fields onto every matching feature.
  // Multi-parcel sales (>1 distinct Parcel ID sharing an Instrument
  // Number, e.g. 630 Kildare) need group totals: the Sold Price is
  // the same on every row (the full sale total), so $/Lot SF is
  // price ÷ sum-of-land-across-the-group, and Sale/Asmt is
  // price ÷ sum-of-assessments-across-the-group.
  const saleByRoll = new Map();
  for (const s of visibleSales) saleByRoll.set(s.roll, s);
  const liveByRoll = new Map();
  for (const f of assessFc.features) {
    const r = String(f.properties?.roll_number ?? '');
    if (r) liveByRoll.set(r, f);
  }
  for (const f of assessFc.features) {
    const p = f.properties || {};
    const sale = saleByRoll.get(String(p.roll_number));
    if (!sale) continue;
    const group = salesData.groups.get(sale.instrument) || [sale];
    const isMulti = group.length > 1;
    p._saleDate = sale.saleDate;
    p._salePrice = sale.salePrice > 0 ? sale.salePrice : null;
    p._saleInstrument = sale.instrument;
    p._saleGroupSize = group.length;
    p._saleUseCode = sale.useCode;
    p._salePropertyType = sale.propertyType;
    p._saleLivingArea = sale.livingArea > 0 ? sale.livingArea : null;
    p._saleYearBuilt = sale.yearBuilt;
    // $/Lot SF: divide by group land for multi-parcel sales.
    let landSf = sale.landSf;
    if (isMulti) {
      landSf = group.reduce((sum, g) => sum + (g.landSf || 0), 0);
    }
    if (p._salePrice && landSf > 0) p._pricePerSf = p._salePrice / landSf;
    // Sale/Asmt: divide by group assessment for multi-parcel sales.
    // Sums best-effort across the live features we have; a missing
    // live record on one group member just makes the denominator
    // smaller (Sale/Asmt slightly overstated).
    let asmt = Number(p.total_assessed_value) || 0;
    if (isMulti) {
      asmt = group.reduce((sum, g) => {
        const live = liveByRoll.get(g.roll);
        return sum + (Number(live?.properties?.total_assessed_value) || 0);
      }, 0);
    }
    // Sale / Asmt as a percentage value (e.g. 101 for a sale at
    // 1% over assessed). The local formatPct expects 0-100 input.
    if (p._salePrice && asmt > 0) p._saleToAsmt = (p._salePrice / asmt) * 100;
    if (subjectCentroid) {
      const c = featureCentroid(f);
      if (c) p._dist = haversineKm(subjectCentroid, c);
    }
  }

  // Inject synthetic features for sale rolls that have no live
  // d4mq-wa44 match — so the appraiser still sees the row.
  const matchedRolls = new Set(assessFc.features.map((f) => String(f.properties?.roll_number)));
  for (const sale of visibleSales) {
    if (matchedRolls.has(sale.roll)) continue;
    assessFc.features.push({
      type: 'Feature',
      geometry: null,
      properties: {
        roll_number: sale.roll,
        full_address: [sale.streetNumber, sale.streetDirection, sale.streetName]
          .filter(Boolean).join(' '),
        _noLiveMatch: true,
        _saleDate: sale.saleDate,
        _salePrice: sale.salePrice > 0 ? sale.salePrice : null,
        _saleInstrument: sale.instrument,
        _saleUseCode: sale.useCode,
        _salePropertyType: sale.propertyType,
        _saleLivingArea: sale.livingArea > 0 ? sale.livingArea : null,
        _saleYearBuilt: sale.yearBuilt,
      },
    });
  }

  tagFeatures(assessFc, 'assess');

  // Race guard: if a newer runSalesAnalysis started while we were
  // awaiting the SODA + subject fetches, drop this run's results
  // on the floor. Otherwise an earlier (more permissive) filter's
  // late-resolving response could overwrite the latest filter.
  if (myToken !== salesRunToken) return;

  // Zoning is deferred: even with the Zoning overlay toggle ON,
  // we don't auto-fetch zoning for every sale row. The toggle
  // handler picks up the current parcel FC and runs
  // enrichAssessmentZoning then re-renders. See toggleZoning.
  lastParcelFc = assessFc;
  lastSurveyFc = EMPTY_FC;

  const rows = assessFc.features.map((f) => ({ assess: f, survey: null }));
  const unmatched = rows.filter((r) => r.assess.properties._noLiveMatch).length;
  setSalesCount(
    `${rows.length} sale${rows.length === 1 ? '' : 's'} shown` +
    (unmatched ? ` · ${unmatched} not in d4mq-wa44` : '')
  );

  // Draw matched parcels on the map.
  const mappable = {
    type: 'FeatureCollection',
    features: assessFc.features.filter((f) => f.geometry),
  };
  setParcels(EMPTY_FC, mappable);

  renderTable(rows);
}

function featureCentroid(f) {
  if (!f) return null;
  const p = f.properties || {};
  const lat = Number(p.centroid_lat);
  const lon = Number(p.centroid_lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return [lon, lat];
  return null;
}

// Haversine distance between two [lon, lat] points, in kilometres.
// Good enough for sales-comparison work (~10 m accuracy at city scale).
function haversineKm(a, b) {
  if (!a || !b) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

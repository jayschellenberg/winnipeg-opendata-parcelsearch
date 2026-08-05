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
  searchAssessmentParcelsByRolls,
  searchAssessmentParcelsExpanded,
  fetchSurveyOverlap,
  joinAssessmentWithSurvey,
  fetchCityZoning,
  computePartialSurveyIds,
  enrichAssessmentAddresses,
  enrichAssessmentZoning,
  filterMatchedSurveys,
  filterMatchedAssessments,
  fetchSecondaryPlans,
  fetchInfillGuidelineArea,
  fetchMallsAndCorridors,
  fetchTrafficVolumes,
  fetchContaminatedSites,
  fetchTransitRoutes,
  fetchTransitStops,
  fetchNeighbourhoods,
  fetchNeighbourhoodClusters,
  fetchWinnipegStreets,
  fetchHistoricalIndex,
  fetchHistoricalManifest,
  fetchHistoricalShard,
  fetchHistoricalZoning,
  fetchHistoricalLineage,
  fetchCurrentAssessmentInBbox,
} from './soda.js';
import {
  initMap, showResults, setZoningData, setZoningMode, flyToFeature,
  setOverlayData, setOverlayVisible, ZONING_PALETTE, setCivicAddresses,
  setDimensions, setDimensionsVisible, setTrafficData, setTrafficVisible,
  setCitywideParcelsVisible, setDwellingUnitsVisible, probeCitywideParcels,
  setContamData, setContamVisible,
  setSubjectData,
  setHistoricalData, setHistoricalVisible,
  setHistoricalZoningData, setHistoricalZoningVisible,
} from './map.js';
import {
  getShapes as getMapShapes,
  resetShapesSilently,
  onShapesChanged,
} from './drawShapes.js';
// Aliased: main.js already has its own featureCentroid for the sales-tab
// subject distance, which returns a [lon, lat] ARRAY from the
// centroid_lat/lon properties only. The shape-filter pair returns
// {lng, lat} and reads real geometry — different contracts, kept apart.
import {
  passesShapeFilter,
  featureCentroid as shapeFeatureCentroid,
  rowCentroid as shapeRowCentroid,
} from './lib/shapeFilter.js';
import { parseSalesText, describeHeaderProblem } from './lib/salesImport.js';
import { initSalesPasteImport } from './lib/salesPasteImport.js';
import { computeSizeChanges } from './lib/sizeChange.js';
import { normalizeRoll, dedupAndGroupSales, buildSaleFeatures } from './lib/sales.js';
import { assessmentUrl } from './lib/links.js';   // walkscoreUrl/floodToolUrl used only inside registry render functions now
import { COLUMNS, csvSchemaForMode, buildThead } from './lib/columnsRegistry.js';
// Cell-value formatters still used by the parcel-summary card (not table cells).
// The DOM constructors td/badgeTd/linkTd/etc are consumed inside the registry
// render functions and never need to be imported here.
import { stripZoningCode, formatPct, formatDollars, formatCoord } from './lib/cells.js';

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
const $dimensionsToggle     = document.getElementById('dimensions-toggle');
const $allParcelsToggle     = document.getElementById('all-parcels-toggle');
const $dwellingUnitsToggle  = document.getElementById('dwelling-units-toggle');
const $contamToggle         = document.getElementById('contam-toggle');
const $transitToggle        = document.getElementById('transit-toggle');
const $neighbourhoodsToggle = document.getElementById('neighbourhoods-toggle');
const $streetsToggle        = document.getElementById('streets-toggle');
const $count = document.getElementById('count');
const $tbody = document.querySelector('#results tbody');

// Populate the (empty) #results thead row from the column registry.
// MUST run before the sort-handler wiring loop below (which calls
// querySelectorAll('#results th[data-col]')) — otherwise no handlers
// would be attached to the dynamically-built ths.
buildThead(document.querySelector('#results thead tr'));

const $mapEl = document.getElementById('map');
const $staticMapBtn = document.getElementById('static-map-btn');
const $staticMapOutput = document.getElementById('static-map-output');
const $zoningLegend = document.getElementById('zoning-legend');
const $trafficLegend = document.getElementById('traffic-legend');
const $historicalToggle = document.getElementById('historical-toggle');
const $historicalArea   = document.getElementById('historical-area');
const $historicalDate   = document.getElementById('historical-date');
const $historicalBanner = document.getElementById('historical-banner');

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// Most recent table rows, kept around for CSV export. When a drawn-shape
// area filter is active this holds the NARROWED set — export, sort and
// the map all follow the table.
let currentRows = [];

// The unfiltered row set most recently handed to renderTable. Erasing a
// shape re-runs the filter against this instead of re-searching, and a
// search/enrichment re-render that lands while shapes are drawn narrows
// consistently because renderTable is the single funnel.
let fullRows = [];
// Counts behind the "· X of Y shown (area filter)" clause setCount appends.
let shapeShown = 0;
let shapeTotal = 0;
// Unfiltered FCs most recently pushed through setParcels, so a shape
// change can re-narrow them without re-searching.
let lastFullSurveyFc = { type: 'FeatureCollection', features: [] };
let lastFullAssessFc = { type: 'FeatureCollection', features: [] };
// Count messages WITHOUT the area-filter clause, so a shape change can
// re-render each line without the caller handing the base text back.
// Declared up here rather than beside setCount/setSalesCount because
// wireSalesTab() calls setSalesCount during module evaluation — a `let`
// further down the file is still in its temporal dead zone at that point.
let lastCountBase = '';
let lastSalesCountBase = '';
let lastSalesCountError = false;
// Recent sales uploads — see the Recent-uploads section further down.
// Up here for the same temporal-dead-zone reason: wireSalesTab() calls
// populateRecentUploads() during module evaluation.
const RECENT_STORAGE_KEY = 'wpg_recent_sales_csvs_v1';
const RECENT_CAP = 5;

// Map of row key -> feature for the table-row → map-fly handler. The key
// is the same string we put on data-row-key (e.g. "a:13052686500"); the
// feature we fly to is whichever side has geometry that's most useful
// (assessment if available, else survey). Cleared on every renderTable.
const rowFeatureMap = new Map();

// Zoning overlay state. `zoningMode` cycles 'off' -> 'shading' -> 'labels' ->
// 'off' via the Zoning button. Deferred sales-mode zoning enrichment reads
// `lastFullAssessFc` (the unfiltered parcel FC most recently pushed through
// setParcels) so it can fetch zones for the current results without
// re-running the search.
let zoningMode = 'off';
let lastSurveyFc = { type: 'FeatureCollection', features: [] };
let trafficEnabled = false;
let trafficLoaded = false;
let contamEnabled = false;
let contamLoaded = false;
let transitEnabled = false;
let transitLoaded = false;
let streetsEnabled = false;
let streetsLoaded = false;
let streetsAutoManaged = false;
let streetsBeforeAerial = false;
let neighbourhoodsMode = 'off';
let neighbourhoodsLoaded = { clusters: false, individual: false };

// Phase 8 TDZ audit: these three were previously declared mid-file
// next to their toggle handlers. Hoisted up here so the Phase 8 (2/2)
// applyUrlState() can synchronously click any toggle button at init
// without tripping a Cannot access 'X' before initialization throw.
const policyOverlayState = {
  secondaryPlans: { enabled: false, loaded: false },
  infill:         { enabled: false, loaded: false },
  mallsCorridors: { enabled: false, loaded: false },
};
let dimensionsEnabled = false;
let citywideParcelsEnabled = false;
let dwellingUnitsEnabled = false;

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
  swornValue:   (r) => finiteOrNeg(r.assess?.properties?._saleSwornValue),
  numUnits:     (r) => finiteOrNeg(r.assess?.properties?._saleNumUnits),
  saleZoning:   (r) => strKey(r.assess?.properties?._saleZoning),
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
  onBasemapChange,
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
$dimensionsToggle.addEventListener('click', toggleDimensions);
$allParcelsToggle.addEventListener('click', toggleCitywideParcels);
if ($dwellingUnitsToggle) $dwellingUnitsToggle.addEventListener('click', toggleDwellingUnits);
if ($contamToggle) $contamToggle.addEventListener('click', toggleContam);
if ($transitToggle) $transitToggle.addEventListener('click', toggleTransit);
if ($neighbourhoodsToggle) $neighbourhoodsToggle.addEventListener('click', cycleNeighbourhoods);
if ($streetsToggle) $streetsToggle.addEventListener('click', toggleStreets);
if ($staticMapBtn) $staticMapBtn.addEventListener('click', generateStaticMap);
// Historical (as-of-date) overlay: a date picker feeds the toggle, which loads
// the parcel + survey shards (and lineage) for the neighbourhoods in the current
// map view from the wpg-parcel-history CDN — and reloads them as you pan/zoom.
if ($historicalToggle) $historicalToggle.addEventListener('click', () => toggleHistorical());
if ($historicalArea)   $historicalArea.addEventListener('change', onHistoricalAreaChange);
if ($historicalDate)   $historicalDate.addEventListener('change', onHistoricalDateChange);
mapReady.then(() => map.on('moveend', onHistoricalMapMove));
initHistoricalControls();
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
// .map-pane drops out of layout, while expand lets the map take the
// viewport height. Both choices persist to localStorage. Restoring or
// expanding the map needs a deferred map.resize() so MapLibre recomputes
// the canvas dimensions.
const MAP_HIDE_KEY = 'wps_map_collapsed_v1';
const MAP_EXPAND_KEY = 'wps_map_expanded_v1';
const $workspaceEl = document.getElementById('workspace');
const $mapToggleBtn = document.getElementById('map-toggle-btn');
const $mapToggleLabel = $mapToggleBtn?.querySelector('.map-toggle-label');
const $mapExpandBtn = document.getElementById('map-expand-btn');
const $mapExpandLabel = $mapExpandBtn?.querySelector('.map-expand-label');
function applyMapCollapsed(collapsed) {
  if (!$workspaceEl || !$mapToggleBtn) return;
  if (collapsed && $workspaceEl.classList.contains('map-expanded')) {
    applyMapExpanded(false);
  }
  $workspaceEl.classList.toggle('map-collapsed', collapsed);
  $mapToggleBtn.setAttribute('aria-pressed', String(collapsed));
  if ($mapToggleLabel) $mapToggleLabel.textContent = collapsed ? 'Show map' : 'Hide map';
  if (!collapsed) {
    mapReady.then(() => map.resize());
  }
  try { localStorage.setItem(MAP_HIDE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
}
function applyMapExpanded(expanded) {
  if (!$workspaceEl || !$mapExpandBtn) return;
  if (expanded && $workspaceEl.classList.contains('map-collapsed')) {
    applyMapCollapsed(false);
  }
  $workspaceEl.classList.toggle('map-expanded', expanded);
  $mapExpandBtn.setAttribute('aria-pressed', String(expanded));
  if ($mapExpandLabel) $mapExpandLabel.textContent = expanded ? 'Restore map' : 'Expand map';
  mapReady.then(() => map.resize());
  try { localStorage.setItem(MAP_EXPAND_KEY, expanded ? '1' : '0'); } catch { /* ignore */ }
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
if ($mapExpandBtn) {
  $mapExpandBtn.addEventListener('click', () => {
    const next = !$workspaceEl?.classList.contains('map-expanded');
    applyMapExpanded(next);
  });
  try {
    if (localStorage.getItem(MAP_EXPAND_KEY) === '1') applyMapExpanded(true);
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
// Read schema fields from the current UI into a plain state
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
    surveyToggle: false, assessToggle: true, allParcelsToggle: false, dwellingUnitsToggle: false,
    zoningToggle: false, trafficToggle: false,
    secondaryPlansToggle: false, infillToggle: false, mallsCorridorsToggle: false,
    transitToggle: false, contamToggle: false, dimensionsToggle: false,
    streetsToggle: false,
  };
  const buttons = {
    surveyToggle: $surveyToggle, assessToggle: $assessToggle,
    allParcelsToggle: $allParcelsToggle, dwellingUnitsToggle: $dwellingUnitsToggle, zoningToggle: $zoningToggle,
    trafficToggle: $trafficToggle,
    secondaryPlansToggle: $secondaryPlansToggle,
    infillToggle: $infillToggle, mallsCorridorsToggle: $mallsCorridorsToggle,
    transitToggle: $transitToggle,
    contamToggle: $contamToggle, dimensionsToggle: $dimensionsToggle,
    streetsToggle: $streetsToggle,
  };
  for (const [key, btn] of Object.entries(buttons)) {
    if (!btn) continue;
    const on = btn.getAttribute('aria-pressed') === 'true';
    if (on !== defaults[key]) s[key] = on;
  }

  const neighbourhoodMode = $neighbourhoodsToggle?.dataset?.mode || neighbourhoodsMode;
  if (neighbourhoodMode === 'clusters' || neighbourhoodMode === 'individual') {
    s.neighbourhoodsMode = neighbourhoodMode;
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
    allParcelsToggle: $allParcelsToggle, dwellingUnitsToggle: $dwellingUnitsToggle, zoningToggle: $zoningToggle,
    trafficToggle: $trafficToggle,
    secondaryPlansToggle: $secondaryPlansToggle,
    infillToggle: $infillToggle, mallsCorridorsToggle: $mallsCorridorsToggle,
    transitToggle: $transitToggle,
    contamToggle: $contamToggle, dimensionsToggle: $dimensionsToggle,
    streetsToggle: $streetsToggle,
  };
  for (const [key, btn] of Object.entries(toggles)) {
    if (!btn || !(key in state)) continue;
    const cur = btn.getAttribute('aria-pressed') === 'true';
    if (cur !== state[key]) btn.click();
  }

  if (state.neighbourhoodsMode === 'clusters' || state.neighbourhoodsMode === 'individual') {
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
function writeUrlStateNow() {
  try {
    const qs = encodeState(captureUrlState());
    const url = qs ? `${location.pathname}?${qs}` : location.pathname;
    history.replaceState(null, '', url);
  } catch (err) {
    console.warn('URL state write failed (non-fatal):', err);
  }
}

function queueUrlWrite() {
  if (urlWritePending) return;
  urlWritePending = true;
  requestAnimationFrame(() => {
    urlWritePending = false;
    writeUrlStateNow();
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
  $surveyToggle, $assessToggle, $allParcelsToggle, $dwellingUnitsToggle,
  $zoningToggle, $trafficToggle,
  $secondaryPlansToggle, $infillToggle, $mallsCorridorsToggle,
  $transitToggle,
  $neighbourhoodsToggle,
  $streetsToggle,
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
    // Re-render from the UNFILTERED set: renderTable re-applies any
    // drawn-shape filter itself, and handing it currentRows (already
    // narrowed) would bake the narrowing in permanently.
    if (fullRows.length > 0) renderTable(fullRows);
    queueUrlWrite();
  });
}

// The initial decode + apply happens earlier (before initChipInput)
// so the chip module sees the URL-state $roll.value at init time.
// Search-input listeners attached above will start writing back to
// the URL on the user's next edit.

async function runSearch() {
  // A stale include shape from a previous area would filter the new
  // results down to nothing, so every fresh Search erases the drawn
  // shapes. Silent: this run repopulates the table itself, and an emit
  // here would re-filter the outgoing result set on the way out.
  resetShapesSilently();
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
function setParcels(surveyFc, assessFc = EMPTY_FC, { fit = true } = {}) {
  // Remember what was handed in BEFORE the area filter narrows it, so
  // erasing a shape can restore the full set without a re-search.
  lastFullSurveyFc = surveyFc;
  lastFullAssessFc = assessFc;
  const shapes = getMapShapes();
  if (shapes.length > 0) {
    surveyFc = filterFcByShapes(surveyFc, shapes);
    assessFc = filterFcByShapes(assessFc, shapes);
  }
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
    showResults(map, surveyFc, mapAssessFc, { fit });
    refreshZoning();
    refreshDimensions();
  });
}

// ---------- Drawn-shape area filter ----------
//
// Radius / rectangle / polygon shapes drawn on the map (drawShapes.js)
// narrow the rendered result set: table, map highlight, count line and
// CSV export together. Shapes never re-query — they filter what the
// search already returned — so erasing one restores the full set with
// no network round-trip.
//
// Membership is tested on the parcel CENTROID (see lib/shapeFilter.js);
// a row with no placeable centroid fails once any shape exists rather
// than leaking into an area-narrowed comp set.

function filterFcByShapes(fc, shapes) {
  return {
    ...fc,
    features: (fc?.features || []).filter(
      (f) => passesShapeFilter(shapeFeatureCentroid(f), shapes)
    ),
  };
}

/** " · 12 of 340 shown (area filter)" — appended by setCount /
 *  setSalesCount so a filter the user can forget they drew, on a map
 *  they may have panned away from, can never silently empty the grid. */
function shapeFilterSuffix() {
  if (getMapShapes().length === 0) return '';
  return ` · ${shapeShown} of ${shapeTotal} parcels shown (area filter)`;
}

/**
 * Re-run the area filter after a shape is committed, flipped
 * include↔exclude, or erased. Re-renders from the remembered full sets,
 * so no search re-runs.
 *
 * Deliberately does NOT re-fit the map (a divergence from the Manitoba
 * app): the shape was just drawn in the current viewport, so the
 * narrowed set is by definition already on screen, and moving the map
 * out from under someone mid-draw — especially while they are about to
 * cut an exclude hole — is worse than leaving it put. That also gives
 * the zero-result case the right behaviour for free: the viewport keeps
 * its geographic anchor while the count line reads "0 of N".
 */
function refilterByShapes() {
  renderTable(fullRows);
  setParcels(lastFullSurveyFc, lastFullAssessFc, { fit: false });
  refreshCount();
}

onShapesChanged(refilterByShapes);

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
  const labelOn = which === 'survey' ? 'Hide Survey Parcel Results' : 'Hide Assessment Results';
  const labelOff = which === 'survey' ? 'Survey Parcel Results' : 'Assessment Results';
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
 * 3-state cycler for the Zoning button: off -> shading (coloured fill) ->
 * labels (zone codes + outlines, no fill) -> off. The citywide zoning data is
 * fetched once on the first activation (off -> shading) and reused for the
 * label state and re-toggles; the colour legend only shows in shading mode.
 */
const ZONING_LABELS = { off: 'Zoning', shading: 'Zoning: Shaded', labels: 'Zoning: Labels' };
async function toggleZoning() {
  const next = zoningMode === 'off' ? 'shading' : zoningMode === 'shading' ? 'labels' : 'off';
  const wasOff = zoningMode === 'off';
  zoningMode = next;
  const on = next !== 'off';
  $zoningToggle.setAttribute('aria-pressed', String(on));
  $zoningToggle.classList.toggle('active', on);
  $zoningToggle.dataset.mode = next;
  await mapReady;
  setZoningMode(map, next);
  // The colour legend is only meaningful when the fill is shown.
  if ($zoningLegend) $zoningLegend.hidden = next !== 'shading';
  if (!on) { $zoningToggle.textContent = ZONING_LABELS.off; return; }
  // shading -> labels reuses the already-loaded data; no fetch.
  if (!wasOff) { $zoningToggle.textContent = ZONING_LABELS[next]; return; }
  // First activation (off -> shading): fetch the citywide zoning. Cold
  // IndexedDB cache is ~10-15s; subsequent toggles read from disk in ms.
  $zoningToggle.disabled = true;
  $zoningToggle.textContent = 'Loading zoning…';
  try {
    await refreshZoning();
    // Phase 7 deferred zoning enrichment: a CSV upload doesn't run
    // enrichAssessmentZoning eagerly (would block 10+s on a cold multi-parcel
    // load). When the user turns Zoning on, enrich the current sales FC +
    // re-render so the % / Zoning 2 columns fill in.
    if (document.body.classList.contains('sales-mode')
        && lastFullAssessFc?.features?.length
        && salesData) {
      try {
        // Enrich the UNFILTERED sales FC. Reading lastParcelFc here
        // would pick up an active area filter's narrowed set, and
        // erasing the shape afterwards would come back short.
        const enriched = await enrichAssessmentZoning(lastFullAssessFc);
        if (enriched?.features) {
          const rows = enriched.features.map((f) => ({ assess: f, survey: null }));
          renderTable(rows);
          setParcels(EMPTY_FC, enriched, { fit: false });
          refreshCount();
        }
      } catch (zErr) {
        console.warn('Sales zoning enrichment failed (non-fatal):', zErr);
      }
    }
    $zoningToggle.textContent = ZONING_LABELS[zoningMode];
  } catch (err) {
    console.warn('zoning toggle failed', err);
    // Roll the toggle back to off so the user can retry.
    zoningMode = 'off';
    $zoningToggle.classList.remove('active');
    $zoningToggle.setAttribute('aria-pressed', 'false');
    $zoningToggle.dataset.mode = 'off';
    $zoningToggle.textContent = ZONING_LABELS.off;
    setZoningMode(map, 'off');
    if ($zoningLegend) $zoningLegend.hidden = true;
  } finally {
    $zoningToggle.disabled = false;
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
      $contamToggle.textContent = 'Hide Environmentally Tracked Sites';
      return;
    }
    $contamToggle.disabled = true;
    $contamToggle.textContent = 'Loading...';
    try {
      const fc = await fetchContaminatedSites();
      setContamData(map, fc);
      contamLoaded = true;
      $contamToggle.textContent = 'Hide Environmentally Tracked Sites';
    } catch (err) {
      console.warn('contaminated-sites overlay failed', err);
      contamEnabled = false;
      $contamToggle.classList.remove('active');
      $contamToggle.setAttribute('aria-pressed', 'false');
      $contamToggle.textContent = 'Environmentally Tracked Sites';
      setContamVisible(map, false);
    } finally {
      $contamToggle.disabled = false;
    }
  } else {
    $contamToggle.textContent = 'Environmentally Tracked Sites';
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
 * Combined Transit toggle. Two static GeoJSON sources (routes + stops)
 * are shipped under web/public and loaded together on first use; after
 * that this is just a visibility flip.
 */
async function toggleTransit() {
  if (!$transitToggle) return;
  transitEnabled = !transitEnabled;
  $transitToggle.setAttribute('aria-pressed', String(transitEnabled));
  $transitToggle.classList.toggle('active', transitEnabled);
  await mapReady;
  setOverlayVisible(map, 'transit-routes', transitEnabled);
  setOverlayVisible(map, 'transit-stops', transitEnabled);

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
      setOverlayData(map, 'transit-stops', stopsFc);
      transitLoaded = true;
      $transitToggle.textContent = 'Hide Transit';
    } catch (err) {
      console.warn('transit overlay failed', err);
      transitEnabled = false;
      $transitToggle.classList.remove('active');
      $transitToggle.setAttribute('aria-pressed', 'false');
      $transitToggle.textContent = 'Transit';
      setOverlayVisible(map, 'transit-routes', false);
      setOverlayVisible(map, 'transit-stops', false);
    } finally {
      $transitToggle.disabled = false;
    }
  } else {
    $transitToggle.textContent = 'Transit';
  }
}

// Winnipeg Streets overlay — current City road-network centrelines + names.
// Entering a City aerial automatically enables it and leaving restores the
// user's prior state. The button remains a manual override, including a clean
// imagery view. Switching between aerial years does not reset that override.
async function setStreetsEnabled(enabled) {
  if (!$streetsToggle) return;
  streetsEnabled = enabled;
  $streetsToggle.setAttribute('aria-pressed', String(streetsEnabled));
  $streetsToggle.classList.toggle('active', streetsEnabled);
  $streetsToggle.textContent = streetsEnabled ? 'Hide Current Streets' : 'Current Winnipeg Streets';
  await mapReady;
  setOverlayVisible(map, 'streets', streetsEnabled);

  if (streetsEnabled) {
    if (streetsLoaded) return;
    $streetsToggle.disabled = true;
    $streetsToggle.textContent = 'Loading...';
    try {
      const fc = await fetchWinnipegStreets();
      setOverlayData(map, 'streets', fc);
      streetsLoaded = true;
      // A basemap switch or manual click may have changed the desired state
      // while the network request was running.
      setOverlayVisible(map, 'streets', streetsEnabled);
    } catch (err) {
      console.warn('streets overlay failed', err);
      streetsEnabled = false;
      streetsAutoManaged = false;
      $streetsToggle.classList.remove('active');
      $streetsToggle.setAttribute('aria-pressed', 'false');
      setOverlayVisible(map, 'streets', false);
    } finally {
      $streetsToggle.disabled = false;
      $streetsToggle.textContent = streetsEnabled ? 'Hide Current Streets' : 'Current Winnipeg Streets';
    }
  }
}

async function toggleStreets() {
  streetsAutoManaged = false;
  await setStreetsEnabled(!streetsEnabled);
}

async function onBasemapChange({ state, previousState }) {
  if (state === 'aerial' && previousState !== 'aerial') {
    streetsBeforeAerial = streetsEnabled;
    streetsAutoManaged = true;
    await setStreetsEnabled(true);
  } else if (state !== 'aerial' && previousState === 'aerial' && streetsAutoManaged) {
    const restore = streetsBeforeAerial;
    streetsAutoManaged = false;
    await setStreetsEnabled(restore);
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
  $neighbourhoodsToggle.dataset.mode = neighbourhoodsMode;
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

async function cycleNeighbourhoods() {
  if (!$neighbourhoodsToggle) return;
  const next = neighbourhoodsMode === 'off'
    ? 'clusters'
    : neighbourhoodsMode === 'clusters'
      ? 'individual'
      : 'off';
  await setNeighbourhoodsMode(next);
  writeUrlStateNow();
}

async function setNeighbourhoodsMode(mode) {
  if (!$neighbourhoodsToggle) return;
  if (mode !== 'off' && mode !== 'clusters' && mode !== 'individual') mode = 'off';
  neighbourhoodsMode = mode;
  renderNeighbourhoodButton();
  await mapReady;

  setNeighbourhoodLayerVisibility(NEIGHBOURHOOD_CLUSTER_LAYERS, mode === 'clusters');
  setNeighbourhoodLayerVisibility(NEIGHBOURHOOD_INDIVIDUAL_LAYERS, mode === 'individual');

  if (mode === 'off') return;

  const fetchKey = mode === 'clusters' ? 'clusters' : 'individual';
  if (neighbourhoodsLoaded[fetchKey]) return;
  $neighbourhoodsToggle.disabled = true;
  const restoreLabel = $neighbourhoodsToggle.textContent;
  $neighbourhoodsToggle.textContent = 'Loading...';
  try {
    if (mode === 'clusters') {
      const fc = await fetchNeighbourhoodClusters();
      setOverlayData(map, 'wpg-neighbourhood-clusters', fc);
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
    neighbourhoodsMode = 'off';
    renderNeighbourhoodButton();
    setNeighbourhoodLayerVisibility(NEIGHBOURHOOD_CLUSTER_LAYERS, false);
    setNeighbourhoodLayerVisibility(NEIGHBOURHOOD_INDIVIDUAL_LAYERS, false);
  } finally {
    $neighbourhoodsToggle.disabled = false;
  }
}

/**
 * Fetch the citywide zoning layer (cached for 7 days in IndexedDB) and
 * push it into the map source. No-op when the toggle is off. Failures
 * are logged and re-thrown so toggleZoning can roll back the button
 * state.
 */
async function refreshZoning() {
  if (zoningMode === 'off') return;
  const zoningFc = await fetchCityZoning();
  setZoningData(map, zoningFc);
}

/**
 * Generic toggle for the OurWinnipeg policy-area overlays. Each is a
 * small whole-citywide dataset fetched once and cached for the
 * session — see fetchAllAndCache in soda.js — so toggling on/off after
 * the first hit is instant.
 *
 * `name` is one of 'secondaryPlans' / 'infill' / 'mallsCorridors'.
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
};

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

/** Toggle derived dwelling-unit totals from the citywide PMTiles archive. */
async function toggleDwellingUnits() {
  await mapReady;
  const available = await probeCitywideParcels();
  if (!available) {
    setCount(
      'Dwelling Units: tiles not built. Run r/build_parcel_tiles.R + tippecanoe to rebuild web/public/parcels.pmtiles.'
    );
    return;
  }
  dwellingUnitsEnabled = !dwellingUnitsEnabled;
  $dwellingUnitsToggle.textContent = dwellingUnitsEnabled ? 'Hide Dwelling Units' : 'Dwelling Units';
  $dwellingUnitsToggle.setAttribute('aria-pressed', String(dwellingUnitsEnabled));
  $dwellingUnitsToggle.classList.toggle('active', dwellingUnitsEnabled);
  setDwellingUnitsVisible(map, dwellingUnitsEnabled);
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

// ---------- Historical (as-of-date) overlay ----------

let historicalActive = false;
let historicalIndexCache = null;
let historicalSnap = null;          // snapshot date currently driving the overlay
let historicalCluster = '';         // selected neighbourhood-cluster name; '' = follow the map view
let historicalNbhdRef = null;       // [{ slug, cluster, bbox:[w,s,e,n] }] from wpg-neighbourhoods.geojson
let historicalMoveTimer = null;     // debounce handle for pan/zoom reloads
let historicalZoningSnap = null;    // snapshot whose whole-city zoning is currently on the map (avoids re-pushing 18k polygons on a view-mode pan)
// Monotonic load id: each load captures its own; a later load (a date change or
// a pan/zoom mid-load) increments it, so a slower earlier response detects it's
// been superseded and skips rendering — prevents an out-of-order overwrite where
// the map shows the previous view's parcels while a newer view is in flight.
let historicalLoadId = 0;

// Follow-the-map guards. Below MIN_ZOOM (the zoom where the neighbourhood layer
// itself appears) we ask the user to zoom in; the per-view neighbourhood cap
// bounds the shard fetch. Tuned from real in-view counts: at zoom 15 a viewport
// spans ~5–24 neighbourhoods and at 14 ~15–55, so a cap of 25 makes the overlay
// load reliably from zoom 15 (and from 14 in lower-density areas) — ~25 shards
// is the same data magnitude as one large cluster pick. Raise the cap to kick in
// at wider zooms (more data per pan); lower it to keep pans light.
const HISTORICAL_MIN_ZOOM = 12;
const HISTORICAL_MAX_HOODS = 25;

// Sentinel Area value for the UNASSIGNED shard — parcels/lots that fell outside
// every neighbourhood polygon (audit H-2). They're scattered city-edge and have
// no neighbourhood bbox, so map-view and cluster picks can't surface them; this
// explicit Area pick loads the shard directly and frames to its own extent.
const HISTORICAL_UNASSIGNED = '__UNASSIGNED__';
const historicalAreaLabel = (cluster) =>
  cluster === HISTORICAL_UNASSIGNED ? 'Unassigned (city-edge)' : cluster;

// Neighbourhood slug — must match the R builder's slugify(name) EXACTLY so it
// maps to the shard filename <SLUG>.json (build_historical_shards.R slugify()).
function historicalSlugify(x) {
  return String(x).toUpperCase().trim()
    .replace(/[/ ]+/g, '-')
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Load + cache the official neighbourhood polygons as [{ slug, cluster, bbox }]
// (reusing the app's session-cached neighbourhoods FC), so a pan/zoom can find
// which neighbourhoods are in view by bbox overlap (a safe superset — the shard
// cap bounds any over-fetch), and an Area pick can gather a whole cluster.
async function historicalNeighbourhoodRef() {
  if (historicalNbhdRef) return historicalNbhdRef;
  const fc = await fetchNeighbourhoods();
  const ref = [];
  for (const f of fc.features || []) {
    const slug = historicalSlugify(f.properties?.name ?? f.properties?.Name ?? f.properties?.NAME);
    if (!slug) continue;
    const cluster = f.properties?.cluster ?? f.properties?.Cluster ?? '';
    try { ref.push({ slug, cluster, bbox: bbox(f) }); } catch { /* skip bad geometry */ }
  }
  historicalNbhdRef = ref;
  return ref;
}

// Axis-aligned bbox overlap; bbox order is turf's [minLon, minLat, maxLon, maxLat].
function historicalBboxesOverlap(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// Slugs of neighbourhoods that (a) intersect the current map view and (b) carry
// data for `snap`. Returns every match (uncapped) so the caller can decide
// whether to load or to ask the user to zoom in further.
async function historicalSlugsInView(snap) {
  const ref = await historicalNeighbourhoodRef();
  const b = map.getBounds();
  const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const man = await fetchHistoricalManifest(snap).catch(() => null);
  const hoods = man?.neighbourhoods || {};
  const slugs = [];
  for (const r of ref) {
    if (!historicalBboxesOverlap(view, r.bbox)) continue;
    const info = hoods[r.slug];
    if (!info) continue;                                  // no shard for this snapshot
    if (!(info.parcels > 0) && !(info.survey > 0)) continue;
    slugs.push(r.slug);
  }
  return slugs;
}

// Slugs of every neighbourhood in `clusterName` that carries data for `snap`,
// plus the union bbox of those neighbourhoods so the map can frame the cluster.
async function historicalSlugsInCluster(snap, clusterName) {
  const man = await fetchHistoricalManifest(snap).catch(() => null);
  const hoods = man?.neighbourhoods || {};
  // Unassigned is the one "area" with no neighbourhood polygon: load its shard
  // directly when the snapshot carries it. bbox is null here — there are no
  // polygons to union — so loadHistorical frames to the loaded data instead.
  if (clusterName === HISTORICAL_UNASSIGNED) {
    const info = hoods.UNASSIGNED;
    const has = !!info && ((info.parcels > 0) || (info.survey > 0));
    return { slugs: has ? ['UNASSIGNED'] : [], bbox: null };
  }
  const ref = await historicalNeighbourhoodRef();
  const slugs = [];
  let bb = null;                                          // [w, s, e, n]
  for (const r of ref) {
    if (r.cluster !== clusterName) continue;
    const info = hoods[r.slug];
    if (!info || (!(info.parcels > 0) && !(info.survey > 0))) continue;
    slugs.push(r.slug);
    bb = bb
      ? [Math.min(bb[0], r.bbox[0]), Math.min(bb[1], r.bbox[1]), Math.max(bb[2], r.bbox[2]), Math.max(bb[3], r.bbox[3])]
      : r.bbox.slice();
  }
  return { slugs, bbox: bb };
}

// Merge several shard FeatureCollections into one. Rolls / survey_ids are unique
// per neighbourhood (binned by representative point), so no cross-shard dedup.
function historicalMergeFC(fcs) {
  const features = [];
  for (const fc of fcs) if (fc?.features?.length) features.push(...fc.features);
  return { type: 'FeatureCollection', features };
}
// Merge several by-key lineage maps (by_roll / by_survey_id) into one object.
function historicalMergeMaps(objs) {
  const out = {};
  for (const o of objs) if (o) Object.assign(out, o);
  return out;
}

// Populate the Area (neighbourhood-cluster) + date pickers. The Area dropdown
// defaults to "Map view", in which the overlay follows the map viewport; pick a
// cluster to load + frame that whole area instead.
async function initHistoricalControls() {
  if (!$historicalDate) return;
  const idx = await fetchHistoricalIndex().catch(() => null);
  historicalIndexCache = idx;
  const snaps = idx?.snapshots
    ? Object.keys(idx.snapshots).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort().reverse()
    : [];
  if (!snaps.length) { console.warn('[historical] no snapshots in index — overlay unavailable.'); return; }

  // Date picker, grouped by year, tagged with which layers each date carries.
  $historicalDate.innerHTML = '';
  let curYear = null, grp = null;
  for (const s of snaps) {
    const yr = s.slice(0, 4);
    if (yr !== curYear) { grp = document.createElement('optgroup'); grp.label = yr; $historicalDate.appendChild(grp); curYear = yr; }
    const layers = idx.snapshots[s]?.layers || {};
    const tags = [];
    if (layers.parcels) tags.push('assessment');
    if (layers.survey)  tags.push('survey');
    if (layers.zoning)  tags.push('zoning');
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = tags.length ? `${s} (${tags.join(' + ')})` : s;
    grp.appendChild(opt);
  }

  // Area picker: a default that means "follow the map view", plus the distinct
  // neighbourhood clusters. The default is set first so it's always present even
  // if the cluster list fails to load. Built via the DOM (no escaping needed).
  if ($historicalArea) {
    $historicalArea.innerHTML = '';
    const def = document.createElement('option');
    def.value = ''; def.textContent = 'Map view (follow zoom)';
    $historicalArea.appendChild(def);
    try {
      const ref = await historicalNeighbourhoodRef();
      const clusters = [...new Set(ref.map((r) => r.cluster).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
      for (const c of clusters) {
        const o = document.createElement('option');
        o.value = c; o.textContent = c;
        $historicalArea.appendChild(o);
      }
    } catch (e) { console.warn('[historical] cluster list unavailable — Area picker shows Map view only.', e); }
    // Unassigned (city-edge) — parcels/lots outside every neighbourhood polygon,
    // otherwise unreachable from map-view or cluster picks (audit H-2). Added
    // unconditionally; a snapshot with no UNASSIGNED shard just reports no data.
    const un = document.createElement('option');
    un.value = HISTORICAL_UNASSIGNED;
    un.textContent = 'Unassigned (city-edge parcels)';
    $historicalArea.appendChild(un);
  }

  if ($historicalToggle) $historicalToggle.disabled = false;
}

// Re-load when the user picks a different snapshot date while active (keeps the
// current Area / viewport mode). Zoning rides along inside loadHistorical.
function onHistoricalDateChange() {
  if (historicalActive && $historicalDate?.value) {
    historicalSnap = $historicalDate.value;
    loadHistorical(historicalSnap);
  }
}

// Switch between "follow the map view" and a fixed cluster. Picking a cluster
// loads + frames it; choosing "Map view" returns to viewport-driven loading.
function onHistoricalAreaChange() {
  historicalCluster = $historicalArea?.value || '';
  if (historicalActive && historicalSnap) loadHistorical(historicalSnap, { frame: !!historicalCluster });
}

// Debounced pan/zoom reload — only in viewport mode (a fixed Area is pinned, so
// moving the map within it must not refetch).
function onHistoricalMapMove() {
  if (!historicalActive || !historicalSnap || historicalCluster) return;
  if (historicalMoveTimer) clearTimeout(historicalMoveTimer);
  historicalMoveTimer = setTimeout(() => {
    historicalMoveTimer = null;
    if (historicalActive && historicalSnap && !historicalCluster) loadHistorical(historicalSnap);
  }, 400);
}


async function toggleHistorical() {
  if (!$historicalToggle) return;
  await mapReady;
  if (historicalActive) { deactivateHistorical(); return; }
  const snap = $historicalDate?.value;
  if (!snap) { setCount('Historical: no snapshots available.'); return; }
  // Turn the mode on first so the pan/zoom handler is live even if the user is
  // currently zoomed out (the load will just prompt them to zoom in).
  historicalActive = true;
  historicalSnap = snap;
  historicalCluster = $historicalArea?.value || '';
  $historicalToggle.classList.add('active');
  $historicalToggle.setAttribute('aria-pressed', 'true');
  await loadHistorical(snap, { frame: !!historicalCluster });
}

function deactivateHistorical() {
  historicalActive = false;
  historicalSnap = null;
  if (historicalMoveTimer) { clearTimeout(historicalMoveTimer); historicalMoveTimer = null; }
  historicalZoningSnap = null;   // re-fetch/re-set zoning on the next activation
  mapReady.then(() => { setHistoricalVisible(map, false); setHistoricalZoningVisible(map, false); });
  if ($historicalToggle) {
    $historicalToggle.classList.remove('active');
    $historicalToggle.setAttribute('aria-pressed', 'false');
    $historicalToggle.textContent = 'Historical';
  }
  if ($historicalBanner) $historicalBanner.hidden = true;
}

// Hide the overlay + banner without leaving the mode (used when the view has no
// data or is zoomed too far out; a subsequent pan/zoom can reload).
function clearHistoricalView() {
  setHistoricalData(map, { parcels: null, survey: null, lineage: null, surveyLineage: null });
  setHistoricalVisible(map, false);
  // Hide zoning too, but keep its data + historicalZoningSnap so panning back
  // into a data-bearing view re-shows it without a refetch.
  setHistoricalZoningVisible(map, false);
  if ($historicalBanner) $historicalBanner.hidden = true;
}

// Match each historical parcel to today's parcel of the same roll by assessed
// land area (roll-vs-roll — immune to display-geometry simplification) and stamp
// _sizeBand / _histArea / _curArea / _deltaPct. Harvests roll → today's
// detail_url for the popup links. Loud on a key mismatch (Lesson F).
async function stampHistoricalSizeChanges(parcels, label) {
  try {
    const histByRoll = new Map();
    for (const f of parcels.features || []) {
      const roll = f.properties?.roll_number;
      const a = Number(f.properties?.assessed_land_area);
      // Coerce roll to string: shards may serialize it as a number while SODA
      // returns a string — Map keys must match exactly (the app coerces too).
      if (roll != null && roll !== '' && a > 0) histByRoll.set(String(roll), a);
    }
    // Current assessment parcels in the shard's bbox — lean fields, one paged
    // within_box query (no per-feature overlap). Gives roll → today's area +
    // detail_url for the size-change classification + popup links.
    // `curComplete` is the partial-fetch guard: when the page loop was cut
    // short, a roll missing from curRows is NOT evidence it was removed.
    let curRows = [];
    let curComplete = false;
    try {
      ({ rows: curRows, complete: curComplete } = await fetchCurrentAssessmentInBbox(bbox(parcels)));
    } catch (e) { console.warn(`[historical] size-change: current fetch threw for "${label}" — highlight disabled.`, e); }
    const curByRoll = new Map();
    for (const r of curRows) {
      const roll = r.roll_number;
      if (roll == null || roll === '') continue;
      const a = Number(r.assessed_land_area);
      if (a > 0) curByRoll.set(String(roll), a);
    }
    if (curByRoll.size === 0) {
      console.warn(`[historical] size-change: no current parcels in bbox for "${label}" (fetched ${curRows.length} rows) — highlight disabled.`);
      return { summary: null };
    }
    const { byRoll, summary } = computeSizeChanges(histByRoll, curByRoll);
    const matched = histByRoll.size - summary.gone;
    if (histByRoll.size > 0 && matched === 0) {
      const sample = (m) => Array.from(m.keys()).slice(0, 3).join(', ') || '(none)';
      console.warn(`[historical] size-change: ${histByRoll.size} hist / ${curByRoll.size} current parcels but ZERO roll overlap for "${label}" — likely a roll_number format mismatch. hist: [${sample(histByRoll)}] cur: [${sample(curByRoll)}]`);
    } else {
      console.info(`[historical] size-change "${label}": ${matched} matched, ${summary.gone} gone, ${summary.appeared} new · ${summary.major} major, ${summary.minor} minor.`);
    }
    // Partial current fetch → "gone" is unprovable (the roll may simply be in
    // a page we never got). Strip the gone band so report-facing popups never
    // claim "roll not present in current data" off a half-finished fetch;
    // major/minor bands for rolls that WERE fetched remain valid.
    if (!curComplete && summary.gone > 0) {
      for (const [roll, rec] of byRoll) {
        if (rec.band === 'gone') byRoll.delete(roll);
      }
      console.warn(`[historical] size-change: current fetch incomplete for "${label}" — gone detection disabled (${summary.gone} unmatched roll${summary.gone === 1 ? '' : 's'} left unmarked).`);
      summary.gone = 0;
    }
    for (const f of parcels.features || []) {
      if (!f.properties) continue;
      const rec = byRoll.get(String(f.properties.roll_number));
      if (!rec) continue;
      f.properties._sizeBand = rec.band;
      if (rec.histArea != null) f.properties._histArea = rec.histArea;
      if (rec.curArea  != null) f.properties._curArea  = rec.curArea;
      if (rec.deltaPct != null) f.properties._deltaPct = rec.deltaPct;
    }
    return { summary };
  } catch (err) {
    console.warn('historical size-change stamp failed', err);
    return null;
  }
}

// Load + merge the historical shards for snapshot `snap`. Two modes: a fixed
// neighbourhood cluster (Area picked → load + frame the whole cluster), or the
// current map view (zoom guard + per-view cap keep it from loading the whole
// city). Called on toggle-on, date change, Area change, and (in view mode only,
// debounced) on every pan/zoom.
async function loadHistorical(snap, { frame = false } = {}) {
  if (!$historicalToggle || !snap) return;
  const cluster = historicalCluster;
  const myId = ++historicalLoadId;
  $historicalToggle.disabled = true;
  $historicalToggle.textContent = 'Loading…';
  try {
    await mapReady;
    let slugs;
    if (cluster) {
      const inCluster = await historicalSlugsInCluster(snap, cluster);
      if (myId !== historicalLoadId) return;           // superseded while resolving the cluster
      slugs = inCluster.slugs;
      if (slugs.length === 0) {
        clearHistoricalView();
        setCount(`Historical: no ${snap} data for ${historicalAreaLabel(cluster)}.`);
        return;
      }
      // Frame the cluster (only on an explicit Area pick, not date-change reloads).
      // moveend is suppressed in cluster mode, so this won't trigger a refetch.
      // Unassigned has no polygon bbox — it's framed post-load, below.
      if (frame && inCluster.bbox) {
        try { map.fitBounds([[inCluster.bbox[0], inCluster.bbox[1]], [inCluster.bbox[2], inCluster.bbox[3]]],
          { padding: 40, maxZoom: 16, duration: 600 }); } catch { /* ignore */ }
      }
      // A whole cluster can be many neighbourhoods + a big current-assessment
      // query; tell the user it's working (first load is uncached).
      const areaLabel = historicalAreaLabel(cluster);
      setCount(cluster === HISTORICAL_UNASSIGNED
        ? `Historical: loading ${areaLabel} parcels…`
        : `Historical: loading ${areaLabel} — ${slugs.length} neighbourhood${slugs.length === 1 ? '' : 's'}…`);
    } else {
      if (map.getZoom() < HISTORICAL_MIN_ZOOM) {
        if (myId !== historicalLoadId) return;
        clearHistoricalView();
        setCount('Historical: zoom in to load as-of-date parcels for the area in view, or pick an Area.');
        return;
      }
      slugs = await historicalSlugsInView(snap);
      if (myId !== historicalLoadId) return;           // superseded while resolving the view
      if (slugs.length === 0) {
        clearHistoricalView();
        setCount(`Historical: no ${snap} data for the area in view.`);
        return;
      }
      if (slugs.length > HISTORICAL_MAX_HOODS) {
        clearHistoricalView();
        setCount(`Historical: zoom in further — ${slugs.length} neighbourhoods in view (max ${HISTORICAL_MAX_HOODS}), or pick an Area.`);
        return;
      }
    }
    // Whole-city as-of zoning (auto-on with the overlay) — kicked off in parallel
    // with the shard fetches. Only (re)fetched when the snapshot changed; a
    // view-mode pan reload keeps whatever's already on the map (it's city-wide,
    // so it doesn't depend on which neighbourhoods are in view).
    // Only snapshots whose index entry declares a zoning layer have a zoning.json
    // (older captures predate the zoning layer) — skip the fetch (and the 404) for
    // the rest, and clear any stale zoning when switching to one of them.
    const snapHasZoning = !!historicalIndexCache?.snapshots?.[snap]?.layers?.zoning;
    const zoningPromise = (snapHasZoning && historicalZoningSnap !== snap)
      ? fetchHistoricalZoning(snap).catch(() => null)
      : null;
    // Fetch every neighbourhood's parcel + survey shard + both lineage maps in
    // parallel, then merge into one overlay.
    const per = await Promise.all(slugs.map(async (slug) => {
      const [parcels, survey, lineage, surveyLineage] = await Promise.all([
        fetchHistoricalShard(snap, 'parcels', slug),
        fetchHistoricalShard(snap, 'survey', slug),
        fetchHistoricalLineage('lineage', slug),
        fetchHistoricalLineage('survey-lineage', slug),
      ]);
      return { parcels, survey, lineage, surveyLineage };
    }));
    if (myId !== historicalLoadId) return;             // a newer load superseded this one
    const parcels = historicalMergeFC(per.map((p) => p.parcels));
    const survey  = historicalMergeFC(per.map((p) => p.survey));
    const lineage       = historicalMergeMaps(per.map((p) => p.lineage?.by_roll));
    const surveyLineage = historicalMergeMaps(per.map((p) => p.surveyLineage?.by_survey_id));
    if (!parcels.features.length && !survey.features.length) {
      clearHistoricalView();
      setCount(`Historical: no ${snap} data for ${historicalAreaLabel(cluster) || 'the area in view'}.`);
      return;
    }
    // Unassigned parcels are scattered city-wide, so there's no neighbourhood
    // bbox to frame — fit to the loaded shard's own extent instead (H-2).
    if (cluster === HISTORICAL_UNASSIGNED && frame) {
      const feats = [...parcels.features, ...survey.features];
      if (feats.length) {
        try {
          const bb = bbox({ type: 'FeatureCollection', features: feats });
          map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 40, maxZoom: 15, duration: 600 });
        } catch { /* ignore */ }
      }
    }
    // Enrich the assessment layer with size-change bands BEFORE setHistoricalData,
    // so the colour expression + popups see them on first render. Skipped for
    // Unassigned: its city-wide bbox would drag ~150k current parcels through
    // fetchCurrentAssessmentInBbox (mostly incomplete → gone-detection disabled
    // anyway), so those edge parcels render plain rather than pay that cost.
    const enrich = (parcels.features.length && cluster !== HISTORICAL_UNASSIGNED)
      ? await stampHistoricalSizeChanges(parcels, `${cluster || 'view'}@${snap}`)
      : null;
    if (myId !== historicalLoadId) return;             // superseded during enrichment
    setHistoricalData(map, {
      parcels: parcels.features.length ? parcels : null,
      survey:  survey.features.length ? survey : null,
      snap,
      lineage: Object.keys(lineage).length ? lineage : null,
      surveyLineage: Object.keys(surveyLineage).length ? surveyLineage : null,
    });
    setHistoricalVisible(map, true);
    // As-of zoning under the dashed lots (auto-on with the overlay). Uses the
    // parallel fetch kicked off above; re-set only when the snapshot changed, and
    // cleared (null) when switching to a snapshot that predates the zoning layer.
    if (historicalZoningSnap !== snap) {
      const zoning = zoningPromise ? await zoningPromise : null;
      if (myId !== historicalLoadId) return;            // superseded during the zoning fetch
      setHistoricalZoningData(map, zoning, snap);
      historicalZoningSnap = snap;
    }
    setHistoricalZoningVisible(map, snapHasZoning);
    updateHistoricalBanner(snap);
    const np = parcels.features.length;
    const ns = survey.features.length;
    const sum = enrich?.summary;
    let changeNote = '';
    if (sum) {
      const parts = [];
      if (sum.major) parts.push(`${sum.major} major`);
      if (sum.minor) parts.push(`${sum.minor} minor`);
      if (sum.gone)  parts.push(`${sum.gone} gone`);
      if (parts.length) changeNote = ` Size changes: ${parts.join(', ')} (red >25%, orange >5%, grey = roll gone).`;
    }
    const bits = [];
    if (np) bits.push(`${np} assessment parcel${np === 1 ? '' : 's'}`);
    if (ns) bits.push(`${ns} survey lot${ns === 1 ? '' : 's'}`);
    const whereTxt = cluster ? historicalAreaLabel(cluster) : 'in view';
    const moreHint = cluster ? '' : ' Pan/zoom to load more.';
    setCount(`Historical as of ${snap} — ${bits.join(' + ')} (${whereTxt}), dashed over today's lots.${moreHint} Click one for its as-of details.${changeNote} Verify against by-law / title.`);
  } catch (err) {
    console.warn('historical load failed', err);
    if (myId === historicalLoadId) {
      setCount('Historical: load failed.');
      deactivateHistorical();
    }
  } finally {
    // Only the most-recent load owns the toggle button's state.
    if (myId === historicalLoadId) {
      $historicalToggle.disabled = false;
      $historicalToggle.textContent = historicalActive ? 'Hide Historical' : 'Historical';
    }
  }
}

function updateHistoricalBanner(snap) {
  if (!$historicalBanner) return;
  const layers = historicalIndexCache?.snapshots?.[snap]?.layers || {};
  const parts = [];
  if (layers.parcels) parts.push(`Assessment ${layers.parcels.source_date || snap}`);
  if (layers.survey)  parts.push(`Survey ${layers.survey.source_date || snap}`);
  const stale = historicalIsStale();
  $historicalBanner.classList.toggle('is-stale', stale);
  // snap + source dates are our own controlled YYYY-MM-DD strings (no user input).
  $historicalBanner.innerHTML =
    `HISTORICAL as of ${snap}${parts.length ? ' · ' + parts.join(' · ') : ''}`
    + ' · <span class="hb-verify">verify vs by-law / title</span>'
    + (stale ? '<span class="hb-stale-tag">archive &gt; 12 mo old</span>' : '');
  $historicalBanner.hidden = false;
}

function historicalIsStale() {
  const snaps = historicalIndexCache?.snapshots;
  const keys = snaps ? Object.keys(snaps).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)) : [];
  if (!keys.length) return false;
  const newest = keys.sort().reverse()[0];
  return (Date.now() - Date.parse(newest)) > 365 * 24 * 60 * 60 * 1000;
}

// ---------- UI helpers ----------

function setCount(text) {
  lastCountBase = text;
  renderCount();
}

function renderCount() {
  const text = lastCountBase ? lastCountBase + shapeFilterSuffix() : lastCountBase;
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

/** Re-render both count lines against the current shape state. */
function refreshCount() {
  renderCount();
  renderSalesCount();
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
  const tokens = String(roll).split(/[\s,;&]+/).map((s) => s.trim()).filter(Boolean);
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
  fullRows = [];
  shapeShown = 0;
  shapeTotal = 0;
  setExportEnabled(false);
  showEmptyState(true);
  if ($parcelSummary) $parcelSummary.hidden = true;
}

/**
 * Render `rows` into the results table. This is the single funnel for
 * the drawn-shape area filter: the argument is always the FULL set for
 * the current search, and any active shapes narrow it here. That way a
 * late enrichment re-render (address back-fill, partial-lot detection)
 * landing while shapes are drawn stays narrowed, and erasing a shape
 * restores the full set from `fullRows` with no re-search.
 */
function renderTable(rows) {
  fullRows = rows;
  const shapes = getMapShapes();
  const shown = shapes.length > 0
    ? rows.filter((r) => passesShapeFilter(shapeRowCentroid(r), shapes))
    : rows;
  shapeShown = shown.length;
  shapeTotal = rows.length;
  $tbody.innerHTML = '';
  currentRows = shown;
  rowFeatureMap.clear();
  showEmptyState(shown.length === 0);
  const sorted = sortRows(shown);
  // Stamp the dominant assessment year onto the column header so it
  // reads "Assess-2026" (or whatever year the source data carries).
  // Falls back to plain "Assessment" when the data lacks the field.
  const valueHeader = document.getElementById('value-header');
  if (valueHeader) {
    const years = shown
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
    // Cell construction is fully registry-driven: each column declares its
    // render(a, s) => Node in lib/columnsRegistry.js, and we append in the
    // registry's declared order — same order as buildThead emits the <th>s,
    // so a column can't drift between its header and its cells. Adding a
    // column is now ONE edit (in the registry); the columnsRegistry test
    // additionally fails CI if SORT_KEYS / PRESETS lose track.
    for (const col of COLUMNS) {
      tr.appendChild(col.render(a, s));
    }
    frag.appendChild(tr);
  }
  $tbody.appendChild(frag);
  setExportEnabled(shown.length > 0);
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
          pruneVerifyKeys(VERIFY_KEYS_MAX);
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
  // Schema + row extractors come from the columns registry — drives the
  // header order and adds the sales-mode columns to the export when sales
  // mode is active (closes the gap audit finding M5).
  const mode = document.body.classList.contains('sales-mode') ? 'sales' : 'property';
  const { headers, cells } = csvSchemaForMode(mode);
  const lines = [headers.map(csvCell).join(',')];
  for (const row of currentRows) {
    const s = row.survey?.properties || {};
    const a = row.assess?.properties || {};
    lines.push(cells.map((extract) => csvCell(extract(a, s) ?? '')).join(','));
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
  let s = String(value);
  // Defuse spreadsheet formula injection: a leading =, +, -, @, or control
  // char (tab/CR/LF) makes Excel/Sheets treat the cell as a formula. Values
  // here come from the public SODA API and from the user's uploaded sales
  // CSV, so neutralise any such cell by prefixing a single quote before
  // RFC-4180 quoting. See OWASP "CSV Injection".
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
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

// The Verify-this checklist writes one `wps_verify_v1:<roll>` key per parcel
// ever opened and never removed them. Public roll numbers only, so it's
// harmless, but bound the growth: keep at most VERIFY_KEYS_MAX, evicting the
// oldest (localStorage preserves insertion order) when the cap is exceeded.
const VERIFY_KEYS_MAX = 1000;
const VERIFY_KEY_PREFIX = 'wps_verify_v1:';

function pruneVerifyKeys(max) {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(VERIFY_KEY_PREFIX)) keys.push(k);
    }
    for (let i = 0; i < keys.length - max; i++) localStorage.removeItem(keys[i]);
  } catch { /* ignore */ }
}

// td / badgeTd / propertyTypeBadgeClass / truncatedTd / stripZoningCode
// moved to lib/cells.js — the registry's render functions are now their
// only callers. stripZoningCode is also imported above for the parcel
// summary card.

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

// linkTd / assessmentTd / formatDollars / formatPct / formatZone2 /
// formatCoord / formatDist all moved to lib/cells.js — the registry's
// render functions are now their only callers. Cell-value formatters
// still used by showParcelSummary (formatDollars, formatPct, formatCoord)
// are re-imported from cells.js at the top of this file.
// assessmentUrl, walkscoreUrl, floodToolUrl live in lib/links.js so
// lib/columnsRegistry.js can use them without dragging main.js's DOM
// imports into Node-side tests.

// formatSqFt is imported from lib/format.js — assessment land area uses
// the same en-CA formatter (`1,234`) as the Sales Analysis tab.

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

// The required-column list now lives in lib/salesImport.js alongside the
// header aliases that satisfy it, so the schema and the vocabulary that
// maps onto it can't drift apart. describeHeaderProblem() turns a
// failure into the message shown in the sidebar status.

// normalizeRoll + dedupAndGroupSales live in lib/sales.js (pure, tested
// in test/sales.test.js); imported at the top of this file.

function wireSalesTab() {
  const $dropzone = document.getElementById('sales-dropzone');
  const $fileInput = document.getElementById('sales-file-input');
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
    if (file) loadSalesFile(file);
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
    if (file) loadSalesFile(file);
  });

  // "Paste data…" — opens the single-step paste modal. Its Load button
  // hands { name, text } to the same pipeline the dropzone feeds, then
  // hops to the Sales tab so the user lands on the result.
  const salesImportModal = initSalesPasteImport({
    onSubmit: async ({ name, text }) => {
      await handleSalesUpload({ name, text });
      setActiveTab('sales', { skipFocus: true });
    },
  });
  document.getElementById('sales-import-trigger')
    ?.addEventListener('click', () => salesImportModal.open());

  // Recent uploads — picker + Forget-all. Picking an entry replays the
  // cached text; `remember: false` because it is already cached and a
  // replay shouldn't reshuffle the list under the user's cursor.
  const $recentSelect = document.getElementById('recent-uploads-select');
  const $recentClear  = document.getElementById('recent-uploads-clear');
  if ($recentSelect) {
    $recentSelect.addEventListener('change', async () => {
      const name = $recentSelect.value;
      $recentSelect.value = '';
      if (!name) return;
      const entry = loadRecentUploads().find((e) => e.name === name);
      if (!entry) return;
      await handleSalesUpload({ name: entry.name, text: entry.text }, false);
    });
  }
  if ($recentClear) {
    $recentClear.addEventListener('click', () => {
      saveRecentUploads([]);
      populateRecentUploads();
    });
  }
  populateRecentUploads();

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

// Cap the uploaded sales CSV so a huge file can't read-into-memory / hang the
// tab. A sales-comparable export is realistically well under this; the limit
// only stops accidental or pathological inputs (self-inflicted DoS).
const MAX_SALES_CSV_BYTES = 25 * 1024 * 1024;

/**
 * Read a dropped / picked File and hand it to handleSalesUpload. The
 * size guard runs here, on the File, so a pathological file is rejected
 * before it is read into memory.
 */
async function loadSalesFile(file) {
  if (!file) return;
  if (file.size > MAX_SALES_CSV_BYTES) {
    setSalesCount(
      `${file.name} is ${(file.size / 1e6).toFixed(1)} MB — too large (max ${MAX_SALES_CSV_BYTES / 1e6} MB). Trim the file and retry.`,
      true,
    );
    return;
  }
  setSalesCount(`Reading ${file.name}…`);
  let text;
  try {
    text = await file.text();
  } catch (err) {
    console.warn('Sales file read failed:', err);
    setSalesCount(`Couldn't read ${file.name}: ${err.message || 'unknown error'}.`, true);
    return;
  }
  await handleSalesUpload({ name: file.name, text });
}

/**
 * The single sales-load pipeline. Every entry point funnels through
 * here — the dropzone / file picker (via loadSalesFile), the "Paste
 * data…" modal, and a Recent-uploads replay — so a pasted SABRE block
 * and an uploaded CSV behave identically from this point on.
 *
 * @param {{ name: string, text: string }} payload
 * @param {boolean} [remember=true] cache in Recent uploads. False when
 *   replaying an entry that is already cached.
 */
async function handleSalesUpload({ name, text }, remember = true) {
  const label = name || 'pasted data';
  try {
    if (String(text || '').length > MAX_SALES_CSV_BYTES) {
      setSalesCount(
        `That input is too large (max ${MAX_SALES_CSV_BYTES / 1e6} MB). Trim it and retry.`,
        true,
      );
      return;
    }
    setSalesCount(`Reading ${label}…`);
    const parsed = parseSalesText(text);
    // Header trouble comes first: "no data rows" is a misleading way to
    // report a block whose columns simply weren't recognised. The
    // message names the missing canonicals AND echoes the headers that
    // were actually seen, so an unrecognised SABRE header can be read
    // off the screen and added to SALES_HEADER_ALIASES.
    const headerProblem = describeHeaderProblem(parsed);
    if (headerProblem) {
      setSalesCount(`${label}: ${headerProblem}`, true);
      return;
    }
    if (!parsed.rows.length) {
      setSalesCount(`No data rows found in ${label}.`, true);
      return;
    }
    salesData = dedupAndGroupSales(parsed.rows);
    // Fresh CSV = fresh filter. The user's previous PUCS picks
    // don't carry across uploads (different sale sets, different
    // codes).
    salesPucsFilter = null;
    rebuildPucsFilter();
    // Same reasoning for drawn area shapes: a stale include shape over
    // the previous CSV's neighbourhood would filter the new sale set to
    // nothing. Silent because runSalesAnalysis repopulates the table.
    // NB: only on UPLOAD — the sentinel/PUCS/date filters re-run
    // runSalesAnalysis constantly and must not cost the user their shape.
    resetShapesSilently();
    // Cache for the Recent-uploads picker only once the load has
    // actually succeeded — a rejected block (wrong headers, no rows) is
    // not worth offering to replay.
    if (remember) rememberUpload(label, text);
    await runSalesAnalysis();
  } catch (err) {
    console.warn('Sales load failed:', err);
    setSalesCount(`Couldn't read ${label}: ${err.message || 'unknown error'}.`, true);
  }
}

// ---------- Recent uploads ----------
//
// Last N sales inputs cached in localStorage, each { name, text, ts }
// where `text` is the raw CSV / pasted block. A realistic sales export
// is tens of KB, so 5 entries sit comfortably under the ~5 MB quota.
// Picking one replays it through handleSalesUpload — the same pipeline
// the dropzone and the paste modal use.

// (RECENT_STORAGE_KEY / RECENT_CAP are declared at the top of this file
// — wireSalesTab() calls populateRecentUploads() during module
// evaluation, so a const down here would still be in its temporal dead
// zone. loadRecentUploads' catch would swallow the ReferenceError and
// return [], leaving the picker permanently empty on a fresh load.)

function loadRecentUploads() {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, RECENT_CAP) : [];
  } catch { return []; }
}

function saveRecentUploads(list) {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list.slice(0, RECENT_CAP)));
  } catch { /* quota / private mode — best-effort */ }
}

function rememberUpload(name, text) {
  if (!name || !text) return;
  // De-dup by name, newest first. Re-loading the same file refreshes
  // both the timestamp and the cached text, which is what you want when
  // the export picks up new sales between sessions.
  const list = loadRecentUploads().filter((e) => e.name !== name);
  list.unshift({ name, text, ts: Date.now() });
  saveRecentUploads(list);
  populateRecentUploads();
}

function populateRecentUploads() {
  const $row    = document.getElementById('recent-uploads-row');
  const $select = document.getElementById('recent-uploads-select');
  if (!$row || !$select) return;
  const list = loadRecentUploads();
  $select.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = list.length ? 'Pick a recent CSV…' : '—';
  $select.appendChild(blank);
  for (const e of list) {
    const opt = document.createElement('option');
    opt.value = e.name;
    const dt = new Date(e.ts || 0);
    const ts = Number.isFinite(dt.valueOf()) ? dt.toISOString().slice(0, 10) : '';
    opt.textContent = ts ? `${e.name} (${ts})` : e.name;
    $select.appendChild(opt);
  }
  $row.hidden = list.length === 0;
}

function setSalesCount(text, isError = false) {
  lastSalesCountBase = text || '';
  lastSalesCountError = !!isError;
  renderSalesCount();
}

function renderSalesCount() {
  const el = document.getElementById('sales-count');
  if (!el) return;
  // The area-filter clause rides on the sales count too — a drawn shape
  // narrows a sales comp set exactly as it narrows a property search.
  const text = lastSalesCountBase
    ? lastSalesCountBase + shapeFilterSuffix()
    : '';
  el.textContent = text;
  el.classList.toggle('results-status-error', lastSalesCountError && !!text);
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
  // SABRE writes a NOMINAL $1 Sold Price on non-arms-length transfers
  // while the sworn value carries the real figure — a $1 sale with a
  // $4.08M sworn value is a transfer worth knowing about, not noise.
  // The sentinel filter still hides it (it is not a market sale and
  // must not enter a comp set), but hiding a multi-million-dollar
  // transfer without saying so would be the wrong kind of quiet.
  const hiddenWithSworn = hideSentinels
    ? salesData.sales.filter((s) => s.salePrice <= 1 && s.swornValue > 1).length
    : 0;
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
  const distinctRolls = [...new Set(visibleSales.map((s) => s.roll))];
  const chunkHint = distinctRolls.length > 500
    ? ` (${Math.ceil(distinctRolls.length / 500)} chunks, ${distinctRolls.length} rolls)`
    : '';
  setSalesCount(`Fetching live data for ${visibleSales.length} parcels${chunkHint}…`);
  document.body.classList.add('sales-mode');
  // Swap the column-visibility set to the Sales Analysis default
  // (or whatever the user's persisted sales-mode customization is).
  setColumnMode('sales');

  let assessFc;
  try {
    // Phase 7 deferral: use the non-expanded search so zoning +
    // civic-address enrichment doesn't fire on every CSV upload
    // (those add ~10s on a cold cache for 100+ rolls). The Zoning
    // overlay toggle picks it up later via the deferred-enrichment
    // hook in toggleZoning.
    // Audit M3.1: route through searchAssessmentParcelsByRolls so a
    // >500-roll CSV fetches all of them in parallel chunks. The old
    // single-call path silently truncated past 500 and then misreported
    // the truncated rolls as "not in d4mq-wa44".
    assessFc = await searchAssessmentParcelsByRolls(distinctRolls);
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

  // One feature per SALE, not per roll. A parcel that sold twice in the
  // study period (same roll, two instruments) must render as two rows —
  // the old roll-keyed stamping kept only the sale that came last in the
  // CSV and silently dropped the other transaction from the analysis.
  // buildSaleFeatures (lib/sales.js, unit-tested) clones the live feature
  // per sale, stamps the _sale* fields, and computes the multi-parcel
  // group aggregates ($/Lot SF and Sale/Asmt over group sums); sales with
  // no live d4mq-wa44 match come back as synthetic _noLiveMatch rows.
  const liveByRoll = new Map();
  for (const f of assessFc.features) {
    const r = String(f.properties?.roll_number ?? '');
    if (r) liveByRoll.set(r, f);
  }
  const saleFc = {
    type: 'FeatureCollection',
    features: buildSaleFeatures(visibleSales, liveByRoll, salesData.groups),
  };
  if (subjectCentroid) {
    for (const f of saleFc.features) {
      const c = featureCentroid(f);
      if (c) f.properties._dist = haversineKm(subjectCentroid, c);
    }
  }

  tagFeatures(saleFc, 'assess');

  // Race guard: if a newer runSalesAnalysis started while we were
  // awaiting the SODA + subject fetches, drop this run's results
  // on the floor. Otherwise an earlier (more permissive) filter's
  // late-resolving response could overwrite the latest filter.
  if (myToken !== salesRunToken) return;

  // Zoning is deferred: even with the Zoning overlay toggle ON,
  // we don't auto-fetch zoning for every sale row. The toggle
  // handler picks up the current parcel FC (lastFullAssessFc, set by
  // the setParcels call below) and runs enrichAssessmentZoning then
  // re-renders. See toggleZoning.
  lastSurveyFc = EMPTY_FC;

  const rows = saleFc.features.map((f) => ({ assess: f, survey: null }));
  const unmatched = rows.filter((r) => r.assess.properties._noLiveMatch).length;
  const repeatSales = rows.length - liveByRoll.size - unmatched;
  setSalesCount(
    `${rows.length} sale${rows.length === 1 ? '' : 's'} shown` +
    (repeatSales > 0 ? ` · ${repeatSales} repeat sale${repeatSales === 1 ? '' : 's'} of the same parcel` : '') +
    (unmatched ? ` · ${unmatched} not in d4mq-wa44` : '') +
    (hiddenWithSworn
      ? ` · ${hiddenWithSworn} $0/$1 transfer${hiddenWithSworn === 1 ? '' : 's'} hidden despite a sworn value — untick the filter to inspect`
      : '')
  );

  // Draw matched parcels on the map. Repeat sales share one polygon;
  // setParcels' geometry-hash dedupe draws it once.
  const mappable = {
    type: 'FeatureCollection',
    features: saleFc.features.filter((f) => f.geometry),
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

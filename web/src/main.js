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
import { initSidebarTabs, setActiveTab, onTabChange, getActiveTab } from './lib/tabs.js';
import { presetRange } from './lib/datePresets.js';
import { readMapLegends, layoutMapLegends, paintMapLegends } from './lib/mapLegend.js';
import {
  buildPermitIndex, findNearestPermit, demoVerdict, describeDemoPermit,
  buildVerdict, describeBuildPermit,
  rollBuildVerdict, describeRollBuilt,
  sabreBuildVerdict, describeSabreBuilt,
  pricedAsLand, describePricedAsLand,
} from './lib/permitEvidence.js';
import { yieldToPaint } from './lib/yieldToPaint.js';
import { judgedVerdict, judgedAssembly, saleJudgement } from './lib/saleJudgements.js';
import { initDataStatusDialog, initStalenessBanner } from './dataStatusDialog.js';
import { initSalesDbPanel } from './salesDbPanel.js';
import bbox from '@turf/bbox';
import {
  searchSurveyParcels,
  fetchAssessmentOverlap,
  joinSurveyWithAssessment,
  searchAssessmentParcels,
  searchAssessmentParcelsByRolls,
  fetchDemoPermits,
  fetchBuildPermits,
  searchAssessmentParcelsExpanded,
  fetchStreetNames,
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
  setContamData, setContamVisible, setWaterInfluenceVisible,
  setSubjectData,
  setParcelNumberData, setParcelNumbersVisible,
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
import { buildClusterIndex, clusterForFeature } from './lib/clusters.js';
import { createMultiSelectFilter } from './lib/multiSelectFilter.js';
import { createStreetSuggest, buildStreetIndex } from './lib/streetSuggest.js';
import {
  parseBound, passesSizeFilter, normalizeStreetQuery, passesStreetFilter,
  passesPriceFilter,
  saleZoningCodes, passesZoningFilter,
  groupVacancy, passesVacantFilter, isVacantUseCode, isLandSetUseCode, saleUseCodeOf,
  resolveMixedSales,
  groupSpreadKm, isFarFlung,
} from './lib/salesFilters.js';
import { waterOf, waterLoaded, waterColor, waterSortRank } from './lib/water.js';
import { computeSizeChanges } from './lib/sizeChange.js';
import { normalizeRoll, dedupAndGroupSales, buildSaleFeatures } from './lib/sales.js';
import {
  saleCategory, pucsName, PUCS_CATEGORY_ORDER, UNCLASSIFIED_CATEGORY,
} from './lib/pucs.js';
import { assessmentUrl } from './lib/links.js';   // walkscoreUrl/floodToolUrl used only inside registry render functions now
import { COLUMNS, csvSchemaForMode, buildThead, columnCellClasses } from './lib/columnsRegistry.js';
import { assignParcelSeq, clearParcelSeq } from './lib/parcelNumbering.js';
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
const $waterFront = document.getElementById('water-front');
const $waterNear  = document.getElementById('water-near');
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
const $numberingToggle  = document.getElementById('numbering-toggle');
const $numberingRow     = document.getElementById('numbering-row');
const $numberingOrderToggle = document.getElementById('numbering-order-toggle');
const $numberingOrderLabel  = document.getElementById('numbering-order-label');

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
// "Number parcels" (under the active tab's action row). `numberingOn` is
// the user's choice; `numberable` is whether the current result set has
// more than one numbered subject. Numbers only appear when both hold — a
// lone "1" on a single parcel is noise, and the checkbox itself stays
// hidden until it would do something.
let numberingOn = false;
let numberable = false;
// "Entry order" beside it — number in the order the rolls were ENTERED
// rather than by roll number. Opt-in, and only offered when the result
// set on screen came from an entered list: the Roll # chips (property) or
// the pasted / uploaded rows (sales). Each side keeps its own
// `{ byRoll, rollCount }` so a sales filter re-run after a property search
// still numbers the sales set in its own order; enteredRollOrder() picks
// by mode. Like numberingOn, the choice survives while it is hidden.
let numberingEntryOrder = false;
let propertyRollOrder = null;
let salesRollOrder = null;
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
  // Map badge number. Rows in one numbered group share a value, so the
  // secondary ordering inside a group is whatever sortRows falls back to.
  seq:     (r) => finiteOrNeg(r.assess?.properties?._seq ?? r.survey?.properties?._seq),
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
  livingArea:   (r) => finiteOrNeg(r.assess?.properties?._saleLivingArea
                                   ?? r.assess?.properties?.total_living_area),
  // Sort on the NUMERIC year, never the display string: a multi-section
  // sale shows "1911, 1913, 1954", and sorting that as text puts 1911
  // beside 1913 but "900" after "1911".
  yearBuilt:    (r) => numOrStr(r.assess?.properties?._saleYearBuiltNumeric
                                ?? r.assess?.properties?._saleYearBuilt
                                ?? r.assess?.properties?.year_built),
  buildingType:  (r) => strKey(r.assess?.properties?.building_type),
  rooms:         (r) => finiteOrNeg(r.assess?.properties?.rooms),
  dwellingUnits: (r) => finiteOrNeg(r.assess?.properties?.dwelling_units),
  instrument:   (r) => strKey(r.assess?.properties?._saleInstrument),
  propertyType: (r) => strKey(r.assess?.properties?._salePropertyType),
  groupSize:    (r) => finiteOrNeg(r.assess?.properties?._saleGroupSize),
  water:        (r) => waterSortRank(waterOf(r.assess?.properties), waterLoaded(r.assess?.properties)),
  cluster:      (r) => strKey(r.assess?.properties?._cluster),
  swornValue:   (r) => finiteOrNeg(r.assess?.properties?._saleSwornValue),
  category:     (r) => strKey(r.assess?.properties?._saleCategory),
  // Sorts by the NAME, which is what the column shows — sorting the
  // plain-language column by its underlying code would move rows into
  // an order the reader cannot see a reason for.
  useCodeName:  (r) => strKey(pucsName(r.assess?.properties?._saleUseCode)),
  numUnits:     (r) => finiteOrNeg(r.assess?.properties?._saleNumUnits),
  unitLabel:    (r) => strKey(r.assess?.properties?._saleUnitLabel),
  saleZoning:   (r) => strKey(r.assess?.properties?._saleZoning),
  n1Id:         (r) => numOrStr(r.assess?.properties?._n1Id),
  saleAcres:    (r) => finiteOrNeg(r.assess?.properties?._saleAcres),
  pricePerBldgSf: (r) => finiteOrNeg(r.assess?.properties?._pricePerBldgSf),
  // Rank, not text: teardown first, then confirms-vacant, then the
  // unflagged majority — so one click on Demo brings the finding up.
  demo:         (r) => {
    const v = r.assess?.properties?._demoVerdict;
    return v === 'teardown' ? '0' : v === 'confirms-vacant' ? '1' : '2';
  },
  demoDate:     (r) => strKey(r.assess?.properties?._demoDate),
  built:        (r) => {
    const v = r.assess?.properties?._buildVerdict;
    return v === 'already-built' ? '0' : v === 'land-then-built' ? '1' : '2';
  },
  builtDate:    (r) => strKey(r.assess?.properties?._buildDate),
  source:       (r) => strKey(r.assess?.properties?._source),
  mlsDate:      (r) => strKey(r.assess?.properties?._mlsDate),
  mlsNumber:    (r) => numOrStr(r.assess?.properties?._mlsNumber),
  listPrice:    (r) => finiteOrNeg(r.assess?.properties?._listPrice),
  origPrice:    (r) => finiteOrNeg(r.assess?.properties?._origPrice),
  dom:          (r) => finiteOrNeg(r.assess?.properties?._dom),
  bldgType:     (r) => strKey(r.assess?.properties?._bldgType),
  style:        (r) => strKey(r.assess?.properties?._style),
  siteInfl:     (r) => strKey(r.assess?.properties?._siteInfl),
  pricePerAcre: (r) => finiteOrNeg(r.assess?.properties?._pricePerAcre),
  pricePerLot:  (r) => finiteOrNeg(r.assess?.properties?._pricePerLot),
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
document.getElementById('water-toggle')?.addEventListener('click', toggleWaterOverlay);
// "Number parcels". No re-render: `_seq` is already stamped and the "#"
// cells are already in the DOM — the body class is what reveals them, so
// flipping the checkbox is a class toggle plus a map visibility call.
if ($numberingToggle) {
  $numberingToggle.addEventListener('change', () => {
    numberingOn = $numberingToggle.checked;
    const active = numberingOn && numberable;
    document.body.classList.toggle('numbering-on', active);
    mapReady.then(() => setParcelNumbersVisible(map, active));
    queueUrlWrite();
  });
}
// "Entry order". renderTable re-stamps `_seq` from scratch (assignParcelSeq
// re-derives its order every call), so this is the one place a live set is
// deliberately renumbered; the badges and the "#" cells follow.
if ($numberingOrderToggle) {
  $numberingOrderToggle.addEventListener('change', () => {
    numberingEntryOrder = $numberingOrderToggle.checked;
    if (fullRows.length > 0) renderTable(fullRows);
    queueUrlWrite();
  });
}
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
//
// $addressStreet is NOT in this list: its typeahead owns Enter, because
// Enter there has to mean "take the highlighted street AND search" and
// the accept must land before the search reads the field. Two listeners
// on one element would have fired in registration order and searched the
// half-typed text. createStreetSuggest calls runSearch itself, below.
for (const el of [$lot, $block, $plan, $desc, $addressFrom, $addressTo, $zoning, $duMin]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
}

// Predictive street-name list on the Street Name field. The vocabulary
// is the assessment roll's own street_name column (soda.fetchStreetNames),
// fetched once on the first focus and cached in localStorage for a month
// — so the first keystroke of a session pays ~258 KB and nothing after
// that pays anything. Loading it also teaches normalizeStreetQuery which
// names are real, which is what stops "ELM PARK" searching as "ELM".
createStreetSuggest({
  inputId: 'address-street',
  listId: 'address-street-suggest',
  loadIndex: () => fetchStreetNames().then(buildStreetIndex),
  onSearch: () => runSearch(),
});

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

// The numbering row (Number parcels / Entry order) sits under the active
// tab's action row and MOVES with the tab rather than being copied into
// both panels, so there is one checkbox state and no syncing — the
// Manitoba app's placeMapOptionsRow pattern.
function placeNumberingRow(tab) {
  if (!$numberingRow) return;
  const panel = document.querySelector(`.sidebar-tab-panel[data-tab="${tab}"]`);
  const actionRow = panel?.querySelector(':scope > .action-row');
  if (actionRow && actionRow.nextElementSibling !== $numberingRow) {
    actionRow.insertAdjacentElement('afterend', $numberingRow);
  }
}
onTabChange(placeNumberingRow);
placeNumberingRow(getActiveTab());

// Wire the Sales Analysis tab — dropzone, subject roll, sentinel
// filter. The CSV is parsed entirely client-side; no upload.
wireSalesTab();

// Topbar Data Status dialog + the tile-staleness banner. Lazy: the
// dialog fetches nothing until first opened; the banner costs one
// ~500-byte same-origin fetch at init.
initDataStatusDialog();
initStalenessBanner();

// Legend-in-image tick: reveal it only while a legend is on screen.
updateLegendAvailability();
if ($mapEl) {
  new MutationObserver(updateLegendAvailability).observe($mapEl, {
    subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'],
  });
}

// SABRE sales database panel. onLoad hands the merged archive to the
// same pipeline as a file drop; remember=false keeps the multi-file
// merge out of the localStorage Recent-uploads cache — it already
// lives in IndexedDB, and recents are a 5-slot quota-bound cache.
initSalesDbPanel({
  onLoad: (payload) => handleSalesUpload(payload, false),
  setStatus: (m) => setSalesCount(m),
  getDateWindow: () => ({
    from: document.getElementById('sales-date-from')?.value || '',
    to: document.getElementById('sales-date-to')?.value || '',
  }),
});

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

  // "Number parcels" — emit the user's CHOICE, not whether it's currently
  // in effect. `numberable` depends on a result set the recipient hasn't
  // run yet; dropping the param because this page happens to show one
  // parcel would strip the setting out of a shared link.
  if (numberingOn) s.numberingToggle = true;
  if (numberingEntryOrder) s.numberingOrder = true;

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

  // N1 crosswalk filter (Sales tab). 'any' is the default and stays
  // out of the URL.
  const n1Val = document.getElementById('sales-n1-filter')?.value;
  if (n1Val === 'matched' || n1Val === 'unmatched') s.salesN1 = n1Val;

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

  // Numbering: set the flag and the checkbox directly rather than
  // .click()ing it. There is no result set yet at this point in init, so
  // the change handler would only toggle a body class that the first
  // renderTable recomputes anyway — and clicking would fire an extra URL
  // write mid-restore.
  if ('numberingOrder' in state) {
    numberingEntryOrder = !!state.numberingOrder;
    if ($numberingOrderToggle) $numberingOrderToggle.checked = numberingEntryOrder;
  }
  if ('numberingToggle' in state) {
    numberingOn = !!state.numberingToggle;
    if ($numberingToggle) $numberingToggle.checked = numberingOn;
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

  if ('salesN1' in state) {
    const el = document.getElementById('sales-n1-filter');
    if (el) el.value = state.salesN1;
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
  // Entry order for "Number parcels": the Roll # chips, as entered. An
  // address / legal search leaves this null, which hides the checkbox.
  propertyRollOrder = buildEnteredRollOrder($roll.value);
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
    // Water influence. Either box on its own is a real query — the
    // whole point is that frontage and near-water are different
    // markets — so each counts as an assessment-side filter and can
    // drive a search with no other field filled.
    waterfront: !!$waterFront?.checked,
    nearWater:  !!$waterNear?.checked,
  };

  const anyLegal = inputs.lot || inputs.block || inputs.plan || inputs.desc;
  const anyDu = inputs.duMode === 'zero' || (inputs.duMode === 'min' && inputs.duMin > 0);
  const anyAddress = inputs.addressFrom || inputs.addressTo || inputs.addressStreet;
  const anyWater = inputs.waterfront || inputs.nearWater;
  const anyAssess = inputs.roll || anyAddress || inputs.zoning || anyDu || anyWater;

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
/**
 * Stamp `_waterColor` on each feature so the water-influence layers can
 * paint straight off a data-driven `['get', '_waterColor']` expression.
 * A MapLibre `match` over the raw property_influences string could not
 * do this: the field is multi-valued, so the colour depends on parsing
 * it, which only lib/water.js does.
 */
function stampWaterColors(fc) {
  for (const f of fc?.features || []) {
    const c = waterColor(waterOf(f.properties));
    if (c) f.properties._waterColor = c;
    else delete f.properties?._waterColor;
  }
  return fc;
}

function setParcels(surveyFc, assessFc = EMPTY_FC, { fit = true } = {}) {
  stampWaterColors(surveyFc);
  stampWaterColors(assessFc);
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

let waterOverlayEnabled = false;
/**
 * Water-influence overlay toggle.
 *
 * OFF by default and it never auto-arms — not even when the waterfront
 * search filters are ticked. Painting the map without being asked takes
 * control away from the user; if the button is hard to find, that is a
 * discoverability problem to fix in the button, not by seizing the map.
 */
function toggleWaterOverlay() {
  waterOverlayEnabled = !waterOverlayEnabled;
  const btn = document.getElementById('water-toggle');
  if (btn) {
    btn.classList.toggle('active', waterOverlayEnabled);
    btn.setAttribute('aria-pressed', String(waterOverlayEnabled));
    btn.textContent = waterOverlayEnabled ? 'Hide Water Influence' : 'Water Influence';
  }
  mapReady.then(() => setWaterInfluenceVisible(map, waterOverlayEnabled));
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
  // Drop the badges with the rows. The checkbox keeps its state — it
  // just goes back into hiding until the next multi-parcel result set —
  // so a user who numbered one search doesn't have to re-tick for the
  // next one.
  numberable = false;
  if ($numberingRow) $numberingRow.hidden = true;
  document.body.classList.remove('numbering-on');
  mapReady.then(() => {
    setParcelNumberData(map, []);
    setParcelNumbersVisible(map, false);
  });
}

// ---------- Parcel numbering ----------
//
// The "Number parcels" toggle stamps a stable 1..N on the result set,
// shown as a red badge on each parcel and in the grid's "#" column, so a
// map exhibit and a comp table can be read against each other. The
// numbering rules (roll order; one number per subject, where a
// multi-parcel sale and a repeat sale of one parcel are each ONE subject)
// live in lib/parcelNumbering.js; drawing lives in map.js. This is the
// "when".

/** The geometry/property-bearing feature for a row. Assessment side when
 *  there is one — it's what the map draws and what carries the sale
 *  fields — falling back to the survey lot for a legal-description search
 *  that found no assessment match. */
function rowFeature(r) {
  return r?.assess || r?.survey || null;
}

/**
 * Assign numbers over `fullRows`, push badges for `shownRows`, and sync
 * the toggle's own visibility.
 *
 * Numbering runs over the FULL set, never the shown one. A drawn-shape
 * area filter narrows what is displayed; re-deriving numbers from the
 * narrowed set would renumber every parcel the moment a shape is drawn,
 * moved or erased, and #4 in a report would stop meaning one parcel.
 * assignParcelSeq derives its own roll order, so calling it on every
 * render is idempotent — re-sorting the grid can't shift the numbers
 * either.
 *
 * Badges, by contrast, follow the SHOWN set: a parcel filtered out of the
 * table shouldn't still be tagged on the map. It keeps its number for
 * when the shape is erased.
 */
/**
 * Build the roll → entered-position map behind "Entry order". `list` is
 * either the Roll # field's comma string or an array of rolls (the sales
 * rows, in CSV order). Keyed by the canonical 11-digit roll so a typed
 * "1003547800" matches its live "01003547800". First appearance wins, so a
 * repeat-sold parcel keeps the position of its first row. Returns null
 * for an empty list; `rollCount` distinguishes one roll (no meaningful
 * order) from a real list.
 */
function buildEnteredRollOrder(list) {
  const tokens = Array.isArray(list) ? list : String(list ?? '').split(/[\s,;&]+/);
  const byRoll = new Map();
  for (const t of tokens) {
    const roll = normalizeRoll(t);
    if (roll && !byRoll.has(roll)) byRoll.set(roll, byRoll.size);
  }
  return byRoll.size ? { byRoll, rollCount: byRoll.size } : null;
}

/** The entered order for the result set on screen — the sales rows in
 *  sales mode, the Roll # chips otherwise. */
function enteredRollOrder() {
  return document.body.classList.contains('sales-mode') ? salesRollOrder : propertyRollOrder;
}

/** The rollOrder to number by right now — null unless "Entry order" is
 *  on AND there is a real order (two or more entered rolls) to follow.
 *  The `rollCount > 1` test mirrors the checkbox's own visibility rule in
 *  applyParcelNumbering, so what is applied never disagrees with what is
 *  on offer. */
function activeRollOrder() {
  if (!numberingEntryOrder) return null;
  const order = enteredRollOrder();
  return (order?.rollCount ?? 0) > 1 ? order.byRoll : null;
}

function applyParcelNumbering(fullRows, shownRows) {
  const all = fullRows.map(rowFeature).filter(Boolean);
  assignParcelSeq(all, { rollOrder: activeRollOrder() });
  // Count SUBJECTS, not rows. Five rows that are all one repeat-sold
  // parcel collapse to a single number, and numbering that set would put
  // a solitary "1" on the map while claiming to have numbered something.
  const subjects = new Set(all.map((f) => f.properties._seq)).size;
  numberable = subjects > 1;
  if (!numberable) clearParcelSeq(all);

  if ($numberingRow) $numberingRow.hidden = !numberable;
  // "Entry order" only when there IS an entry order — an entered list
  // naming more than one roll. An address or legal-description search has
  // none, so the checkbox stays out of the way rather than sitting there
  // as a no-op. The choice itself is kept (activeRollOrder ignores it
  // while unavailable), so it is still in force for the next pasted list.
  const orderAvail = numberable && (enteredRollOrder()?.rollCount ?? 0) > 1;
  if ($numberingOrderLabel) $numberingOrderLabel.hidden = !orderAvail;
  const active = numberingOn && numberable;
  document.body.classList.toggle('numbering-on', active);

  const shownFeatures = numberable ? shownRows.map(rowFeature).filter(Boolean) : [];
  mapReady.then(() => {
    setParcelNumberData(map, shownFeatures);
    setParcelNumbersVisible(map, active);
  });
}

/**
 * Render `rows` into the results table. This is the single funnel for
 * the drawn-shape area filter: the argument is always the FULL set for
 * the current search, and any active shapes narrow it here. That way a
 * late enrichment re-render (address back-fill, partial-lot detection)
 * landing while shapes are drawn stays narrowed, and erasing a shape
 * restores the full set from `fullRows` with no re-search.
 */
/**
 * How many rows the table will actually build. See the comment at the
 * row loop: this caps DRAWING only, never the analysis.
 */
const TABLE_DRAW_CAP = 2000;

/** Rows the last render left undrawn, for the count line to own up to. */
let drawCapped = 0;

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
  // Must precede sortRows: `seq` is a sortable column, so the key has to
  // exist before the comparator can read it.
  applyParcelNumbering(rows, shown);
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
    // Draw cap. One <tr> per row with no virtualization means a full
    // archive load is 18,000 rows x ~25 columns — roughly 450,000 DOM
    // nodes — and the tab locks for seconds. ONLY THE DRAWING IS CAPPED:
    // currentRows (and therefore the CSV export), the charts broadcast
    // and every count above are computed over the whole set, so no
    // figure that could reach a report changes. Jason’s call.
    // `break`, not slice(), so the group-position lookups below still
    // index the full sorted array and a capped row’s neighbour is read
    // correctly.
    if (sortedIdx >= TABLE_DRAW_CAP) break;
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
    // Sale Price and Sworn disagree — a non-arms-length transfer. Marked
    // on the ROW as well as the two cells so it's findable while
    // scrolling, without having to scan those two columns.
    if (a._saleSwornMismatch) {
      tr.classList.add('sworn-mismatch-row');
      tr.title = 'Sale Price and Sworn Value disagree — the sold price is not what this property changed hands for. Click to zoom map to this parcel.';
    } else {
      tr.title = 'Click to zoom map to this parcel';
    }
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
      const cell = col.render(a, s);
      // Same data-col + conditional classes the <th> carries. Without
      // this the `.sales-only` / `.subj-col` display:none rules hide a
      // heading while its cells stay put, and every column after it
      // renders one place off. See columnCellClasses.
      cell.dataset.col = col.key;
      for (const cls of columnCellClasses(col)) cell.classList.add(cls);
      tr.appendChild(cell);
    }
    frag.appendChild(tr);
  }
  $tbody.appendChild(frag);
  drawCapped = Math.max(0, sorted.length - TABLE_DRAW_CAP);
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
  // The "#" column joins the export only when the set is actually
  // numbered — that's when it's the key tying the spreadsheet to the map
  // exhibit. Otherwise the export keeps the schema it has always had.
  const { headers, cells } = csvSchemaForMode(mode, { numbering: numberingOn && numberable });
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
 * The far-flung tally that sits outside the Additional-filters
 * disclosure. Silent when nothing is flagged: a permanent "none
 * flagged" beside a control the user can't see would be noise that
 * trains the eye to skip it. Counted by distinct SALE, not by row — a
 * 14-parcel portfolio sale is one sale, and saying 14 would badly
 * overstate what is being set aside.
 */
function updateFarFlungCount(sales, thresholdKm, excluding) {
  const el = document.getElementById('far-flung-count');
  if (!el) return;
  if (!thresholdKm || !sales) {
    el.textContent = '';
    el.classList.remove('has-flagged');
    el.removeAttribute('title');
    return;
  }
  const verb = excluding ? 'excluded' : 'flagged';
  el.textContent = `⚠ Far-Flung: ${sales} sale${sales === 1 ? '' : 's'} ${verb}`;
  el.classList.add('has-flagged');
  el.title = excluding
    ? `Sales whose own parcels lie more than ${thresholdKm} km apart are being REMOVED from the table, map and export. Change the threshold or untick Exclude under Additional filters.`
    : `Sales whose own parcels lie more than ${thresholdKm} km apart are marked with a ⚠ on $/Lot SF. Nothing is removed unless you tick Exclude under Additional filters.`;
}

/*
 * Live link to the land-sales charts tab (charts.html).
 *
 * The charts page holds no data: it asks for the current set on open
 * and we re-publish on every sales render, so the scatter tracks the
 * sidebar filters. Only the fields the charts actually read are sent —
 * a projection, not the whole feature — because the full joined
 * features carry geometry and would be an order of magnitude larger to
 * structured-clone on every keystroke of a filter.
 */
const CHARTS_CHANNEL = 'wps-sales-charts';
let chartsChannel = null;
let lastChartRows = [];

function chartsBus() {
  if (chartsChannel || typeof BroadcastChannel === 'undefined') return chartsChannel;
  chartsChannel = new BroadcastChannel(CHARTS_CHANNEL);
  // A tab opened after the grid was populated has no broadcast coming,
  // so it asks; answer with whatever we last rendered.
  chartsChannel.addEventListener('message', (e) => {
    if (e.data?.type === 'request') {
      chartsChannel.postMessage({ type: 'sales', rows: lastChartRows });
    }
  });
  return chartsChannel;
}

function publishSalesToCharts(rows) {
  lastChartRows = (rows || []).map((r) => {
    const p = r.assess?.properties || {};
    return {
      assess: {
        properties: {
          roll_number: p.roll_number,
          full_address: p.full_address,
          _saleInstrument: p._saleInstrument,
          _saleDate: p._saleDate,
          _salePrice: p._salePrice,
          _saleAcres: p._saleAcres,
          _pricePerSf: p._pricePerSf,
          _pricePerAcre: p._pricePerAcre,
          _pricePerLot: p._pricePerLot,
          _saleUseCode: p._saleUseCode,
          property_use_code: p.property_use_code,
          _saleZoning: p._saleZoning,
          zoning: p.zoning,
          _saleGroupSize: p._saleGroupSize,
          _dist: p._dist,
          _farFlung: p._farFlung,
          _buildVerdict: p._buildVerdict,
          _demoVerdict: p._demoVerdict,
          // The permit-corrected category, so the charts and the grid
          // cannot disagree about what "land" is. Without it the charts
          // re-derive land from the raw use code and a teardown — an
          // improved-coded sale that in fact bought a lot — can never
          // appear on a land chart.
          _saleCategory: p._saleCategory,
        },
      },
    };
  });
  try { chartsBus()?.postMessage({ type: 'sales', rows: lastChartRows }); } catch { /* no receiver */ }
}

/**
 * Show the "Include legend in map image" tick only once a legend is
 * actually on screen. Watching the map pane for hidden/style flips
 * beats hooking each of the dozen overlay handlers — one observer
 * cannot be forgotten when a new overlay is added.
 */
function updateLegendAvailability() {
  const label = document.getElementById('legend-toggle-label');
  if (!label || !$mapEl) return;
  const any = [...$mapEl.querySelectorAll('.map-legend')]
    .some((el) => !el.hidden && el.offsetParent !== null);
  label.hidden = !any;
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

  // Legend, when asked for: stacked upward from just above the credit
  // pill, in the same bottom-right corner it occupies on screen. Drawn
  // last so it sits over the map; the image keeps its dimensions.
  if (document.getElementById('legend-toggle')?.checked) {
    const legends = readMapLegends($mapEl, (el) => getComputedStyle(el));
    if (legends.length) {
      const measure = (t, bold) => {
        ctx.font = `${bold ? '600 ' : ''}${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
        return ctx.measureText(t).width;
      };
      const boxes = layoutMapLegends(legends, {
        width: w, height: h, bottomY: y0 - 6, fontSize, measureText: measure,
      });
      paintMapLegends(ctx, boxes, fontSize);
    }
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

// The PUCS and assessment-class multi-selects own their own selection
// state — see pucsFilter / classFilter below and lib/multiSelectFilter.js
// for the tri-state (null = no filter / Set = those only / empty Set =
// show nothing). Both are reset on every fresh CSV.

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

  // Date-preset pills. Fill the pickers, flash them so the change is
  // visible, then dispatch 'change' — the pickers' own listeners above
  // do the rest (Winnipeg's date inputs commit on change, not input).
  const flashDates = () => {
    for (const el of [$dateFrom, $dateTo]) {
      if (!el) continue;
      el.classList.remove('just-set');
      void el.offsetWidth;   // restart the animation
      el.classList.add('just-set');
    }
  };
  for (const btn of document.querySelectorAll('.date-preset-btn')) {
    btn.addEventListener('click', () => {
      if (!$dateFrom || !$dateTo) return;
      if (btn.dataset.clear === '1') {
        $dateFrom.value = '';
        $dateTo.value = '';
      } else {
        const { from, to } = presetRange(parseInt(btn.dataset.months || '0', 10));
        $dateFrom.value = from;
        $dateTo.value = to;
      }
      flashDates();
      $dateFrom.dispatchEvent(new Event('change', { bubbles: true }));
      $dateTo.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Sale/Asmt cap, vacant/improved, and the far-flung pair. All re-run
  // the analysis; the far-flung km field listens on 'input' too so the
  // tally tracks as you type rather than only on blur.
  for (const id of ['vacant-improved', 'far-flung-exclude', 'far-flung-km']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', () => { if (salesData) runSalesAnalysis(); });
    if (id === 'far-flung-km') {
      el.addEventListener('input', () => { if (salesData) runSalesAnalysis(); });
    }
  }

  // Charts. A named window target so repeated clicks reuse the one
  // tab rather than littering a dozen identical ones.
  document.getElementById('charts-open')?.addEventListener('click', () => {
    chartsBus();   // ensure we're listening before the tab asks
    window.open('charts.html', 'wps-sales-charts');
  });

  // N1 crosswalk filter (Additional filters). Shareable via ?n1=.
  const $n1Filter = document.getElementById('sales-n1-filter');
  if ($n1Filter) {
    $n1Filter.addEventListener('change', () => {
      queueUrlWrite();
      if (salesData) runSalesAnalysis();
    });
  }

  // Lot-size range + street name. 'input' rather than 'change' so the
  // set narrows as you type — these two are the filters you tune by
  // watching the count, unlike the date pickers which commit once.
  // Debounced, because each run re-joins against the live records.
  const $sizeLow  = document.getElementById('sales-size-low');
  const $sizeHigh = document.getElementById('sales-size-high');
  const $street   = document.getElementById('sales-street-name');
  const $priceLow  = document.getElementById('sales-price-low');
  const $priceHigh = document.getElementById('sales-price-high');
  let filterTimer = null;
  const rerunSoon = () => {
    if (!salesData) return;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => runSalesAnalysis(), 300);
  };
  for (const el of [$sizeLow, $sizeHigh, $street, $priceLow, $priceHigh]) {
    if (el) el.addEventListener('input', rerunSoon);
  }

  // Clear — the same hard reset the Property tab uses. A soft clear
  // would have to unwind the loaded CSV, both multi-selects, every
  // range input, the subject roll, the map layers and the column mode;
  // a reload of the bare URL cannot leave a corner of that behind.
  const $salesClear = document.getElementById('sales-clear');
  if ($salesClear) $salesClear.addEventListener('click', clearAll);

  setSalesCount('');
}

/*
 * Sales-tab multi-select filters. Both use the same controller
 * (lib/multiSelectFilter.js); they differ only in where their values
 * come from:
 *
 *   PUCS   — off the pasted CSV rows, so the list is known before any
 *            network call and is rebuilt on upload.
 *   Class  — off the LIVE assessment record (property_class_1); the
 *            SABRE export carries no class column, so the list can only
 *            be built after the roll lookup and is therefore rebuilt
 *            from each run's joined results.
 */

const pucsFilter = createMultiSelectFilter({
  btnId: 'pucs-filter-btn',
  popoverId: 'pucs-filter-popover',
  label: 'PUCS',
  onChange: () => runSalesAnalysis(),
});

const classFilter = createMultiSelectFilter({
  btnId: 'class-filter-btn',
  popoverId: 'class-filter-popover',
  label: 'class',
  onChange: () => runSalesAnalysis(),
});

// Zoning — like Class, this can only be built after the join, because
// half its vocabulary (the parcel's CURRENT zoning) comes from the live
// record. Unlike Class it has a second source that IS in the CSV, so the
// list is never empty: see saleZoningCodes in lib/salesFilters.js.
const zoningFilter = createMultiSelectFilter({
  btnId: 'zoning-filter-btn',
  popoverId: 'zoning-filter-popover',
  label: 'zoning',
  onChange: () => runSalesAnalysis(),
});

// Category — the grouping a comp search actually starts from. Built after
// the join and after the permit pass, because the permit record is what
// moves a vacant-coded sale that already had a house on it out of Land.
// Explicit order (Land first) rather than alphabetical: this is a fixed
// vocabulary with a natural reading order, and sorting it would bury Land
// between Infrastructure and Mixed-Use.
const categoryFilter = createMultiSelectFilter({
  btnId: 'category-filter-btn',
  popoverId: 'category-filter-popover',
  label: 'category',
  order: [...PUCS_CATEGORY_ORDER, UNCLASSIFIED_CATEGORY],
  onChange: () => runSalesAnalysis(),
});

/**
 * Rebuild the category options from the joined, permit-corrected set.
 *
 * Tallied from the set BEFORE the category filter narrows it, for the
 * same reason as Class: counting the filtered set would shrink the
 * option list on every change and the user could never tick back what
 * they unticked.
 */
function rebuildCategoryFilter(features) {
  const counts = new Map();
  for (const f of features) {
    const c = saleCategoryOf(f);
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  categoryFilter.setOptions(counts);
}

/**
 * A sale's category, as the filter and the column both read it.
 *
 * Falls back to a named bucket rather than blank when lib/pucs.js has
 * never seen the code: a code the City adds later must be VISIBLE and
 * tickable, because the alternative is that those sales quietly fail
 * every category filter and drop out of comp searches unnoticed.
 */
function saleCategoryOf(f) {
  return f?.properties?._saleCategory || UNCLASSIFIED_CATEGORY;
}

/** Rebuild the PUCS options from the loaded CSV. Counts are per SALE,
 *  not per raw row — dedup has already collapsed component rows. */
function rebuildPucsFilter() {
  const counts = new Map();
  for (const s of salesData?.sales || []) {
    const k = s.useCode || '(blank)';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  pucsFilter.setOptions(counts);
}

/**
 * Rebuild the assessment-class options from the joined features.
 *
 * Must be tallied from the set BEFORE the class filter narrows it —
 * counting the filtered set would shrink the option list on every
 * change and the user could never get back the classes they unticked.
 */
function rebuildClassFilter(features) {
  const counts = new Map();
  for (const f of features) {
    counts.set(saleClassOf(f), (counts.get(saleClassOf(f)) || 0) + 1);
  }
  classFilter.setOptions(counts);
}

/**
 * Rebuild the zoning picker from the joined results.
 *
 * A sale carrying two different codes (its recorded sale zoning and a
 * since-changed current zoning) counts toward BOTH options, which is what
 * makes it findable under either — the count is "sales carrying this
 * code", not a partition of the set, so the counts can sum to more than
 * the number of sales.
 */
function rebuildZoningFilter(features) {
  const counts = new Map();
  for (const f of features) {
    for (const code of saleZoningCodes(f, stripZoningCode)) {
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  zoningFilter.setOptions(counts);
}

/** A sale's assessment class, bucketing the rolls that matched no live
 *  record — they genuinely have no class rather than a blank one. */
function saleClassOf(f) {
  const p = f?.properties || {};
  if (p._noLiveMatch) return '(no live match)';
  return p.property_class_1 || '(blank)';
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
    // Entry order for "Number parcels": each roll's first appearance in
    // the pasted / uploaded rows, so a pasted comp list numbers as typed.
    salesRollOrder = buildEnteredRollOrder(salesData.sales.map((s) => s.roll));
    // Fresh CSV = fresh filter. The user's previous PUCS picks
    // don't carry across uploads (different sale sets, different
    // codes).
    pucsFilter.reset();
    classFilter.reset();
    categoryFilter.reset();
    // The N1 filter resets too: Matched/Unmatched is a statement about
    // THIS CSV's crosswalk column, not a standing preference.
    const $n1 = document.getElementById('sales-n1-filter');
    if ($n1) $n1.value = 'any';
    // Same reasoning for the other narrowing controls: they describe the
    // previous comp set, not a standing preference. Far-flung is left
    // alone — its threshold is a judgement about what counts as
    // scattered, which does carry across uploads.
    const $vacant = document.getElementById('vacant-improved');
    if ($vacant) $vacant.value = 'all';
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

/**
 * Owning up to the draw cap.
 *
 * Silence here would be the worst outcome: a table showing 2,000 of
 * 14,318 sales, with medians and charts computed over all 14,318, reads
 * as a much smaller market than it is. Say the number, and say what
 * still covers everything.
 */
function drawCapSuffix() {
  if (!drawCapped) return '';
  const shown = TABLE_DRAW_CAP.toLocaleString('en-CA');
  const total = (TABLE_DRAW_CAP + drawCapped).toLocaleString('en-CA');
  return ` · table showing the first ${shown} of ${total} rows in the current sort — charts, medians and export cover all ${total}`;
}

function renderSalesCount() {
  const el = document.getElementById('sales-count');
  if (!el) return;
  // The area-filter clause rides on the sales count too — a drawn shape
  // narrows a sales comp set exactly as it narrows a property search.
  const text = lastSalesCountBase
    ? lastSalesCountBase + shapeFilterSuffix() + drawCapSuffix()
    : '';
  el.textContent = text;
  el.classList.toggle('results-status-error', lastSalesCountError && !!text);
  // Mirror into the status bar between the map and the table, the way
  // renderCount already does for a property search. Without this the
  // sales tab reports itself ONLY in the sidebar, so a long run over the
  // whole archive looks like a frozen page rather than a working one.
  const bar = document.getElementById('results-status');
  if (bar && document.body.classList.contains('sales-mode')) {
    bar.hidden = !text;
    bar.textContent = text;
    bar.classList.remove('results-status-busy');
    bar.classList.toggle('results-status-error', lastSalesCountError && !!text);
  }
}

/**
 * Say what the run is DOING, in the bar above the table.
 *
 * A full-archive sales run fetches thousands of assessment records, two
 * permit tables and a neighbourhood index before a single row appears.
 * On one thread that reads as a hang: the tab stops responding and
 * nothing on screen changes. Naming each step costs nothing and turns
 * "it froze" into "it is fetching 14,318 parcels".
 *
 * Pair every call with a yieldToPaint() — assigning textContent inside a
 * synchronous block paints nothing, because the browser never gets the
 * thread back to do it.
 */
function setResultsProgress(text) {
  const bar = document.getElementById('results-status');
  if (!bar) return;
  bar.hidden = !text;
  bar.textContent = text || '';
  bar.classList.remove('results-status-error');
  bar.classList.toggle('results-status-busy', !!text);
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
  const pucsSelected = pucsFilter.getSelected();
  if (pucsSelected != null) {
    visibleSales = visibleSales.filter((s) => pucsSelected.has(s.useCode || '(blank)'));
  }
  // Sale-date range. CSV dates are ISO YYYY-MM-DD so lexical >= / <=
  // comparison works without parsing.
  const dateFrom = (document.getElementById('sales-date-from')?.value || '').trim();
  const dateTo   = (document.getElementById('sales-date-to')?.value || '').trim();
  if (dateFrom) visibleSales = visibleSales.filter((s) => s.saleDate && s.saleDate >= dateFrom);
  if (dateTo)   visibleSales = visibleSales.filter((s) => s.saleDate && s.saleDate <= dateTo);

  // Lot-size range + street name (lib/salesFilters.js, unit-tested).
  // Applied here, pre-join, for the same reason the date and PUCS
  // filters are: every row removed is a roll that never has to be
  // fetched from d4mq-wa44. Size measures the SALE's total land, not
  // the parcel's — the same denominator $/Lot SF uses — so a
  // multi-parcel sale passes or fails as one transaction.
  const sizeLo = parseBound(document.getElementById('sales-size-low')?.value);
  const sizeHi = parseBound(document.getElementById('sales-size-high')?.value);
  const sizeActive = sizeLo != null || sizeHi != null;
  if (sizeActive) {
    visibleSales = visibleSales.filter(
      (s) => passesSizeFilter(s, salesData.groups, sizeLo, sizeHi)
    );
  }
  const streetQuery = normalizeStreetQuery(document.getElementById('sales-street-name')?.value);
  if (streetQuery) {
    visibleSales = visibleSales.filter((s) => passesStreetFilter(s, streetQuery));
  }

  // Sale price — the whole transaction's consideration, so a
  // multi-parcel sale is tested once as one deal rather than per lot.
  const priceLo = parseBound(document.getElementById('sales-price-low')?.value);
  const priceHi = parseBound(document.getElementById('sales-price-high')?.value);
  const priceActive = priceLo != null || priceHi != null;
  if (priceActive) {
    visibleSales = visibleSales.filter((s) => passesPriceFilter(s, priceLo, priceHi));
  }

  // N1 crosswalk status. Row-level (one record per roll+instrument), so
  // a multi-parcel sale matched on some rolls only keeps exactly its
  // unmatched rows — those ARE the data-entry queue being asked for.
  // Pre-join like the rest: every filtered row is a roll never fetched.
  const n1Mode = document.getElementById('sales-n1-filter')?.value || 'any';
  if (n1Mode !== 'any') {
    visibleSales = visibleSales.filter((s) => (n1Mode === 'matched' ? !!s.n1Id : !s.n1Id));
  }


  if (!visibleSales.length) {
    let msg;
    if (pucsFilter.isEmptySelection()) {
      msg = `No PUCS selected — click All in the PUCS popover, or pick one or more codes.`;
    } else if (streetQuery) {
      // Named before the ranges because a typo'd street is the most
      // likely cause of an unexpectedly empty grid, and the least
      // likely for the user to spot in a one-line text box.
      msg = `${salesData.sales.length} sales loaded, but none have an address containing "${streetQuery}".`;
    } else if (priceActive) {
      msg = `${salesData.sales.length} sales loaded, but none fall inside the sale-price range `
          + `($0 / $1 nominal transfers have no price to test and are excluded while it's set).`;
    } else if (sizeActive) {
      // Says WHY a row can fail, because "missing = excluded" is not
      // guessable: a sale whose CSV rows carry no Land Actual sqft
      // has no size to test and drops out silently otherwise.
      msg = `${salesData.sales.length} sales loaded, but none fall inside the lot-size range `
          + `(sales missing Land Actual sqft can't be measured and are excluded while it's set).`;
    } else if (n1Mode !== 'any') {
      msg = `${salesData.sales.length} sales loaded, but none are N1-${n1Mode}. `
          + `CSVs without an N1 ID column read as entirely unmatched.`;
    } else if (dateFrom || dateTo) {
      msg = `${salesData.sales.length} sales loaded, but none fall inside the selected date range.`;
    } else if (pucsSelected) {
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
    setResultsProgress(`Fetching ${distinctRolls.length.toLocaleString('en-CA')} assessment record${distinctRolls.length === 1 ? '' : 's'}…`);
    await yieldToPaint();
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

  // Demolition-permit evidence. Non-fatal like the cluster lookup: if
  // the permit table can't be fetched the columns stay blank rather
  // than taking the analysis down. Matched on the CSV's own street
  // number + name, so it works whether or not the roll found a live
  // record — the permit table has no roll number to join on anyway.
  // Whether the permit evidence actually arrived. The category below is
  // only as good as this: with no verdicts, saleCategory falls through to
  // the roll's raw opinion and every finished house sold on a vacant-coded
  // lot stays in Land. The Demo and Built columns going blank is honest —
  // an empty cell claims nothing — but Category would go on ASSERTING
  // "Land", which is a positive statement that is false. Measured, the
  // difference is 6,736 Land rows against 12,889, and $30.11/lot SF
  // against $40.58. So it has to be said out loud, not warned to a console
  // nobody has open.
  let permitsOk = false;
  try {
    // Both permit sets in parallel — they answer opposite halves of one
    // question (did this sale include a building?), and neither is worth
    // a round trip on its own.
    setResultsProgress('Checking demolition and new-construction permits…');
    await yieldToPaint();
    const [demoRows, buildRows] = await Promise.all([fetchDemoPermits(), fetchBuildPermits()]);
    const demoIndex = buildPermitIndex(demoRows);
    const buildIndex = buildPermitIndex(buildRows);
    for (const f of saleFc.features) {
      const p = f.properties;
      const at = {
        streetNumber: p._saleStreetNumber,
        streetName: p._saleStreetName,
        saleDate: p._saleDate,
      };
      // Two different questions, deliberately kept apart. demoVerdict asks
      // "did the ASSESSOR call this vacant" -- a surface parking lot is
      // emphatically not vacant, and a demolition permit on one is a real
      // teardown finding. buildVerdict asks "is this sale in the LAND SET",
      // which is wider by exactly one code (CMPSP). Collapsing them would
      // silently turn 17 teardown findings into confirmations.
      const vacant = isVacantUseCode(saleUseCodeOf(f));
      const landSet = isLandSetUseCode(saleUseCodeOf(f));

      const demoHit = findNearestPermit(at, demoIndex);
      if (demoHit) {
        const verdict = demoVerdict(demoHit, vacant);
        p._demoDate = demoHit.date;
        p._demoSide = demoHit.side;
        p._demoVerdict = verdict;
        p._demoTitle = describeDemoPermit(demoHit, verdict);
      }

      // Three years either side, wider than the demolition window: a
      // permit 18+ months before a sale still reads as a finished house
      // (median $424k in Jason's archive), so a two-year window would
      // miss the oldest of exactly the rows this is meant to catch.
      const buildHit = findNearestPermit(at, buildIndex, 3 * 365);
      const buildJudgement = buildVerdict(buildHit, landSet);
      if (buildJudgement) {
        p._buildDate = buildHit.date;
        p._buildVerdict = buildJudgement;
        p._buildEvidence = 'permit';
        p._buildTitle = describeBuildPermit(buildHit, buildJudgement);
      }
    }
    permitsOk = true;
  } catch (err) {
    console.warn('Permit lookup failed (Demo / Built columns stay blank):', err);
  }

  // Second instrument, and OUTSIDE the try above on purpose: the roll's
  // own year_built needs no network call, so a Socrata outage that costs
  // us the permits must not also cost us this.
  //
  // Consulted only where the permit pass said nothing. A permit is dated
  // evidence about the transaction; this is a later snapshot read
  // backwards, and where they disagree the dated one wins — including
  // 'land-then-built', which is a permit positively saying the lot was
  // bare, and must not be overturned by a roll that only knows the
  // parcel as it stands today.
  //
  // Catches 37 sales the permit window structurally cannot: houses built
  // 2014-2024 and sold up to twelve years later, and pre-war houses that
  // predate it4w-cpf4's 2016 start. lib/permitEvidence.js carries the
  // measurement.
  for (const f of saleFc.features) {
    const p = f.properties;
    if (p._buildVerdict) continue;
    const rollJudgement = rollBuildVerdict({
      saleIsVacant: isLandSetUseCode(saleUseCodeOf(f)),
      hasLiveRecord: !p._noLiveMatch,
      yearBuilt: p.year_built,
      livingArea: p.total_living_area,
      saleDate: p._saleDate,
    });
    if (!rollJudgement) continue;
    p._buildVerdict = rollJudgement;
    p._buildEvidence = 'roll';
    p._buildTitle = describeRollBuilt({
      yearBuilt: p.year_built,
      livingArea: p.total_living_area,
      saleDate: p._saleDate,
    });
  }

  // Third instrument, ordered last and outside the try for the same
  // reason: SABRE's export carries the parcel's OWN living area and year
  // built, and that record survives the roll's retirement. It is the
  // only thing that can speak for the 79 vacant-coded sales matching no
  // live assessment record — those rolls are retired, not merely missing
  // from a stale snapshot; 71 of the 72 are absent from the LIVE
  // d4mq-wa44 too.
  //
  // Reaches 30 sales — 3 of which the teardown tiebreak below then holds
  // back, leaving 27: 6 of those 79, and 24 that DO have a live record
  // but where the roll cannot contradict, because the building stood at
  // the sale and has been demolished since. Positive evidence only — a
  // blank living area here means "not populated", never "no building",
  // and a 1 sf one is a placeholder MIN_PLAUSIBLE_LIVING_SF rejects.
  // lib/permitEvidence.js carries the measurement.
  for (const f of saleFc.features) {
    const p = f.properties;
    if (p._buildVerdict) continue;
    // STRICT vacant test here, unlike the permit and roll passes above.
    //
    // SABRE's building fields are not trustworthy on a surface-parking
    // row, and the evidence is overwhelming: of the 17 CMPSP sales, 11
    // carry a 1 sf placeholder and the other 6 carry figures the live
    // roll flatly contradicts -- 165 FORT reporting 120,126 sf of
    // building on a 34,305 sf lot, PIONEER 110,140 sf on 10,271, while
    // d4mq-wa44 shows those parcels with NO year built and NO living
    // area at all. Widening this gate reclassified all 6 out of Land on
    // that alone.
    //
    // The permit and roll passes are widened because their evidence is
    // sound for parking: a construction permit at the address is dated
    // fact, and the roll is the very source that contradicts SABRE here.
    // This one is not, so it keeps the narrow gate. "Only reclassify if
    // obvious or a permit says so" -- and a figure the roll denies is
    // the opposite of obvious.
    const sabreJudgement = sabreBuildVerdict({
      saleIsVacant: isVacantUseCode(saleUseCodeOf(f)),
      yearBuilt: p._saleYearBuiltNumeric,
      livingArea: p._saleLivingArea,
      saleDate: p._saleDate,
    });
    if (!sabreJudgement) continue;
    p._buildVerdict = sabreJudgement;
    p._buildEvidence = 'sabre';
    p._buildTitle = describeSabreBuilt({
      yearBuilt: p._saleYearBuiltNumeric,
      livingArea: p._saleLivingArea,
      saleDate: p._saleDate,
      hasLiveRecord: !p._noLiveMatch,
    });
  }

  // JASON'S OWN VERDICTS, applied before the price tiebreak and before
  // saleCategory so everything downstream recomputes from the corrected
  // state -- including resolveMixedSales, which re-reads the group. Two
  // of these un-mix a sale and return a SIBLING parcel to Land as a
  // side effect; forcing the category instead would have fixed one row
  // and left its sibling wrong.
  //
  // Only ever rewrites an INFERRED verdict. A permit is dated evidence
  // about the transaction and is not overridden from a list.
  //
  // lib/saleJudgements.js carries the reasoning. The short version: on
  // 2026-08-22 the top-end review put rows of identical shape in front
  // of Jason -- SABRE reporting a building, live roll reporting none --
  // and he split them from knowledge of the properties. Nothing in the
  // data separates them.
  for (const f of saleFc.features) {
    const p = f.properties;
    if (p._buildVerdict !== 'already-built') continue;
    if (p._buildEvidence !== 'roll' && p._buildEvidence !== 'sabre') continue;
    const judged = judgedVerdict(p.roll_number);
    if (judged === undefined) continue;
    const j = saleJudgement(p.roll_number);
    p._buildVerdict = judged;          // null drops it, a string downgrades it
    p._judged = true;
    p._judgedTitle = `${j.note} (Jason, ${j.decided})`;
    if (judged === null) { p._buildEvidence = null; p._buildTitle = null; }
    else { p._buildTitle = p._judgedTitle; }
  }

  // The teardown tiebreak, and the reason it sits AFTER both inferred
  // passes and never touches the permit one.
  //
  // demoVerdict already calls "a building stood here and was worthless"
  // a LAND sale — that is the definition of a teardown. The roll and
  // SABRE call the same fact disqualifying, because all they know is
  // that a building existed. Where a permit exists the two never
  // collide; where none does, the same transaction gets opposite answers
  // depending on whether it4w-cpf4 reaches back far enough, which for a
  // pre-war house it never does.
  //
  // So: only reclassify where it is obvious or a permit says so. Where
  // the price says the building was worth nothing, hold the verdict
  // back — the row STAYS in Land and carries a mark instead. 6 sales,
  // 3 from each inferred instrument: 570 BALMORAL ($32/bldg sf), 294
  // CHARLES ($35), 511 WILLIAM ($38), 431 LANGSIDE ($42), 488 SHERBROOK
  // ($28) and one unaddressed 1914 row ($23), against $174 for an
  // ordinary improved sale. Land 6,709 -> 6,715.
  //
  // A PERMIT VERDICT IS NEVER SECOND-GUESSED. Price is a weaker
  // instrument than a dated permit at the address, and 'already-built'
  // from a permit is the obvious case this rule exists to preserve.
  for (const f of saleFc.features) {
    const p = f.properties;
    if (p._buildVerdict !== 'already-built') continue;
    if (p._buildEvidence !== 'roll' && p._buildEvidence !== 'sabre') continue;
    const area = p._buildEvidence === 'roll' ? p.total_living_area : p._saleLivingArea;
    const year = p._buildEvidence === 'roll' ? p.year_built : p._saleYearBuiltNumeric;
    if (!pricedAsLand({
      salePrice: p._salePrice, livingArea: area, groupSize: p._saleGroupSize,
    })) continue;
    // Deliberately NOT 'already-built': saleCategory only acts on that
    // value, so this leaves the row in Land, which is the whole point.
    p._buildVerdict = 'built-priced-as-land';
    p._buildTitle = describePricedAsLand({
      yearBuilt: year, livingArea: area, saleDate: p._saleDate, salePrice: p._salePrice,
    });
  }

  // What is left after all three: a vacant-coded sale with no live roll
  // record and no verdict from anything. 73 of them, and they must not
  // read as vetted land comps — a blank Built cell otherwise means the
  // same thing here as it does on the 642 sales the roll positively
  // confirms bare, which are two completely different states.
  //
  // They STAY in Land. Their price signature is squarely land — median
  // $24.71 per lot square foot against the Land set's $30.14, p75 $43.60
  // against $37.84, and 3 of 70 above the Land p95 — and pulling 73 rows
  // out of a comp set for want of a check is a different act from
  // pulling the 37 that were positively contradicted. The marker says
  // "nobody could ask", not "this is improved".
  //
  // The second sentence of the tooltip is the one that matters most:
  // 49 of the 79 carry no street number AND name, so permitAddressKey
  // returns '' and the permit lookup never ran at all. On those rows
  // "no permit found" is a question that failed, not an answer.
  for (const f of saleFc.features) {
    const p = f.properties;
    if (p._buildVerdict || !p._noLiveMatch) continue;
    if (!isLandSetUseCode(saleUseCodeOf(f))) continue;
    const askable = !!(String(p._saleStreetNumber ?? '').trim()
      && String(p._saleStreetName ?? '').trim());
    // Checked, not assumed. Today all 73 have a blank SABRE living area,
    // but a row could reach here carrying one — an area with no year, or
    // a year at or after the sale — and a tooltip that flatly said "SABRE
    // reports no building" would then be stating something false about
    // the row it is attached to.
    const sabreBlank = !(Number(p._saleLivingArea) > 0);
    p._buildUnjudged = true;
    p._buildUnjudgedTitle = `This roll is not on the assessment roll — it has been RETIRED, `
      + `which is what happens when a parcel is subdivided or consolidated after it sells. `
      + (askable
        ? `No construction permit was found at this address within three years either way, and `
          + `with no live record the roll cannot be asked either.`
        : `The sale carries no usable street number and name, so the permit table could not even `
          + `be queried — "no permit" here is a question that failed, not an answer.`)
      + (sabreBlank
        ? ` SABRE reports no building on the parcel, but it almost never does on a vacant-coded `
          + `row, so that is not evidence of bareness.`
        : ` SABRE reports a building, but not one that can be dated before the sale, so it `
          + `settles nothing either way.`)
      + ` NOTHING has verified this sale bought bare land. It is still counted as Land, and its `
      + `rate sits with the rest of the Land set, but confirm it yourself before putting it in a `
      + `report.`;
  }

  // Appraisal category, stamped AFTER the permit pass because the permit
  // record is what overrules the roll: a vacant-coded sale whose house was
  // finished before it changed hands is not a land comp, and an improved
  // sale with a demolition permit beside it is. lib/pucs.js owns the
  // mapping and the fallbacks; this only supplies the three inputs.
  //
  // The live use code is withheld on a row that matched no live record —
  // the feature is synthetic there, so property_use_code would be absent
  // anyway, but passing it explicitly as null keeps the intent readable.
  for (const f of saleFc.features) {
    const p = f.properties;
    p._saleCategory = saleCategory({
      saleUseCode: saleUseCodeOf(f),
      liveUseCode: p._noLiveMatch ? null : p.property_use_code,
      buildVerdict: p._buildVerdict,
      demoVerdict: p._demoVerdict,
    });
  }

  // A transaction is ONE deal, so a sale that mixed land and improvements
  // is an improved sale in all of its rows. Runs AFTER the per-row
  // categories because it reads them: a teardown assembly has already
  // been pulled to Land on both sides and correctly does not register as
  // mixed, while a group whose only improved parcel was found by an
  // instrument rather than by its use code does. lib/salesFilters.js
  // carries the measurement -- 16 groups, 34 rows.
  //
  // THE LAND-DENOMINATED RATES ARE WITHHELD, not just marked. $/Lot SF,
  // $/Acre and $/Lot all divide the WHOLE consideration by a land-side
  // denominator, and on a mixed sale part of that consideration bought
  // buildings. 5650563 is the case that decides it: a $6,650,000
  // VINDU + INWWH deal reading $16.63 per lot square foot. That is not a
  // land rate, it is arithmetic, and an appraiser could lift it into a
  // report. $/Bldg SF stays -- the sale IS improved, so that is now the
  // meaningful figure. Same principle as parcelLandSf withholding every
  // rate rather than pricing on a placeholder: a blank claims nothing.
  const { force: mixedCategory, mixed: mixedSales } = resolveMixedSales(saleFc.features);
  for (const f of saleFc.features) {
    const p = f.properties;
    const key = String(p._saleInstrument ?? '');
    // A sale SABRE mis-measured gets its rates REBUILT, not withheld.
    // 165 PROVENCHER assembled five parcels; SABRE linked one and gave it
    // 4,044 sf, which is a DIFFERENT parcel's area -- its own is 12,111.
    // The published rate read $865.48 per lot square foot against a real
    // $127.63, high by 6.8x. The corrected area comes from the
    // wpg-parcel-history snapshot dated two weeks before the sale, so it
    // is a sourced figure rather than an estimate, and an appraiser can
    // use $127.63 where they could not use a blank.
    const assembly = judgedAssembly(p.roll_number);
    if (assembly && p._salePrice) {
      p._pricePerSf = p._salePrice / assembly.landSf;
      p._saleAcres = assembly.landSf / 43560;
      p._pricePerAcre = p._salePrice / p._saleAcres;
      p._pricePerLot = p._salePrice / assembly.parcels;
      p._assemblyCorrected = true;
      const j = saleJudgement(p.roll_number);
      p._assemblyTitle = `${j.note} (Jason, ${j.decided})`;
    }
    if (!mixedSales.has(key)) continue;
    p._mixedSale = true;
    const forced = mixedCategory.get(key);
    if (forced) p._saleCategory = forced;
    p._pricePerSf = null;
    p._pricePerAcre = null;
    p._pricePerLot = null;
    p._mixedSaleTitle = `This sale included ${forced ? `an improved ${forced} parcel` : 'improved parcels'} `
      + `alongside land, so the whole transaction is an improved sale rather than a land comp. `
      + `$/Lot SF, $/Acre and $/Lot are withheld: they divide the entire price by a land-side `
      + `denominator, and part of this price bought buildings.`;
  }

  // Neighbourhood cluster, from the parcel centroid. Non-fatal: if the
  // geojson can't be fetched the column just stays blank rather than
  // taking the whole analysis down with it.
  try {
    setResultsProgress('Assigning neighbourhoods…');
    await yieldToPaint();
    const index = await clusterIndex();
    if (index) {
      for (const f of saleFc.features) {
        f.properties._cluster = clusterForFeature(index, f) || '';
      }
    }
  } catch (err) {
    console.warn('Cluster lookup failed (Cluster column stays blank):', err);
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

  // Assessment class. Unlike PUCS this can only run HERE: the class
  // lives on the live record, so it doesn't exist until the roll lookup
  // above has resolved. Options are tallied from the full joined set
  // (before narrowing) so unticking a class never removes it from the
  // list the user needs in order to tick it back on.
  // Category first: it is the coarsest cut and the one that narrows most.
  // Note the pickers BELOW it are still built from the full joined set,
  // not from what Category left — that is deliberate and must stay:
  // tallying a picker from its own filtered output shrinks its option list
  // on every change, and the user could never tick back what they
  // unticked.
  rebuildCategoryFilter(saleFc.features);
  const categorySelected = categoryFilter.getSelected();
  const afterCategory = categorySelected == null
    ? saleFc.features
    : saleFc.features.filter((f) => categorySelected.has(saleCategoryOf(f)));
  const categoryHidden = saleFc.features.length - afterCategory.length;

  rebuildClassFilter(saleFc.features);
  const classSelected = classFilter.getSelected();
  const afterClass = classSelected == null
    ? afterCategory
    : afterCategory.filter((f) => classSelected.has(saleClassOf(f)));
  const classHidden = afterCategory.length - afterClass.length;

  // Zoning. Options come off the FULL joined set (like Class) so
  // unticking a code never removes it from the list you need in order to
  // tick it back on. Applied after Class so the two narrow together.
  rebuildZoningFilter(saleFc.features);
  const zoningSelected = zoningFilter.getSelected();
  const visibleFeatures = zoningSelected == null
    ? afterClass
    : afterClass.filter((f) => passesZoningFilter(f, zoningSelected, stripZoningCode));
  const zoningHidden = afterClass.length - visibleFeatures.length;

  // Vacant / improved, from the assessor's use code. Judged per SALE so
  // every parcel of a multi-parcel transaction passes or fails together
  // — one improved parcel makes the whole thing an improved sale.
  //
  // Judged over saleFc.features, NOT over what the pickers above left
  // standing. A group property has to be measured on the whole
  // transaction: the Category filter can remove the one improved parcel
  // of a land assembly, and reading vacancy off the survivors would then
  // flip that sale from improved to vacant — reporting a land-and-house
  // assembly as a clean vacant sale while its rows still carry a $/Lot SF
  // computed over all three parcels and the whole price. Class and zoning
  // could do the same in principle; they just never split on this axis.
  const vacantMode = document.getElementById('vacant-improved')?.value || 'all';
  const vacancyByGroup = groupVacancy(saleFc.features);
  const afterVacant = vacantMode === 'all'
    ? visibleFeatures
    : visibleFeatures.filter((f) => passesVacantFilter(f, vacantMode, vacancyByGroup));
  const vacantHidden = visibleFeatures.length - afterVacant.length;

  // Far-flung. The threshold MARKS; only the Exclude tick removes. The
  // span is a group property, so a flagged sale drops whole — never
  // part of one, which would silently corrupt its $/Lot SF.
  const farFlungRaw = parseFloat(document.getElementById('far-flung-km')?.value ?? '');
  const farFlungKm = Number.isFinite(farFlungRaw) && farFlungRaw > 0 ? farFlungRaw : null;
  const farFlungExclude = !!document.getElementById('far-flung-exclude')?.checked;
  // Same reason as vacancy: measured over the whole transaction. Drop the
  // far member of a scattered assembly with a Category tick and the span
  // collapses, clearing the very flag this exists to raise — and _farFlung
  // rides to the charts page, where "Drop far-flung" is on by default.
  const spanByGroup = groupSpreadKm(saleFc.features, featureCentroid, haversineKm);
  for (const f of afterVacant) {
    const span = spanByGroup.get(String(f.properties._saleInstrument ?? ''));
    f.properties._saleGroupSpanKm = span;
    f.properties._farFlung = isFarFlung(span, farFlungKm);
  }
  // Tally off the PRE-exclusion set: counting what survived would report
  // "none flagged" at the moment six sales are being hidden.
  const flaggedSales = new Set(
    afterVacant.filter((f) => f.properties._farFlung)
      .map((f) => String(f.properties._saleInstrument ?? ''))
  ).size;
  const finalFeatures = farFlungKm != null && farFlungExclude
    ? afterVacant.filter((f) => !f.properties._farFlung)
    : afterVacant;
  const farFlungHidden = afterVacant.length - finalFeatures.length;
  updateFarFlungCount(flaggedSales, farFlungKm, farFlungExclude);

  const teardownCount = finalFeatures.filter((f) => f.properties._demoVerdict === 'teardown').length;
  const alreadyBuiltCount = finalFeatures.filter((f) => f.properties._buildVerdict === 'already-built').length;
  // Split out because the three are not equally strong. A permit is
  // dated evidence about the transaction; the roll is a later snapshot
  // of the same parcel; SABRE's is the export's own attribute with
  // nothing pinning it to the sale date. An appraiser weighing one of
  // these rows is entitled to know which one they have without opening
  // the tooltip.
  const builtBy = (evidence) => finalFeatures.filter((f) => (
    f.properties._buildVerdict === 'already-built' && f.properties._buildEvidence === evidence
  )).length;
  const rollBuiltCount = builtBy('roll');
  const sabreBuiltCount = builtBy('sabre');
  const inferredBuiltParts = [
    rollBuiltCount ? `${rollBuiltCount} from the roll's year built` : '',
    sabreBuiltCount ? `${sabreBuiltCount} from SABRE's own record` : '',
  ].filter(Boolean);
  // Vacant-coded, roll retired, no instrument could answer. Named here
  // for the same reason the teardowns are: it is invisible unless the
  // Built column happens to be on screen, and it is the difference
  // between a land comp that was checked and one that merely wasn't
  // contradicted. Quiet — an absence of evidence is not a finding.
  const unverifiedCount = finalFeatures.filter((f) => f.properties._buildUnjudged).length;
  // Held back rather than acted on: a building was found, the price says
  // it was worth nothing, and the row stays in Land. Named because it is
  // the only ⚠ finding that leaves the comp set unchanged — silence here
  // would read as "nothing found" when something was.
  const pricedAsLandCount = finalFeatures.filter((f) => (
    f.properties._buildVerdict === 'built-priced-as-land'
  )).length;
  const rows = finalFeatures.map((f) => ({ assess: f, survey: null }));
  const unmatched = rows.filter((r) => r.assess.properties._noLiveMatch).length;
  // Counted off the SHOWN rows rather than liveByRoll, which spans the
  // whole pre-class-filter set — subtracting it once the class filter
  // has narrowed things would understate (and could go negative).
  const matchedRows = rows.filter((r) => !r.assess.properties._noLiveMatch);
  const distinctShownRolls = new Set(matchedRows.map((r) => r.assess.properties.roll_number)).size;
  const repeatSales = matchedRows.length - distinctShownRolls;
  setSalesCount(
    `${rows.length} sale${rows.length === 1 ? '' : 's'} shown` +
    (repeatSales > 0 ? ` · ${repeatSales} repeat sale${repeatSales === 1 ? '' : 's'} of the same parcel` : '') +
    (unmatched ? ` · ${unmatched} not in d4mq-wa44` : '') +
    // Rows with no Parcel ID or no Instrument Number can't be placed or
    // grouped, so they never enter the analysis. Saying so matters: the
    // instrument identifies the transaction, and a blank one silently
    // removes a whole sale from the comp set.
    (salesData?.dropped
      ? ` · ${salesData.dropped} row${salesData.dropped === 1 ? '' : 's'} skipped (no Parcel ID / Instrument Number)`
      : '') +
    (hiddenWithSworn
      ? ` · ${hiddenWithSworn} $0/$1 transfer${hiddenWithSworn === 1 ? '' : 's'} hidden despite a sworn value — untick the filter to inspect`
      : '') +
    // Name the class narrowing for the same reason the area filter is
    // named: a filter the user can forget they set must never silently
    // shrink the comp set.
    // Loudest clause in the line, because it invalidates the column an
    // appraiser is about to build a land comp set from.
    // Still said, and still says the same thing in substance: both
    // fallbacks need no network and survive this, but between them they
    // account for 61 of 6,299 already-built findings. Losing the permits
    // loses essentially all of them.
    (permitsOk ? '' : " · ⚠ PERMIT CHECK FAILED — only the roll's and SABRE's own year built are judging, which catches a small fraction, so already-built houses are still counted as Land") +
    (categoryHidden ? ` · ${categoryHidden} hidden by the category filter` : '') +
    (classHidden ? ` · ${classHidden} hidden by the class filter` : '') +
    (zoningHidden ? ` · ${zoningHidden} hidden by the zoning filter` : '') +
    (vacantHidden ? ` · ${vacantHidden} hidden by the ${vacantMode} filter` : '') +
    (farFlungHidden ? ` · ${farFlungHidden} far-flung excluded` : '') +
    // Named explicitly because this is the finding the columns exist to
    // surface, and it is invisible unless the Demo column happens to be
    // on screen: an improved-coded sale with a demolition permit beside
    // it is a land sale in disguise.
    (teardownCount
      ? ` · ⚠ ${teardownCount} teardown${teardownCount === 1 ? '' : 's'} (improved code + demo permit)`
      : '') +
    // The mirror finding, and the bigger one in practice: vacant-coded
    // sales that already had a finished house standing on them.
    (alreadyBuiltCount
      ? ` · ⚠ ${alreadyBuiltCount} vacant-coded sale${alreadyBuiltCount === 1 ? '' : 's'} already built on`
        + (inferredBuiltParts.length
          ? ` (${inferredBuiltParts.join(' and ')}, not a permit — confirm before using)`
          : '')
      : '') +
    // Last, and deliberately after the findings: this one asserts
    // nothing about the parcels, only about how much is known.
    (pricedAsLandCount
      ? ` · ⚠ ${pricedAsLandCount} kept in Land with a building on ${pricedAsLandCount === 1 ? 'it' : 'them'}`
        + ` (price says the building was worth nothing — check before using)`
      : '') +
    (unverifiedCount
      ? ` · ${unverifiedCount} land sale${unverifiedCount === 1 ? '' : 's'} not verified (roll retired, no instrument could answer)`
      : '')
  );

  // Draw matched parcels on the map. Repeat sales share one polygon;
  // setParcels' geometry-hash dedupe draws it once.
  const mappable = {
    type: 'FeatureCollection',
    features: finalFeatures.filter((f) => f.geometry),
  };
  setParcels(EMPTY_FC, mappable);

  setResultsProgress(`Drawing ${rows.length.toLocaleString('en-CA')} row${rows.length === 1 ? '' : 's'}…`);
  await yieldToPaint();
  renderTable(rows);
  // renderSalesCount repaints the bar with the finished tally, which
  // also clears the busy state — the progress line must not outlive the
  // work it describes.
  renderSalesCount();
  publishSalesToCharts(rows);
}

// Neighbourhood-cluster index, built once from the committed
// wpg-neighbourhoods.geojson (soda.js caches the fetch, and the
// historical overlay already loads the same file, so this costs no
// extra download). Null on failure so callers can degrade to a blank
// Cluster column.
let _clusterIndex = null;
async function clusterIndex() {
  if (_clusterIndex) return _clusterIndex;
  const fc = await fetchNeighbourhoods();
  _clusterIndex = buildClusterIndex(fc);
  return _clusterIndex;
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

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

import {
  searchSurveyParcels,
  fetchAssessmentOverlap,
  joinSurveyWithAssessment,
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
} from './soda.js';
import {
  initMap, showResults, setZoningData, setZoningVisible, flyToFeature,
  setOverlayData, setOverlayVisible, setCivicAddresses,
} from './map.js';

const $lot = document.getElementById('lot');
const $block = document.getElementById('block');
const $plan = document.getElementById('plan');
const $desc = document.getElementById('desc');
const $roll = document.getElementById('roll');
const $address = document.getElementById('address');
const $zoning = document.getElementById('zoning');
const $duMode = document.getElementById('du-mode');
const $duMin = document.getElementById('du-min');
const $search = document.getElementById('search');
const $clear = document.getElementById('clear');
const $export = document.getElementById('export');
const $zoningToggle = document.getElementById('zoning-toggle');
const $surveyToggle = document.getElementById('survey-toggle');
const $assessToggle = document.getElementById('assess-toggle');
const $secondaryPlansToggle = document.getElementById('secondary-plans-toggle');
const $infillToggle         = document.getElementById('infill-toggle');
const $mallsCorridorsToggle = document.getElementById('malls-corridors-toggle');
const $count = document.getElementById('count');
const $tbody = document.querySelector('#results tbody');
const $mapEl = document.getElementById('map');
const $staticMapBtn = document.getElementById('static-map-btn');
const $staticMapOutput = document.getElementById('static-map-output');
const $legend = document.getElementById('map-legend');

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
$surveyToggle.addEventListener('click', () => toggleLayer('survey'));
$assessToggle.addEventListener('click', () => toggleLayer('assess'));
$secondaryPlansToggle.addEventListener('click', () => togglePolicyOverlay('secondaryPlans'));
$infillToggle.addEventListener('click',         () => togglePolicyOverlay('infill'));
$mallsCorridorsToggle.addEventListener('click', () => togglePolicyOverlay('mallsCorridors'));
if ($staticMapBtn) $staticMapBtn.addEventListener('click', generateStaticMap);
for (const el of [$lot, $block, $plan, $desc, $roll, $address, $zoning, $duMin]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
}

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
  });
}

async function runSearch() {
  const inputs = {
    lot: $lot.value.trim(),
    block: $block.value.trim(),
    plan: $plan.value.trim(),
    desc: $desc.value.trim(),
    roll: $roll.value.trim(),
    address: $address.value.trim(),
    zoning: $zoning.value.trim(),
    // DU filter: 'zero' = vacant lots only, 'min' = ≥ N units, '' = no filter.
    // The minimum is captured separately so it persists across mode swaps.
    duMode: $duMode.value,
    duMin: parseInt($duMin.value, 10) || null,
  };

  const anyLegal = inputs.lot || inputs.block || inputs.plan || inputs.desc;
  const anyDu = inputs.duMode === 'zero' || (inputs.duMode === 'min' && inputs.duMin > 0);
  const anyAssess = inputs.roll || inputs.address || inputs.zoning || anyDu;

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
  // Toggle the floating colour legend — hidden on an empty map.
  if ($legend) $legend.hidden = lastParcelFc.features.length === 0;
  mapReady.then(() => {
    showResults(map, surveyFc, assessFc);
    refreshZoning();
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
  const labelOff = which === 'survey' ? 'Show Survey' : 'Show Assessment';
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
  if (zoningEnabled) {
    // First-load shows a loading state because the citywide fetch is
    // ~10-15s on a cold IndexedDB cache. Subsequent toggles within
    // the 7-day TTL read from disk and resolve in a few hundred ms.
    $zoningToggle.disabled = true;
    $zoningToggle.textContent = 'Loading zoning…';
    try {
      await refreshZoning();
      $zoningToggle.textContent = 'Hide Zoning';
    } catch (err) {
      console.warn('zoning toggle failed', err);
      // Roll the toggle back so the user can retry.
      zoningEnabled = false;
      $zoningToggle.classList.remove('active');
      $zoningToggle.setAttribute('aria-pressed', 'false');
      $zoningToggle.textContent = 'Show Zoning';
      setZoningVisible(map, false);
    } finally {
      $zoningToggle.disabled = false;
    }
  } else {
    $zoningToggle.textContent = 'Show Zoning';
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
 * `name` is one of 'secondaryPlans' / 'infill' / 'mallsCorridors'.
 */
const POLICY_OVERLAY_CONFIG = {
  secondaryPlans: {
    btn:    () => $secondaryPlansToggle,
    src:    'secondary-plans',
    fetch:  fetchSecondaryPlans,
    onLabel:  'Hide Secondary Plans',
    offLabel: 'Show Secondary Plans',
  },
  infill: {
    btn:    () => $infillToggle,
    src:    'infill-guideline',
    fetch:  fetchInfillGuidelineArea,
    onLabel:  'Hide Infill Area',
    offLabel: 'Show Infill Area',
  },
  mallsCorridors: {
    btn:    () => $mallsCorridorsToggle,
    src:    'malls-corridors',
    fetch:  fetchMallsAndCorridors,
    onLabel:  'Hide Malls/Corridors',
    offLabel: 'Show Malls/Corridors',
  },
};

const policyOverlayState = {
  secondaryPlans: { enabled: false, loaded: false },
  infill:         { enabled: false, loaded: false },
  mallsCorridors: { enabled: false, loaded: false },
};

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

  const countMsg = n === 1000
    ? '1000 parcels found (limit reached — refine your search)'
    : `${n} parcels found`;
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
  if (n === 0) {
    setCount('No parcels found.');
    setParcels(EMPTY_FC, EMPTY_FC);
    return;
  }

  // Stamp a row key onto each feature so clicking on the map can jump
  // straight to the matching row. In this flow the map is drawn from
  // Assessment Parcels, so we key on assess.roll_number.
  tagFeatures(assessFc, 'assess');

  const countMsg = n === 1000
    ? '1000 parcels found (limit reached — refine your search)'
    : `${n} parcels found`;
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
  window.location.reload();
}

function clearTable() {
  $tbody.innerHTML = '';
  currentRows = [];
  setExportEnabled(false);
}

function renderTable(rows) {
  $tbody.innerHTML = '';
  currentRows = rows;
  rowFeatureMap.clear();
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
  for (const row of sorted) {
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
    });
    tr.appendChild(td(s.lot));
    tr.appendChild(td(s.block));
    tr.appendChild(td(s.plan));
    tr.appendChild(td(s.description));
    tr.appendChild(td(a.roll_number));
    tr.appendChild(td(a.full_address));
    // Prefer the area-weighted top-1 zoning code; fall back to the
    // assessment dataset's primary `zoning` text if enrichment hasn't
    // populated zoning_top1 (no overlap, fetch failed, etc.).
    tr.appendChild(td(a.zoning_top1 ?? a.zoning));
    tr.appendChild(td(formatPct(a.zoning_top1_pct), 'num'));
    tr.appendChild(td(formatZone2(a.zoning_top2, a.zoning_top2_pct)));
    tr.appendChild(td(formatArea(a.assessed_land_area), 'num'));
    tr.appendChild(td(formatCoord(a.centroid_lat), 'num'));
    tr.appendChild(td(formatCoord(a.centroid_lon), 'num'));
    tr.appendChild(assessmentTd(a));
    tr.appendChild(linkTd(walkscoreUrl(a.full_address), 'Walk'));
    tr.appendChild(linkTd(floodToolUrl(a), 'Flood'));
    frag.appendChild(tr);
  }
  $tbody.appendChild(frag);
  setExportEnabled(rows.length > 0);
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
 * Pull the City's assessment-page URL out of the parcel's `detail_url`
 * field. Socrata exposes this as a "url" type column wrapped in a
 * `{ url: "..." }` object on the JSON side; the .geojson endpoint
 * preserves the same shape. Falls back to building the URL from the
 * roll number when detail_url is absent or malformed.
 */
function assessmentUrl(props) {
  if (!props) return null;
  const raw = props.detail_url?.url || props.detail_url;
  if (typeof raw === 'string' && /^https?:\/\//i.test(raw)) return raw;
  const roll = props.roll_number;
  if (roll) {
    return `https://www.winnipegassessment.com/AsmtPub/english/propertydetails/details.aspx?pgLang=EN&isRealtySearch=true&RollNumber=${encodeURIComponent(roll)}`;
  }
  return null;
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

// Assessment land area comes in as a stringified integer of square feet.
// Render with thousands separators; hide junk values.
function formatArea(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n).toLocaleString('en-US');
}

// Winnipeg serves centroid_lat / centroid_lon as strings with way more
// precision than anyone needs. 6 decimals is ~10 cm at this latitude.
function formatCoord(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(6);
}

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
  searchAssessmentParcels,
  fetchSurveyOverlap,
  joinAssessmentWithSurvey,
} from './soda.js';
import { initMap, showResults } from './map.js';

const $lot = document.getElementById('lot');
const $block = document.getElementById('block');
const $plan = document.getElementById('plan');
const $desc = document.getElementById('desc');
const $roll = document.getElementById('roll');
const $address = document.getElementById('address');
const $zoning = document.getElementById('zoning');
const $search = document.getElementById('search');
const $clear = document.getElementById('clear');
const $export = document.getElementById('export');
const $count = document.getElementById('count');
const $tbody = document.querySelector('#results tbody');
const $mapEl = document.getElementById('map');

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// Most recent table rows, kept around for CSV export.
let currentRows = [];

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
  zoning:  (r) => strKey(r.assess?.properties?.zoning),
  area:    (r) => finiteOrNeg(r.assess?.properties?.assessed_land_area),
  lat:     (r) => finiteOrNeg(r.assess?.properties?.centroid_lat),
  lon:     (r) => finiteOrNeg(r.assess?.properties?.centroid_lon),
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
for (const el of [$lot, $block, $plan, $desc, $roll, $address, $zoning]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
}

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
  };

  const anyLegal = inputs.lot || inputs.block || inputs.plan || inputs.desc;
  const anyAssess = inputs.roll || inputs.address || inputs.zoning;

  if (!anyLegal && !anyAssess) {
    setCount('Enter at least one search field.');
    clearTable();
    mapReady.then(() => showResults(map, EMPTY_FC));
    return;
  }

  setBusy(true);
  setCount('Searching…');
  clearTable();

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
    mapReady.then(() => showResults(map, surveyFc));
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

  // Show survey-only rows in the table immediately.
  renderTable(surveyFc.features.map((f) => ({ survey: f, assess: null })));
  mapReady.then(() => showResults(map, surveyFc));

  // Enrichment: Assessment Parcels inside the survey bbox.
  let assessFc;
  try {
    assessFc = await fetchAssessmentOverlap(surveyFc);
  } catch (err) {
    console.error(err);
    setCount(`${countMsg} · enrichment failed: ${err.message}`);
    return;
  }

  renderTable(joinSurveyWithAssessment(surveyFc, assessFc));
  setCount(countMsg);
}

// ---------- Assessment-first flow (Roll # / Address / Zoning) ----------

async function runAssessmentSearch(inputs) {
  let assessFc;
  try {
    assessFc = await searchAssessmentParcels(inputs);
  } catch (err) {
    console.error(err);
    setCount(`Search failed: ${err.message}`);
    return;
  }

  const n = assessFc.features.length;
  if (n === 0) {
    setCount('No parcels found.');
    mapReady.then(() => showResults(map, assessFc));
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
  // assessment geometry directly — no survey polygon is drawn in this flow.
  renderTable(assessFc.features.map((f) => ({ survey: null, assess: f })));
  mapReady.then(() => showResults(map, assessFc));

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

  renderTable(joinAssessmentWithSurvey(assessFc, surveyFc));
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
function clearAll() {
  for (const el of [$lot, $block, $plan, $desc, $roll, $address, $zoning]) {
    el.value = '';
  }
  setCount('');
  clearTable();
  mapReady.then(() => showResults(map, EMPTY_FC));
  $lot.focus();
}

function clearTable() {
  $tbody.innerHTML = '';
  currentRows = [];
  setExportEnabled(false);
}

function renderTable(rows) {
  $tbody.innerHTML = '';
  currentRows = rows;
  const sorted = sortRows(rows);
  const frag = document.createDocumentFragment();
  for (const row of sorted) {
    // Either side can be null depending on the flow, so optional-chain both.
    const s = row.survey?.properties || {};
    const a = row.assess?.properties || {};
    const tr = document.createElement('tr');
    // Link the row back to whichever feature is drawn on the map in the
    // current flow. `_rowKey` is stamped on by tagFeatures() before render.
    const key = s._rowKey ?? a._rowKey;
    if (key != null) tr.dataset.rowKey = String(key);
    tr.appendChild(td(s.lot));
    tr.appendChild(td(s.block));
    tr.appendChild(td(s.plan));
    tr.appendChild(td(s.description));
    tr.appendChild(td(a.roll_number));
    tr.appendChild(td(a.full_address));
    tr.appendChild(td(a.zoning));
    tr.appendChild(td(formatArea(a.assessed_land_area), 'num'));
    tr.appendChild(td(formatCoord(a.centroid_lat), 'num'));
    tr.appendChild(td(formatCoord(a.centroid_lon), 'num'));
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
    'Roll Number', 'Full Address', 'Zoning',
    'Lot Size (sf)', 'Lat', 'Lon',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const row of currentRows) {
    const s = row.survey?.properties || {};
    const a = row.assess?.properties || {};
    lines.push([
      s.lot, s.block, s.plan, s.description,
      a.roll_number, a.full_address, a.zoning,
      // Unformatted numeric values in CSV so spreadsheets can treat them
      // as numbers rather than text. Empty cells stay empty.
      a.assessed_land_area ?? '',
      a.centroid_lat ?? '',
      a.centroid_lon ?? '',
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

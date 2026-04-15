// Entry point. Wires the five search inputs, the map, and the results table.
//
// Two search flows:
//
//   Legal-description flow (default — any of plan/lot/block/desc filled):
//     1. Read input values.
//     2. Live query Survey Parcels (soda.searchSurveyParcels).
//     3. Immediately render survey results to the map and a placeholder table
//        so the user sees something right away.
//     4. In parallel, fetch Assessment Parcels inside the result bbox and
//        join them to the survey parcels via turf.js.
//     5. Re-render the table with the enriched columns (Roll / Address / Zoning).
//     → Map shows Survey Parcels geometry.
//
//   Roll-number flow (Roll # field is filled):
//     1. Live query Assessment Parcels (soda.searchAssessmentByRoll).
//     2. Immediately render assessment results to the map and a table with
//        the roll/address/zoning columns filled in.
//     3. In parallel, fetch Survey Parcels inside the result bbox and join
//        them so the lot/block/plan/description columns can be back-filled.
//     4. Re-render the table.
//     → Map shows Assessment Parcels geometry (per Jason's requirement).
//
// If both a Roll # and a legal field are filled, Roll # wins and the legal
// fields are ignored — it's the more specific query.

import {
  searchSurveyParcels,
  fetchAssessmentOverlap,
  joinSurveyWithAssessment,
  searchAssessmentByRoll,
  fetchSurveyOverlap,
  joinAssessmentWithSurvey,
} from './soda.js';
import { initMap, showResults } from './map.js';

const $plan = document.getElementById('plan');
const $lot = document.getElementById('lot');
const $block = document.getElementById('block');
const $desc = document.getElementById('desc');
const $roll = document.getElementById('roll');
const $search = document.getElementById('search');
const $count = document.getElementById('count');
const $tbody = document.querySelector('#results tbody');
const $mapEl = document.getElementById('map');

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const { map, ready: mapReady } = initMap($mapEl);

$search.addEventListener('click', runSearch);
for (const el of [$plan, $lot, $block, $desc, $roll]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
}

async function runSearch() {
  const inputs = {
    plan: $plan.value.trim(),
    lot: $lot.value.trim(),
    block: $block.value.trim(),
    desc: $desc.value.trim(),
    roll: $roll.value.trim(),
  };

  if (!inputs.plan && !inputs.lot && !inputs.block && !inputs.desc && !inputs.roll) {
    setCount('Enter at least one search field.');
    clearTable();
    mapReady.then(() => showResults(map, EMPTY_FC));
    return;
  }

  setBusy(true);
  setCount('Searching…');
  clearTable();

  try {
    if (inputs.roll) {
      await runRollSearch(inputs);
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

  const countMsg = n === 500
    ? '500 parcels found (limit reached — refine your search)'
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

// ---------- Roll-number flow ----------

async function runRollSearch(inputs) {
  let assessFc;
  try {
    assessFc = await searchAssessmentByRoll(inputs);
  } catch (err) {
    console.error(err);
    setCount(`Search failed: ${err.message}`);
    return;
  }

  const n = assessFc.features.length;
  if (n === 0) {
    setCount('No parcels found for that roll #.');
    mapReady.then(() => showResults(map, assessFc));
    return;
  }

  const countMsg = n === 500
    ? '500 parcels found (limit reached — enter more digits of the roll #)'
    : `${n} parcels found by roll #`;
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

function clearTable() {
  $tbody.innerHTML = '';
}

function renderTable(rows) {
  clearTable();
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    // Either side can be null depending on the flow, so optional-chain both.
    const s = row.survey?.properties || {};
    const a = row.assess?.properties || {};
    const tr = document.createElement('tr');
    tr.appendChild(td(s.lot));
    tr.appendChild(td(s.block));
    tr.appendChild(td(s.plan));
    tr.appendChild(td(s.description));
    tr.appendChild(td(a.roll_number));
    tr.appendChild(td(a.full_address));
    tr.appendChild(td(a.zoning));
    frag.appendChild(tr);
  }
  $tbody.appendChild(frag);
}

function td(value) {
  const el = document.createElement('td');
  if (value == null || value === '') {
    el.textContent = '—';
    el.classList.add('empty');
  } else {
    el.textContent = value;
  }
  return el;
}

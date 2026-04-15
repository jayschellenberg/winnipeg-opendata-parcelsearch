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
const $count = document.getElementById('count');
const $tbody = document.querySelector('#results tbody');
const $mapEl = document.getElementById('map');

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const { map, ready: mapReady } = initMap($mapEl);

$search.addEventListener('click', runSearch);
for (const el of [$lot, $block, $plan, $desc, $roll, $address, $zoning]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
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

  const countMsg = n === 500
    ? '500 parcels found (limit reached — refine your search)'
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

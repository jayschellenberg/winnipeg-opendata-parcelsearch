// Entry point. Wires the four search inputs, the map, and the results table.
//
// Flow on Search click:
//   1. Read input values.
//   2. Live query Survey Parcels (soda.searchSurveyParcels).
//   3. Immediately render survey results to the map and a placeholder table
//      so the user sees something right away.
//   4. In parallel, fetch Assessment Parcels inside the result bbox and join
//      them to the survey parcels via turf.js.
//   5. Re-render the table with the enriched columns (Roll / Address / Zoning).

import {
  searchSurveyParcels,
  fetchAssessmentOverlap,
  joinSurveyWithAssessment,
} from './soda.js';
import { initMap, showResults } from './map.js';

const $plan = document.getElementById('plan');
const $lot = document.getElementById('lot');
const $block = document.getElementById('block');
const $desc = document.getElementById('desc');
const $search = document.getElementById('search');
const $count = document.getElementById('count');
const $tbody = document.querySelector('#results tbody');
const $mapEl = document.getElementById('map');

const { map, ready: mapReady } = initMap($mapEl);

$search.addEventListener('click', runSearch);
for (const el of [$plan, $lot, $block, $desc]) {
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
  };

  if (!inputs.plan && !inputs.lot && !inputs.block && !inputs.desc) {
    setCount('Enter at least one search field.');
    clearTable();
    mapReady.then(() => showResults(map, { type: 'FeatureCollection', features: [] }));
    return;
  }

  setBusy(true);
  setCount('Searching…');
  clearTable();

  let surveyFc;
  try {
    surveyFc = await searchSurveyParcels(inputs);
  } catch (err) {
    console.error(err);
    setBusy(false);
    setCount(`Search failed: ${err.message}`);
    return;
  }

  const n = surveyFc.features.length;
  if (n === 0) {
    setCount('No parcels found.');
    setBusy(false);
    mapReady.then(() => showResults(map, surveyFc));
    return;
  }

  // Render survey-only rows immediately; enrichment fills in shortly.
  const countMsg = n === 500
    ? '500 parcels found (limit reached — refine your search)'
    : `${n} parcels found`;
  setCount(`${countMsg} · loading roll numbers…`);

  // Show survey-only rows in the table immediately. Don't block on map
  // readiness — the table is independent and should not wait for tiles.
  renderTable(
    surveyFc.features.map((f) => ({ survey: f, assess: null }))
  );

  // Update the map in the background when it's ready.
  mapReady.then(() => showResults(map, surveyFc));

  // Enrichment: fetch Assessment Parcels in the bbox and join.
  let assessFc;
  try {
    assessFc = await fetchAssessmentOverlap(surveyFc);
  } catch (err) {
    console.error(err);
    setCount(`${countMsg} · enrichment failed: ${err.message}`);
    setBusy(false);
    return;
  }

  const rows = joinSurveyWithAssessment(surveyFc, assessFc);
  renderTable(rows);
  setCount(countMsg);
  setBusy(false);
}

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
    const s = row.survey.properties || {};
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

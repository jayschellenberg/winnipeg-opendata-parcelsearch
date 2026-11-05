/*
 * Permits dialog — the parcel card's "Permits" button.
 *
 * Three lookups run side by side for one civic address:
 *   - the City's PP&D property permit search (building + trade permits)
 *   - the City's PP&D occupancy permit search
 *   - open-data Detailed Building Permit Data (it4w-cpf4)
 * and lib/ppdPermits.js joins them. The portal pages come through the
 * same-origin /proxy/ppd/ rewrite (vercel.json in production, the Vite
 * proxy in dev) because the portal sends no CORS headers.
 *
 * The portal's own search page makes the user tick a disclaimer before
 * every search. This dialog asks once, shows the substance of it, and
 * remembers the tick in localStorage; until it is ticked only the open
 * data loads.
 *
 * Everything from the portal arrives as text (lib/ppdPermits.js strips
 * tags and decodes entities) and is written with textContent — never
 * innerHTML.
 */

import {
  PPD_STREET_TYPES, parseCivicAddress, addressLabel, ppdSearchBody,
  parsePpdPage, mergePermits, linkOccupancyToBuilding, sameStreet,
  describeOd, permitClassCode, isTradePermit, PERMIT_CLASS_LABELS,
} from './lib/ppdPermits.js';
import { fetchPermitsAtAddress } from './soda.js';
import { properCaseAddress } from './lib/addressFormat.js';

const PROXY = '/proxy/ppd';
const ACK_KEY = 'wps_ppd_disclaimer_v1';
/** A multi-unit address with this many units or fewer is fetched whole;
 *  above it the units are listed for the user to pick. */
const MAX_AUTO_UNITS = 25;

const PORTALS = {
  building: { search: 'PropertyPermitSearch', post: 'Proc.jsp' },
  occupancy: { search: 'OccupancyPermitSearch', post: 'AddressSelect.jsp' },
};

const $ = (id) => document.getElementById(id);

let wired = false;
let runId = 0;
let current = { addr: null, building: [], occupancy: [] };

function acked() {
  try { return localStorage.getItem(ACK_KEY) === '1'; } catch { return false; }
}

async function fetchPortal(kind, pathOrNull, addr) {
  const p = PORTALS[kind];
  const url = pathOrNull
    ? `${PROXY}/${p.search}/${pathOrNull}`
    : `${PROXY}/${p.search}/${p.post}`;
  const init = pathOrNull
    ? {}
    : {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: ppdSearchBody(addr),
    };
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`PPD ${kind} search HTTP ${res.status}`);
  return parsePpdPage(await res.text(), kind);
}

function dedupeByNumber(rows) {
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.number) ? false : (seen.add(r.number), true)));
}

/**
 * Resolve one portal search to permit rows. A unit list is resolved
 * automatically when the parcel names its unit or when there are few
 * enough units to fetch them all; a "nearby" suggestion list is never
 * guessed at — it goes to the user as buttons.
 * Returns { rows, choices, note }.
 */
async function resolvePortal(kind, addr) {
  const page = await fetchPortal(kind, null, addr);
  if (page.shape === 'results') return { rows: page.rows, choices: [], note: page.heading };
  if (page.shape === 'none') return { rows: [], choices: [], note: 'No property at this address in the City permit portal.' };
  if (page.shape === 'unknown') throw new Error('Unexpected response from the City permit portal');
  if (page.shape === 'units') {
    const mine = addr.unit ? page.choices.filter((c) => c.unit === addr.unit) : [];
    const pick = mine.length ? mine : (page.choices.length <= MAX_AUTO_UNITS ? page.choices : []);
    if (!pick.length) {
      return { rows: [], choices: page.choices, note: `${page.choices.length} units at this address — pick one.` };
    }
    const pages = await Promise.all(pick.map((c) => fetchPortal(kind, c.path)));
    const rows = dedupeByNumber(pages.flatMap((pg) => pg.rows));
    const note = mine.length
      ? `Showing unit ${addr.unit}. Other units at this address:`
      : `All ${pick.length} units at this address`;
    return { rows, choices: mine.length ? page.choices : [], note };
  }
  // nearby
  return {
    rows: [],
    choices: page.choices,
    note: 'The City portal does not know this exact address. Nearby records:',
  };
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function td(text, className) {
  const el = document.createElement('td');
  el.textContent = text ?? '';
  if (className) el.className = className;
  return el;
}

function sourceBadge(source) {
  const s = document.createElement('span');
  s.className = `permits-src permits-src-${source}`;
  s.textContent = source === 'both' ? 'portal + open data' : source === 'ppd' ? 'portal' : 'open data only';
  s.title = source === 'both'
    ? 'In the City portal and in open data (joined on permit number)'
    : source === 'ppd'
      ? 'City portal only — trade permits and pre-2010 permits are not in the open-data table'
      : 'Open data only — the portal omits demolition of a whole primary structure and cancelled/in-progress permits';
  return s;
}

function renderBuilding(allRows) {
  const $tb = $('permits-building-rows');
  $tb.textContent = '';
  const mode = $('permits-building-filter').value;
  const trade = allRows.filter((r) => isTradePermit(r.number)).length;
  const rows = mode === 'all' ? allRows
    : allRows.filter((r) => isTradePermit(r.number) === (mode === 'trade'));
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (r.source === 'opendata') tr.className = 'permits-od-only';
    tr.appendChild(td(r.issued || '—'));
    const num = td(r.number);
    num.appendChild(document.createElement('br'));
    num.appendChild(sourceBadge(r.source));
    tr.appendChild(num);
    const desc = td(r.description || (r.source === 'opendata' ? '(no description in open data)' : ''));
    if (!r.description) desc.classList.add('is-unknown');
    tr.appendChild(desc);

    const cls = td('');
    const od = r.od;
    if (od) {
      const lines = [
        describeOd(od),
        od.permitGroup,
        od.applicant ? `Applicant: ${od.applicant}` : '',
        od.unitsCreated || od.unitsLost ? `Dwelling units: +${od.unitsCreated} / −${od.unitsLost}` : '',
        od.received ? `Received ${od.received}` : '',
        od.finalDate ? `Final ${od.finalDate}` : '',
        od.majorProject ? 'Major project' : '',
        od.unit ? `Unit ${od.unit}` : '',
      ].filter(Boolean);
      lines.forEach((l, i) => {
        if (i) cls.appendChild(document.createElement('br'));
        cls.appendChild(document.createTextNode(l));
      });
    } else {
      const code = permitClassCode(r.number);
      const label = PERMIT_CLASS_LABELS[code];
      cls.textContent = code ? `${label || `Class ${code}`} — not in open data` : '—';
      cls.classList.add('is-unknown');
    }
    tr.appendChild(cls);

    const st = td(r.status || od?.odStatus || '');
    if (r.statusNote) st.title = r.statusNote;
    tr.appendChild(st);
    $tb.appendChild(tr);
  }
  if (!rows.length) {
    const tr = document.createElement('tr');
    const cell = td(allRows.length ? 'None in this view — change "Show".' : 'No permits found.', 'is-unknown');
    cell.colSpan = 5;
    tr.appendChild(cell);
    $tb.appendChild(tr);
  }
  const both = allRows.filter((r) => r.source === 'both').length;
  const odOnly = allRows.filter((r) => r.source === 'opendata').length;
  const hidden = allRows.length - rows.length;
  $('permits-building-count').textContent = allRows.length
    ? `— ${allRows.length} (${trade} trade; ${both} matched to open data${odOnly ? `, ${odOnly} open data only` : ''})`
      + (hidden ? ` · ${hidden} hidden` : '')
    : '';
}

function renderOccupancy(rows) {
  const $tb = $('permits-occupancy-rows');
  $tb.textContent = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(td(r.issued || '—'));
    tr.appendChild(td(r.number));
    tr.appendChild(td([r.use, r.majorGroup].filter(Boolean).join(' — ')));
    tr.appendChild(td([r.occupant, r.unit && `Unit ${r.unit}`].filter(Boolean).join(' · ')));
    const desc = td(r.description);
    if (r.relatedPermit) {
      desc.appendChild(document.createElement('br'));
      const tag = document.createElement('span');
      tag.className = 'permits-related';
      tag.textContent = `Building permit ${r.relatedPermit}`;
      tag.title = 'Same description as this building permit at the address';
      desc.appendChild(tag);
    }
    tr.appendChild(desc);
    tr.appendChild(td(r.expires || ''));
    tr.appendChild(td(r.occupantLoad || ''));
    $tb.appendChild(tr);
  }
  if (!rows.length) {
    const tr = document.createElement('tr');
    const cell = td('No occupancy permits found.', 'is-unknown');
    cell.colSpan = 7;
    tr.appendChild(cell);
    $tb.appendChild(tr);
  }
  $('permits-occupancy-count').textContent = rows.length ? `— ${rows.length}` : '';
}

function renderChoices(kind, choices, note, onPick) {
  const $box = $(`permits-${kind}-choices`);
  $box.textContent = '';
  if (note) {
    const p = document.createElement('p');
    p.className = 'permits-note';
    p.textContent = note;
    $box.appendChild(p);
  }
  for (const c of choices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sales-modal-btn permits-choice';
    b.textContent = c.label;
    b.addEventListener('click', () => onPick(c));
    $box.appendChild(b);
  }
  $box.hidden = !note && !choices.length;
}

function setStatus(text) {
  $('permits-status').textContent = text || '';
}

// ---------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------

function readForm() {
  const number = $('permits-number').value.trim();
  const name = $('permits-street').value.trim().toUpperCase();
  const type = $('permits-type').value;
  const base = current.addr || {};
  const same = base.number === number && base.name === name;
  return {
    unit: same ? base.unit || '' : '',
    number,
    suffix: same ? base.suffix || '' : '',
    name,
    type,
    direction: same ? base.direction || '' : '',
  };
}

function fillForm(addr) {
  $('permits-number').value = addr?.number || '';
  $('permits-street').value = addr?.name || '';
  $('permits-type').value = addr?.type || '';
}

async function runSearch(addr) {
  const id = ++runId;
  current = { addr, building: [], occupancy: [], odRows: [] };
  $('permits-title').textContent = `Permits — ${properCaseAddress(addressLabel(addr))}`;
  renderChoices('building', [], '', null);
  renderChoices('occupancy', [], '', null);
  $('permits-building-rows').textContent = '';
  $('permits-occupancy-rows').textContent = '';
  $('permits-building-count').textContent = '';
  $('permits-occupancy-count').textContent = '';

  if (!/^\d{1,8}$/.test(addr.number) || addr.name.length < 3) {
    setStatus('Enter a civic number and a street name of at least three letters.');
    return;
  }
  const usePortal = acked();
  setStatus(usePortal ? 'Searching the City permit portal and open data…' : 'Loading open data… (tick the disclaimer to include the City permit portal)');

  const odP = fetchPermitsAtAddress(addr)
    .then((rows) => rows.filter((r) => sameStreet(addr, r)))
    .catch((err) => { console.warn('Open-data permits failed', err); return null; });
  const bP = usePortal ? resolvePortal('building', addr).catch((err) => ({ error: err })) : Promise.resolve(null);
  const oP = usePortal ? resolvePortal('occupancy', addr).catch((err) => ({ error: err })) : Promise.resolve(null);

  const [odRows, b, o] = await Promise.all([odP, bP, oP]);
  if (id !== runId) return;
  current.odRows = odRows || [];

  const problems = [];
  if (odRows == null) problems.push('open data unavailable');
  if (b?.error) { console.warn(b.error); problems.push('City permit portal unavailable'); }
  else if (o?.error) { console.warn(o.error); problems.push('City occupancy search unavailable'); }

  const showBuilding = (portalRows) => {
    current.building = mergePermits(portalRows, current.odRows);
    renderBuilding(current.building);
  };
  const showOccupancy = (rows) => {
    current.occupancy = linkOccupancyToBuilding(rows, current.building);
    renderOccupancy(current.occupancy);
  };

  showBuilding(b && !b.error ? b.rows : []);
  showOccupancy(o && !o.error ? o.rows : []);

  const pick = (kind) => async (choice) => {
    const myId = runId;
    setStatus(`Loading ${choice.label}…`);
    try {
      const page = await fetchPortal(kind, choice.path);
      if (myId !== runId) return;
      if (kind === 'building') { showBuilding(page.rows); showOccupancy(current.occupancy); }
      else showOccupancy(page.rows);
      setStatus(`Showing ${choice.label}.`);
    } catch (err) {
      console.warn(err);
      setStatus('City permit portal unavailable.');
    }
  };
  if (b && !b.error) renderChoices('building', b.choices, b.choices.length || !b.rows.length ? b.note : '', pick('building'));
  if (o && !o.error) renderChoices('occupancy', o.choices, o.choices.length || !o.rows.length ? o.note : '', pick('occupancy'));
  if (!usePortal) {
    renderChoices('occupancy', [], 'Tick the disclaimer above to search the City occupancy permits.', null);
  }

  const parts = [];
  if (b && !b.error && b.note && b.rows.length) parts.push(b.note.replace(/\.?\s*Other units.*$/, ''));
  parts.push(`${current.building.length} building/trade, ${current.occupancy.length} occupancy`);
  if (problems.length) parts.push(problems.join('; '));
  setStatus(parts.join(' · '));
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv() {
  const head = ['Kind', 'Issued', 'Number', 'Source', 'Description', 'Status', 'Permit group', 'Permit type',
    'Sub type', 'Work type', 'Applicant', 'Units created', 'Units lost', 'Received', 'Final', 'Use',
    'Major group', 'Occupant', 'Unit', 'Expires', 'Occupant load', 'Related building permit'];
  const lines = [head];
  for (const r of current.building) {
    const od = r.od || {};
    lines.push(['Building/trade', r.issued, r.number, r.source, r.description, r.status || od.odStatus,
      od.permitGroup, od.permitType, od.subType, od.workType, od.applicant, od.unitsCreated ?? '',
      od.unitsLost ?? '', od.received, od.finalDate, '', '', '', od.unit, '', '', '']);
  }
  for (const r of current.occupancy) {
    lines.push(['Occupancy', r.issued, r.number, 'portal', r.description, '', '', '', '', '', '', '', '',
      '', '', r.use, r.majorGroup, r.occupant, r.unit, r.expires, r.occupantLoad, r.relatedPermit || '']);
  }
  return lines.map((l) => l.map(csvCell).join(',')).join('\n');
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

function wire() {
  if (wired) return;
  wired = true;
  const $type = $('permits-type');
  for (const t of PPD_STREET_TYPES) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    $type.appendChild(o);
  }
  $('permits-close').addEventListener('click', () => $('permits-modal').close());
  $('permits-building-filter').addEventListener('change', () => renderBuilding(current.building));
  $('permits-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(readForm());
  });
  const $ack = $('permits-disclaimer-ack');
  $ack.addEventListener('change', () => {
    try {
      if ($ack.checked) localStorage.setItem(ACK_KEY, '1');
      else localStorage.removeItem(ACK_KEY);
    } catch { /* private mode: the tick lasts for this page only */ }
    if ($ack.checked) {
      $('permits-disclaimer').hidden = true;
      if (current.addr) runSearch(readForm());
    }
  });
  $('permits-copy-csv').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(toCsv());
      setStatus('Copied as CSV.');
    } catch {
      setStatus('Clipboard unavailable.');
    }
  });
}

/**
 * Open the dialog for an assessment record (its full_address) and start
 * the lookups.
 */
export function openPermitsDialog(assessment) {
  const $modal = $('permits-modal');
  if (!$modal) return;
  wire();
  const addr = parseCivicAddress(assessment?.full_address);
  $('permits-disclaimer').hidden = acked();
  $('permits-disclaimer-ack').checked = acked();
  if (!$modal.open) $modal.showModal();
  if (!addr) {
    fillForm(null);
    current = { addr: null, building: [], occupancy: [] };
    $('permits-title').textContent = 'Permits';
    setStatus('This parcel has no civic address on the roll — enter one above.');
    renderBuilding([]);
    renderOccupancy([]);
    return;
  }
  fillForm(addr);
  runSearch(addr);
}

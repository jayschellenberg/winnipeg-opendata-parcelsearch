/*
 * The land-sales charts page.
 *
 * Opened from the Sales Analysis tab in its own browser tab. It holds
 * no data of its own: main.js broadcasts the currently-filtered sales
 * over a BroadcastChannel and this page redraws. So the charts track
 * the sidebar filters live — narrow the grid and the scatter narrows
 * with it — which is why "Freeze" exists for when you want them to sit
 * still while reading or screenshotting.
 *
 * Three charts, chosen for land work and deliberately non-overlapping:
 *   - $/Lot SF over time   — the market-conditions view
 *   - $/Acre vs lot size   — the size-adjustment curve, at the unit
 *                            larger parcels are actually quoted in.
 *                            (An $/Acre-over-TIME chart was tried and
 *                            dropped: $/acre is $/sf × 43,560, so it
 *                            plots the identical trend and R² as the
 *                            first chart — a third of the page saying
 *                            nothing new.)
 *   - $/Lot vs lot size    — what one lot fetched against how big it is
 *
 * "Exclude already-built" defaults ON and is the most consequential
 * thing on the page. Roughly half the vacant-coded sales in the archive
 * are new-subdivision HOUSES sold while the roll still read vacant, and
 * they clear about 3x a genuine lot per square foot — a step, not a
 * gradient. Charting them drags every land trendline upward, so the
 * default is to leave them out and say in the header how many went.
 * Unticking puts them back for anyone who wants to see the contrast.
 */

import {
  saleRecordsFromRows, fitLinear, niceScale, dotRadius, median, annualTrendPct,
} from '../lib/salesCharts.js';
import {
  drawChart, fmtAxisMoney, fmtAxisDate, fmtMoney,
} from '../lib/chartRender.js';
import './charts.css';

const CHANNEL = 'wps-sales-charts';
const OPTS_KEY = 'wps_charts_opts_v1';

const $grid = document.getElementById('charts-grid');
const $sub = document.getElementById('charts-sub');
const $status = document.getElementById('charts-status');
const $landOnly = document.getElementById('land-only');
const $dropFarFlung = document.getElementById('drop-far-flung');
const $dropBuilt = document.getElementById('drop-built');
const $freeze = document.getElementById('freeze');

let records = [];
let received = false;

// --- options persistence ----------------------------------------------------
// The three filters are ways of working and persist. `freeze` deliberately
// does NOT: a page that silently reopens frozen would look broken, and
// the user would blame the live link rather than a checkbox they set
// days ago.
function readOpts() {
  try {
    const raw = JSON.parse(localStorage.getItem(OPTS_KEY) || '{}');
    if (typeof raw.landOnly === 'boolean') $landOnly.checked = raw.landOnly;
    if (typeof raw.dropFarFlung === 'boolean') $dropFarFlung.checked = raw.dropFarFlung;
    // Absent from an options blob written before this filter existed,
    // which leaves the markup's checked default in place — the safe way
    // round, since the old charts were quietly INCLUDING these.
    if (typeof raw.dropBuilt === 'boolean') $dropBuilt.checked = raw.dropBuilt;
  } catch { /* defaults already in the markup */ }
}
function writeOpts() {
  try {
    localStorage.setItem(OPTS_KEY, JSON.stringify({
      landOnly: $landOnly.checked,
      dropFarFlung: $dropFarFlung.checked,
      dropBuilt: $dropBuilt.checked,
    }));
  } catch { /* storage disabled — options just don't persist */ }
}

// --- chart construction -----------------------------------------------------
function card(title, note) {
  const wrap = document.createElement('section');
  wrap.className = 'chart-card';
  const h = document.createElement('h2');
  h.textContent = title;
  wrap.appendChild(h);
  if (note) {
    const p = document.createElement('p');
    p.className = 'chart-note';
    p.textContent = note;
    wrap.appendChild(p);
  }
  return wrap;
}

function emptyCard(title, why) {
  const wrap = card(title);
  const p = document.createElement('p');
  p.className = 'chart-empty';
  p.textContent = why;
  wrap.appendChild(p);
  return wrap;
}

/** One scatter with an OLS fit, plus a one-line read-out under it. */
function scatterCard({ title, rows, xOf, yOf, xFormat, yFormat, xLabel, yLabel, overTime }) {
  const points = rows
    .map((r) => ({ x: xOf(r), y: yOf(r), farFlung: r.farFlung, rec: r }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.y > 0);
  if (points.length < 2) {
    return emptyCard(title, points.length === 1
      ? 'Only one sale has the figures this chart needs — a trend needs at least two.'
      : 'No sales in the current filter have the figures this chart needs.');
  }
  for (const p of points) {
    p.label = `${p.rec.address || p.rec.roll}\n${fmtMoney(p.rec.price)}`
      + `${p.rec.lots > 1 ? ` · ${p.rec.lots} parcels` : ''}`;
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xScale = niceScale(Math.min(...xs), Math.max(...xs), 6);
  const yScale = niceScale(Math.min(0, ...ys), Math.max(...ys), 5);
  const fit = fitLinear(points);

  const wrap = card(title);
  wrap.appendChild(drawChart({
    points, xScale, yScale, xFormat, yFormat, fit,
    xLabel, yLabel, radius: dotRadius(points.length),
  }));

  const med = median(ys);
  const bits = [`${points.length} sale${points.length === 1 ? '' : 's'}`, `median ${fmtMoney(med)}`];
  if (fit) {
    if (overTime) {
      const pct = annualTrendPct(fit, med);
      // A trendline off a handful of scattered points is arithmetic, not
      // evidence, so the strength of the fit is stated beside the rate
      // rather than left for the eye to guess.
      if (pct != null) bits.push(`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%/yr`);
    }
    bits.push(`R² ${fit.r2.toFixed(2)}`);
  }
  const note = document.createElement('p');
  note.className = 'chart-note';
  note.textContent = bits.join(' · ');
  wrap.appendChild(note);
  return wrap;
}

function render() {
  // Counted, not just dropped. A chart that silently sheds half its
  // sales reads as a thin market rather than a cleaned one, and the
  // header has to be able to say which happened.
  let builtSeen = 0;
  const filtered = records.filter((r) => {
    if ($landOnly.checked && !r.isLand) return false;
    if ($dropFarFlung.checked && r.farFlung) return false;
    if (r.alreadyBuilt) {
      builtSeen += 1;
      if ($dropBuilt.checked) return false;
    }
    return true;
  });

  $grid.textContent = '';
  if (!received) {
    $sub.textContent = 'Waiting for the Sales Analysis tab…';
    return;
  }
  const noun = filtered.length === 1 ? 'sale' : 'sales';
  const scope = $landOnly.checked ? `land ${noun}` : noun;
  const builtNoun = `already-built sale${builtSeen === 1 ? '' : 's'}`;
  // Said either way round: excluded is a number the reader needs to
  // judge the sample, and included is a warning that the land rates on
  // screen are partly house prices.
  const builtNote = builtSeen === 0 ? ''
    : $dropBuilt.checked ? ` ${builtSeen} ${builtNoun} excluded.`
    : ` ⚠ Includes ${builtSeen} ${builtNoun} — these are house prices, not land prices.`;
  $sub.textContent = filtered.length
    ? `${filtered.length} ${scope} from the current grid filter.${builtNote}`
    : `No ${$landOnly.checked ? 'land sales' : 'sales'} in the current grid filter.${builtNote}`;

  if (!filtered.length) {
    $grid.appendChild(emptyCard(
      'Nothing to chart',
      builtSeen && $dropBuilt.checked
        ? `Every sale in the current filter was flagged already-built — a finished house sold while the roll still read vacant. Untick "Exclude already-built" to chart them anyway, but read the result as improved sales, not land.`
        : $landOnly.checked
          ? 'No vacant-land sales are in the current filter. Untick "Land sales only" to chart every sale shown in the grid.'
          : 'The grid filter is currently showing no sales.',
    ));
    return;
  }

  const dated = filtered.filter((r) => Number.isFinite(r.date));
  $grid.appendChild(scatterCard({
    title: '$/Lot SF over time',
    rows: dated,
    xOf: (r) => r.date,
    yOf: (r) => r.pricePerSf,
    xFormat: fmtAxisDate,
    yFormat: fmtAxisMoney,
    xLabel: 'Sale date',
    yLabel: '$ per lot SF',
    overTime: true,
  }));
  $grid.appendChild(scatterCard({
    title: '$/Acre vs lot size',
    rows: filtered,
    xOf: (r) => r.acres,
    yOf: (r) => r.pricePerAcre,
    xFormat: (v) => (v >= 1 ? v.toFixed(v >= 10 ? 0 : 1) : v.toFixed(2)),
    yFormat: fmtAxisMoney,
    xLabel: 'Lot size (acres, group total)',
    yLabel: '$ per acre',
  }));
  $grid.appendChild(scatterCard({
    title: '$/Lot vs lot size',
    rows: filtered,
    xOf: (r) => r.landSf,
    yOf: (r) => r.pricePerLot,
    xFormat: (v) => `${Math.round(v).toLocaleString('en-CA')}`,
    yFormat: fmtAxisMoney,
    xLabel: 'Lot size (SF, group total)',
    yLabel: '$ per lot',
  }));
}

// --- live link back to the app ----------------------------------------------
const channel = new BroadcastChannel(CHANNEL);
channel.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'sales') return;
  if ($freeze.checked && received) {
    $status.textContent = 'Frozen — the grid changed but these charts are held.';
    return;
  }
  records = saleRecordsFromRows(msg.rows || [], { parseDate: (iso) => Date.parse(iso) });
  received = true;
  $status.textContent = '';
  render();
});
// Ask the app to send what it has: this tab may have been opened after
// the grid was already populated, in which case no broadcast is coming.
channel.postMessage({ type: 'request' });

for (const el of [$landOnly, $dropFarFlung, $dropBuilt]) {
  el.addEventListener('change', () => { writeOpts(); render(); });
}
$freeze.addEventListener('change', () => {
  $status.textContent = $freeze.checked
    ? 'Frozen — updates from the Sales Analysis tab are paused.'
    : '';
  if (!$freeze.checked) channel.postMessage({ type: 'request' });
});

readOpts();
render();

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
 * TWO PAGES, as the land dashboard's first two (2026-11-01):
 *   - ADF Overview: every sale the search returned, ticked or not -- the
 *     near market -- with the dashboard's map tabs (price and year of sale,
 *     the isovalue surface, the location effect and its uncertainty).
 *   - CMS Charts: the sales ticked in the grid, the comparable set.
 * Winnipeg's sales filters run BEFORE the parcel lookup, so the search's
 * result is already the filtered set: the two pages differ only by the rows
 * unticked in the grid, and say so. Each page has a row of map tabs on top
 * and a row of chart tabs below, two charts to a tab.
 *
 * TWO SETS, switched at the top. Land and Buildings divide a price by
 * different denominators and answer different questions, so they are two
 * sets rather than one that half-applies. The three option checkboxes
 * belong to the land set and hide in Buildings mode — "Land sales only"
 * would empty it, and "Exclude already-built" exists to keep house prices
 * OUT of land rates, which is precisely what the building charts want in.
 *
 * BUILDINGS (Jason, 2026-09-16):
 *   - $/Bldg SF over time        — market conditions for improved stock
 *   - $/Bldg SF by year built    — the age/obsolescence curve
 *   - $/Bldg SF by building size — the size-adjustment curve
 *   A sale with no building rate is not in these at all: lib/sales.js
 *   withholds $/Bldg SF on a vacant group rather than inventing one, so
 *   vacant land drops out without needing a filter of its own.
 *
 * LAND — chosen for land work and deliberately non-overlapping:
 *   - $/Lot SF over time   — the market-conditions view
 *   - $/Acre vs lot size   — the size-adjustment curve, at the unit
 *                            larger parcels are actually quoted in.
 *                            (An $/Acre-over-TIME chart was tried and
 *                            dropped: $/acre is $/sf × 43,560, so it
 *                            plots the identical trend and R² as the
 *                            first chart — a third of the page saying
 *                            nothing new.)
 *   - $/Lot vs lot size    — what one lot fetched against how big it is
 *   - $/Lot SF by distance — from the subject, when one is set
 * Both sets also carry the dashboard's Sales by year, Distributions and
 * Sale/Assessment tabs.
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
  drawChart, drawBars, fmtAxisMoney, fmtAxisDate, fmtMoney,
} from '../lib/chartRender.js';
import { properCaseAddress } from '../lib/addressFormat.js';
import { ISO_MIN_N, LOCFX_MIN_N } from '../lib/locationMaps.js';
import { createChartMap, linkMaps } from './chartMap.js';
import './charts.css';

const CHANNEL = 'wps-sales-charts';
const OPTS_KEY = 'wps_charts_opts_v1';

const $grid = document.getElementById('charts-grid');
const $sub = document.getElementById('charts-sub');
const $status = document.getElementById('charts-status');
const $landOnly = document.getElementById('land-only');
const $modeLand = document.getElementById('mode-land');
const $modeBldg = document.getElementById('mode-bldg');
const $title = document.getElementById('charts-title');
const $dropFarFlung = document.getElementById('drop-far-flung');
const $dropBuilt = document.getElementById('drop-built');
const $freeze = document.getElementById('freeze');
const $pageTabs = document.getElementById('page-tabs');

let records = [];
let received = false;
let mode = 'land';   // 'land' | 'bldg'
let page = 'adf';    // 'adf' | 'cms'
// The chosen map and chart tab per page and mode, by label.
let subTabs = {};

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
    if (raw.mode === 'land' || raw.mode === 'bldg') mode = raw.mode;
    if (raw.page === 'adf' || raw.page === 'cms') page = raw.page;
    if (raw.subTabs && typeof raw.subTabs === 'object') subTabs = raw.subTabs;
  } catch { /* defaults already in the markup */ }
}
function writeOpts() {
  try {
    localStorage.setItem(OPTS_KEY, JSON.stringify({
      landOnly: $landOnly.checked,
      dropFarFlung: $dropFarFlung.checked,
      dropBuilt: $dropBuilt.checked,
      mode,
      page,
      subTabs,
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

const noteEl = (text) => {
  const note = document.createElement('p');
  note.className = 'chart-note';
  note.textContent = text;
  return note;
};

/** One scatter with an OLS fit, plus a one-line read-out under it. */
function scatterCard({ title, rows, xOf, yOf, xFormat, yFormat, xLabel, yLabel, overTime, valueFmt = fmtMoney }) {
  const points = rows
    .map((r) => ({ x: xOf(r), y: yOf(r), farFlung: r.farFlung, rec: r }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.y > 0);
  if (points.length < 2) {
    return emptyCard(title, points.length === 1
      ? 'Only one sale has the figures this chart needs — a trend needs at least two.'
      : 'No sales in the current filter have the figures this chart needs.');
  }
  for (const p of points) {
    p.label = `${properCaseAddress(p.rec.address) || p.rec.roll}\n${fmtMoney(p.rec.price)}`
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
  const bits = [`${points.length} sale${points.length === 1 ? '' : 's'}`, `median ${valueFmt(med)}`];
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
  wrap.appendChild(noteEl(bits.join(' · ')));
  return wrap;
}

/** Sales by year: one bar per calendar year, a year with none a gap. */
function salesByYearCard(rows) {
  const years = rows.filter((r) => Number.isFinite(r.date)).map((r) => new Date(r.date).getFullYear());
  if (!years.length) return emptyCard('Sales by year', 'No sales in the current filter carry a sale date.');
  const lo = Math.min(...years); const hi = Math.max(...years);
  const n = new Map();
  for (const y of years) n.set(y, (n.get(y) || 0) + 1);
  const bars = [];
  for (let y = lo; y <= hi; y++) bars.push({ label: String(y), n: n.get(y) || 0 });
  const wrap = card('Sales by year');
  wrap.appendChild(drawBars({ bars, xLabel: 'Year of sale', counts: true }));
  wrap.appendChild(noteEl(`${years.length} sale${years.length === 1 ? '' : 's'}, each counted once in the calendar year it sold.`));
  return wrap;
}

/** A histogram on about 20 bins of a nice width. */
function histogramCard(title, values, { xLabel, fmt = fmtAxisMoney, valueFmt = fmtMoney, note = '' } = {}) {
  const v = values.filter((x) => Number.isFinite(x) && x > 0);
  if (v.length < 2) return emptyCard(title, 'No sales in the current filter carry this figure.');
  const s = niceScale(Math.min(...v), Math.max(...v), 20);
  const width = s.ticks.length > 1 ? s.ticks[1] - s.ticks[0] : 1;
  const nb = Math.max(1, Math.round((s.max - s.min) / width));
  const bars = Array.from({ length: nb }, (_, i) => ({ label: fmt(s.min + i * width), n: 0 }));
  for (const x of v) bars[Math.min(nb - 1, Math.max(0, Math.floor((x - s.min) / width)))].n += 1;
  const wrap = card(title);
  wrap.appendChild(drawBars({ bars, xLabel }));
  wrap.appendChild(noteEl([`${v.length} sales`, `median ${valueFmt(median(v))}`, note].filter(Boolean).join(' · ')));
  return wrap;
}

/** Sale / assessment: over time, and its distribution. */
function saleAsmtCards(rows) {
  const ratioFmt = (v) => v.toFixed(2);
  const note = 'Against the CURRENT roll’s total assessment, not the roll in force at the sale.';
  const a = scatterCard({
    title: 'Sale / assessment over time',
    rows: rows.filter((r) => Number.isFinite(r.date)),
    xOf: (r) => r.date,
    yOf: (r) => r.saleToAsmt,
    xFormat: fmtAxisDate,
    yFormat: (v) => v.toFixed(1),
    xLabel: 'Sale date',
    yLabel: 'Sale price / assessment',
    valueFmt: ratioFmt,
  });
  a.appendChild(noteEl(note));
  const b = histogramCard('Sale / assessment distribution', rows.map((r) => r.saleToAsmt),
    { xLabel: 'Sale price / assessment', fmt: (v) => v.toFixed(1), valueFmt: ratioFmt, note });
  return [a, b];
}

// --- what each set charts -----------------------------------------------------

/** The rate the set is about, for the maps and the distribution. */
const RATE = {
  land: { field: 'pricePerSf', unit: '$/sf', title: '$/Lot SF', digits: 2, sizeField: 'landSf', sizeLabel: 'Lot size (SF)' },
  bldg: { field: 'pricePerBldgSf', unit: '$/sf', title: '$/Bldg SF', digits: 2, sizeField: 'bldgSf', sizeLabel: 'Building size (SF)' },
};

function landCharts(rows) {
  const dated = rows.filter((r) => Number.isFinite(r.date));
  const out = [
    ['Over time & size', scatterCard({
      title: '$/Lot SF over time', rows: dated, xOf: (r) => r.date, yOf: (r) => r.pricePerSf,
      xFormat: fmtAxisDate, yFormat: fmtAxisMoney, xLabel: 'Sale date', yLabel: '$ per lot SF', overTime: true,
    })],
    ['Over time & size', scatterCard({
      title: '$/Acre vs lot size', rows, xOf: (r) => r.acres, yOf: (r) => r.pricePerAcre,
      xFormat: (v) => (v >= 1 ? v.toFixed(v >= 10 ? 0 : 1) : v.toFixed(2)), yFormat: fmtAxisMoney,
      xLabel: 'Lot size (acres, group total)', yLabel: '$ per acre',
    })],
    ['Per lot & distance', scatterCard({
      title: '$/Lot vs lot size', rows, xOf: (r) => r.landSf, yOf: (r) => r.pricePerLot,
      xFormat: (v) => `${Math.round(v).toLocaleString('en-CA')}`, yFormat: fmtAxisMoney,
      xLabel: 'Lot size (SF, group total)', yLabel: '$ per lot',
    })],
  ];
  if (rows.some((r) => Number.isFinite(r.dist))) {
    out.push(['Per lot & distance', scatterCard({
      title: '$/Lot SF by distance from subject', rows, xOf: (r) => r.dist, yOf: (r) => r.pricePerSf,
      xFormat: (v) => `${v.toFixed(v < 10 ? 1 : 0)} km`, yFormat: fmtAxisMoney,
      xLabel: 'Distance from the subject parcel (km)', yLabel: '$ per lot SF',
    })]);
  }
  return out;
}

function bldgCharts(rows) {
  const dated = rows.filter((r) => Number.isFinite(r.date));
  return [
    ['Over time & age', scatterCard({
      title: '$/Bldg SF over time', rows: dated, xOf: (r) => r.date, yOf: (r) => r.pricePerBldgSf,
      xFormat: fmtAxisDate, yFormat: fmtAxisMoney, xLabel: 'Sale date', yLabel: '$ per building SF', overTime: true,
    })],
    ['Over time & age', scatterCard({
      title: '$/Bldg SF by year built', rows, xOf: (r) => r.yearBuilt, yOf: (r) => r.pricePerBldgSf,
      // A year is not a quantity: no thousands separator, or 1962 reads
      // as 1,962 on the axis.
      xFormat: (v) => String(Math.round(v)), yFormat: fmtAxisMoney,
      xLabel: 'Year built (oldest section)', yLabel: '$ per building SF',
    })],
    ['Size', scatterCard({
      title: '$/Bldg SF by building size', rows, xOf: (r) => r.bldgSf, yOf: (r) => r.pricePerBldgSf,
      xFormat: (v) => Math.round(v).toLocaleString('en-CA'), yFormat: fmtAxisMoney,
      xLabel: 'Building size (SF, group total)', yLabel: '$ per building SF',
    })],
  ];
}

/** Every chart for a set, as [tab label, card]. */
function chartsFor(rows) {
  const r = RATE[mode];
  return [
    ...(mode === 'bldg' ? bldgCharts(rows) : landCharts(rows)),
    ['Sales by year', salesByYearCard(rows)],
    ['Distributions', histogramCard(`${r.title} distribution`, rows.map((x) => x[r.field]), { xLabel: `${r.title} (as sold)` })],
    ['Distributions', histogramCard(`${r.sizeLabel.replace(/ \(SF\)/, '')} distribution`, rows.map((x) => x[r.sizeField]),
      { xLabel: r.sizeLabel, fmt: (v) => Math.round(v).toLocaleString('en-CA'), valueFmt: (v) => `${Math.round(v).toLocaleString('en-CA')} sf` })],
    ...saleAsmtCards(rows).map((c) => ['Sale/Assessment', c]),
  ];
}

// --- maps ---------------------------------------------------------------------

const maps = new Map();
function mapFor(key) {
  if (!maps.has(key)) maps.set(key, createChartMap());
  return maps.get(key);
}
const located = (r) => Number.isFinite(r.lat) && Number.isFinite(r.lng);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const tipOf = (r) => `${properCaseAddress(r.address) || r.roll} · ${fmtMoney(r.price)}${Number.isFinite(r.date) ? ` · ${fmtAxisDate(r.date)}` : ''}`;

const QUINTILE = ['#fef0d9', '#fdcc8a', '#fc8d59', '#e34a33', '#b30000'];
const YEAR_RAMP = ['#deebf7', '#9ecae1', '#6baed6', '#3182bd', '#08519c', '#08306b'];

function pointsFc(rows, colorOf, small = false) {
  return {
    type: 'FeatureCollection',
    features: rows.map((r) => ({
      type: 'Feature',
      properties: { color: colorOf ? colorOf(r) : null, small, tip: tipOf(r) },
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
    })),
  };
}
const fitKeyOf = (rows) => rows.map((r) => r.instrument).join('|');

function priceMap(key, rows, setName) {
  const r = RATE[mode];
  const recs = rows.filter(located).filter((x) => x[r.field] > 0);
  const vals = recs.map((x) => x[r.field]).sort((a, b) => a - b);
  const q = [0.2, 0.4, 0.6, 0.8].map((p) => vals[Math.floor(p * (vals.length - 1))]);
  const band = (v) => q.filter((t) => v > t).length;
  const m = mapFor(key);
  m.setHeader(`${setName} – ${r.title} heatmap`);
  m.setSurface(null);
  m.setData({ fc: pointsFc(recs, (x) => QUINTILE[band(x[r.field])]), fitKey: fitKeyOf(recs) });
  const edges = [vals[0], ...q, vals[vals.length - 1]];
  m.setLegend(recs.length ? QUINTILE.map((c, i) => ({ color: c, label: `${fmtMoney(edges[i])} – ${fmtMoney(edges[i + 1])}` })).reverse() : []);
  m.setNote(recs.length
    ? `Quintiles of ${r.title} as sold; each colour holds about a fifth of the ${plural(recs.length, 'sale')}.`
    : `No sales in this set carry a ${r.title} and a location.`);
  return m;
}

function yearMap(key, rows, setName) {
  const recs = rows.filter(located).filter((x) => Number.isFinite(x.date));
  const years = [...new Set(recs.map((x) => new Date(x.date).getFullYear()))].sort();
  const colorOf = (y) => YEAR_RAMP[Math.round((years.indexOf(y) / Math.max(1, years.length - 1)) * (YEAR_RAMP.length - 1))];
  const m = mapFor(key);
  m.setHeader(`${setName} – map by year of sale`);
  m.setSurface(null);
  m.setData({ fc: pointsFc(recs, (x) => colorOf(new Date(x.date).getFullYear())), fitKey: fitKeyOf(recs) });
  m.setLegend(years.map((y) => ({ color: colorOf(y), label: String(y) })).reverse());
  m.setNote('Pans and zooms with the map beside it.');
  return m;
}

// The fitted maps (lib/locationMaps.js, the land template's helpers.R
// section 28), in a worker, keyed on what was sent: a render that finds the
// answer not yet back draws the sales and says the surface is being fitted.
let fitWorker = null;
const fitCache = new Map();
const fitPending = new Set();
function hashText(t) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
function fitFor(kind, payload) {
  const key = `${kind}:${hashText(JSON.stringify(payload))}`;
  if (fitCache.has(key)) return fitCache.get(key);
  if (!fitWorker) {
    try {
      fitWorker = new Worker(new URL('../workers/locationMaps.worker.js', import.meta.url), { type: 'module' });
      fitWorker.addEventListener('message', (e) => {
        const { key: k, result } = e.data || {};
        fitPending.delete(k);
        fitCache.set(k, result);
        while (fitCache.size > 24) fitCache.delete(fitCache.keys().next().value);
        render();
      });
    } catch (err) {
      const reason = `This browser could not start the worker that fits the surface (${err?.message || err}).`;
      return { ok: false, reason, caption: reason };
    }
  }
  if (!fitPending.has(key)) {
    fitPending.add(key);
    fitWorker.postMessage({ key, kind, ...payload });
  }
  return null;
}

function surfaceMap(key, title, recs, result, waiting) {
  const m = mapFor(key);
  m.setHeader(title);
  m.setData({ fc: pointsFc(recs, null, true), fitKey: fitKeyOf(recs) });
  m.setSurface(result?.ok ? { fills: result.fills, lines: result.lines } : null);
  m.setLegend(result?.ok ? result.legend : []);
  m.setNote(result == null ? waiting : result.caption);
  return m;
}

/** Today at local midnight: the page has no effective-date control. */
function todayMs() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function isovalueMap(key, rows, setName) {
  const r = RATE[mode];
  const recs = rows.filter(located).filter((x) => x[r.field] > 0);
  const result = fitFor('iso', {
    sales: recs.map((x) => ({ lon: x.lng, lat: x.lat, value: x[r.field], dateMs: x.date })),
    opts: { effMs: todayMs(), unit: r.unit, digits: r.digits },
  });
  return surfaceMap(key, `${setName} isovalue – ${r.title}`, recs, result,
    `Fitting the surface on ${plural(recs.length, 'sale')}… (needs at least ${ISO_MIN_N}).`);
}

/** The location model's controls: the land template's list as far as the
 *  Winnipeg roll carries it. A control under half recorded is left out and
 *  named in the caption. */
const LOCFX_CONTROLS = {
  land: [
    { col: 'landSf', kind: 'smooth', log: true, label: 'lot size' },
    { col: 'date', kind: 'smooth', label: 'sale date' },
    { col: 'zoning', kind: 'factor', label: 'zoning' },
    { col: 'useCode', kind: 'factor', label: 'property use' },
  ],
  bldg: [
    { col: 'bldgSf', kind: 'smooth', log: true, label: 'building size' },
    { col: 'landSf', kind: 'smooth', log: true, label: 'lot size' },
    { col: 'yearBuilt', kind: 'smooth', label: 'year built' },
    { col: 'date', kind: 'smooth', label: 'sale date' },
    { col: 'useCode', kind: 'factor', label: 'property use' },
    { col: 'zoning', kind: 'factor', label: 'zoning' },
  ],
};

function locationMaps(rows, setName) {
  // Buildings mode models the sales WITH a building; land mode every sale.
  const recs = rows.filter(located).filter((x) => mode !== 'bldg' || x.pricePerBldgSf > 0);
  const result = fitFor('locfx', {
    sales: recs.map((x) => ({
      lon: x.lng, lat: x.lat, price: x.price, landSf: x.landSf, bldgSf: x.bldgSf, yearBuilt: x.yearBuilt,
      date: x.date, zoning: String(x.zoning || '').trim(), useCode: String(x.useCode || '').split(/\s+-\s+/)[0].trim(),
    })),
    controls: LOCFX_CONTROLS[mode],
    opts: { what: 'sale price', noun: 'sale' },
  });
  const waiting = `Fitting the location model on ${plural(recs.length, 'sale')}… (needs at least ${LOCFX_MIN_N}).`;
  const half = (part) => {
    if (result == null) return null;
    return result.ok ? { ok: true, ...result[part] } : { ok: false, caption: result.reason };
  };
  const a = surfaceMap(`${page}-${mode}-locfx`, `${setName} – location effect on sale price`, recs, half('effect'), waiting);
  const b = surfaceMap(`${page}-${mode}-locunc`, `${setName} – location effect uncertainty (95% band)`, recs, half('unc'), waiting);
  if (!a.linked) { linkMaps(a, b); a.linked = true; }
  return [a, b];
}

/** A page's map tabs: [label, () => maps]. */
function mapTabs(rows) {
  const set = page === 'adf' ? 'ADF' : 'CMS';
  const k = (name) => `${page}-${mode}-${name}`;
  const tabs = [['Price & year', () => {
    const a = priceMap(k('price'), rows, set);
    const b = yearMap(k('year'), rows, set);
    if (!a.linked) { linkMaps(a, b); a.linked = true; }
    return [a, b];
  }]];
  if (page === 'adf') {
    tabs.push(['Isovalue', () => [isovalueMap(k('iso'), rows, set)]]);
    tabs.push(['Location effect', () => locationMaps(rows, set)]);
  }
  return tabs;
}

// --- page layout ----------------------------------------------------------------

function tabStrip(labels, active, onPick, aria) {
  const nav = document.createElement('div');
  nav.className = 'row-tabs';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', aria);
  for (const label of labels) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(label === active));
    b.className = `row-tab${label === active ? ' is-on' : ''}`;
    b.textContent = label;
    b.addEventListener('click', () => onPick(label));
    nav.appendChild(b);
  }
  return nav;
}

function pickSub(row, label) {
  subTabs[`${page}|${mode}|${row}`] = label;
  writeOpts();
  render();
}
const subOf = (row) => subTabs[`${page}|${mode}|${row}`];

function renderPage(rows) {
  // Maps on top.
  const mt = mapTabs(rows);
  const mAct = mt.find(([l]) => l === subOf('map')) || mt[0];
  const mapSec = document.createElement('section');
  mapSec.className = 'page-row';
  const mapRow = document.createElement('div');
  mapRow.className = 'chart-pair';
  const shown = mAct[1]();
  mapRow.append(...shown.map((m) => m.figure));
  mapSec.append(tabStrip(mt.map(([l]) => l), mAct[0], (l) => pickSub('map', l), 'Maps'), mapRow);
  $grid.appendChild(mapSec);
  requestAnimationFrame(() => { for (const m of shown) m.resize(); });

  // Charts below, two to a tab.
  const charts = chartsFor(rows);
  const labels = [...new Set(charts.map(([l]) => l))];
  const cAct = labels.includes(subOf('chart')) ? subOf('chart') : labels[0];
  const chartSec = document.createElement('section');
  chartSec.className = 'page-row';
  const pair = document.createElement('div');
  pair.className = 'chart-pair';
  pair.append(...charts.filter(([l]) => l === cAct).map(([, c]) => c));
  chartSec.append(tabStrip(labels, cAct, (l) => pickSub('chart', l), 'Charts'), pair);
  $grid.appendChild(chartSec);
}

/** Reflect the mode and page in the switches, the heading and which options apply. */
function syncMode() {
  $modeLand.classList.toggle('is-on', mode === 'land');
  $modeBldg.classList.toggle('is-on', mode === 'bldg');
  $modeLand.setAttribute('aria-pressed', String(mode === 'land'));
  $modeBldg.setAttribute('aria-pressed', String(mode === 'bldg'));
  if ($title) $title.textContent = mode === 'bldg' ? 'Building Sales Charts' : 'Land Sales Charts';
  for (const el of document.querySelectorAll('.land-opt')) {
    el.hidden = mode === 'bldg';
  }
  for (const b of $pageTabs.querySelectorAll('[data-page]')) {
    const on = b.dataset.page === page;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  }
}

function render() {
  syncMode();
  // Counted, not just dropped. A chart that silently sheds half its
  // sales reads as a thin market rather than a cleaned one, and the
  // header has to be able to say which happened.
  let builtSeen = 0;
  const landMode = mode === 'land';
  const near = records.filter((r) => {
    // Far-flung is a statement about the SALE (a scattered portfolio deal
    // whose blended rate is not a local comp), so it applies to both sets.
    if ($dropFarFlung.checked && r.farFlung) return false;
    if (!landMode) return Number(r.pricePerBldgSf) > 0;
    if ($landOnly.checked && !r.isLand) return false;
    if (r.alreadyBuilt) {
      builtSeen += 1;
      if ($dropBuilt.checked) return false;
    }
    return true;
  });
  const ticked = near.filter((r) => r.selected);
  const rows = page === 'adf' ? near : ticked;

  $grid.textContent = '';
  if (!received) {
    $sub.textContent = 'Waiting for the Sales Analysis tab…';
    return;
  }
  const noun = landMode ? ($landOnly.checked ? 'land sale' : 'sale') : 'improved sale';
  const builtNoun = `already-built sale${builtSeen === 1 ? '' : 's'}`;
  // Said either way round: excluded is a number the reader needs to
  // judge the sample, and included is a warning that the land rates on
  // screen are partly house prices.
  const builtNote = !landMode || builtSeen === 0 ? ''
    : $dropBuilt.checked ? ` ${builtSeen} ${builtNoun} excluded.`
    : ` ⚠ Includes ${builtSeen} ${builtNoun} — these are house prices, not land prices.`;
  const unticked = near.length - ticked.length;
  const setNote = page === 'adf'
    ? ` ADF: every sale the search returned${unticked ? `, including ${unticked} unticked in the grid` : ''}.`
    : ` CMS: the sales ticked in the grid${unticked ? ` (${unticked} unticked left out)` : ''}.`;
  $sub.textContent = rows.length
    ? `${plural(rows.length, noun)} from the current grid filter.${setNote}${builtNote}`
    : `No ${noun}s in the current grid filter.${builtNote}`;

  if (!rows.length) {
    $grid.appendChild(emptyCard(
      'Nothing to chart',
      !landMode
        ? 'These charts need $/Bldg SF, which needs a building area — from the export’s '
          + 'Living Area or the assessment record. Vacant land has none by design. Widen the '
          + 'grid filter, or switch back to the Land charts.'
        : builtSeen && $dropBuilt.checked
          ? 'Every sale in the current filter was flagged already-built — a finished house sold while the roll still read vacant. Untick "Exclude already-built" to chart them anyway, but read the result as improved sales, not land.'
          : $landOnly.checked
            ? 'No vacant-land sales are in the current filter. Untick "Land sales only" to chart every sale shown in the grid.'
            : 'The grid filter is currently showing no sales.',
    ));
    return;
  }
  renderPage(rows);
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
$modeLand.addEventListener('click', () => { mode = 'land'; writeOpts(); render(); });
$modeBldg.addEventListener('click', () => { mode = 'bldg'; writeOpts(); render(); });
for (const b of $pageTabs.querySelectorAll('[data-page]')) {
  b.addEventListener('click', () => { page = b.dataset.page; writeOpts(); render(); });
}
$freeze.addEventListener('change', () => {
  $status.textContent = $freeze.checked
    ? 'Frozen — updates from the Sales Analysis tab are paused.'
    : '';
  if (!$freeze.checked) channel.postMessage({ type: 'request' });
});
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { for (const m of maps.values()) m.resize(); }, 150);
});

readOpts();
render();

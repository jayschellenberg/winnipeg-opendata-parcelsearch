/*
 * The three ADF Overview maps the land dashboard draws (2026-11-01): the
 * isovalue surface, the location effect and its uncertainty -- a port of
 * appraisal-templates/base-files/helpers.R sections 28, 28b and 28c, so the
 * site and the signed exhibits follow the same rules:
 *
 *   * BLANK BEYOND THE SALES. A cell farther than the mask from every sale is
 *     not drawn. The automatic mask is 2 x the 90th-percentile nearest-sale
 *     spacing, at least 1/25 of the sales' span, held to 300 m - 5 km.
 *   * TOO FEW SALES DRAW NO SURFACE, and say why: 15 for the isovalue map,
 *     150 for the location model (a location smooth beside several controls
 *     on a thin set fits noise).
 *   * The isovalue value is time-adjusted by the set's OWN trend -- here a
 *     proportional one (log value on date), where the template uses dollars:
 *     see ownLogTrendPerDay for why.
 *   * The location model is log(price) ~ controls + s(x, y); the map is the
 *     s(x, y) term alone, as +/- % against the sales' average location. A
 *     control recorded for under half the sales is left out and named; one
 *     recorded for most keeps every sale (the median plus a not-recorded
 *     flag). A category under 10 sales folds into Other.
 *   * Isovalue bands span the 2nd-98th percentile of the surface; effect
 *     bands are split at 0 and set per side, never below -95%, on the
 *     smallest of 5/10/20/25/50/100% that keeps 12 bands, coloured by
 *     distance from 0; uncertainty bands run from 0 on a nice step, viridis.
 *
 * Two differences from the R, both forced by drawing in the browser: cells
 * are drawn as squares (no isoband clipping), so the edge steps at the cell
 * size rather than following the mask circles, and the band edges are drawn
 * along cell edges rather than as interpolated contours.
 *
 * Pure: the charts page runs this in a worker (lib/locationMaps.worker.js).
 */

import { fitPenalised } from './spatialSmooth.js';

export const ISO_MIN_N = 15;
export const LOCFX_MIN_N = 150;
export const LOCFX_MIN_LEVEL = 10;
export const ISO_GRID = 160;
const MS_PER_DAY = 86400000;

// ---------- geometry ---------------------------------------------------------

/** Local metres about (lon0, lat0), as helpers.R .iso_proj does. */
export function projector(lon0, lat0) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110540;
  return {
    fwd: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky],
    inv: (x, y) => [lon0 + x / kx, lat0 + y / ky],
  };
}

/** A bucket grid over points for nearest-distance queries within `reach`. */
function pointIndex(pts, reach) {
  const size = Math.max(reach, 1);
  const cells = new Map();
  const key = (i, j) => `${i},${j}`;
  pts.forEach((p, n) => {
    const k = key(Math.floor(p[0] / size), Math.floor(p[1] / size));
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(n);
  });
  return {
    /** Nearest distance to any point, or Infinity if none within `reach`. */
    nearest(x, y, skip = -1) {
      const ci = Math.floor(x / size); const cj = Math.floor(y / size);
      let best = Infinity;
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (let j = cj - 1; j <= cj + 1; j++) {
          for (const n of cells.get(key(i, j)) || []) {
            if (n === skip) continue;
            const d = Math.hypot(pts[n][0] - x, pts[n][1] - y);
            if (d < best) best = d;
          }
        }
      }
      return best <= reach ? best : Infinity;
    },
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h); const hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}
const sortNum = (a) => a.filter(Number.isFinite).sort((p, q) => p - q);

/** The automatic mask (metres), helpers.R appraisal_iso_auto_mask(). */
export function autoMask(xy) {
  if (xy.length < 2) return 1000;
  // Nearest-neighbour spacing; brute force in buckets of 5 km, the cap.
  const idx = pointIndex(xy, 5000);
  const nn = [];
  xy.forEach((p, i) => {
    let d = idx.nearest(p[0], p[1], i);
    if (!Number.isFinite(d)) d = 5000;
    if (d > 0) nn.push(d);
  });
  if (!nn.length) return 1000;
  const xs = xy.map((p) => p[0]); const ys = xy.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const q90 = quantile(sortNum(nn), 0.9);
  return Math.round(Math.min(5000, Math.max(300, 2 * q90, span / 25)) / 50) * 50;
}

/** The grid, helpers.R .iso_grid(): cells at most half the mask, the kept ones within the mask. */
export function surfaceGrid(lonlat, { maskM = null, gridN = ISO_GRID } = {}) {
  const lon0 = lonlat.reduce((s, p) => s + p[0], 0) / lonlat.length;
  const lat0 = lonlat.reduce((s, p) => s + p[1], 0) / lonlat.length;
  const pr = projector(lon0, lat0);
  const xy = lonlat.map(([lo, la]) => pr.fwd(lo, la));
  const maskAuto = !(Number.isFinite(maskM) && maskM > 0);
  const mask = maskAuto ? autoMask(xy) : maskM;
  const xs = xy.map((p) => p[0]); const ys = xy.map((p) => p[1]);
  const x0 = Math.min(...xs) - mask; const x1 = Math.max(...xs) + mask;
  const y0 = Math.min(...ys) - mask; const y1 = Math.max(...ys) + mask;
  const ext = Math.max(x1 - x0, y1 - y0);
  const cell = Math.max(ext / (2.5 * gridN), Math.min(ext / gridN, mask / 2));
  const nx = Math.floor((x1 - x0) / cell) + 1;
  const ny = Math.floor((y1 - y0) / cell) + 1;
  const idx = pointIndex(xy, mask);
  const keep = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * cell; const y = y0 + j * cell;
      if (Number.isFinite(idx.nearest(x, y))) keep.push({ i, j, x, y });
    }
  }
  const inside = (lon, lat) => { const [x, y] = pr.fwd(lon, lat); return Number.isFinite(idx.nearest(x, y)); };
  return { pr, xy, mask, maskAuto, cell, x0, y0, nx, ny, keep, inside };
}

// ---------- bands and colours -----------------------------------------------

const RDYLBU = ['#a50026', '#d73027', '#f46d43', '#fdae61', '#fee090', '#ffffbf', '#e0f3f8', '#abd9e9', '#74add1', '#4575b4', '#313695'].reverse();
const VIRIDIS = ['#440154', '#482878', '#3e4a89', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'];

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** A colour at t in [0, 1] along a ramp of hex stops. */
export function rampAt(stops, t) {
  const u = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(u));
  const a = hex2rgb(stops[i]); const b = hex2rgb(stops[i + 1]);
  return rgb2hex(a.map((v, k) => v + (b[k] - v) * (u - i)));
}
const rampN = (stops, n) => Array.from({ length: n }, (_, i) => rampAt(stops, n === 1 ? 0.5 : i / (n - 1)));

/** helpers.R nice_step(): a 1/2/2.5/5 x 10^k step giving about `n` buckets. */
export function niceStep(lo, hi, n) {
  const raw = (hi - lo) / Math.max(1, n);
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

function bandOf(v, breaks) {
  if (!Number.isFinite(v)) return -1;
  const nb = breaks.length - 1;
  for (let i = 1; i < nb; i++) if (v < breaks[i]) return i - 1;
  return nb - 1;
}

const pct = (x, dg = 0) => { const r = Number(x.toFixed(dg)); return r === 0 ? '0%' : `${r > 0 ? '+' : ''}${r.toFixed(dg)}%`; };
const pm = (x, dg = 0) => `±${x.toFixed(dg)}%`;
const fmtM = (m) => Math.round(m).toLocaleString('en-CA');

/** Isovalue bands: 2nd-98th percentile on a nice step, about 12 bands, open ends. */
export function valueBands(z, fmt, nBands = 12) {
  const s = sortNum(z);
  let lo = quantile(s, 0.02); let hi = quantile(s, 0.98);
  if (!(hi > lo)) { lo = s[0] - 1; hi = s[s.length - 1] + 1; }
  const st = niceStep(lo, hi, nBands);
  const b0 = Math.floor(lo / st) * st; const b1 = Math.ceil(hi / st) * st;
  const breaks = [];
  for (let v = b0; v <= b1 + st / 2; v += st) breaks.push(Number(v.toFixed(10)));
  while (breaks.length < 3) breaks.push(breaks[breaks.length - 1] + st);
  const nb = breaks.length - 1;
  const labels = breaks.slice(0, -1).map((v, i) => `${fmt(v)}-${fmt(breaks[i + 1])}`);
  labels[0] = `under ${fmt(breaks[1])}`;
  labels[nb - 1] = `${fmt(breaks[nb - 1])}+`;
  return { breaks, labels, colors: rampN(RDYLBU, nb) };
}

/** Effect bands: split at 0, each side from the data, never below -95%. */
export function effectBands(eff, steps = [5, 10, 20, 25, 50, 100], digits = 0) {
  const s = sortNum(eff);
  const q0 = quantile(s, 0.02); const q1 = quantile(s, 0.98);
  const st0 = steps[0];
  const lo = Math.max(Math.min(q0, -st0), -95); const hi = Math.max(q1, st0);
  const count = (st) => Math.ceil(hi / st) - Math.floor(lo / st);
  const st = steps.find((v) => count(v) <= 12) ?? 100;
  const breaks = [];
  for (let v = Math.floor(lo / st) * st; v <= Math.ceil(hi / st) * st + st / 2; v += st) breaks.push(v);
  const nb = breaks.length - 1;
  const labels = breaks.slice(0, -1).map((v, i) => `${pct(v, digits)} to ${pct(breaks[i + 1], digits)}`);
  labels[0] = `under ${pct(breaks[1], digits)}`;
  labels[nb - 1] = `${pct(breaks[nb - 1], digits)} or more`;
  const maxAbs = Math.max(...breaks.map(Math.abs));
  const colors = breaks.slice(0, -1).map((v, i) => rampAt(RDYLBU, ((v + breaks[i + 1]) / 2 / maxAbs + 1) / 2));
  return { breaks, labels, colors };
}

/** Uncertainty bands: from 0 on a nice step, about 6 bands, viridis. */
export function uncertaintyBands(unc) {
  const uq = quantile(sortNum(unc), 0.98);
  const st = niceStep(0, uq, 6);
  const breaks = [];
  for (let v = 0; v <= Math.ceil(uq / st) * st + st / 2; v += st) breaks.push(Number(v.toFixed(10)));
  while (breaks.length < 3) breaks.push(breaks[breaks.length - 1] + st);
  const nb = breaks.length - 1;
  const f = (v) => `±${Number(v.toFixed(4))}%`;
  const labels = breaks.slice(0, -1).map((v, i) => `${f(v)} to ${f(breaks[i + 1])}`);
  labels[nb - 1] = `${f(breaks[nb - 1])} or more`;
  return { breaks, labels, colors: rampN(VIRIDIS, nb) };
}

/**
 * The kept cells as GeoJSON: one rectangle per horizontal run of cells in the
 * same band (so a 20,000-cell surface is a few thousand features), each with
 * its band colour, plus the band edges as lines along the cell edges.
 */
export function bandFeatures(gr, z, bands) {
  const { pr, cell, x0, y0, nx } = gr;
  const byRow = new Map();
  const band = new Map();
  gr.keep.forEach((c, n) => {
    const b = bandOf(z[n], bands.breaks);
    if (b < 0) return;
    band.set(c.j * nx + c.i, b);
    if (!byRow.has(c.j)) byRow.set(c.j, []);
    byRow.get(c.j).push({ i: c.i, b });
  });
  const half = cell / 2;
  const corner = (x, y) => pr.inv(x, y).map((v) => Number(v.toFixed(6)));
  const fills = [];
  for (const [j, cells] of byRow) {
    cells.sort((a, b) => a.i - b.i);
    let run = null;
    const flush = () => {
      if (!run) return;
      const xa = x0 + run.a * cell - half; const xb = x0 + run.b * cell + half;
      const ya = y0 + j * cell - half; const yb = y0 + j * cell + half;
      fills.push({
        type: 'Feature',
        properties: { color: bands.colors[run.band], band: run.band },
        geometry: { type: 'Polygon', coordinates: [[corner(xa, ya), corner(xb, ya), corner(xb, yb), corner(xa, yb), corner(xa, ya)]] },
      });
    };
    for (const c of cells) {
      if (run && c.i === run.b + 1 && c.b === run.band) run.b = c.i;
      else { flush(); run = { a: c.i, b: c.i, band: c.b }; }
    }
    flush();
  }
  const segs = [];
  for (const [k, b] of band) {
    const i = k % nx; const j = Math.floor(k / nx);
    const x = x0 + i * cell; const y = y0 + j * cell;
    const right = band.get(k + 1);
    if (right != null && right !== b) segs.push([corner(x + half, y - half), corner(x + half, y + half)]);
    const up = band.get(k + nx);
    if (up != null && up !== b) segs.push([corner(x - half, y + half), corner(x + half, y + half)]);
  }
  return {
    fills: { type: 'FeatureCollection', features: fills },
    lines: { type: 'FeatureCollection', features: segs.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: segs } }] : [] },
    legend: bands.labels.map((label, i) => ({ label, color: bands.colors[i] })).reverse(),
  };
}

// ---------- the isovalue surface ---------------------------------------------

/**
 * The set's own linear trend in value per day, as helpers.R appraisal_iso_n1()
 * fits it; 0 when there is none to fit.
 */
export function ownTrendPerDay(sales, { log = false } = {}) {
  const pts = sales.filter((s) => Number.isFinite(s.dateMs) && s.value > 0);
  if (pts.length < 3) return 0;
  const xs = pts.map((s) => s.dateMs / MS_PER_DAY); const ys = pts.map((s) => (log ? Math.log(s.value) : s.value));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length; const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0; let sxx = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
  return sxx > 1e-9 * xs.length ? sxy / sxx : 0;
}

/**
 * The set's own trend as a PROPORTION per day: the slope of log(value) on the
 * date. The isovalue map adjusts with this, not with ownTrendPerDay's dollars.
 * A dollar trend fitted across a set running from $5,000 to $5,000,000 an acre
 * (bare land beside house lots, the ordinary Manitoba search) carried a fifth of
 * a real Springfield set to zero or below -- 247 of 1,063 sales -- and the
 * surface then had to drop them; a proportional rate cannot reach zero. The
 * land template's appraisal_iso_n1() still adjusts in dollars (2026-11-01).
 */
export function ownLogTrendPerDay(sales) {
  return ownTrendPerDay(sales, { log: true });
}

/**
 * The isovalue map.
 * @param sales [{lon, lat, value, dateMs}] -- value is the unit price.
 * @param opts {effMs, subject: {lng, lat} | null, unit: '$/ac', digits (2 for $/SF)}
 */
export function isovalueSurface(sales, { effMs = null, subject = null, unit = '$/ac', digits = 0, noun = 'sale' } = {}) {
  // Digits, not a formatter: the options cross a worker boundary.
  const fmt = (v) => `$${v.toLocaleString('en-CA', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  const ok = sales.filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat) && s.value > 0);
  const n = ok.length;
  const fail = (reason) => ({ ok: false, n, reason, caption: reason, captionShort: reason });
  if (n < ISO_MIN_N) return fail(`${n} sale${n === 1 ? '' : 's'} with a location and a value; an isovalue surface needs at least ${ISO_MIN_N}.`);
  if (new Set(ok.map((s) => `${s.lon.toFixed(5)},${s.lat.toFixed(5)}`)).size < 4) return fail('Fewer than four distinct sale locations; no surface can be drawn.');
  const rate = ownLogTrendPerDay(ok);
  const adj = ok.map((s) => (Number.isFinite(effMs) && Number.isFinite(s.dateMs) && rate !== 0
    ? s.value * Math.exp(rate * ((effMs - s.dateMs) / MS_PER_DAY)) : s.value));
  const keepAdj = ok.map((s, i) => ({ ...s, adj: adj[i] }));
  const gr = surfaceGrid(keepAdj.map((s) => [s.lon, s.lat]));
  if (!gr.keep.length) return fail('No part of the surface lies within the mask distance of a sale.');
  const k = Math.max(5, Math.min(60, Math.floor(keepAdj.length / 3)));
  const scaleKm = (p) => [p[0] / 1000, p[1] / 1000];
  const model = fitPenalised(keepAdj.map((s) => Math.log(s.adj)), [
    { kind: 'smooth', name: 'xy', values: gr.xy.map(scaleKm), k, d: 2 },
  ]);
  if (!model) return fail('The smoothed surface could not be fitted.');
  const b0 = model.beta[0];
  const z = gr.keep.map((c) => Math.exp(b0 + model.predictTerm('xy', scaleKm([c.x, c.y]), { se: false }).fit));
  const bands = valueBands(z, fmt);
  const layers = bandFeatures(gr, z, bands);
  let subjectValue = null; let subjectInside = false;
  if (subject && Number.isFinite(subject.lng) && Number.isFinite(subject.lat)) {
    subjectValue = Math.exp(b0 + model.predictTerm('xy', scaleKm(gr.pr.fwd(subject.lng, subject.lat)), { se: false }).fit);
    subjectInside = gr.inside(subject.lng, subject.lat);
  }
  const unitWord = unit.replace(/^\$/, '');
  const pctYear = 100 * (Math.exp(rate * 365) - 1);
  const effText = Number.isFinite(effMs) ? new Date(effMs).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null;
  const how = rate !== 0 && effText
    ? `time-adjusted to ${effText} at ${pctYear >= 0 ? '+' : ''}${pctYear.toFixed(1)}% per year (the set's own trend, fitted on log value)`
    : 'not time-adjusted (the set supports no market trend)';
  let caption = `Smoothed (thin-plate spline) ${unit} surface from ${keepAdj.length} ${noun}s; areas more than ${fmtM(gr.mask)} m from a ${noun} are left blank${gr.maskAuto ? ' (auto)' : ''}.`;
  if (subjectValue != null) caption += ` Subject reads about ${fmt(subjectValue)}${unitWord}${subjectInside ? '.' : ' (outside the mask: an extrapolation).'}`;
  caption += ` Values ${how}.`;
  const captionShort = [
    `${keepAdj.length} ${noun}s`, `blank beyond ${fmtM(gr.mask)} m`, rate !== 0 ? 'time-adjusted' : 'not time-adj.',
    subjectValue != null ? `subject ${subjectInside ? 'about' : 'extrapolated'} ${fmt(subjectValue)}${unitWord}` : null,
  ].filter(Boolean).join(' · ');
  return { ok: true, n: keepAdj.length, mask: gr.mask, maskAuto: gr.maskAuto, ratePerDay: rate, pctPerYear: pctYear, subjectValue, subjectInside, caption, captionShort, ...layers };
}

// ---------- the location effect ----------------------------------------------

/**
 * Fit the location model and build the effect and uncertainty layers.
 * @param sales [{lon, lat, price, ...control columns}]
 * @param controls [{col, kind: 'smooth' | 'factor', label, log}]
 */
export function locationEffect(sales, controls, { subject = null, what = 'sale price', noun = 'sale', minN = LOCFX_MIN_N } = {}) {
  const ok = sales.filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat) && s.price > 0);
  const n = ok.length;
  const fail = (reason) => ({ ok: false, n, reason, effect: { caption: reason, captionShort: reason }, unc: { caption: reason, captionShort: reason } });
  if (n < minN) return fail(`${n} sale${n === 1 ? '' : 's'} with a price and a location; a location-effect map needs at least ${minN}.`);
  const terms = []; const used = []; const dropped = [];
  for (const ct of controls) {
    const lab = ct.label || ct.col;
    const raw = ok.map((s) => s[ct.col]);
    if (ct.kind === 'factor') {
      let v = raw.map((x) => (x == null || String(x).trim() === '' ? 'Not recorded' : String(x).trim()));
      const tb = new Map(); for (const x of v) tb.set(x, (tb.get(x) || 0) + 1);
      v = v.map((x) => (tb.get(x) < LOCFX_MIN_LEVEL ? 'Other' : x));
      if (new Set(v).size < 2) { dropped.push(`${lab} (one value)`); continue; }
      terms.push({ kind: 'factor', name: ct.col, values: v }); used.push(lab);
    } else {
      let x = raw.map((r) => {
        const v = r == null || r === '' ? NaN : Number(r);
        return Number.isFinite(v) && (!ct.log || v > 0) ? (ct.log ? Math.log(v) : v) : NaN;
      });
      const rec = x.filter(Number.isFinite);
      const cov = rec.length / n;
      if (cov < 0.5) { dropped.push(`${lab} (${Math.round(100 * cov)}% recorded)`); continue; }
      const nd = new Set(rec).size;
      if (nd < 4) { dropped.push(`${lab} (too few distinct values)`); continue; }
      let label = lab;
      if (rec.length < n) {
        terms.push({ kind: 'factor', name: `${ct.col}_na`, values: x.map((v) => (Number.isFinite(v) ? 'recorded' : 'not recorded')) });
        const med = quantile(sortNum(rec), 0.5);
        x = x.map((v) => (Number.isFinite(v) ? v : med));
        label = `${lab} (${Math.floor(100 * cov)}% recorded)`;
      }
      // Scale to unit spread so one knot rule and one lambda grid serve all.
      const s = sortNum(x); const sp = (s[s.length - 1] - s[0]) || 1;
      terms.push({ kind: 'smooth', name: ct.col, values: x.map((v) => [(v - s[0]) / sp]), k: Math.min(10, nd), d: 1 });
      used.push(label);
    }
  }
  const gr = surfaceGrid(ok.map((s) => [s.lon, s.lat]));
  const kxy = Math.max(20, Math.min(80, Math.floor(n / 8)));
  const scaleKm = (p) => [p[0] / 1000, p[1] / 1000];
  terms.push({ kind: 'smooth', name: 'xy', values: gr.xy.map(scaleKm), k: kxy, d: 2 });
  const model = fitPenalised(ok.map((s) => Math.log(s.price)), terms);
  if (!model) return fail('The location model could not be fitted.');
  if (!gr.keep.length) return fail('No part of the surface lies within the mask distance of a sale.');
  const at = (x, y) => model.predictTerm('xy', scaleKm([x, y]));
  const cellFits = gr.keep.map((c) => at(c.x, c.y));
  const eff = cellFits.map((t) => 100 * (Math.exp(t.fit) - 1));
  const unc = cellFits.map((t) => 100 * (Math.exp(1.96 * t.se) - 1));
  const effLayers = bandFeatures(gr, eff, effectBands(eff));
  const uncLayers = bandFeatures(gr, unc, uncertaintyBands(unc));
  let sEff = null; let sUnc = null; let sIn = false;
  if (subject && Number.isFinite(subject.lng) && Number.isFinite(subject.lat)) {
    const [x, y] = gr.pr.fwd(subject.lng, subject.lat);
    const t = at(x, y);
    sEff = 100 * (Math.exp(t.fit) - 1); sUnc = 100 * (Math.exp(1.96 * t.se) - 1); sIn = gr.inside(subject.lng, subject.lat);
  }
  const caps = locationCaptions({ n, used, dropped, mask: gr.mask, maskAuto: gr.maskAuto, devExpl: model.devExpl, sEff, sUnc, sIn, what, noun });
  return {
    ok: true, n, used, dropped, mask: gr.mask, maskAuto: gr.maskAuto, devExpl: model.devExpl,
    subjectEffect: sEff, subjectUnc: sUnc, subjectInside: sIn,
    effect: { ...effLayers, caption: caps.effect, captionShort: caps.effectShort },
    unc: { ...uncLayers, caption: caps.unc, captionShort: caps.uncShort },
  };
}

/** helpers.R appraisal_location_effect_captions(). */
export function locationCaptions({ n, used, dropped, mask, maskAuto, devExpl, sEff, sUnc, sIn, what = 'sale price', noun = 'sale' }) {
  const pw = what.replace(/^.* /, ''); const nn = `${noun}s`;
  const m = `${fmtM(mask)} m${maskAuto ? ' (auto)' : ''}`;
  const ctrl = used.length ? `Net of ${used.join(', ')}.` : 'No controls could be fitted.';
  const drp = dropped.length ? ` Left out: ${dropped.join('; ')}.` : '';
  const subj = sEff != null ? ` Subject: ${pct(sEff)} vs. the area average (${pm(sUnc)} at 95%)${sIn ? '' : ', outside the mask: an extrapolation'}.` : '';
  const effect = `Location effect on ${what} from ${n} ${nn}: the share of ${pw} that comes from where a ${noun} is, vs. the ${nn}' average location. ${ctrl}${drp} Blank beyond ${m}.${subj} Model explains ${Math.round(100 * devExpl)}% of the variation in log ${pw}.`;
  const unc = `Width of the 95% band round the location effect (±%, pointwise and model-based). Dark = well supported by nearby ${nn}; yellow = few ${nn}, treat with caution. ${n} ${nn}; blank beyond ${m}.${subj}`;
  const ss = sEff != null ? `subject ${pct(sEff)} ${pm(sUnc)}` : null;
  return {
    effect, unc,
    effectShort: [`${n} ${nn}`, `net of ${used.length} controls`, `blank beyond ${fmtM(mask)} m`, ss].filter(Boolean).join(' · '),
    uncShort: ['95% band width', `${n} ${nn}`, ss].filter(Boolean).join(' · '),
  };
}

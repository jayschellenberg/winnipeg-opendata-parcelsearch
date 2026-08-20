/*
 * The maths behind the land-sales charts.
 *
 * Pure: no DOM, no fetch, no app imports, so it runs under plain node
 * like the rest of lib/. src/charts/ owns the page; lib/chartRender.js
 * owns the pixels; this file owns the numbers.
 *
 * The one modelling decision worth stating up front: a chart point is a
 * SALE, not a grid row. A three-parcel assembly renders as three rows
 * in the table (that is what an appraiser wants to read) but it is one
 * transaction, and letting it contribute three points would triple its
 * weight in every trendline. saleRecordsFromRows collapses by
 * instrument, keeping the group-level figures the grid already stamps.
 */

/** Vacant-land use codes: the V prefix, plus condo-vacant. Kept in step
 *  with isVacantUseCode in lib/salesFilters.js — duplicated rather than
 *  imported so this module stays dependency-free. */
export function isLandUseCode(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) return false;
  return c.startsWith('V') || c === 'CNVAC';
}

/**
 * Collapse joined grid rows to one record per sale.
 *
 * @param {Array} rows        [{ assess: Feature }]
 * @param {object} opts
 * @param {(iso: string) => number|null} opts.parseDate ISO date -> ms
 * @returns {Array<{instrument, date, price, landSf, acres, pricePerSf,
 *   pricePerAcre, pricePerLot, useCode, zoning, lots, isLand, roll, address,
 *   alreadyBuilt}>}
 */
export function saleRecordsFromRows(rows, { parseDate } = {}) {
  const byInstrument = new Map();
  for (const row of rows || []) {
    const p = row?.assess?.properties;
    if (!p) continue;
    const key = String(p._saleInstrument ?? '');
    if (byInstrument.has(key)) continue;   // one point per transaction
    const price = Number(p._salePrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    const ms = parseDate ? parseDate(p._saleDate) : Date.parse(p._saleDate);
    byInstrument.set(key, {
      instrument: key,
      roll: p.roll_number || '',
      address: p.full_address || '',
      date: Number.isFinite(ms) ? ms : null,
      price,
      landSf: Number(p._pricePerSf) > 0 ? price / Number(p._pricePerSf) : null,
      acres: Number.isFinite(Number(p._saleAcres)) ? Number(p._saleAcres) : null,
      pricePerSf: Number.isFinite(Number(p._pricePerSf)) ? Number(p._pricePerSf) : null,
      pricePerAcre: Number.isFinite(Number(p._pricePerAcre)) ? Number(p._pricePerAcre) : null,
      pricePerLot: Number.isFinite(Number(p._pricePerLot)) ? Number(p._pricePerLot) : null,
      useCode: p._saleUseCode || p.property_use_code || '',
      zoning: p._saleZoning || p.zoning || '',
      lots: Number(p._saleGroupSize) || 1,
      dist: Number.isFinite(Number(p._dist)) ? Number(p._dist) : null,
      isLand: isLandUseCode(p._saleUseCode || p.property_use_code || ''),
      farFlung: !!p._farFlung,
      // The permit record contradicts a vacant use code: a new-build
      // permit closed 6+ months before the sale, so a finished house
      // changed hands with the lot. Its rate is a house price wearing a
      // land label — src/charts/main.js drops these by default.
      alreadyBuilt: p._buildVerdict === 'already-built',
    });
  }
  return [...byInstrument.values()];
}

/**
 * Ordinary least squares. Returns null when fewer than two points share
 * no x-variance — a vertical fit is not a trend, it is one date.
 *
 * @returns {{slope: number, intercept: number, r2: number, predict: Function}|null}
 */
export function fitLinear(points) {
  const pts = (points || []).filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0, sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    sxx += dx * dx;
    sxy += dx * (p.y - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssTot = 0, ssRes = 0;
  for (const p of pts) {
    const yh = slope * p.x + intercept;
    ssTot += (p.y - my) ** 2;
    ssRes += (p.y - yh) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2, n, predict: (x) => slope * x + intercept };
}

/**
 * Nice round axis bounds and tick positions for a value range.
 *
 * Always spans zero-or-min to max with a little headroom, because a
 * land-rate chart whose y-axis starts at $18/sf exaggerates a flat
 * market into a dramatic one.
 */
export function niceScale(min, max, targetTicks = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad / 2;
    max += pad / 2;
  }
  const span = max - min;
  const rawStep = span / Math.max(1, targetTicks);
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  // Guard the loop against a pathological step; 1e4 is far more ticks
  // than any chart draws and simply stops a hang on absurd input.
  for (let v = lo, i = 0; v <= hi + step / 2 && i < 1e4; v += step, i++) {
    ticks.push(Number(v.toFixed(10)));
  }
  return { min: lo, max: hi, ticks };
}

/** Dot radius that thins out as the set grows, so 400 sales stay
 *  readable without hiding a 12-sale set. */
export function dotRadius(count) {
  if (count <= 20) return 5;
  if (count <= 60) return 4;
  if (count <= 150) return 3.2;
  return 2.6;
}

/**
 * Median — the headline an appraiser trusts over a mean on a small,
 * skewed comp set. Null on an empty list.
 */
export function median(values) {
  const v = (values || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Annual rate of change implied by a time fit, as a percentage of the
 * period's median value. Slope alone is $/ms, which means nothing to
 * read; "+4.2%/yr" does. Null when there is no usable fit.
 */
export function annualTrendPct(fit, medianValue) {
  if (!fit || !Number.isFinite(medianValue) || medianValue <= 0) return null;
  const perYear = fit.slope * 365.25 * 24 * 60 * 60 * 1000;
  return (perYear / medianValue) * 100;
}

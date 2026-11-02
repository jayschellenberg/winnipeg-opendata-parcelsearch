// Unit tests for lib/spatialSmooth.js and lib/locationMaps.js -- the
// penalised-spline model behind the Sales Charts tab's ADF isovalue and
// location-effect maps (2026-11-01). The land template fits the same model
// with mgcv; these hold the browser version to an mgcv fit of the same data
// rather than to "the map looks plausible".
//
// The fixture (test/fixtures/mgcv-location-ref.csv) is 220 simulated sales:
//   lp = 10 + 0.4 sin(x/8) + 0.3 cos(y/6) - 0.5 log(acres) + 0.05 yr + zone + e
// fitted in R with mgcv 1.9.4 as
//   gam(lp ~ s(lac, k = 9) + s(yr, k = 9) + zone + s(x, y, k = 50), method = "REML")
// and carrying mgcv's s(x, y) term (fx) and its standard error (se) per sale.
//
// Run: cd web && node test/spatialSmooth.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  cholesky, cholSolve, nullSpaceOfTransposed, chooseKnots, fitPenalised,
} from '../src/lib/spatialSmooth.js';
import {
  autoMask, effectBands, valueBands, uncertaintyBands, isovalueSurface, locationEffect,
  ownTrendPerDay, niceStep, ISO_MIN_N, LOCFX_MIN_N,
} from '../src/lib/locationMaps.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

const cor = (a, b) => {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n; const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
};
const med = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };

// ---------- linear algebra --------------------------------------------------

{
  const A = [[4, 2, 0.4], [2, 5, 1], [0.4, 1, 3]];
  const L = cholesky(A);
  const x = cholSolve(L, [1, 2, 3]);
  const back = A.map((r) => r.reduce((s, v, j) => s + v * x[j], 0));
  ok(back.every((v, i) => Math.abs(v - [1, 2, 3][i]) < 1e-12), 'Cholesky solve reproduces b');
  ok(cholesky([[1, 2], [2, 1]]) === null, 'a matrix that is not positive definite is refused, not factored');
}
{
  // The null space of T' is orthogonal to every column of T and orthonormal.
  const T = [[1, 0, 0], [1, 1, 0], [1, 0, 1], [1, 1, 1], [1, 2, 0.5]];
  const Z = nullSpaceOfTransposed(T);
  ok(Z.length === 5 && Z[0].length === 2, 'null space of T\' is k x (k - m)');
  for (let c = 0; c < 2; c++) {
    for (let j = 0; j < 3; j++) {
      const d = T.reduce((s, row, i) => s + row[j] * Z[i][c], 0);
      ok(Math.abs(d) < 1e-12, `null-space column ${c} is orthogonal to T column ${j}`);
    }
    const nrm = Z.reduce((s, row) => s + row[c] ** 2, 0);
    ok(Math.abs(nrm - 1) < 1e-12, `null-space column ${c} has unit length`);
  }
}
{
  // Knots are deterministic and collapse duplicate points.
  const pts = [[0, 0], [0, 0], [1, 0], [0, 1], [5, 5], [2, 2]];
  const a = chooseKnots(pts, 3);
  const b = chooseKnots(pts, 3);
  ok(JSON.stringify(a) === JSON.stringify(b), 'knots are the same on every call');
  ok(chooseKnots(pts, 10).length === 5, 'duplicate points give one knot');
  ok(a.some((p) => p[0] === 5 && p[1] === 5), 'farthest-point sampling reaches the outlying point');
}

// ---------- against mgcv ----------------------------------------------------

{
  const rows = readFileSync(path.join(here, 'fixtures', 'mgcv-location-ref.csv'), 'utf8')
    .trim().split(/\r?\n/).slice(1).map((l) => l.split(',').map((v) => v.replace(/"/g, '')));
  const col = (i) => rows.map((r) => Number(r[i]));
  const [x, y, lac, yr] = [0, 1, 2, 3].map(col);
  const zone = rows.map((r) => r[4]);
  const lp = col(5); const fx = col(7); const se = col(8);
  const fit = fitPenalised(lp, [
    { kind: 'smooth', name: 'lac', values: lac.map((v) => [v]), k: 9, d: 1 },
    { kind: 'smooth', name: 'yr', values: yr.map((v) => [v]), k: 9, d: 1 },
    { kind: 'factor', name: 'zone', values: zone },
    { kind: 'smooth', name: 'xy', values: x.map((v, i) => [v, y[i]]), k: 50, d: 2 },
  ]);
  ok(fit != null, 'the location model fits');
  const js = x.map((v, i) => fit.predictTerm('xy', [v, y[i]]));
  const r = cor(js.map((t) => t.fit), fx);
  ok(r > 0.995, `the location term follows mgcv's (r = ${r.toFixed(4)})`);
  const mad = js.reduce((s, t, i) => s + Math.abs(t.fit - fx[i]), 0) / js.length;
  ok(mad < 0.03, `the location term is within 0.03 log points of mgcv's on average (${mad.toFixed(4)})`);
  const ratio = med(js.map((t) => t.se)) / med(se);
  ok(ratio > 0.8 && ratio < 1.25, `the standard errors are mgcv's size (median ratio ${ratio.toFixed(3)})`);
  // mgcv explains 95.8% of the variation on this fixture.
  ok(Math.abs(fit.devExpl - 0.958) < 0.01, `deviance explained matches mgcv (${fit.devExpl.toFixed(4)})`);
}

// ---------- the map rules ---------------------------------------------------

{
  // Mask: 300 m floor, 5 km cap, round 50 m.
  ok(autoMask([[0, 0], [10, 0], [0, 10], [10, 10]]) === 300, 'a tight cluster takes the 300 m floor');
  ok(autoMask([[0, 0], [200000, 0], [0, 200000]]) === 5000, 'a sparse set takes the 5 km cap');
  ok(autoMask([[0, 0], [1234, 0], [0, 1234], [1234, 1234]]) % 50 === 0, 'the mask rounds to 50 m');
}
{
  ok(niceStep(0, 100, 10) === 10 && niceStep(0, 23, 10) === 2.5, 'nice steps are 1/2/2.5/5 x 10^k');
  // Effect bands split at 0 and never fall below -95%.
  const eff = Array.from({ length: 200 }, (_, i) => -99 + i * 1.3);
  const b = effectBands(eff);
  ok(b.breaks.includes(0), 'effect bands have an edge at 0');
  ok(b.breaks[0] >= -100 && b.breaks[0] <= -95 + 1e-9 + 5, 'the lowest effect edge is not below -100%');
  ok(b.breaks.length - 1 <= 12, 'effect bands are at most 12');
  ok(b.labels[0].startsWith('under ') && b.labels[b.labels.length - 1].endsWith('or more'), 'effect bands are open at both ends');
  const v = valueBands(Array.from({ length: 100 }, (_, i) => 1000 + i * 10), (n) => `$${n}`);
  ok(v.labels[0].startsWith('under $') && v.labels[v.labels.length - 1].endsWith('+'), 'value bands are open at both ends');
  const u = uncertaintyBands(Array.from({ length: 100 }, (_, i) => i / 10));
  ok(u.breaks[0] === 0, 'uncertainty bands start at 0');
}
{
  // The set's own trend: +$10 a day.
  const day = 86400000;
  const sales = Array.from({ length: 10 }, (_, i) => ({ dateMs: i * 100 * day, value: 1000 + i * 1000 }));
  ok(Math.abs(ownTrendPerDay(sales) - 10) < 1e-9, 'the own trend is the OLS slope per day');
  ok(ownTrendPerDay(sales.slice(0, 2)) === 0, 'two sales support no trend');
}
{
  // Too few sales: no surface, and the reason names the minimum.
  const few = Array.from({ length: ISO_MIN_N - 1 }, (_, i) => ({ lon: -97 + i * 0.01, lat: 50, value: 1000 }));
  const s = isovalueSurface(few);
  ok(!s.ok && s.caption.includes(String(ISO_MIN_N)), 'fewer than 15 sales draw no isovalue surface and say why');
  const fx = locationEffect(few.map((r) => ({ ...r, price: 1000 })), []);
  ok(!fx.ok && fx.reason.includes(String(LOCFX_MIN_N)), 'fewer than 150 sales draw no location effect and say why');
}
{
  // A known east-west gradient: the isovalue surface must read higher in the
  // east than the west, and the location effect must find it NET of size.
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const sales = Array.from({ length: 300 }, () => {
    const lon = -97.5 + rnd(); const lat = 49.8 + rnd() * 0.4;
    // Big parcels in the WEST, the location premium in the EAST: a model that
    // dropped its size control would read the gap backwards.
    const acres = Math.exp(2 - 3 * (lon + 97.5) + rnd() * 0.3);
    const price = Math.exp(11 + 0.8 * (lon + 97.5) + 0.7 * Math.log(acres) + 0.05 * rnd());
    return { lon, lat, acres, price, value: price / acres, dateMs: Date.UTC(2024, 0, 1), zone: 'A' };
  });
  const iso = isovalueSurface(sales, { subject: { lng: -96.6, lat: 50 } });
  ok(iso.ok && iso.fills.features.length > 0, 'the isovalue surface draws');
  const fx = locationEffect(sales, [{ col: 'acres', kind: 'smooth', log: true, label: 'parcel size' }],
    { subject: { lng: -96.6, lat: 50 } });
  ok(fx.ok, 'the location model fits on 300 sales');
  ok(fx.subjectEffect > 20, `an eastern subject reads a location premium (${fx.subjectEffect.toFixed(0)}%)`);
  const west = locationEffect(sales, [{ col: 'acres', kind: 'smooth', log: true, label: 'parcel size' }],
    { subject: { lng: -97.4, lat: 50 } });
  ok(west.subjectEffect < -20, `a western subject reads a location discount (${west.subjectEffect.toFixed(0)}%)`);
  ok(fx.effect.caption.includes('Net of parcel size'), 'the caption names the controls');
  ok(fx.unc.legend.length >= 2, 'the uncertainty map has a legend');
  // A control the data barely records is left out and named.
  const thin = sales.map((s, i) => ({ ...s, cult: i % 5 === 0 ? 50 : null }));
  const fx2 = locationEffect(thin, [{ col: 'cult', kind: 'smooth', label: 'cultivated %' }]);
  ok(fx2.dropped.some((d) => d.startsWith('cultivated %')), 'a control recorded for a fifth of the sales is left out and named');
}

{
  // Log-spaced isovalue bands (2026-11-01): values spread over 400x put about
  // as many cells in each band, where even dollar steps put most in the first.
  const z = Array.from({ length: 1000 }, (_, i) => 5000 * 400 ** (i / 999));
  const b = valueBands(z, (v) => `$${v}`);
  const counts = new Array(b.breaks.length - 1).fill(0);
  for (const v of z) { let k = b.breaks.findIndex((e, i) => i > 0 && v < e) - 1; if (k < 0) k = counts.length - 1; counts[Math.max(0, k)] += 1; }
  ok(Math.max(...counts) < 0.25 * z.length, `no band holds a quarter of a log-spread surface (largest ${Math.max(...counts)})`);
  ok(b.breaks.every((v) => Number(v.toPrecision(2)) === v), 'band edges are rounded to two significant figures');
}
{
  // Faded cells: a location effect the sales cannot tell from zero is marked weak.
  let seed = 23;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const flat = Array.from({ length: 220 }, () => ({ lon: -97.5 + rnd(), lat: 49.8 + rnd() * 0.4, price: Math.exp(12 + 0.3 * (rnd() - 0.5)) }));
  const fx = locationEffect(flat, []);
  const feats = fx.effect.fills.features;
  const weakShare = feats.filter((f) => f.properties.weak).length / feats.length;
  ok(weakShare > 0.5, `a market with no location effect is mostly faded (${(100 * weakShare).toFixed(0)}%)`);
  ok(fx.effect.legend.some((l) => l.label.startsWith('Faded')), 'the legend explains the fading');
  const strong = flat.map((r) => ({ ...r, price: r.price * Math.exp(1.5 * (r.lon + 97.5)) }));
  const fx2 = locationEffect(strong, []);
  const w2 = fx2.effect.fills.features.filter((f) => f.properties.weak).length / fx2.effect.fills.features.length;
  ok(w2 < weakShare, `a strong east-west effect fades less (${(100 * w2).toFixed(0)}%)`);
}

console.log(`spatialSmooth: ${passed} assertions passed`);

/*
 * Penalised-spline regression for the Sales Charts maps (2026-11-01).
 *
 * The land dashboard's ADF Overview page draws three maps that need a fitted
 * model rather than a colour per sale: an ISOVALUE surface (the time-adjusted
 * $/unit smoothed over location), the LOCATION EFFECT (the share of price
 * that comes from where a sale is, net of size, date and zoning) and its
 * UNCERTAINTY (the width of that effect's pointwise 95% band). The templates
 * fit them with mgcv; this is the same model, small enough to run in the
 * browser on whatever the filters leave:
 *
 *   y = b0 + factors + s1(control) + ... + s(x, y) + e
 *
 * Each s() is a low-rank thin-plate spline (Wood 2017 §5.5): k knots chosen
 * from the data by farthest-point sampling, the polynomial part unpenalised,
 * the radial part penalised by its own bending energy and constrained
 * orthogonal to the polynomial at the knots. Each smooth is centred on the
 * data (mgcv's sum-to-zero constraint), so a term reads as a departure from
 * the average. Smoothing parameters are chosen by REML, as the templates'
 * `method = "REML"` does; the covariance is mgcv's Bayesian one,
 * Vb = scale * (X'X + S)^-1 with scale = RSS / (n - edf).
 *
 * It is not mgcv: mgcv's thin-plate REGRESSION spline truncates an eigen-
 * basis of every sale rather than using knots, so the two agree on the
 * pattern, not to the dollar. test/spatialSmooth.test.js holds them to a
 * correlation recorded from a real mgcv fit.
 *
 * Pure functions, no DOM: the charts page runs it in a worker.
 */

// ---------- small dense linear algebra ----------------------------------------

/** Cholesky of a symmetric positive-definite matrix (array of rows). null if not PD. */
export function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      const Li = L[i]; const Lj = L[j];
      for (let k = 0; k < j; k++) s -= Li[k] * Lj[k];
      if (i === j) {
        if (!(s > 0)) return null;
        Li[i] = Math.sqrt(s);
      } else {
        Li[j] = s / Lj[j];
      }
    }
  }
  return L;
}

/** Solve L L' x = b. */
export function cholSolve(L, b) {
  const n = L.length;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

/** (L L')^-1, as rows. */
function cholInverse(L) {
  const n = L.length;
  const inv = Array.from({ length: n }, () => new Float64Array(n));
  const e = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    e.fill(0); e[j] = 1;
    const col = cholSolve(L, e);
    for (let i = 0; i < n; i++) inv[i][j] = col[i];
  }
  return inv;
}

/**
 * The columns of a full Householder Q for the k x m matrix T (k > m) beyond
 * the first m: an orthonormal basis of the null space of T'. This is the
 * constraint that keeps a thin-plate spline's radial part from duplicating
 * its polynomial part.
 */
export function nullSpaceOfTransposed(T) {
  const k = T.length; const m = T[0].length;
  const R = T.map((r) => Float64Array.from(r));
  const vs = [];
  for (let j = 0; j < m; j++) {
    let norm = 0;
    for (let i = j; i < k; i++) norm += R[i][j] * R[i][j];
    norm = Math.sqrt(norm);
    const v = new Float64Array(k);
    const alpha = R[j][j] > 0 ? -norm : norm;
    for (let i = j; i < k; i++) v[i] = R[i][j];
    v[j] -= alpha;
    let vn = 0;
    for (let i = j; i < k; i++) vn += v[i] * v[i];
    if (vn > 0) {
      for (let c = j; c < m; c++) {
        let d = 0;
        for (let i = j; i < k; i++) d += v[i] * R[i][c];
        const f = (2 * d) / vn;
        for (let i = j; i < k; i++) R[i][c] -= f * v[i];
      }
    }
    vs.push({ v, vn });
  }
  // Q = H1 H2 ... Hm; columns m..k-1 of Q are Q applied to the unit vectors.
  const Z = Array.from({ length: k }, () => new Float64Array(k - m));
  for (let c = m; c < k; c++) {
    const col = new Float64Array(k); col[c] = 1;
    for (let j = m - 1; j >= 0; j--) {
      const { v, vn } = vs[j];
      if (!(vn > 0)) continue;
      let d = 0;
      for (let i = j; i < k; i++) d += v[i] * col[i];
      const f = (2 * d) / vn;
      for (let i = j; i < k; i++) col[i] -= f * v[i];
    }
    for (let i = 0; i < k; i++) Z[i][c - m] = col[i];
  }
  return Z;
}

// ---------- thin-plate spline bases -------------------------------------------

/** The radial function: r^2 log r in two dimensions, |r|^3 in one. */
const eta = (d, r) => (d === 2 ? (r > 0 ? r * r * Math.log(r) : 0) : r * r * r);

/**
 * k knots from the points by farthest-point sampling, starting from the point
 * nearest the centroid: deterministic (the same sales give the same knots on
 * every render) and spread over the data, dense where the data is.
 * Coincident points are collapsed first, so k never exceeds the distinct ones.
 */
export function chooseKnots(pts, k) {
  const seen = new Map();
  for (const p of pts) seen.set(p.map((v) => v.toFixed(6)).join(','), p);
  const uniq = [...seen.values()];
  if (uniq.length <= k) return uniq;
  const d = uniq[0].length;
  const c = new Array(d).fill(0);
  for (const p of uniq) for (let j = 0; j < d; j++) c[j] += p[j] / uniq.length;
  const dist2 = (a, b) => { let s = 0; for (let j = 0; j < d; j++) s += (a[j] - b[j]) ** 2; return s; };
  let first = 0;
  for (let i = 1; i < uniq.length; i++) if (dist2(uniq[i], c) < dist2(uniq[first], c)) first = i;
  const knots = [uniq[first]];
  const near = uniq.map((p) => dist2(p, uniq[first]));
  while (knots.length < k) {
    let best = 0;
    for (let i = 1; i < uniq.length; i++) if (near[i] > near[best]) best = i;
    knots.push(uniq[best]);
    for (let i = 0; i < uniq.length; i++) near[i] = Math.min(near[i], dist2(uniq[i], uniq[best]));
  }
  return knots;
}

/**
 * A thin-plate smooth of `d` (1 or 2) variables with up to `k` knots over the
 * rows `pts` (arrays of length d, already scaled). Returns the basis builder:
 * row(p) -> the term's model-matrix row, the penalty block S (cols x cols),
 * and the column means the term is centred on.
 */
export function thinPlateSmooth(pts, k, d) {
  const knots = chooseKnots(pts, k);
  const kk = knots.length;
  const m = d + 1; // polynomial null space: 1, x(, y)
  if (kk <= m) return null;
  const T = knots.map((q) => [1, ...q]);
  const Z = nullSpaceOfTransposed(T);
  const dist = (a, b) => Math.sqrt(a.reduce((s, v, j) => s + (v - b[j]) ** 2, 0));
  const E = knots.map((a) => knots.map((b) => eta(d, dist(a, b))));
  const q = kk - m;
  // S = Z' E Z, the radial coefficients' bending energy.
  const EZ = E.map((row) => {
    const out = new Float64Array(q);
    for (let c = 0; c < q; c++) { let s = 0; for (let i = 0; i < kk; i++) s += row[i] * Z[i][c]; out[c] = s; }
    return out;
  });
  const Spen = Array.from({ length: q }, (_, a) => {
    const out = new Float64Array(q);
    for (let b = 0; b < q; b++) { let s = 0; for (let i = 0; i < kk; i++) s += Z[i][a] * EZ[i][b]; out[b] = s; }
    return out;
  });
  // Scale the penalty to a unit-ish size so one lambda grid serves every smooth.
  let tr = 0; for (let i = 0; i < q; i++) tr += Spen[i][i];
  const sc = tr > 0 ? q / tr : 1;
  for (const r of Spen) for (let j = 0; j < q; j++) r[j] *= sc;
  const cols = d + q; // the linear term(s), unpenalised, then the radial part
  const raw = (p) => {
    const out = new Float64Array(cols);
    for (let j = 0; j < d; j++) out[j] = p[j];
    const e = knots.map((kn) => eta(d, dist(p, kn)));
    for (let c = 0; c < q; c++) { let s = 0; for (let i = 0; i < kk; i++) s += e[i] * Z[i][c]; out[d + c] = s; }
    return out;
  };
  const means = new Float64Array(cols);
  const rows = pts.map(raw);
  for (const r of rows) for (let j = 0; j < cols; j++) means[j] += r[j] / rows.length;
  const S = Array.from({ length: cols }, (_, i) => {
    const out = new Float64Array(cols);
    if (i >= d) for (let j = d; j < cols; j++) out[j] = Spen[i - d][j - d];
    return out;
  });
  return {
    cols, rank: q, S, knots: kk,
    row(p) { const r = raw(p); for (let j = 0; j < cols; j++) r[j] -= means[j]; return r; },
  };
}

// ---------- the model ----------------------------------------------------------

/**
 * Fit y ~ intercept + factor dummies + smooths by REML.
 *
 * @param {number[]} y  response (already logged).
 * @param {object[]} terms  each {kind: 'factor', values: string[]} or
 *   {kind: 'smooth', values: number[][] (rows), k, d, name}.
 * @returns {null | {beta, Vb, scale, edf, devExpl, lambdas, blocks, predictTerm}}
 *   predictTerm(name, p) -> {fit, se} for a smooth term at a new point.
 */
export function fitPenalised(y, terms) {
  const n = y.length;
  const blocks = [];
  let p = 1;
  for (const t of terms) {
    if (t.kind === 'factor') {
      const lv = [...new Set(t.values)].sort();
      const ref = lv[0];
      const levels = lv.slice(1);
      if (!levels.length) continue;
      blocks.push({ ...t, start: p, cols: levels.length, levels, ref });
      p += levels.length;
    } else {
      const sm = thinPlateSmooth(t.values, t.k, t.d);
      if (!sm) continue;
      blocks.push({ ...t, sm, start: p, cols: sm.cols });
      p += sm.cols;
    }
  }
  if (n <= p + 2) return null;
  const X = Array.from({ length: n }, () => new Float64Array(p));
  for (let i = 0; i < n; i++) {
    X[i][0] = 1;
    for (const b of blocks) {
      if (b.kind === 'factor') {
        const j = b.levels.indexOf(b.values[i]);
        if (j >= 0) X[i][b.start + j] = 1;
      } else {
        const r = b.sm.row(b.values[i]);
        for (let j = 0; j < b.cols; j++) X[i][b.start + j] = r[j];
      }
    }
  }
  const XtX = Array.from({ length: p }, () => new Float64Array(p));
  const Xty = new Float64Array(p);
  let yty = 0; let ym = 0;
  for (let i = 0; i < n; i++) {
    const r = X[i]; const yi = y[i];
    yty += yi * yi; ym += yi / n;
    for (let a = 0; a < p; a++) {
      const ra = r[a];
      if (ra === 0) continue;
      Xty[a] += ra * yi;
      const row = XtX[a];
      for (let b = a; b < p; b++) row[b] += ra * r[b];
    }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];
  // Put lambda on the scale of the data: S blocks are unit-ish, X'X is not.
  const smooths = blocks.filter((b) => b.kind === 'smooth');
  const xscale = smooths.map((b) => {
    let s = 0; for (let j = 0; j < b.cols; j++) s += XtX[b.start + j][b.start + j];
    return s / b.cols || 1;
  });
  const nullDim = p - smooths.reduce((s, b) => s + b.sm.rank, 0);

  const solve = (logLam) => {
    const M = XtX.map((r) => Float64Array.from(r));
    smooths.forEach((b, j) => {
      const lam = Math.exp(logLam[j]) * xscale[j];
      for (let a = 0; a < b.cols; a++) for (let c = 0; c < b.cols; c++) M[b.start + a][b.start + c] += lam * b.sm.S[a][c];
    });
    let L = cholesky(M);
    if (!L) {
      for (let a = 0; a < p; a++) M[a][a] += 1e-8 * (XtX[a][a] || 1);
      L = cholesky(M);
      if (!L) return null;
    }
    const beta = cholSolve(L, Xty);
    let bXty = 0; let bMb = 0; let bXXb = 0;
    for (let a = 0; a < p; a++) {
      bXty += beta[a] * Xty[a];
      let s = 0; let t = 0;
      for (let c = 0; c < p; c++) { s += M[a][c] * beta[c]; t += XtX[a][c] * beta[c]; }
      bMb += beta[a] * s; bXXb += beta[a] * t;
    }
    const rss = Math.max(1e-12, yty - 2 * bXty + bXXb);
    const pen = Math.max(0, bMb - bXXb);
    let logDetM = 0; for (let a = 0; a < p; a++) logDetM += 2 * Math.log(L[a][a]);
    let logDetS = 0;
    smooths.forEach((b, j) => { logDetS += b.sm.rank * (logLam[j] + Math.log(xscale[j])); });
    const df = n - nullDim;
    const sig2 = (rss + pen) / df;
    // Profiled REML (Gaussian, scale estimated), up to a constant.
    const reml = 0.5 * (df * Math.log(sig2) + logDetM - logDetS);
    return { L, beta, rss, reml };
  };

  // Coordinate search on each log lambda, then a golden-section polish.
  const lo = -12; const hi = 12;
  const logLam = smooths.map(() => 0);
  const score = (ll) => { const r = solve(ll); return r ? r.reml : Infinity; };
  for (let sweep = 0; sweep < 3; sweep++) {
    for (let j = 0; j < smooths.length; j++) {
      let best = logLam[j]; let bestS = score(logLam);
      for (let v = lo; v <= hi; v += 2) {
        const t = logLam.slice(); t[j] = v;
        const s = score(t);
        if (s < bestS) { bestS = s; best = v; }
      }
      let a = Math.max(lo, best - 2); let b = Math.min(hi, best + 2);
      const g = (Math.sqrt(5) - 1) / 2;
      for (let it = 0; it < 14; it++) {
        const c = b - g * (b - a); const d = a + g * (b - a);
        const tc = logLam.slice(); tc[j] = c;
        const td = logLam.slice(); td[j] = d;
        if (score(tc) < score(td)) b = d; else a = c;
      }
      logLam[j] = (a + b) / 2;
    }
  }
  const fit = solve(logLam);
  if (!fit) return null;
  const Minv = cholInverse(fit.L);
  let edf = 0;
  for (let a = 0; a < p; a++) { let s = 0; for (let c = 0; c < p; c++) s += Minv[a][c] * XtX[c][a]; edf += s; }
  const scale = fit.rss / Math.max(1, n - edf);
  let tss = 0; for (const v of y) tss += (v - ym) ** 2;
  const byName = new Map(blocks.filter((b) => b.kind === 'smooth').map((b) => [b.name, b]));
  return {
    n, p, edf, scale,
    devExpl: tss > 0 ? 1 - fit.rss / tss : 0,
    beta: fit.beta,
    lambdas: logLam.map(Math.exp),
    blocks: blocks.map(({ kind, name, start, cols, levels }) => ({ kind, name, start, cols, levels })),
    /** The fitted value of one smooth term at a point, and its standard error. */
    predictTerm(name, pt, { se = true } = {}) {
      const b = byName.get(name);
      if (!b) return null;
      const r = b.sm.row(pt);
      let f = 0;
      for (let j = 0; j < b.cols; j++) f += r[j] * fit.beta[b.start + j];
      if (!se) return { fit: f, se: NaN };
      let v = 0;
      for (let a = 0; a < b.cols; a++) {
        const row = Minv[b.start + a];
        let s = 0;
        for (let c = 0; c < b.cols; c++) s += row[b.start + c] * r[c];
        v += r[a] * s;
      }
      return { fit: f, se: Math.sqrt(Math.max(0, v * scale)) };
    },
    /** Intercept plus every term: the model's prediction for a full row. */
    fitted(i) {
      let f = 0;
      for (let a = 0; a < p; a++) f += X[i][a] * fit.beta[a];
      return f;
    },
  };
}

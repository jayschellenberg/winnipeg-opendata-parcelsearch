/*
 * A small hand-rolled SVG scatter renderer.
 *
 * Hand-rolled rather than a charting library for two reasons that both
 * still hold: the site's CSP is `script-src 'self'` so a CDN chart lib
 * cannot load at all, and the repo rule is no new npm dependencies
 * without asking. What is actually needed here — a scatter, an axis
 * pair and a straight trendline — is a couple of hundred lines.
 *
 * Builds real SVG DOM (not a string) so labels stay selectable and the
 * caller can attach handlers. The maths lives in lib/salesCharts.js;
 * this file only turns numbers into geometry.
 */

const NS = 'http://www.w3.org/2000/svg';

export const INK = {
  axis: '#b8c3ba',
  grid: '#e7ebe7',
  text: '#4d5752',
  muted: '#6d7771',
  dot: '#2f6f6a',
  dotFar: '#8a2f1a',
  trend: '#121613',
};

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, String(v));
  }
  return node;
}

/** $12,300 / $1.2M — compact enough for an axis tick. */
export function fmtAxisMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  if (abs >= 10) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n >= 100
    ? `$${Math.round(n).toLocaleString('en-CA')}`
    : `$${n.toFixed(2)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Epoch ms -> "Mar 2026", in LOCAL time. Deliberately not
 *  toLocaleDateString on a UTC-parsed date: Winnipeg runs behind UTC,
 *  which slides an early-in-the-month sale into the previous month. */
export function fmtAxisDate(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Draw one scatter chart.
 *
 * @param {object} spec
 * @param {Array<{x:number,y:number,label?:string}>} spec.points
 * @param {{min:number,max:number,ticks:number[]}} spec.xScale
 * @param {{min:number,max:number,ticks:number[]}} spec.yScale
 * @param {(v:number)=>string} spec.xFormat
 * @param {(v:number)=>string} spec.yFormat
 * @param {{predict:(x:number)=>number}|null} [spec.fit]
 * @param {string} [spec.xLabel]
 * @param {string} [spec.yLabel]
 * @param {number} [spec.radius]
 * @param {number} [spec.width]
 * @param {number} [spec.height]
 * @returns {SVGElement}
 */
export function drawChart({
  points, xScale, yScale, xFormat, yFormat, fit,
  xLabel = '', yLabel = '', radius = 4, width = 620, height = 320,
}) {
  const m = { top: 14, right: 16, bottom: 42, left: 68 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    role: 'img',
    'aria-label': `${yLabel} against ${xLabel}`,
  });

  const sx = (v) => m.left + ((v - xScale.min) / (xScale.max - xScale.min || 1)) * plotW;
  const sy = (v) => m.top + plotH - ((v - yScale.min) / (yScale.max - yScale.min || 1)) * plotH;

  // Grid + y ticks
  for (const t of yScale.ticks) {
    const y = sy(t);
    if (y < m.top - 1 || y > m.top + plotH + 1) continue;
    svg.appendChild(el('line', {
      x1: m.left, x2: m.left + plotW, y1: y, y2: y, stroke: INK.grid, 'stroke-width': 1,
    }));
    const label = el('text', {
      x: m.left - 8, y, 'text-anchor': 'end', 'dominant-baseline': 'middle',
      fill: INK.text, 'font-size': 11,
    });
    label.textContent = yFormat(t);
    svg.appendChild(label);
  }

  // x ticks — thinned so labels never collide
  const maxXLabels = Math.max(2, Math.floor(plotW / 90));
  const stride = Math.ceil(xScale.ticks.length / maxXLabels);
  xScale.ticks.forEach((t, i) => {
    const x = sx(t);
    if (x < m.left - 1 || x > m.left + plotW + 1) return;
    svg.appendChild(el('line', {
      x1: x, x2: x, y1: m.top, y2: m.top + plotH, stroke: INK.grid, 'stroke-width': 1,
    }));
    if (i % stride) return;
    const label = el('text', {
      x, y: m.top + plotH + 16, 'text-anchor': 'middle', fill: INK.text, 'font-size': 11,
    });
    label.textContent = xFormat(t);
    svg.appendChild(label);
  });

  // Axes
  svg.appendChild(el('line', {
    x1: m.left, x2: m.left + plotW, y1: m.top + plotH, y2: m.top + plotH,
    stroke: INK.axis, 'stroke-width': 1,
  }));
  svg.appendChild(el('line', {
    x1: m.left, x2: m.left, y1: m.top, y2: m.top + plotH, stroke: INK.axis, 'stroke-width': 1,
  }));

  if (xLabel) {
    const t = el('text', {
      x: m.left + plotW / 2, y: height - 6, 'text-anchor': 'middle',
      fill: INK.muted, 'font-size': 11,
    });
    t.textContent = xLabel;
    svg.appendChild(t);
  }
  if (yLabel) {
    const t = el('text', {
      x: 12, y: m.top + plotH / 2, 'text-anchor': 'middle',
      fill: INK.muted, 'font-size': 11,
      transform: `rotate(-90 12 ${m.top + plotH / 2})`,
    });
    t.textContent = yLabel;
    svg.appendChild(t);
  }

  // Dots, then the trendline ON TOP. Drawn in that order deliberately:
  // with the fit underneath, the dots bury it exactly where the data is
  // densest, which is where the line most needs to be read.
  const dots = el('g');
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const c = el('circle', {
      cx: sx(p.x), cy: sy(p.y), r: radius,
      fill: p.farFlung ? INK.dotFar : INK.dot,
      'fill-opacity': 0.55,
      stroke: p.farFlung ? INK.dotFar : INK.dot,
      'stroke-opacity': 0.9,
      'stroke-width': 1,
    });
    if (p.label) {
      const title = el('title');
      title.textContent = p.label;
      c.appendChild(title);
    }
    dots.appendChild(c);
  }
  svg.appendChild(dots);

  if (fit) {
    const x1 = xScale.min;
    const x2 = xScale.max;
    const y1 = fit.predict(x1);
    const y2 = fit.predict(x2);
    if (Number.isFinite(y1) && Number.isFinite(y2)) {
      // Clip to the plot box: an extrapolated fit can leave the frame.
      svg.appendChild(el('line', {
        x1: sx(x1), y1: Math.max(m.top, Math.min(m.top + plotH, sy(y1))),
        x2: sx(x2), y2: Math.max(m.top, Math.min(m.top + plotH, sy(y2))),
        stroke: INK.trend, 'stroke-width': 2, 'stroke-opacity': 0.85,
      }));
    }
  }

  return svg;
}

/**
 * Vertical bars (2026-11-01): the ADF Overview / CMS pages' histograms and
 * sales-by-year counts, the land dashboard's two bar exhibits.
 *
 * @param {object} spec
 * @param {Array<{label:string, n:number, back?:number}>} spec.bars  in axis
 *   order; `back` is a second count drawn BEHIND `n`, pale -- the template's
 *   nominal-behind-adjusted histogram on one bin grid
 * @param {string} [spec.xLabel]
 * @param {string} [spec.yLabel]
 * @param {boolean} [spec.counts]  print each bar's count above it
 * @returns {SVGElement}
 */
export function drawBars({ bars, xLabel = '', yLabel = 'Sales', counts = false, width = 620, height = 320 }) {
  const m = { top: 18, right: 16, bottom: 42, left: 56 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`, width: '100%', role: 'img', 'aria-label': `${yLabel} by ${xLabel}`,
  });
  const top = Math.max(1, ...bars.map((b) => Math.max(b.n || 0, b.back || 0)));
  // A 1/2/5 x 10^k step giving about five gridlines; whole counts below 5.
  const raw = top / 5;
  const p10 = 10 ** Math.floor(Math.log10(raw));
  const step = top <= 5 ? 1 : [1, 2, 5, 10].map((f) => f * p10).find((s) => s >= raw);
  const ymax = Math.ceil(top / step) * step;
  const sy = (v) => m.top + plotH - (v / ymax) * plotH;
  for (let t = 0; t <= ymax; t += step) {
    svg.appendChild(el('line', { x1: m.left, x2: m.left + plotW, y1: sy(t), y2: sy(t), stroke: INK.grid }));
    const lab = el('text', { x: m.left - 8, y: sy(t), 'text-anchor': 'end', 'dominant-baseline': 'middle', fill: INK.text, 'font-size': 11 });
    lab.textContent = String(t);
    svg.appendChild(lab);
  }
  const slot = plotW / Math.max(1, bars.length);
  const every = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor(plotW / 70))));
  bars.forEach((b, i) => {
    const cx = m.left + slot * (i + 0.5);
    const w = Math.max(2, slot * 0.82);
    for (const [v, fill, op] of [[b.back, '#b9bfbb', 0.75], [b.n, INK.dot, 0.6]]) {
      if (!(v > 0)) continue;
      svg.appendChild(el('rect', {
        x: cx - w / 2, y: sy(v), width: w, height: sy(0) - sy(v), fill, 'fill-opacity': op, stroke: fill, 'stroke-opacity': 0.9,
      }));
    }
    if (counts && b.n > 0) {
      const t = el('text', { x: cx, y: sy(b.n) - 4, 'text-anchor': 'middle', fill: INK.text, 'font-size': 11 });
      t.textContent = String(b.n);
      svg.appendChild(t);
    }
    if (i % every === 0) {
      const t = el('text', { x: cx, y: m.top + plotH + 16, 'text-anchor': 'middle', fill: INK.text, 'font-size': 11 });
      t.textContent = b.label;
      svg.appendChild(t);
    }
  });
  svg.appendChild(el('line', { x1: m.left, x2: m.left + plotW, y1: m.top + plotH, y2: m.top + plotH, stroke: INK.axis }));
  for (const [txt, attrs] of [
    [xLabel, { x: m.left + plotW / 2, y: height - 6, 'text-anchor': 'middle' }],
    [yLabel, { x: 12, y: m.top + plotH / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${m.top + plotH / 2})` }],
  ]) {
    if (!txt) continue;
    const t = el('text', { ...attrs, fill: INK.muted, 'font-size': 11 });
    t.textContent = txt;
    svg.appendChild(t);
  }
  return svg;
}

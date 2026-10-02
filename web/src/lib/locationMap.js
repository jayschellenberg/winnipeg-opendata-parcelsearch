// Location maps — a printed base map with a SUBJECT callout pointing at the
// searched property, for the location figure at the front of an appraisal
// report. Two base maps:
//
//   manitoba  NRCan "Manitoba" overview page (© 2001 NRCan, Atlas of Canada),
//             from D:\Dropbox\Appraisal\Maps\Manitoba\Canada Manitoba
//             Overview Map.pdf → public/manitoba-overview.svg
//   winnipeg  the Winnipeg map with its downtown inset, from
//             D:\Dropbox\Appraisal\Maps\Winnipeg\Winnipeg 2026-Cropped.pdf
//             → public/winnipeg-overview.svg
//
// Both are fully vector, so the browser re-rasterises them at whatever
// output size we ask for and the figure stays as crisp as the PDF.
// Coordinates throughout are each page's points, origin top-left, y down —
// the SVG viewBox is the same frame.
//
// SHARED FILE: kept byte-identical between mb-parcelsearch and the Winnipeg
// ParcelSearch app (with lib/locationMapData.js), like phoneMode.js. Each
// app ships only the SVGs it offers.
//
// REBUILDING THE SVGs. The Manitoba PDF does not embed its fonts, so a
// straight conversion draws every label in a substitute serif and every
// town dot (a Wingdings glyph) as a bar. Embed the real Windows fonts first
// with Ghostscript, mapping the comma-styled names explicitly — without the
// map the Bold / Italic / Narrow variants still fall back to Times:
//   Fontmap.mb:  /Verdana,Bold (C:/Windows/Fonts/verdanab.ttf) ;  and the
//                same for Verdana, Verdana,Italic, ArialNarrow,Bold,
//                TimesNewRoman,Bold,Italic, Georgia, Wingdings-Regular
//   gswin64c -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -dEmbedAllFonts=true
//            -sFONTMAP=<absolute path>/Fontmap.mb -o emb.pdf <source>.pdf
// The Winnipeg PDF embeds its fonts and converts directly. Either way:
//   python: fitz.open(pdf)[0].get_svg_image(text_as_path=True)
//
// GEOREFERENCING.
//   manitoba  Lambert Conformal Conic 49°/77° (the Atlas of Canada
//             projection). An affine on the LCC coordinates of the page's own
//             graticule vertices — the 49th-parallel border at -101..-96 and
//             the 60th at -102..-95 — reproduces all 14 to 0.003 pt, so it is
//             exact. The TOWN DOTS are not: the cartographer nudged them
//             ~1.6 pt (≈4 km), so a Steinbach subject lands ~0.8 pt off the
//             Steinbach dot. The graticule wins over the dots.
//   winnipeg  UTM 14N, see WINNIPEG_MAIN / WINNIPEG_INSET in
//             locationMapData.js for how each was fitted.
//
// DOWNTOWN. The Winnipeg map repeats the area inside its pink circle as an
// enlarged inset. A subject inside the inset gets ONE box between the two
// circles with an arrow to each (Jason, 2026-10-01); everywhere else gets
// the usual single arrow.
//
// Pure apart from renderLocationMap(), which needs a canvas — everything
// else unit-tests in node (test/locationMap.test.js).

import {
  MANITOBA_OBSTACLES,
  WINNIPEG_OBSTACLES,
  WINNIPEG_MAIN,
  WINNIPEG_INSET,
} from './locationMapData.js';

const RAD = Math.PI / 180;
// GRS80 (NAD83) — both projections below.
const A = 6378137.0;
const FL = 1 / 298.257222101;
const E = Math.sqrt(2 * FL - FL * FL);

// ---- Manitoba: LCC 49/77, origin 49°N 95°W --------------------------------
const lccM = (p) => Math.cos(p) / Math.sqrt(1 - E * E * Math.sin(p) ** 2);
const lccT = (p) => Math.tan(Math.PI / 4 - p / 2)
  / ((1 - E * Math.sin(p)) / (1 + E * Math.sin(p))) ** (E / 2);
const P1 = 49 * RAD;
const P2 = 77 * RAD;
const LCC_N = (Math.log(lccM(P1)) - Math.log(lccM(P2))) / (Math.log(lccT(P1)) - Math.log(lccT(P2)));
const LCC_F = lccM(P1) / (LCC_N * lccT(P1) ** LCC_N);
const LCC_R0 = A * LCC_F * lccT(49 * RAD) ** LCC_N;
// Affine from LCC metres to page points, least-squares on the graticule.
// LCC's central meridian is arbitrary here (the affine absorbs the
// rotation); -95 is what these constants were fitted with.
const MB_AX = [0.00037731844780214814, -1.9768553984621283e-05, 190.50720105713833];
const MB_AY = [-1.964642960892757e-05, -0.00037730478038530354, 463.99270547640856];

function manitobaPage(lng, lat) {
  const r = A * LCC_F * lccT(lat * RAD) ** LCC_N;
  const th = LCC_N * (lng * RAD - -95 * RAD);
  const e = r * Math.sin(th);
  const n = LCC_R0 - r * Math.cos(th);
  return [MB_AX[0] * e + MB_AX[1] * n + MB_AX[2], MB_AY[0] * e + MB_AY[1] * n + MB_AY[2]];
}

// ---- Winnipeg: UTM zone 14N (Krüger series, sub-millimetre) ---------------
const UTM_N = FL / (2 - FL);
const UTM_A = A / (1 + UTM_N) * (1 + UTM_N ** 2 / 4 + UTM_N ** 4 / 64);
const UTM_ALPHA = [
  UTM_N / 2 - 2 * UTM_N ** 2 / 3 + 5 * UTM_N ** 3 / 16,
  13 * UTM_N ** 2 / 48 - 3 * UTM_N ** 3 / 5,
  61 * UTM_N ** 3 / 240,
];

/** [lng, lat] → UTM 14N [easting, northing] in metres. */
export function utm14(lng, lat) {
  const phi = lat * RAD;
  const lam = (lng + 99) * RAD;
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - E * Math.atanh(E * s));
  const xi = Math.atan2(t, Math.cos(lam));
  const eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let x = eta;
  let y = xi;
  for (let j = 0; j < 3; j++) {
    const k = 2 * (j + 1);
    x += UTM_ALPHA[j] * Math.cos(k * xi) * Math.sinh(k * eta);
    y += UTM_ALPHA[j] * Math.sin(k * xi) * Math.cosh(k * eta);
  }
  return [500000 + 0.9996 * UTM_A * x, 0.9996 * UTM_A * y];
}

function winnipegPage(lng, lat) {
  const [e, n] = utm14(lng, lat);
  const de = e - WINNIPEG_MAIN.origin[0];
  const dn = n - WINNIPEG_MAIN.origin[1];
  const m = WINNIPEG_MAIN.inv;
  return [m[0][0] * de + m[0][1] * dn, m[1][0] * de + m[1][1] * dn];
}

function winnipegInset(lng, lat) {
  const [e, n] = utm14(lng, lat);
  const u = e - 633500;
  const v = n - 5528500;
  const { x, y } = WINNIPEG_INSET;
  return [x[0] * u + x[1] * v + x[2], y[0] * u + y[1] * v + y[2]];
}

const circleBox = ([cx, cy, r]) => [cx - r, cy - r, cx + r, cy + r];

/** The base maps. `scale` is output pixels per page point, chosen so both
 *  figures come out around 1500 px wide. */
export const BASE_MAPS = {
  manitoba: {
    id: 'manitoba',
    label: 'Manitoba',
    svgUrl: '/manitoba-overview.svg',
    width: 366.73298,
    height: 489.54597,
    scale: 4,
    project: manitobaPage,
    obstacles: MANITOBA_OBSTACLES,
  },
  winnipeg: {
    id: 'winnipeg',
    label: 'Winnipeg',
    svgUrl: '/winnipeg-overview.svg',
    width: 536.075,
    height: 511.2019,
    scale: 3,
    project: winnipegPage,
    inset: { project: winnipegInset, circle: WINNIPEG_INSET.circle, source: WINNIPEG_INSET.source },
    // Never park a box over downtown or on the inset.
    obstacles: [...WINNIPEG_OBSTACLES, circleBox(WINNIPEG_INSET.source), circleBox(WINNIPEG_INSET.circle)],
  },
};

const EDGE = 3;  // a point closer than this to the page edge is "off the map"

/**
 * Where a property falls on a base map: { main: [x, y], inset: [x, y] | null },
 * or null when it is off the page. `inset` is set only when the subject is
 * inside the downtown inset (comfortably inside its circle, so the arrow
 * tip never lands on the circle's rim).
 */
export function locateOnMap(map, lng, lat) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const main = map.project(lng, lat);
  if (main[0] < EDGE || main[1] < EDGE || main[0] > map.width - EDGE || main[1] > map.height - EDGE) {
    return null;
  }
  let inset = null;
  if (map.inset) {
    const q = map.inset.project(lng, lat);
    const [cx, cy, r] = map.inset.circle;
    if (Math.hypot(q[0] - cx, q[1] - cy) < r - 4) inset = q;
  }
  return { main, inset };
}

/** Callout look, in page points. Matches the hand-made report figures:
 *  maroon box, white rule inside its edge, white bold caps, soft shadow,
 *  maroon arrow that stops just short of the subject's map pin. */
export const CALLOUT = {
  fill: '#8c1c22',
  text: '#ffffff',
  font: 'bold 13px Arial, Helvetica, sans-serif',
  fontSize: 13,
  padX: 8,
  height: 23,
  lineWidth: 1.6,
  headLen: 6.5,
  headHalfWidth: 3.6,
};

/** Compass choices for the callout. Angles are screen angles (y down):
 *  0 = east, -90 = north. 'auto' searches all of them. */
export const DIRECTIONS = {
  ne: -40, e: 0, se: 40, s: 90, sw: 140, w: 180, nw: -140, n: -90,
};
/** The map pin standing on the subject: a maroon teardrop, tip on the
 *  point, white rim and centre dot. `gap` is how far short of its outline
 *  an arrowhead stops. */
export const PIN = { height: 32, radius: 11, gap: 1.5 };

/** Pin outline as a polygon (page points): the head circle plus the two
 *  tangents running down to the tip at `p`. */
export function pinOutline(p, { height = PIN.height, radius = PIN.radius } = {}) {
  const cy = p[1] - (height - radius);            // head centre
  const half = Math.asin(radius / (height - radius)); // tangent half-angle at the tip
  const pts = [[p[0], p[1]]];
  // Tangent points sit at +-(90deg - half) from straight down; walk the
  // circle the long way round, over the top.
  const a0 = Math.PI - half;
  const a1 = 2 * Math.PI + half;
  for (let i = 0; i <= 24; i++) {
    const a = a0 + (a1 - a0) * (i / 24);
    pts.push([p[0] + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return pts;
}

/** Bounding box of the pin at `p`. */
export function pinBox(p) {
  return [p[0] - PIN.radius, p[1] - PIN.height, p[0] + PIN.radius, p[1]];
}

/** Where an arrow from `tail` toward the pin at `p` should end: the first
 *  point where it meets the pin's outline (aiming at the head centre),
 *  pulled back by PIN.gap. Falls back to the tip itself. */
export function arrowTipAtPin(tail, p) {
  const head = [p[0], p[1] - (PIN.height - PIN.radius)];
  const dx = head[0] - tail[0];
  const dy = head[1] - tail[1];
  const len = Math.hypot(dx, dy);
  if (!len) return p;
  const pts = pinOutline(p);
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const ex = bx - ax;
    const ey = by - ay;
    const den = dx * ey - dy * ex;
    if (!den) continue;
    const t = ((ax - tail[0]) * ey - (ay - tail[1]) * ex) / den;   // along the arrow
    const u = ((ax - tail[0]) * dy - (ay - tail[1]) * dx) / den;   // along the edge
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < best) best = t;
  }
  if (best === Infinity) return p;
  const d = Math.max(0, best * len - PIN.gap);
  return [tail[0] + (dx / len) * d, tail[1] + (dy / len) * d];
}

const MIN_ARROW = 16;             // shortest visible arrow, tail to pin
const PREFERRED = -40;            // up and to the right, the usual look
const LEADERS = [32, 42, 52, 64, 78, 94, 112];
const MARGIN = 4;                 // keep the box this far inside the page

/** Estimated label width in points when no canvas is at hand. */
export function estimateTextWidth(label, fontSize = CALLOUT.fontSize) {
  return label.length * fontSize * 0.72;
}

function overlapArea(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

function coveredArea(box, obstacles) {
  let covered = 0;
  for (const o of obstacles) covered += overlapArea(box, o);
  return covered;
}

const onPage = (box, map) => box[0] >= MARGIN && box[1] >= MARGIN
  && box[2] <= map.width - MARGIN && box[3] <= map.height - MARGIN;
const contains = (box, p) => p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3];

/** Where segment centre→p leaves the box — the arrow's tail. */
function boxExit(box, p) {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  const hw = (box[2] - box[0]) / 2;
  const hh = (box[3] - box[1]) / 2;
  const s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * s, cy + dy * s];
}

/** Box for one candidate: walk `leader` points from the subject along
 *  `angle`, then hang the box off that spot on the side facing away. */
function candidateBox(p, angle, leader, w, h) {
  const c = Math.cos(angle * RAD);
  const s = Math.sin(angle * RAD);
  const cx = p[0] + leader * c + c * w / 2;
  const cy = p[1] + leader * s + s * h / 2;
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

/**
 * Choose the callout box for subject point `p` (page points) on `map`.
 *
 * Every candidate (36 directions, or five around the one asked for,
 * × 7 leader lengths) is scored by how much label / symbol area it would
 * cover, plus small pulls toward a short leader and the up-right direction
 * so that among clear spots the familiar one wins. A box that would leave
 * the page is never chosen.
 *
 * Returns { box: [x0, y0, x1, y1], tails: [[x, y]], targets: [p] } — each
 * tail is where an arrow leaves the box; its tip is the matching target.
 */
export function placeCallout(p, width, { map = BASE_MAPS.manitoba, direction = 'auto', height = CALLOUT.height } = {}) {
  // Every 10 degrees: the south of Manitoba is crowded enough that the
  // eight compass points alone often all land on a label when a spot 10-20
  // degrees off one of them is clear. A forced side searches +-20 degrees.
  const angles = [];
  if (direction in DIRECTIONS) {
    for (let d = -20; d <= 20; d += 10) angles.push(DIRECTIONS[direction] + d);
  } else {
    for (let a = -180; a < 180; a += 10) angles.push(a);
  }
  let best = null;
  for (const angle of angles) {
    for (const leader of LEADERS) {
      const box = candidateBox(p, angle, leader, width, height);
      if (!onPage(box, map) || overlapArea(box, pinBox(p)) > 0) continue;
      const tail = boxExit(box, p);
      const tip = arrowTipAtPin(tail, p);
      if (Math.hypot(tip[0] - tail[0], tip[1] - tail[1]) < MIN_ARROW) continue;
      const turn = Math.abs(((angle - PREFERRED + 540) % 360) - 180);
      const score = coveredArea(box, map.obstacles) + leader * 0.25 + turn * 0.3;
      if (!best || score < best.score) best = { score, box };
    }
  }
  if (!best) {
    // Nothing fits (only possible with a forced direction into the page
    // edge): fall back to the automatic choice rather than draw off-page.
    if (direction !== 'auto') return placeCallout(p, width, { map, height });
    return null;
  }
  return { box: best.box, tails: [boxExit(best.box, p)], targets: [p] };
}

/**
 * Choose ONE box for a downtown subject that points at both its spot on
 * the main map (`pMain`, inside the pink circle) and its spot in the inset
 * (`pInset`). Candidates are a grid over the page; the score is label
 * cover plus the two arrows' total length, so the box settles in the
 * clearest spot between the circles. The circles themselves are
 * obstacles, so it never sits on downtown or on the inset.
 */
export function placeTwinCallout(pMain, pInset, width, { map = BASE_MAPS.winnipeg, height = CALLOUT.height } = {}) {
  const step = 4;
  let best = null;
  for (let cy = height / 2 + MARGIN; cy <= map.height - height / 2 - MARGIN; cy += step) {
    for (let cx = width / 2 + MARGIN; cx <= map.width - width / 2 - MARGIN; cx += step) {
      const box = [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
      if (contains(box, pMain) || contains(box, pInset)) continue;
      if (overlapArea(box, pinBox(pMain)) > 0 || overlapArea(box, pinBox(pInset)) > 0) continue;
      const t1 = boxExit(box, pMain);
      const t2 = boxExit(box, pInset);
      // Arrow lengths to where they stop, short of each pin.
      const e1 = arrowTipAtPin(t1, pMain);
      const e2 = arrowTipAtPin(t2, pInset);
      const l1 = Math.hypot(e1[0] - t1[0], e1[1] - t1[1]);
      const l2 = Math.hypot(e2[0] - t2[0], e2[1] - t2[1]);
      if (l1 < MIN_ARROW || l2 < MIN_ARROW) continue;   // room for the arrowheads to read
      const score = coveredArea(box, map.obstacles) + (l1 + l2) * 0.3 + Math.abs(l1 - l2) * 0.15;
      if (!best || score < best.score) best = { score, box, tails: [t1, t2] };
    }
  }
  return best && { box: best.box, tails: best.tails, targets: [pMain, pInset] };
}

const imageCache = new Map();
/** Load a base map once per page. */
function loadBaseMap(url) {
  if (!imageCache.has(url)) {
    imageCache.set(url, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { imageCache.delete(url); reject(new Error(`could not load ${url}`)); };
      img.src = url;
    }));
  }
  return imageCache.get(url);
}

/**
 * Draw `map` plus the callout into a new canvas `map.scale` pixels per page
 * point. The SVG is drawn straight at the output size, so the browser
 * rasterises the vectors at that resolution rather than upscaling. Returns
 * null when the property is off this map.
 */
export async function renderLocationMap({ map = BASE_MAPS.manitoba, lng, lat, label = 'SUBJECT', direction = 'auto' }) {
  const where = locateOnMap(map, lng, lat);
  if (!where) return null;
  const img = await loadBaseMap(map.svgUrl);
  const scale = map.scale;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(map.width * scale);
  canvas.height = Math.round(map.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  ctx.scale(scale, scale);
  ctx.font = CALLOUT.font;
  const text = String(label || 'SUBJECT').trim() || 'SUBJECT';
  const width = Math.ceil(ctx.measureText(text).width + CALLOUT.padX * 2);
  const placed = where.inset
    ? placeTwinCallout(where.main, where.inset, width, { map })
    : placeCallout(where.main, width, { map, direction });
  if (placed) drawCallout(ctx, placed, text);
  return canvas;
}

function drawArrow(ctx, tail, tip) {
  const ang = Math.atan2(tip[1] - tail[1], tip[0] - tail[0]);
  const baseX = tip[0] - Math.cos(ang) * CALLOUT.headLen;
  const baseY = tip[1] - Math.sin(ang) * CALLOUT.headLen;
  ctx.beginPath();
  ctx.moveTo(tail[0], tail[1]);
  ctx.lineTo(baseX, baseY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tip[0], tip[1]);
  ctx.lineTo(baseX + Math.sin(ang) * CALLOUT.headHalfWidth, baseY - Math.cos(ang) * CALLOUT.headHalfWidth);
  ctx.lineTo(baseX - Math.sin(ang) * CALLOUT.headHalfWidth, baseY + Math.cos(ang) * CALLOUT.headHalfWidth);
  ctx.closePath();
  ctx.fill();
}

function drawCallout(ctx, { box, tails, targets }, text) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;

  // Arrows first, so the box sits over their tail ends.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 0.8;
  ctx.shadowOffsetY = 0.8;
  ctx.strokeStyle = CALLOUT.fill;
  ctx.fillStyle = CALLOUT.fill;
  ctx.lineWidth = CALLOUT.lineWidth;
  ctx.lineCap = 'round';
  tails.forEach((tail, i) => drawArrow(ctx, tail, arrowTipAtPin(tail, targets[i])));
  ctx.restore();

  // A pin on every subject point (main map and, downtown, the inset).
  for (const p of targets) drawPin(ctx, p);

  // Box with a drop shadow, then the inner white rule and the label.
  ctx.save();
  ctx.fillStyle = CALLOUT.fill;
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetX = 1.5;
  ctx.shadowOffsetY = 1.5;
  roundRect(ctx, x0, y0, w, h, 2.5);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.9;
  roundRect(ctx, x0 + 1.6, y0 + 1.6, w - 3.2, h - 3.2, 1.5);
  ctx.stroke();
  ctx.fillStyle = CALLOUT.text;
  ctx.font = CALLOUT.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x0 + w / 2, y0 + h / 2 + 0.6);
}

function drawPin(ctx, p) {
  const outline = pinOutline(p);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 0.8;
  ctx.shadowOffsetY = 0.8;
  ctx.beginPath();
  outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = CALLOUT.fill;
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.9;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p[0], p[1] - (PIN.height - PIN.radius), PIN.radius * 0.38, 0, 2 * Math.PI);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

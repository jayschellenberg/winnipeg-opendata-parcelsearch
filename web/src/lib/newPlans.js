/**
 * New Plans: survey plans registered since the oldest archived survey
 * snapshot, each dated to the window it first appeared in.
 *
 * Built offline by scripts/build-new-plans.mjs into public/new-plans.geojson
 * (the window logic and feature shape live here so they are unit-tested,
 * test/newPlans.test.js); drawn by the New Plans overlay in map.js.
 */

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Plan numbers above this are not ordinary Winnipeg LTO plans (the City data
// carries a couple of six-digit ones); they are left out of the high-water mark.
const PLAN_NUMBER_CEILING = 100000;

/**
 * The highest ordinary plan number in a set — the "registered by then" mark.
 * A new plan numbered below the baseline's mark was registered before the
 * baseline and only reached the City's data later.
 */
export function planHighWater(plans) {
  let hi = 0;
  for (const p of plans || []) {
    const n = /^\d+$/.test(String(p)) ? Number(p) : NaN;
    if (Number.isFinite(n) && n < PLAN_NUMBER_CEILING && n > hi) hi = n;
  }
  return hi;
}

/** true when `plan` is numbered below the baseline's high-water mark. */
export function isLatePlan(plan, highWater) {
  const n = /^\d+$/.test(String(plan)) ? Number(plan) : NaN;
  return Number.isFinite(n) && highWater > 0 && n < highWater;
}

// Douglas-Peucker on one ring, tolerance in degrees. Keeps the first and last
// points so the ring stays closed; never returns fewer than 4 points.
function simplifyRing(ring, tol) {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1; keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a]; const [bx, by] = ring[b];
    const dx = bx - ax; const dy = by - ay; const len2 = dx * dx + dy * dy;
    let best = -1; let bestD = t2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      let d;
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

// ~0.5 m at Winnipeg's latitude: invisible at the zooms the outlines draw at.
const SIMPLIFY_TOL_DEG = 0.000005;

/**
 * plan → { after, by }: the plan was absent on `after` and present on `by`.
 *
 * @param {object} o
 * @param {{date: string, plans: Set<string>}[]} o.snapshots oldest first; [0] is the baseline
 * @param {Set<string>} o.current today's plans
 * @param {string} o.today YYYY-MM-DD
 * @param {object|null} o.previous the previous build's FeatureCollection
 */
export function planWindows({ snapshots, current, today, previous = null }) {
  const out = new Map();
  if (!snapshots?.length) return out;
  const baseline = snapshots[0].plans;
  const kept = new Map();
  for (const f of previous?.features || []) {
    const p = f?.properties;
    if (p?.plan && p.after && p.by) kept.set(String(p.plan), { after: p.after, by: p.by });
  }
  const lastSnap = snapshots[snapshots.length - 1].date;
  const prevBuilt = previous?._meta?.generated_at;
  // Newest window starts at the later of the last snapshot and the last build.
  const openFrom = prevBuilt && /^\d{4}-\d{2}-\d{2}$/.test(prevBuilt) && prevBuilt > lastSnap ? prevBuilt : lastSnap;

  for (const plan of current) {
    if (baseline.has(plan)) continue;
    if (kept.has(plan)) { out.set(plan, kept.get(plan)); continue; }
    let win = null;
    for (let i = 1; i < snapshots.length; i++) {
      if (snapshots[i].plans.has(plan)) { win = { after: snapshots[i - 1].date, by: snapshots[i].date }; break; }
    }
    out.set(plan, win || { after: openFrom, by: today });
  }
  return out;
}

function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

const roundRing = (ring) => simplifyRing(ring.map(([x, y]) => [round6(x), round6(y)]), SIMPLIFY_TOL_DEG);

/**
 * One feature per plan: every lot's polygon in one MultiPolygon, with the
 * lot count, the window, and a label point (centre of the lots' bbox).
 * null when no lot has geometry.
 */
export function newPlanFeature(plan, lots, win, { late = false } = {}) {
  const polys = [];
  const blocks = new Set();
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const f of lots || []) {
    const geom = f?.geometry || f?.properties?.location;
    for (const poly of polygonsOf(geom)) {
      const rounded = poly.map(roundRing);
      for (const [x, y] of rounded[0] || []) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      polys.push(rounded);
    }
    const b = f?.properties?.block;
    if (b != null && String(b).trim()) blocks.add(String(b).trim());
  }
  if (!polys.length) return null;
  return {
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: polys },
    properties: {
      plan: String(plan),
      lots: (lots || []).length,
      blocks: blocks.size,
      after: win?.after || null,
      by: win?.by || null,
      late: late ? 1 : 0,
      lon: round6((minX + maxX) / 2),
      lat: round6((minY + maxY) / 2),
    },
  };
}

/** Label points for the low-zoom circle layer. */
export function newPlanPoints(fc) {
  return {
    type: 'FeatureCollection',
    features: (fc?.features || [])
      .filter((f) => Number.isFinite(f?.properties?.lon) && Number.isFinite(f?.properties?.lat))
      .map((f) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.properties.lon, f.properties.lat] },
        properties: { ...f.properties },
      })),
  };
}

/** The distinct windows of the on-time plans, oldest first: [{ after, by, key, count }]. */
export function planWindowList(fc) {
  const m = new Map();
  for (const f of fc?.features || []) {
    const { after, by, late } = f?.properties || {};
    if (!after || !by || Number(late)) continue;
    const key = `${after}|${by}`;
    if (!m.has(key)) m.set(key, { after, by, key, count: 0 });
    m.get(key).count++;
  }
  return [...m.values()].sort((a, b) => a.after.localeCompare(b.after) || a.by.localeCompare(b.by));
}

/** Window colours, oldest → newest (light → dark green). */
const WINDOW_COLORS = ['#86efac', '#22c55e', '#15803d', '#14532d'];

/**
 * key → colour, spread across the ramp so neighbouring windows stay easy to
 * tell apart; the newest window always gets the darkest shade.
 */
export function windowColors(list) {
  const n = list.length;
  const last = WINDOW_COLORS.length - 1;
  const out = new Map();
  list.forEach((w, i) => {
    const idx = n <= 1 ? last : Math.round(last - (n - 1 - i) * (last / (n - 1)));
    out.set(w.key, WINDOW_COLORS[Math.max(0, Math.min(last, idx))]);
  });
  return out;
}

/** Colour of plans registered before the baseline that reached the data late. */
export const LATE_PLAN_COLOR = '#9ca3af';

/** MapLibre colour expression: late plans grey, the rest by after|by window. */
export function windowColorExpression(colors) {
  const byWindow = ['match', ['concat', ['get', 'after'], '|', ['get', 'by']]];
  for (const [k, c] of colors) byWindow.push(k, c);
  byWindow.push('#059669');
  return ['case', ['==', ['get', 'late'], 1], LATE_PLAN_COLOR, colors.size ? byWindow : '#059669'];
}

/** Plain-text popup parts (caller escapes). */
export function newPlanPopupParts(p) {
  const lots = Number(p?.lots) || 0;
  const blocks = Number(p?.blocks) || 0;
  const late = Number(p?.late) === 1;
  const lines = [
    `${lots} lot${lots === 1 ? '' : 's'}${blocks > 1 ? ` in ${blocks} blocks` : ''}`,
    p?.after && p?.by ? `First appeared in City data between ${p.after} and ${p.by}` : null,
    late ? 'Numbered below plans already in the data then: registered earlier and added late, not a new registration.' : null,
    'Subdivision, consolidation or re-survey — Survey Parcels does not say which. Verify at Land Titles.',
  ].filter(Boolean);
  return { heading: `Plan ${p?.plan || ''}`.trim(), lines };
}

/*
 * Hover-popup reach zone — when is the pointer "on its way to" the popup?
 *
 * The parcel hover popup (map.js) follows the cursor and swaps to
 * whatever parcel is under it, which is right for scanning and wrong for
 * reaching the popup's links: the pointer has to cross other parcels to
 * get there. A per-move "is the distance shrinking?" test proved too
 * strict — any sideways wobble counted as moving away, and the popup
 * slipped off or changed (Jason, 2026-11-05: "my mouse chasing after the
 * hover tool tip"). So the test is a ZONE, not a direction:
 *
 *   NEAR   — within `margin` px of the popup's edge. Held as long as the
 *            pointer stays there.
 *   FUNNEL — anywhere in the convex hull of the point where the popup
 *            was placed and the popup grown by `margin`: the whole wedge a
 *            hand travels through on the way over, wobble included. Held
 *            for the linger time.
 *   OUT    — anything else: back to following and swapping instantly.
 *
 * All coordinates are one frame (map-canvas pixels). Rects are
 * { left, top, right, bottom }. Pure — no DOM.
 */

/** Distance from a point to a rect (0 inside). */
export function rectDistance(pt, rect) {
  if (!pt || !rect) return Infinity;
  const dx = Math.max(rect.left - pt.x, 0, pt.x - rect.right);
  const dy = Math.max(rect.top - pt.y, 0, pt.y - rect.bottom);
  return Math.hypot(dx, dy);
}

export function growRect(rect, by) {
  return { left: rect.left - by, top: rect.top - by, right: rect.right + by, bottom: rect.bottom + by };
}

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Point in triangle (inclusive of edges), either winding. */
export function inTriangle(p, a, b, c) {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * 'near' | 'funnel' | 'out' for the pointer `pt`, the popup `rect`, and
 * the `origin` point the popup was placed at (null → no funnel).
 * The hull of origin + grown rect is exactly the grown rect plus the four
 * triangles (origin, corner, next corner), so that is what is tested.
 */
export function reachZone(pt, rect, origin, margin = 32) {
  if (!pt || !rect) return 'out';
  if (rectDistance(pt, rect) <= margin) return 'near';
  if (!origin) return 'out';
  const g = growRect(rect, margin);
  const corners = [
    { x: g.left, y: g.top }, { x: g.right, y: g.top },
    { x: g.right, y: g.bottom }, { x: g.left, y: g.bottom },
  ];
  for (let i = 0; i < 4; i += 1) {
    if (inTriangle(pt, origin, corners[i], corners[(i + 1) % 4])) return 'funnel';
  }
  return 'out';
}

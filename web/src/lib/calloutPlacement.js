// Screen-space de-confliction for the numbered parcel callouts.
//
// Every badge used to sit at the SAME pixel offset from its parcel
// centroid, so badge spacing was exactly centroid spacing: any two
// parcels whose centroids landed within ~25-31 px of each other overlapped,
// guaranteed. This solver keeps that canonical up-and-right position as
// each badge's first choice and only bumps the ones that would actually
// collide, walking outward through a ladder of candidate slots (rings of
// positions around the parcel) until it finds clear space.
//
// Pure + camera-agnostic on purpose: it takes projected pixel positions
// and returns slot indices, so it unit-tests without a map (see
// test/calloutPlacement.test.js). map.js owns the projection either side.

/** Badge offset (px, screen space: +x right, +y down) when nothing is in
 *  the way — up and to the right of the centroid, the long-standing look.
 *  Scaled with the badge (see badgeRadius) so the leader stays visible
 *  instead of disappearing under a disc that outgrew it. */
export const BASE_OFFSET = [22, -29];

const BASE_ANGLE = Math.atan2(BASE_OFFSET[1], BASE_OFFSET[0]);
const BASE_RADIUS = Math.hypot(BASE_OFFSET[0], BASE_OFFSET[1]);

// Candidate ladder: concentric rings of slots around the centroid. Rings
// grow by RING_STEP px; each ring holds as many slots as fit at roughly
// SLOT_ARC px of arc apart, so the outer rings offer more directions.
// Both are sized off the badge — SLOT_ARC comfortably exceeds a badge
// diameter, so most slots on a ring are usable rather than mutually
// exclusive. RING_COUNT caps how far a leader can stretch: a badge in a
// hopeless cluster reaches out rather than sitting on its neighbour.
const RING_STEP = 29;
const RING_COUNT = 14;
const SLOT_ARC = 37;
const MIN_SLOTS_PER_RING = 8;

/** Longest a leader line can get (px) — the outermost ring's radius. */
export const MAX_LEADER_PX = BASE_RADIUS + RING_STEP * (RING_COUNT - 1);

// Hysteresis band. A badge needs PAD_TAKE px of clearance to move INTO a
// slot but only PAD_KEEP to stay in the one it already holds, so a badge
// that is merely grazing its neighbour holds still instead of flip-
// flopping between two slots as you nudge the camera.
const PAD_TAKE = 8;
const PAD_KEEP = 2;

// Anchor dots are OTHER parcels' obstacles: a badge that covered a
// neighbouring parcel's dot would hide the very mark it exists to point
// at. A callout is never pushed off its own dot — that one it is
// supposed to point at. circle-radius 3 + 1.25 stroke in map.js.
const ANCHOR_DOT_RADIUS = 4.25;

/** Outer radius of the largest badge — the 3-digit case. */
export const MAX_BADGE_RADIUS = 17.05;

// Grid cell for the collision hash. Must be >= the largest clearance any
// single test can need, so scanning the 3x3 neighbourhood is guaranteed
// to catch every hit. Derived, not typed in, so it can't drift out of
// step when the badge is resized.
const CELL = Math.ceil(MAX_BADGE_RADIUS * 2 + PAD_TAKE);

/**
 * Outer pixel radius of a badge, INCLUDING its white stroke — mirrors the
 * `circle-radius` step expression + `circle-stroke-width` on the
 * `parcel-num-badge` layer. Keep the two in sync: this is what decides
 * whether two badges are judged to overlap.
 */
export function badgeRadius(seqStr) {
  const len = String(seqStr ?? '').length;
  if (len >= 3) return MAX_BADGE_RADIUS;   // 14.85 + 2.2 stroke
  if (len === 2) return 14.85;             // 12.65 + 2.2
  return 13.2;                             // 11 + 2.2
}

let CANDIDATES = null;

/**
 * The candidate slot ladder as [dx, dy] pixel offsets, index = slot
 * number. Slot 0 is exactly BASE_OFFSET; within each ring the angles are
 * ordered by how far they swing off the canonical direction (nearest
 * first, upward on ties), so a bumped badge lands as close to where the
 * eye expects it as the space allows. Built once — the ladder depends
 * only on constants, never on the camera, which is what makes a slot
 * index a stable thing to remember between frames.
 */
export function calloutCandidates() {
  if (CANDIDATES) return CANDIDATES;
  const out = [BASE_OFFSET.slice()];
  for (let ring = 0; ring < RING_COUNT; ring++) {
    const radius = BASE_RADIUS + ring * RING_STEP;
    const count = Math.max(
      MIN_SLOTS_PER_RING,
      Math.round((2 * Math.PI * radius) / SLOT_ARC),
    );
    const step = (2 * Math.PI) / count;
    // k = 0, -1, +1, -2, +2 ... off the base angle. Negative first because
    // screen y grows downward, so it swings toward straight up.
    for (let k = ring === 0 ? 1 : 0; k < count; k++) {
      const angle = BASE_ANGLE + (k % 2 === 1 ? -1 : 1) * Math.ceil(k / 2) * step;
      out.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
  }
  CANDIDATES = out;
  return CANDIDATES;
}

/**
 * Slot for a badge drawn INSIDE its own parcel, with no leader or anchor
 * dot (Jason, 2026-10-22: the callouts sat on the roll numbers in the
 * report maps). Offered only where the caller found the disc fits inside
 * the parcel (inlineBadgeFits) — a parcel big on screen — so there is no
 * doubt which parcel the number belongs to. Small parcels keep callouts.
 * The offset itself is the caller's (`item.inline`), since it depends on
 * the roll label above which the badge sits.
 */
export const INLINE_SLOT = -1;

/**
 * True when a badge disc of radius `r` centred at (x, y) lies inside the
 * polygon `rings` (screen px, [[x, y], ...] per ring, holes included,
 * even-odd) with at least `margin` px between the disc and every edge.
 */
export function inlineBadgeFits(rings, x, y, r, margin) {
  const need = r + margin;
  let inside = false;
  for (const ring of rings || []) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[j];
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      if (segmentDistance(x, y, ax, ay, bx, by) < need) return false;
    }
  }
  return inside;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Pixel offset for a slot index, falling back to the canonical position
 *  for anything out of range. */
export function calloutOffset(slot) {
  const c = calloutCandidates();
  return c[Number.isInteger(slot) && slot >= 0 && slot < c.length ? slot : 0];
}

// Cell coordinates fold into one integer key rather than a string: the
// first-fit scan can run hundreds of candidates deep for a badge in a
// dense cluster, and integer Map keys keep that off the hot path.
const GRID_ORIGIN = 32768;
const cellKey = (gx, gy) => (gx + GRID_ORIGIN) * 65536 + (gy + GRID_ORIGIN);

function makeGrid() {
  const cells = new Map();
  return {
    add(x, y, r, owner) {
      const key = cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
      const bucket = cells.get(key);
      if (bucket) bucket.push({ x, y, r, owner });
      else cells.set(key, [{ x, y, r, owner }]);
    },
    /** True when nothing already placed is within r + other.r + pad,
     *  ignoring anything belonging to `owner` — a callout's own anchor
     *  dot must never repel its own badge. */
    clear(x, y, r, pad, owner) {
      const cx = Math.floor(x / CELL);
      const cy = Math.floor(y / CELL);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = cells.get(cellKey(gx, gy));
          if (!bucket) continue;
          for (const o of bucket) {
            if (o.owner === owner) continue;
            const need = r + o.r + pad;
            const dx = x - o.x;
            const dy = y - o.y;
            if (dx * dx + dy * dy < need * need) return false;
          }
        }
      }
      return true;
    },
  };
}

/**
 * Assign each callout a slot from the ladder such that no two badges
 * overlap (and no badge covers another parcel's anchor dot).
 *
 * `items` are the projected callouts — `{ key, x, y, r }` in screen px —
 * in draw order; lower numbers are placed first, so they keep the
 * canonical position and later ones give way. An item may carry
 * `inline: [dx, dy]`, an offset at which its badge fits inside its own
 * parcel: those are placed before every callout and take INLINE_SLOT
 * whenever the spot is clear, since that position cannot move and a
 * callout can. `prevSlots` is the map
 * returned by the previous solve: a badge that can't have its first
 * choice will hold the slot it already occupies as long as that slot is
 * still workable, which is what stops the badges dancing during a pan.
 * `viewport` ({ width, height }, optional) skips the collision work for
 * callouts far enough off-screen that neither they nor their leaders can
 * be seen.
 *
 * Returns a fresh Map of key -> slot index; feed it back in next time.
 */
export function solveCalloutSlots(items, prevSlots, viewport) {
  const candidates = calloutCandidates();
  const grid = makeGrid();
  const slots = new Map();
  const prev = prevSlots instanceof Map ? prevSlots : null;

  // Off-screen callouts get the canonical offset without a collision
  // pass: their badges can't be seen, and leaving them out of the grid
  // keeps the solve proportional to what's actually on screen rather
  // than to the size of the result set.
  const live = [];
  for (const it of items) {
    if (viewport && !nearViewport(it, viewport)) slots.set(it.key, 0);
    else live.push(it);
  }

  for (const it of live) grid.add(it.x, it.y, ANCHOR_DOT_RADIUS, it.key);

  // Leaders already drawn, as [x1, y1, x2, y2]. A slot whose leader
  // crosses one of them reads as each number pointing at the other's
  // parcel (Lac du Bonnet 1200 + 1300, 2026-10-13), so crossing slots are
  // refused while any uncrossed slot is left; only a cluster with none
  // falls back to the plain overlap test.
  const leaders = [];
  const rest = [];
  for (const it of live) {
    const held = prev ? prev.get(it.key) : undefined;
    // The caller only offers a spot whose disc is already inside the
    // parcel with room to spare, so all it needs here is not to touch
    // what is placed: a neighbour's dot just over the lot line must not
    // send a big parcel's number back out to a callout.
    if (Array.isArray(it.inline) &&
        fits(grid, it, it.inline, held === INLINE_SLOT ? 0 : PAD_KEEP)) {
      slots.set(it.key, INLINE_SLOT);
      grid.add(it.x + it.inline[0], it.y + it.inline[1], it.r, null);
    } else {
      rest.push(it);
    }
  }
  for (const it of rest) {
    const held = prev ? prev.get(it.key) : undefined;
    let chosen = -1;
    for (const avoidCross of [true, false]) {
      const ok = (slot, pad) =>
        fits(grid, it, candidates[slot], pad) &&
        (!avoidCross || !crossesAny(leaders, it, candidates[slot]));
      if (ok(0, PAD_TAKE)) {
        // First choice is free with room to spare — always snap back to
        // it, so badges recover the canonical look as a cluster opens up.
        chosen = 0;
      } else if (
        Number.isInteger(held) && held > 0 && held < candidates.length &&
        ok(held, PAD_KEEP)
      ) {
        chosen = held;
      } else {
        for (let s = 1; s < candidates.length; s++) {
          if (ok(s, PAD_TAKE)) { chosen = s; break; }
        }
      }
      if (chosen >= 0) break;
    }
    // Nothing clear anywhere on the ladder (a very dense cluster): keep
    // whatever it had rather than snapping it home, and accept the
    // overlap — every parcel keeps a visible number either way.
    if (chosen < 0) chosen = Number.isInteger(held) && held >= 0 && held < candidates.length ? held : 0;
    slots.set(it.key, chosen);
    const [dx, dy] = candidates[chosen];
    // Placed badges block everyone INCLUDING their own parcel's later
    // tests, so pass no owner — only the anchor dot is self-exempt.
    grid.add(it.x + dx, it.y + dy, it.r, null);
    leaders.push([it.x, it.y, it.x + dx, it.y + dy]);
  }
  return slots;
}

/** True when the leader from `it` to its badge at [dx, dy] properly
 *  crosses any placed leader. Leaders that only touch at an end (two
 *  parcels sharing an anchor point) do not count. */
function crossesAny(leaders, it, [dx, dy]) {
  const a = [it.x, it.y, it.x + dx, it.y + dy];
  return leaders.some((b) => segmentsCross(a, b));
}

function segmentsCross([ax, ay, bx, by], [cx, cy, dx, dy]) {
  const orient = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function fits(grid, it, [dx, dy], pad) {
  return grid.clear(it.x + dx, it.y + dy, it.r, pad, it.key);
}

function nearViewport(it, { width, height }) {
  return (
    it.x >= -MAX_LEADER_PX && it.x <= width + MAX_LEADER_PX &&
    it.y >= -MAX_LEADER_PX && it.y <= height + MAX_LEADER_PX
  );
}

// Unit tests for lib/calloutPlacement.js — the screen-space solver that
// stops the numbered parcel callouts from stacking on top of each other
// when several parcels sit close together on screen. Verifies the
// canonical offset is kept whenever it fits, that crowded badges are
// pushed to genuinely clear space, and that the hysteresis band keeps a
// bumped badge still while the camera moves.
//
// Run: cd web && node test/calloutPlacement.test.js

import assert from 'node:assert/strict';
import {
  BASE_OFFSET,
  MAX_LEADER_PX,
  badgeRadius,
  calloutCandidates,
  calloutOffset,
  solveCalloutSlots,
} from '../src/lib/calloutPlacement.js';

// Mirrors the collision rule inside the solver: two badges clash when
// their discs (radius includes the white stroke) touch at all.
function overlaps(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r;
}

function badgeAt(item, slots) {
  const [dx, dy] = calloutOffset(slots.get(item.key));
  return { x: item.x + dx, y: item.y + dy, r: item.r };
}

function item(key, x, y, seqStr = String(key)) {
  return { key: String(key), x, y, r: badgeRadius(seqStr) };
}

/** Every pair of badges clear of every other, and clear of every dot. */
function assertNoOverlap(items, slots) {
  const badges = items.map((it) => badgeAt(it, slots));
  for (let i = 0; i < badges.length; i++) {
    for (let j = i + 1; j < badges.length; j++) {
      assert.ok(
        !overlaps(badges[i], badges[j]),
        `badges ${items[i].key} and ${items[j].key} overlap`,
      );
    }
    for (const other of items) {
      // A badge must not bury a neighbouring parcel's anchor dot (r 4.25).
      if (other.key === items[i].key) continue;
      assert.ok(
        Math.hypot(badges[i].x - other.x, badges[i].y - other.y) >= badges[i].r + 4.25,
        `badge ${items[i].key} covers anchor ${other.key}`,
      );
    }
  }
}

// ---- badgeRadius: mirrors the circle-radius step expr + 2.2px stroke --
assert.equal(badgeRadius('7'), 13.2);
assert.equal(badgeRadius('42'), 14.85);
assert.equal(badgeRadius('123'), 17.05);
assert.equal(badgeRadius('1234'), 17.05);
// Site # overrides can be non-numeric strings.
assert.equal(badgeRadius('A'), 13.2);
assert.equal(badgeRadius(''), 13.2);
assert.equal(badgeRadius(null), 13.2);

// ---- a callout is never pushed off its OWN parcel --------------------
{
  // The badge sits close enough to its anchor dot that treating that dot
  // as an obstacle would bump every callout outward for nothing — most
  // visibly for the widest (3-digit) badges.
  for (const seq of ['1', '42', '123']) {
    const solo = [item(seq, 500, 500, seq)];
    assert.equal(
      solveCalloutSlots(solo, null).get(seq), 0,
      `a lone "${seq}" callout should keep the canonical offset`,
    );
  }
}

// ---- the candidate ladder -------------------------------------------
{
  const c = calloutCandidates();
  // Slot 0 is exactly the long-standing up-and-right offset.
  assert.deepEqual(c[0], BASE_OFFSET);
  // Rings only ever grow, and none reaches past the advertised cap.
  for (const [dx, dy] of c) {
    assert.ok(Math.hypot(dx, dy) <= MAX_LEADER_PX + 1e-9);
  }
  // Slot 1 stays near the canonical direction rather than jumping across
  // the parcel — a bumped badge should land close to where the eye looks.
  const ang = (o) => Math.atan2(o[1], o[0]);
  assert.ok(Math.abs(ang(c[1]) - ang(c[0])) < Math.PI / 3);
  // Out-of-range slots fall back to the canonical offset.
  assert.deepEqual(calloutOffset(c.length + 99), BASE_OFFSET);
  assert.deepEqual(calloutOffset(undefined), BASE_OFFSET);
  assert.deepEqual(calloutOffset(-1), BASE_OFFSET);
}

// ---- parcels far apart keep the canonical position -------------------
{
  const items = [item(1, 100, 100), item(2, 400, 100), item(3, 100, 400)];
  const slots = solveCalloutSlots(items, null);
  assert.equal(slots.size, 3);
  for (const it of items) assert.equal(slots.get(it.key), 0);
}

// ---- two parcels at the same spot get pushed apart -------------------
{
  const items = [item(1, 200, 200), item(2, 202, 201)];
  const slots = solveCalloutSlots(items, null);
  // Lowest number keeps the canonical slot; the later one gives way.
  assert.equal(slots.get('1'), 0);
  assert.notEqual(slots.get('2'), 0);
  assertNoOverlap(items, slots);
}

// ---- a dense cluster separates completely ----------------------------
{
  // 24 parcels inside a 60x60 px box — the townsite-at-low-zoom case.
  const items = [];
  for (let i = 0; i < 24; i++) {
    items.push(item(i + 1, 300 + (i % 6) * 12, 300 + Math.floor(i / 6) * 12));
  }
  const slots = solveCalloutSlots(items, null);
  assert.equal(slots.size, 24);
  assertNoOverlap(items, slots);
  // "Let leaders grow long" — some badges must have reached well past the
  // first ring, but none past the cap.
  const reach = items.map((it) => {
    const [dx, dy] = calloutOffset(slots.get(it.key));
    return Math.hypot(dx, dy);
  });
  assert.ok(Math.max(...reach) > Math.hypot(...BASE_OFFSET));
  assert.ok(Math.max(...reach) <= MAX_LEADER_PX + 1e-9);
}

// ---- three-digit badges are measured at their real size --------------
{
  // Same geometry, bigger discs: spacing that clears for 1-digit numbers
  // must still clear once the badges are 3-digit.
  const wide = [item(100, 200, 200, '100'), item(101, 231, 200, '101')];
  const slots = solveCalloutSlots(wide, null);
  assertNoOverlap(wide, slots);
}

// ---- solving is deterministic and idempotent -------------------------
{
  const items = [item(1, 200, 200), item(2, 205, 203), item(3, 210, 199)];
  const first = solveCalloutSlots(items, null);
  const again = solveCalloutSlots(items, first);
  for (const it of items) assert.equal(again.get(it.key), first.get(it.key));
  // A pure pan (every anchor translated alike) must not reshuffle.
  const panned = items.map((it) => ({ ...it, x: it.x + 37, y: it.y - 14 }));
  const afterPan = solveCalloutSlots(panned, again);
  for (const it of items) assert.equal(afterPan.get(it.key), first.get(it.key));
}

// ---- hysteresis: a bumped badge holds through the marginal zone ------
{
  // Badge discs are r=13.2, so they need 26.4 px to touch, 34.4 to be
  // taken (pad 8) and 28.4 to be kept (pad 2).
  const tight = [item(1, 100, 100), item(2, 120, 100)];
  const bumped = solveCalloutSlots(tight, null);
  const held = bumped.get('2');
  assert.notEqual(held, 0, 'badge 2 should be bumped when 20px apart');

  // Ease apart into the hysteresis band (31 px): slot 0 is free of an
  // actual overlap but not by the margin required to move in, so the
  // badge should stay exactly where it is rather than snap back.
  const marginal = [item(1, 100, 100), item(2, 131, 100)];
  const stillHeld = solveCalloutSlots(marginal, bumped);
  assert.equal(stillHeld.get('2'), held, 'badge 2 should hold its slot in the band');

  // Past the band, it reclaims the canonical position.
  const roomy = [item(1, 100, 100), item(2, 140, 100)];
  assert.equal(solveCalloutSlots(roomy, stillHeld).get('2'), 0);

  // ...and with no memory of the bumped slot, the same marginal geometry
  // still resolves to something clear rather than to slot 0.
  const cold = solveCalloutSlots(marginal, null);
  assert.notEqual(cold.get('2'), 0);
  assertNoOverlap(marginal, cold);
}

// ---- off-screen callouts skip the collision pass ---------------------
{
  const viewport = { width: 800, height: 600 };
  const off = MAX_LEADER_PX + 500;
  const items = [
    item(1, 400, 300),
    item(2, 402, 301),
    item(3, -off, 300),      // far left, badge can't be seen
    item(4, -off + 2, 301),  // stacked on it, and equally invisible
  ];
  const slots = solveCalloutSlots(items, null, viewport);
  assert.equal(slots.size, 4);
  // On-screen pair still de-conflicted...
  assert.equal(slots.get('1'), 0);
  assert.notEqual(slots.get('2'), 0);
  // ...off-screen pair left at the canonical offset, no work done.
  assert.equal(slots.get('3'), 0);
  assert.equal(slots.get('4'), 0);
  // A callout just outside the frame is still solved: its badge and
  // leader can reach back into view.
  const edge = [item(1, 795, 300), item(2, 812, 300)];
  const edgeSlots = solveCalloutSlots(edge, null, viewport);
  assert.notEqual(edgeSlots.get('2'), 0);
}

// ---- degenerate input ------------------------------------------------
{
  assert.equal(solveCalloutSlots([], null).size, 0);
  assert.equal(solveCalloutSlots([], new Map()).size, 0);
  // A junk `prevSlots` value must not throw.
  assert.equal(solveCalloutSlots([item(1, 10, 10)], { get: null }).get('1'), 0);
}

console.log('calloutPlacement.test.js: all assertions passed');

/*
 * Parcel numbering — the stable 1..N sequence stamped onto a multi-parcel
 * result set so the map badges and the results-table "#" column agree.
 *
 * Ported from the Manitoba app (mb-parcelsearch lib/parcelNumbering.js)
 * with two Winnipeg-specific changes:
 *
 *   1. ORDERING. Manitoba sorts by municipality code first, then Roll #.
 *      Winnipeg is one municipality, so the sort is Roll # as a NUMBER
 *      (so 90 sorts before 100, not after it as a string sort would).
 *
 *   2. GROUPING. Manitoba groups by an explicit `_saleGroupId`. Winnipeg
 *      has two things that make several ROWS one numbered subject, and
 *      both must collapse or the map ends up with two badges stacked on
 *      one polygon:
 *        - Same Instrument Number — a multi-parcel sale. One transaction
 *          over several rolls is ONE comp (see the handoff's decision 6:
 *          the instrument, not date+price, defines a sale).
 *        - Same Roll Number — a repeat sale. Two rows, one parcel, one
 *          polygon on the map, so one number.
 *      These are unioned transitively (roll A + roll B on one instrument,
 *      then roll B alone on another, is one group), which is the only
 *      rule that keeps "one number per drawn polygon" true in every case.
 *
 * The number is a fixed identity — once assigned it stays glued to that
 * parcel however the table is later re-sorted or narrowed — so callers
 * assign over the FULL result set, not the filtered subset. Assignment is
 * also order-independent of the table sort: it re-derives its own order
 * from the roll numbers, so calling it twice on the same set is a no-op.
 *
 * Pure (no DOM / no map) so it unit-tests in plain node; main.js owns the
 * "when" and map.js owns the "where".
 */

/**
 * Roll # as a number. Winnipeg rolls are plain digit strings
 * ("01000001000"); strip anything else and parse. Non-numeric / missing
 * rolls sort last via +Infinity rather than colliding at 0.
 */
export function rollNumericValue(props) {
  const cleaned = String(props?.roll_number ?? '').replace(/[^0-9.]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : Infinity;
}

/** The raw roll string, trimmed; '' → null. Used as a group key. */
export function rollKey(props) {
  const raw = props?.roll_number;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/**
 * Group identity from the sale: the Land Titles instrument number, which
 * is what makes several rolls one transaction. Absent outside sales mode.
 */
export function instrumentKey(props) {
  const raw = props?._saleInstrument;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/**
 * Return the features ordered by roll (numeric), with the raw roll string
 * and the original index as stable tie-breakers. Does not mutate the input
 * array or the features. Features without `.properties` are dropped.
 */
export function orderForNumbering(features) {
  return (features || [])
    .filter((f) => f && f.properties)
    .map((f, idx) => ({
      f,
      idx,
      roll: rollNumericValue(f.properties),
      rollStr: String(f.properties.roll_number ?? ''),
    }))
    .sort((a, b) => {
      if (a.roll !== b.roll) return a.roll - b.roll;
      if (a.rollStr < b.rollStr) return -1;
      if (a.rollStr > b.rollStr) return 1;
      return a.idx - b.idx;
    })
    .map((e) => e.f);
}

/**
 * Assign each feature's `_seq` — the number on the map badge and in the
 * grid "#" column.
 *
 * 1..N in Roll # order, counting by SUBJECT rather than by row: rows
 * joined by a shared roll or a shared instrument (transitively) share one
 * number, and the count advances once per group. A six-roll assembly sold
 * under one instrument is one comp carrying one number, not six
 * consecutive ones; a parcel that sold twice is one badge, not two.
 *
 * Mutates the features and returns them in assigned order.
 */
export function assignParcelSeq(features) {
  const ordered = orderForNumbering(features);

  // Union-find over positions in `ordered`. Two rows are the same subject
  // if they share a roll or share an instrument; unioning both keys in one
  // structure is what makes the relation transitive.
  const parent = ordered.map((_, i) => i);
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    // Path-compress so repeated finds stay flat on large result sets.
    let c = i;
    while (parent[c] !== r) { const next = parent[c]; parent[c] = r; c = next; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Point the later group at the earlier one so a root is always the
    // group's first member in roll order — which is what numbers it.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  const firstByRoll = new Map();
  const firstByInstrument = new Map();
  ordered.forEach((f, i) => {
    const roll = rollKey(f.properties);
    if (roll != null) {
      if (firstByRoll.has(roll)) union(i, firstByRoll.get(roll));
      else firstByRoll.set(roll, i);
    }
    const inst = instrumentKey(f.properties);
    if (inst != null) {
      if (firstByInstrument.has(inst)) union(i, firstByInstrument.get(inst));
      else firstByInstrument.set(inst, i);
    }
  });

  const seqByRoot = new Map();
  let next = 1;
  ordered.forEach((f, i) => {
    const root = find(i);
    if (!seqByRoot.has(root)) seqByRoot.set(root, next++);
    f.properties._seq = seqByRoot.get(root);
  });
  return ordered;
}

/** Remove any previously-stamped `_seq` (used when a result set drops to
 *  a single parcel, so a stray "1" badge never lingers). */
export function clearParcelSeq(features) {
  for (const f of features || []) {
    if (f && f.properties && '_seq' in f.properties) delete f.properties._seq;
  }
}

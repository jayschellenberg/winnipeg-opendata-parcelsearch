/*
 * Historical → current parcel size-change classification.
 *
 * For the Historical overlay: match each historical-snapshot parcel to the
 * current parcel with the same roll (Winnipeg roll numbers are city-wide
 * unique — no muni qualifier) and classify how much its assessed land area
 * changed. The map colours changed parcels and the popup shows old → new sq ft.
 *
 * IMPORTANT (surfaced in the popup): a size change can be a real subdivision /
 * consolidation, OR a re-survey / geometry correction, OR — where we fall back
 * to the simplified (~0.3-3 m) historical display geometry — a simplification
 * artifact. It is a pointer to investigate, not proof. Where both snapshots
 * carry an assessor AREA (assessed_land_area) the delta is roll-vs-roll and
 * immune to simplification; that is the high-confidence case.
 *
 * Pure + dependency-free — area is supplied by the caller as roll→sqft maps, so
 * this unit-tests without turf or the DOM.
 */

export const SIZE_MINOR_PCT = 5;    // |Δ| >  5%  → minor change
export const SIZE_MAJOR_PCT = 25;   // |Δ| > 25%  → material change

/** Band for a signed percent delta. */
export function sizeBand(deltaPct) {
  if (deltaPct == null || !Number.isFinite(deltaPct)) return 'unknown';
  const a = Math.abs(deltaPct);
  if (a > SIZE_MAJOR_PCT) return 'major';
  if (a > SIZE_MINOR_PCT) return 'minor';
  return 'same';
}

/**
 * Classify size changes between two roll→sqft maps.
 *
 * @param {Map<string,number>} histByRoll  historical roll → sq ft
 * @param {Map<string,number>} curByRoll   current   roll → sq ft
 * @returns {{ byRoll: Map<string,{histArea:number,curArea:number|null,deltaPct:number|null,band:string}>,
 *             summary: {same:number,minor:number,major:number,gone:number,appeared:number,unknown:number} }}
 *   `band` is one of 'same' | 'minor' | 'major' | 'gone' | 'unknown'.
 *   'gone'     = roll present historically but not now (removed / merged away).
 *   'appeared' = roll present now but not historically (counted in summary only).
 */
export function computeSizeChanges(histByRoll, curByRoll) {
  const byRoll = new Map();
  const summary = { same: 0, minor: 0, major: 0, gone: 0, appeared: 0, unknown: 0 };

  for (const [roll, h] of histByRoll) {
    const c = curByRoll.get(roll);
    if (c == null) {
      byRoll.set(roll, { histArea: h, curArea: null, deltaPct: null, band: 'gone' });
      summary.gone++;
      continue;
    }
    if (!(h > 0) || !(c > 0)) {
      byRoll.set(roll, { histArea: h, curArea: c, deltaPct: null, band: 'unknown' });
      summary.unknown++;
      continue;
    }
    const deltaPct = ((c - h) / h) * 100;
    const band = sizeBand(deltaPct);
    byRoll.set(roll, { histArea: h, curArea: c, deltaPct, band });
    summary[band]++;
  }

  for (const roll of curByRoll.keys()) if (!histByRoll.has(roll)) summary.appeared++;

  return { byRoll, summary };
}

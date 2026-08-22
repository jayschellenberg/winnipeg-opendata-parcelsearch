/*
 * Jason's own verdicts on individual sales, where no instrument can be
 * right.
 *
 * WHY THIS FILE HAS TO EXIST. sabreBuildVerdict fires on a row whose
 * live roll shows no building, and that situation has two completely
 * different causes which the data cannot tell apart:
 *
 *   - the building stood at the sale and has been demolished since, so
 *     SABRE captured it and the roll is simply newer (185 BANNERMAN in
 *     reverse -- the case the instrument was built for); or
 *   - SABRE's figure is junk for that parcel and the roll is right.
 *
 * On 2026-08-22 the top-end review put four rows of IDENTICAL shape in
 * front of Jason -- SABRE reporting a building, live roll reporting none
 * -- and he split them two and two from knowledge of the properties. No
 * threshold, ratio or cross-check separates them, because the difference
 * is not in the data. Anything derived would have been a coin flip
 * dressed as a rule.
 *
 * SO THE OVERRIDE IS ON THE VERDICT, NOT THE CATEGORY. Dropping the
 * build verdict lets everything downstream recompute honestly:
 * saleCategory returns the row to Land on its own, and resolveMixedSales
 * re-reads the group -- which matters for 1204 STURGEON, whose sibling
 * parcel was dragged out of Land only because of the verdict being
 * dropped here. Forcing the category instead would have fixed one row
 * and left its sibling wrong.
 *
 * WHAT DOES NOT BELONG HERE. This is not a place to silence findings
 * that are inconvenient, and not a substitute for fixing a rule that is
 * wrong in general -- the six parking false positives were fixed by
 * narrowing the SABRE gate, not by listing them here. It is for the
 * residue where the instruments have done their best and a human who
 * knows the property has to say which way it falls. Every entry carries
 * the reason and the date, so a later reader can weigh it rather than
 * inherit it blindly.
 */

/**
 * @typedef {object} SaleJudgement
 * @property {string} roll     11-digit roll number
 * @property {'no-building'|'priced-as-land'|'upheld'} verdict
 *   'no-building'    there is no building; DROP the already-built verdict
 *                    and let the row fall back to Land on its own.
 *   'priced-as-land' a building DID stand, but the price bought dirt --
 *                    a teardown. Downgrades to 'built-priced-as-land', so
 *                    the row stays in Land carrying the visible mark
 *                    rather than silently reading as a clean comp.
 *   'upheld'         changes nothing, and exists so the record shows the
 *                    row was reviewed and the instrument agreed --
 *                    otherwise a later session re-opens the same question
 *                    and gets the same surprise.
 * @property {ReadonlyArray<string>} [assemblyRolls]
 *   Every roll the transaction actually bought, when SABRE linked only
 *   some of them. Recorded even though the areas are carried separately,
 *   because it is the evidence for the number and the thing to re-check
 *   if it is ever questioned.
 * @property {number} [assemblyLandSf]
 *   The REAL land area of the assembly, in square feet, replacing the
 *   denominator SABRE supplied. Prefer this to withholding: an appraiser
 *   can use $127.63 and cannot use a blank. Only ever a figure sourced
 *   from a dated record -- never an estimate -- and the note must say
 *   where it came from.
 * @property {string} note     why, in Jason's terms
 * @property {string} decided  ISO date
 */

/** @type {ReadonlyArray<SaleJudgement>} */
export const SALE_JUDGEMENTS = Object.freeze([
  {
    roll: '14098347100',
    verdict: 'no-building',
    note: '2730 KING EDWARD STREET -- vacant multi-family land. SABRE reports '
      + '3,643 sf built 1960; the live roll reads VAGRI with no year built and no '
      + 'living area, and the sale prices at $35.62 per lot square foot over 43,518 '
      + 'sf, which is a land rate.',
    decided: '2026-08-22',
  },
  {
    roll: '07438470500',
    verdict: 'no-building',
    note: '1204 STURGEON ROAD -- vacant multifamily. SABRE reports 2,930 sf built '
      + '1963; the live roll reads CMVSR with no year built and no living area. '
      + 'Dropping the verdict also un-mixes instrument 5694029, returning its '
      + 'sibling parcel to Land.',
    decided: '2026-08-22',
  },
  {
    roll: '01009600025',
    verdict: 'priced-as-land',
    note: '365 OAKDALE -- multifamily REDEVELOPMENT. The 1937 house of 1,970 sf was '
      + 'real, so this is not a no-building case, but it cannot explain $5,500,000 '
      + 'over 67,755 sf: $2,792 per building square foot, 6.7x the p99 for its own '
      + 'pre-1945 cohort. The price bought dirt. Stays in Land with the '
      + 'priced-as-land mark, which also un-mixes instrument 5265912 and returns its '
      + 'sibling parcel to Land.',
    decided: '2026-08-22',
  },
  {
    roll: '06093124800',
    verdict: 'priced-as-land',
    assemblyRolls: Object.freeze([
      '06093124800', '06060338000', '06060337000', '06060302000', '06060301000',
    ]),
    assemblyLandSf: 27422,
    note: '165 PROVENCHER -- REDEVELOPMENT, assembled from five parcels that SABRE '
      + 'never linked: 165 PROVENCHER (12,111 sf), 157 PROVENCHER (4,044, restaurant), '
      + '155 PROVENCHER (3,189, office), 160 DUMOULIN (4,039) and 158 DUMOULIN '
      + '(4,039). SABRE saw only ONE roll and, worse, gave it 4,044 sf -- which is 157 '
      + "PROVENCHER's area, not its own 12,111. The result was $865.48 per lot square "
      + 'foot on a rate that should read $127.63, high by 6.8x. Areas are from the '
      + 'wpg-parcel-history snapshot 2023-11-13, two weeks before the 2023-11-28 sale, '
      + 'so they are the areas as they stood. The 1937/1951 building did not drive '
      + '$3,500,000; the assembled dirt did.',
    decided: '2026-08-22',
  },
  {
    roll: '14098695400',
    verdict: 'upheld',
    note: 'The unaddressed $9,700,000 M1 sale. The live roll reads VINDU with no '
      + 'building and the price works out to $1,060 per building square foot, which '
      + 'looks like a land sale -- but it DOES include buildings. Jason: "an oddity '
      + 'but an improved sale." Reviewed and upheld; do not reverse it on the roll.',
    decided: '2026-08-22',
  },
  {
    roll: '02040550500',
    verdict: 'upheld',
    note: '599 WASHINGTON -- improved, and CONSOLIDATED, which is why the roll is '
      + 'retired. A demolition permit dated 2023-07-27 corroborates that something '
      + 'stood through both the 2021 and 2022 sales.',
    decided: '2026-08-22',
  },
]);

const BY_ROLL = new Map(SALE_JUDGEMENTS.map((j) => [j.roll, j]));

/**
 * Jason's judgement for a roll, or null.
 *
 * Keyed on the roll alone rather than roll + instrument: both current
 * 'no-building' entries are statements about the PARCEL ("there is no
 * building on it"), which holds for every sale of it. A judgement that
 * genuinely applied to one transaction and not another would need the
 * instrument too, and this should grow that key rather than pretend.
 *
 * @param {string} roll
 * @returns {SaleJudgement|null}
 */
export function saleJudgement(roll) {
  const key = String(roll ?? '').trim();
  if (!key) return null;
  return BY_ROLL.get(key) || null;
}

/**
 * The corrected land denominator for a sale SABRE mis-measured, or null.
 *
 * Returns `{landSf, parcels}` so the caller can rebuild $/Lot SF, $/Acre
 * AND $/Lot -- the last of which divides by the parcel COUNT, and SABRE
 * had one parcel where the deal bought five.
 *
 * @param {string} roll
 * @returns {{landSf: number, parcels: number}|null}
 */
export function judgedAssembly(roll) {
  const j = saleJudgement(roll);
  if (!j || !(Number(j.assemblyLandSf) > 0)) return null;
  return {
    landSf: Number(j.assemblyLandSf),
    parcels: j.assemblyRolls ? j.assemblyRolls.length : 1,
  };
}

/**
 * How an inferred already-built verdict on this roll should be rewritten,
 * or undefined to leave it alone.
 *
 * Returns null to DROP the verdict, the string 'built-priced-as-land' to
 * downgrade it, and undefined when there is no judgement or the
 * instrument was upheld. Null and undefined mean different things here,
 * which is why the caller checks with `!== undefined` rather than
 * truthiness.
 *
 * @param {string} roll
 * @returns {null|'built-priced-as-land'|undefined}
 */
export function judgedVerdict(roll) {
  const j = saleJudgement(roll);
  if (!j) return undefined;
  if (j.verdict === 'no-building') return null;
  if (j.verdict === 'priced-as-land') return 'built-priced-as-land';
  return undefined;
}

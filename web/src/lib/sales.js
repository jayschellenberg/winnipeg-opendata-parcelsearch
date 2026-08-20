// Pure sales-CSV helpers, extracted from main.js so the test suite
// can import them — main.js wires DOM elements at import time and
// can't be loaded under plain Node.

// normalizeRoll lives in soda.js (where rollClause already uses it for
// the query side); the local import + re-export keeps a single
// implementation so the sales tab's client-side joins (matchedRolls.has,
// saleByRoll.get, subject lookups) use the SAME function that built the
// SoQL clause — drift here meant a just-padded roll wouldn't join to its
// own live record.
import { normalizeRoll } from '../soda.js';
import { isVacantUseCode } from './salesFilters.js';
export { normalizeRoll };

/**
 * Parse a numeric cell out of a SABRE export.
 *
 * Every money and area field has to come through here rather than a bare
 * parseFloat, because parseFloat reads formatted numbers WRONG rather
 * than refusing them:
 *
 *   parseFloat('1,234,567')   -> 1        (stops at the first comma)
 *   parseFloat('$1,234,567')  -> NaN -> 0 (leading symbol)
 *
 * The first is the dangerous one. A $1.2M sale silently became a sale
 * price of 1 — which then looks exactly like SABRE's nominal $1
 * non-arms-length sentinel, so the "Hide $0 / $1 transfers" filter
 * removed the whole transaction from the comp set without a word. The
 * second is what left Sworn Value blank on rows that plainly had a
 * value: it parsed to 0, and 0 reads as "not provided".
 *
 * Strips currency symbols, thousands separators and whitespace, and
 * accepts accounting-style negatives — (1,234) meaning -1234 — so a
 * credit or adjustment column can't come back positive.
 *
 * Returns `null` for anything that isn't a number, letting each caller
 * decide what missing means, rather than collapsing "absent" and "zero".
 */
export function parseNumeric(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).trim();
  if (s === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  // Keep digits, decimal point and a leading sign; drop $ , spaces and
  // any stray currency code.
  s = s.replace(/[^0-9.\-+]/g, '');
  if (s === '' || s === '-' || s === '+' || s === '.') return null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** parseNumeric, collapsed to 0 for the callers that want a plain sum. */
function numOrZero(value) {
  const n = parseNumeric(value);
  return n == null ? 0 : n;
}

/**
 * The canonical columns two rows of one sale must agree on to be the
 * same row exported twice: every field dedupAndGroupSales reads EXCEPT
 * Zoning — the field the twins disagree on — and except the (Parcel ID,
 * Instrument Number) pair, which is already the group key.
 *
 * Leaving Parcel ID out is deliberate rather than incidental: the key
 * holds it in NORMALIZED form, so a 10-digit `6070731000` and its
 * 11-digit twin `06070731000` must not be read as two different
 * buildings just because the export wrote the roll two ways.
 */
const TWIN_SIGNATURE_COLUMNS = [
  'Sale Dates', 'Sold Price', 'Sworn Value',
  'Land Actual sqft', 'Land Assessed sqft', 'Living Area', 'Year Built',
  'Par Use Code', 'Property Type', 'Property Sub Type',
  'Street Number', 'Street Direction', 'Street Name', 'Number of Unit',
  'N1 ID', 'Source', 'MLS #', 'MLS Date', 'List Price', 'Orig Price',
  'DOM', 'Bldg Type', 'Style', 'Site Influences',
];

/**
 * Signature of a row for the twin collapse: the raw cells, trimmed and
 * NUL-joined. NUL because no SABRE cell contains one, so no pair of
 * neighbouring values can run together into a signature that collides
 * with a different pair.
 */
function twinSignature(r) {
  return TWIN_SIGNATURE_COLUMNS.map((c) => String(r[c] ?? '').trim()).join('\u0000');
}

/**
 * Collapse the blank-Zoning twin rows SABRE exports inside a single
 * (Parcel ID, Instrument Number).
 *
 * SABRE frequently writes a component row TWICE: once with the Zoning
 * cell filled, once with it blank and every other cell identical. The
 * merge below reads that as two building components and SUMS their
 * Living Area, so the sale reports exactly 2.00x the building it has —
 * 927 DORCHESTER (roll 12030200000, instrument 5145676) came out at
 * 5,516 sf for a 2,758 sf house, which halves $/Bldg SF on the row. In
 * the 52-file archive (19,809 rows) there are 1,022 such twins across
 * 785 sales, 609 of them doubled outright: 16,681,358 sf reported
 * against 8,340,679 sf of real living area.
 *
 * So: bucket the sale's rows on every canonical field EXCEPT Zoning and
 * let each bucket contribute exactly ONE row to the merge. Rows that
 * differ anywhere else — a genuine second building section — land in
 * separate buckets and still merge and still sum. That is why the test
 * is field-by-field rather than "drop the rows with a blank Zoning": a
 * real section that happens to carry no zoning must survive.
 *
 * SPLIT-ZONED PARCELS ARE REAL and must not be summed either. Two rows
 * in the archive are identical except that both carry a zoning and the
 * two DIFFER — roll 08005959000 (RR5 / RMFL) and roll 08081223180
 * (RMU / RR5). That is one parcel lying in two zoning districts, not two
 * buildings, so it collapses like any other bucket but keeps BOTH
 * zoning taken from whichever row actually carries one. NOT joined: see
 * which of the two rows the export happened to write first (the pair
 * above therefore reads "RMFL / RR5").
 */
function collapseZoningTwins(saleRows) {
  if (saleRows.length < 2) return saleRows;
  const buckets = new Map();
  for (const r of saleRows) {
    const sig = twinSignature(r);
    let b = buckets.get(sig);
    if (!b) { b = { rows: [], zonings: [] }; buckets.set(sig, b); }
    b.rows.push(r);
    const zoning = String(r['Zoning'] ?? '').trim();
    if (zoning && !b.zonings.includes(zoning)) b.zonings.push(zoning);
  }
  const out = [];
  // Map iteration is first-appearance order, so the surviving rows reach
  // the merge in the export's own order — the first-non-blank rules
  // below (use code, N1 ID, the MLS fields) still resolve the way they
  // did before the collapse existed.
  for (const b of buckets.values()) {
    // Prefer a member that actually carries a zoning: the blank-cell
    // twin is the defective copy, and keeping it would trade the doubled
    // living area for a silently emptied Zoning column.
    const keep = b.rows.find((r) => String(r['Zoning'] ?? '').trim()) || b.rows[0];
    // Clone rather than write the joined zoning back onto the caller's
    // row: salesDbMerge hands us the very row objects it holds, and this
    // module is pure.
    // Two DIFFERENT non-blank zonings on otherwise identical rows read
    // like a split-zoned parcel, and an earlier pass joined them as
    // "RMU / RR5". The City's own record says otherwise: roll
    // 08081223180 (694 ST ANNE'S) carries a single zoning, "RMU - RES -
    // MIX USE", and RR5 appears nowhere in it. Joining therefore puts a
    // district on screen that the assessment roll does not carry —
    // inventing evidence, which is worse than dropping a stale duplicate
    // cell. Keep the row we chose and let its own zoning stand.
    out.push(keep);
  }
  return out;
}

/**
 * Every usable Year Built across a sale's component rows, distinct and
 * ascending.
 *
 * A genuine multi-section sale carries a different year per section —
 * roll 13081715000 instrument 5141959 has 1954 / 1958 / 1962 / 1911 /
 * 1913 — and the merge used to keep only the oldest, so four of those
 * five years never reached the grid. Jason wants both figures: the list
 * describes the property, and the oldest (as a number, not this string)
 * is what a sort or a year filter can compare.
 *
 * Blank and unparseable cells are dropped rather than carried through as
 * empty strings. 538 rows across 224 sales sit in a multi-row group with
 * a blank Year Built, so a naive join would print a leading comma or a
 * stray gap on one sale in six.
 */
/**
 * Plausible construction years only.
 *
 * SABRE writes 9999 as a "not known" sentinel, and the archive also
 * carries years back to 1870. The old oldest-wins rule hid 9999 by
 * accident (any real year is smaller); listing every distinct year
 * surfaces it, so 208 EDMONTON would read "1957, 9999". Bound the
 * range rather than naming 9999, so the next sentinel the export
 * invents is caught without another edit. 0 is excluded for the same
 * reason parseNumeric keeps it: it is "not stated", not a year.
 */
const YEAR_BUILT_MIN = 1800;
const YEAR_BUILT_MAX = 2200;

/**
 * Living area for a sale whose rows SABRE wrote more than once.
 *
 * Summing every row is wrong, and not marginally: checked against the
 * City's own total_living_area (assessment-parcels-2026-03-10.parquet)
 * on the 168 multi-row sales that carry one, summing matched on 0 of
 * them. SABRE repeats the WHOLE building's area on each row rather than
 * splitting it between sections — 397 HORACE writes 1,950 sf three
 * times, once per suite, and the City says the building is 1,950 sf.
 *
 * But it does not repeat every time: on 355 of the 889 multi-row sales
 * the areas genuinely DIFFER, and those read like real sections
 * (1,764 + 378 + 1,554). So neither "always sum" nor "always take one"
 * is right.
 *
 * The rule that separates them is to sum the DISTINCT areas: a repeated
 * figure counts once, differing figures still add up. That scores 92.9%
 * against the City — tied with taking the max, and better than the max
 * because it keeps the genuine multi-section sales adding up. Summing
 * every row scored 0%.
 *
 * The residual 7% are sales where the 2026 roll simply disagrees with
 * what stood in 2020 — an addition, a re-measure — which no row rule
 * can fix.
 */
/**
 * SABRE's "Number of Unit" is the SUITE IDENTIFIER, not a unit count.
 *
 * The merge used to take the MAX of it across a sale's rows and render
 * that as the parcel's unit count. Measured against dwelling_units in
 * the City's own parcel file, that was right on 58 of 17,755 sales —
 * 0.3%. Roll 04007260310 is unit 103 of 255 PEGUIS and was reported as
 * a 103-unit property; the City says 1. The largest "count" the column
 * produced was 4,201. 583 of the 889 rows that carry a value are above
 * 12, and 34 are not numbers at all ("504B", "G-H", "F") — which is the
 * clearest tell: a count cannot be "G-H".
 *
 * The count is not the max of the labels — it is HOW MANY of them there
 * are. SABRE writes one row per suite, so 185 BANNERMAN's rows labelled
 * 1..6 are six units, and 255 PEGUIS's single row labelled 103 is one.
 * Measured against dwelling_units in the City's parcel file, on the 713
 * sales that carry a label: the old max rule matched 60 (8.4%), counting
 * the distinct labels matches 571 (80.1%) — and 134 of the remaining
 * disagreements are rolls the City NOW reports as 0 dwelling units
 * because the building has since been demolished or reclassified, where
 * SABRE's historical count is the right one and today's roll is the
 * stale one. 185 BANNERMAN is exactly that case: six suites sold in
 * 2022, and the roll reads 0 today.
 *
 * That is also why the count is taken from SABRE rather than simply read
 * off the live record: the sale is a historical fact and the roll is
 * not.
 *
 * Distinct values in first-seen order, so a three-suite sale reads
 * "1, 2, 3" rather than repeating whichever row came first.
 */
function unitLabelsOf(componentRows) {
  const seen = [];
  for (const r of componentRows) {
    const v = String(r['Number of Unit'] ?? '').trim();
    if (v && !seen.includes(v)) seen.push(v);
  }
  return seen;
}

function distinctLivingArea(componentRows) {
  const areas = new Set();
  for (const r of componentRows) {
    const a = numOrZero(r['Living Area']);
    if (a > 0) areas.add(a);
  }
  let total = 0;
  for (const a of areas) total += a;
  return total;
}

function distinctYearsBuilt(componentRows) {
  const years = new Set();
  for (const r of componentRows) {
    const y = parseNumeric(r['Year Built']);
    if (y == null || !Number.isFinite(y)) continue;
    if (y < YEAR_BUILT_MIN || y > YEAR_BUILT_MAX) continue;
    years.add(Math.trunc(y));
  }
  return [...years].sort((a, b) => a - b);
}

/**
 * Dedup by (Parcel ID, Instrument Number) — multi-building rows
 * on the same sale roll up into one record. Then group by
 * Instrument Number so multi-parcel sales can compute group
 * aggregates ($/Lot, $/Acre, group size) in Phase 7 (2/2).
 *
 * Before anything is merged, each sale's rows go through
 * collapseZoningTwins so SABRE's duplicated blank-Zoning rows can't
 * double the living area.
 *
 * Returns:
 *   {
 *     sales: SaleRecord[],          // one per (roll, instrument)
 *     rolls: Set<string>,           // distinct rolls
 *     groups: Map<instrument, SaleRecord[]>  // sale-level groups
 *   }
 */
export function dedupAndGroupSales(rows) {
  const merged = new Map(); // key = `${roll}|${instrument}`
  // Rows we could not place. The Instrument Number is THE identifier for
  // a transaction — it is what decides whether two parcels are one sale
  // — so a row without one cannot be grouped and has to be dropped. That
  // is a whole sale leaving the comp set, which the caller reports
  // rather than letting it vanish unremarked.
  let dropped = 0;
  // Gather each sale's rows before folding any of them into a record.
  // Both fixes below need to see a whole (roll, instrument) at once —
  // the twin collapse decides which rows are duplicates by comparing
  // them against each other, and the Year Built list is computed over
  // the sale's sections — and neither is possible while merging rows one
  // at a time, which is what this loop used to do.
  const byKey = new Map(); // key -> { roll, inst, rows } in CSV order
  for (const r of rows) {
    // 11-digit zero-pad so 10-digit CSV rolls (`6070731000`) match
    // their 11-digit d4mq-wa44 records (`06070731000`).
    const roll = normalizeRoll(r['Parcel ID']);
    const inst = String(r['Instrument Number'] ?? '').trim();
    if (!roll || !inst) { dropped++; continue; }
    const key = `${roll}|${inst}`;
    if (!byKey.has(key)) byKey.set(key, { roll, inst, rows: [] });
    byKey.get(key).rows.push(r);
  }
  for (const { roll, inst, rows: saleRows } of byKey.values()) {
    const key = `${roll}|${inst}`;
    // SABRE's blank-Zoning duplicates removed: what's left is one row per
    // genuine building section.
    const components = collapseZoningTwins(saleRows);
    // Read over the whole sale, so the year fields are already final on
    // the record's very first row and the merge branch has nothing to
    // add to them.
    const years = distinctYearsBuilt(components);
    // Computed over the whole sale, like the years, so it is final on the
    // record's first row and the merge branch never accumulates.
    const saleLivingArea = distinctLivingArea(components);
    const saleUnitLabels = unitLabelsOf(components);
    for (const r of components) {
      const existing = merged.get(key);
      // 'Number of Unit' is a suite identifier, not a count — see
      // unitLabelsOf. Kept verbatim as a label, and counted by how many
      // distinct labels the sale carries.
      const unitLabel = saleUnitLabels.length ? saleUnitLabels.join(', ') : null;
      const numUnits = saleUnitLabels.length || null;
      if (!existing) {
        merged.set(key, {
          roll,
          instrument: inst,
          saleDate: r['Sale Dates'] || null,
          salePrice: numOrZero(r['Sold Price']),
          // Value declared for land-transfer purposes. Carried separately
          // from salePrice and never substituted into it: a $1 Sold Price
          // with a large sworn value is a non-arms-length transfer, and
          // collapsing the two would launder it into the comp set as a
          // market sale. See the sentinel note in main.js.
          swornValue: numOrZero(r['Sworn Value']),
          landSf: numOrZero(r['Land Actual sqft']),
          landAssessedSf: numOrZero(r['Land Assessed sqft']),
          livingArea: saleLivingArea,
          // Two Year Built fields, both read off the whole sale rather
          // than off this row: the DISPLAY string listing every distinct
          // section year ascending ("1911, 1913, 1954, 1958, 1962"), and
          // the oldest year as a NUMBER for the grid's sort and any year
          // filter — sorting the string would order "1911, 1913" by text
          // beside "1911", not by age. Null (not '') on a sale whose rows
          // all carry a blank or unusable year, so the column reads as
          // absent rather than as a zero-length year.
          yearBuilt: years.length ? years.join(', ') : null,
          yearBuiltNumeric: years.length ? years[0] : null,
          useCode: r['Par Use Code'] || null,
          propertyType: r['Property Type'] || null,
          propertySubType: r['Property Sub Type'] || null,
          zoning: r['Zoning'] || null,
          streetNumber: r['Street Number'] || null,
          streetDirection: r['Street Direction'] || null,
          streetName: r['Street Name'] || null,
          unitLabel,
        numUnits,
          // N1 comp-database ID from the offline crosswalk; null (not '')
          // so the N1 filter's truthiness test reads clean.
          n1Id: String(r['N1 ID'] ?? '').trim() || null,
          // MLS-side fields. Present only on rows that came from an MLS
          // export, or on a SABRE row the merge fused one onto — see
          // collapseCrossSource in salesDbMerge.js.
          source: String(r.Source ?? '').trim() || null,
          mlsNumber: String(r['MLS #'] ?? '').trim() || null,
          mlsDate: String(r['MLS Date'] ?? '').trim() || null,
          listPrice: numOrZero(r['List Price']),
          origPrice: numOrZero(r['Orig Price']),
          dom: parseNumeric(r.DOM),
          bldgType: String(r['Bldg Type'] ?? '').trim() || null,
          style: String(r.Style ?? '').trim() || null,
          siteInfl: String(r['Site Influences'] ?? '').trim() || null,
        });
      } else {
        // Merge: same Parcel ID + same Instrument Number = more than one
        // row for one sale. Use code falls back to the first non-empty
        // value.
        //
        // Living area is deliberately absent here. It used to accumulate
        // row by row, which double-counted every repeated row — and SABRE
        // repeats far more often than it splits (see distinctLivingArea).
        // The figure is computed over the whole sale before this loop
        // starts, so there is nothing left to add.
        //
        // Year Built is deliberately absent here: it used to keep the
        // OLDEST row and throw the rest away (the HIGGINS rows at
        // 2008 / 2012 / 2012 reported 2008, which was fine, but roll
        // 13081715000's five sections reported 1911 and lost 1913, 1954,
        // 1958 and 1962). distinctYearsBuilt already read every component
        // row above, so both year fields were final before this branch
        // ever ran.
        if (!existing.useCode && r['Par Use Code']) existing.useCode = r['Par Use Code'];
        if (!existing.zoning && r['Zoning']) existing.zoning = r['Zoning'];
        // The crosswalk stamps its ID on specific rows; when component rows
        // merge, the surviving record must not lose the ID just because an
        // un-stamped copy happened to come first.
        if (!existing.n1Id && r['N1 ID']) existing.n1Id = String(r['N1 ID']).trim();
        // Same first-non-blank rule for the MLS fields: only one component
        // row of a fused sale carries them.
        for (const [k, col] of [['mlsNumber', 'MLS #'], ['mlsDate', 'MLS Date'],
          ['bldgType', 'Bldg Type'], ['style', 'Style'], ['siteInfl', 'Site Influences'],
          ['source', 'Source']]) {
          if (!existing[k] && r[col]) existing[k] = String(r[col]).trim();
        }
        if (!existing.listPrice && r['List Price']) existing.listPrice = numOrZero(r['List Price']);
        if (!existing.origPrice && r['Orig Price']) existing.origPrice = numOrZero(r['Orig Price']);
        if (existing.dom == null && r.DOM) existing.dom = parseNumeric(r.DOM);
        // Unit label is read over the whole sale before this loop, like
        // the years and the living area, so there is nothing to merge.
        // Sworn value is a sale-level figure repeated on every component
        // row; keep the largest in case a component row leaves it blank.
        const sworn = numOrZero(r['Sworn Value']);
        if (sworn > existing.swornValue) existing.swornValue = sworn;
      }
    }
  }
  const sales = Array.from(merged.values());
  const rolls = new Set(sales.map((s) => s.roll));
  // Group by Instrument Number ALONE. The instrument is the unique
  // identifier for a transaction, so every distinct parcel sharing one
  // is a member of the same sale — that is what makes a group size > 1
  // mean "this sale covered N parcels", and what drives the group
  // aggregates in buildSaleFeatures ($/Lot SF over the group's summed
  // land, Sale/Asmt over its summed assessment). Deliberately NOT keyed
  // on date or price: two parcels can sell the same day for the same
  // amount under separate instruments and are then separate sales.
  const groups = new Map();
  for (const s of sales) {
    if (!groups.has(s.instrument)) groups.set(s.instrument, []);
    groups.get(s.instrument).push(s);
  }
  return { sales, rolls, groups, dropped };
}

/**
 * Build ONE map/table feature per sale record. A parcel that sold twice in
 * the study period (same roll, two instruments) yields two features sharing
 * the live parcel's geometry — the previous roll-keyed stamping collapsed
 * them to whichever sale came last in the CSV, silently dropping the other
 * transaction from the analysis (a 3-sale CSV rendered "2 sales shown").
 *
 * Each feature is a shallow clone (own `properties`) of the live d4mq-wa44
 * feature for the sale's roll; sales with no live match get a synthetic
 * geometry-less feature flagged `_noLiveMatch` so the row still renders.
 *
 * Group aggregates (multi-parcel sales sharing an Instrument Number): the
 * Sold Price on every row is the full sale total, so $/Lot SF divides by the
 * group's summed land and Sale/Asmt by the group's summed live assessments —
 * a member with no live record just shrinks that denominator (best-effort,
 * Sale/Asmt slightly overstated).
 *
 * @param {SaleRecord[]} visibleSales   post-filter sales, one per (roll, instrument)
 * @param {Map<string, Feature>} liveByRoll  roll → live d4mq-wa44 feature
 * @param {Map<string, SaleRecord[]>} groups instrument → group members
 * @returns {Feature[]} one feature per sale, in visibleSales order
 */
/** Square feet in an acre. The City publishes land area in sf only, so
 *  every acreage figure in the app is derived through this. */
const SQFT_PER_ACRE = 43560;

/**
 * Below this, a SABRE land area is a placeholder rather than a
 * measurement.
 *
 * 41 records in the archive carry a "Land Actual sqft" under 100, most of
 * them literally 1. They are not tiny parcels: their PRICES are ordinary
 * — median $151,216 against $280,000 for the whole set, sitting between
 * the 53rd and 88th percentile — so the sale is fine and the area is
 * junk. Divided by 1 they price at $323,000 to $615,000 per square foot,
 * which leaves the median alone but destroys every mean and every OLS
 * trend the charts fit (the land chart printed R² 0.000 because of them).
 */
const MIN_PLAUSIBLE_LAND_SF = 100;

/**
 * How far the two land areas may differ before the rate is flagged.
 *
 * Where both exist they agree within 2% on 98.5% of 15,234 records, and
 * the gap between the 2% and 10% thresholds is only 40 records — so the
 * near-misses are rounding and re-measurement, and the real disagreements
 * are large. 10% flags 159 records (1.0%): a parcel subdivided or
 * consolidated since the sale, or one of the two figures simply being
 * wrong. Either way it is worth an appraiser's eye before the rate is
 * lifted into a report.
 */
const LAND_DISAGREE_FRACTION = 0.10;

/** The live assessment record's land area for a roll, or 0. */
function liveLandSf(liveByRoll, roll) {
  const n = Number(liveByRoll?.get(roll)?.properties?.assessed_land_area);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The land area to price ONE parcel on, and where it came from.
 *
 * SABRE's own figure leads, because it is the SALE-TIME fact: the live
 * record describes the parcel as it stands today, and a parcel
 * subdivided after the sale would otherwise be priced on geometry that
 * did not exist when it changed hands — the same trap the unit counts
 * fell into. The live assessed area is the FALLBACK, which is what
 * rescues the placeholder rows: 36 of the 40 tiny-lot sales have a real
 * area on the roll, turning $615,000/sf back into $74.84/sf.
 *
 * @returns {{sf: number, fellBack: boolean, sabre: number, live: number}}
 */
function parcelLandSf(g, liveByRoll) {
  const sabre = Number(g?.landSf) > 0 ? Number(g.landSf) : 0;
  const live = liveLandSf(liveByRoll, g?.roll);
  if (sabre >= MIN_PLAUSIBLE_LAND_SF) return { sf: sabre, fellBack: false, sabre, live };
  if (live >= MIN_PLAUSIBLE_LAND_SF) return { sf: live, fellBack: true, sabre, live };
  // Neither source is usable. Return 0, which leaves every per-area rate
  // NULL — the honest outcome, and the whole point of the threshold.
  // Pricing on a known placeholder is worse than declining to price: a
  // blank cell claims nothing, while "$323,150/sf" is a confident,
  // fictional number an appraiser could lift into a report. $/Lot is
  // unaffected, since it divides by the parcel COUNT rather than by area,
  // so the row still carries a usable figure. `unusable` marks it so the
  // caller can say WHY the rate is missing instead of leaving a bare gap.
  return { sf: 0, fellBack: false, unusable: sabre > 0 || live > 0, sabre, live };
}

export function buildSaleFeatures(visibleSales, liveByRoll, groups) {
  const features = [];
  for (const sale of visibleSales) {
    const live = liveByRoll.get(sale.roll);
    const f = live
      ? { ...live, properties: { ...live.properties } }
      : {
          type: 'Feature',
          geometry: null,
          properties: {
            roll_number: sale.roll,
            full_address: [sale.streetNumber, sale.streetDirection, sale.streetName]
              .filter(Boolean).join(' '),
            _noLiveMatch: true,
          },
        };
    const p = f.properties;
    const group = groups.get(sale.instrument) || [sale];
    const isMulti = group.length > 1;
    p._saleDate = sale.saleDate;
    p._salePrice = sale.salePrice > 0 ? sale.salePrice : null;
    p._saleInstrument = sale.instrument;
    p._saleGroupSize = group.length;
    p._saleUseCode = sale.useCode;
    p._salePropertyType = sale.propertyType;
    p._saleLivingArea = sale.livingArea > 0 ? sale.livingArea : null;
    // Both halves of Year Built. The display string lists every section
    // year ("1911, 1913, 1954"); the numeric one is the oldest of them,
    // stamped separately because that is the only form a sort or a year
    // filter can compare — by text, "1911, 1913" sorts nowhere near 1911.
    p._saleYearBuilt = sale.yearBuilt;
    p._saleYearBuiltNumeric = sale.yearBuiltNumeric ?? null;
    p._saleZoning = sale.zoning || null;
    p._saleUnitLabel = sale.unitLabel ?? null;
    p._saleNumUnits = sale.numUnits ?? null;
    // The CSV's own street parts. Kept on the feature because the
    // demolition-permit join is by ADDRESS — the permit table has no
    // roll number — and must work for a sale whose roll never matched a
    // live record.
    p._source = sale.source || null;
    p._mlsNumber = sale.mlsNumber || null;
    p._mlsDate = sale.mlsDate || null;
    p._listPrice = sale.listPrice > 0 ? sale.listPrice : null;
    p._origPrice = sale.origPrice > 0 ? sale.origPrice : null;
    p._dom = Number.isFinite(sale.dom) ? sale.dom : null;
    p._bldgType = sale.bldgType || null;
    p._style = sale.style || null;
    p._siteInfl = sale.siteInfl || null;
    p._saleStreetNumber = sale.streetNumber || null;
    p._saleStreetName = sale.streetName || null;
    p._n1Id = sale.n1Id || null;
    // Shown whenever the CSV carries one.
    //
    // This used to blank the cell when the sworn value EQUALLED the sale
    // price, on the theory that a duplicate column says nothing. In
    // practice that made the column unreadable: on an ordinary arm's-
    // length sale the two figures agree, so the column was empty exactly
    // when the data was fine, and a blank could mean either "no sworn
    // value in the export" or "sworn value present and matching". An
    // appraiser can't tell those apart, and the second is a positive
    // confirmation worth having.
    //
    // Still NEVER substituted into _salePrice — a $1 sale price with a
    // large sworn value is a non-arms-length transfer, and folding the
    // two would launder it into the comp set as a market sale.
    p._saleSwornValue = sale.swornValue > 0 ? sale.swornValue : null;
    // Flagged when the two figures disagree — the signal that the Sold
    // Price is not what the property actually changed hands for. The
    // grid tints both cells and marks the row off this one property so
    // the two numbers are never read as an ordinary sale.
    p._saleSwornMismatch = !!(p._salePrice && p._saleSwornValue
      && p._salePrice !== p._saleSwornValue);
    // Sibling rolls in this sale, for the map's group-hover highlight:
    // hovering any parcel lights up every parcel in the same
    // transaction. Stamped as JSON because MapLibre stringifies
    // non-primitive feature properties when they come back out of
    // queryRenderedFeatures, so an array would arrive as "[object
    // Object]" — a string we control round-trips predictably.
    p._saleGroupRollIds = JSON.stringify(group.map((g) => g.roll));
    // Land, per parcel then summed, so an assembly is priced as one deal.
    // Each parcel takes SABRE's own area where that is plausible and the
    // assessment record's where it is not — see parcelLandSf.
    const landParts = group.map((g) => parcelLandSf(g, liveByRoll));
    const landSf = landParts.reduce((sum, x) => sum + x.sf, 0);
    // Flagged, not silently substituted. A rate computed on a different
    // area than the one on the row is exactly the kind of quiet
    // discrepancy this app exists to surface, so the grid marks the rate
    // cell and says which figure it used.
    const fellBack = landParts.filter((x) => x.fellBack);
    const unusable = landParts.filter((x) => x.unusable);
    const disagreed = landParts.filter((x) => !x.fellBack && x.sabre > 0 && x.live > 0
      && Math.abs(x.sabre - x.live) / x.live > LAND_DISAGREE_FRACTION);
    if (fellBack.length || disagreed.length || unusable.length) {
      p._landDisagree = true;
      p._landTitle = unusable.length
        ? `No usable land area for this sale — SABRE reports ${unusable.map((x) => Math.round(x.sabre).toLocaleString('en-CA')).join(', ')} sf and the assessment record has none either. Every per-area rate is withheld rather than computed on a placeholder; $/Lot still divides by the parcel count.`
        : fellBack.length
        ? `SABRE reports ${fellBack.map((x) => Math.round(x.sabre).toLocaleString('en-CA')).join(', ')} sf of land here, which is a placeholder rather than a measurement. Every rate on this row is computed on the assessment record's ${fellBack.map((x) => Math.round(x.live).toLocaleString('en-CA')).join(', ')} sf instead.`
        : `SABRE's land area and the assessment record disagree by more than ${Math.round(LAND_DISAGREE_FRACTION * 100)}% (${disagreed.map((x) => `${Math.round(x.sabre).toLocaleString('en-CA')} sf vs ${Math.round(x.live).toLocaleString('en-CA')} sf`).join('; ')}). The rates use SABRE's figure, which is the area at the time of sale — the parcel may have been subdivided or consolidated since.`;
    }
    if (p._salePrice && landSf > 0) p._pricePerSf = p._salePrice / landSf;
    // Land metrics for the land-sales charts and the Land Sales preset.
    // Acres is derived rather than sourced: the City publishes land area
    // in square feet only, and an appraiser reasons about larger parcels
    // in acres. Same group-total denominator as $/Lot SF, so an assembly
    // is rated as one deal.
    if (landSf > 0) p._saleAcres = landSf / SQFT_PER_ACRE;
    if (p._salePrice && p._saleAcres > 0) p._pricePerAcre = p._salePrice / p._saleAcres;
    // Price per LOT: the consideration split across the parcels in the
    // transaction. On a multi-lot land deal this is the figure that
    // actually prices a building lot, which a per-SF rate obscures.
    if (p._salePrice && group.length > 0) p._pricePerLot = p._salePrice / group.length;
    // Price per BUILDING square foot — the rate an improved commercial
    // comp is actually quoted at, where $/Lot SF prices the dirt.
    //
    // Denominator is the CSV's Living Area summed across the group, with
    // the live record's total_living_area as a fallback when the export
    // carries none. Same group-total treatment as the land and
    // assessment figures, so every rate on the row divides by the same
    // transaction.
    //
    // The fallback is withheld on a VACANT-coded sale, and that is the
    // whole point of it being conditional: the live record describes the
    // parcel TODAY, so a lot that sold as bare land and has since been
    // built on would otherwise be handed the new building's area and
    // report a confident, entirely fictional $/Bldg SF. A vacant sale
    // has no building to rate, and no rate is the honest answer.
    let bldgSf = group.reduce((sum, g) => sum + (g.livingArea || 0), 0);
    const groupIsVacant = group.every((g) => isVacantUseCode(g.useCode));
    if (!(bldgSf > 0) && !groupIsVacant) {
      bldgSf = group.reduce((sum, g) => {
        const groupLive = liveByRoll.get(g.roll);
        return sum + (Number(groupLive?.properties?.total_living_area) || 0);
      }, 0);
    }
    if (p._salePrice && bldgSf > 0) p._pricePerBldgSf = p._salePrice / bldgSf;
    let asmt = Number(p.total_assessed_value) || 0;
    if (isMulti) {
      asmt = group.reduce((sum, g) => {
        const groupLive = liveByRoll.get(g.roll);
        return sum + (Number(groupLive?.properties?.total_assessed_value) || 0);
      }, 0);
    }
    if (p._salePrice && asmt > 0) p._saleToAsmt = (p._salePrice / asmt) * 100;
    features.push(f);
  }
  return features;
}

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
 * Dedup by (Parcel ID, Instrument Number) — multi-building rows
 * on the same sale roll up into one record. Then group by
 * Instrument Number so multi-parcel sales can compute group
 * aggregates ($/Lot, $/Acre, group size) in Phase 7 (2/2).
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
  for (const r of rows) {
    // 11-digit zero-pad so 10-digit CSV rolls (`6070731000`) match
    // their 11-digit d4mq-wa44 records (`06070731000`).
    const roll = normalizeRoll(r['Parcel ID']);
    const inst = String(r['Instrument Number'] ?? '').trim();
    if (!roll || !inst) { dropped++; continue; }
    const key = `${roll}|${inst}`;
    const existing = merged.get(key);
    const livingArea = numOrZero(r['Living Area']);
    // Unit counts are whole numbers, and 0 is "not stated" rather than a
    // count — keeping it would report a blank cell as a zero-unit parcel.
    const numUnitsRaw = parseNumeric(r['Number of Unit']);
    const numUnits = numUnitsRaw != null && numUnitsRaw > 0 ? Math.trunc(numUnitsRaw) : null;
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
        livingArea,
        yearBuilt: r['Year Built'] || null,
        useCode: r['Par Use Code'] || null,
        propertyType: r['Property Type'] || null,
        propertySubType: r['Property Sub Type'] || null,
        zoning: r['Zoning'] || null,
        streetNumber: r['Street Number'] || null,
        streetDirection: r['Street Direction'] || null,
        streetName: r['Street Name'] || null,
        numUnits,
        // N1 comp-database ID from the offline crosswalk; null (not '')
        // so the N1 filter's truthiness test reads clean.
        n1Id: String(r['N1 ID'] ?? '').trim() || null,
      });
    } else {
      // Merge: same Parcel ID + same Instrument Number = multiple
      // building components on one sale. Sum living area across
      // them; keep the OLDEST (smallest) Year Built so e.g. the
      // HIGGINS rows at 2008 / 2012 / 2012 report 2008. Use code
      // falls back to the first non-empty value.
      existing.livingArea += livingArea;
      const yb = parseNumeric(r['Year Built']);
      const existingYb = parseNumeric(existing.yearBuilt);
      if (Number.isFinite(yb) && (!Number.isFinite(existingYb) || yb < existingYb)) {
        existing.yearBuilt = r['Year Built'];
      }
      if (!existing.useCode && r['Par Use Code']) existing.useCode = r['Par Use Code'];
      if (!existing.zoning && r['Zoning']) existing.zoning = r['Zoning'];
      // The crosswalk stamps its ID on specific rows; when component rows
      // merge, the surviving record must not lose the ID just because an
      // un-stamped copy happened to come first.
      if (!existing.n1Id && r['N1 ID']) existing.n1Id = String(r['N1 ID']).trim();
      // SABRE enumerates a multi-unit parcel one row per unit, with
      // Number of Unit running 1..N (six rows for 185 BANNERMAN). The
      // first row's value is 1, so keeping it would report a six-unit
      // property as one unit — the MAX is the count.
      if (numUnits != null && (existing.numUnits == null || numUnits > existing.numUnits)) {
        existing.numUnits = numUnits;
      }
      // Sworn value is a sale-level figure repeated on every component
      // row; keep the largest in case a component row leaves it blank.
      const sworn = numOrZero(r['Sworn Value']);
      if (sworn > existing.swornValue) existing.swornValue = sworn;
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
    p._saleYearBuilt = sale.yearBuilt;
    p._saleZoning = sale.zoning || null;
    p._saleNumUnits = sale.numUnits ?? null;
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
    let landSf = sale.landSf;
    if (isMulti) {
      landSf = group.reduce((sum, g) => sum + (g.landSf || 0), 0);
    }
    if (p._salePrice && landSf > 0) p._pricePerSf = p._salePrice / landSf;
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

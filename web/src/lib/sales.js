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
  for (const r of rows) {
    // 11-digit zero-pad so 10-digit CSV rolls (`6070731000`) match
    // their 11-digit d4mq-wa44 records (`06070731000`).
    const roll = normalizeRoll(r['Parcel ID']);
    const inst = String(r['Instrument Number'] ?? '').trim();
    if (!roll || !inst) continue;
    const key = `${roll}|${inst}`;
    const existing = merged.get(key);
    const livingArea = Number.parseFloat(r['Living Area']) || 0;
    const numUnits = Number.parseInt(r['Number of Unit'], 10) || null;
    if (!existing) {
      merged.set(key, {
        roll,
        instrument: inst,
        saleDate: r['Sale Dates'] || null,
        salePrice: Number.parseFloat(r['Sold Price']) || 0,
        // Value declared for land-transfer purposes. Carried separately
        // from salePrice and never substituted into it: a $1 Sold Price
        // with a large sworn value is a non-arms-length transfer, and
        // collapsing the two would launder it into the comp set as a
        // market sale. See the sentinel note in main.js.
        swornValue: Number.parseFloat(r['Sworn Value']) || 0,
        landSf: Number.parseFloat(r['Land Actual sqft']) || 0,
        landAssessedSf: Number.parseFloat(r['Land Assessed sqft']) || 0,
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
      });
    } else {
      // Merge: same Parcel ID + same Instrument Number = multiple
      // building components on one sale. Sum living area across
      // them; keep the OLDEST (smallest) Year Built so e.g. the
      // HIGGINS rows at 2008 / 2012 / 2012 report 2008. Use code
      // falls back to the first non-empty value.
      existing.livingArea += livingArea;
      const yb = Number.parseInt(r['Year Built'], 10);
      const existingYb = Number.parseInt(existing.yearBuilt, 10);
      if (Number.isFinite(yb) && (!Number.isFinite(existingYb) || yb < existingYb)) {
        existing.yearBuilt = r['Year Built'];
      }
      if (!existing.useCode && r['Par Use Code']) existing.useCode = r['Par Use Code'];
      if (!existing.zoning && r['Zoning']) existing.zoning = r['Zoning'];
      // SABRE enumerates a multi-unit parcel one row per unit, with
      // Number of Unit running 1..N (six rows for 185 BANNERMAN). The
      // first row's value is 1, so keeping it would report a six-unit
      // property as one unit — the MAX is the count.
      if (numUnits != null && (existing.numUnits == null || numUnits > existing.numUnits)) {
        existing.numUnits = numUnits;
      }
      // Sworn value is a sale-level figure repeated on every component
      // row; keep the largest in case a component row leaves it blank.
      const sworn = Number.parseFloat(r['Sworn Value']) || 0;
      if (sworn > existing.swornValue) existing.swornValue = sworn;
    }
  }
  const sales = Array.from(merged.values());
  const rolls = new Set(sales.map((s) => s.roll));
  const groups = new Map();
  for (const s of sales) {
    if (!groups.has(s.instrument)) groups.set(s.instrument, []);
    groups.get(s.instrument).push(s);
  }
  return { sales, rolls, groups };
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
    // Only surfaced when it actually says something the Sale Price
    // doesn't — i.e. a nominal/sentinel price hiding a real declared
    // value. Showing it on every row would just duplicate Sale Price.
    p._saleSwornValue = (sale.swornValue > 0 && sale.swornValue !== sale.salePrice)
      ? sale.swornValue
      : null;
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

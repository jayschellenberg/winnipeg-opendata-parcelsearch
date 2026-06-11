// Pure sales-CSV helpers, extracted verbatim from main.js so the test
// suite can import them — main.js wires DOM elements at import time and
// can't be loaded under plain Node. No behaviour change intended.

/**
 * Normalize a Winnipeg roll number to its 11-digit zero-padded
 * canonical form. The CSV strips leading zeros from short rolls
 * (e.g. `6070731000` instead of `06070731000`), but d4mq-wa44
 * stores them padded. soda.js's rollClause already normalizes on
 * the query side; this helper makes the client-side joins
 * (matchedRolls.has, saleByRoll.get, subject lookups) line up.
 */
export function normalizeRoll(token) {
  const digits = String(token ?? '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  return digits.length >= 11 ? digits : digits.padStart(11, '0');
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
  for (const r of rows) {
    // 11-digit zero-pad so 10-digit CSV rolls (`6070731000`) match
    // their 11-digit d4mq-wa44 records (`06070731000`).
    const roll = normalizeRoll(r['Parcel ID']);
    const inst = String(r['Instrument Number'] ?? '').trim();
    if (!roll || !inst) continue;
    const key = `${roll}|${inst}`;
    const existing = merged.get(key);
    const livingArea = Number.parseFloat(r['Living Area']) || 0;
    if (!existing) {
      merged.set(key, {
        roll,
        instrument: inst,
        saleDate: r['Sale Dates'] || null,
        salePrice: Number.parseFloat(r['Sold Price']) || 0,
        landSf: Number.parseFloat(r['Land Actual sqft']) || 0,
        landAssessedSf: Number.parseFloat(r['Land Assessed sqft']) || 0,
        livingArea,
        yearBuilt: r['Year Built'] || null,
        useCode: r['Par Use Code'] || null,
        propertyType: r['Property Type'] || null,
        propertySubType: r['Property Sub Type'] || null,
        streetNumber: r['Street Number'] || null,
        streetDirection: r['Street Direction'] || null,
        streetName: r['Street Name'] || null,
        numUnits: Number.parseInt(r['Number of Unit'], 10) || null,
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

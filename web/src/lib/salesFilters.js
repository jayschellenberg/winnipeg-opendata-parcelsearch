import { pucsCategory } from './pucs.js';

/*
 * Sales-tab range and text filters — the pure predicates behind the
 * "Additional filters" row (Manitoba parity: `size-low` / `size-high` /
 * `sales-street-name`).
 *
 * These run PRE-JOIN, against the parsed SaleRecords rather than the
 * joined features, for the same reason the date and PUCS filters do:
 * every row they remove is a roll that never has to be fetched from
 * d4mq-wa44. main.js owns the wiring; this file owns the meaning.
 *
 * Two rules are shared by both filters and worth stating once:
 *
 *   - EMPTY IS OFF. A blank input is not "0" or "match everything
 *     literally" — it disables that side of the filter. Both blank is a
 *     complete no-op, so a user who has never touched the row cannot be
 *     surprised by sales disappearing.
 *
 *   - MISSING IS EXCLUDED. Once a filter is active, a sale that has no
 *     value to test fails it. Passing unknowns through would quietly
 *     seed a size- or street-constrained comp set with rows that were
 *     never checked, which is the more dangerous direction for an
 *     appraisal. This mirrors the Manitoba app's semantics exactly.
 */

/**
 * Parse a range input into a finite non-negative bound, or null when the
 * input is blank / unparseable / negative. Null means "this side of the
 * range is off", never "zero".
 */
export function parseBound(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  const n = Number.parseFloat(s.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Total land area for the sale a record belongs to, in square feet.
 *
 * Deliberately the SALE-GROUP sum, not the per-parcel figure. A sale that
 * bundles three lots is meaningfully a transaction of their combined
 * area, and a size range typed by an appraiser expresses interest in the
 * size of the DEAL. It is also the same denominator `$/Lot SF` uses in
 * lib/sales.js, so the filter and the column can never disagree about
 * how big a sale is.
 *
 * `complete` is false when any member of the group is missing its Land
 * Actual sqft. The sum is then an understatement — filtering on it would
 * pull a large assembly into a small-lot search — so callers treat an
 * incomplete group as untestable rather than as its partial total. Single
 * -parcel sales with no land figure come back {landSf: 0, complete: false}
 * for the same reason.
 *
 * @param {object} sale   a SaleRecord (needs .instrument and .landSf)
 * @param {Map<string, object[]>} groups  instrument -> group members
 */
export function saleGroupLandSf(sale, groups) {
  const members = groups?.get?.(sale?.instrument) || [sale];
  let total = 0;
  let complete = true;
  for (const m of members) {
    const sf = Number(m?.landSf);
    if (!Number.isFinite(sf) || sf <= 0) { complete = false; continue; }
    total += sf;
  }
  return { landSf: total, complete };
}

/**
 * Does this sale's group land area fall inside [lo, hi] square feet?
 * Either bound may be null (that side unbounded); both null is a no-op
 * that passes everything. An incomplete or zero group total fails
 * whenever the filter is active.
 */
export function passesSizeFilter(sale, groups, lo, hi) {
  if (lo == null && hi == null) return true;
  const { landSf, complete } = saleGroupLandSf(sale, groups);
  if (!complete || landSf <= 0) return false;
  if (lo != null && landSf < lo) return false;
  if (hi != null && landSf > hi) return false;
  return true;
}

/**
 * The sale's total consideration. SABRE repeats the WHOLE sale price on
 * every component row of a multi-parcel sale, so this is already a
 * transaction-level figure and needs no group summing — summing it would
 * multiply a three-lot sale's price by three.
 *
 * Zero and the $1 sentinel come back null: they are not prices. (The
 * sentinel rows are normally filtered upstream by the non-arms-length
 * checkbox, but a user can untick that, and a $1 transfer must not then
 * satisfy a "under $50,000" search as though it were a market sale.)
 */
export function salePriceOf(sale) {
  const n = Number(sale?.salePrice);
  if (!Number.isFinite(n) || n <= 1) return null;
  return n;
}

/**
 * Generic inclusive range test over a value that may be null. Both bounds
 * null is a no-op; otherwise a null value fails ("missing is excluded").
 */
export function passesRange(value, lo, hi) {
  if (lo == null && hi == null) return true;
  if (value == null || !Number.isFinite(value)) return false;
  if (lo != null && value < lo) return false;
  if (hi != null && value > hi) return false;
  return true;
}

/** Total sale price inside [lo, hi]. */
export function passesPriceFilter(sale, lo, hi) {
  return passesRange(salePriceOf(sale), lo, hi);
}

/**
 * Every zoning code a joined sale feature carries, de-duplicated and
 * stripped to the bare code.
 *
 * Winnipeg has two independent sources and they disagree often enough to
 * matter, so the filter reads BOTH:
 *
 *   - `_saleZoning`, the zoning recorded on the sale itself. Always
 *     present, and it is what the "Zoning (sale)" column shows.
 *   - `zoning_top1` / `zoning_top2`, the parcel's CURRENT zoning by
 *     area-weighted intersection. Only populated once the Zoning overlay
 *     has run — sales-mode zoning enrichment is deferred so a large CSV
 *     doesn't block on it.
 *
 * A sale matches if ANY of its codes is ticked, which is also how the
 * Manitoba app treats its two zone columns. Reading only the current
 * zoning would make the control do nothing until the overlay is
 * switched on; reading only the sale zoning would ignore a rezoning.
 *
 * `strip` is injected (lib/cells.js owns stripZoningCode) to keep this
 * file free of any dependency that touches the DOM.
 */
export function saleZoningCodes(feature, strip = (v) => v) {
  const p = feature?.properties || {};
  const out = new Set();
  for (const raw of [p._saleZoning, p.zoning_top1, p.zoning_top2, p.zoning]) {
    if (raw == null) continue;
    const code = String(strip(raw) ?? '').trim().toUpperCase();
    if (code !== '') out.add(code);
  }
  return out;
}

/**
 * Does this feature match the ticked zoning set? `selected` is the
 * multi-select tri-state: null = no filter. A sale carrying no zoning at
 * all fails an active filter, same rule as everywhere else here.
 */
export function passesZoningFilter(feature, selected, strip) {
  if (selected == null) return true;
  const codes = saleZoningCodes(feature, strip);
  if (codes.size === 0) return false;
  for (const c of codes) if (selected.has(c)) return true;
  return false;
}

/**
 * The address text a street filter is matched against: the sale's own
 * Street Number / Direction / Name from the CSV, upper-cased and
 * whitespace-collapsed.
 *
 * The CSV's fields rather than the joined record's `full_address` on
 * purpose. These are the same parts buildSaleFeatures composes into
 * full_address for a row with no live match, so the filter behaves
 * identically whether or not d4mq-wa44 knows the roll — and it can run
 * before the fetch. It also sidesteps the condo case, where the grid
 * shows only a unit address.
 */
export function saleAddressText(sale) {
  return [sale?.streetNumber, sale?.streetDirection, sale?.streetName]
    .filter((part) => part != null && String(part).trim() !== '')
    .join(' ')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a user-typed street query. Returns null when the query is
 * blank, i.e. the filter is off.
 */
export function normalizeStreetQuery(value) {
  if (value == null) return null;
  const s = String(value).toUpperCase().replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/**
 * Case-insensitive substring match of `query` against the sale's address
 * text. A blank query passes everything; a sale with no address text at
 * all fails an active query.
 *
 * Substring, not word-match, so "BANNER" finds BANNERMAN and a partial
 * recollection of a street name still lands — the same latitude the
 * Manitoba app gives.
 */
export function passesStreetFilter(sale, query) {
  if (query == null || query === '') return true;
  const text = saleAddressText(sale);
  if (text === '') return false;
  return text.includes(query);
}

/* ---------------------------------------------------------------------
 * POST-JOIN predicates (Manitoba parity: `sale-asmt-max`,
 * `vacant-improved`, `far-flung-km` / `far-flung-exclude`).
 *
 * Unlike everything above these run AFTER the d4mq-wa44 join, because
 * what they test only exists once the live record is attached: the
 * assessed total, the assessor's use code, and the parcel centroids.
 * They take joined FEATURES, not SaleRecords.
 *
 * The two rules above still hold — empty is off, missing is excluded —
 * with one deliberate exception, called out on isFarFlung: a sale whose
 * spread cannot be measured is never *excluded*, because the far-flung
 * control removes comps rather than narrowing to them.
 * ------------------------------------------------------------------ */

/*
 * Vacant-land use codes. Winnipeg's assessor classifies vacancy
 * directly in the Property Use Code, so this is the assessor's own
 * determination rather than the Manitoba app's buildings-value
 * threshold proxy — which is why this port carries no equivalent of
 * MB's `vacant-threshold` input: there is no number to tune.
 *
 * The rule is the V PREFIX (VRES1, VRES2, VCOMM, VINDU, VAGRI, VAPRK
 * …), not a fixed list, so a vacant code the City adds later is picked
 * up without a code change. CNVAC — condo vacant — is the one genuine
 * vacant code that doesn't start with V, so it is named explicitly
 * rather than silently dropping out of land comps.
 *
 * Codes are matched on the bare 5-character form: the live record
 * spells it "VCOMM - VACANT COMMERCIAL" while a SABRE export carries
 * just "VCOMM".
 */
const VACANT_EXTRA_CODES = new Set(['CNVAC']);

/** The bare 5-char use code for a joined sale feature, preferring the
 *  CSV's own Par Use Code and falling back to the live record. '' when
 *  neither is present. */
export function bareUseCode(raw) {
  return String(raw ?? '').trim().toUpperCase().split(/[\s-]/)[0];
}

export function saleUseCodeOf(feature) {
  const p = feature?.properties || {};
  return bareUseCode(p._saleUseCode || p.property_use_code || '');
}

/** True when the code is one the assessor marks vacant. */
export function isVacantUseCode(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) return false;
  return c.startsWith('V') || VACANT_EXTRA_CODES.has(c);
}

/**
 * True when the sale belongs to the LAND SET -- which is a wider question
 * than "did the assessor mark it vacant".
 *
 * The build instruments (permit, roll, SABRE, and the price tiebreak) all
 * used isVacantUseCode as their gate, so they policed the V-codes and
 * nothing else. But saleCategory files a sale under Land by CATEGORY, and
 * one code reaches Land without being vacant-coded: CMPSP, surface
 * parking. Result: 17 sales sat in the Land set that no instrument could
 * ever judge -- structurally invisible, at a median $74.21 per lot square
 * foot against the set's $30.14, and 6 of them carrying SABRE building
 * evidence nothing was asking for.
 *
 * Measured before widening: exactly 11 codes have category Land, and
 * CMPSP is the ONLY one of them that is not vacant-coded. So this adds
 * that one code and nothing else.
 *
 * THE UNION IS REQUIRED, not just the category test. pucsCategory returns
 * null for a code it does not know, so gating on the category ALONE would
 * silently stop judging any future V-code the taxonomy has not been taught
 * yet -- narrowing the gate while appearing to widen it. Keeping
 * isVacantUseCode as the first clause means this can only ever add.
 *
 * NOT a replacement for isVacantUseCode. That function answers "the
 * assessor marked this vacant" and still owns the vacant FILTER and
 * groupVacancy, where a surface parking lot is emphatically not vacant.
 * The two questions are different and must stay different.
 */
export function isLandSetUseCode(code) {
  if (isVacantUseCode(code)) return true;
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) return false;
  return pucsCategory(c) === 'Land';
}

/**
 * The category a MIXED sale should really carry, per group.
 *
 * A transaction is one deal. If any parcel in it is improved, the buyer
 * bought an improved property, and every row of that sale has to say so
 * -- Jason's rule, 2026-08-22: "if there are multiple parcels, and at
 * least one of them is not a parking lot or vacant land then the entire
 * sale should be considered as an improved property".
 *
 * Left uncorrected this quietly poisons the Land set. 5650563 is a
 * $6,650,000 VINDU + INWWH sale whose vacant parcel sat in Land reading
 * $16.63 per lot square foot -- a number that prices the warehouse.
 * Measured over the archive: 16 groups, 34 Land rows.
 *
 * JUDGED ON THE FINAL CATEGORY, not the use code, and that is the whole
 * design. It means two things fall out for free:
 *
 *   - A teardown assembly needs no exception. demoVerdict has already
 *     moved the improved parcel to Land, so the group no longer spans
 *     two categories and nothing here fires. A warehouse sold with a
 *     vacant lot for its land stays a land deal.
 *   - EVIDENCE counts, not just the code. 8 of the 16 groups are all
 *     vacant-CODED but hold one parcel an instrument proved was built
 *     on. The biggest is a 24-parcel $1,930,000 subdivision sale, 6 of
 *     the lots already built. Jason's call, deliberately: the sale
 *     bought buildings, so all 24 rows read improved.
 *
 * Silent on a group with more than ONE non-Land category -- it cannot
 * say which improved type the deal was, so it declines rather than
 * picking. None exist in the archive today; the caller still marks the
 * sale mixed and withholds its land rates.
 *
 * @param {Array} features joined sale features, categories already stamped
 * @returns {{force: Map<string,string>, mixed: Set<string>}} the category to
 *          force per instrument, and every instrument whose sale mixed Land
 *          with anything else (a superset -- `mixed` also holds the groups
 *          `force` declined to name).
 */
export function resolveMixedSales(features) {
  const byGroup = new Map();
  for (const f of features || []) {
    const key = String(f?.properties?._saleInstrument ?? '');
    const cat = f?.properties?._saleCategory;
    if (!cat) continue;
    if (!byGroup.has(key)) byGroup.set(key, new Set());
    byGroup.get(key).add(cat);
  }
  const force = new Map();
  const mixed = new Set();
  for (const [key, cats] of byGroup) {
    if (!cats.has('Land') || cats.size < 2) continue;
    // Mixed either way -- the land-denominated rates divide a
    // consideration that partly bought buildings, so they go whether or
    // not the improved category can be named.
    mixed.add(key);
    const others = [...cats].filter((c) => c !== 'Land');
    if (others.length === 1) force.set(key, others[0]);
  }
  return { force, mixed };
}

/**
 * Vacancy verdict per SALE GROUP (instrument), so every row of a
 * multi-parcel sale passes or fails together — the same rule the lot-
 * size filter uses. A sale is:
 *
 *   'vacant'   — every parcel in it is a vacant code
 *   'improved' — at least one parcel is not
 *   'unknown'  — no parcel has any use code to read
 *
 * MB's wording, adapted to the code-based signal. A group is judged as
 * a whole because that is how it sold: one improved parcel makes the
 * transaction an improved sale, whatever the other lots were.
 *
 * @param {Array} features joined sale features
 * @returns {Map<string, 'vacant'|'improved'|'unknown'>} keyed by instrument
 */
export function groupVacancy(features) {
  const byGroup = new Map();
  for (const f of features || []) {
    const key = String(f?.properties?._saleInstrument ?? '');
    const code = saleUseCodeOf(f);
    const prev = byGroup.get(key);
    if (!code) {
      if (prev === undefined) byGroup.set(key, 'unknown');
      continue;
    }
    if (isVacantUseCode(code)) {
      // A vacant parcel only keeps a group vacant; it can't rescue one
      // already known to hold an improvement.
      if (prev === undefined || prev === 'unknown') byGroup.set(key, 'vacant');
    } else {
      byGroup.set(key, 'improved');
    }
  }
  return byGroup;
}


/**
 * How far apart the parcels of each multi-parcel sale lie, in km,
 * measured as the largest centroid-to-centroid distance within the
 * group.
 *
 * Single-parcel sales get 0 — they have no spread, and reporting null
 * would wrongly read as "couldn't measure". A group is null only when
 * fewer than two of its parcels have a centroid, i.e. the spread
 * genuinely cannot be measured.
 *
 * @param {Array} features joined sale features
 * @param {(f: object) => [number, number]|null} centroidOf
 * @param {(a: [number, number], b: [number, number]) => number|null} distanceKm
 * @returns {Map<string, number|null>} keyed by instrument
 */
export function groupSpreadKm(features, centroidOf, distanceKm) {
  const points = new Map();
  const sizes = new Map();
  for (const f of features || []) {
    const key = String(f?.properties?._saleInstrument ?? '');
    sizes.set(key, (sizes.get(key) || 0) + 1);
    const c = centroidOf(f);
    if (!c) continue;
    if (!points.has(key)) points.set(key, []);
    points.get(key).push(c);
  }
  const out = new Map();
  for (const [key, count] of sizes) {
    const pts = points.get(key) || [];
    if (count < 2) { out.set(key, 0); continue; }
    if (pts.length < 2) { out.set(key, null); continue; }
    let max = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = distanceKm(pts[i], pts[j]);
        if (Number.isFinite(d) && d > max) max = d;
      }
    }
    out.set(key, max);
  }
  return out;
}

/**
 * Is this spread beyond the threshold? Blank / 0 / negative threshold
 * turns the marking off entirely.
 *
 * An unmeasurable spread (null) is NOT far-flung. This is the one place
 * the "missing is excluded" rule is deliberately inverted: every other
 * filter narrows TO something and an unchecked row must not sneak in,
 * whereas this one REMOVES comps, so an unchecked row must not be
 * silently thrown away. Same call the Manitoba app makes.
 */
export function isFarFlung(spreadKm, thresholdKm) {
  if (thresholdKm == null || !(thresholdKm > 0)) return false;
  if (spreadKm == null || !Number.isFinite(spreadKm)) return false;
  return spreadKm > thresholdKm;
}

/* ---------------------------------------------------------------------
 * LOCATION predicates — neighbourhood cluster and radius-from-subject.
 *
 * Both run POST-JOIN, for the same reason the vacancy and far-flung
 * tests do: what they read is stamped onto the joined feature rather
 * than carried by the CSV. `_cluster` comes from a point-in-polygon of
 * the parcel centroid against wpg-neighbourhoods.geojson (lib/clusters
 * .js); `_dist` is the centroid-to-centroid km to the subject parcel,
 * and exists only once a subject roll is set.
 *
 * ROW-LEVEL, NOT GROUP-LEVEL, and deliberately so. The rule this file
 * follows for a group property (lot size, vacancy, far-flung) is "judge
 * the transaction as a whole", because those three are properties OF the
 * deal. Where a parcel sits is not: it is a property of the parcel, and
 * it is what the Cluster and Dist (km) columns show on that parcel's own
 * row. Filtering row-level keeps the filter and the column saying the
 * same thing — tick Fort Garry South and every row left is a row whose
 * Cluster cell reads Fort Garry South. Judging per group would leave
 * rows on screen that visibly contradict the filter that kept them.
 *
 * The cost is that a multi-parcel sale straddling a boundary can show
 * some of its rows and not others, while the $/Lot SF on those rows is
 * still the whole group's. That is already how the category, class and
 * zoning filters behave, and it is the lesser evil: the alternative
 * silently widens the search past what the user asked for.
 * ------------------------------------------------------------------ */

/**
 * Where a sale with no cluster is filed. Named and tickable rather than
 * blank, for the same reason UNCLASSIFIED_CATEGORY is: a parcel the
 * point-in-polygon can't place (no centroid, or a centroid outside every
 * neighbourhood — city-edge parcels genuinely exist) must stay VISIBLE
 * in the picker. A blank option would quietly fail every cluster filter
 * and drop those sales out of comp searches with nothing to say why.
 */
export const UNASSIGNED_CLUSTER = '(no cluster)';

/**
 * A sale whose centroid is real but lies further from every neighbourhood
 * than the placement cap — in practice an MLS row for a property outside
 * the city.
 *
 * Split out of (no cluster) on 2026-09-16 because that one label was
 * answering two different questions: "this is not in Winnipeg" and "there
 * was nothing to place it with". Jason found three unplaced sales and had
 * to inspect the rows to learn which. Naming it makes an out-of-town row
 * self-identifying on import, and keeps the genuinely unplaceable ones a
 * separate, smaller problem.
 *
 * Deliberately NOT auto-assigned to the nearest Winnipeg cluster. That is
 * what the cap exists to prevent: an out-of-town comp labelled Transcona
 * looks like a Transcona comp, and nothing on the row would say otherwise.
 */
export const OUTSIDE_CITY_CLUSTER = '(outside Winnipeg)';

/** A sale's neighbourhood cluster, as the filter and the Cluster column
 *  both read it. Never returns blank — see UNASSIGNED_CLUSTER. */
export function saleClusterOf(feature) {
  const c = String(feature?.properties?._cluster ?? '').trim();
  return c === '' ? UNASSIGNED_CLUSTER : c;
}

/**
 * Does this feature sit in one of the ticked clusters? `selected` is the
 * multi-select tri-state: null = no filter, empty Set = show nothing.
 */
export function passesClusterFilter(feature, selected) {
  if (selected == null) return true;
  return selected.has(saleClusterOf(feature));
}

/**
 * Parse the radius input into a positive distance in kilometres, or null
 * when the filter is off.
 *
 * Blank, zero and negative all mean OFF rather than "0 km", matching
 * parseBound and the far-flung threshold. A 0 km radius would otherwise
 * be a filter that can only ever match the subject itself, which is
 * never what typing a 0 into a half-finished number field meant.
 */
export function parseRadiusKm(value) {
  const n = parseBound(value);
  return n != null && n > 0 ? n : null;
}

/**
 * Is this sale within `radiusKm` of the subject parcel?
 *
 * Reads `_dist`, the same centroid-to-centroid figure the Dist (km)
 * column shows, so the filter can never disagree with the number on
 * screen. Inclusive at the boundary — "within 2 km" includes 2.00 km.
 *
 * MISSING IS EXCLUDED, the standard rule here: a sale whose roll found
 * no live record has no centroid and therefore no distance, and a
 * radius search must not seed a comp set with rows nobody measured.
 * Callers are responsible for not applying this at all when no subject
 * roll is set — with no subject NOTHING has a distance, and silently
 * emptying the grid would read as "no comps nearby" rather than as
 * "you haven't said what nearby means".
 */
export function passesRadiusFilter(feature, radiusKm) {
  if (radiusKm == null) return true;
  const d = feature?.properties?._dist;
  // Typed rather than coerced. Number(null) is 0 and Number('') is 0, so
  // a coercing test would read "never measured" as "zero kilometres from
  // the subject" and hand back the unmeasured rows as the CLOSEST comps
  // in the set — the exact inversion of the missing-is-excluded rule.
  if (typeof d !== 'number' || !Number.isFinite(d)) return false;
  return d <= radiusKm;
}


/* ---------------------------------------------------------------------
 * PRE-JOIN vacancy — the same question groupVacancy answers, asked early
 * enough to save the work.
 *
 * WHY. Vacant/improved used to be judged only after the d4mq-wa44 join,
 * so choosing "Vacant Land Only" still fetched an assessment record for
 * every improved sale and drew it before throwing it away. That is the
 * expensive half of a run. The CSV usually carries its own Par Use Code,
 * which is the same signal — so where it does, the answer is available
 * before a single request goes out.
 *
 * WHY IT DOES NOT SIMPLY REPLACE THE POST-JOIN CHECK. saleUseCodeOf
 * falls back to the live record's property_use_code when the CSV row has
 * none. Judging purely on the CSV would therefore silently drop sales
 * that the live record could have classified — a narrowing disguised as
 * an optimisation. So this only decides a group when EVERY member has a
 * code of its own; anything less defers, gets fetched, and is judged
 * afterwards exactly as before. Same sales, most of the speed.
 * ------------------------------------------------------------------ */




/* ---------------------------------------------------------------------
 * Building age and floor area — POST-JOIN, and dual-source.
 *
 * Both read exactly what the Year Built and Living Area COLUMNS show:
 * the sales CSV's own value when it has one, otherwise the live
 * assessment record. That is the design constraint. Filtering on a
 * different source from the one on screen produces the worst kind of bug
 * — a row visibly holding 1962 vanishing from a 1950-1970 search — and it
 * is why these are not pre-join despite the CSV usually carrying both.
 * ------------------------------------------------------------------ */

/**
 * Building floor area in square feet for a joined sale feature, or null.
 *
 * Mirrors livingAreaOf in lib/columnsRegistry.js. Per ROW rather than
 * summed over the sale group, because that is what the Living Area cell
 * on this row shows — unlike the lot-size filter, whose group sum is the
 * denominator $/Lot SF actually divides by.
 */
export function saleBuildingSf(feature) {
  const p = feature?.properties || {};
  const sale = Number(p._saleLivingArea);
  if (Number.isFinite(sale) && sale > 0) return sale;
  const live = Number(p.total_living_area);
  return Number.isFinite(live) && live > 0 ? live : null;
}

/**
 * Year built as a NUMBER, or null.
 *
 * The CSV side is `_saleYearBuiltNumeric`, which lib/sales.js already
 * defines as the OLDEST year across a multi-section sale and documents as
 * being for "the grid's sort and any year filter" — this is that filter.
 * The display string it sits beside ("1911, 1913, 1954") cannot be
 * compared numerically, which is exactly why the numeric twin exists.
 *
 * Guards the roll's "unknown" sentinels the same way the popup does: 0
 * and blank mean nobody recorded a year, and letting 0 through would put
 * every unknown-age building inside any range starting at 0.
 */
export function saleYearBuilt(feature) {
  const p = feature?.properties || {};
  for (const raw of [p._saleYearBuiltNumeric, p.year_built]) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1700 && n <= 2200) return n;
  }
  return null;
}



/* ---------------------------------------------------------------------
 * RESIDENTIAL vs NON-RESIDENTIAL, among the improved sales.
 *
 * "Improved Only" split in two on 2026-09-16 (Jason): a house comp and a
 * strip-mall comp are different searches, and the Par Use Code already
 * carries the distinction.
 *
 * THE RULE IS A CODE TEST, not the appraisal category, because the
 * category collapses distinctions this needs (Condominium holds both
 * Condo Apartment and Condo-Office) and keeps ones it does not.
 * ------------------------------------------------------------------ */

/* Codes that start with RES but are NOT residential for this purpose. The
 * second bucket is named Non-Res/MIXED, and these are exactly the mixed
 * and institutional ones hiding behind a residential prefix (Jason's
 * call): Residential Multiple Use and Residential/Commercial Split are
 * Mixed-Use, Residential Group Care is Special Purpose. */
const RES_PREFIX_EXCEPTIONS = new Set(['RESMU', 'RESPL', 'RESGC']);

/* Condo codes that ARE residential. The RES prefix does not reach them —
 * the City files condos under CN — so they are named. CNCMP (Condo
 * Complex) and CNCST (Condo Cost) are deliberately absent: they describe
 * the filing, not the use. CNVAC never reaches here; it is vacant. */
const RES_CONDO_CODES = new Set(['CNAPT', 'CNRES', 'CNDRH']);

/**
 * Is this use code residential — houses, apartments and residential
 * condos?
 *
 * A blank code is NOT residential and not anything else: it is unknown,
 * and the group rules below keep unknown out of both buckets rather than
 * guessing. Callers must not read `false` here as "commercial".
 */
export function isResidentialUseCode(code) {
  const c = bareUseCode(code);
  if (!c) return false;
  if (RES_CONDO_CODES.has(c)) return true;
  return c.startsWith('RES') && !RES_PREFIX_EXCEPTIONS.has(c);
}

/**
 * What the vacant/improved control is choosing between, per SALE GROUP:
 *
 *   'vacant'            every parcel carries a vacant code
 *   'improved-res'      improved, and every CODED parcel is residential
 *   'improved-nonres'   improved, and at least one coded parcel is not
 *   'unknown'           no parcel in the group carries any code
 *
 * TWO GROUP RULES, both "the wider answer wins", both inherited from the
 * vacancy logic they extend:
 *
 *   one improved parcel makes the transaction improved — the buyer bought
 *   an improvement; and
 *   one NON-residential parcel makes it non-residential. Five houses sold
 *   with a store is not a residential comp, and the blended rate on every
 *   row is partly the store's.
 *
 * @param {Array} features joined sale features
 * @returns {Map<string, 'vacant'|'improved-res'|'improved-nonres'|'unknown'>}
 */
export function groupSaleType(features) {
  const vacancy = groupVacancy(features);
  const nonResByGroup = new Map();
  for (const f of features || []) {
    const key = String(f?.properties?._saleInstrument ?? '');
    const code = saleUseCodeOf(f);
    if (!code || isVacantUseCode(code)) continue;   // vacant parcels do not type the sale
    if (!isResidentialUseCode(code)) nonResByGroup.set(key, true);
  }
  const out = new Map();
  for (const [key, verdict] of vacancy) {
    if (verdict !== 'improved') { out.set(key, verdict); continue; }
    out.set(key, nonResByGroup.get(key) ? 'improved-nonres' : 'improved-res');
  }
  return out;
}

/**
 * Keep sales matching the selected mode.
 *
 * UNKNOWN PASSES EVERY MODE (Jason, 2026-09-16: "include blank in all
 * searches"). This inverts the missing-is-excluded rule the rest of this
 * file follows, deliberately and only here: a sale nobody coded is a sale
 * an appraiser should still SEE and judge, not one that quietly vanishes
 * from every narrowed view. Hiding it would make a thin comp set look like
 * a thin market.
 *
 * 'all' (or anything unrecognised) is off.
 */
export function passesSaleTypeFilter(feature, mode, typeByGroup) {
  if (mode !== 'vacant' && mode !== 'improved-res' && mode !== 'improved-nonres') return true;
  const verdict = typeByGroup?.get?.(String(feature?.properties?._saleInstrument ?? ''));
  if (verdict === 'unknown' || verdict == null) return true;
  return verdict === mode;
}

/**
 * The same verdict from the CSV's own Par Use Codes, for the PRE-FETCH
 * cut. null = this group cannot be decided here, so it is fetched and
 * judged after the join (see passesPreJoinSaleTypeFilter).
 *
 * @param {Map<string, object[]>} groups instrument -> SaleRecords
 */
export function csvGroupSaleType(groups) {
  const out = new Map();
  for (const [key, members] of groups || []) {
    const list = Array.isArray(members) ? members : [];
    let decidable = list.length > 0;
    let allVacant = true;
    let anyNonRes = false;
    let anyCoded = false;
    for (const m of list) {
      const code = bareUseCode(m?.useCode);
      if (!code) { decidable = false; break; }
      anyCoded = true;
      if (isVacantUseCode(code)) continue;
      allVacant = false;
      if (!isResidentialUseCode(code)) anyNonRes = true;
    }
    if (!decidable || !anyCoded) { out.set(String(key), null); continue; }
    if (allVacant) { out.set(String(key), 'vacant'); continue; }
    out.set(String(key), anyNonRes ? 'improved-nonres' : 'improved-res');
  }
  return out;
}

/**
 * The pre-fetch cut. FAILS OPEN on a group the export cannot decide — the
 * live record may still classify it, so this may only remove rows the
 * post-join check would also remove.
 */
export function passesPreJoinSaleTypeFilter(sale, verdicts, mode) {
  if (mode !== 'vacant' && mode !== 'improved-res' && mode !== 'improved-nonres') return true;
  const v = verdicts?.get?.(String(sale?.instrument ?? ''));
  if (v == null) return true;
  return v === mode;
}

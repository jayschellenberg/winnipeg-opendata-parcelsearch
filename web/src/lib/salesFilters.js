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
export function saleUseCodeOf(feature) {
  const p = feature?.properties || {};
  const raw = p._saleUseCode || p.property_use_code || '';
  return String(raw).trim().toUpperCase().split(/[\s-]/)[0];
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
 * Keep sales matching the vacant/improved mode. 'all' (or anything
 * unrecognised) is off. A sale whose vacancy is unknown drops out of
 * BOTH narrowed modes — it has not been checked either way.
 */
export function passesVacantFilter(feature, mode, vacancyByGroup) {
  if (mode !== 'vacant' && mode !== 'improved') return true;
  const key = String(feature?.properties?._saleInstrument ?? '');
  return vacancyByGroup.get(key) === mode;
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

/*
 * Rise (storey band) of apartment and office parcels, stamped onto SABRE
 * sales from an OFFLINE lookup — the same division of labour as the N1
 * crosswalk. The browser never classifies anything; it joins a roll
 * number against /rise-lookup.json and shows what the pipeline decided.
 *
 * WHY A LOOKUP. Neither the City's assessment roll nor SABRE carries a
 * storey count for RESAP/RESAM or CMOFF-family parcels (`building_type`
 * is only filled for houses, `number_floors_condo` only for condo
 * suites). WpgOpenData/RESAPStoreys derives one from OpenStreetMap
 * building:levels, Overture Maps building heights, and — where neither
 * exists — a model on assessed value, land area, units and zoning. That
 * needs Python, a 25 MB Overture extract and a scikit-learn model, none
 * of which belong in a client-only app. The lookup covers every parcel
 * in the two groups, not just the ones that have sold, so a sale in a
 * NEW export classifies the moment it lands.
 *
 * The bands are Jason's: apartments split at 3 storeys (garden / walk-up
 * vs anything with 4+), offices at 1–4 / 5–9 / 10+. The labels ride in
 * the JSON so the pipeline and this file cannot drift apart; the
 * fallbacks below only cover a lookup written before labels were added.
 *
 * Pure except loadRiseLookup, which takes its fetch as an argument so
 * the module unit-tests under plain node.
 */

import { pucsCode } from './pucs.js';

/** Use codes each group covers — must match RESAPStoreys' GROUPS. */
export const RISE_GROUP_CODES = Object.freeze({
  apartment: Object.freeze(['RESAP', 'RESAM']),
  office:    Object.freeze(['CMOFF', 'CMOMC', 'CMOGV', 'CMFBK']),
});

/** Fallback labels, used only when the JSON carries none. */
export const RISE_LABELS = Object.freeze({
  apartment: Object.freeze({ low: 'Low-rise / garden (≤3)', mid: 'Mid/high-rise (4+)' }),
  office:    Object.freeze({ low: 'Low-rise (1–4)', mid: 'Mid-rise (5–9)', high: 'High-rise (10+)' }),
});

/** Filter options, in rank order. 'high' never matches an apartment. */
export const RISE_CLASSES = Object.freeze(['low', 'mid', 'high']);

const SOURCE_NAMES = Object.freeze({
  osm_levels: 'OpenStreetMap building:levels',
  overture_height: 'Overture Maps building height',
  'model+overture_height': 'model on assessment attributes + Overture height',
  model: 'model on assessment attributes only (no height data for this parcel)',
});

/**
 * Roll number as the lookup keys it: digits only, zero-padded to 11.
 * SABRE writes `6070731000` for what the City calls `06070731000`; an
 * unpadded compare would report the sale as unclassified, which reads as
 * "the pipeline missed it" when in fact it did not.
 */
export function normalizeRiseRoll(roll) {
  const digits = String(roll ?? '').replace(/\D/g, '');
  return digits ? digits.padStart(11, '0') : '';
}

/** Which group a use code belongs to, or null when rise does not apply. */
export function riseGroupOfUseCode(code) {
  const c = pucsCode(code);
  if (!c) return null;
  for (const [group, codes] of Object.entries(RISE_GROUP_CODES)) {
    if (codes.includes(c)) return group;
  }
  return null;
}

/**
 * Parse the JSON document into a lookup: { rolls: Map, labels, generated }.
 * Tolerant of a malformed row — one bad entry must not blank the column
 * for every other sale.
 */
export function parseRiseLookup(doc) {
  const rolls = new Map();
  const labels = { ...RISE_LABELS };
  for (const [g, def] of Object.entries(doc?.groups || {})) {
    if (def?.labels && typeof def.labels === 'object') labels[g] = { ...labels[g], ...def.labels };
  }
  for (const [roll, v] of Object.entries(doc?.rolls || {})) {
    if (!Array.isArray(v) || v.length < 2) continue;
    const [group, cls, storeys, source] = v;
    if (!labels[group] || !RISE_CLASSES.includes(cls)) continue;
    const key = normalizeRiseRoll(roll);
    if (!key) continue;
    rolls.set(key, {
      group,
      cls,
      storeys: Number.isFinite(Number(storeys)) && storeys != null ? Number(storeys) : null,
      source: source ? String(source) : null,
    });
  }
  return { rolls, labels, generated: doc?.generated || null };
}

/** The lookup entry for a roll, or null. */
export function riseFor(lookup, roll) {
  if (!lookup?.rolls) return null;
  return lookup.rolls.get(normalizeRiseRoll(roll)) || null;
}

/** Grid text for an entry. */
export function riseLabel(lookup, entry) {
  if (!entry) return null;
  const labels = lookup?.labels?.[entry.group] || RISE_LABELS[entry.group] || {};
  return labels[entry.cls] || entry.cls;
}

/** Tooltip: the storey count and which instrument produced it. */
export function riseTitle(entry) {
  if (!entry) return null;
  const parts = [];
  if (entry.storeys != null) parts.push(`${entry.storeys} storey${entry.storeys === 1 ? '' : 's'}`);
  else parts.push('storey count not available — band is a model estimate');
  parts.push(`Source: ${SOURCE_NAMES[entry.source] || entry.source || 'unknown'}`);
  return parts.join('. ');
}

/**
 * Sort rank: low, mid, high, then everything unclassified — so one click
 * on the column brings the taller buildings together at either end.
 */
export function riseSortKey(entry) {
  if (!entry) return '9';
  const i = RISE_CLASSES.indexOf(entry.cls);
  return i < 0 ? '9' : String(i);
}

/**
 * Stamp rise onto sale features (the objects buildSaleFeatures returns).
 * Returns how many were stamped. Features whose use code is outside both
 * groups are left untouched: rise is not a property of a warehouse.
 */
export function stampRise(features, lookup) {
  let n = 0;
  for (const f of features || []) {
    const p = f?.properties;
    if (!p) continue;
    const entry = riseFor(lookup, p.roll_number);
    if (!entry) {
      // Eligible but unclassified: the parcel is missing from the lookup
      // (retired roll, resubdivision, or a build older than the parcel
      // file). Say so on the tooltip rather than leaving a silent blank.
      if (riseGroupOfUseCode(p._saleUseCode)) {
        p._riseTitle = 'Not in the rise lookup — parcel missing from the assessment file the pipeline used.';
      }
      p._riseSortKey = '9';
      continue;
    }
    p._rise = riseLabel(lookup, entry);
    p._riseClass = entry.cls;
    p._riseGroup = entry.group;
    p._riseStoreys = entry.storeys;
    p._riseSource = entry.source;
    p._riseTitle = riseTitle(entry);
    p._riseSortKey = riseSortKey(entry);
    n += 1;
  }
  return n;
}

/**
 * Pre-join filter predicate on a SaleRecord. 'any' passes everything;
 * a class passes only sales the lookup puts in that class. MISSING IS
 * EXCLUDED, like the other Additional filters: with the filter set, a
 * sale the pipeline never classified must not slip into a "mid-rise"
 * comp set unchecked.
 */
export function passesRiseFilter(sale, lookup, mode) {
  if (!mode || mode === 'any') return true;
  const entry = riseFor(lookup, sale?.roll);
  return !!entry && entry.cls === mode;
}

let cached = null;

/**
 * Fetch and parse /rise-lookup.json once per page load. Resolves to null
 * on any failure so the caller degrades to a blank column rather than a
 * broken sales run. `fetchFn` is injectable for tests.
 */
export function loadRiseLookup(fetchFn = globalThis.fetch, url = '/rise-lookup.json') {
  if (cached) return cached;
  cached = (async () => {
    try {
      const res = await fetchFn(url, { cache: 'no-cache' });
      if (!res?.ok) return null;
      return parseRiseLookup(await res.json());
    } catch (err) {
      console.warn('Rise lookup unavailable (Rise column stays blank):', err);
      return null;
    }
  })();
  return cached;
}

/** Test hook. */
export function resetRiseLookupCache() { cached = null; }

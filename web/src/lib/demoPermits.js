/*
 * Demolition-permit evidence for a sale.
 *
 * THE POINT: finding sales that looked like improved properties but
 * were really teardowns.
 *
 * A sale whose use code says "house" is normally an improved comp. But
 * if a demolition permit sits within a couple of years of the sale
 * date, the building was worthless to the buyer — the price bought the
 * lot and a demolition bill. Left unflagged, that sale walks into an
 * improved-comp set carrying building value nobody paid for, dragging
 * the whole set's $/Bldg SF down for reasons the assessment roll cannot
 * show. Those are the rows this module exists to surface.
 *
 * The same permit against an already-vacant sale is only confirmatory,
 * so the two cases are labelled differently rather than lumped together
 * — see demoVerdict.
 *
 * JOINING. The City's Building Permits table (it4w-cpf4) carries no
 * roll number — only street_number / street_name / street_type — so the
 * join is by address, through the same normalizeAddressKey the
 * assessment/civic-address reconciliation already uses (it folds AVENUE
 * to AVE and NORTH to N, which is exactly the drift between these
 * tables). The key deliberately omits the street TYPE, because a SABRE
 * export carries no type column at all. That is safe rather than
 * sloppy: across the 2,582 demolition permits since 2018 there is not
 * one case where dropping the type merges two different streets.
 *
 * Pure — no DOM, no network. soda.js fetches, main.js stamps.
 */

import { normalizeAddressKey } from './addressFormat.js';

/**
 * Default window either side of the sale, in days. Two years each way:
 * long enough to catch a permit pulled while a sale was being
 * negotiated or a buyer clearing the site the following season, short
 * enough that an unrelated redevelopment a decade later doesn't get
 * read as evidence about this transaction.
 */
export const DEMO_WINDOW_DAYS = Math.round(2 * 365.25);

/** Address key for either side of the join: number + street name, with
 *  the street type and any directional folded by normalizeAddressKey. */
export function demoAddressKey(streetNumber, streetName) {
  const num = String(streetNumber ?? '').trim();
  const name = String(streetName ?? '').trim();
  if (!num || !name) return '';
  return normalizeAddressKey(`${num} ${name}`);
}

/**
 * Index raw permit rows by address key.
 *
 * @param {Array} permits rows from it4w-cpf4
 * @returns {Map<string, Array<{date: string, ms: number, permitNumber, workType, subType}>>}
 */
export function buildDemoIndex(permits) {
  const index = new Map();
  for (const p of permits || []) {
    const key = demoAddressKey(p.street_number, p.street_name);
    if (!key) continue;
    const date = String(p.issue_date ?? '').slice(0, 10);
    const ms = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({
      date,
      ms,
      permitNumber: p.permit_number || '',
      workType: p.work_type || '',
      subType: p.sub_type || '',
    });
  }
  return index;
}

/**
 * The demolition permit nearest a sale date at the same address, within
 * the window. Null when the address is unknown to the permit table or
 * every permit there is outside it.
 *
 * NEAREST rather than first: an address can carry several permits (a
 * demolish and a demolition/construct on the same project), and the one
 * closest in time is the one that speaks to this transaction.
 *
 * @param {{streetNumber, streetName, saleDate}} sale
 * @param {Map} index from buildDemoIndex
 * @param {number} [windowDays]
 * @returns {{date, permitNumber, workType, subType, offsetDays, side}|null}
 *          side is 'before' or 'after', from the SALE's point of view.
 */
export function findDemoPermit(sale, index, windowDays = DEMO_WINDOW_DAYS) {
  if (!index || !index.size) return null;
  const key = demoAddressKey(sale?.streetNumber, sale?.streetName);
  if (!key) return null;
  const list = index.get(key);
  if (!list) return null;
  const saleMs = Date.parse(`${String(sale?.saleDate ?? '').slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(saleMs)) return null;
  const limit = windowDays * 24 * 60 * 60 * 1000;
  let best = null;
  let bestGap = Infinity;
  for (const p of list) {
    const gap = Math.abs(p.ms - saleMs);
    if (gap > limit) continue;
    if (gap < bestGap) { bestGap = gap; best = p; }
  }
  if (!best) return null;
  const offsetDays = Math.round((best.ms - saleMs) / 86_400_000);
  return {
    date: best.date,
    permitNumber: best.permitNumber,
    workType: best.workType,
    subType: best.subType,
    offsetDays,
    // A permit issued the same day as the sale reads as 'after': it did
    // not precede the transaction, so it cannot have informed the price.
    side: offsetDays < 0 ? 'before' : 'after',
  };
}

/**
 * The verdict that actually matters: a sale whose use code says there is
 * a BUILDING, with a demolition permit beside it.
 *
 * That combination is a teardown wearing an improved property's
 * clothes. It would otherwise walk into an improved-comp set carrying
 * building value the buyer never paid for — the price bought land and a
 * demolition bill. On an already-vacant sale the same permit is merely
 * confirmatory, which is why the two are not treated alike.
 *
 * @param {object|null} hit      from findDemoPermit
 * @param {boolean} saleIsVacant use code says vacant land
 * @returns {'teardown'|'confirms-vacant'|null}
 */
export function demoVerdict(hit, saleIsVacant) {
  if (!hit) return null;
  return saleIsVacant ? 'confirms-vacant' : 'teardown';
}

/** Human phrasing for the gap, e.g. "14 months before the sale". */
export function describeDemoPermit(hit, verdict = null) {
  if (!hit) return '';
  const days = Math.abs(hit.offsetDays);
  const months = Math.round(days / 30.44);
  const when = days < 45
    ? `${days} day${days === 1 ? '' : 's'}`
    : `${months} month${months === 1 ? '' : 's'}`;
  const what = [hit.workType, hit.subType].filter(Boolean).join(' / ');
  const lead = `Demolition permit ${hit.permitNumber || ''} (${what}) issued ${hit.date} — `
    + `${when} ${hit.side} the sale.`;
  if (verdict === 'teardown') {
    return `${lead} The use code says this sale had a building, so treat it as a LAND `
      + `sale: the price bought the lot and a demolition bill, not the improvement.`;
  }
  if (verdict === 'confirms-vacant') {
    return `${lead} The sale is already coded vacant, so this only confirms it.`;
  }
  return lead;
}

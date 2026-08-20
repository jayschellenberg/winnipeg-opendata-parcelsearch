/*
 * Evidence that a sale's assessment use code is stale.
 *
 * Two instruments, not one. Permits are the primary and everything
 * below the BUILT_BEFORE_DAYS block is about them; rollBuildVerdict at
 * the foot of the file is the second, and it exists because permits
 * structurally cannot answer for some sales. See its own note.
 *
 * THE POINT: two questions the assessment use code answers wrongly,
 * both settled by a building permit at the same address.
 *
 *   1. TEARDOWN — a sale coded improved, with a DEMOLITION permit
 *      beside it. The building was worthless to the buyer; the price
 *      bought the lot and a demolition bill.
 *   2. ALREADY BUILT — a sale coded VACANT, with a NEW-CONSTRUCTION
 *      permit issued well before it. The house was finished when the
 *      lot changed hands; the assessment simply had not caught up.
 *
 * Both are the same failure in opposite directions: the roll describes
 * the parcel as it was last assessed, not as it stood on the day it
 * sold, and a comp set built on the code alone inherits that error.
 *
 * Left unflagged, a teardown drags an improved set's $/Bldg SF down
 * for a reason the roll cannot show, and an already-built sale inflates
 * a LAND set: measured against Jason's archive, vacant-coded sales with
 * a construction permit 6+ months earlier run about $105 per lot square
 * foot against roughly $28 for genuine land — a different population,
 * not a wide spread.
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
export function permitAddressKey(streetNumber, streetName) {
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
export function buildPermitIndex(permits) {
  const index = new Map();
  for (const p of permits || []) {
    const key = permitAddressKey(p.street_number, p.street_name);
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
      permitType: p.permit_type || '',
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
 * @param {Map} index from buildPermitIndex
 * @param {number} [windowDays]
 * @returns {{date, permitNumber, workType, subType, offsetDays, side}|null}
 *          side is 'before' or 'after', from the SALE's point of view.
 */
export function findNearestPermit(sale, index, windowDays = DEMO_WINDOW_DAYS) {
  if (!index || !index.size) return null;
  const key = permitAddressKey(sale?.streetNumber, sale?.streetName);
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
    permitType: best.permitType,
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
 * @param {object|null} hit      from findNearestPermit
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

/*
 * How long before a sale a new-construction permit must sit for the
 * building to have been FINISHED when the lot changed hands.
 *
 * Six months, and the number is measured rather than assumed. Splitting
 * Jason's 14,018 vacant-coded sales by permit timing puts a wall
 * exactly here: 6+ months before the sale, the median is $427k and
 * about $105 per lot square foot; anywhere from 5 months before to
 * after the sale, $133k-$175k and $26-$30. A 3x step, not a gradient —
 * a house takes roughly that long to build, so a permit older than this
 * means the buyer bought a completed home whatever the roll says.
 */
export const BUILT_BEFORE_DAYS = Math.round(6 * 30.44);

/**
 * Did this sale actually include a building the use code doesn't know
 * about?
 *
 * Only asked of VACANT-coded sales: a construction permit against an
 * already-improved sale is unremarkable — every house has one — and
 * flagging those would bury the finding in noise.
 *
 * @param {object|null} hit from findNearestPermit against construction permits
 * @param {boolean} saleIsVacant use code says vacant land
 * @returns {'already-built'|'land-then-built'|null}
 */
export function buildVerdict(hit, saleIsVacant) {
  if (!hit || !saleIsVacant) return null;
  return hit.offsetDays <= -BUILT_BEFORE_DAYS ? 'already-built' : 'land-then-built';
}

/** Plain-language reading of a construction-permit verdict. */
export function describeBuildPermit(hit, verdict) {
  if (!hit) return '';
  const months = Math.round(Math.abs(hit.offsetDays) / 30.44);
  const what = [hit.permitType, hit.subType].filter(Boolean).join(' / ');
  const lead = `New-construction permit ${hit.permitNumber || ''} (${what}) issued ${hit.date} — `
    + `${months} month${months === 1 ? '' : 's'} ${hit.side} the sale.`;
  if (verdict === 'already-built') {
    return `${lead} The building was finished before the lot changed hands, so despite the `
      + `vacant use code this is an IMPROVED sale — do not read its rate as a land rate.`;
  }
  if (verdict === 'land-then-built') {
    return `${lead} Construction started at or after the sale, so the sale itself bought `
      + `bare land — a genuine land comp.`;
  }
  return lead;
}

/*
 * The SECOND instrument: the assessment roll's own year_built.
 *
 * A permit answers "was a building going up around the time of this
 * sale". For a large class of sales it cannot answer at all, and the
 * gap is structural rather than a tuning problem. Replayed over the
 * whole archive on 2026-08-20, 812 vacant-coded sales came back with no
 * construct-new permit either side and sat in Land unjudged. Asking the
 * roll instead:
 *
 *    641  no building on the roll at all        correctly Land
 *     55  roll year_built >= the sale year      land then built, correctly Land
 *     37  roll shows a building OLDER than the sale
 *     79  no live roll record                   the roll cannot answer either
 *
 * So 86% of that "blind spot" was never blind. The 37 are, and no
 * window would have caught them. They are two populations: houses built
 * 2014-2024 and sold seven to twelve years later at full price (28
 * WATERSTONE DRIVE, $1,525,000, 2,871 sf, built 2014), and pre-war
 * houses that predate it4w-cpf4 entirely, which starts in 2016 (570
 * BALMORAL, $52,500, built 1891). The first group is far outside the
 * three-year window; the second has no permit row in existence.
 *
 * They price like buildings, not dirt: median $56.27 per lot square
 * foot against the Land set's $29.98, p75 $130.21 against $37.71, and
 * 9 of the 35 rated rows sit above the Land set's p95. Removing them
 * barely moves the aggregate -- the Land median goes $29.98 to $29.94
 * across 6,673 sales -- which is the point. This is not a median
 * problem. It is 37 individual rows an appraiser could lift into a
 * report as land comps, one at a time.
 *
 * REQUIRES A LIVING AREA, not just a year. The roll zeroes living area
 * once a building comes down but keeps the year (185 BANNERMAN reads 0
 * today after selling six suites in 2022), so year_built alone would
 * read a demolished house as standing and call a genuine bare-lot sale
 * improved -- the exact error this is meant to remove, in reverse.
 *
 * REQUIRES A LIVE RECORD. No record is not evidence of bareness; those
 * 79 stay unjudged, which is the honest outcome.
 *
 * A PERMIT ALWAYS WINS. main.js only consults this when the permit pass
 * returned nothing. A permit is dated evidence about the transaction;
 * the roll is a snapshot read backwards, and where they disagree the
 * dated one is worth more.
 *
 * @returns {'already-built'|null}
 */
export function rollBuildVerdict({
  saleIsVacant, hasLiveRecord, yearBuilt, livingArea, saleDate,
}) {
  if (!saleIsVacant || !hasLiveRecord) return null;
  const built = Number(yearBuilt);
  if (!Number.isFinite(built) || built <= 1800) return null;
  const area = Number(livingArea);
  if (!Number.isFinite(area) || area <= 0) return null;
  const saleYear = Number(String(saleDate ?? '').slice(0, 4));
  if (!Number.isFinite(saleYear) || saleYear <= 1800) return null;
  return built < saleYear ? 'already-built' : null;
}

/** Plain-language reading of a ROLL-derived verdict. Says which
 *  instrument spoke, because a permit is dated evidence about this
 *  transaction and this is an inference from a later snapshot — an
 *  appraiser weighing the row is entitled to know which one they have. */
export function describeRollBuilt({ yearBuilt, livingArea, saleDate }) {
  const saleYear = String(saleDate ?? '').slice(0, 4);
  const area = Math.round(Number(livingArea) || 0).toLocaleString('en-CA');
  return `No construction permit within three years either way, but the assessment roll `
    + `records a ${yearBuilt} building of ${area} sf on this parcel — older than the ${saleYear} `
    + `sale, and still standing today. Despite the vacant use code something was on the lot `
    + `when it changed hands, so this is NOT a land comp. From the roll, not a permit: the `
    + `roll describes the parcel now, so confirm before leaning on the row.`;
}

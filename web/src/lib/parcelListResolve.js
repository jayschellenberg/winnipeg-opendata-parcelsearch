/*
 * Resolver behind the "Import list" modal: parsed rows in, assessment
 * rolls out, with a per-row verdict the review screen can render.
 *
 * RESOLUTION ORDER, per row:
 *   1. roll   — the row already names a roll. Looked up anyway, so the
 *               review screen can show what that roll IS and a typo'd
 *               roll reads as "not found" instead of silently mapping
 *               nothing.
 *   2. direct — the assessment roll's own street_number / street_name.
 *               This is one query per STREET, not per address, so the
 *               usual comp list of five addresses on one street costs
 *               a single request.
 *   3. side door — only for addresses step 2 missed. The City's civic-
 *               address dataset knows addresses the assessment roll does
 *               not list as a parcel's primary ("440 Hargrave" on the
 *               parcel assessed as "400 Hargrave"); each leftover address
 *               becomes a point, and the parcel containing it is the
 *               answer. One request per leftover address, which is why
 *               it runs second and only on the remainder.
 *
 * WHY THE STREET MATCH IS RE-CHECKED CLIENT-SIDE. The SoQL filter is a
 * substring LIKE, deliberately loose so "Selkirk Ave" finds street_name
 * "SELKIRK". Loose means it can also return a different street that
 * merely contains the query. So every returned row is re-tested here:
 * an EXACT normalized-name match wins outright, and only if a row has no
 * exact match do substring matches count — and if those span more than
 * one street name, the row is reported ambiguous rather than guessed at.
 *
 * MULTIPLE ROLLS AT ONE ADDRESS IS NORMAL, not an error: condo splits and
 * side doors genuinely put several assessment records on one civic
 * address. Those rows come back status 'multiple' with every roll
 * attached; the review screen includes them all by default and says so.
 *
 * Network access is entirely through injected fetchers (defaulting to
 * soda.js), so test/parcelListResolve.test.js exercises the whole
 * decision tree without touching the network.
 */

import {
  fetchAssessmentRowsByStreet,
  fetchCivicAddressPointsByStreet,
  fetchAssessmentRowsAtPoints,
  fetchAssessmentRowsByRolls,
  normalizeStreetQuery,
  streetKey,
  normalizeRoll,
} from '../soda.js';

/**
 * How many unmatched addresses get the side-door treatment. Each one is
 * its own request, so an import where nothing matched directly — a list
 * of Brandon addresses, say — must not turn into hundreds of calls. The
 * remainder are reported not-found with a notice saying the cap was hit,
 * which is the honest answer rather than a slow one.
 */
export const SIDE_DOOR_MAX = 60;

/** The parcel identity the review screen shows for one match. */
function toMatch(row) {
  return {
    roll: normalizeRoll(row.roll_number) || String(row.roll_number || ''),
    address: String(row.full_address || '').trim(),
  };
}

/** Distinct matches, first-seen order, deduped by roll. */
function dedupeMatches(matches) {
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    if (!m.roll || seen.has(m.roll)) continue;
    seen.add(m.roll);
    out.push(m);
  }
  return out;
}

function statusFor(matches) {
  if (!matches.length) return 'notfound';
  return matches.length > 1 ? 'multiple' : 'resolved';
}

/**
 * Group address rows by the street query they will be looked up under.
 * Rows whose streets normalize to the same thing share one request.
 */
function groupByStreet(rows, normalize) {
  const groups = new Map();   // normalized street -> { street, rows }
  for (const row of rows) {
    const key = normalize(row.street);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, street: row.street, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

/**
 * Resolve parsed rows (from lib/parcelListParse.js) to assessment rolls.
 *
 * @param {Array} rows - parsed rows, each { lineNo, raw, kind, ... }
 * @param {Object} [deps] - injectable fetchers, for tests
 * @returns {Promise<{
 *   rows: Array<{ ...row, status, matches, via }>,
 *   notices: string[],
 *   stats: { total, resolved, multiple, notfound, unparseable },
 * }>}
 */
export async function resolveParcelList(rows, deps = {}) {
  const byStreet   = deps.fetchAssessmentRowsByStreet   || fetchAssessmentRowsByStreet;
  const civicByStreet = deps.fetchCivicAddressPointsByStreet || fetchCivicAddressPointsByStreet;
  const atPoints   = deps.fetchAssessmentRowsAtPoints   || fetchAssessmentRowsAtPoints;
  const byRolls    = deps.fetchAssessmentRowsByRolls    || fetchAssessmentRowsByRolls;
  const normalize  = deps.normalizeStreetQuery          || normalizeStreetQuery;
  const fold       = deps.streetKey                     || streetKey;
  const normRoll   = deps.normalizeRoll                 || normalizeRoll;
  const sideDoorMax = deps.sideDoorMax ?? SIDE_DOOR_MAX;

  const input = Array.isArray(rows) ? rows : [];
  const notices = [];
  // Verdicts keyed by the row object itself, so the output preserves the
  // user's paste order no matter which path answered each row.
  const verdict = new Map();

  for (const row of input) {
    if (row.kind === 'unparseable') {
      verdict.set(row, { status: 'unparseable', matches: [], via: null });
    }
  }

  // ---- 1. rows that already name a roll --------------------------
  const rollRows = input.filter((r) => r.kind === 'roll');
  if (rollRows.length) {
    let found = null;
    try {
      found = await byRolls(rollRows.map((r) => r.roll));
    } catch (err) {
      console.warn('roll verification failed, accepting rolls unverified', err);
    }
    if (found) {
      const byRoll = new Map();
      for (const r of found) {
        const key = normRoll(r.roll_number);
        if (key) byRoll.set(key, r);
      }
      for (const row of rollRows) {
        const key = normRoll(row.roll);
        const hit = key ? byRoll.get(key) : null;
        verdict.set(row, {
          status: hit ? 'resolved' : 'notfound',
          matches: hit ? [toMatch(hit)] : [],
          via: 'roll',
        });
      }
    } else {
      // A dead lookup must not throw away a list the user typed. Accept
      // each roll at face value and say the address is unknown.
      for (const row of rollRows) {
        const roll = normRoll(row.roll);
        verdict.set(row, {
          status: roll ? 'resolved' : 'notfound',
          matches: roll ? [{ roll, address: '' }] : [],
          via: 'roll',
        });
      }
      notices.push('Roll numbers could not be verified against the assessment roll — they were accepted as typed.');
    }
  }

  // ---- 2. direct address lookup, one query per street -------------
  const addressRows = input.filter((r) => r.kind === 'address');
  const pending = [];
  if (addressRows.length) {
    const groups = groupByStreet(addressRows, normalize);
    // Rows whose street normalizes to nothing never make a request.
    for (const row of addressRows) {
      if (!normalize(row.street)) {
        verdict.set(row, { status: 'notfound', matches: [], via: 'address' });
      }
    }
    const results = await Promise.all(groups.map(async (g) => {
      try {
        return { g, rows: await byStreet(g.street, g.rows.map((r) => r.number)) };
      } catch (err) {
        console.warn(`address lookup failed for ${g.street}`, err);
        return { g, rows: null };
      }
    }));
    for (const { g, rows: fetched } of results) {
      if (fetched === null) {
        notices.push(`Lookup failed for ${g.street} — those rows are unresolved.`);
        for (const row of g.rows) {
          verdict.set(row, { status: 'notfound', matches: [], via: 'address' });
        }
        continue;
      }
      // Index the returned parcels by civic number.
      const byNumber = new Map();
      for (const r of fetched) {
        const n = parseInt(r.street_number, 10);
        if (!Number.isFinite(n)) continue;
        if (!byNumber.has(n)) byNumber.set(n, []);
        byNumber.get(n).push(r);
      }
      const target = g.key;
      for (const row of g.rows) {
        const candidates = byNumber.get(row.number) || [];
        const exact = candidates.filter((c) => fold(c.street_name) === target);
        const loose = candidates.filter((c) => fold(c.street_name).includes(target));
        const use = exact.length ? exact : loose;
        if (!use.length) { pending.push(row); continue; }
        const streets = new Set(use.map((c) => fold(c.street_name)));
        if (!exact.length && streets.size > 1) {
          // The query was loose and the answers disagree about which
          // street this is. Guessing here is exactly the mistake the
          // review screen exists to prevent.
          verdict.set(row, {
            status: 'ambiguous',
            matches: dedupeMatches(use.map(toMatch)),
            via: 'address',
          });
          continue;
        }
        const matches = dedupeMatches(use.map(toMatch));
        verdict.set(row, { status: statusFor(matches), matches, via: 'address' });
      }
    }
  }

  // ---- 3. side door: civic-address point → containing parcel ------
  if (pending.length) {
    const capped = pending.slice(0, sideDoorMax);
    const skipped = pending.slice(sideDoorMax);
    for (const row of skipped) {
      verdict.set(row, { status: 'notfound', matches: [], via: 'address' });
    }
    if (skipped.length) {
      notices.push(
        `${skipped.length} address${skipped.length === 1 ? '' : 'es'} went unmatched on the assessment roll `
        + `and were not cross-referenced against the civic-address dataset (limit ${sideDoorMax}).`
      );
    }
    // One civic-address request per street covers every leftover on it.
    const groups = groupByStreet(capped, normalize);
    const pointsByStreet = new Map();
    await Promise.all(groups.map(async (g) => {
      try {
        const fc = await civicByStreet(g.street, g.rows.map((r) => r.number));
        pointsByStreet.set(g.key, fc?.features || []);
      } catch (err) {
        console.warn(`civic-address lookup failed for ${g.street}`, err);
        pointsByStreet.set(g.key, []);
      }
    }));
    // Then one containment request per leftover ADDRESS, because the
    // union query dedupes by roll and would lose which address produced
    // which parcel — the one thing this step has to know.
    await Promise.all(capped.map(async (row) => {
      const key = normalize(row.street);
      const features = (pointsByStreet.get(key) || [])
        .filter((f) => parseInt(f.properties?.street_number, 10) === row.number);
      if (!features.length) {
        verdict.set(row, { status: 'notfound', matches: [], via: 'address' });
        return;
      }
      try {
        const found = await atPoints({ type: 'FeatureCollection', features });
        const matches = dedupeMatches((found || []).map(toMatch));
        verdict.set(row, {
          status: statusFor(matches),
          matches,
          via: matches.length ? 'civic' : 'address',
        });
      } catch (err) {
        console.warn(`containment lookup failed for ${row.interpreted}`, err);
        verdict.set(row, { status: 'notfound', matches: [], via: 'address' });
      }
    }));
  }

  const out = input.map((row) => {
    const v = verdict.get(row) || { status: 'notfound', matches: [], via: null };
    return { ...row, ...v };
  });

  return {
    rows: out,
    notices,
    stats: {
      total: out.length,
      resolved: out.filter((r) => r.status === 'resolved').length,
      multiple: out.filter((r) => r.status === 'multiple').length,
      ambiguous: out.filter((r) => r.status === 'ambiguous').length,
      notfound: out.filter((r) => r.status === 'notfound').length,
      unparseable: out.filter((r) => r.status === 'unparseable').length,
    },
  };
}

/**
 * The distinct rolls carried by the rows the user left checked, in paste
 * order. Paste order is the point: Property Search's "Entry order"
 * numbering reads the roll list back in exactly this sequence, so the
 * parcels on the map are numbered the way the list was written.
 */
export function collectRolls(rows, isIncluded = () => true) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!isIncluded(row)) continue;
    for (const m of row.matches || []) {
      if (!m.roll || seen.has(m.roll)) continue;
      seen.add(m.roll);
      out.push(m.roll);
    }
  }
  return out;
}

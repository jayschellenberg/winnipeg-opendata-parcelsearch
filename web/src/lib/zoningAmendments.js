/**
 * Zoning amendments per parcel — the index behind the "Zoning Changes"
 * pill, the amber map highlight, the Rezoned grid column and the popup
 * line.
 *
 * Two sources, merged by roll number:
 *   - web/public/zoning-amendments.json, built offline by
 *     r/build_zoning_amendments.R from the City's DMIS list of amending
 *     Land Development by-laws (adopted rezonings, 2001 on), each placed on
 *     its parcels by address, by street corner, or by inheriting the by-law
 *     it corrects (`confidence` says which).
 *   - Public Notices (gnxp-9hpt), live: rezoning applications from 2025 on,
 *     roll-keyed by the City, mostly still at the notice stage. These are
 *     "pending" until a by-law exists.
 *
 * Pure so the merge and the cell / sort rules are unit-tested
 * (test/zoningAmendments.test.js).
 */

export const ZONING_CHANGE_MODES = ['off', 'show', 'filter'];

const NOTICE_TYPES = new Set(['REZONING', 'SUBDIVISION AND REZONING', 'ZONING AGREEMENT AMENDMENT']);

const KIND_LABEL = {
  'rezoning': 'Rezoning',
  'subdivision-rezoning': 'Subdivision + rezoning',
  'correction': 'Correction',
  'text': 'Text amendment',
  'notice': 'Rezoning notice',
};

/** DMIS record page for a by-law entry. */
export function dmisRecordUrl(entry) {
  return entry?.dmisId ? `https://dmis.winnipeg.ca/ViewByLaw?bylawId=${encodeURIComponent(entry.dmisId)}` : null;
}

/** One index entry per Public Notices rezoning row, keyed by roll. */
export function noticeEntries(rows) {
  const byRoll = new Map();
  for (const r of rows || []) {
    const type = String(r?.notice_type || '').toUpperCase();
    const roll = r?.roll_number != null ? String(r.roll_number).trim() : '';
    if (!NOTICE_TYPES.has(type) || !roll) continue;
    const entry = {
      kind: 'notice',
      noticeId: r.notice_id || null,
      noticeType: type,
      address: r.address || null,
      description: r.description || null,
      inDate: (r.in_date || '').slice(0, 10) || null,
      meetingDate: (r.meeting_date || '').slice(0, 10) || null,
      decision: r.decision || null,
      url: r.dmis_decision?.url || (typeof r.dmis_decision === 'string' ? r.dmis_decision : null),
      confidence: 'notice',
    };
    if (!byRoll.has(roll)) byRoll.set(roll, []);
    const list = byRoll.get(roll);
    if (!list.some((e) => e.noticeId && e.noticeId === entry.noticeId)) list.push(entry);
  }
  return byRoll;
}

/**
 * Merge the offline by-law index with live notices.
 * @returns {{ byRoll: Map<string, object[]>, nonParcel: object[], unresolved: object[],
 *             generated: string|null, counts: object, rolls: string[] }}
 */
export function buildAmendmentIndex(json, noticeRows = []) {
  const byRoll = new Map();
  const src = json?.byRoll || {};
  for (const [roll, entries] of Object.entries(src)) {
    if (!Array.isArray(entries) || !entries.length) continue;
    byRoll.set(String(roll), entries.map((e) => ({ ...e })));
  }
  for (const [roll, entries] of noticeEntries(noticeRows)) {
    const cur = byRoll.get(roll) || [];
    byRoll.set(roll, cur.concat(entries));
  }
  for (const [roll, entries] of byRoll) byRoll.set(roll, sortEntries(entries));
  return {
    byRoll,
    nonParcel: Array.isArray(json?.nonParcel) ? json.nonParcel : [],
    unresolved: Array.isArray(json?.unresolved) ? json.unresolved : [],
    generated: json?.generated || null,
    counts: json?.counts || {},
    rolls: [...byRoll.keys()],
  };
}

/** Year an entry belongs to: the by-law's passing year, or the notice's. */
export function entryYear(e) {
  const d = e?.passed || e?.effective || e?.meetingDate || e?.inDate || '';
  const m = /^(\d{4})/.exec(String(d));
  if (m) return Number(m[1]);
  const b = /\/(\d{4})$/.exec(String(e?.bylaw || ''));
  return b ? Number(b[1]) : null;
}

/** Newest first; notices (pending) ahead of adopted by-laws of the same year. */
export function sortEntries(entries) {
  return [...(entries || [])].sort((a, b) => {
    const ya = entryYear(a) ?? -1;
    const yb = entryYear(b) ?? -1;
    if (ya !== yb) return yb - ya;
    if ((a.kind === 'notice') !== (b.kind === 'notice')) return a.kind === 'notice' ? -1 : 1;
    return String(b.passed || '').localeCompare(String(a.passed || ''));
  });
}

/** The newest year on a parcel, for sorting the grid column. null = none. */
export function latestAmendmentYear(entries) {
  let best = null;
  for (const e of entries || []) {
    const y = entryYear(e);
    if (y != null && (best == null || y > best)) best = y;
  }
  return best;
}

/** "140/2008 (2008) · notice 26-106557 (pending)" — the grid cell. */
export function amendmentCellText(entries) {
  const parts = [];
  for (const e of sortEntries(entries)) {
    if (e.kind === 'notice') {
      const st = e.decision ? e.decision.toLowerCase() : 'pending';
      parts.push(`notice ${e.noticeId || ''} (${st})`.replace('  ', ' '));
    } else {
      const y = entryYear(e);
      parts.push(`${e.bylaw}${y ? ` (${y})` : ''}${e.kind === 'correction' ? ' corr.' : ''}`);
    }
  }
  return parts.join(' · ');
}

/**
 * Plain-text lines for a popup or tooltip, one per entry, newest first:
 * label, detail, and a link. No HTML here — the caller escapes.
 */
export function amendmentLines(entries) {
  return sortEntries(entries).map((e) => {
    if (e.kind === 'notice') {
      return {
        label: `${KIND_LABEL.notice} ${e.noticeId || ''}`.trim(),
        detail: [e.noticeType && e.noticeType !== 'REZONING' ? e.noticeType.toLowerCase() : null,
          e.decision || 'pending', e.meetingDate ? `meeting ${e.meetingDate}` : (e.inDate ? `filed ${e.inDate}` : null)]
          .filter(Boolean).join(' · '),
        url: e.url || null,
        pending: true,
      };
    }
    const when = e.passed ? `passed ${e.passed}` : (e.effective ? `effective ${e.effective}` : null);
    const conf = e.confidence === 'corner' ? 'placed by street corner — verify'
      : e.confidence === 'correction' ? 'inherits the corrected by-law’s parcels' : null;
    return {
      label: `By-law ${e.bylaw}${e.daz ? ` (${e.daz})` : ''}`,
      detail: [KIND_LABEL[e.kind] || e.kind, when, conf].filter(Boolean).join(' · '),
      url: dmisRecordUrl(e),
      pending: false,
    };
  });
}

/*
 * Pure helpers behind the Data Status dialog (src/dataStatusDialog.js).
 *
 * Everything here is date arithmetic and row assembly — no DOM, no
 * fetch, no IndexedDB — so it runs under plain `node test/run` like the
 * rest of lib/.
 *
 * The date renderers are hand-parsed on purpose (ported from the
 * Manitoba site): `new Date('2026-08-01')` parses as UTC midnight, and
 * toLocaleDateString then renders JULY 31 anywhere west of Greenwich.
 * Regex + a month table has no such trap.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

/** '2026-07' → 'July 2026'. Anything else passes through unchanged. */
export function monthLabel(ym) {
  const m = String(ym ?? '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return String(ym ?? '');
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return String(ym);
  return `${MONTHS[idx]} ${m[1]}`;
}

/** ISO date or timestamp → its 'YYYY-MM-DD' part, else '' for garbage. */
export function datePart(ts) {
  const m = String(ts ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/** '2026-08-01' (or an ISO timestamp) → 'Aug 1, 2026'. Hand-parsed —
 *  never routed through Date — so the label can't slip a day. Anything
 *  that isn't ISO passes through unchanged. */
export function dateLabel(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso ?? '');
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return String(iso);
  return `${MONTHS_SHORT[idx]} ${Number(m[3])}, ${m[1]}`;
}

/**
 * data.winnipeg.ca /api/views/<id>.json → the dataset's last row-update
 * as an ISO date, or null when the metadata doesn't carry one.
 *
 * Socrata's rowsUpdatedAt is EPOCH SECONDS — unlike ArcGIS's
 * dataLastEditDate (milliseconds), which is the trap this comment
 * exists to disarm.
 */
export function socrataUpdatedDate(json) {
  const s = json?.rowsUpdatedAt;
  if (!Number.isFinite(s) || s <= 0) return null;
  return new Date(s * 1000).toISOString().slice(0, 10);
}

/**
 * The next scheduled citywide tile rebuild, as 'October 2026'.
 *
 * The archive rebuilds on the 2nd of every EVEN month (map.js's
 * TILE_STALE_DAYS comment; WpgParcelTilesBiMonthly → r/rebuild_tiles.ps1).
 * Month-and-year only — naming the exact day would promise a scheduler
 * start time this label has no way to know.
 */
export function nextTileRebuildLabel(now = new Date()) {
  let year = now.getFullYear();
  // Months here are 1-based for readability: rebuilds run in 2,4,…,12.
  let month = now.getMonth() + 1;
  const day = now.getDate();
  const isRebuildMonth = month % 2 === 0;
  if (!isRebuildMonth || day > 2) {
    month = isRebuildMonth ? month + 2 : month + 1;
    if (month > 12) { month -= 12; year += 1; }
  }
  return `${MONTHS[month - 1]} ${year}`;
}

/**
 * Pull the `_meta` object off the tail of one of the committed geojson
 * files (transit-routes, wpg-neighbourhoods…). Their builder writes
 * `"_meta":{…}}` as the very last bytes, so a small Range fetch of the
 * tail is enough — this parses that fragment. Returns null when the
 * fragment doesn't contain a complete _meta (Range ignored mid-object,
 * file truncated, …).
 */
export function extractTailMeta(text) {
  const s = String(text ?? '');
  const at = s.lastIndexOf('"_meta"');
  if (at < 0) return null;
  const start = s.indexOf('{', at);
  if (start < 0) return null;
  // The builder emits _meta as the final property, so the fragment ends
  // `…}}` — strip the outer close and parse the object itself.
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Whole days between a 'YYYY-MM-DD' build date and now; null when the
 *  date doesn't parse. UTC on both sides so the subtraction is exact. */
export function tileAgeDays(builtDate, now = new Date()) {
  const built = Date.parse(`${String(builtDate ?? '')}T00:00:00Z`);
  if (!Number.isFinite(built)) return null;
  return Math.floor((now.getTime() - built) / 86_400_000);
}

/**
 * Rows for the dialog's "Published site data" block. Every input is
 * optional — a source whose fetch failed still gets a row, with a null
 * vintage the renderer shows as unknown rather than alarming.
 *
 * @param {object} opts
 * @param {object|null} opts.pmtilesMeta         parcels-pmtiles-meta.json
 * @param {object|null} opts.neighbourhoodsMeta  wpg-neighbourhoods.geojson _meta
 * @param {object|null} opts.transitMeta         transit-routes.geojson _meta
 * @param {Date}        opts.now
 * @returns {Array<{label: string, vintage: string|null, detail: string, next: string}>}
 */
export function publishedRows({ pmtilesMeta, neighbourhoodsMeta, transitMeta, now = new Date() } = {}) {
  const rows = [];
  const nextRebuild = nextTileRebuildLabel(now);

  const built = datePart(pmtilesMeta?.built) || null;
  const tiled = Number(pmtilesMeta?.features_tiled);
  const live = Number(pmtilesMeta?.source_live_count);
  rows.push({
    label: 'Citywide parcel tiles',
    vintage: built ? dateLabel(built) : null,
    detail: Number.isFinite(tiled) && Number.isFinite(live)
      ? `${tiled.toLocaleString('en-CA')} parcels tiled of ${live.toLocaleString('en-CA')} live`
      : '',
    next: nextRebuild,
  });

  const nbDate = datePart(neighbourhoodsMeta?.generated_at) || null;
  const nbCount = Number(neighbourhoodsMeta?.neighbourhood_count);
  rows.push({
    label: 'Neighbourhood boundaries',
    vintage: nbDate ? dateLabel(nbDate) : null,
    detail: Number.isFinite(nbCount) ? `${nbCount} neighbourhoods` : '',
    next: 'with app deploys',
  });

  const trDate = datePart(transitMeta?.generated_at) || null;
  const trCount = Number(transitMeta?.route_count);
  rows.push({
    label: 'Transit routes & stops',
    vintage: trDate ? dateLabel(trDate) : null,
    detail: Number.isFinite(trCount) ? `${trCount} routes (Winnipeg Transit GTFS)` : '',
    next: 'with app deploys',
  });

  return rows;
}

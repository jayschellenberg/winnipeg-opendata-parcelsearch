/**
 * Historical (as-of-date) overlay — the per-snapshot PMTiles archives.
 *
 * r/build_historical_tiles.R turns each wpg-parcel-history snapshot into one
 * vector-tile archive (layers `parcels` and `survey`) with the size-change
 * band vs today's roll baked in, published on R2 beside the citywide
 * parcels archive. The app streams it like any other tile source, so the
 * whole city is on screen at once — no Area picker, no per-view shard cap.
 *
 * The lineage and the whole-city as-of zoning still come from the archive
 * CDN (small, keyed files); only the two heavy polygon layers moved to tiles.
 *
 * Pure so the naming is unit-tested (test/historicalTiles.test.js).
 */

/** Where the archives live unless VITE_HISTORICAL_TILES_BASE overrides it. */
export const DEFAULT_HISTORICAL_TILES_BASE =
  'https://pub-f351b204f73e4b2287acad946d79681c.r2.dev';

/** The archive file name for a snapshot: `wpg-hist-2026-07-01.pmtiles`. */
export function historicalTileFile(snap) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(snap || ''))) return null;
  return `wpg-hist-${snap}.pmtiles`;
}

/** The https URL of a snapshot's archive (no pmtiles:// prefix). */
export function historicalTilesUrl(base, snap) {
  const file = historicalTileFile(snap);
  if (!file) return null;
  return `${String(base || DEFAULT_HISTORICAL_TILES_BASE).replace(/\/+$/, '')}/${file}`;
}

/**
 * "Size changes vs the 2026-09-14 roll: 1,204 major, 3,310 minor, 812 gone"
 * from a meta entry's size_change block; '' when there is nothing to say.
 */
export function sizeChangeSummaryText(entry) {
  const sc = entry?.size_change;
  if (!sc) return '';
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const parts = [];
  if (sc.major) parts.push(`${fmt(sc.major)} major`);
  if (sc.minor) parts.push(`${fmt(sc.minor)} minor`);
  if (sc.gone)  parts.push(`${fmt(sc.gone)} gone`);
  if (!parts.length) return '';
  const vs = entry.size_change_vs ? ` vs the ${entry.size_change_vs} roll` : '';
  return `Size changes${vs}: ${parts.join(', ')} (red >25%, orange >5%, grey = roll gone).`;
}

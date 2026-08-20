/*
 * Staleness-banner policy for the citywide parcel tiles.
 *
 * Same shape as the Manitoba site's lib/staleness.js, with thresholds
 * keyed to Winnipeg's pipeline: the tile archive rebuilds on the 2nd of
 * every even month (WpgParcelTilesBiMonthly → r/rebuild_tiles.ps1), so a
 * healthy archive is at most ~62 days old and 90 days = two consecutive
 * missed rebuilds (matching TILE_STALE_DAYS in map.js, which logs the
 * same condition to the console). Past a year the data is unambiguously
 * unfit and the banner goes red.
 *
 * Pure: no DOM, no fetch — dataStatusDialog.js owns the rendering.
 */

/** Age (days) at or below which no banner shows. */
export const STALE_FRESH_MAX_DAYS = 90;

/** Age (days) above which the banner turns red rather than amber. */
export const STALE_RED_MIN_DAYS = 365;

/**
 * What the staleness banner should show for tiles this many days old.
 *
 * @param {number|null} oldestDays  age of the tile archive in days
 * @returns {{show: boolean, tone: string|null, lead: string, tail: string}}
 */
export function stalenessBannerState(oldestDays) {
  if (!Number.isFinite(oldestDays) || oldestDays <= STALE_FRESH_MAX_DAYS) {
    return { show: false, tone: null, lead: '', tail: '' };
  }
  const lead = `Citywide parcel tiles are ${Math.floor(oldestDays)} days old.`;
  if (oldestDays > STALE_RED_MIN_DAYS) {
    return {
      show: true,
      tone: 'data-staleness-red',
      lead,
      tail: 'The bi-monthly rebuild has not published in over a year — '
        + 'parcels created since then are missing from Show All Parcels and '
        + 'Dwelling Units. Check the WpgParcelTilesBiMonthly scheduled task '
        + 'and r/rebuild_tiles.ps1.',
    };
  }
  return {
    show: true,
    tone: 'data-staleness-amber',
    lead,
    tail: 'Two bi-monthly rebuilds have been missed. Newer parcels are '
      + 'absent from the citywide layers until the WpgParcelTilesBiMonthly '
      + 'task publishes again (r/rebuild_tiles.ps1).',
  };
}

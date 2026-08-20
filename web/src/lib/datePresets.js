/*
 * Sale-date range presets (the pill row above the From/To pickers).
 *
 * Ported from the Manitoba site's applyDatePreset. Two rules beyond
 * "today minus N months":
 *
 *   - Month-end clamp: JS Date.setMonth overflows (Mar 31 − 1 mo →
 *     Mar 3), so when the day-of-month overflows the target month we
 *     clamp to that month's last day instead.
 *
 *   - Jan-1 snap at 24 months and up: appraisers reason in vintage
 *     YEARS at that range, so "24 mo" means "this year, last year and
 *     the one before" — From snaps back to Jan 1 of whatever year the
 *     plain offset lands in. Only ever widens the window. The short
 *     presets (3/6/12) stay exact rolling windows.
 *
 * Pure and Node-testable: `today` is injectable, and nothing here
 * touches the DOM.
 */

/** Local-time YYYY-MM-DD. Deliberately not toISOString(): Manitoba runs
 *  5–6 h behind UTC, so from early evening the UTC date is TOMORROW. */
export function isoDate(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/**
 * The From/To window for a preset button.
 *
 * @param {number} monthsBack  whole months back from today
 * @param {Date}   today       injectable clock for tests
 * @returns {{from: string, to: string}} ISO dates, from ≤ to
 */
export function presetRange(monthsBack, today = new Date()) {
  const to = isoDate(today);
  const back = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const targetMonthIndex = back.getMonth() - monthsBack;
  back.setMonth(targetMonthIndex);
  // setMonth overflowed into the following month (e.g. Mar 31 − 1 mo
  // lands on Mar 3): clamp to the target month's last day.
  const wanted = ((targetMonthIndex % 12) + 12) % 12;
  if (back.getMonth() !== wanted) back.setDate(0);
  if (monthsBack >= 24) {
    back.setMonth(0);
    back.setDate(1);
  }
  return { from: isoDate(back), to };
}

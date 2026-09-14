/**
 * Traffic-count history: the per-year series behind a corridor or a
 * permanent station, and the annualized growth read off it.
 *
 * The City publishes no AADT table. The history IS the raw data: midblock
 * counts are 2–7 day portable-tube studies going back to 1997, keyed by
 * street / from / to; the eight permanent stations log every 15 minutes
 * since late 2019. Both reduce to the same shape here — one entry per
 * year with the summed count and the number of days it was sampled over —
 * so the popup and the growth figure can treat them alike. The caveats
 * differ and the callers say so: a midblock year is a "24-h study
 * average" (season and study length move it as much as growth does); a
 * station year with near-complete coverage is a true annual average.
 *
 * Pure so it is unit-tested (test/trafficSeries.test.js) and importable
 * by both soda.js and map.js.
 */

/** Days of coverage that make a station year a real annual average. */
export const FULL_YEAR_MIN_DAYS = 300;

/**
 * Collapse study- or station-level entries into one row per year.
 * @param {Array<{year: number|string, total: number|string, days: number|string, studies?: number}>} entries
 * @returns {Array<{year: number, avg: number, total: number, days: number, studies: number}>} ascending by year
 */
export function yearSeriesFromEntries(entries) {
  const byYear = new Map();
  for (const e of entries || []) {
    const year = Number(e?.year);
    const total = Number(e?.total);
    const days = Number(e?.days);
    if (!Number.isInteger(year) || year < 1900 || !Number.isFinite(total) || !(days > 0)) continue;
    const row = byYear.get(year) || { year, total: 0, days: 0, studies: 0 };
    row.total += total;
    row.days += days;
    row.studies += Number.isFinite(Number(e.studies)) ? Number(e.studies) : 1;
    byYear.set(year, row);
  }
  return [...byYear.values()]
    .filter((r) => r.total > 0)
    .map((r) => ({ ...r, avg: Math.round(r.total / r.days) }))
    .sort((a, b) => a.year - b.year);
}

/**
 * Compound annual growth between the first and last qualifying years.
 * `minDays` keeps thin samples out of the endpoints; `minSpanYears` refuses
 * a rate read off two adjacent years, which says more about the studies
 * than the road. Null when there is nothing defensible to say.
 * @returns {{pct: number, fromYear: number, toYear: number, from: number, to: number}|null}
 */
export function annualizedGrowth(series, { minDays = 1, minSpanYears = 2 } = {}) {
  const ok = (series || []).filter((r) => r.days >= minDays && r.avg > 0);
  if (ok.length < 2) return null;
  const first = ok[0];
  const last = ok[ok.length - 1];
  const span = last.year - first.year;
  if (span < minSpanYears) return null;
  const rate = Math.pow(last.avg / first.avg, 1 / span) - 1;
  if (!Number.isFinite(rate)) return null;
  return {
    pct: Math.round(rate * 1000) / 10,
    fromYear: first.year,
    toYear: last.year,
    from: first.avg,
    to: last.avg,
  };
}

/** "+5.1%/yr (2021→2025)"; '' for null. */
export function formatGrowth(g) {
  if (!g) return '';
  const sign = g.pct > 0 ? '+' : '';
  return `${sign}${g.pct.toFixed(1)}%/yr (${g.fromYear}→${g.toYear})`;
}

/** The latest year with enough days to be an annual average, or null. */
export function latestFullYear(series, minDays = FULL_YEAR_MIN_DAYS) {
  const full = (series || []).filter((r) => r.days >= minDays);
  return full.length ? full[full.length - 1] : null;
}

/** Parse a series that rode through MapLibre feature properties as JSON. */
export function parseSeries(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Assessment history block for the Winnipeg preliminary report: the roll's
// total assessed value at each wpg-parcel-history snapshot and today, with
// the change between them. Renders nothing without at least one snapshot.

import { HISTORICAL_PIN, fetchHistoricalIndex } from '../soda.js';
import { snapshotRows, neighbourhoodSlug } from '../lib/snapshotValues.js';
import { fmtMoney } from '../lib/reportData.js';

export async function renderAssessmentHistory(el, { roll, neighbourhood, current, currentYear, cite }) {
  if (!el || !roll || !neighbourhood) return;
  const index = await fetchHistoricalIndex();
  const snaps = Object.entries(index?.snapshots || {})
    .filter(([, s]) => s?.layers?.parcels)
    .map(([id]) => id);
  if (!snaps.length) return;
  const slug = neighbourhoodSlug(neighbourhood);
  const found = {};
  await Promise.all(snaps.map(async (snap) => {
    try {
      const res = await fetch(`${HISTORICAL_PIN}/${snap}/parcels/${slug}.json`);
      if (!res.ok) return;
      const fc = await res.json();
      const f = (fc.features || []).find((x) => x.properties?.roll_number === roll);
      if (f) found[snap] = f.properties;
    } catch { /* a missing snapshot just leaves a gap */ }
  }));
  const rows = snapshotRows(found, { total: current, year: currentYear });
  if (rows.length < 2) return;
  const pct = (v) => (v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
  el.innerHTML = `
    <h3>Assessed value over time</h3>
    <table class="rp-table"><thead><tr><th></th><th>Total assessed</th><th>Change</th></tr></thead><tbody>${
      rows.map((r) => `<tr><td>${r.label}</td><td>${fmtMoney(r.total)}</td><td>${pct(r.pct)}</td></tr>`).join('')
    }</tbody></table>
    <p class="rp-note">From the semi-annual snapshots of the City's Assessment Parcels kept by this site; the snapshots record no roll year, so rows are dated by snapshot. Winnipeg reassesses every two years.</p>`;
  cite?.('Assessment history', `Snapshots of City of Winnipeg Assessment Parcels (wpg-parcel-history): ${Object.keys(found).sort().join(', ')}.`);
}

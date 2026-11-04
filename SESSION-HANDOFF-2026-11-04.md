# Session handoff — 2026-11-04

Everything below is **shipped and live** unless a line says otherwise. How the
features work is in `README.md` (§ *Public Notices & Rezonings layer*, § *New
Plans layer*) and `REPLICATION_GUIDE.md` §8.7.3 / §8.7.4; this file is only what
changed, why, and what is still open.

PRs #73 – #78, plus this documentation PR. Each merged to `main` and checked on
the live site after Vercel deployed it.

---

## What shipped

| PR | Change |
|---|---|
| #73 | **Public Notices & Rezonings** point layer under Planning: adopted DMIS rezoning by-laws (one point per by-law at its parcels' centroid) + live rezoning-type Public Notices, coloured by type, clustered below z13, **Within** 1/2/3/5/10/all years (default 5). Also corrected the Zoning Changes tooltips: DMIS coverage starts **1997**, not 2001. |
| #74 | **Show** dropdown on that layer (both / notices only / rezonings only). **New Plans** layer: survey plans not in the 2025-03-14 survey snapshot, dated by snapshot diff. |
| #75 | New Plans **Lots** min / max filter. |
| #76 | Public Notices **Parcels** min / max filter — by-laws only; notices always shown (see below). |
| #77 | New Plans **Within** filter (default all). |
| #78 | MLS Areas moved into the main Map Layers grid beside Dimensions; icons on 15 layer buttons and Search / Clear via `data-icon`; **Planning layout fix** (the filter fields from #73–#77 had broken the grid). |

URL params added: `nz py ps pa pb` (Public Notices), `np nl nx ny` (New Plans).

---

## Decisions that will silently regress if changed

- **Notices have no parcel count.** The City ties each Public Notice to one
  roll even when it covers a subdivision phase ("136 … 172 Pathfinder Trail",
  "Prairie Pointe Stage 11"). The Parcels filter therefore passes every notice.
  Giving notices a count of 1 would misclassify exactly the big ones.
- **New Plans windows are state.** `web/public/new-plans.geojson` carries each
  plan's first-seen window forward; a rebuild only dates plans it has not seen
  before, to (last build, today). Deleting or hand-editing the file throws that
  away and every plan falls back to the coarse snapshot windows.
- **The New Plans builder reads raw.githubusercontent.com, not jsDelivr.**
  jsDelivr answers 403 "Package size exceeded the configured limit of 50 MB"
  for uncached files from wpg-parcel-history. The app only gets away with
  jsDelivr because a browser asks for a few shards; the build reads all 470.
  The commit is still taken from `HISTORICAL_CDN` in `soda.js`.
- **Late plans.** Plans numbered below the baseline's highest ordinary plan
  (74496) were registered before the baseline and reached the City data late;
  they are flagged and drawn grey, not counted as new subdivisions.
- **Within on New Plans keeps straddling windows whole**, so with today's two
  windows even "1 year" keeps all 203 plans. It starts to cut as quarterly
  rebuilds add narrower windows (the 1-year setting from about mid-2027).
- **Button icons live in `data-icon`, not the label.** Toggles rewrite their
  own text (`Hide …`, `Loading...`, `Searching…`); an emoji in the label is lost
  on the first click. That is why Search used to lose its 🔍. Icons were added
  only where they add no line in either state at 1400 and 1024 px; the nine
  long labels have none on purpose.
- **Planning grid.** Filter fields under a toggle carry `overlay-field-wide` and
  span the row; the group grid uses `minmax(0, 1fr)` columns. Without either,
  the selects shrink to one character and the right column leaves the sidebar.
- **By-law placement for the point layer** uses Assessment Parcels
  `centroid_lat / centroid_lon`, fetched per roll and cached 30 days under the
  index's `generated` stamp; a rebuilt index refetches.

---

## Open / unverified

1. **New Plans in the quarterly job has not run on the Windows box yet.** The
   step is in `r/refresh_assets.ps1` (non-fatal) and the builder ran clean
   here; the first real run is 1 January 2027.
2. **Plan type is unknown.** A new plan may be a subdivision, a consolidation
   or a re-survey; Survey Parcels does not say which. Land Titles is the only
   source.
3. **Coverage floor.** New Plans cannot go before 2025-03-14 (the 2023 and
   early-2025 snapshots hold assessment parcels only). An assessment-roll diff
   from 2023-11-13 could extend it, but new rolls also come from condo
   registrations and roll splits, so it would need its own filtering.
4. **The Manitoba repo was not reachable from this session**, so 🔍 / 🗑️ are
   the standard choices rather than copied from it.
5. Some sidebar buttons wrap on the default label at narrow desktop widths
   regardless of icons (All Assessment Parcels, Environmentally Tracked Sites,
   Current Winnipeg Streets). Untouched.

---

## Files touched (beyond docs)

- `web/src/lib/publicNoticesLayer.js` (new), `web/src/lib/newPlans.js` (new)
- `web/scripts/build-new-plans.mjs` (new), `web/public/new-plans.geojson` (new, generated)
- `web/src/soda.js` (`fetchRezoningNoticePoints`, `fetchRollCentroids`)
- `web/src/map.js` (both layers, popups), `web/src/main.js` (toggles, filters, legends, URL state)
- `web/src/lib/urlState.js`, `web/src/dataStatusDialog.js` (New Plans row)
- `web/index.html`, `web/src/style.css`
- `r/refresh_assets.ps1` (New Plans step), `.gitignore` (ship `new-plans.geojson`)
- Tests: `test/publicNoticesLayer.test.js`, `test/newPlans.test.js` (new);
  `urlState`, `searchReset` updated. The 1997 fix touched `lib/zoningAmendments.js`
  (comment) and `lib/columnsRegistry.js` (Rezoned tooltip).

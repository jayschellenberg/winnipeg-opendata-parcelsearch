# Winnipeg Parcel Search

A free, client-only parcel-research tool for City of Winnipeg properties, built
for commercial-appraisal workflows.

**Live:** https://winnipeg-opendata-parcelsearch.vercel.app/

Search parcels by legal description (Lot / Block / Plan) or by roll number,
civic address, zoning, and dwelling-unit count; see survey lots and assessment
parcels together on a MapLibre map (street, satellite, or 7.5 cm City aerial basemaps); toggle ~15 reference overlays (citywide
zoning, traffic volumes, transit, OurWinnipeg policy areas, contaminated
sites, neighbourhoods, parcel dimensions); browse **historical as-of-date
parcels** with inferred lineage and size-change highlighting; analyse
comparable sales from SABRE exports (drop a file, paste a block, or connect a
folder as a local sales database); export results to CSV.

There is no server, database, or login. The browser queries the
[City of Winnipeg Open Data](https://data.winnipeg.ca) Socrata API live on
every search; heavier citywide overlays are cached in IndexedDB. Historical
snapshots are served from the companion
[wpg-parcel-history](https://github.com/jayschellenberg/wpg-parcel-history)
data repo via CDN.

## Quickstart

```bash
cd web
npm ci
npm run dev      # http://localhost:5173 — live data on every search
npm test         # plain-Node unit tests (no framework)
npm run build    # production bundle in web/dist
```

Deploys are automatic: every push to `main` rebuilds on Vercel
([vercel.json](vercel.json)); CI runs the test suite + a build on every push.

## Repository layout

| Path | Contents |
|---|---|
| `web/src/` | The app — `main.js` (UI wiring), `soda.js` (all SODA queries/joins), `map.js` (MapLibre layers), `lib/` (reusable modules) |
| `web/test/` | Unit tests, run by `npm test` |
| `web/scripts/` | Builders for the committed static overlays (transit GTFS, neighbourhoods) |
| `web/public/` | Static GeoJSON overlays. `parcels.pmtiles` (citywide parcel polygons, address labels, and derived dwelling-unit totals; ~96 MB) is not in git — deploys fetch it from the `parcels-pmtiles` GitHub release (see vercel.json); keep a local copy for dev. Rebuilt and republished automatically every two months (see [Data freshness](#data-freshness)). |
| `r/` | Offline R/PowerShell pipeline: scheduled Open Data downloads, provenance-stamped snapshot archive, historical shard + lineage builders, citywide-parcels + aerial-ortho PMTiles builds |
| `extras/` | Early experiments kept for reference |

## Sales Analysis

Winnipeg publishes no sales dataset, so sales always arrive from the user: a
SABRE **SoldPropertyListing** export dropped on the sales tab, a block pasted
out of SABRE or a spreadsheet, or the **SABRE sales database** — a folder of
exports connected once and cached locally.

That data is a paid subscription product, so it is never hosted or uploaded.
The database lives in IndexedDB (`wpg-parcel-sales`) behind a File System
Access directory handle, which is what lets a new export dropped into the
folder be noticed on the next visit rather than re-imported by hand. Chrome
and Edge support the handle; Firefox and Safari fall back to a manual folder
pick, which works without the auto-refresh. Its coverage is shown only in the
sales panel's own Coverage dialog — never in Data Status, which is public.

Two things about the merge are load-bearing:

- Exports are manual pulls capped near 500 records, so their date windows
  overlap and the same sale row arrives in several files. Duplicate rows are
  dropped across files by an exact full-row match (with the date cell
  normalized first — SABRE exported one month in two date formats).
- **SABRE repeats a building's area on every row rather than splitting it.**
  It writes one row per suite and puts the WHOLE building's Living Area on
  each: 397 HORACE carries 1,950 sf three times, and the City's assessment
  record says the building is 1,950 sf. Summing every row matched that record
  on 0 of the 168 multi-row sales that carry one. But 355 of 889 multi-row
  sales DO carry genuinely different areas, and those are real sections that
  must still add up — so `dedupAndGroupSales` sums the DISTINCT areas, which
  matches on 156 of 168. It also collapses SABRE's blank-`Zoning` twin rows,
  which used to report 609 sales at exactly 2.00x their true floor area and
  so halve every `$/Bldg SF`.
- Files are recognised by their **header**, not their filename, so a renamed
  export still imports and a stray CSV in the folder is ignored and counted.

**Rates.** `$/Lot SF` prices the dirt; `$/Bldg SF` prices the improvement
(Living Area from the export, else the live record — withheld on a
vacant-coded sale, since the live record describes the parcel today and
a lot that sold bare then got built on would otherwise report a
confident, fictional building rate).

The land denominator is SABRE's `Land Actual sqft` — the area at the time of
sale — falling back to the assessment record's `assessed_land_area` where
SABRE's is missing or implausibly small, and withheld entirely where neither
is usable. 41 records carry an area under 100 sf, most of them literally 1,
and they are not tiny parcels: their prices are ordinary and the roll gives
them 2,460–8,217 sf. Dividing by the placeholder printed rates up to
$615,000/sf, which left the median alone but destroyed every trend the charts
fit. A rate computed on anything other than the row's own figure is marked
with a ⚠ rather than substituted silently. Acres is derived from that same
denominator (÷ 43,560), the City publishing area in square feet only, and joins
`$/Acre` and `$/Lot` — the latter being the consideration split across
the parcels in the transaction, which is what prices a building lot in a
multi-lot deal. Every rate uses the same group-total denominator, so an
assembly is rated as one deal.

**Was a building standing?** The assessment use code describes a parcel as
it was last assessed, not as it stood the day it sold, so a comp set built on
the code alone inherits that error in both directions. Three instruments
answer, strongest first, each consulted only where the one before it said
nothing: a City **building permit** matched by address (6,238 findings), the
assessment roll's own **year built** (34), and **SABRE's** own record (27) —
which is the only one that can speak for a parcel whose roll has since been
retired, and 71 of those 72 rolls are gone from the live assessment data too.
The **Built** column names which instrument spoke, because a dated permit is
evidence about the transaction while the other two are later snapshots read
backwards.

A fourth pass holds verdicts BACK rather than making them. Where the price
works out below $50 per building square foot — the 5th percentile of ordinary
improved sales, against a $174 median — the market paid nothing for the
building, which is what a teardown is: the sale bought the lot and a
demolition bill. Those 6 sales stay in the Land set with a
`⚠ Building, priced as land` mark instead of being reclassified out of it. A
permit verdict is never overruled this way. And where the roll has been
retired and nothing can answer at all, the column reads `not verified` rather
than going blank — 73 sales, still counted as Land, but checked by nothing.

The **Charts** button opens [charts.html](web/charts.html) in a second
tab: `$/Lot SF` over time, `$/Acre` against lot size (the
size-adjustment curve), and `$/Lot` against lot size. It holds no data of its own — the app broadcasts the filtered set
over a `BroadcastChannel` and the page redraws, so the charts track the
sidebar filters live (hence Freeze). It defaults to land sales — which now
means the grid's evidence-corrected **Category**, so the two can never disagree
about what land is — and to EXCLUDING already-built sales, vacant-coded lots
that in fact carried a finished house when they changed hands. Roughly half
the vacant-coded sales in the archive are those, and they clear about 3x a
genuine lot per square foot, so leaving them in dragged every land trendline
upward. The header reports the count either way round.
A chart point is a SALE, not a grid row: a three-parcel assembly is one
transaction, and three points would triple its weight in every
trendline. The renderer is hand-rolled SVG because the CSP is
`script-src 'self'` — no CDN chart library can load.

**N1 cross-reference.** Sales carry an optional `N1 ID` column, stamped by an
offline crosswalk rather than matched in the browser (the same division of
labour the Manitoba app uses). The grid shows it and the sales tab filters
Any / Matched / Unmatched, shareable as `?n1=`. Blank is the useful state:
unmatched rows are the queue of sales still to be entered into N1. The filter
is row-level, so a multi-parcel sale matched on only some of its rolls shows
exactly the rows that still need doing. A CSV with no N1 ID column reads as
entirely unmatched, which is the truth.

## Data freshness

The **Data Status** dialog in the top bar is the in-app view of everything
below: published artifact vintages, the historical archive and its pinned
CDN revision, the aerial-ortho years, and each Socrata dataset's own
last-update stamp (fetched when the dialog opens, filled in per service so
one dead endpoint reads "unavailable" rather than blocking the rest). A
banner appears under the top bar when the citywide parcel tiles pass 90 days
— two missed bi-monthly rebuilds — and turns red past a year. It is the one
alarm that fires from the deployed app rather than the scheduler machine, so
it still works when the machine that runs the jobs is off.

Search results are always live — every search queries the Socrata API
directly. The build-time artifacts below are the parts that can age, so each
has a schedule and an alarm. All three jobs are registered by
`r/setup_schedule.ps1` and run as the logged-on user.

| Job | When | Rebuilds | Stores history? |
|---|---|---|---|
| `WpgParcelTilesBiMonthly` | 2nd of each even month, 03:00 | `parcels.pmtiles` — the Show All Parcels / Dwelling Units overlays. Fetches d4mq-wa44 live, tiles via WSL tippecanoe, publishes the release asset, commits the checksum, auto-deploys. | No |
| `WpgOpenDataSemiAnnualDownload` | Jun 1 + Dec 1, 03:00 | Downloads the `r/wpg_datasets.R` layers into the WpgSnapshots archive. | **Yes** — the only job that does |
| `WpgAssetRefreshQuarterly` | Jan/Apr/Jul/Oct 1, 03:30 | Transit + neighbourhood GeoJSON, and runs both staleness heartbeats. | No |

Tiles refresh on their own faster cadence than the snapshot archive on
purpose: the overlay should track the current roll, while history stays
sparse and deliberate.

Three independent alarms cover a job that stops running, since a failed job
emails for itself but a job that never starts cannot:

- Each job emails on failure and drops a dated `FAILED-*.txt` marker at the
  archive root.
- The quarterly job verifies the archive actually contains the most recent
  scheduled capture (Jun 1 / Dec 1, plus 21 days of grace) and that the
  published tiles are under 80 days old, emailing and writing a
  `STALE-*.txt` marker when either trips. It checks against the schedule
  rather than a fixed age so an off-cycle capture can't shrink the margin
  below one missed run.
- The quarterly job also checks the release is **servable** — that the asset
  exists, is finalised, and its SHA-256 equals the committed checksum. That
  is the only property the deploy actually tests, and it is independent of
  the age checks: on 2026-08-05 a failed publish emptied the release while
  the committed sidecar stayed perfectly fresh.
- The deployed app itself warns in the browser console when the tile sidecar
  is over 90 days old — the only signal that survives the scheduler machine
  being off entirely.
- The quarterly job also cross-checks the aerial-ortho years the app offers
  (`ORTHO_YEARS` in `web/src/map.js`) against the archives actually on R2, in
  both directions: a listed year with no archive renders a blank basemap with
  no error, and an archive nobody listed is 14–18 GB that no one can see.
- The tile rebuild emails when the City publishes a residential property-use
  code nobody has classified. Every `CN*`/`RES*` code must appear in either
  the counted set or `DWELLING_REVIEWED_EXCLUSIONS` in
  [lib_dwelling_units.R](r/lib_dwelling_units.R); anything in neither is
  reported, because an unclassified code drops its parcels from dwelling-unit
  totals with no visible symptom.

To rebuild and publish tiles by hand, **from the repository root** (the path
is relative; the script itself is working-directory independent, so a full
path works from anywhere):

```bash
powershell -ExecutionPolicy Bypass -File r\rebuild_tiles.ps1
```

Publishing never deletes the live release asset before its replacement is
uploaded and digest-verified: the new archive goes up under a staging name,
and the swap is two metadata renames ([lib_gh.ps1](r/lib_gh.ps1)). Do **not**
publish by hand with `gh release upload --clobber` — it deletes first, so a
failed upload leaves the release with no asset and every deploy silently
loses the overlay. `r/test_gh_publish.ps1` exercises the real upload, verify,
and swap against scratch asset names on the live release.

### Why the archive is served from Vercel and not object storage

Reviewed 2026-08-24, after the Manitoba sister project moved its equivalent
archive to Cloudflare R2. The answer here is different, and the numbers are
why. Re-measure before revisiting; do not port the Manitoba decision across.

`scripts/fetch-pmtiles.mjs` pulls the archive into `web/public/` during the
Vercel build, Vite copies `public/` into `dist/`, so the whole file ships in
every deploy. That sounds like the thing to fix. Measured, it mostly is not:

| | Vercel (today) | R2 public domain |
|---|---|---|
| Range request | `206`, `Accept-Ranges: bytes` | `206`, `Accept-Ranges: bytes` |
| Warm 16 KB read | **193 ms**, `X-Vercel-Cache: HIT` | 368 ms, no `Cache-Control` at all |
| Egress | billed | free |

And egress barely exists: a full session — cold load at z11, toggle the
overlay on, jump to downtown at z15 — pulled **80 KB in 7 range requests**
from the 99 MB archive. The file is big; nobody downloads it. R2's zero-egress
advantage is worth approximately nothing at this scale, and the public
`r2.dev` domain is measurably slower and sets no cache policy.

Manitoba's case was not this case. That archive is 509 MB of province-wide
parcels, past what belongs in a deploy pipeline at all. Winnipeg's is 99 MB of
one city.

Moving would also cost something Manitoba never had: the SHA-256 of the
published archive is pinned in `web/scripts/parcels.pmtiles.sha256`, committed
to git, and verified before the bytes are written — so a swapped or tampered
release asset cannot reach users. Serving straight from a bucket drops that
check unless it is rebuilt, and it would mean rebuilding the publish path that
the 2026-08-05 incident hardened.

**What would change the answer:** archive size, and it has started moving.
Lowering the tile zoom floor to z8 took the archive from 99.4 MB to
**116.5 MB**. That is still comfortably inside the 60–150 MB sanity band in
`r/build_parcel_tiles.R`, and a GitHub release asset may be up to 2 GB, so
nothing is at a limit — but the headroom is no longer generous, and the next
thing that adds a zoom level or a tile property spends it. The pinch point
when it arrives will be the GitHub publish, not Vercel, and R2 is where the
archive of record should then live.

Re-run the two measurements above at that point rather than assuming they
still hold: the session-egress number in particular is what makes Vercel the
cheaper option today, and it is a property of how people use the overlay, not
of the file.

If it ever moves: the `wpg-ortho` bucket is already reachable (the five aerial
archives live there), its origin is already in `connect-src` in
[vercel.json](vercel.json), and its CORS policy already exposes
`content-range`, which PMTiles cannot work without. One gap to fix first,
which already affects the aerial basemap: `AllowedOrigins` covers production
and `http://localhost:5173` only, so **branch previews are not allowed** and
the aerial basemap silently fails on them. Add
`https://*-jks-consulting-inc.vercel.app` in the Cloudflare dashboard under
R2 → `wpg-ortho` → Settings → CORS Policy. Note also that
`http://127.0.0.1:5173` is a different origin to CORS and is *not* allowed —
start the dev server on `localhost`.

## Documentation

- **[SESSION-HANDOFF-2026-08-22.md](SESSION-HANDOFF-2026-08-22.md)** — the
  current resume point: what the sales side is, the decisions that will
  silently regress if you change them, and what is still open. Superseded
  handoffs are archived under `.claude/`.
- **[REPLICATION_GUIDE.md](REPLICATION_GUIDE.md)** — the deep doc: full
  architecture, every solved bug, SoQL reference, and a checklist for porting
  the tool to another jurisdiction.
- **[REFACTOR_NOTES.md](REFACTOR_NOTES.md)** and
  **[WINNIPEG_PORT_KICKOFF.md](WINNIPEG_PORT_KICKOFF.md)** — imported
  reference from the Manitoba (non-Winnipeg) sister app this tool was ported
  from. They describe *that* repo's files; keep them for porting context, not
  as a map of this codebase.

## Data sources & attribution

Parcel, zoning, address, traffic, and policy-area data: City of Winnipeg Open
Data Portal, under the
[Open Government Licence – Winnipeg](https://data.winnipeg.ca/open-data-licence).
Transit overlays are derived from the Winnipeg Transit GTFS feed.
Environmentally tracked sites: Manitoba Contaminated/Impacted Sites Registry.
Basemaps © OpenStreetMap contributors / CARTO; satellite imagery © Esri and partners; aerial ortho imagery © City of Winnipeg (Open Government Licence – Winnipeg).

## Disclaimer

This is a research aid, not an authoritative record. Parcel boundaries,
dimensions, zoning, and historical lineage are derived from open data (and,
for historical layers, simplified display geometry + geometric inference) —
verify against the registered plan, certificate of title, and the zoning
by-law before relying on them.

## License

[MIT](LICENSE) © Jason Schellenberg

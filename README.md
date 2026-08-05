# Winnipeg Parcel Search

A free, client-only parcel-research tool for City of Winnipeg properties, built
for commercial-appraisal workflows.

**Live:** https://winnipeg-opendata-parcelsearch.vercel.app/

Search parcels by legal description (Lot / Block / Plan) or by roll number,
civic address, zoning, and dwelling-unit count; see survey lots and assessment
parcels together on a MapLibre map (street, satellite, or 7.5 cm City aerial basemaps); toggle ~15 reference overlays (citywide
zoning, traffic volumes, transit, OurWinnipeg policy areas, contaminated
sites, neighbourhoods, parcel dimensions); browse **historical as-of-date
parcels** with inferred lineage and size-change highlighting; upload a sales
CSV for comparable-sales analysis; export results to CSV.

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

## Data freshness

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
- The tile rebuild emails when the City publishes a residential property-use
  code nobody has classified. Every `CN*`/`RES*` code must appear in either
  the counted set or `DWELLING_REVIEWED_EXCLUSIONS` in
  [lib_dwelling_units.R](r/lib_dwelling_units.R); anything in neither is
  reported, because an unclassified code drops its parcels from dwelling-unit
  totals with no visible symptom.

To rebuild and publish tiles by hand:

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

## Documentation

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

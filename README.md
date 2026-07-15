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
| `web/public/` | Static GeoJSON overlays. `parcels.pmtiles` (citywide parcel polygons, address labels, and derived dwelling-unit totals; ~96 MB) is not in git — deploys fetch it from the `parcels-pmtiles` GitHub release (see vercel.json); keep a local copy for dev. Publish a rebuild with `gh release upload parcels-pmtiles web/public/parcels.pmtiles --clobber`, then refresh the tracked SHA-256 checksum. |
| `r/` | Offline R/PowerShell pipeline: scheduled Open Data downloads, provenance-stamped snapshot archive, historical shard + lineage builders, citywide-parcels + aerial-ortho PMTiles builds |
| `extras/` | Early experiments kept for reference |

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

# Zoning amendments — source notes (2026-09-14)

Research notes behind the Zoning Changes pill. **Built 2026-09-14**: the
"Recommended shape" below is what shipped — `r/build_zoning_amendments.R`
(DMIS scrape, three-tier placement, `web/public/zoning-amendments.json`),
`web/src/lib/zoningAmendments.js` (merge with live Public Notices), the
Off / Show / Filter pill under Planning, the Rezoned grid column, the
popup block, and the two lists under the pill for what could not be
mapped. See REPLICATION_GUIDE §8.7.2. The source findings below stand.

## What exists

- **Zoning By-law Parcels `dxrp-w6re`** (18,521 rows, weekly). Fields are
  only id, zoning, short/long description, geometry, map colour. No
  amending by-law, no effective date. Its description still cites the
  Downtown By-law 100/2004. Cannot yield "amended since" on its own; only
  a diff between snapshots you archive yourself (the historical overlay's
  whole-city zoning captures start 2026-07-01).
- **Public Notices `gnxp-9hpt`** (6,097 rows, daily, Nov 2015 to now;
  roll_number keyed). notice_type counts: VARIANCE 4,164; CONDITIONAL USE
  1,279; APPEAL 635; REZONING 11; SUBDIVISION AND REZONING 5; ZONING
  AGREEMENT AMENDMENT 3. Rezoning rows only appear from 2025 onward and
  mostly at the "Approved for Posters" (notice) stage, with a
  dmis_decision URL to follow for the by-law number. Good for pending /
  recent rezonings, useless for history. Joins to Assessment Parcels on
  roll_number.
- **DMIS amending by-law list** —
  `https://dmis.winnipeg.ca/ByLaws?Status=Amending&Category=Land%20Development&Classification=All&ViewAll=true`
  returns every Land Development amending by-law from 1997 (well over 100
  rows) as HTML: subject ("Rezoning: 3021 Pembina Highway (Riel)",
  "Zoning Change: 1010 Logan Avenue (LSWK)", "Plan of Subdivision and
  Rezoning: 1266, 1300, 1330 and 1350 Dugald Road (EKT)"), by-law number,
  status, category. The record page (`/ViewByLaw?bylawId=NNNN`) adds Date
  Passed, Effective Date, File Number (DAZ nnn/yyyy), Amends. Addresses
  are free text, multi-address lists happen, no legal descriptions, and
  some are "0 Chester Street (City-owned lands south of 4 Chester)". No
  JSON/CSV/RSS; no text-search parameter found.
- **Council / EPC decisions** are per-hearing PDFs in DMIS; the older
  clkapps.winnipeg.ca ViewPdf links are dying. Not structured.
- **Zoning By-law pages**: legacy.winnipeg.ca/ppd/zoning/default.stm is a
  404; Bylaws.stm redirects to winnipeg.ca/node/25234, which links only
  the two consolidated by-laws. The consolidation PDF
  (`dmis.winnipeg.ca/DownloadByLawDocument/9111/C/2006.200.cons.pdf`,
  "Consolidation update May 28, 2026") exceeded the fetch limit, so it is
  UNVERIFIED whether its amendment table lists site-specific map
  amendments or only text amendments (Winnipeg consolidations have
  historically listed text amendments only).
- **Detailed Development Permit Data `w842-cdeb`**: permit_type is only
  Development Permits / Mobile Signs / Residential Home Occupations — no
  DAZ or variance types. Catalog searches for by-law, rezoning,
  amendment, DMIS, DAZ, council found nothing else.

## Recommended shape (if built)

Offline build step, not client-side:

1. Scrape the DMIS amending Land Development list once (title, number),
   then each ViewByLaw page (date passed, effective date, DAZ file).
2. Geocode the address strings against Civic Addresses `cam2-ii3u` to
   roll numbers; keep the unresolved titles in a review list.
3. Emit a small static JSON `{ roll: [{ bylaw, date, daz }] }` under
   web/public, refreshed periodically (the R scheduled-download pattern).
4. Supplement live with a SoQL call on `gnxp-9hpt` where notice_type in
   ('REZONING', 'SUBDIVISION AND REZONING', 'ZONING AGREEMENT
   AMENDMENT'), keyed by roll_number, for pending and recent rezonings.
5. Present as the Manitoba "Zoning/Dev Plan Changes" pill: Off / Show
   (amber highlight + by-law in the popup) / Filter (cut the grid).

Expect partial coverage: multi-parcel plans of subdivision and
unaddressed lands will not resolve, and nothing gives the pre-1997 or
by-legal-description picture. If the only need is "changed since date
X", periodic snapshots of `dxrp-w6re` (id + zoning) diffed against a
baseline are the most reliable signal, but the baseline has to start
now.

## Follow-ups (2026-11-04)

- The same index now also draws as points: **Public Notices & Rezonings**
  (one point per by-law at its parcels' centroid, plus live rezoning-type
  notices), with Show / Within / Parcels filters. REPLICATION_GUIDE §8.7.3.
- Coverage starts in **1997**, not 2001 as first written: the DMIS list
  returns by-laws passed from 1997 on (11 that year). The pill tooltip, the
  Rezoned column tooltip and §8.7.2 were corrected.
- **Plain subdivisions are not in DMIS.** Of the ~850 amending by-laws only
  2 are "Plan of Subdivision" without a rezoning, and Public Notices has no
  plain-subdivision type. Completed subdivisions are instead dated by
  diffing survey plan numbers between snapshots: the **New Plans** layer,
  REPLICATION_GUIDE §8.7.4. It reaches back only to the oldest archived
  survey snapshot (2025-03-14).
- Public Notices ties each notice to **one roll** even when it covers many
  lots ("136, 140 … 172 Pathfinder Trail", "Prairie Pointe Stage 11"), so a
  notice has no usable parcel count.

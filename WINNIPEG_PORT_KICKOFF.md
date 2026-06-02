# Winnipeg Port — Claude Code Kickoff Prompt

Drop this whole document into a fresh Claude Code session opened in
`D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch\`. It's self-contained —
the agent should not need to read anything in `MBOpenData/` to do the
work. (REFACTOR_NOTES.md must be copied into the Winnipeg repo first;
see "Setup" below.)

---

## Setup (do once, outside the session)

```cmd
copy "D:\Dropbox\ClaudeCode\MBOpenData\WebSearch\REFACTOR_NOTES.md" ^
     "D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch\REFACTOR_NOTES.md"
```

Then open Claude Code in `D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch\`
and paste the prompt below.

---

## The prompt

I want to port the eight-phase UI/UX refactor from my Manitoba sister
app to this Winnipeg parcel-search app. `REFACTOR_NOTES.md` (just
dropped into this repo at the root) is the authoritative porting
guide — read it end to end before touching anything.

The Manitoba sibling is live at `manitoba-opendata-parcelsearch.vercel.app`
— that's the visual target. Look at it in a browser if you can, or
ask me to send screenshots.

---

### Stack differences from REFACTOR_NOTES

This Winnipeg app:
- Uses **Socrata SODA** (`web/src/soda.js`) to fetch parcel + zoning
  data, not ArcGIS REST. Endpoints, field names, and pagination
  conventions differ. Treat the original `web/src/arcgis.js`
  references in REFACTOR_NOTES as shape, not text.
- Has **no MAO scrape**, no `r/build_*_index.R`, no `monthly-refresh.bat`,
  no `dashboard/`, no `schedule_monthly.ps1`, no staleness banner,
  no cadence config. Skip every one of those sections of
  REFACTOR_NOTES verbatim; do not create equivalents.
- Has **no Sales Analysis tab** in the same form as Manitoba yet.
  Apply the Property Search refactor patterns first; Sales is a
  separate discussion after Phase 8 lands.
- Is a **separate git repository** (not a sibling of Manitoba and
  not a worktree of it). Use a feature branch in this repo:
  `claude/ui-refactor`. Don't touch `main` until I sign off.

---

### Working rules — same as the original Manitoba refactor

1. **One phase at a time.** Stop and ask for go-ahead between phases.
2. **Commit per phase.** Commit message: `Phase N: <short description>`,
   matching the format used in the Manitoba repo's git log.
3. **No regressions.** Each phase must leave `npm run build` clean,
   `npm test` passing (if there are tests), and the dev server
   rendering the page without console errors. Test in a browser
   before claiming a phase done.
4. **Ask before deviating** from REFACTOR_NOTES. If a Manitoba pattern
   doesn't fit Winnipeg (different field name, different layer, etc.),
   surface it as a question, don't quietly adapt.
5. **Don't touch Winnipeg-specific code** without confirming. That
   includes:
   - `web/src/soda.js` endpoints, fields, query parameters
   - Zoning by-law field names
   - Anything in `r/`
   - The `extras/` directory
   - `vercel.json`
   - The `gpkg` / `pmtiles` / `csv` data files at the repo root
6. **Preserve element IDs and DOM hooks** so existing JS continues
   to drive the same handlers (same rule as the Manitoba refactor —
   see REFACTOR_NOTES §1 "What was preserved").
7. **Plain JS, no React, no JSX, no TypeScript.** Vite + ES modules,
   same as today.
8. **en-CA locale** for all formatters (dates, numbers, currency).
9. **No new npm dependencies** without asking. The Manitoba app
   added Tailwind v4 via `@tailwindcss/vite`; bring the same
   plugin in if it's not already, but flag any other new dep.
10. **Don't write documentation files** unless I ask. Comments
    inside code should explain non-obvious "why", not "what".

---

### Pre-flight checklist (do this first, before Phase 1)

1. Read `REFACTOR_NOTES.md` end to end.
2. Read these files in this repo, in this order:
   - `web/index.html`
   - `web/src/main.js`
   - `web/src/map.js`
   - `web/src/soda.js`
   - `web/src/style.css`
   - `web/package.json` + `web/vite.config.js`
   - `README.md`, `REPLICATION_GUIDE.md`
3. Run `npm install` in `web/` if `node_modules` looks stale.
4. Run `npm run build`. Confirm it succeeds. Report any warnings.
5. Run `npm run dev` and walk through the existing app in a browser.
   Note any obvious bugs or DOM hooks I should preserve.
6. **Tell me, in one message, before you create the branch:**
   - Which Manitoba phases port cleanly (Phase X, Y, …)
   - Which need Winnipeg-specific adaptation, and what the
     adaptation is (Phase Z needs <X> because <reason>)
   - Anything in REFACTOR_NOTES that **doesn't apply at all**
     (skip it, don't simulate it)
   - Element IDs / globals from current Winnipeg code that you'll
     keep untouched to avoid breaking handlers
   - Open questions you need me to answer before Phase 1
7. **Wait for my go-ahead.** Don't start Phase 1 until I confirm
   your divergence plan.

---

### Phase plan (from REFACTOR_NOTES §5, adapted)

Run these in order. Each is one commit. Stop after each for review.

1. **Phase 1** — Tailwind v4 + design tokens. Install plugin if
   needed; add `web/src/lib/tailwind.css` with the `@theme` block;
   confirm a single Tailwind class on `<body>` renders correctly.
2. **Phase 2** — Sticky topbar with Data sources `<details>`
   panel. Replace the current Winnipeg header. List Winnipeg
   open-data sources in the panel (City of Winnipeg Open Data
   portal, Open Source Data Portal, etc.) — ask me if unsure.
3. **Phase 3** — App shell. Sticky sidebar 25% / min 320 px, flowing
   workspace, map capped at `min(1280px, 100%)` with 16:9 aspect
   ratio, table inside `.table-scroll` with sticky `<thead>`.
4. **Phase 4** — Sidebar tabs: Property Search (default). Map
   Layers always visible below the active tab, **not** inside a
   tab. (Sales Analysis tab is deferred — don't add it.)
5. **Phase 5** — Hand-rolled UI primitives, in this order: chip
   input, info-icon popovers, dropzone (likely unused without
   Sales), column-visibility gear with presets, parcel-summary
   card with verify-this checklist, results status bar, empty state.
6. **Phase 6** — Map interactions: zoom-to-muni on selection
   (adapt for Winnipeg neighbourhoods or wards), basemap toggle
   defaulting to Streets with explicit `layout.visibility` on
   every layer.
7. **Phase 7** — Sales-CSV upload + zoning enrichment deferral.
   **Defer this phase.** Confirm with me how Winnipeg handles
   sales data before doing anything here.
8. **Phase 8** — Reusable module extraction into `web/src/lib/`:
   `chipInput.js`, `columns.js`, `format.js`, `infoIcon.js`,
   `layout.js`, `tabs.js`, `urlState.js`, `tailwind.css`. Update
   imports in `main.js`. Add `web/test/urlState.test.js` with the
   plain-node test runner — port the 37 tests from Manitoba and
   adjust any Winnipeg-specific URL-state fields.

---

### Out of scope (skip these entirely)

- **MAO scrape pipeline** — no `r/build_*_index.R`, no manifest,
  no per-muni JSON shards, no `mao-scrape/` references.
- **Monthly refresh + Task Scheduler** — no `monthly-refresh.bat`,
  no `schedule_monthly.ps1`.
- **Local dashboard** — no `dashboard/` directory, no
  `start-dashboard.bat`, no SSE-based progress streaming.
- **Cadence configuration** — no `rescrape_cadence` column, no
  `scripts/cadence.R`, no cadence-aware delta logic.
- **Staleness banner** — Winnipeg's data freshness story is
  different; don't add the amber/red banner.
- **Sales Analysis tab** — deferred until after Phase 8.
- **Vacant-land filtering** — deferred (lives in Sales Analysis).

---

### Acceptance per phase

Before claiming a phase complete:

- `npm run build` succeeds with no new warnings.
- `npm test` (if defined) passes.
- `npm run dev` renders the page; no console errors; the feature
  added in that phase visibly works in a browser.
- Git working tree is clean apart from intentional new files.
- Commit message follows the `Phase N: <description>` pattern.
- A short note to me describing what changed, what you tested,
  and anything you noticed but did **not** fix.

---

### Open questions to surface in your pre-flight report

Don't guess at these — ask me:

1. Winnipeg parcel identifier conventions: Roll Number? PIN?
   Property Number? Use whatever `soda.js` already keys on.
2. Brand colours: keep slate-navy / accent-blue from the
   Manitoba app, or does Winnipeg have its own palette?
3. Topbar "Data sources" panel — which Winnipeg open-data
   endpoints should I list? (Confirm with me before writing
   labels.)
4. Map layer naming — Manitoba uses "Parcel boundaries / Roll
   Layer", "Development plan / Dev Plan", etc. What's the
   Winnipeg equivalent? (Likely: "Assessment parcels", "Zoning",
   "Neighbourhood boundaries" — confirm.)
5. Default municipality / view: Manitoba defaults to province-wide
   bounds. Winnipeg presumably defaults to city bounds — confirm
   the centroid + initial zoom.
6. Sales workflow: Winnipeg doesn't seem to have a Sales Analysis
   tab today. Is there a sales data source I should know about,
   or is this strictly a parcel-lookup tool?

---

### When in doubt

Stop, ask, propose. Don't refactor things outside the phase
you're on. Don't add features the Manitoba app doesn't have.
Don't remove features the Winnipeg app already has without
confirming.

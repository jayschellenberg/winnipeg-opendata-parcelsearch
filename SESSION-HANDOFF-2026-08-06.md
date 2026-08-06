# Session handoff — 2026-08-06

Resume point for a fresh thread on the **Winnipeg Parcel Search** repo
(`D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`). Live at
https://winnipeg-opendata-parcelsearch.vercel.app/ ; every push to `main`
auto-deploys via Vercel.

Working tree is CLEAN and everything below is pushed. HEAD `2037253`
(13 commits this session, from `6c6fa0c`).

Read this first, then the auto-memory. This file **supersedes**
`SESSION-HANDOFF-2026-08-05.md` and `SESSION-HANDOFF-2026-07-13.md`, both
of which were deleted — 08-05 is still in git history if you need it. Both
had become actively misleading, which is why they were not just left to
sit: the 07-13 file's resume point (aerial 2018/2016) had been finished
for weeks, and the 08-05 file described the sales-panel work as "not
started" when most of it had shipped. Reading it cost real time this
session and produced a wrong answer to Jason.

---

## ⏸ THE ACTIVE RESUME POINT — pick one

Nothing is half-finished. Three candidates, in the order I would take them:

1. **Sales-panel parity — the remaining five controls.** See the verified
   inventory below. This is the only *feature* work outstanding; everything
   else this session was reliability. Jason's original question — "start
   with Number parcels, or sweep the quick filters first?" — is moot:
   Number parcels shipped (`6817ab6`).
2. **Historical shards for the 2026-08-06 capture.** A new snapshot was
   archived today, but the app still serves shards from the 2026-07-01
   capture. See "Open / parked".
3. **Browser QA that needs Jason's real browser** (auto-memory
   `wpg-open-todos` item 4). The in-app pane cannot render MapLibre.

---

## Sales-panel parity — VERIFIED inventory (2026-08-06)

Checked against the live control ids in `web/index.html`, not against the
commit subjects. The 08-05 handoff's list is out of date; use this one.

**Shipped** — `numbering-toggle` (Number parcels), `sales-price-low/high`,
`sales-size-low/high`, `sales-street-name`, `sales-clear`, `zoning-filter`
popover. Plus Winnipeg-only additions with no MB equivalent:
`pucs-filter`, `class-filter`, `recent-uploads`, `sales-hide-sentinels`,
`subject-roll`.

**Still absent, from MB's 29-control inventory:**

| MB control | Winnipeg today |
|---|---|
| date presets (6/12/24/36/48 mo + ×) | raw `sales-date-from` / `sales-date-to` only |
| `sale-asmt-max` (Sale/Asmt ratio cap) | — |
| `vacant-improved` + `vacant-threshold` | — |
| `legend-toggle` ("include legend in map image") | — (`static-map-btn` exists) |
| `far-flung-km` + `far-flung-exclude` | — (subject roll + Dist km column exist, so this is a filter over existing machinery) |

**DO NOT re-add the $/Lot SF range.** `sales-ppsf-low/high` was added in
`23ebd62` and then deliberately REMOVED in `6741015`, along with its
helpers and tests. It reads like an oversight in the id list; it is not.
Ask before restoring it.

---

## Shipped this session (all on `main`, deployed)

The whole session was one thread: **find property data that goes stale
silently, and make it impossible for that to be silent.** Newest first.

| Commit | What |
|---|---|
| `2037253` | Rebuilt assets stop churning on a build timestamp alone |
| `c62d313` | Aerial-ortho years cross-checked against R2 |
| `92616df` | Compensator covered by a test; fetch-pmtiles retries + verifies |
| `8fd6824` | Alert emails quote an ABSOLUTE re-run command |
| `f04af5d` | **Publish never deletes the live asset before the replacement is verified** |
| `4f9ab41` `c43e563` | RESMB/RESRM counted as dwellings; tiles republished |
| `59f3575` | An empty citywide overlay is a failure, and is never cached |
| `8e225cf` | PUCS drift surfaced; snapshot heartbeat made schedule-aware |
| `b4dbaa0` `c093420` | **Citywide parcel tiles rebuild automatically every 2 months** |

### New files

- `r/rebuild_tiles.ps1` — the bi-monthly job itself
- `r/lib_gh.ps1` + `r/test_gh_publish.ps1` — publish primitives; 73 assertions
  driven against the REAL release using scratch asset names
- `r/lib_ortho.ps1` + `r/test_ortho.ps1` — ortho year cross-check (24)
- `r/lib_tippecanoe.R` + `r/test_tippecanoe.R` — tippecanoe invocation, with a
  live two-feature build proving the WSL dispatch
- `web/scripts/stableWrite.mjs` + `web/test/stableWrite.test.js` (9)

---

## The three scheduled jobs — ALL now proven end to end

Registered by `r/setup_schedule.ps1`. Every one has now actually run;
before this session, two had never fired unattended and one did not exist.

| Task | When | Proven |
|---|---|---|
| `WpgParcelTilesBiMonthly` | even months, 2nd, 03:00 | Jason ran it 2026-08-05, 19 min, clean. Next **Oct 2** |
| `WpgAssetRefreshQuarterly` | Jan/Apr/Jul/Oct 1, 03:30 | Manual run 2026-08-06, all 4 checks passed. Next **Oct 1** |
| `WpgOpenDataSemiAnnualDownload` | Jun 1 + Dec 1, 03:00 | Manual run 2026-08-06, 10.5 min, 10 datasets. Next **Dec 1** |

Task Scheduler's own `LastRun` still reads never for two of them, because
the manual runs invoked the scripts directly rather than through
`schtasks /Run`. The pipelines are proven; the scheduler's trigger record
is not. The scheduler *context* was probed separately (`wsl`, keyring
`gh`, `Start-Process` redirection, hardlinks all work from `system32`).

**Five alarms now exist where there were two:** per-job failure email +
`FAILED-*.txt` marker; snapshot-age (schedule-aware); tile-age (80 days);
release liveness (is the asset actually servable?); ortho year
cross-check; PUCS drift. Plus a browser-console warning from the deployed
app when the tile sidecar is >90 days old — the only signal that survives
this machine being off.

---

## Decisions that will silently regress if you don't know them

Carrying forward the 08-05 list (water tokens, `_waterLoaded`, column
classes, `ASSESS_SELECT`, instrument-defines-a-sale, sworn value, cluster
geometry, shape filters, ISO dates) — all still true. New today:

1. **NEVER publish the release asset with `gh release upload --clobber`.**
   It deletes the existing asset *before* uploading; gh's own help says
   "if the upload fails, the original assets will be lost." A 502 on that
   DELETE on 2026-08-05 left the release with ZERO assets, which would
   have disabled the overlay on every deploy. `r/lib_gh.ps1` uploads under
   a staging name and swaps by metadata rename. Retrying `--clobber` is
   *worse*, not better — every attempt restarts from an empty release.
2. **Revert the committed checksum if and only if the new archive is NOT
   live** (`$script:newArchiveIsLive`). Reverting after a good upload pins
   the OLD hash against NEW bytes, which fails on EVERY future deploy — a
   transient blip turned permanent.
3. **Decide from a re-read, never from an exit code.** gh returning
   non-zero does not mean the mutation did not happen. Everything
   post-mutation goes through `Get-CanonicalState`. The first draft of the
   fix got this wrong at the one call that mattered and an adversarial
   review caught it.
4. **"Unknown" is a third outcome.** If the release cannot be read, mutate
   nothing. Never fold it into "the publish failed".
5. **Every `CN*`/`RES*` property-use code must be classified** — counted in
   `DWELLING_ALL_PUCS` or listed in `DWELLING_REVIEWED_EXCLUSIONS` with a
   reason. Anything in neither is emailed as drift. Currently 19 counted,
   6 excluded, 0 unreviewed. RESMB + RESRM were added 2026-08-06 on
   Jason's call (+719 dwelling units); RESGC and CNCST excluded.
6. **`generated_at` means "when the DATA last changed"**, not "when the
   builder last ran". `writeStable()` skips the write otherwise. Do not
   "fix" this back.
7. **`.ps1` files must stay 7-bit ASCII.** PS 5.1 reads a BOM-less `.ps1`
   as ANSI, and an em-dash inside a string literal decodes to a smart
   quote that terminates the string. `build_ortho_tiles.ps1` was
   *completely unparseable* under 5.1 for this reason until today.

---

## Environment gotchas that cost real time

Still true from 08-05: the in-app Browser pane cannot render this map (use
Claude in Chrome); `getBoundingClientRect` lies about
`content-visibility` content; Vercel occasionally 500s on push; Bash here
is Git Bash, so PowerShell here-strings fail — use a heredoc and
`git commit -F -`. New today:

- **Run scripts by ABSOLUTE path.** `-File r\rebuild_tiles.ps1` only
  resolves from the repo root. Alert emails now quote the absolute form.
- **`r2.dev` does not answer HEAD usefully.** Every existing ortho archive
  errored on HEAD while missing ones cleanly 404'd — a HEAD-based check
  reports live years as broken. Use a ranged GET.
- **`return ,$array` in PowerShell unrolls differently depending on the
  call site** — inline it yields a 1-element array that stringifies to
  `System.Object[]`. Return an object instead.
- **Do not capture a native command's stderr with PowerShell's `2>&1`** if
  you intend to parse it; it becomes a `NativeCommandError`. Use
  `cmd /c "... 2>&1"` or `Start-Process` with redirect-to-file.
- The tile rebuild is **byte-for-byte reproducible** — two builds hours
  apart from unchanged source produced an identical sha256, so a re-run
  after a failure is free and cannot perturb the published bytes.

---

## Open / parked

- **Historical shards for 2026-08-06.** The capture is archived; the app
  still pins `eca2c00` (2026-07-01 data). Run the 6-step pipeline in
  `r/scheduled_download.ps1`'s reminder, then bump `HISTORICAL_CDN` in
  `web/src/soda.js`. The in-app staleness check warns in the console if
  the pin falls behind branch HEAD.
- **Sales-panel parity** — the five controls above.
- **Deliberately skipped, with reasons on record:** content-addressed
  asset names + pointer JSON (would also fix "redeploying an old commit
  loses the overlay", but changes the deploy-critical consumer to prevent
  something that has never happened); a single-instance mutex on the
  rebuild; three nit-level review findings (a metadata failure re-uploads
  96 MB rather than resuming; the preflight RECOVERED email sends before
  its confirming re-read; `Restore-TrackedFiles` logs a misleading reason
  if `Fail()` runs before preflight sets the flags).
- **Water tokens need no drift check** — all 16 verified present
  2026-08-05. Truro Creek is still flagged on zero parcels.
- `ORTHO_YEARS` stays a hand-maintained literal (runtime discovery would
  add five R2 fetches to map startup, which is already the slow part); the
  quarterly job verifies it instead.
- Older parked items remain in auto-memory `wpg-open-todos`.

## Working style (Jason)

Direct/technical, no preamble. Commit + push when he says (main = deploy).
Concrete numbers over hand-waving; verify by execution against real data,
not fixtures. He will interrupt mid-task to redirect — finish the
in-flight piece, then take the new one.

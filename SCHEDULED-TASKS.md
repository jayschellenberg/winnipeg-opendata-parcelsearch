# Scheduled tasks — WpgOpenData\ParcelSearch

Three Windows Task Scheduler tasks keep the Winnipeg parcel-search site's data and tiles
current. Live settings verified against Task Scheduler on 2026-09-20.

Fast path for a rebuilt PC: `D:\Dropbox\ClaudeCode\_scheduled-tasks\restore-all.ps1`.
Master index: `D:\Dropbox\ClaudeCode\SCHEDULED-TASKS.md`. Broader setup is in `README.md`.

## Prerequisites on a new PC

- **Folder at the same path:** `D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`, a git clone on branch `main` with push credentials for `origin` (Vercel deploys from `main`).
- **Windows PowerShell 5.1**; scripts are ASCII-only for that reason.
- **R** on PATH or at `C:\Program Files\R\R-4.6.1\bin\Rscript.exe` (pinned fallback), packages digest dplyr httr2 jsonlite sf xml2.
- **WSL** with `tippecanoe` installed inside the distro (`wsl tippecanoe --version` must work).
- **gh CLI** authenticated with push and release rights on `jayschellenberg/winnipeg-opendata-parcelsearch` (release tag `parcels-pmtiles`).
- **rclone** on PATH with remote `r2` configured (Cloudflare R2 bucket `wpg-ortho`).
- **Folders:** staging `D:\wpg-tile-staging` (same volume, outside Dropbox) and archive `D:\Dropbox\Appraisal\Web\WpgSnapshots`.
- **Email credential:** a Windows Credential Manager generic credential named `WpgScheduleMail` (username = Gmail address, password = Gmail app password) plus the `CredentialManager` PowerShell module installed under 5.1 (`Install-Module CredentialManager -Scope CurrentUser -Force`). Setup steps are in the header of `r\lib_mail.ps1`. This is a different alert path from the MBOpenData projects.
- **ntfy topics:** `wpgps-parcel-tiles-jks`, `wpgps-asset-refresh-jks`, `wpgps-semiannual-download-jks`.
- Optional env: `SODA_APP_TOKEN` (Socrata rate limits), `WPG_KEEP_MIN_MONTHS`, `WPG_ONLY`.

## The tasks

| Task | Schedule | Runs |
|---|---|---|
| WpgOpenDataSemiAnnualDownload | 1 Jun and 1 Dec 03:00 | `r\scheduled_download.ps1` |
| WpgAssetRefreshQuarterly | 1 Jan, Apr, Jul, Oct 03:30 | `r\refresh_assets.ps1` |
| WpgParcelTilesBiMonthly | 2 Feb, Apr, Jun, Aug, Oct, Dec 03:00 | `r\rebuild_tiles.ps1` |

All three: `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <script>`,
no working directory, LogonType S4U, RunLevel Limited, 6 h limit, StartWhenAvailable,
**WakeToRun on**, restart twice at 30 min intervals, not allowed on battery.

## Recreate

One registrar creates all three with `schtasks /Create ... /F` and then `Set-ScheduledTask`
for settings and the S4U principal. Run it from an **elevated** prompt; an unelevated run
downgrades the tasks to Interactive and the verdict block says so.

```powershell
cd D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch
powershell -ExecutionPolicy Bypass -File r\setup_schedule.ps1
Get-ScheduledTask -TaskName 'Wpg*' | Select TaskName, @{n='Logon';e={$_.Principal.LogonType}}
```

Then prove the alert path and gh from an S4U context (elevated prompt):
`powershell -ExecutionPolicy Bypass -File r\test_s4u_alert.ps1`. An interactive
`r\refresh_assets.ps1 -TestAlert` only proves the wiring for a logged-on session.

## Per-task notes

**WpgOpenDataSemiAnnualDownload.** Downloads every layer in `r\wpg_datasets.R` via
paginated SODA and archives it with provenance into WpgSnapshots. The only job that stores
history. Ends by emailing a "shard rebuild pending" reminder for the manual
`build_historical_shards.R` then `verify_shards.R` steps. Has not fired since the
2026-08-24 re-registration; next is 2026-12-01.

**WpgAssetRefreshQuarterly.** Heartbeats (all three tasks still S4U, newest snapshot
covers the last capture, tiles under 80 days old, release asset SHA matches `origin/main`,
ortho years vs R2), then regenerates transit and neighbourhood GeoJSON and pushes if
changed. Delete the `git push` line for commit-only.

**WpgParcelTilesBiMonthly.** Fetches parcels live, tiles via WSL tippecanoe, publishes to
the GitHub release with a staged swap, copies to R2 and verifies size, pushes the meta and
sha files. Day 2 so it never contends with the 1 June / 1 December download. Preflight
fails fast if Rscript, tippecanoe, gh or rclone is missing.

## Alerting

Each script calls `Send-FailureMail` (email via the `WpgScheduleMail` credential plus ntfy)
and drops a `FAILED-*.txt` or `STALE-*.txt` marker in the archive folder.

**Verified under S4U on 2026-09-21:** email, ntfy and `gh auth status` all succeeded from
a temporary S4U task (`r\test_s4u_alert.ps1`, which runs `r\s4u_probe.ps1`). Re-run that
script from an elevated prompt after any rebuild, password change, or gh re-login; it
creates a throwaway task, runs the alert test and gh check inside it, prints a verdict and
deletes the task. Nothing else runs.

## Known drift

None between registrar and live tasks.

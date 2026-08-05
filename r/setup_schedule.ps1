# setup_schedule.ps1
#
# Register (or update) the three scheduled jobs in Windows Task Scheduler. All
# run in the current user's context (so they run when you're logged on). Re-run
# this script any time to update them - it re-applies the full hardened
# settings, so re-registration never regresses them.
#
#   powershell -ExecutionPolicy Bypass -File r\setup_schedule.ps1
#
#   1) WpgOpenDataSemiAnnualDownload  (Jun 1 + Dec 1, 03:00)
#        Downloads the City Open Data layers in r/wpg_datasets.R (parcels /
#        zoning / addresses + OurWinnipeg dev-plan areas) and archives them
#        into WpgSnapshots. This is the ONLY job that stores history.
#        -> r/scheduled_download.ps1
#
#   2) WpgAssetRefreshQuarterly       (Jan/Apr/Jul/Oct 1, 03:30)
#        Snapshot-age + tile-age heartbeats, and regenerates the app's static
#        transit + neighbourhood GeoJSON; if they changed, commits + pushes to
#        main (Vercel AUTO-DEPLOYS).
#        -> r/refresh_assets.ps1
#
#   3) WpgParcelTilesBiMonthly        (Feb/Apr/Jun/Aug/Oct/Dec 2nd, 03:00)
#        Rebuilds + publishes the citywide parcels PMTiles archive and
#        AUTO-DEPLOYS. Stores no history - it fetches d4mq-wa44 live, tiles
#        it, and deletes the intermediates.
#        -> r/rebuild_tiles.ps1
#
#        Why the 2nd and not the 1st: Jun/Dec overlap with the snapshot
#        download, and running a day later keeps two heavy paged fetches of
#        the same Socrata dataset from contending. It also means the Jun/Dec
#        tile builds sit one day after the archived capture, so the published
#        tiles and the newest snapshot agree at those points.
#
# Hardening applied to both (audit F5 follow-up - schtasks /Create alone
# CANNOT set these, and /F re-creation resets them to defaults, which is how
# the June 2026 download got silently missed):
#   - StartWhenAvailable : run ASAP after a missed start (machine off/asleep)
#   - WakeToRun          : wake from sleep for the trigger
#   - RestartCount 2 / RestartInterval 30 min : retry a failed run twice
#   - ExecutionTimeLimit 6 h
#
# Notes:
#  - Runs as the logged-on user (no stored password). A start missed while
#    logged out fires at the next logon (StartWhenAvailable).
#  - Run one now:   schtasks /Run /TN WpgOpenDataSemiAnnualDownload
#  - Remove one:    schtasks /Delete /TN WpgAssetRefreshQuarterly /F

$rdir = 'D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch\r'

function Register-WpgTask($name, $script, $months, $time, $day = 1) {
  $run = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
  schtasks /Create /TN $name /TR $run /SC MONTHLY /M $months /D $day /ST $time /F
  # schtasks cannot express these; re-apply them on every (re-)registration.
  $t = Get-ScheduledTask -TaskName $name
  $s = $t.Settings
  $s.StartWhenAvailable = $true
  $s.WakeToRun          = $true
  $s.RestartCount       = 2
  $s.RestartInterval    = 'PT30M'
  $s.ExecutionTimeLimit = 'PT6H'
  Set-ScheduledTask -TaskName $name -Settings $s | Out-Null
  $v = (Get-ScheduledTask -TaskName $name).Settings
  Write-Output ("  hardened {0}: StartWhenAvailable={1} WakeToRun={2} Restart={3}x{4} Limit={5}" -f
    $name, $v.StartWhenAvailable, $v.WakeToRun, $v.RestartCount, $v.RestartInterval, $v.ExecutionTimeLimit)
}

Register-WpgTask 'WpgOpenDataSemiAnnualDownload' (Join-Path $rdir 'scheduled_download.ps1') 'JUN,DEC'                  '03:00'
Register-WpgTask 'WpgAssetRefreshQuarterly'      (Join-Path $rdir 'refresh_assets.ps1')      'JAN,APR,JUL,OCT'          '03:30'
Register-WpgTask 'WpgParcelTilesBiMonthly'       (Join-Path $rdir 'rebuild_tiles.ps1')       'FEB,APR,JUN,AUG,OCT,DEC'  '03:00' 2

Write-Output ''
Write-Output "Registered:"
Write-Output "  WpgOpenDataSemiAnnualDownload  (Jun 1 + Dec 1, 03:00)  -> data download + archive (the only job storing history)"
Write-Output "  WpgAssetRefreshQuarterly       (quarterly, 03:30)      -> heartbeats + transit/neighbourhood refresh + auto-deploy"
Write-Output "  WpgParcelTilesBiMonthly        (even months, 2nd, 03:00) -> citywide parcel tiles rebuild + publish + auto-deploy"
Write-Output ""
Write-Output "Verify:  schtasks /Query /TN WpgParcelTilesBiMonthly /V /FO LIST"

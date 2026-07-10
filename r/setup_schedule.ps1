# setup_schedule.ps1
#
# Register (or update) the two scheduled jobs in Windows Task Scheduler. Both
# run in the current user's context (so they run when you're logged on). Re-run
# this script any time to update them.
#
#   powershell -ExecutionPolicy Bypass -File r\setup_schedule.ps1
#
#   1) WpgOpenDataSemiAnnualDownload  (Jun 1 + Dec 1, 03:00)
#        Downloads the 10 City Open Data layers (parcels/zoning/addresses +
#        OurWinnipeg policy areas) and archives them into WpgSnapshots.
#        -> r/scheduled_download.ps1
#
#   2) WpgAssetRefreshQuarterly       (Jan/Apr/Jul/Oct 1, 03:30)
#        Regenerates the app's static transit + neighbourhood GeoJSON and, if
#        they changed, commits + pushes to main (Vercel AUTO-DEPLOYS).
#        -> r/refresh_assets.ps1
#
# Notes:
#  - Runs as the logged-on user (no stored password). If the PC is off / you're
#    not logged on at the trigger time, open Task Scheduler > the task > Settings
#    and tick "Run task as soon as possible after a scheduled start is missed".
#  - Run one now:   schtasks /Run /TN WpgOpenDataSemiAnnualDownload
#  - Remove one:    schtasks /Delete /TN WpgAssetRefreshQuarterly /F

$rdir = 'D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch\r'

function Register-WpgTask($name, $script, $months, $time) {
  $run = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
  schtasks /Create /TN $name /TR $run /SC MONTHLY /M $months /D 1 /ST $time /F

  # schtasks /Create cannot set "run task as soon as possible after a missed
  # start" — and a 03:00 trigger on a workstation is missed by default (audit
  # F5: the semi-annual task had NEVER fired; Last Result 267011). Patch the
  # settings via the ScheduledTasks module: StartWhenAvailable = catch-up at
  # next logon/wake after a missed trigger; WakeToRun = wake a sleeping (not
  # powered-off) machine at trigger time. ExecutionTimeLimit bounds a hung run.
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
                -ExecutionTimeLimit (New-TimeSpan -Hours 6)
  Set-ScheduledTask -TaskName $name -Settings $settings | Out-Null
}

Register-WpgTask 'WpgOpenDataSemiAnnualDownload' (Join-Path $rdir 'scheduled_download.ps1') 'JUN,DEC'          '03:00'
Register-WpgTask 'WpgAssetRefreshQuarterly'      (Join-Path $rdir 'refresh_assets.ps1')      'JAN,APR,JUL,OCT' '03:30'

Write-Output ''
Write-Output "Registered:"
Write-Output "  WpgOpenDataSemiAnnualDownload  (Jun 1 + Dec 1, 03:00)  -> data download + archive"
Write-Output "  WpgAssetRefreshQuarterly       (quarterly, 03:30)      -> transit/neighbourhood refresh + auto-deploy"
Write-Output ""
Write-Output "Both have StartWhenAvailable (missed-trigger catch-up) + WakeToRun."
Write-Output "Verify:  powershell -Command `"(Get-ScheduledTask WpgOpenDataSemiAnnualDownload).Settings | Select StartWhenAvailable, WakeToRun`""

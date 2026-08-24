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
# *** RUN THIS FROM AN ELEVATED PROMPT ***
#
# schtasks.exe can only ever create an INTERACTIVE task, and an Interactive
# task DOES NOT RUN while the user is logged off. StartWhenAvailable does not
# rescue it: the run does not merely slip, it waits for the next logon. On a
# machine that takes a Windows Update reboot at 01:31 and sits at the logon
# screen, a 03:00 job simply does not happen, and no failure alert is possible
# because the job that would send it never started either.
#
# That is not hypothetical. The Manitoba sister project lost 9.3 h to exactly
# this on 2026-08-12 and converted all 14 of its tasks to S4U that day. These
# three were still Interactive when audited on 2026-08-24 -- including
# WpgParcelTilesBiMonthly, which AUTO-DEPLOYS to production, so a missed run
# means the live overlay keeps serving stale tiles with nothing to say so.
#
# S4U = "run whether the user is logged on or not", using a service-for-user
# token, so no password is stored anywhere. Setting a principal is an
# administrative operation: unelevated, Set-ScheduledTask -Principal throws
# "Access is denied." That is CAUGHT rather than fatal -- the task is already
# registered and stays usable -- but the read-back below reports what Windows
# actually stored, and shouts if it is not S4U. Do not assert the principal;
# read it.
#
# Notes:
#  - Re-running this registrar is idempotent, but re-running it UNELEVATED
#    downgrades a working S4U task back to Interactive. The verdict block says
#    so explicitly when it detects that it just happened.
#  - Run one now:   schtasks /Run /TN WpgOpenDataSemiAnnualDownload
#  - Remove one:    schtasks /Delete /TN WpgAssetRefreshQuarterly /F
#  - Prove alerting: powershell -ExecutionPolicy Bypass -File r\rebuild_tiles.ps1 -TestAlert

$rdir = 'D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch\r'

# Collected so the verdict at the end can speak about all three at once.
$script:principalReport = @()

function Register-WpgTask($name, $script, $months, $time, $day = 1) {
  $run = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""

  # What the task's principal was BEFORE this run, so the verdict can tell
  # "never was S4U" apart from "this unelevated re-run just downgraded it".
  $prior = 'none'
  try { $prior = [string](Get-ScheduledTask -TaskName $name -ErrorAction Stop).Principal.LogonType } catch {}

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

  # Own the principal. See the header for why this is not optional.
  $s4uError = $null
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
                 -LogonType S4U -RunLevel Limited
  try {
    Set-ScheduledTask -TaskName $name -Principal $principal -ErrorAction Stop | Out-Null
  } catch {
    # Expected when unelevated. Trimmed: the CIM exception message carries a
    # trailing newline that would break up the warning block below.
    $s4uError = ([string]$_.Exception.Message).Trim()
  }

  # Ask Windows what it STORED. This read-back, not the request above, is the
  # line that would have caught the drift these three tasks were sitting in.
  $actual = 'unreadable'
  try { $actual = [string](Get-ScheduledTask -TaskName $name).Principal.LogonType } catch {}
  Write-Output ("  principal {0}: LogonType={1}  (S4U = runs while logged off; Interactive = does NOT)" -f $name, $actual)

  $script:principalReport += [pscustomobject]@{
    Name = $name; Actual = $actual; Prior = $prior; Error = $s4uError
  }
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
Write-Output "Alerts:  powershell -ExecutionPolicy Bypass -File r\rebuild_tiles.ps1 -TestAlert"

# The verdict, printed last so it is what is left on screen. Based on what Task
# Scheduler reports, never on what was requested.
$bad = @($script:principalReport | Where-Object { $_.Actual -ne 'S4U' })
Write-Output ""
if (-not $bad.Count) {
  Write-Output "All three run whether you are logged on or not - a logon screen no longer stalls them."
} else {
  Write-Output "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  foreach ($b in $bad) {
    Write-Output ("!!  WARNING: '{0}' is LogonType={1}, NOT S4U." -f $b.Name, $b.Actual)
    if ($b.Prior -eq 'S4U') {
      Write-Output "!!  THIS RUN JUST DOWNGRADED IT - it was S4U a moment ago. Re-run elevated NOW."
    }
    if ($b.Error) {
      Write-Output ("!!  Reason: {0}" -f $b.Error)
    }
  }
  Write-Output "!!"
  Write-Output "!!  Interactive tasks DO NOT RUN while you are logged off. A Windows Update"
  Write-Output "!!  reboot that lands on a logon screen silently costs every run until the"
  Write-Output "!!  next login, and no alert is possible because the job that would send it"
  Write-Output "!!  never starts either. That is the 2026-08-12 incident in the Manitoba"
  Write-Output "!!  sister project: 9.3 h lost, nothing said a word."
  Write-Output "!!"
  Write-Output "!!  ('Access is denied' just means this prompt is not elevated - expected.)"
  Write-Output "!!  FIX: re-run this registrar from an ELEVATED prompt (Run as administrator):"
  Write-Output ("!!    powershell -ExecutionPolicy Bypass -File `"{0}`"" -f $PSCommandPath)
  Write-Output "!!  Re-running is idempotent and safe."
  Write-Output "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
}

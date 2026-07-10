# scheduled_download.ps1
#
# Semi-annual unattended job: download every City of Winnipeg Open Data layer
# in the r/wpg_datasets.R registry (10 today: zoning, assessment parcels,
# survey parcels, addresses + 6 OurWinnipeg dev-plan policy areas) via
# paginated SODA, archive them into WpgSnapshots with provenance, then remove
# the repo-dir copies that are now archived. Registered as a Windows Scheduled
# Task by r/setup_schedule.ps1. Logs to WpgSnapshots\_download_logs\.
#
# Run manually any time:  powershell -ExecutionPolicy Bypass -File r\scheduled_download.ps1

$ErrorActionPreference = 'Continue'
$repo        = 'D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch'
$archiveRoot = 'D:\Dropbox\Appraisal\Web\WpgSnapshots'

# PATH lookup first; the pinned fallback matches the currently installed R
# (checked 2026-07: R-4.6.1). If both miss, Fail() below fires loudly.
$rscript = (Get-Command Rscript.exe -ErrorAction SilentlyContinue).Source
if (-not $rscript) { $rscript = 'C:\Program Files\R\R-4.6.1\bin\Rscript.exe' }

$logDir = Join-Path $archiveRoot '_download_logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("download_{0}.log" -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
function Log($m) { ('{0}  {1}' -f (Get-Date -Format 's'), $m) | Tee-Object -FilePath $log -Append | Out-Null; Write-Output $m }

# Failure-email helper (best-effort; tolerant of missing setup).
. (Join-Path $PSScriptRoot 'lib_mail.ps1')

# Loud failure: write a dated FAILED marker at the archive root (where it's
# seen in normal file browsing), send an email with the log tail, skip the
# destructive cleanup step, exit 1. The run is unattended twice a year -
# a quiet failure costs a snapshot.
function Fail($why) {
  Log "FAILED: $why - skipping cleanup; repo-dir downloads left in place."
  $marker = Join-Path $archiveRoot ("FAILED-download-{0}.txt" -f (Get-Date -Format 'yyyy-MM-dd'))
  @("$(Get-Date -Format 's')  scheduled_download.ps1 failed", "Reason: $why", "Log: $log") |
    Set-Content -Path $marker
  $tail = ''
  try { $tail = (Get-Content $log -Tail 60 -ErrorAction Stop) -join "`n" } catch {}
  $body = "Reason: $why`n`nFull log: $log`n`nLast 60 lines:`n$tail"
  Send-FailureMail -Subject "Wpg Open Data: scheduled_download FAILED" -Body $body | Tee-Object -FilePath $log -Append | Out-Null
  exit 1
}

Log '=== Winnipeg Open Data download + archive ==='
if (-not (Test-Path $rscript)) { Fail "Rscript not found at $rscript" }

Log 'Step 1/3: download_parcels.R (paginated)'
& $rscript (Join-Path $repo 'r\download_parcels.R') *>> $log
if ($LASTEXITCODE -ne 0) { Fail "download_parcels.R exited $LASTEXITCODE" }

Log 'Step 2/3: archive_snapshot.R (file into WpgSnapshots + provenance)'
& $rscript (Join-Path $repo 'r\archive_snapshot.R') *>> $log
if ($LASTEXITCODE -ne 0) { Fail "archive_snapshot.R exited $LASTEXITCODE" }

Log 'Step 3/3: clean repo-dir downloads now safely archived'
Get-ChildItem $repo -File |
  Where-Object { $_.Name -match '^[A-Za-z][A-Za-z0-9]*_\d{8}\.gpkg$' } |
  ForEach-Object {
    # An archived copy in a real year folder (not a _partial/_superseded/_-dir),
    # byte-size-identical to the repo copy - existence alone isn't proof the
    # copy completed.
    $archived = Get-ChildItem -Recurse -File -Filter $_.Name $archiveRoot -ErrorAction SilentlyContinue |
                Where-Object { $_.DirectoryName -notmatch '\\_' } | Select-Object -First 1
    if ($archived -and $archived.Length -eq $_.Length) {
      Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue; Log "cleaned $($_.Name)"
    } elseif ($archived) {
      Log "kept $($_.Name) (archived copy size mismatch: archive $($archived.Length) vs repo $($_.Length) bytes)"
    } else {
      Log "kept $($_.Name) (no archived copy found)"
    }
  }

# A clean run supersedes any earlier FAILED marker.
Get-ChildItem $archiveRoot -File -Filter 'FAILED-download-*.txt' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue; Log "cleared stale marker $($_.Name)" }

# Success reminder: archiving is automatic, but the app's historical overlay
# stays on its pinned CDN snapshot until the shard pipeline is re-run and the
# SHA re-pinned. Twice a year, so nudge by email too (best-effort).
$reminder = @(
  'The semi-annual snapshot download + archive completed cleanly.',
  '',
  'REMINDER: the app still serves its previously pinned historical snapshot.',
  'To advance the historical overlay to this capture, run the shard pipeline:',
  '  1. Rscript r\build_historical_shards.R --year <year of new snapshot>',
  '  2. Rscript r\sanitize_shards.R',
  '  3. Rscript r\build_lineage.R',
  '  4. Rscript r\build_historical_shards.R --index-only',
  '  5. Rscript r\verify_shards.R   (must pass before publishing)',
  '  6. commit + push wpg-parcel-history, then pin the new commit SHA in',
  '     web/src/soda.js (HISTORICAL_CDN), npm run build, commit + push.',
  '(Remove the superseded snapshot dir from wpg-parcel-history first if the',
  'retention prune deleted its archive source; see r\prune_snapshots.R.)',
  '',
  "Log: $log"
) -join "`n"
Log 'REMINDER: snapshot archived - run the historical shard rebuild to advance the app (see email / script header).'
Send-FailureMail -Subject 'Wpg Open Data: semi-annual snapshot archived - shard rebuild pending' -Body $reminder |
  Tee-Object -FilePath $log -Append | Out-Null
Log '=== done ==='

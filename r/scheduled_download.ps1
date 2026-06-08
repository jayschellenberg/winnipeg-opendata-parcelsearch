# scheduled_download.ps1
#
# Semi-annual unattended job: download the four City of Winnipeg Open Data
# layers (zoning, assessment parcels, survey parcels, addresses) via paginated
# SODA, archive them into WpgSnapshots with provenance, then remove the repo-dir
# copies that are now archived. Registered as a Windows Scheduled Task by
# r/setup_schedule.ps1. Logs to WpgSnapshots\_download_logs\.
#
# Run manually any time:  powershell -ExecutionPolicy Bypass -File r\scheduled_download.ps1

$ErrorActionPreference = 'Continue'
$repo        = 'D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch'
$archiveRoot = 'D:\Dropbox\Appraisal\Web\WpgSnapshots'

$rscript = (Get-Command Rscript.exe -ErrorAction SilentlyContinue).Source
if (-not $rscript) { $rscript = 'C:\Program Files\R\R-4.5.3\bin\Rscript.exe' }

$logDir = Join-Path $archiveRoot '_download_logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("download_{0}.log" -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
function Log($m) { ('{0}  {1}' -f (Get-Date -Format 's'), $m) | Tee-Object -FilePath $log -Append | Out-Null; Write-Output $m }

Log '=== Winnipeg Open Data download + archive ==='
if (-not (Test-Path $rscript)) { Log "ERROR: Rscript not found at $rscript"; exit 1 }

Log 'Step 1/3: download_parcels.R (paginated)'
& $rscript (Join-Path $repo 'r\download_parcels.R') *>> $log

Log 'Step 2/3: archive_snapshot.R (file into WpgSnapshots + provenance)'
& $rscript (Join-Path $repo 'r\archive_snapshot.R') *>> $log

Log 'Step 3/3: clean repo-dir downloads now safely archived'
Get-ChildItem $repo -File |
  Where-Object { $_.Name -match '^[A-Za-z][A-Za-z0-9]*_\d{8}\.gpkg$' } |
  ForEach-Object {
    # An archived copy in a real year folder (not a _partial/_superseded/_-dir).
    $archived = Get-ChildItem -Recurse -File -Filter $_.Name $archiveRoot -ErrorAction SilentlyContinue |
                Where-Object { $_.DirectoryName -notmatch '\\_' } | Select-Object -First 1
    if ($archived) { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue; Log "cleaned $($_.Name)" }
    else { Log "kept $($_.Name) (no archived copy found)" }
  }
Log '=== done ==='

# refresh_assets.ps1
#
# QUARTERLY: regenerate the app's static transit + neighbourhood GeoJSON assets
# (web/public) and, IF they changed, commit + push to main so Vercel
# auto-deploys the refreshed data. Only the four asset files are staged, so this
# never touches other working-tree changes, and the push is not forced.
#
# Also carries the SNAPSHOT-AGE HEARTBEAT: this job demonstrably fires on
# schedule, so it is the one that alerts when the semi-annual download has
# quietly NOT been running (audit F5: that task had never fired, and no
# failure alert can come from a job that never starts).
#
# *** This job AUTO-DEPLOYS to production when the assets change. *** To make it
# commit-only (you push manually), delete the `git push` line below. To disable
# entirely: schtasks /Delete /TN WpgAssetRefreshQuarterly /F
#
#   Run manually:  powershell -ExecutionPolicy Bypass -File r\refresh_assets.ps1

$ErrorActionPreference = 'Continue'
$repo        = 'D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch'
$archiveRoot = 'D:\Dropbox\Appraisal\Web\WpgSnapshots'
$logDir = Join-Path $archiveRoot '_download_logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("refresh_assets_{0}.log" -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
function Log($m) { ('{0}  {1}' -f (Get-Date -Format 's'), $m) | Tee-Object -FilePath $log -Append | Out-Null; Write-Output $m }

# Failure-email helper (best-effort; tolerant of missing setup).
. (Join-Path $PSScriptRoot 'lib_mail.ps1')
function Mail-Fail($why) {
  $tail = ''
  try { $tail = (Get-Content $log -Tail 60 -ErrorAction Stop) -join "`n" } catch {}
  $body = "Reason: $why`n`nFull log: $log`n`nLast 60 lines:`n$tail"
  Send-FailureMail -Subject "Wpg Open Data: refresh_assets FAILED" -Body $body | Tee-Object -FilePath $log -Append | Out-Null
}

Log '=== refresh transit + neighbourhood static assets ==='

# --- Snapshot-age heartbeat (alert on ABSENCE, not just failure) -----------
# Runs FIRST so every quarterly invocation checks it — the common "no asset
# changes" outcome exits early below and must not skip the tripwire. If the
# newest canonical AssessmentParcels snapshot is older than ~6.5 months
# (semi-annual cadence + a few weeks grace), email + a STALE marker at the
# archive root. Non-fatal to the asset refresh either way.
# 200 (not 245): a silently-missed June run leaves the newest snapshot ~212
# days old at the July 1 heartbeat — 200 catches it there instead of Oct 1.
# Healthy ages at check time never exceed ~122 days + StartWhenAvailable slack.
$maxAgeDays = 200
try {
  $newest = Get-ChildItem -Recurse -File -Path $archiveRoot -Filter 'AssessmentParcels_*.gpkg' -ErrorAction Stop |
    ForEach-Object {
      if ($_.DirectoryName -notmatch '\\_' -and $_.Name -match '^AssessmentParcels_(\d{8})\.gpkg$') {
        [datetime]::ParseExact($Matches[1], 'yyyyMMdd', $null)
      }
    } |
    Sort-Object -Descending | Select-Object -First 1
  if (-not $newest) {
    $why = "snapshot heartbeat: NO canonical AssessmentParcels_*.gpkg found under $archiveRoot."
    Log "WARNING: $why"; Mail-Fail $why
  } else {
    $ageDays = [int]((Get-Date) - $newest).TotalDays
    Log "snapshot heartbeat: newest AssessmentParcels snapshot $($newest.ToString('yyyy-MM-dd')) ($ageDays days old; limit $maxAgeDays)"
    if ($ageDays -gt $maxAgeDays) {
      $why = "snapshot heartbeat: newest AssessmentParcels snapshot is $ageDays days old (> $maxAgeDays). The semi-annual download likely never fired - run r\scheduled_download.ps1 manually and check the WpgOpenDataSemiAnnualDownload task."
      Log "WARNING: $why"; Mail-Fail $why
      @("$(Get-Date -Format 's')  snapshot heartbeat tripped", "Reason: $why") |
        Set-Content -Path (Join-Path $archiveRoot ("STALE-snapshots-{0}.txt" -f (Get-Date -Format 'yyyy-MM-dd')))
    }
  }
} catch {
  Log "snapshot heartbeat check errored (non-fatal): $($_.Exception.Message)"
}

Log 'npm run refresh:transit'
& npm --prefix (Join-Path $repo 'web') run refresh:transit *>> $log 2>&1
$t = $LASTEXITCODE
Log 'npm run refresh:neighbourhoods'
& npm --prefix (Join-Path $repo 'web') run refresh:neighbourhoods *>> $log 2>&1
$n = $LASTEXITCODE
if ($t -ne 0 -or $n -ne 0) {
  $why = "refresh script(s) failed (transit=$t neighbourhoods=$n) - NOT committing."
  Log $why; Mail-Fail $why
  exit 1
}

$assets = @(
  'web/public/transit-routes.geojson',
  'web/public/transit-stops.geojson',
  'web/public/wpg-neighbourhoods.geojson',
  'web/public/wpg-neighbourhood-clusters.geojson'
)
$changed = & git -C $repo status --porcelain -- $assets
if (-not $changed) { Log 'no asset changes - nothing to deploy.'; Log '=== done ==='; exit 0 }

Log 'asset(s) changed - committing + pushing (Vercel will auto-deploy)'
& git -C $repo add -- $assets
$msg = "Refresh transit + neighbourhood static assets (scheduled)`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
& git -C $repo commit -m $msg *>> $log 2>&1
if ($LASTEXITCODE -ne 0) {
  $why = "git commit failed (exit $LASTEXITCODE) - nothing deployed."
  Log "ERROR: $why"; Mail-Fail $why
  exit 1
}
& git -C $repo push origin main *>> $log 2>&1
$pushExit = $LASTEXITCODE
Log "git push exit: $pushExit"
if ($pushExit -ne 0) {
  $why = 'PUSH FAILED - assets are committed locally but NOT deployed. Push manually (git push origin main).'
  Log "ERROR: $why"; Mail-Fail $why
  exit 1
}
Log '=== done ==='

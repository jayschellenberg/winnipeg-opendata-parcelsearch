# refresh_assets.ps1
#
# QUARTERLY: regenerate the app's static transit + neighbourhood GeoJSON assets
# (web/public) and, IF they changed, commit + push to main so Vercel
# auto-deploys the refreshed data. Only the four asset files are staged, so this
# never touches other working-tree changes, and the push is not forced.
#
# *** This job AUTO-DEPLOYS to production when the assets change. *** To make it
# commit-only (you push manually), delete the `git push` line below. To disable
# entirely: schtasks /Delete /TN WpgAssetRefreshQuarterly /F
#
#   Run manually:  powershell -ExecutionPolicy Bypass -File r\refresh_assets.ps1

$ErrorActionPreference = 'Continue'
$repo = 'D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch'
$logDir = 'D:\Dropbox\Appraisal\Web\WpgSnapshots\_download_logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("refresh_assets_{0}.log" -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
function Log($m) { ('{0}  {1}' -f (Get-Date -Format 's'), $m) | Tee-Object -FilePath $log -Append | Out-Null; Write-Output $m }

Log '=== refresh transit + neighbourhood static assets ==='

Log 'npm run refresh:transit'
& npm --prefix (Join-Path $repo 'web') run refresh:transit *>> $log 2>&1
$t = $LASTEXITCODE
Log 'npm run refresh:neighbourhoods'
& npm --prefix (Join-Path $repo 'web') run refresh:neighbourhoods *>> $log 2>&1
$n = $LASTEXITCODE
if ($t -ne 0 -or $n -ne 0) { Log "refresh script(s) failed (transit=$t neighbourhoods=$n) — NOT committing."; exit 1 }

$assets = @(
  'web/public/transit-routes.geojson',
  'web/public/transit-stops.geojson',
  'web/public/wpg-neighbourhoods.geojson',
  'web/public/wpg-neighbourhood-clusters.geojson'
)
$changed = & git -C $repo status --porcelain -- $assets
if (-not $changed) { Log 'no asset changes — nothing to deploy.'; exit 0 }

Log 'asset(s) changed — committing + pushing (Vercel will auto-deploy)'
& git -C $repo add -- $assets
$msg = "Refresh transit + neighbourhood static assets (scheduled)`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
& git -C $repo commit -m $msg *>> $log 2>&1
if ($LASTEXITCODE -ne 0) { Log "ERROR: git commit failed (exit $LASTEXITCODE) — nothing deployed."; exit 1 }
& git -C $repo push origin main *>> $log 2>&1
$pushExit = $LASTEXITCODE
Log "git push exit: $pushExit"
if ($pushExit -ne 0) {
  Log 'ERROR: PUSH FAILED — assets are committed locally but NOT deployed. Push manually (git push origin main).'
  exit 1
}
Log '=== done ==='

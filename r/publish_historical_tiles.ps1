# publish_historical_tiles.ps1
#
# Build + publish the historical tile archives for a list of snapshots, one
# after another, then commit the meta sidecar and push (Vercel deploys).
# Each snapshot is 15–25 minutes of tippecanoe plus a ~200 MB rclone upload,
# so this is meant to run detached (Start-Process) and be left alone; the
# log says where it is.
#
#   powershell -File r/publish_historical_tiles.ps1 -Snapshots 2023-11-13,2025-02-26,2025-03-14
#   powershell -File r/publish_historical_tiles.ps1            # every snapshot in the archive index
#   powershell -File r/publish_historical_tiles.ps1 -NoCommit  # build + upload only
#
# Stops at the first failed snapshot and commits nothing then: a sidecar that
# advertises an archive R2 is not serving is worse than a stale one.

param(
  [string[]] $Snapshots = @(),
  [switch]   $NoCommit
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$metaRel = 'web/public/historical-tiles-meta.json'
function Log($m) { "$(Get-Date -Format 'HH:mm:ss')  $m" }

if (-not $Snapshots.Count) {
  $index = Get-Content 'D:/Dropbox/ClaudeCode/WpgOpenData/wpg-parcel-history/index.json' -Raw | ConvertFrom-Json
  $Snapshots = @($index.snapshots.PSObject.Properties.Name | Sort-Object)
}
Log "Snapshots: $($Snapshots -join ', ')"

foreach ($snap in $Snapshots) {
  Log "== ${snap}: build + publish"
  & Rscript (Join-Path $repo 'r/build_historical_tiles.R') --snapshot $snap --publish
  if ($LASTEXITCODE -ne 0) { Log "FAILED on $snap (exit $LASTEXITCODE); stopping, nothing committed"; exit 1 }
}

if ($NoCommit) { Log 'Done (no commit requested).'; exit 0 }

$changed = & git -C $repo status --porcelain -- $metaRel
if (-not $changed) { Log 'Meta sidecar unchanged; nothing to commit.'; exit 0 }
& git -C $repo add -- $metaRel
$msg = "Historical tile archives: $($Snapshots -join ', ') built and published`n`nr/build_historical_tiles.R --publish; sidecar refreshed with the new bytes, sha256 and size-change summaries.`n`nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
& git -C $repo -c core.safecrlf=false commit -q -m $msg
if ($LASTEXITCODE -ne 0) { Log 'commit failed'; exit 1 }
& git -C $repo push origin main
if ($LASTEXITCODE -ne 0) { Log 'push failed (Dropbox git lock? retry: git push origin main)'; exit 1 }
Log 'Done: committed + pushed.'

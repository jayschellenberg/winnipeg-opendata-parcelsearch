# publish_survey_tiles.ps1
#
# Build + publish the All Survey Parcels archive (r/build_survey_tiles.R),
# then commit its sidecar and push (Vercel deploys). ~20-30 minutes of
# fetching and tippecanoe plus the R2 upload, so run it detached; the
# monthly r/rebuild_tiles.ps1 calls it as its final, non-fatal step.
#
#   powershell -File r/publish_survey_tiles.ps1
#   powershell -File r/publish_survey_tiles.ps1 -NoCommit   # build + upload only
#
# Commits nothing when the build or upload fails: a sidecar dating an archive
# R2 is not serving is worse than a stale one.

param([switch] $NoCommit)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$metaRel = 'web/public/survey-pmtiles-meta.json'
function Log($m) { "$(Get-Date -Format 'HH:mm:ss')  $m" }

$rscript = (Get-Command Rscript.exe -ErrorAction SilentlyContinue).Source
if (-not $rscript) { $rscript = 'C:\Program Files\R\R-4.6.1\bin\Rscript.exe' }

Log '== build_survey_tiles.R --publish'
& $rscript (Join-Path $repo 'r/build_survey_tiles.R') --publish
if ($LASTEXITCODE -ne 0) { Log "FAILED (exit $LASTEXITCODE); nothing committed"; exit 1 }

if ($NoCommit) { Log 'Done (no commit requested).'; exit 0 }

$changed = & git -C $repo status --porcelain -- $metaRel
if (-not $changed) { Log 'Meta sidecar unchanged; nothing to commit.'; exit 0 }
& git -C $repo add -- $metaRel
$msg = "Survey parcel tiles built and published`n`nr/build_survey_tiles.R --publish; sidecar refreshed with the new build date, bytes and sha256."
& git -C $repo -c core.safecrlf=false commit -q -m $msg
if ($LASTEXITCODE -ne 0) { Log 'commit failed'; exit 1 }
# The repo lives under Dropbox, whose sync client intermittently holds a git
# lock; retry the push rather than fail the step on the first collision.
foreach ($attempt in 1..3) {
  & git -C $repo pull --rebase -q origin main
  & git -C $repo push -q origin main
  if ($LASTEXITCODE -eq 0) { Log 'Done: committed + pushed.'; exit 0 }
  Start-Sleep -Seconds (5 * $attempt)
}
Log 'push failed after 3 attempts (Dropbox git lock? retry: git push origin main)'
exit 1

# rebuild_tiles.ps1
#
# BI-MONTHLY unattended job: rebuild and publish the citywide parcels PMTiles
# archive (web/public/parcels.pmtiles) so the "Show All Parcels" and
# "Dwelling Units" overlays never drift more than ~2 months behind the live
# assessment roll. Before this job existed the archive was rebuilt by hand,
# with nothing scheduling it and nothing warning when it aged.
#
# THIS JOB STORES NO HISTORY. It fetches its own copy of d4mq-wa44 live from
# SODA, tiles it, publishes, and deletes the intermediates - it never touches
# WpgSnapshots or wpg-parcel-history. Historical snapshots stay on their own
# SEMI-ANNUAL cadence (r/scheduled_download.ps1, Jun 1 + Dec 1). That
# separation is the whole design: tiles are a current-state overlay that
# should be fresh, history is an archive that should be sparse.
#
# Registered as WpgParcelTilesBiMonthly by r/setup_schedule.ps1
# (Feb/Apr/Jun/Aug/Oct/Dec, the 2nd at 03:00). The 2nd, not the 1st, so this
# never contends with the Jun/Dec snapshot download or the quarterly asset
# refresh for the same Socrata dataset.
#
# Steps: preflight -> rollback copy -> R build + tippecanoe (WSL) ->
#        sha256 refresh -> gh release upload + verify -> commit + push.
# Vercel then auto-deploys, and web/scripts/fetch-pmtiles.mjs pulls the new
# release asset and checks it against the sha256 this job just committed.
#
# *** This job AUTO-DEPLOYS to production. *** To make it publish-only,
# delete the `git push` line below. To disable entirely:
#   schtasks /Delete /TN WpgParcelTilesBiMonthly /F
#
# Run manually any time:
#   powershell -ExecutionPolicy Bypass -File r\rebuild_tiles.ps1
#
# ASCII-ONLY (same reason as lib_mail.ps1): Windows PowerShell 5.1 - the
# scheduled-task runtime - reads a BOM-less .ps1 as the ANSI codepage, so a
# non-ASCII byte inside a string literal corrupts the parse silently.

$ErrorActionPreference = 'Continue'

$repo        = 'D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch'
$archiveRoot = 'D:\Dropbox\Appraisal\Web\WpgSnapshots'
$ghRepo      = 'jayschellenberg/winnipeg-opendata-parcelsearch'
$releaseTag  = 'parcels-pmtiles'

$pmtilesPath = Join-Path $repo 'web\public\parcels.pmtiles'
$shaPath     = Join-Path $repo 'web\scripts\parcels.pmtiles.sha256'
$rollbackDir = Join-Path $archiveRoot '_pmtiles_rollback'

# Git-relative paths - the ONLY two files this job is allowed to stage.
$metaRel = 'web/public/parcels-pmtiles-meta.json'
$shaRel  = 'web/scripts/parcels.pmtiles.sha256'

# PATH lookup first; the pinned fallback matches the currently installed R
# (checked 2026-08: R-4.6.1), same convention as scheduled_download.ps1.
$rscript = (Get-Command Rscript.exe -ErrorAction SilentlyContinue).Source
if (-not $rscript) { $rscript = 'C:\Program Files\R\R-4.6.1\bin\Rscript.exe' }

$logDir = Join-Path $archiveRoot '_download_logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("rebuild_tiles_{0}.log" -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
function Log($m) { ('{0}  {1}' -f (Get-Date -Format 's'), $m) | Tee-Object -FilePath $log -Append | Out-Null; Write-Output $m }

# Failure-email helper (best-effort; tolerant of missing setup).
. (Join-Path $PSScriptRoot 'lib_mail.ps1')

# Whether meta/sha were already dirty BEFORE this run. If they were clean, a
# failure restores them so a half-finished rebuild cannot ride along with
# some later unrelated push. If they were already dirty, they are somebody
# else's edits and we leave them alone.
$metaWasClean = $false
$shaWasClean  = $false

function Restore-TrackedFiles {
  $restore = @()
  if ($metaWasClean) { $restore += $metaRel }
  if ($shaWasClean)  { $restore += $shaRel }
  if (-not $restore) {
    Log 'restore: meta/sha were already modified before this run - left untouched.'
    return
  }
  & git -C $repo checkout -- $restore 2>&1 | Out-Null
  Log ("restore: reverted {0}" -f ($restore -join ', '))
}

# Loud failure: revert our tracked-file edits, write a dated FAILED marker at
# the archive root (seen in normal file browsing), email the log tail, exit 1.
function Fail($why) {
  Log "FAILED: $why"
  Restore-TrackedFiles
  $marker = Join-Path $archiveRoot ("FAILED-tiles-{0}.txt" -f (Get-Date -Format 'yyyy-MM-dd'))
  @("$(Get-Date -Format 's')  rebuild_tiles.ps1 failed", "Reason: $why", "Log: $log") |
    Set-Content -Path $marker
  $tail = ''
  try { $tail = (Get-Content $log -Tail 60 -ErrorAction Stop) -join "`n" } catch {}
  $body = "Reason: $why`n`nThe previously published tiles are still live - this job promotes only after a clean build.`n`nFull log: $log`n`nLast 60 lines:`n$tail"
  Send-FailureMail -Subject 'Wpg Open Data: parcel-tile rebuild FAILED' -Body $body |
    Tee-Object -FilePath $log -Append | Out-Null
  exit 1
}

Log '=== Winnipeg citywide parcel-tile rebuild (bi-monthly) ==='

# --- Step 0: preflight ----------------------------------------------------
# All three external dependencies are checked BEFORE the ~50-page fetch, so a
# missing tool costs seconds instead of failing after a 40-minute download.
Log 'Step 0/6: preflight'

if (-not (Test-Path $rscript)) { Fail "Rscript not found at $rscript" }
Log "  Rscript: $rscript"

if (-not (Test-Path $repo)) { Fail "repo not found at $repo" }

# WSL tippecanoe. Docker is deliberately NOT used here: Docker Desktop's
# daemon is often not running at 03:00, which would strand the build.
#
# `cmd /c` merges stderr into stdout at the OS level, so PowerShell only ever
# sees stdout. Both tippecanoe and gh print their banner to STDERR, and
# capturing that with PowerShell's own `2>&1` turns it into a
# NativeCommandError. Measured in a real scheduled-task run: that form halted
# the script mid-preflight before it reached the gh check, and even when it
# does survive it logs a 440-character error blob instead of a version. This
# form is immune and logs one clean line.
$tippeVersion = (& cmd /c "wsl tippecanoe --version 2>&1") -join ' '
if ($LASTEXITCODE -ne 0) { Fail "WSL tippecanoe not runnable (exit $LASTEXITCODE): $tippeVersion" }
Log "  tippecanoe: $tippeVersion"

# gh keeps its token in the Windows keyring. Verified reachable from a
# non-interactive scheduled-task session (probed 2026-08-05), which is the
# thing most likely to be silently missing at 03:00.
$ghStatus = (& cmd /c "gh auth status 2>&1") -join ' | '
if ($LASTEXITCODE -ne 0) { Fail "gh not authenticated - cannot upload the release asset. $ghStatus" }
Log '  gh: authenticated'

# Must be on main, checked BEFORE anything is fetched or published. Step 6
# commits the new checksum and pushes main; on any other branch the commit
# would land on that branch while `push origin main` pushed a main without
# it. The asset would then be live with no matching committed sha - the one
# state fetch-pmtiles.mjs rejects, disabling the overlay on every deploy
# until someone notices. Failing here leaves nothing published.
$branch = & git -C $repo rev-parse --abbrev-ref HEAD
if ($LASTEXITCODE -ne 0) { Fail "git rev-parse failed in $repo - not a working repo?" }
$branch = "$branch".Trim()
if ($branch -ne 'main') {
  Fail "repo is on branch '$branch', not main. Refusing to publish: the checksum commit would not reach the branch this job pushes."
}
Log "  branch: $branch"

# Record pre-run cleanliness of the two files we are allowed to touch.
$metaWasClean = -not (& git -C $repo status --porcelain -- $metaRel)
$shaWasClean  = -not (& git -C $repo status --porcelain -- $shaRel)
Log "  pre-run clean: meta=$metaWasClean sha=$shaWasClean"

# --- Step 1: rollback copy ------------------------------------------------
# One generation of insurance (~96 MB). If a bad archive ever gets published,
# re-upload this file and restore the sha beside it. Not history - history is
# the semi-annual snapshot archive.
Log 'Step 1/6: rollback copy of the currently published archive'
if (Test-Path $pmtilesPath) {
  New-Item -ItemType Directory -Force -Path $rollbackDir | Out-Null
  try {
    Copy-Item $pmtilesPath (Join-Path $rollbackDir 'parcels.pmtiles') -Force -ErrorAction Stop
    if (Test-Path $shaPath) { Copy-Item $shaPath (Join-Path $rollbackDir 'parcels.pmtiles.sha256') -Force }
    ("Rollback copy taken {0} from {1}" -f (Get-Date -Format 's'), $pmtilesPath) |
      Set-Content -Path (Join-Path $rollbackDir 'README.txt')
    Log "  copied to $rollbackDir"
  } catch {
    Fail "rollback copy failed: $($_.Exception.Message)"
  }
} else {
  Log '  no existing archive to copy (first run) - continuing.'
}

# --- Step 2: build --------------------------------------------------------
# build_parcel_tiles.R sources r/lib_dwelling_units.R by RELATIVE path, so it
# must run with the repo as the working directory. A scheduled task starts in
# C:\Windows\System32, which would fail the source() immediately.
Log 'Step 2/6: build_parcel_tiles.R --run-tippecanoe (fetch + tile + promote)'
$runStart = Get-Date
Push-Location $repo
try {
  & $rscript (Join-Path $repo 'r\build_parcel_tiles.R') --run-tippecanoe *>> $log
  $buildExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($buildExit -ne 0) { Fail "build_parcel_tiles.R exited $buildExit" }

# --- Step 3: post-build sanity -------------------------------------------
# The R script enforces the size band before it promotes the archive; these
# checks confirm the promotion actually happened in THIS run and that nothing
# clobbered the file afterwards.
Log 'Step 3/6: post-build sanity'
if (-not (Test-Path $pmtilesPath)) { Fail "no archive at $pmtilesPath after a successful build" }
$archive = Get-Item $pmtilesPath
if ($archive.LastWriteTime -lt $runStart) {
  Fail ("archive was not rewritten by this run (last write {0}, run started {1}) - refusing to publish a stale file." -f $archive.LastWriteTime, $runStart)
}
if ($archive.Length -lt 1MB) { Fail "archive is only $($archive.Length) bytes - truncated." }
# Decimal MB (1e6), matching the size band build_parcel_tiles.R enforces and
# quotes in its failure message. PowerShell's 1MB literal is 1048576 (MiB),
# which logged the 95.8 MB archive as "91.4 MB" and read like an unexplained
# shrink against the previous build. Keep both logs in the same units.
Log ("  archive OK: {0:N1} MB ({1:N0} bytes), written {2}" -f ($archive.Length / 1e6), $archive.Length, $archive.LastWriteTime)

# --- Step 4: refresh the pinned checksum ---------------------------------
# fetch-pmtiles.mjs verifies the downloaded asset against this value at
# deploy time, so it must be refreshed in the same run that uploads.
Log 'Step 4/6: refresh web/scripts/parcels.pmtiles.sha256'
$hash = (Get-FileHash $pmtilesPath -Algorithm SHA256).Hash.ToLower()
Set-Content -Path $shaPath -Value $hash -Encoding ascii
Log "  sha256: $hash"

# --- Step 5: publish the release asset -----------------------------------
Log 'Step 5/6: gh release upload (--clobber)'
& gh release upload $releaseTag $pmtilesPath --clobber --repo $ghRepo *>> $log 2>&1
if ($LASTEXITCODE -ne 0) { Fail "gh release upload exited $LASTEXITCODE" }

# Verify what GitHub actually stored. A truncated upload would otherwise
# surface only as a silent overlay-disable at the next deploy. GitHub reports
# the asset's own sha256 digest, so this is a cryptographic check, not just a
# size comparison; the size check is the fallback if digest is ever absent.
$assetOk = $false
try {
  # Deliberately NOT merging stderr here: this output is parsed as JSON, and
  # a merged warning line would corrupt the parse. cmd keeps stderr on its own
  # stream (discarded), so $view is pure stdout.
  $view = (& cmd /c "gh release view $releaseTag --repo $ghRepo --json assets") -join ''
  $asset = ($view | ConvertFrom-Json).assets | Where-Object { $_.name -eq 'parcels.pmtiles' } | Select-Object -First 1
  if (-not $asset) { Fail 'uploaded asset parcels.pmtiles not found in the release after upload.' }
  $digest = ''
  if ($asset.PSObject.Properties.Name -contains 'digest' -and $asset.digest) {
    $digest = ($asset.digest -replace '^sha256:', '').ToLower()
  }
  if ($digest) {
    if ($digest -ne $hash) {
      Fail "uploaded asset digest $digest does not match local $hash - the published archive is not what we built."
    }
    Log '  upload verified by sha256 digest'
    $assetOk = $true
  } elseif ([int64]$asset.size -eq $archive.Length) {
    Log "  upload verified by size ($($asset.size) bytes; no digest reported)"
    $assetOk = $true
  } else {
    Fail "uploaded asset is $($asset.size) bytes, local is $($archive.Length) - upload is incomplete."
  }
} catch {
  if (-not $assetOk) { Fail "could not verify the uploaded asset: $($_.Exception.Message)" }
}

# --- Step 6: commit + push the two tracked files -------------------------
# ONLY meta + sha are staged, so this never sweeps up unrelated working-tree
# changes, and the push is not forced.
Log 'Step 6/6: commit + push meta + sha (Vercel auto-deploys)'
$changed = & git -C $repo status --porcelain -- $metaRel $shaRel
if (-not $changed) {
  Log '  no change to meta/sha (same-day re-run?) - release asset is published; nothing to deploy.'
  Log '=== done ==='
  exit 0
}

& git -C $repo add -- $metaRel $shaRel
$msg = "Rebuild citywide parcel tiles (scheduled bi-monthly)`n`nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
& git -C $repo commit -m $msg *>> $log 2>&1
if ($LASTEXITCODE -ne 0) { Fail "git commit failed (exit $LASTEXITCODE) - asset uploaded but sha NOT deployed." }

& git -C $repo push origin main *>> $log 2>&1
if ($LASTEXITCODE -ne 0) {
  # Do NOT revert here: the commit is good and the asset is published. The
  # deploy just needs a push. Reverting would strand the release asset with a
  # stale committed sha, which is the one state fetch-pmtiles.mjs rejects.
  Log 'ERROR: push failed - meta/sha are committed locally but NOT deployed.'
  $marker = Join-Path $archiveRoot ("FAILED-tiles-{0}.txt" -f (Get-Date -Format 'yyyy-MM-dd'))
  @("$(Get-Date -Format 's')  rebuild_tiles.ps1: push failed", 'Run: git push origin main', "Log: $log") |
    Set-Content -Path $marker
  Send-FailureMail -Subject 'Wpg Open Data: parcel-tile rebuild - PUSH FAILED' `
    -Body "The new tiles are built and the release asset is uploaded, but the commit pinning its sha256 was not pushed, so production still serves the old archive.`n`nFix: git -C $repo push origin main`n`nLog: $log" |
    Tee-Object -FilePath $log -Append | Out-Null
  exit 1
}

# A clean run supersedes any earlier FAILED marker.
Get-ChildItem $archiveRoot -File -Filter 'FAILED-tiles-*.txt' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue; Log "cleared stale marker $($_.Name)" }

Log 'Pushed. Vercel will rebuild and fetch-pmtiles.mjs will pull the new asset.'
Log '=== done ==='

# rebuild_tiles.ps1
#
# BI-MONTHLY unattended job: rebuild and publish the citywide parcels PMTiles
# archive (web/public/parcels.pmtiles) so the "Show All Parcels" and
# "Dwelling Units" overlays never drift more than ~2 months behind the live
# assessment roll.
#
# THIS JOB STORES NO HISTORY. It fetches its own copy of d4mq-wa44 live from
# SODA, tiles it, publishes, and deletes the intermediates - it never touches
# WpgSnapshots or wpg-parcel-history. Historical snapshots stay on their own
# SEMI-ANNUAL cadence (r/scheduled_download.ps1, Jun 1 + Dec 1).
#
# Registered as WpgParcelTilesBiMonthly by r/setup_schedule.ps1
# (Feb/Apr/Jun/Aug/Oct/Dec, the 2nd at 03:00).
#
# *** This job AUTO-DEPLOYS to production. *** To disable entirely:
#   schtasks /Delete /TN WpgParcelTilesBiMonthly /F
#
# Run manually any time. Use the FULL path: the script is working-directory
# independent, but `-File r\rebuild_tiles.ps1` only resolves if the shell
# happens to be sitting in the repo root, and a scheduled task starts in
# C:\WINDOWS\system32.
#   powershell -ExecutionPolicy Bypass -File D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch\r\rebuild_tiles.ps1
#
# ---------------------------------------------------------------------------
# WHY THE PUBLISH STEP LOOKS LIKE THIS (the 2026-08-05 incident)
#
# Step 5 used to be one line: `gh release upload <tag> <file> --clobber`.
# gh's own help says, verbatim: "When using --clobber, existing assets are
# deleted before new assets are uploaded. If the upload fails, the original
# assets will be lost." On 2026-08-05 GitHub returned HTTP 502 on the DELETE
# half. GitHub had already applied the delete, so the release was left with
# ZERO assets, and every subsequent Vercel deploy would have shipped with the
# parcel overlay silently disabled until a human noticed the email.
#
# The fix is ORDERING, not retrying: never destroy the live asset before its
# replacement exists and has been verified.
#
#   P1  prune stale staging assets            (best effort, never fatal)
#   P2  hardlink the archive to a staging name unique to this attempt
#   P3  upload it under that name             (NO --clobber; name is virgin)
#   P4  re-read the release and verify        (state=uploaded AND digest)
#   P5  PATCH the live asset  -> parcels-previous-<date>.pmtiles
#   P6  PATCH the new asset   -> parcels.pmtiles      <- now live
#   P7  re-read and confirm                   (a read failure here is a warning)
#
# Only P5-P6 leaves the canonical name unoccupied, and that is two consecutive
# metadata calls. If P6 fails, the compensator is one more metadata PATCH -
# it moves zero bytes, so it cannot fail for the reason a 96 MB upload would.
# There is deliberately NO "re-upload the rollback copy" path: it is the same
# large transfer to the same service that just failed, and under this ordering
# it can never be needed.
#
# THE ONE RULE: revert the two tracked files if and only if the NEW archive is
# NOT serving under the canonical name ($script:newArchiveIsLive). Reverting
# after a good upload pins the OLD hash against NEW bytes, which fails on
# EVERY future deploy - a transient blip turned into a permanent outage.
#
# Decisions are made by RE-READING the release, never from an exit code: the
# incident's 502 came from a mutation GitHub had already applied.
#
# ASCII-ONLY (same reason as lib_mail.ps1): Windows PowerShell 5.1 - the
# scheduled-task runtime - reads a BOM-less .ps1 as the ANSI codepage, so a
# non-ASCII byte inside a string literal corrupts the parse silently.

$ErrorActionPreference = 'Continue'

$repo        = 'D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch'
$archiveRoot = 'D:\Dropbox\Appraisal\Web\WpgSnapshots'
$ghRepo      = 'jayschellenberg/winnipeg-opendata-parcelsearch'
$releaseTag  = 'parcels-pmtiles'
$assetName   = 'parcels.pmtiles'

$pmtilesPath = Join-Path $repo 'web\public\parcels.pmtiles'
$shaPath     = Join-Path $repo 'web\scripts\parcels.pmtiles.sha256'
$rollbackDir = Join-Path $archiveRoot '_pmtiles_rollback'

# Staging lives OUTSIDE Dropbox (which would sync 96 MB) and outside
# web/public (.gitignore ignores the exact path web/public/parcels.pmtiles,
# not a pattern, so a second name there would show up untracked). Same volume
# as the repo so the hardlink works.
$stagingDir  = 'D:\wpg-tile-staging'

# Git-relative paths - the ONLY two files this job is allowed to stage.
$metaRel = 'web/public/parcels-pmtiles-meta.json'
$shaRel  = 'web/scripts/parcels.pmtiles.sha256'

$rscript = (Get-Command Rscript.exe -ErrorAction SilentlyContinue).Source
if (-not $rscript) { $rscript = 'C:\Program Files\R\R-4.6.1\bin\Rscript.exe' }

$logDir = Join-Path $archiveRoot '_download_logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("rebuild_tiles_{0}.log" -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
function Log($m) { ('{0}  {1}' -f (Get-Date -Format 's'), $m) | Tee-Object -FilePath $log -Append | Out-Null; Write-Output $m }

# The re-run command, built from $repo so it can never drift from where this
# script actually lives. Emails quote this: a relative path pasted out of an
# alert at 03:00 fails with "the argument does not exist", which is a
# needless obstacle in front of someone already dealing with an outage.
$selfCmd = "powershell -ExecutionPolicy Bypass -File $(Join-Path $repo 'r\rebuild_tiles.ps1')"

. (Join-Path $PSScriptRoot 'lib_mail.ps1')
# Publish primitives (Invoke-Gh, Read-Release, Publish-ReleaseAsset, ...).
# Extracted so the publish sequence - the code that caused the 2026-08-05
# outage - can be exercised by r/test_gh_publish.ps1 against scratch asset
# names instead of only ever running for real at 03:00.
. (Join-Path $PSScriptRoot 'lib_gh.ps1')

# Log is defined above; wrap it so the library can report through it.
$LogCb = { param($m) Log $m }

# THE publish-state flag. The $script: prefix on every assignment is mandatory:
# a bare assignment inside a function creates a function-local, the caller
# keeps the old value, and Fail() takes the wrong branch.
$script:newArchiveIsLive = $false
$script:pushFailed       = $false

$metaWasClean = $false
$shaWasClean  = $false

# Convenience wrapper: the library's Read-Release is parameterised by tag/repo
# so the test harness can point it elsewhere; this job always means one release.
function Read-ThisRelease([int]$Attempts = 3) {
  Read-Release $releaseTag $ghRepo $Attempts $LogCb
}

function Get-CommittedSha($rev) {
  try {
    $out = & git -C $repo show "${rev}:$shaRel" 2>$null
    if ($LASTEXITCODE -eq 0) { return ("$out").Trim().ToLower().Split()[0] }
  } catch {}
  return ''
}

# Measure - never assume - what is actually published, and whether the next
# Vercel deploy will render the overlay. This block goes into both the marker
# file and the failure email, because the cause of a failure is far less
# useful to a human than the current state of production.
function Measure-PublishedState {
  $rel    = Read-ThisRelease 2
  $asset  = Get-Asset $rel $assetName
  $digest = Get-AssetDigest $asset
  $head   = Get-CommittedSha 'HEAD'
  $origin = Get-CommittedSha 'origin/main'

  $verdict = ''
  $subject = ''
  if (-not $rel) {
    $verdict = 'UNKNOWN - the release could not be read; nothing was changed.'
    $subject = 'Wpg Open Data: parcel-tile rebuild - published state UNKNOWN, please check'
  } elseif ($script:newArchiveIsLive -and $script:pushFailed) {
    $verdict = 'The NEW archive is live but its checksum is not pushed. The overlay BREAKS on the next deploy from any commit until the push lands.'
    $subject = 'Wpg Open Data: parcel-tile rebuild - OVERLAY BREAKS ON NEXT DEPLOY, push required'
  } elseif (-not $asset) {
    $verdict = 'The next Vercel deploy WILL NOT render the parcel overlay (no asset named parcels.pmtiles).'
    $subject = 'Wpg Open Data: parcel-tile rebuild FAILED - OVERLAY DOWN, action required'
  } elseif ($digest -and $origin -and $digest -eq $origin) {
    $verdict = 'The next Vercel deploy WILL render the parcel overlay. Production is unaffected.'
    $subject = 'Wpg Open Data: parcel-tile rebuild FAILED - overlay UNAFFECTED'
  } elseif ($digest -and $head -and $digest -eq $head) {
    $verdict = 'The published asset matches the local commit but not origin/main - push the checksum commit.'
    $subject = 'Wpg Open Data: parcel-tile rebuild - OVERLAY BREAKS ON NEXT DEPLOY, push required'
  } elseif (-not $digest) {
    # An asset with no reported digest is NOT evidence of a broken overlay -
    # GitHub simply did not tell us. Folding this into the certain DOWN verdict
    # would print repair steps that delete a possibly-good asset.
    $verdict = "An asset named $assetName is present but GitHub reported no checksum for it (state '$(if ($asset) { $asset.state } else { 'n/a' })'), so this could not be verified either way. Check it before acting."
    $subject = 'Wpg Open Data: parcel-tile rebuild - published state UNKNOWN, please check'
  } else {
    $verdict = 'The next Vercel deploy WILL NOT render the parcel overlay (published asset does not match the committed checksum).'
    $subject = 'Wpg Open Data: parcel-tile rebuild FAILED - OVERLAY DOWN, action required'
  }

  $short = { param($h) if ($h) { $h.Substring(0, [Math]::Min(12, $h.Length)) } else { 'n/a' } }
  $block = @(
    "PUBLISHED STATE (measured $(Get-Date -Format 's'))",
    "  VERDICT: $verdict",
    "  release asset parcels.pmtiles : $(if ($asset) { 'present' } elseif ($rel) { 'MISSING' } else { 'unreadable' })",
    "  its state                     : $(if ($asset) { $asset.state } else { 'n/a' })",
    "  its sha256                    : $(& $short $digest)",
    "  committed sha (HEAD)          : $(& $short $head)",
    "  committed sha (origin/main)   : $(& $short $origin)"
  ) -join "`n"

  [PSCustomObject]@{ Block = $block; Subject = $subject; Verdict = $verdict; Asset = $asset; Release = $rel }
}

function Restore-TrackedFiles {
  $restore = @()
  if ($metaWasClean) { $restore += $metaRel }
  if ($shaWasClean)  { $restore += $shaRel }
  if (-not $restore) {
    Log 'restore: meta/sha were already modified before this run - left untouched.'
    return
  }
  & git -C $repo checkout -- $restore 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Log ("restore: reverted {0}" -f ($restore -join ', '))
  } else {
    # Saying "reverted" when git refused leaves the operator believing the
    # working tree is clean while the new checksum is still sitting in it,
    # ready to ride along with an unrelated later commit.
    Log ("restore: FAILED to revert {0} (git exit {1}) - check the working tree by hand" -f ($restore -join ', '), $LASTEXITCODE)
  }
}

# Loud failure. Reverts the tracked files ONLY when the new archive is not
# live, measures the published state, writes a timestamped marker (so two
# failures on one day stop overwriting each other) and emails a subject chosen
# from what is actually published rather than from where the code failed.
function Fail($why) {
  Log "FAILED: $why"
  if ($script:newArchiveIsLive) {
    Log 'not reverting tracked files: the NEW archive is live under the canonical name.'
  } else {
    Restore-TrackedFiles
  }

  $state = Measure-PublishedState
  Log $state.Verdict

  $marker = Join-Path $archiveRoot ("FAILED-tiles-{0}.txt" -f (Get-Date -Format 'yyyy-MM-dd-HHmm'))
  @("VERDICT: $($state.Verdict)", "$(Get-Date -Format 's')  rebuild_tiles.ps1 failed", "Reason: $why", '', $state.Block, '', "Log: $log") |
    Set-Content -Path $marker

  $repair = @(
    '',
    'REPAIR (only if the verdict above says the overlay is down):',
    "  1. Confirm:  gh release view $releaseTag --repo $ghRepo --json assets",
    "  2. Re-run:   $selfCmd",
    '     (a re-run is safe: it never deletes the live asset before its replacement is verified)',
    "  3. If an asset named parcels-previous-*.pmtiles holds the last good archive, rename it back:",
    "     gh api --method PATCH <that asset's apiUrl> -f name=parcels.pmtiles"
  ) -join "`n"

  $tail = ''
  try { $tail = (Get-Content $log -Tail 40 -ErrorAction Stop) -join "`n" } catch {}
  $body = "Reason: $why`n`n$($state.Block)`n$repair`n`nFull log: $log`n`nLast 40 lines:`n$tail"
  Send-FailureMail -Subject $state.Subject -Body $body | Tee-Object -FilePath $log -Append | Out-Null
  exit 1
}

Log '=== Winnipeg citywide parcel-tile rebuild (bi-monthly) ==='

# --- Step 0: preflight ----------------------------------------------------
# Every external dependency is checked BEFORE the ~20-minute build, so a
# missing tool or an unreachable release costs seconds instead of failing at
# the end.
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
# the script mid-preflight before it reached the gh check. (The publish path
# below uses Invoke-Gh instead, which is immune for the same reason and also
# bounded; these two preflight probes are left as they are because they work
# and churn is risk.)
$tippeVersion = (& cmd /c "wsl tippecanoe --version 2>&1") -join ' '
if ($LASTEXITCODE -ne 0) { Fail "WSL tippecanoe not runnable (exit $LASTEXITCODE): $tippeVersion" }
Log "  tippecanoe: $tippeVersion"

$ghExe = Initialize-Gh
if (-not $ghExe) { Fail 'gh.exe not found on PATH - cannot publish the release asset.' }
Log "  gh: $ghExe"

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
# state fetch-pmtiles.mjs rejects.
$branch = & git -C $repo rev-parse --abbrev-ref HEAD
if ($LASTEXITCODE -ne 0) { Fail "git rev-parse failed in $repo - not a working repo?" }
$branch = "$branch".Trim()
if ($branch -ne 'main') {
  Fail "repo is on branch '$branch', not main. Refusing to publish: the checksum commit would not reach the branch this job pushes."
}
Log "  branch: $branch"

$metaWasClean = -not (& git -C $repo status --porcelain -- $metaRel)
$shaWasClean  = -not (& git -C $repo status --porcelain -- $shaRel)
Log "  pre-run clean: meta=$metaWasClean sha=$shaWasClean"

# Read the release now: it discovers a deleted tag / draft / immutable release
# in seconds instead of after the build, and it captures the digest the step-1
# rollback gate needs.
$rel0 = Read-ThisRelease 3
if (-not $rel0) { Fail 'could not read the GitHub release at preflight - refusing to start a 20-minute build that may not be publishable.' }
if ($rel0.isDraft)     { Fail "release $releaseTag is a DRAFT - fetch-pmtiles.mjs cannot download from it." }
if ($rel0.isImmutable) { Fail "release $releaseTag is IMMUTABLE - asset replacement is impossible." }

$prevAsset  = Get-Asset $rel0 $assetName
$prevDigest = Get-AssetDigest $prevAsset
$headSha    = Get-CommittedSha 'HEAD'
if ($prevAsset) {
  Log ("  release: asset {0} state={1} digest={2} size={3:N0}" -f $assetName, $prevAsset.state, $(if ($prevDigest) { $prevDigest.Substring(0,12) } else { 'n/a' }), [int64]$prevAsset.size)
} else {
  Log "  release: NO asset named $assetName is present"
}
Log ("  committed sha (HEAD): {0}" -f $(if ($headSha) { $headSha.Substring(0,12) } else { 'n/a' }))

# Exactly ONE narrow self-repair: the canonical asset missing while a
# parcels-previous-* asset carries the digest we have committed is the
# unambiguous signature of a crash inside the P5-P6 swap window, and its fix
# is a single metadata PATCH. Every broader auto-repair is a cold branch that
# could replace a good new asset with a two-month-old one, so anything else
# is reported and left alone - this run's own publish will resolve it.
if ((-not $prevAsset) -and $headSha) {
  $candidate = @($rel0.assets) | Where-Object { $_.name -like 'parcels-previous-*.pmtiles' -and (Get-AssetDigest $_) -eq $headSha } | Select-Object -First 1
  if ($candidate) {
    Log "  preflight: canonical asset missing; $($candidate.name) matches the committed sha - restoring it"
    $fix = Invoke-Gh @('api', '--method', 'PATCH', $candidate.apiUrl, '-f', "name=$assetName") 90000
    if ($fix.ExitCode -eq 0) {
      Log "  preflight: repaired interrupted swap - restored $($candidate.name) to $assetName"
      Send-FailureMail -Subject 'Wpg Open Data: parcel-tile release RECOVERED at preflight' `
        -Body "The release had no asset named $assetName, and $($candidate.name) carried the committed checksum, so it was renamed back. This is the signature of a crash inside the publish swap. The overlay is serving again.`n`nLog: $log" |
        Tee-Object -FilePath $log -Append | Out-Null
      $rel0 = Read-ThisRelease 2
      $prevAsset  = Get-Asset $rel0 $assetName
      $prevDigest = Get-AssetDigest $prevAsset
    } else {
      Log "  preflight: repair PATCH failed (exit $($fix.ExitCode)): $(FirstLine $fix.StdErr)"
    }
  }
}
if ($prevAsset -and $headSha -and $prevDigest -and $prevDigest -ne $headSha) {
  Log '  WARNING: the published asset does not match the committed checksum. This run will republish and resolve it.'
}

# --- Step 1: rollback copy ------------------------------------------------
# One generation of local insurance. GATED ON PROOF: copy only when the local
# archive really is what is published. Task Scheduler retries the whole job
# twice on failure (RestartCount=2), and from step 2 onward the local file is
# the NEW build - so an ungated copy on a retry would overwrite the last good
# archive with an unpublished one and leave it beside a reverted old hash.
Log 'Step 1/6: rollback copy of the currently published archive'
if (-not (Test-Path $pmtilesPath)) {
  Log '  no local archive to copy (first run) - continuing.'
} else {
  $localNow = (Get-FileHash $pmtilesPath -Algorithm SHA256).Hash.ToLower()
  if ($prevDigest -and $localNow -eq $prevDigest) {
    New-Item -ItemType Directory -Force -Path $rollbackDir | Out-Null
    try {
      $tmpA = (Join-Path $rollbackDir 'parcels.pmtiles.tmp')
      Copy-Item $pmtilesPath $tmpA -Force -ErrorAction Stop
      Move-Item $tmpA (Join-Path $rollbackDir 'parcels.pmtiles') -Force -ErrorAction Stop
      Set-Content -Path (Join-Path $rollbackDir 'parcels.pmtiles.sha256') -Value $localNow -Encoding ascii -ErrorAction Stop
      @("Rollback copy taken $(Get-Date -Format 's') from $pmtilesPath",
        "sha256: $localNow",
        'Verified equal to the asset published on the GitHub release at the time of the copy.') |
        Set-Content -Path (Join-Path $rollbackDir 'README.txt') -ErrorAction Stop
      Log "  copied to $rollbackDir (sha $($localNow.Substring(0,12)))"
    } catch {
      Fail "rollback copy failed: $($_.Exception.Message)"
    }
  } else {
    Log '  rollback: local archive does not match the published digest - existing rollback copy left untouched (this is a retry of a failed run).'
  }
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

# --- Step 3b: PUCS drift notice (non-fatal) ------------------------------
# The City can add a residential property-use code at any time. Until someone
# classifies it, its parcels are silently missing from the dwelling-unit
# totals - an undercount with no symptom, because the overlay still renders.
# The build already detected this and wrote it to a log nobody reads; this
# turns it into mail. Deliberately NOT a failure: a classification question
# must not block a tile rebuild.
try {
  $meta = Get-Content (Join-Path $repo $metaRel) -Raw | ConvertFrom-Json
  # Absent field != empty list. A sidecar written before this check existed has
  # no such field, and treating that as "none unreviewed" would report all-clear
  # for something never evaluated - the trap _waterLoaded exists to avoid in the
  # web app.
  $hasField   = $meta.PSObject.Properties.Name -contains 'dwelling_unreviewed_pucs'
  $unreviewed = if ($hasField) { @($meta.dwelling_unreviewed_pucs) } else { @() }

  if (-not $hasField) {
    Log '  PUCS: sidecar predates the drift check (no dwelling_unreviewed_pucs field) - NOT evaluated.'
  } elseif ($unreviewed.Count) {
    $list = $unreviewed -join ', '
    Log "  PUCS DRIFT: $($unreviewed.Count) unreviewed residential code(s): $list"
    $body = @(
      "These City property-use codes look residential (CN*/RES*), are NOT counted as",
      "dwelling units, and have never been classified:",
      "",
      "  $list",
      "",
      "Parcels carrying them are missing from the Dwelling Units overlay totals.",
      "",
      "Decide each one in r/lib_dwelling_units.R:",
      "  - counts as housing  -> add to DWELLING_RESIDENTIAL_PUCS or DWELLING_CONDO_PUCS",
      "  - does not           -> add to DWELLING_REVIEWED_EXCLUSIONS with a reason",
      "Then re-run:  $selfCmd",
      "This stops as soon as the list is empty.",
      "",
      "Log: $log"
    ) -join "`n"
    Send-FailureMail -Subject "Wpg Open Data: $($unreviewed.Count) unreviewed residential PUCS code(s)" -Body $body |
      Tee-Object -FilePath $log -Append | Out-Null
  } else {
    Log '  PUCS: every residential-looking code is explicitly classified'
  }
} catch {
  Log "PUCS drift check errored (non-fatal): $($_.Exception.Message)"
}

# --- Step 4: refresh the pinned checksum ---------------------------------
# fetch-pmtiles.mjs verifies the downloaded asset against this value at
# deploy time, so it must be refreshed in the same run that uploads.
Log 'Step 4/6: refresh web/scripts/parcels.pmtiles.sha256'
# WAIT FOR THE ARCHIVE TO BE READABLE BEFORE HASHING IT.
#
# Dropbox keeps the freshly written ~99 MB archive open while it indexes and
# uploads it, and Get-FileHash cannot read it until that finishes. Measured
# on 2026-08-22: still failing 25s after the write, hashing in under a second
# at 85s. Both runs that day died here with the archive already built, which
# is 17 minutes of tiling discarded for a wait of about a minute.
#
# Poll on the condition that actually matters -- can the file be OPENED for
# read -- rather than on a fixed sleep, so a fast machine proceeds at once
# and a slow sync still completes. Ten minutes is far beyond the observed
# window and still well inside the task's 6h limit.
#
# LOG THE REASON. The first version of this swallowed the exception and
# logged a bare 'came back empty', which cost a whole second run to
# diagnose. Whatever fails here, say what it was.
$hash = ''
$hashDeadline = (Get-Date).AddMinutes(10)
$lastErr = 'no attempt made'
while ((Get-Date) -lt $hashDeadline) {
  try {
    $fs = [System.IO.File]::Open($pmtilesPath, 'Open', 'Read', 'Read')
    try {
      $sha = [System.Security.Cryptography.SHA256]::Create()
      $hash = (($sha.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $fs.Close() }
  } catch { $hash = ''; $lastErr = "$($_.Exception.GetType().Name): $($_.Exception.Message)" }
  if ($hash) { break }
  Log "  archive not readable yet ($lastErr); retrying in 10s"
  Start-Sleep -Seconds 10
}
if (-not $hash) { Fail "could not read $pmtilesPath to hash it within 10 minutes. Last error: $lastErr" }
$hash = $hash.ToLower()
try {
  Set-Content -Path $shaPath -Value $hash -Encoding ascii -ErrorAction Stop
} catch {
  Fail "could not write $shaRel : $($_.Exception.Message)"
}
# Read it back. An unchecked write here would commit the OLD hash against the
# NEW live archive - the one state the deploy rejects - and the run would still
# report success.
$written = ''
try { $written = (Get-Content $shaPath -Raw -ErrorAction Stop).Trim().ToLower() } catch {}
if ($written -ne $hash) { Fail "checksum file did not persist correctly (wrote $hash, read back '$written')." }
Log "  sha256: $hash"

# --- Step 5: publish (upload -> verify -> swap) --------------------------
# The sequence itself lives in r/lib_gh.ps1 so it can be exercised by
# r/test_gh_publish.ps1 against scratch asset names. See this file's header
# for why it is not `--clobber`.
Log 'Step 5/6: publish (upload -> verify -> swap)'

# Wall-clock ceiling computed from the clock, not from an attempt count, so a
# machine sleep during a backoff aborts safely instead of silently extending
# the run. ~55 min worst case sits well inside ExecutionTimeLimit PT6H
# alongside the ~20-minute build.
$publishDeadline = (Get-Date).AddMinutes(45)

$pub = Publish-ReleaseAsset -Tag $releaseTag -Repo $ghRepo -CanonicalName $assetName `
         -FilePath $pmtilesPath -Sha256 $hash -StagingDir $stagingDir `
         -Deadline $publishDeadline -LogAction $LogCb

# Set the flag BEFORE any failure branch: it is what stops Fail() from
# reverting the checksum over bytes that are already live.
if ($pub.NewIsLive) { $script:newArchiveIsLive = $true }

if ($pub.Status -ne 'published') { Fail $pub.Message }

# Only report degraded verification once the publish actually succeeded -
# otherwise a run that failed later still mails "the publish proceeded".
if ($pub.Degraded) {
  Send-FailureMail -Subject 'Wpg Open Data: parcel-tile publish verified by SIZE only' `
    -Body "GitHub reported no sha256 digest for the uploaded asset after 60s, so it was verified by byte size only. The publish proceeded. Worth a look if this recurs.`n`nLog: $log" |
    Tee-Object -FilePath $log -Append | Out-Null
}

# P7 - confirm. Three outcomes, not two. An unreadable release is a warning
# (the promote already returned success, so the bytes are live and reverting
# would be exactly wrong). But a release that reads cleanly and shows the WRONG
# archive under the canonical name is a real defect, and continuing to commit
# and push a checksum for bytes that are not serving would pin a mismatch on
# origin/main - broken on every future deploy.
$relF = Read-ThisRelease 2
$canonF = Get-Asset $relF $assetName
$digF = Get-AssetDigest $canonF
if ($digF -and $digF -eq $hash) {
  Log "  published: $assetName digest $($hash.Substring(0,12))"
} elseif (-not $relF) {
  Log '  WARNING: post-swap confirmation could not read the release (the promote itself succeeded; continuing).'
} elseif (-not $digF) {
  Log '  WARNING: post-swap confirmation read reported no digest (the promote itself succeeded; continuing).'
} else {
  Fail "post-swap confirmation shows $assetName carrying $digF, not the $hash we just published - refusing to commit a checksum for an archive that is not serving."
}

# Keep the newest previous-generation asset as insurance, prune older ones.
# Restoring from it costs one metadata call, versus a 96 MB upload from the
# local rollback copy - which is why the failure path never needs that copy.
$olds = @(@($relF.assets) | Where-Object { $_.name -like 'parcels-previous-*.pmtiles' } | Sort-Object name -Descending | Select-Object -Skip 1)
foreach ($o in $olds) {
  $d = Invoke-Gh @('release', 'delete-asset', $releaseTag, $o.name, '--repo', $ghRepo, '--yes') 90000
  Log "  prune: $($o.name) $(if ($d.ExitCode -eq 0) { 'deleted' } else { 'delete failed (ignored)' })"
}

# --- Step 6: commit + push the two tracked files -------------------------
# ONLY meta + sha are staged, so this never sweeps up unrelated working-tree
# changes, and the push is not forced.
Log 'Step 6/6: commit + push meta + sha (Vercel auto-deploys)'
$changed = & git -C $repo status --porcelain -- $metaRel $shaRel
if (-not $changed) {
  # "Nothing to commit" is only an all-clear if the checksum already REACHED
  # origin/main. On a re-run after a push failure the working tree is clean
  # (the commit exists locally) while origin/main still pins the old hash - so
  # exiting 0 here and deleting the FAILED markers would erase the only signal
  # for an outage that is still live.
  $headNow   = Get-CommittedSha 'HEAD'
  $originNow = Get-CommittedSha 'origin/main'
  if ($headNow -and $originNow -and $headNow -eq $originNow -and $headNow -eq $hash) {
    Log '  no change to meta/sha, and origin/main already pins this archive - nothing to deploy.'
    Get-ChildItem $archiveRoot -File -Filter 'FAILED-tiles-*.txt' -ErrorAction SilentlyContinue |
      ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue; Log "cleared stale marker $($_.Name)" }
    Log '=== done ==='
    exit 0
  }
  Log "  no working-tree change, but origin/main pins '$originNow' and this archive is '$hash' - the commit still needs to reach origin."
  $script:pushFailed = $true
  Fail 'the published archive is not pinned on origin/main and there is nothing left to commit - push the existing commit (git -C <repo> push origin main).'
}

& git -C $repo add -- $metaRel $shaRel
$msg = "Rebuild citywide parcel tiles (scheduled bi-monthly)`n`nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
& git -C $repo commit -m $msg *>> $log 2>&1
if ($LASTEXITCODE -ne 0) {
  # Fail() will NOT revert now: $newArchiveIsLive is true, and reverting would
  # pin the old hash against the new bytes - broken on every future deploy.
  Fail "git commit failed (exit $LASTEXITCODE) - the new asset is live but its checksum is not committed."
}

# Pushing an already-made commit is idempotent, so retrying is free. The
# likeliest 03:00 push failure is a non-fast-forward because something landed
# on origin/main during the ~20-minute build; the commit touches only two
# files nobody else edits, so a rebase is safe.
$pushed = $false
foreach ($wait in @(0, 15, 60)) {
  if ($wait -gt 0) {
    Log "  push failed - pulling --rebase and retrying in ${wait}s"
    Start-Sleep -Seconds $wait
    & git -C $repo pull --rebase origin main *>> $log 2>&1
  }
  & git -C $repo push origin main *>> $log 2>&1
  if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
}
if (-not $pushed) {
  $script:pushFailed = $true
  Fail 'git push failed after 3 attempts - the new asset is live but its checksum is not on origin/main.'
}

# A clean run supersedes any earlier FAILED marker.
Get-ChildItem $archiveRoot -File -Filter 'FAILED-tiles-*.txt' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue; Log "cleared stale marker $($_.Name)" }

Log 'Pushed. Vercel will rebuild and fetch-pmtiles.mjs will pull the new asset.'
Log '=== done ==='

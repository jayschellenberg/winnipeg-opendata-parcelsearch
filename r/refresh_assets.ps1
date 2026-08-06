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
# Quoted in alarm emails. Built from $repo so it cannot drift, and ABSOLUTE
# because a relative path pasted out of an alert only works if the shell
# happens to be sitting in the repo root.
$rebuildCmd = "powershell -ExecutionPolicy Bypass -File $(Join-Path $repo 'r\rebuild_tiles.ps1')"
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
# Runs FIRST so every quarterly invocation checks it - the common "no asset
# changes" outcome exits early below and must not skip the tripwire. Non-fatal
# to the asset refresh either way.
#
# SCHEDULE-AWARE, not a fixed age. This used to allow a flat 200 days, which
# had a blind spot: the captures are semi-annual (Jun 1 / Dec 1) but the checks
# are quarterly, so the allowance had to cover a healthy 122-day gap, and a
# snapshot taken off-cycle shrank the margin below one missed run. Concretely,
# with the newest capture at 2026-07-01, a missed Dec 1 2026 download would be
# only 184 days old at the Jan 1 2027 check and would NOT have tripped - the
# miss would have surfaced in April at the earliest.
#
# Instead: work out the most recent scheduled capture that has had time to
# finish, and require the archive to contain it. Healthy always passes,
# a missed run is caught at the very next quarterly check, and there is no
# day-count to re-tune when a capture lands off-cycle.
$graceDays = 21   # StartWhenAvailable can defer a run to the next logon
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
    # Latest Jun 1 / Dec 1 that is at least $graceDays in the past. Two years
    # of candidates so a January check still sees the previous December.
    $cutoff = (Get-Date).Date.AddDays(-$graceDays)
    $due = @()
    foreach ($y in @($cutoff.Year, ($cutoff.Year - 1))) {
      $due += (Get-Date -Year $y -Month 6  -Day 1).Date
      $due += (Get-Date -Year $y -Month 12 -Day 1).Date
    }
    $expected = $due | Where-Object { $_ -le $cutoff } | Sort-Object -Descending | Select-Object -First 1
    $ageDays  = [int]((Get-Date) - $newest).TotalDays
    Log ("snapshot heartbeat: newest {0} ({1} days old); must be on/after the {2} capture" -f
      $newest.ToString('yyyy-MM-dd'), $ageDays, $expected.ToString('yyyy-MM-dd'))
    if ($newest -lt $expected) {
      $why = "snapshot heartbeat: newest AssessmentParcels snapshot is $($newest.ToString('yyyy-MM-dd')) ($ageDays days old), but the $($expected.ToString('yyyy-MM-dd')) capture should already be archived. The semi-annual download likely never fired - run it manually and check the WpgOpenDataSemiAnnualDownload task:  powershell -ExecutionPolicy Bypass -File $(Join-Path $repo 'r\scheduled_download.ps1')"
      Log "WARNING: $why"; Mail-Fail $why
      @("$(Get-Date -Format 's')  snapshot heartbeat tripped", "Reason: $why") |
        Set-Content -Path (Join-Path $archiveRoot ("STALE-snapshots-{0}.txt" -f (Get-Date -Format 'yyyy-MM-dd')))
    }
  }
} catch {
  Log "snapshot heartbeat check errored (non-fatal): $($_.Exception.Message)"
}

# --- Parcel-tile-age heartbeat (alert on ABSENCE) --------------------------
# Same reasoning as the snapshot heartbeat above, for the bi-monthly tile
# rebuild (WpgParcelTilesBiMonthly -> r/rebuild_tiles.ps1). A FAILED run emails
# for itself; this is the tripwire for the run that NEVER STARTS - a disabled
# task, or a machine that was off through the whole window.
#
# 80 days: this job runs Jan/Apr/Jul/Oct 1 and tiles rebuild on the 2nd of even
# months, so the newest healthy build seen here is ~60 days old (Oct 1 sees the
# Aug 2 build). One missed rebuild pushes that to ~120, which 80 catches at the
# very next quarterly check instead of a quarter later.
#
# Reads the same committed sidecar the app serves, so this alarm and the
# overlay's "Tile snapshot as of" line can never disagree.
$maxTileAgeDays = 80
try {
  $metaPath = Join-Path $repo 'web\public\parcels-pmtiles-meta.json'
  if (-not (Test-Path $metaPath)) {
    $why = "tile heartbeat: no parcels-pmtiles-meta.json at $metaPath - the citywide overlay may never have been built."
    Log "WARNING: $why"; Mail-Fail $why
  } else {
    $built = (Get-Content $metaPath -Raw | ConvertFrom-Json).built
    $builtDate = [datetime]::ParseExact($built, 'yyyy-MM-dd', $null)
    $tileAge = [int]((Get-Date) - $builtDate).TotalDays
    Log "tile heartbeat: parcels.pmtiles built $built ($tileAge days old; limit $maxTileAgeDays)"
    if ($tileAge -gt $maxTileAgeDays) {
      $why = "tile heartbeat: the citywide parcel tiles are $tileAge days old (> $maxTileAgeDays). The bi-monthly rebuild likely never fired - run it manually and check the WpgParcelTilesBiMonthly task:  $rebuildCmd"
      Log "WARNING: $why"; Mail-Fail $why
      @("$(Get-Date -Format 's')  tile heartbeat tripped", "Reason: $why") |
        Set-Content -Path (Join-Path $archiveRoot ("STALE-tiles-{0}.txt" -f (Get-Date -Format 'yyyy-MM-dd')))
    }
  }
} catch {
  Log "tile heartbeat check errored (non-fatal): $($_.Exception.Message)"
}

# --- Release liveness check (is the overlay actually SERVABLE?) -------------
# The age heartbeat above reads only the committed sidecar, so it answers "were
# the tiles rebuilt recently" and NOT "can the deploy still fetch them". On
# 2026-08-05 a failed publish left the GitHub release with zero assets while
# that sidecar was perfectly fresh - the age check would have reported all-clear
# for as long as it took someone to read an email.
#
# This is the one property fetch-pmtiles.mjs actually tests at deploy time:
# the asset exists, is finalised, and its sha256 equals the committed one.
# One API call, no bytes transferred. Non-fatal to the asset refresh.
function Short($h) {
  if (-not $h) { return 'n/a' }
  if ($h.Length -le 12) { return $h }
  return $h.Substring(0, 12)
}
try {
  . (Join-Path $PSScriptRoot 'lib_gh.ps1')
  $ghRepo     = 'jayschellenberg/winnipeg-opendata-parcelsearch'
  $releaseTag = 'parcels-pmtiles'
  $assetName  = 'parcels.pmtiles'
  $shaFile    = Join-Path $repo 'web\scripts\parcels.pmtiles.sha256'

  if (-not (Initialize-Gh)) {
    # Fail LOUD, not open: a watchdog that goes quiet when its tool disappears
    # is indistinguishable from a healthy system, which is the failure mode
    # this whole exercise exists to remove.
    $why = 'release liveness: gh.exe is not on PATH, so the published release could NOT be checked. The overlay may be down without any alarm.'
    Log "WARNING: $why"; Mail-Fail $why
  } else {
    # Compare against ORIGIN/MAIN, not the working tree. Vercel builds from
    # origin/main, so that is the checksum the deploy will actually enforce -
    # and on a run that published but failed to push, the working-tree file
    # already holds the new hash and would give a false all-clear for exactly
    # the outage this check was added to catch.
    $committed = ''
    $fromGit = & git -C $repo show "origin/main:web/scripts/parcels.pmtiles.sha256" 2>$null
    if ($LASTEXITCODE -eq 0 -and $fromGit) {
      $committed = ("$fromGit").Trim().ToLower().Split()[0]
    } elseif (Test-Path $shaFile) {
      Log 'release liveness: could not read the checksum from origin/main - falling back to the working-tree copy.'
      $committed = (Get-Content $shaFile -Raw).Trim().ToLower()
    }
    $rel   = Read-Release $releaseTag $ghRepo 3 $null
    $asset = Get-Asset $rel $assetName
    $dig   = Get-AssetDigest $asset

    if (-not $rel) {
      Log 'release liveness: the release could not be read - NOT evaluated (no alarm raised on an unknown).'
    } elseif (-not $asset) {
      $why = "release liveness: the GitHub release has NO asset named $assetName. Every Vercel deploy from now on ships with the parcel overlay DISABLED. Re-publish with:  $rebuildCmd"
      Log "WARNING: $why"; Mail-Fail $why
      @("$(Get-Date -Format 's')  release liveness tripped", "Reason: $why") |
        Set-Content -Path (Join-Path $archiveRoot ("STALE-tiles-{0}.txt" -f (Get-Date -Format 'yyyy-MM-dd')))
    } elseif ($asset.state -ne 'uploaded') {
      $why = "release liveness: asset $assetName is in state '$($asset.state)', not 'uploaded' - it is not downloadable. Re-publish with:  $rebuildCmd"
      Log "WARNING: $why"; Mail-Fail $why
    } elseif ($committed -and $dig -and $dig -ne $committed) {
      # Short() rather than .Substring(0,12): a truncated or empty checksum
      # file would throw here, and the outer catch would swallow the ALARM -
      # the one path that must never fail silently.
      $why = "release liveness: the published asset ($(Short $dig)) does not match the checksum on origin/main ($(Short $committed)). fetch-pmtiles.mjs rejects that, so the overlay is disabled on every deploy. Re-publish with:  $rebuildCmd"
      Log "WARNING: $why"; Mail-Fail $why
      @("$(Get-Date -Format 's')  release liveness tripped", "Reason: $why") |
        Set-Content -Path (Join-Path $archiveRoot ("STALE-release-{0}.txt" -f (Get-Date -Format 'yyyy-MM-dd')))
    } else {
      Log "release liveness: OK - $assetName state=uploaded digest=$(Short $dig) matches the checksum on origin/main"
    }
  }
} catch {
  Log "release liveness check errored (non-fatal): $($_.Exception.Message)"
}

# --- Aerial-ortho year consistency (alert on DRIFT in either direction) ----
# ORTHO_YEARS in web/src/map.js is hand-maintained and nothing connects it to
# the archives actually on R2, so both directions can drift silently: a listed
# year with no archive renders a BLANK basemap with no error, and an archive
# nobody listed is 14-18 GB paid for and invisible. Old imagery never expires,
# so neither has a natural signal.
#
# Probes the header of each candidate year (128 bytes each, not the archive),
# so the whole check moves a couple of KB. Non-fatal to the asset refresh.
try {
  . (Join-Path $PSScriptRoot 'lib_ortho.ps1')
  $orthoBase = 'https://pub-f351b204f73e4b2287acad946d79681c.r2.dev'
  $mapJs     = Join-Path $repo 'web\src\map.js'
  $parsed    = Get-OrthoYearsFromSource $mapJs

  if (-not $parsed.Found) {
    $why = "ortho check: could not find ORTHO_YEARS in $mapJs. Either the file moved or the declaration changed shape - the aerial-year check is now blind."
    Log "WARNING: $why"; Mail-Fail $why
  } else {
    $listed = @($parsed.Years)
    Log ("ortho check: map.js offers " + $(if ($listed.Count) { $listed -join ', ' } else { '(none)' }))
    # Candidate window: a couple of years either side of what is listed, up to
    # next year, so a newly built archive is discovered without probing a
    # pointless span.
    $lo = if ($listed.Count) { ([int]($listed | Measure-Object -Minimum).Minimum) - 2 } else { (Get-Date).Year - 12 }
    $hi = (Get-Date).Year + 1
    $infos = @()
    foreach ($y in $lo..$hi) { $infos += Get-OrthoArchiveInfo $orthoBase $y 20 }
    $found = @(@($infos) | Where-Object { $_.Present } | ForEach-Object { $_.Year })
    Log ("ortho check: R2 has " + $(if ($found.Count) { $found -join ', ' } else { '(none)' }))

    $cmp = Compare-OrthoYears $listed $infos
    if (@($cmp.Unreached).Count) { Log ("ortho check: not reached (state unknown, no alarm): " + ($cmp.Unreached -join ', ')) }

    if ($cmp.Healthy) {
      Log 'ortho check: OK - every listed year has a valid archive, and every archive is listed'
    } else {
      $parts = @()
      if (@($cmp.Missing).Count)      { $parts += "LISTED BUT MISSING on R2: $($cmp.Missing -join ', ') - those years render a BLANK aerial basemap. Either rebuild/upload them (r\build_ortho_tiles.ps1) or remove them from ORTHO_YEARS in web/src/map.js." }
      if (@($cmp.Unlisted).Count)     { $parts += "ON R2 BUT NOT OFFERED: $($cmp.Unlisted -join ', ') - the archive exists and nobody can see it. Add the year to ORTHO_YEARS in web/src/map.js, keeping the list newest-first." }
      if (@($cmp.ZoomMismatch).Count) { $parts += "ZOOM RANGE MISMATCH: $($cmp.ZoomMismatch -join '; ') - map.js declares 12..20, so the layer will blank outside the archive's real range." }
      $why = "ortho check: " + ($parts -join '  ')
      Log "WARNING: $why"; Mail-Fail $why
      @("$(Get-Date -Format 's')  ortho year check tripped", "Reason: $why") |
        Set-Content -Path (Join-Path $archiveRoot ("STALE-ortho-{0}.txt" -f (Get-Date -Format 'yyyy-MM-dd')))
    }
  }
} catch {
  Log "ortho check errored (non-fatal): $($_.Exception.Message)"
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

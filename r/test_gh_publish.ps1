# test_gh_publish.ps1
#
# Exercises r/lib_gh.ps1 for real: unit checks on the pure helpers, then a live
# upload-verify-swap against the ACTUAL GitHub release using SCRATCH asset
# names and a few KB of data.
#
# Why live rather than mocked: the 2026-08-05 outage was caused by the exact
# semantics of gh's release commands (--clobber deletes before it uploads), and
# a mock would have asserted my belief about gh rather than gh's behaviour. The
# scratch names mean the canonical parcels.pmtiles asset is never touched.
#
#   powershell -ExecutionPolicy Bypass -File r\test_gh_publish.ps1
#
# ASCII-ONLY (see lib_mail.ps1).

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib_gh.ps1')

$ghRepo     = 'jayschellenberg/winnipeg-opendata-parcelsearch'
$releaseTag = 'parcels-pmtiles'
$PROD_ASSET = 'parcels.pmtiles'

# Every name this test writes is prefixed so it can never collide with the
# production asset. Asserted, not merely intended.
$canonical = 'selftest-canonical.pmtiles'
$incomingP = 'selftest-incoming'
$previousP = 'selftest-previous'
if ($canonical -eq $PROD_ASSET -or $incomingP -eq 'parcels-incoming' -or $previousP -eq 'parcels-previous') {
  Write-Output 'REFUSING TO RUN: scratch names overlap the production asset names.'
  exit 1
}

$staging = Join-Path $env:TEMP 'wpg-gh-selftest'
New-Item -ItemType Directory -Force -Path $staging | Out-Null

$passed = 0; $failed = 0
function Check($name, $cond, $detail = '') {
  if ($cond) { $script:passed++; Write-Output "  PASS  $name" }
  else       { $script:failed++; Write-Output "  FAIL  $name $detail" }
}
$logCb = { param($m) Write-Output "        $m" }

Write-Output '=== lib_gh unit checks (no network) ==='

Check 'FirstLine takes the first non-blank line' ((FirstLine "`n`nhello`nworld") -eq 'hello')
Check 'FirstLine tolerates empty/null' ((FirstLine '') -eq '' -and (FirstLine $null) -eq '')

$fakeRel = '{"assets":[{"name":"a.pmtiles","digest":"sha256:AABB","state":"uploaded","size":10,"apiUrl":"u1"}]}' | ConvertFrom-Json
Check 'Get-Asset finds by exact name'      ((Get-Asset $fakeRel 'a.pmtiles').apiUrl -eq 'u1')
Check 'Get-Asset misses cleanly'           ($null -eq (Get-Asset $fakeRel 'nope.pmtiles'))
Check 'Get-Asset on a null release'        ($null -eq (Get-Asset $null 'a.pmtiles'))
Check 'Get-AssetDigest strips sha256: and lowercases' ((Get-AssetDigest (Get-Asset $fakeRel 'a.pmtiles')) -eq 'aabb')
Check 'Get-AssetDigest on a null asset'    ((Get-AssetDigest $null) -eq '')

# A single-asset release must still behave as a collection - the @() in
# Get-Asset is what makes this true.
$oneRel = '{"assets":[{"name":"only.pmtiles","digest":null,"state":"open","size":1,"apiUrl":"u2"}]}' | ConvertFrom-Json
Check 'single-element assets array indexes correctly' ((Get-Asset $oneRel 'only.pmtiles').apiUrl -eq 'u2')
Check 'null digest yields empty, not a crash'         ((Get-AssetDigest (Get-Asset $oneRel 'only.pmtiles')) -eq '')

$emptyRel = '{"assets":[]}' | ConvertFrom-Json
Check 'empty assets array is handled' ($null -eq (Get-Asset $emptyRel 'x'))

# Get-Backoff must never hand Start-Sleep a $null, whatever the caller passes.
Check 'Get-Backoff first attempt'          ((Get-Backoff @(60, 240) 1) -eq 60)
Check 'Get-Backoff second attempt'         ((Get-Backoff @(60, 240) 2) -eq 240)
Check 'Get-Backoff past the end clamps'    ((Get-Backoff @(60, 240) 3) -eq 240)
Check 'Get-Backoff far past the end clamps' ((Get-Backoff @(60, 240) 99) -eq 240)
Check 'Get-Backoff attempt 0 clamps low'   ((Get-Backoff @(60, 240) 0) -eq 60)
Check 'Get-Backoff on an empty list'       ((Get-Backoff @() 1) -eq 30)
Check 'Get-Backoff on a null list'         ((Get-Backoff $null 1) -eq 30)

Write-Output ''
Write-Output '=== Invoke-Gh (live, read-only) ==='
$exe = Initialize-Gh
Check 'gh.exe resolves' ([bool]$exe) $exe
if (-not $exe) { Write-Output 'cannot continue without gh'; exit 1 }

$v = Invoke-Gh @('--version') 30000
Check 'Invoke-Gh returns exit 0 for --version' ($v.ExitCode -eq 0) "exit=$($v.ExitCode)"
Check 'Invoke-Gh captures stdout'              ($v.StdOut -match 'gh version')
Check 'Invoke-Gh reports TimedOut=false'       ($v.TimedOut -eq $false)

# The timeout path must kill the process AND still return a usable exit code.
# Without `$null = $p.Handle` in the library, ExitCode reads empty here and a
# successful publish would later be scored a failure.
$slow = Invoke-Gh @('api', 'repos/cli/cli', '--jq', '.name') 1
Check 'a 1ms timeout is reported and does not hang' ($slow.TimedOut -eq $true -or $slow.ExitCode -ne 0) "timedOut=$($slow.TimedOut) exit=$($slow.ExitCode)"
Check 'ExitCode is never empty after a timed wait'  ($null -ne $slow.ExitCode)

$bad = Invoke-Gh @('release', 'view', 'no-such-tag-xyz', '--repo', $ghRepo, '--json', 'assets') 30000
Check 'a failing gh call reports non-zero'     ($bad.ExitCode -ne 0) "exit=$($bad.ExitCode)"
Check 'a failing gh call captures stderr'      ([bool]$bad.StdErr.Trim())

$rel = Read-Release $releaseTag $ghRepo 2 $logCb
Check 'Read-Release parses the live release'   ($null -ne $rel)
Check 'the production asset is present'        ($null -ne (Get-Asset $rel $PROD_ASSET))
$prodDigestBefore = Get-AssetDigest (Get-Asset $rel $PROD_ASSET)
Check 'the production asset reports a digest'  ([bool]$prodDigestBefore) $prodDigestBefore
# Without a real baseline the "production unchanged" assertions at the end are
# vacuous ('' -eq ''), so refuse to continue rather than report a false pass.
if (-not $prodDigestBefore) {
  Write-Output 'ABORTING: no baseline digest for the production asset - the safety assertions would be vacuous.'
  exit 1
}

Write-Output ''
Write-Output '=== Get-CanonicalState (live, read-only) - the function every post-mutation decision goes through ==='
$bogus = 'ff' * 32
Check "reports 'new' when the canonical asset carries the sha we claim is new" `
  ((Get-CanonicalState $releaseTag $ghRepo $PROD_ASSET $prodDigestBefore $bogus $null) -eq 'new')
Check "reports 'previous' when it carries the sha we claim is previous" `
  ((Get-CanonicalState $releaseTag $ghRepo $PROD_ASSET $bogus $prodDigestBefore $null) -eq 'previous')
Check "reports 'other' when it matches neither" `
  ((Get-CanonicalState $releaseTag $ghRepo $PROD_ASSET $bogus ('ee' * 32) $null) -eq 'other')
Check "reports 'absent' for a name that does not exist" `
  ((Get-CanonicalState $releaseTag $ghRepo 'no-such-asset-xyz.pmtiles' $bogus $bogus $null) -eq 'absent')
Check "reports 'unknown' when the release cannot be read" `
  ((Get-CanonicalState 'no-such-tag-xyz' $ghRepo $PROD_ASSET $bogus $bogus $null) -eq 'unknown')

Write-Output ''
Write-Output '=== Publish-ReleaseAsset (live, scratch asset names) ==='

function New-TestFile($path, $seed, $kb) {
  $rng = New-Object System.Random($seed)
  $buf = New-Object byte[] ($kb * 1024)
  $rng.NextBytes($buf)
  [IO.File]::WriteAllBytes($path, $buf)
  (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
}

$fileA = Join-Path $staging 'A.bin'; $shaA = New-TestFile $fileA 11 64
$fileB = Join-Path $staging 'B.bin'; $shaB = New-TestFile $fileB 22 64
Check 'the two fixtures differ' ($shaA -ne $shaB)

$deadline = (Get-Date).AddMinutes(10)
$common = @{
  Tag = $releaseTag; Repo = $ghRepo; CanonicalName = $canonical; StagingDir = $staging
  Deadline = $deadline; IncomingPrefix = $incomingP; PreviousPrefix = $previousP
  LogAction = $logCb; Backoffs = @(5, 10); UploadTimeoutMs = 120000
}

Write-Output '--- the staging-path guard (a space would corrupt the gh argv) ---'
$guardArgs = $common.Clone()
$guardArgs.StagingDir = 'D:\path with spaces'
$guard = Publish-ReleaseAsset @guardArgs -FilePath $fileA -Sha256 $shaA
Check 'a staging path containing a space is refused' ($guard.Status -eq 'failed' -and $guard.Message -match 'space') $guard.Message
Check 'the refusal does not claim anything is live'  ($guard.NewIsLive -eq $false)

Write-Output '--- P1 prune actually removes a leftover staging asset ---'
# Seed the exact shape an interrupted run leaves behind, so the prune body
# genuinely executes instead of iterating over an empty set.
$seedName = "$incomingP-seed-test.pmtiles"
$seedPath = Join-Path $staging $seedName
Copy-Item $fileA $seedPath -Force
$seedUp = Invoke-Gh @('release', 'upload', $releaseTag, $seedPath, '--repo', $ghRepo) 120000
Check 'seeded a leftover staging asset' ($seedUp.ExitCode -eq 0) (FirstLine $seedUp.StdErr)
Remove-Item $seedPath -Force -ErrorAction SilentlyContinue
$relSeed = Read-Release $releaseTag $ghRepo 2 $logCb
Check 'the seeded leftover is really on the release' ($null -ne (Get-Asset $relSeed $seedName))

Write-Output '--- first publish (canonical name does not exist yet) ---'
$r1 = Publish-ReleaseAsset @common -FilePath $fileA -Sha256 $shaA
Check 'first publish reports published' ($r1.Status -eq 'published') $r1.Message
Check 'first publish sets NewIsLive'    ($r1.NewIsLive -eq $true)
$rel = Read-Release $releaseTag $ghRepo 2 $logCb
Check 'canonical asset now carries A'   ((Get-AssetDigest (Get-Asset $rel $canonical)) -eq $shaA)

Write-Output '--- second publish (THE SWAP: different content over a live asset) ---'
$r2 = Publish-ReleaseAsset @common -FilePath $fileB -Sha256 $shaB
Check 'second publish reports published' ($r2.Status -eq 'published') $r2.Message
Check 'second publish sets NewIsLive'    ($r2.NewIsLive -eq $true)
$rel = Read-Release $releaseTag $ghRepo 2 $logCb
Check 'canonical asset now carries B'    ((Get-AssetDigest (Get-Asset $rel $canonical)) -eq $shaB)
$prevAsset = @($rel.assets) | Where-Object { $_.name -like "$previousP-*" } | Select-Object -First 1
Check 'the displaced asset was kept aside, not deleted' ($null -ne $prevAsset)
Check 'the kept-aside asset is the OLD content (A)'     ((Get-AssetDigest $prevAsset) -eq $shaA)

Write-Output '--- third publish (same content: must short-circuit, not re-upload) ---'
$t0 = Get-Date
$r3 = Publish-ReleaseAsset @common -FilePath $fileB -Sha256 $shaB
$elapsed = ((Get-Date) - $t0).TotalSeconds
Check 'third publish reports published'      ($r3.Status -eq 'published') $r3.Message
Check 'third publish is a no-op short-circuit' ($r3.Message -eq 'already published') $r3.Message
Check 'short-circuit is fast (no re-upload)'   ($elapsed -lt 30) "took ${elapsed}s"

Write-Output '--- SECOND swap on the same calendar day (what a scheduler retry does) ---'
# The previous-generation name used to be date-only, so this swap collided with
# the one above and P5 could never succeed - meaning the bug fired on the
# RECOVERY attempt rather than the happy path. Publishing A again forces a real
# second swap within the same day.
$r4 = Publish-ReleaseAsset @common -FilePath $fileA -Sha256 $shaA
Check 'a second same-day swap succeeds' ($r4.Status -eq 'published') $r4.Message
Check 'the second same-day swap is live'  ($r4.NewIsLive -eq $true)
$rel = Read-Release $releaseTag $ghRepo 2 $logCb
Check 'canonical carries A again after the second swap' ((Get-AssetDigest (Get-Asset $rel $canonical)) -eq $shaA)
$prevs = @(@($rel.assets) | Where-Object { $_.name -like "$previousP-*" })
Check 'the two same-day previous assets have distinct names' ($prevs.Count -eq 2) "names: $(@($prevs).name -join ', ')"

Write-Output '--- no staging leftovers ---'
$rel = Read-Release $releaseTag $ghRepo 2 $logCb
# Assert the read worked first: every check below is vacuously true against a
# $null release, which would turn a broken cleanup into a green test.
Check 'the release is readable for the leftover checks' ($null -ne $rel)
$leftover = @(@($rel.assets) | Where-Object { $_.name -like "$incomingP-*" })
Check 'no selftest-incoming-* assets remain on the release' ($leftover.Count -eq 0) "found $(@($leftover).name -join ', ')"
Check 'the seeded leftover was pruned by P1' ($null -eq (Get-Asset $rel $seedName))
Check 'no staging files left on disk' (-not (Get-ChildItem $staging -Filter "$incomingP-*" -ErrorAction SilentlyContinue))

Write-Output '--- the production asset was never touched ---'
$prodAfter = Get-Asset $rel $PROD_ASSET
Check 'production asset still present'      ($null -ne $prodAfter)
Check 'production asset digest unchanged'   ((Get-AssetDigest $prodAfter) -eq $prodDigestBefore)

Write-Output ''
Write-Output '=== cleanup ==='
foreach ($a in @($rel.assets)) {
  if ($a.name -like 'selftest-*') {
    $d = Invoke-Gh @('release', 'delete-asset', $releaseTag, $a.name, '--repo', $ghRepo, '--yes') 90000
    Write-Output "  removed $($a.name) $(if ($d.ExitCode -eq 0) { 'ok' } else { 'FAILED' })"
  }
}
$relEnd = Read-Release $releaseTag $ghRepo 2 $logCb
Check 'the release is readable for the cleanup checks' ($null -ne $relEnd)
$stragglers = @(@($relEnd.assets) | Where-Object { $_.name -like 'selftest-*' })
Check 'all scratch assets removed' ($stragglers.Count -eq 0) "left: $(@($stragglers).name -join ', ')"
$prodEnd = Get-AssetDigest (Get-Asset $relEnd $PROD_ASSET)
Check 'production asset survived cleanup' ([bool]$prodEnd -and $prodEnd -eq $prodDigestBefore) "before=$prodDigestBefore after=$prodEnd"
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue

Write-Output ''
Write-Output "$passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }
exit 0

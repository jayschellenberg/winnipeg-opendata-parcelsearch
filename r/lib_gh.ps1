# lib_gh.ps1
#
# GitHub-release publishing primitives for r/rebuild_tiles.ps1.
#
# Extracted into a library for one reason: the publish sequence is the code
# that caused the 2026-08-05 outage, it runs unattended six times a year, and
# inline it could not be exercised without publishing 96 MB to production.
# r/test_gh_publish.ps1 drives everything here against scratch asset names on
# the real release, so the swap, the verification poll and the compensator are
# warm code by the time they matter.
#
# ASCII-ONLY (see lib_mail.ps1): Windows PowerShell 5.1 reads a BOM-less .ps1
# as the ANSI codepage, so a non-ASCII byte in a string literal corrupts the
# parse silently.

$script:GhExe = $null

function Initialize-Gh {
  $script:GhExe = (Get-Command gh.exe -ErrorAction SilentlyContinue).Source
  # gh hygiene: the update-notifier banner and ANSI colour can interleave with
  # output that ConvertFrom-Json is about to read.
  $env:GH_NO_UPDATE_NOTIFIER = '1'
  $env:NO_COLOR              = '1'
  $env:GH_PAGER              = 'cat'
  return $script:GhExe
}

function FirstLine($text) {
  if (-not $text) { return '' }
  (($text -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
}

# Bounded, capturable gh invocation.
#
# Start-Process with the two streams redirected to SEPARATE files (5.1 throws
# if both point at one path) keeps gh's stderr out of the PowerShell pipeline,
# so the NativeCommandError hazard cannot occur and the log gets one clean line
# instead of a multi-line error blob. WaitForExit(ms) bounds the hang: gh sets
# no deadline of its own, and the only other backstop is the task's
# ExecutionTimeLimit, which kills from outside so no handler runs and no email
# is ever sent.
#
# `$null = $p.Handle` is NOT optional: without it $p.ExitCode reads EMPTY after
# a timed WaitForExit, and an empty value compared -ne 0 is true - a SUCCESSFUL
# publish would be scored a failure and compensated backwards over good bytes.
#
# Arguments must not contain spaces: Start-Process joins the array on spaces.
function Invoke-Gh([string[]]$GhArgs, [int]$TimeoutMs = 90000) {
  if (-not $script:GhExe) { Initialize-Gh | Out-Null }
  if (-not $script:GhExe) {
    return [PSCustomObject]@{ ExitCode = -1; StdOut = ''; StdErr = 'gh.exe not found on PATH'; TimedOut = $false }
  }
  $outFile = [IO.Path]::GetTempFileName()
  $errFile = [IO.Path]::GetTempFileName()
  $timedOut = $false
  $code = -1
  try {
    $p = Start-Process -FilePath $script:GhExe -ArgumentList $GhArgs -NoNewWindow -PassThru `
           -RedirectStandardOutput $outFile -RedirectStandardError $errFile -ErrorAction Stop
    $null = $p.Handle
    if (-not $p.WaitForExit($TimeoutMs)) {
      try { $p.Kill() } catch {}
      try { $p.WaitForExit() } catch {}
      $timedOut = $true
    }
    $code = $p.ExitCode
  } catch {
    Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
    return [PSCustomObject]@{ ExitCode = -1; StdOut = ''; StdErr = "Start-Process failed: $($_.Exception.Message)"; TimedOut = $false }
  }
  $so = ''; $se = ''
  try { $so = [IO.File]::ReadAllText($outFile) } catch {}
  try { $se = [IO.File]::ReadAllText($errFile) } catch {}
  Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
  [PSCustomObject]@{ ExitCode = $code; StdOut = $so; StdErr = $se; TimedOut = $timedOut }
}

# Returns the parsed release, or $null when the remote state could not be
# determined. "Unknown" is a THIRD outcome and must never be folded into
# "the publish failed" - on unknown the caller mutates nothing.
function Read-Release($Tag, $Repo, [int]$Attempts = 3, $LogAction = $null) {
  for ($i = 1; $i -le $Attempts; $i++) {
    $r = Invoke-Gh @('release', 'view', $Tag, '--repo', $Repo, '--json', 'tagName,isDraft,isImmutable,assets') 90000
    if ($r.ExitCode -eq 0 -and $r.StdOut.Trim()) {
      try { return ($r.StdOut | ConvertFrom-Json) } catch {
        if ($LogAction) { & $LogAction "  release read: JSON parse failed ($($_.Exception.Message))" }
      }
    } elseif ($LogAction) {
      & $LogAction "  release read attempt $i/$Attempts failed (exit $($r.ExitCode), timedOut=$($r.TimedOut)): $(FirstLine $r.StdErr)"
    }
    if ($i -lt $Attempts) { Start-Sleep -Seconds (5 * $i) }
  }
  return $null
}

# @() matters: ConvertFrom-Json yields a PSCustomObject, and a 0- or 1-element
# array does not behave like one without it.
function Get-Asset($rel, $name) {
  if (-not $rel) { return $null }
  @($rel.assets) | Where-Object { $_.name -eq $name } | Select-Object -First 1
}

function Get-AssetDigest($a) {
  if ($a -and ($a.PSObject.Properties.Name -contains 'digest') -and $a.digest) {
    return ($a.digest -replace '^sha256:', '').ToLower()
  }
  return ''
}

# What is ACTUALLY serving under the canonical name right now?
#
# This is the function that makes "decide from a re-read, never from an exit
# code" real. gh returning non-zero does NOT mean the mutation did not happen:
# the 2026-08-05 outage was a 502 on a DELETE that GitHub had already applied,
# and a killed-on-timeout PATCH is indistinguishable from the same thing. Every
# post-mutation decision goes through here.
#
#   'new'      the canonical name carries the archive we just uploaded
#   'previous' it carries the archive that was live before this attempt
#   'absent'   there is no asset under the canonical name
#   'notready' present but not finalised, so not downloadable
#   'other'    present, finalised, and something we did not expect
#   'unknown'  the release could not be read - mutate NOTHING on this
function Get-CanonicalState($Tag, $Repo, $Name, $NewSha, $PrevSha, $LogAction = $null) {
  $rel = Read-Release $Tag $Repo 3 $LogAction
  if (-not $rel) { return 'unknown' }
  $c = Get-Asset $rel $Name
  if (-not $c) { return 'absent' }
  if ($c.state -ne 'uploaded') { return 'notready' }
  $d = Get-AssetDigest $c
  if ($NewSha  -and $d -eq $NewSha)  { return 'new' }
  if ($PrevSha -and $d -eq $PrevSha) { return 'previous' }
  return 'other'
}

# $Backoffs is indexed by attempt, so a caller passing fewer backoffs than
# attempts would otherwise index past the end and hand Start-Sleep a $null.
function Get-Backoff($Backoffs, $attempt) {
  if (-not $Backoffs -or $Backoffs.Count -eq 0) { return 30 }
  $i = $attempt - 1
  if ($i -lt 0) { $i = 0 }
  if ($i -ge $Backoffs.Count) { $i = $Backoffs.Count - 1 }
  return $Backoffs[$i]
}

# Put the previously-published asset back under the canonical name after a
# half-completed swap.
#
# This is the compensator for the ONE window in which the canonical name can be
# unoccupied: between the rename-aside (P5) and the promote (P6), two
# consecutive metadata calls. It moves ZERO bytes, so it cannot fail for the
# reason a 96 MB upload would - which is the whole argument for preferring it
# over re-uploading a local rollback copy.
#
# Split out of Publish-ReleaseAsset so r/test_gh_publish.ps1 can drive it from a
# genuine mid-swap state (canonical absent, previous present) instead of it
# being the one branch that only ever executes during a real outage. Adding a
# test-only failure hook to the publish path would have been the alternative,
# and a switch that exists only to break things is worse than a seam.
#
# Returns { Message; NewIsLive; State } where State is the MEASURED canonical
# state afterwards - never asserted. The code this replaced reported "canonical
# asset name is EMPTY" without ever establishing that it was.
function Restore-CanonicalAsset {
  param(
    [Parameter(Mandatory)][string]$Tag,
    [Parameter(Mandatory)][string]$Repo,
    [Parameter(Mandatory)][string]$CanonicalName,
    [string]$PrevApiUrl,
    [string]$PrevName,
    [string]$NewSha,
    [string]$PrevSha,
    [string]$ObservedState = '',
    [int]$MetaTimeoutMs = 90000,
    [int]$Attempts = 3,
    [int]$RetrySeconds = 20,
    $LogAction = $null
  )
  if (-not $PrevApiUrl) {
    return [PSCustomObject]@{
      Message   = "canonical name is '$ObservedState' and there is no previous asset to restore"
      NewIsLive = $false
      State     = $ObservedState
    }
  }
  if ($LogAction) { & $LogAction "  compensate: restoring $PrevName to $CanonicalName (canonical is '$ObservedState')" }
  for ($c = 1; $c -le $Attempts; $c++) {
    $back = Invoke-Gh @('api', '--method', 'PATCH', $PrevApiUrl, '-f', "name=$CanonicalName") $MetaTimeoutMs
    if ($back.ExitCode -eq 0) { break }
    if ($c -lt $Attempts) { Start-Sleep -Seconds $RetrySeconds }
  }
  $after = Get-CanonicalState $Tag $Repo $CanonicalName $NewSha $PrevSha $LogAction
  $newIsLive = $false
  switch ($after) {
    'previous' { $msg = 'compensate: OK - the previously published archive is live again' }
    'new'      { $msg = 'compensate: the NEW archive ended up live after all'; $newIsLive = $true }
    'unknown'  { $msg = 'compensate: could not confirm - the release was unreadable' }
    default    { $msg = "compensate: FAILED - the canonical asset name is '$after'" }
  }
  if ($LogAction) { & $LogAction "  $msg" }
  [PSCustomObject]@{ Message = $msg; NewIsLive = $newIsLive; State = $after }
}

# Publish $FilePath as the release asset named $CanonicalName, without ever
# destroying the live asset before the replacement is verified.
#
#   P1  prune leftover staging assets           (best effort, never fatal)
#   P2  hardlink the file to a name unique to this attempt
#   P3  upload under that name                  (NO --clobber; name is virgin)
#   P4  re-read and verify                      (state=uploaded AND digest)
#   P5  PATCH the live asset  -> $PreviousName
#   P6  PATCH the new asset   -> $CanonicalName          <- now live
#   P7  caller confirms
#
# Returns { Status = 'published' | 'failed' | 'unknown'; NewIsLive; Degraded;
#           Message; PreviousName }.
#
# NewIsLive is the load-bearing field: the caller must revert its tracked
# checksum file if and only if NewIsLive is false. Reverting after a good
# upload pins the OLD hash against NEW bytes, which fails on EVERY future
# deploy - a transient blip turned into a permanent outage.
function Publish-ReleaseAsset {
  param(
    [Parameter(Mandatory)][string]$Tag,
    [Parameter(Mandatory)][string]$Repo,
    [Parameter(Mandatory)][string]$CanonicalName,
    [Parameter(Mandatory)][string]$FilePath,
    [Parameter(Mandatory)][string]$Sha256,
    [Parameter(Mandatory)][string]$StagingDir,
    [Parameter(Mandatory)][datetime]$Deadline,
    [string]$PreviousPrefix = 'parcels-previous',
    [string]$IncomingPrefix = 'parcels-incoming',
    [int]$UploadTimeoutMs = 600000,
    [int]$MetaTimeoutMs = 90000,
    [int[]]$Backoffs = @(60, 240),
    [int]$Attempts = 3,
    $LogAction = $null
  )

  function _log($m) { if ($LogAction) { & $LogAction $m } }

  $stamp = Get-Date -Format 'yyyyMMddHHmmss'
  # Time, not just date. A date-only name collides on the SECOND publish of any
  # calendar day, and P5 then 422s forever - which is exactly what a Task
  # Scheduler retry (RestartCount=2) or a same-day manual re-run does, so the
  # collision would have fired on the recovery attempt rather than the happy path.
  $previousName = '{0}-{1}.pmtiles' -f $PreviousPrefix, $stamp
  $fileLen      = (Get-Item $FilePath).Length
  $newIsLive    = $false
  $degraded     = $false

  # Start-Process joins the argument array on spaces, so a staging path
  # containing one would silently corrupt the upload argv. Assert it rather
  # than leaving it as a comment nobody re-reads.
  if ($StagingDir -match '\s') {
    return [PSCustomObject]@{ Status = 'failed'; NewIsLive = $false; Degraded = $false; Message = "StagingDir '$StagingDir' contains a space, which would corrupt the gh argument list."; PreviousName = $previousName }
  }

  New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

  # P1 now runs at the top of each attempt (see inside the loop), so a retry
  # cannot leave its predecessor's 96 MB staging asset on the release.
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    if ((Get-Date) -gt $Deadline) {
      return [PSCustomObject]@{ Status = 'failed'; NewIsLive = $newIsLive; Degraded = $degraded; Message = 'publish deadline exceeded before an attempt could start.'; PreviousName = $previousName }
    }

    # Decide from a RE-READ, never from the previous attempt's exit code: the
    # incident's 502 came from a mutation GitHub had already applied.
    $rel = Read-Release $Tag $Repo 3 $LogAction
    if (-not $rel) {
      if ($attempt -lt $Attempts) { Start-Sleep -Seconds (Get-Backoff $Backoffs $attempt); continue }
      return [PSCustomObject]@{ Status = 'unknown'; NewIsLive = $newIsLive; Degraded = $degraded; Message = 'could not read the release during publish - remote state unknown, nothing was changed.'; PreviousName = $previousName }
    }

    # Prune leftover staging assets at the top of EVERY attempt, not just once
    # before the loop: each attempt uploads under its own name, so without this
    # a run that retries twice leaves ~200 MB of orphans on the release until
    # the next run's prune. Names are attempt-suffixed, so this can never touch
    # the asset this attempt is about to create. Best effort, never fatal.
    foreach ($a in @($rel.assets)) {
      if ($a.name -like "$IncomingPrefix-*") {
        $d = Invoke-Gh @('release', 'delete-asset', $Tag, $a.name, '--repo', $Repo, '--yes') $MetaTimeoutMs
        _log "  prune: $($a.name) $(if ($d.ExitCode -eq 0) { 'deleted' } else { 'delete failed (ignored)' })"
      }
    }

    $canon = Get-Asset $rel $CanonicalName
    if ($canon -and (Get-AssetDigest $canon) -eq $Sha256 -and $canon.state -eq 'uploaded') {
      _log '  publish: the canonical asset already carries this archive - nothing to do.'
      return [PSCustomObject]@{ Status = 'published'; NewIsLive = $true; Degraded = $false; Message = 'already published'; PreviousName = $previousName }
    }
    $prevApiUrl = if ($canon) { $canon.apiUrl } else { '' }
    $prevDigest = Get-AssetDigest $canon

    # P2 - gh derives the asset name from the local file's BASENAME and offers
    # no flag to set it, so a link under the staging name is the only way to
    # control it. Instant on the same volume, no admin rights needed.
    $incomingName = "$IncomingPrefix-$stamp-a$attempt.pmtiles"
    $linkPath     = Join-Path $StagingDir $incomingName
    Remove-Item $linkPath -Force -ErrorAction SilentlyContinue
    try {
      New-Item -ItemType HardLink -Path $linkPath -Target $FilePath -ErrorAction Stop | Out-Null
    } catch {
      _log "  staging: hardlink failed ($($_.Exception.Message)) - falling back to a copy"
      try { Copy-Item $FilePath $linkPath -Force -ErrorAction Stop } catch {
        # Clean up before returning: this return is OUTSIDE the try/finally
        # below, so a part-written 96 MB copy would otherwise be left behind.
        Remove-Item $linkPath -Force -ErrorAction SilentlyContinue
        return [PSCustomObject]@{ Status = 'failed'; NewIsLive = $newIsLive; Degraded = $degraded; Message = "could not stage the archive for upload: $($_.Exception.Message)"; PreviousName = $previousName }
      }
    }

    try {
      # P3 - no --clobber: the name is virgin, so nothing is deleted to make
      # progress and a retry cannot collide with its own leftover.
      $t0 = Get-Date
      $up = Invoke-Gh @('release', 'upload', $Tag, $linkPath, '--repo', $Repo) $UploadTimeoutMs
      if ($up.ExitCode -ne 0) {
        _log ("  publish attempt {0}/{1} failed (exit {2}, timedOut={3}): {4}" -f $attempt, $Attempts, $up.ExitCode, $up.TimedOut, (FirstLine $up.StdErr))
        # Fail-fast list, deliberately tiny: bias hard toward retrying, because
        # misclassifying a transient failure as permanent costs the self-heal
        # this design exists to buy, while retrying a permanent failure costs
        # a few minutes on a job that already left production healthy.
        if ($up.ExitCode -eq 4 -or $up.StdErr -match 'Bad credentials|HTTP 401') {
          return [PSCustomObject]@{ Status = 'failed'; NewIsLive = $newIsLive; Degraded = $degraded; Message = "gh authentication failed during upload: $(FirstLine $up.StdErr)"; PreviousName = $previousName }
        }
        if ($attempt -lt $Attempts) {
          $wait = (Get-Backoff $Backoffs $attempt)
          if ((Get-Date).AddSeconds($wait) -gt $Deadline) {
            return [PSCustomObject]@{ Status = 'failed'; NewIsLive = $newIsLive; Degraded = $degraded; Message = 'publish deadline would be crossed by the next backoff - stopping.'; PreviousName = $previousName }
          }
          _log "  retrying in ${wait}s (deadline $($Deadline.ToString('HH:mm')))"
          Start-Sleep -Seconds $wait
        }
        continue
      }
      _log ("  uploaded {0} in {1:N0}s" -f $incomingName, ((Get-Date) - $t0).TotalSeconds)

      # P4 - verify. state AND digest, with a poll: finalisation and digest
      # computation can lag the upload response, and trusting the first null
      # read is a false pass wearing a different hat. An asset in a
      # non-'uploaded' state reports a size while its digest is null, which is
      # exactly the branch a naive size check falls through to.
      $ok = $false; $inc = $null; $mismatch = ''
      for ($poll = 0; $poll -lt 12; $poll++) {
        $relV = Read-Release $Tag $Repo 2 $LogAction
        $inc  = Get-Asset $relV $incomingName
        if ($inc -and $inc.state -eq 'uploaded') {
          $d = Get-AssetDigest $inc
          if ($d -and $d -eq $Sha256) { $ok = $true; break }
          if ($d -and $d -ne $Sha256) { $mismatch = $d; break }
          if (-not $d -and $poll -ge 11 -and [int64]$inc.size -eq $fileLen) { $ok = $true; $degraded = $true; break }
        }
        Start-Sleep -Seconds 5
      }
      if ($mismatch) {
        return [PSCustomObject]@{ Status = 'failed'; NewIsLive = $newIsLive; Degraded = $degraded; Message = "uploaded asset digest $mismatch does not match local $Sha256 - the published archive is not what we built."; PreviousName = $previousName }
      }
      if (-not $ok) {
        _log "  verification did not confirm $incomingName within 60s"
        if ($attempt -lt $Attempts) { Start-Sleep -Seconds (Get-Backoff $Backoffs $attempt); continue }
        return [PSCustomObject]@{ Status = 'failed'; NewIsLive = $newIsLive; Degraded = $degraded; Message = "uploaded asset $incomingName never reached state=uploaded with a matching digest."; PreviousName = $previousName }
      }
      if ($degraded) { _log '  DEGRADED: verified by size only, GitHub reported no digest' }
      else           { _log '  verified: state=uploaded digest matches local sha256' }

      # P5 - free the canonical name. Metadata only, no bytes on the wire.
      #
      # A non-zero exit here does NOT mean the rename did not happen, so the
      # decision comes from a re-read. This is the same fault class as the
      # outage: a 502 (or an Invoke-Gh timeout kill) on a mutation the server
      # already applied.
      if ($prevApiUrl) {
        $mv1 = Invoke-Gh @('api', '--method', 'PATCH', $prevApiUrl, '-f', "name=$previousName") $MetaTimeoutMs
        if ($mv1.ExitCode -ne 0) {
          _log "  swap: rename-aside reported failure (exit $($mv1.ExitCode)): $(FirstLine $mv1.StdErr) - measuring"
          $st = Get-CanonicalState $Tag $Repo $CanonicalName $Sha256 $prevDigest $LogAction
          if ($st -eq 'unknown') {
            return [PSCustomObject]@{ Status = 'unknown'; NewIsLive = $false; Degraded = $degraded; Message = 'the release became unreadable during the swap - remote state unknown, nothing further was changed.'; PreviousName = $previousName }
          }
          if ($st -ne 'absent') {
            # The canonical name is still occupied, so the rename really did
            # not apply. Production is unaffected; retry the whole attempt.
            _log "  swap: canonical name still occupied ($st) - rename-aside did not apply"
            if ($attempt -lt $Attempts) { Start-Sleep -Seconds (Get-Backoff $Backoffs $attempt); continue }
            return [PSCustomObject]@{ Status = 'failed'; NewIsLive = $false; Degraded = $degraded; Message = "could not rename the live asset aside: $(FirstLine $mv1.StdErr)"; PreviousName = $previousName }
          }
          _log '  swap: rename-aside had in fact applied - continuing'
        }
      }

      # P6 - promote. This is THE call that decides NewIsLive, so its result is
      # measured, never inferred from the exit code.
      $mv2 = Invoke-Gh @('api', '--method', 'PATCH', $inc.apiUrl, '-f', "name=$CanonicalName") $MetaTimeoutMs
      if ($mv2.ExitCode -eq 0) {
        $newIsLive = $true
        _log "  swapped: $CanonicalName -> $previousName, $incomingName -> $CanonicalName"
        return [PSCustomObject]@{ Status = 'published'; NewIsLive = $true; Degraded = $degraded; Message = 'published'; PreviousName = $previousName }
      }

      _log "  swap: promote reported failure (exit $($mv2.ExitCode)): $(FirstLine $mv2.StdErr) - measuring"
      $st = Get-CanonicalState $Tag $Repo $CanonicalName $Sha256 $prevDigest $LogAction

      if ($st -eq 'new') {
        # GitHub applied the rename and then failed to tell us. The archive IS
        # live. Reporting failure here would make the caller revert the
        # checksum over live bytes and break every future deploy.
        $newIsLive = $true
        _log '  swap: the promote had in fact applied - the new archive is live'
        return [PSCustomObject]@{ Status = 'published'; NewIsLive = $true; Degraded = $degraded; Message = 'published (the promote call reported an error but had been applied)'; PreviousName = $previousName }
      }
      if ($st -eq 'unknown') {
        return [PSCustomObject]@{ Status = 'unknown'; NewIsLive = $false; Degraded = $degraded; Message = 'could not read the release after the promote - remote state unknown, nothing was compensated.'; PreviousName = $previousName }
      }
      if ($st -eq 'previous') {
        return [PSCustomObject]@{ Status = 'failed'; NewIsLive = $false; Degraded = $degraded; Message = "the promote to $CanonicalName failed and the previously published archive is still live. Production is unaffected."; PreviousName = $previousName }
      }

      # 'absent', 'notready' or 'other': the canonical name is not serving the
      # old archive, so restore it. See Restore-CanonicalAsset.
      $comp = Restore-CanonicalAsset -Tag $Tag -Repo $Repo -CanonicalName $CanonicalName `
                -PrevApiUrl $prevApiUrl -PrevName $previousName -NewSha $Sha256 -PrevSha $prevDigest `
                -ObservedState $st -MetaTimeoutMs $MetaTimeoutMs -LogAction $LogAction
      $compensated = $comp.Message
      if ($comp.NewIsLive) { $newIsLive = $true }
      if ($newIsLive) {
        return [PSCustomObject]@{ Status = 'published'; NewIsLive = $true; Degraded = $degraded; Message = "published ($compensated)"; PreviousName = $previousName }
      }
      return [PSCustomObject]@{ Status = 'failed'; NewIsLive = $newIsLive; Degraded = $degraded; Message = "could not promote the uploaded asset to $CanonicalName. $compensated"; PreviousName = $previousName }
    } finally {
      Remove-Item $linkPath -Force -ErrorAction SilentlyContinue
    }
  }

  [PSCustomObject]@{ Status = 'failed'; NewIsLive = $newIsLive; Degraded = $degraded; Message = "publish did not complete after $Attempts attempts."; PreviousName = $previousName }
}

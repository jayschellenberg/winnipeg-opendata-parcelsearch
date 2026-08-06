# lib_ortho.ps1
#
# Consistency checks between the aerial-ortho years the WEB APP offers
# (ORTHO_YEARS in web/src/map.js) and the PMTiles archives that actually exist
# on Cloudflare R2.
#
# WHY THIS EXISTS. ORTHO_YEARS is hand-maintained: you build
# wpg-ortho-<year>.pmtiles (r/build_ortho_tiles.ps1), upload it to R2, then add
# the year to map.js. Nothing connects those steps, so two silent failures are
# possible in opposite directions:
#
#   listed but not on R2  -> the year appears in the picker and renders NOTHING.
#                            No console error, no failed request the user sees;
#                            the basemap is just blank for that year.
#   on R2 but not listed  -> a 14-18 GB archive was built and paid for and no
#                            one can see it.
#
# Neither is detectable from the app, and old imagery never "expires", so there
# is no natural signal. This turns both into mail from the quarterly job.
#
# DELIBERATELY NOT runtime discovery in the browser. The app would have to
# probe R2 during style setup, and the five ortho archives' header fetches are
# already the slowest part of map startup - they are what made a cold load
# exceed the old 30 s failsafe (see the comment in map.js setupLayers). Keeping
# the list a static literal and VERIFYING it out-of-band costs the app nothing.
#
# ASCII-ONLY (see lib_mail.ps1): Windows PowerShell 5.1 reads a BOM-less .ps1
# as the ANSI codepage, so a non-ASCII byte in a string literal corrupts the
# parse silently.

try { Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue } catch {}

# Read the years the app actually offers, straight from the source of truth.
#
# Returns an OBJECT { Found; Years }, deliberately not a bare array. Two
# PowerShell traps make a bare array the wrong contract here:
#
#   `return ,$years`  unrolls differently depending on the CALL SITE - measured
#                     under 5.1, assigning gives the 2-element array but using
#                     the call inline inside an expression gives a 1-element
#                     array containing it, which stringifies to
#                     "System.Object[]". A function whose result depends on how
#                     the caller writes the call is a trap.
#   `return @()`      for the legitimate empty case emits nothing, so the caller
#                     receives $null - indistinguishable from "no declaration
#                     found", which is a completely different situation.
#
# An empty ORTHO_YEARS is a documented, supported state ("ship the aerial
# control inert"); a missing declaration means the parser or the file changed
# shape and is worth alerting on. Found separates them.
function Get-OrthoYearsFromSource($MapJsPath) {
  if (-not (Test-Path $MapJsPath)) {
    return [PSCustomObject]@{ Found = $false; Years = @() }
  }
  $src = [IO.File]::ReadAllText($MapJsPath)
  $m = [regex]::Match($src, 'ORTHO_YEARS\s*=\s*\[([^\]]*)\]')
  if (-not $m.Success) {
    return [PSCustomObject]@{ Found = $false; Years = @() }
  }
  $years = @([regex]::Matches($m.Groups[1].Value, '\d{4}') | ForEach-Object { [int]$_.Value })
  return [PSCustomObject]@{ Found = $true; Years = $years }
}

# Probe one archive with a RANGED GET of the PMTiles header.
#
# Not HEAD: r2.dev does not answer HEAD usefully here (measured 2026-08-06 -
# every existing archive errored on HEAD while missing ones cleanly 404'd, so a
# HEAD-based check would have reported the live years as broken). A 128-byte
# range is what the pmtiles protocol itself issues first anyway.
#
# Byte 100 is min zoom and byte 101 is max zoom in the PMTiles v3 header,
# verified against a local archive whose zooms were read independently with the
# pmtiles JS library.
function Get-OrthoArchiveInfo($Base, $Year, $TimeoutSec = 30) {
  $url = "$Base/wpg-ortho-$Year.pmtiles"
  $hc = New-Object System.Net.Http.HttpClient
  try {
    $hc.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    $req = New-Object System.Net.Http.HttpRequestMessage('GET', $url)
    $req.Headers.Range = New-Object System.Net.Http.Headers.RangeHeaderValue(0, 127)
    $resp = $hc.SendAsync($req).GetAwaiter().GetResult()
    $code = [int]$resp.StatusCode
    if ($code -ne 200 -and $code -ne 206) {
      return [PSCustomObject]@{ Year = $Year; Present = $false; Status = $code; Magic = ''; Version = 0; MinZoom = 0; MaxZoom = 0; Bytes = 0; Error = '' }
    }
    $b = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    $total = 0
    if ($resp.Content.Headers.ContentRange -and $resp.Content.Headers.ContentRange.Length) {
      $total = [int64]$resp.Content.Headers.ContentRange.Length
    }
    $magic = if ($b.Length -ge 7) { [Text.Encoding]::ASCII.GetString($b[0..6]) } else { '' }
    return [PSCustomObject]@{
      Year = $Year; Present = ($magic -eq 'PMTiles'); Status = $code; Magic = $magic
      Version = $(if ($b.Length -ge 8) { [int]$b[7] } else { 0 })
      MinZoom = $(if ($b.Length -ge 101) { [int]$b[100] } else { 0 })
      MaxZoom = $(if ($b.Length -ge 102) { [int]$b[101] } else { 0 })
      Bytes = $total; Error = ''
    }
  } catch {
    # A network failure is NOT evidence the archive is missing. The caller must
    # not raise a "listed but absent" alarm on it.
    return [PSCustomObject]@{ Year = $Year; Present = $false; Status = 0; Magic = ''; Version = 0; MinZoom = 0; MaxZoom = 0; Bytes = 0; Error = $_.Exception.Message }
  } finally { $hc.Dispose() }
}

# Compare what the app offers against what exists.
#
#   Missing   listed in map.js but no valid archive on R2  -> blank basemap year
#   Unlisted  a valid archive on R2 the app does not offer -> built, forgotten
#   Unreached probe errored; state unknown, never alarmed on
function Compare-OrthoYears($Listed, $Infos, $ExpectMinZoom = 12, $ExpectMaxZoom = 20) {
  $listed = @($Listed)
  $missing = @(); $unlisted = @(); $unreached = @(); $zoomMismatch = @()
  foreach ($i in @($Infos)) {
    if ($i.Error) { $unreached += $i.Year; continue }
    $isListed = $listed -contains $i.Year
    if ($isListed -and -not $i.Present)      { $missing  += $i.Year }
    if ($i.Present -and -not $isListed)      { $unlisted += $i.Year }
    if ($isListed -and $i.Present -and ($i.MinZoom -ne $ExpectMinZoom -or $i.MaxZoom -ne $ExpectMaxZoom)) {
      $zoomMismatch += "$($i.Year) (archive $($i.MinZoom)..$($i.MaxZoom))"
    }
  }
  # A listed year that was never probed is also "not confirmed present", but it
  # is reported as unreached rather than missing - a network blip must not send
  # mail claiming the basemap is broken.
  foreach ($y in $listed) {
    if (-not (@($Infos) | Where-Object { $_.Year -eq $y })) { $unreached += $y }
  }
  [PSCustomObject]@{
    Missing      = @($missing | Sort-Object -Unique)
    Unlisted     = @($unlisted | Sort-Object -Unique)
    Unreached    = @($unreached | Sort-Object -Unique)
    ZoomMismatch = @($zoomMismatch)
    Healthy      = ((@($missing).Count -eq 0) -and (@($unlisted).Count -eq 0) -and (@($zoomMismatch).Count -eq 0))
  }
}

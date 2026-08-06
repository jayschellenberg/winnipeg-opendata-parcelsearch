# test_ortho.ps1
#
# Covers r/lib_ortho.ps1: the map.js parser and the comparison logic against
# fixtures, then one live probe of the real R2 bucket.
#
#   powershell -ExecutionPolicy Bypass -File D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch\r\test_ortho.ps1
#
# ASCII-ONLY (see lib_mail.ps1).

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib_ortho.ps1')

$passed = 0; $failed = 0
function Check($name, $cond, $detail = '') {
  if ($cond) { $script:passed++; Write-Output "  PASS  $name" }
  else       { $script:failed++; Write-Output "  FAIL  $name $detail" }
}
$tmp = Join-Path $env:TEMP ('ortho-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Output '=== parsing ORTHO_YEARS out of map.js ==='

function Write-Fixture($name, $text) {
  $p = Join-Path $tmp $name
  [IO.File]::WriteAllText($p, $text)
  return $p
}

$f1 = Write-Fixture 'a.js' "const X = 1;`nexport const ORTHO_YEARS = [2026, 2024, 2021, 2018, 2016];`nconst Y = 2;"
$y1 = Get-OrthoYearsFromSource $f1
Check 'parses the real declaration'    ((@($y1.Years) -join ',') -eq '2026,2024,2021,2018,2016') "got $(@($y1.Years) -join ',')"
Check 'preserves newest-first order'   (@($y1.Years)[0] -eq 2026)

$f2 = Write-Fixture 'b.js' "export const ORTHO_YEARS = [];"
$y2 = Get-OrthoYearsFromSource $f2
Check 'an empty list is Found with zero years, not a failure' ($y2.Found -and @($y2.Years).Count -eq 0)

# Inline (not assigned first): `return ,$array` used to give a 1-element array
# containing the array here, so these two cases pin the calling-context trap.
$f3 = Write-Fixture 'c.js' "export const ORTHO_YEARS = [`n  2026,`n  2024,`n];"
Check 'multi-line and trailing comma, called INLINE'  ((@((Get-OrthoYearsFromSource $f3).Years) -join ',') -eq '2026,2024') "got $(@((Get-OrthoYearsFromSource $f3).Years) -join ',')"

$f4 = Write-Fixture 'd.js' "export const ORTHO_YEARS=[2026,2024];"
Check 'no whitespace around =, called INLINE'         ((@((Get-OrthoYearsFromSource $f4).Years) -join ',') -eq '2026,2024') "got $(@((Get-OrthoYearsFromSource $f4).Years) -join ',')"

$f6 = Write-Fixture 'f.js' "export const ORTHO_YEARS = [2026];"
Check 'a SINGLE year stays a one-element list'        (@((Get-OrthoYearsFromSource $f6).Years).Count -eq 1)

$f5 = Write-Fixture 'e.js' "const SOMETHING_ELSE = [2020];"
Check 'a missing declaration is Found=false' (-not (Get-OrthoYearsFromSource $f5).Found)
Check 'a missing FILE is Found=false'        (-not (Get-OrthoYearsFromSource (Join-Path $tmp 'nope.js')).Found)

# The real file must parse - this is the one that matters.
$realMap = Join-Path $PSScriptRoot '..\web\src\map.js'
$realParsed = Get-OrthoYearsFromSource $realMap
$realYears = @($realParsed.Years)
Check 'the REAL web/src/map.js parses' ($realParsed.Found -and $realYears.Count -gt 0) "got $($realYears -join ',')"

Write-Output ''
Write-Output '=== comparison logic (fixtures) ==='

function Info($year, $present, $min = 12, $max = 20, $err = '') {
  [PSCustomObject]@{ Year = $year; Present = $present; Status = $(if ($present) { 206 } else { 404 }); Magic = $(if ($present) { 'PMTiles' } else { '' }); Version = 3; MinZoom = $min; MaxZoom = $max; Bytes = 1; Error = $err }
}

$c = Compare-OrthoYears @(2026, 2024) @((Info 2026 $true), (Info 2024 $true))
Check 'all present and listed is healthy' ($c.Healthy -and $c.Missing.Count -eq 0 -and $c.Unlisted.Count -eq 0)

$c = Compare-OrthoYears @(2026, 2024) @((Info 2026 $true), (Info 2024 $false))
Check 'listed but absent is reported MISSING' ((@($c.Missing) -join ',') -eq '2024') "missing=$(@($c.Missing) -join ',')"
Check 'and that is not healthy'               (-not $c.Healthy)

$c = Compare-OrthoYears @(2026) @((Info 2026 $true), (Info 2025 $true))
Check 'present but unlisted is reported'      ((@($c.Unlisted) -join ',') -eq '2025')
Check 'an unlisted year is not healthy'       (-not $c.Healthy)

# The important negative: a network failure must never masquerade as a
# missing archive, or a blip would mail "the basemap is broken".
$c = Compare-OrthoYears @(2026, 2024) @((Info 2026 $true), (Info 2024 $false 12 20 'timeout'))
Check 'a probe ERROR is unreached, not missing' ((@($c.Unreached) -join ',') -eq '2024' -and @($c.Missing).Count -eq 0) "missing=$(@($c.Missing) -join ',') unreached=$(@($c.Unreached) -join ',')"

$c = Compare-OrthoYears @(2026, 2024) @((Info 2026 $true))
Check 'a listed year never probed is unreached' ((@($c.Unreached) -join ',') -eq '2024')

$c = Compare-OrthoYears @(2026) @((Info 2026 $true 12 19))
Check 'a zoom-range mismatch is reported'  (@($c.ZoomMismatch).Count -eq 1) "$(@($c.ZoomMismatch) -join '; ')"
Check 'and a zoom mismatch is not healthy' (-not $c.Healthy)

$c = Compare-OrthoYears @() @()
Check 'an inert (empty) config is healthy' ($c.Healthy)

Write-Output ''
Write-Output '=== live probe of the R2 bucket ==='
$base = 'https://pub-f351b204f73e4b2287acad946d79681c.r2.dev'

$newest = @($realYears)[0]
$hit = Get-OrthoArchiveInfo $base $newest
Check "the newest listed year ($newest) is a real PMTiles archive" ($hit.Present -and $hit.Magic -eq 'PMTiles') "status=$($hit.Status) magic='$($hit.Magic)' err=$($hit.Error)"
Check 'it reports PMTiles v3'          ($hit.Version -eq 3)
Check 'its zoom range matches map.js'  ($hit.MinZoom -eq 12 -and $hit.MaxZoom -eq 20) "$($hit.MinZoom)..$($hit.MaxZoom)"
Check 'and a plausible size (>1 GB)'   ($hit.Bytes -gt 1GB) "$($hit.Bytes) bytes"

$miss = Get-OrthoArchiveInfo $base 1999
Check 'a year with no archive is absent, not an error' ((-not $miss.Present) -and (-not $miss.Error)) "status=$($miss.Status) err=$($miss.Error)"

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Output ''
Write-Output "$passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }
exit 0

# s4u_probe.ps1 - what test_s4u_alert.ps1 runs INSIDE the temporary S4U task.
# Not meant to be run by hand. It proves, from a non-interactive S4U logon:
#   1. refresh_assets.ps1 -TestAlert can read the WpgScheduleMail credential
#      (email) and reach ntfy (push);
#   2. gh auth status works (the tile job creates GitHub releases unattended).
# Results go to the file named in $env:WPG_PROBE_OUT, or next to this script.
param([string]$OutFile = $(if ($env:WPG_PROBE_OUT) { $env:WPG_PROBE_OUT } else { Join-Path $PSScriptRoot 's4u_probe_result.txt' }))

$lines = @()
$lines += "probe started $(Get-Date -Format s) as $env:USERDOMAIN\$env:USERNAME on $env:COMPUTERNAME"
$lines += "interactive session: $([Environment]::UserInteractive)"

# 1. Alert path
try {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'refresh_assets.ps1') -TestAlert 2>&1
    $rc = $LASTEXITCODE
    $lines += "TestAlert exit=$rc"
    $lines += ($out | ForEach-Object { "  | $_" })
} catch {
    $lines += "TestAlert threw: $($_.Exception.Message)"
}

# 2. gh
$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
    try {
        $ghOut = & $gh.Source auth status 2>&1
        $lines += "gh auth status exit=$LASTEXITCODE ($($gh.Source))"
        $lines += ($ghOut | ForEach-Object { "  | $_" })
    } catch {
        $lines += "gh threw: $($_.Exception.Message)"
    }
} else {
    $lines += "gh NOT on PATH in this session"
}

$lines += "probe finished $(Get-Date -Format s)"
$lines -join "`r`n" | Out-File $OutFile -Encoding utf8

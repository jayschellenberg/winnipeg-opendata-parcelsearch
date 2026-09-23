# test_s4u_alert.ps1 - prove the Wpg alert path (email + ntfy) and gh auth work
# under an S4U scheduled-task logon, which is how the three Wpg tasks actually run.
#
#   RUN FROM AN ELEVATED PROMPT (S4U principal needs admin):
#   powershell -ExecutionPolicy Bypass -File D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch\r\test_s4u_alert.ps1
#
# What it does, and nothing more:
#   1. registers a temporary S4U task "WpgS4UProbe" that runs s4u_probe.ps1
#      (which calls refresh_assets.ps1 -TestAlert, then gh auth status);
#   2. starts it, waits up to 3 minutes for it to finish;
#   3. prints the probe's result file and a verdict;
#   4. deletes the temporary task.
# No GeoJSON is regenerated, nothing is committed or pushed, no real job runs.
#
# Why this is needed: refresh_assets.ps1 -TestAlert from your own shell proves
# the wiring under an INTERACTIVE logon. The scheduled tasks run S4U, which has
# no DPAPI key, so Credential Manager (email) and gh's token store may fail
# there while the interactive test passes. Only a run under S4U settles it.

$ErrorActionPreference = 'Stop'
$here     = $PSScriptRoot
$probe    = Join-Path $here 's4u_probe.ps1'
$result   = Join-Path $env:TEMP 'wpg_s4u_probe_result.txt'
$TaskName = 'WpgS4UProbe'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run this from an elevated prompt; an S4U principal cannot be set otherwise." }
if (-not (Test-Path $probe)) { throw "probe script missing: $probe" }
Remove-Item $result -ErrorAction SilentlyContinue

$action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$probe`" -OutFile `"$result`""
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings | Out-Null

$logon = (Get-ScheduledTask -TaskName $TaskName).Principal.LogonType
if ($logon -ne 'S4U') {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    throw "temporary task registered as $logon, not S4U - the probe would not prove anything. Aborted."
}

Write-Host "Starting $TaskName under S4U..."
Start-ScheduledTask -TaskName $TaskName
$deadline = (Get-Date).AddMinutes(3)
do {
    Start-Sleep -Seconds 5
    $state = (Get-ScheduledTask -TaskName $TaskName).State
} while ($state -eq 'Running' -and (Get-Date) -lt $deadline)
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Host ""
Write-Host "task state=$state lastResult=$($info.LastTaskResult)"
if (-not (Test-Path $result)) {
    Write-Host "!! no result file written - the probe did not run or could not write $result"
    exit 1
}
$text = Get-Content $result -Raw
Write-Host "---- probe output ----"
Write-Host $text
Write-Host "----------------------"

$emailOk = $text -match 'TestAlert: email=True'
$pushOk  = $text -match 'push=True'
$ghOk    = $text -match 'gh auth status exit=0'
Write-Host ("VERDICT under S4U:  email={0}  ntfy={1}  gh={2}" -f `
    $(if ($emailOk) {'OK'} else {'FAIL'}), $(if ($pushOk) {'OK'} else {'FAIL'}), $(if ($ghOk) {'OK'} else {'FAIL'}))
if (-not $emailOk) { Write-Host "  email: Credential Manager entry WpgScheduleMail is not readable under S4U (see lib_mail.ps1 header)." }
if (-not $ghOk)    { Write-Host "  gh: token store not readable under S4U; WpgParcelTilesBiMonthly's release step would fail." }
Write-Host "Now check your inbox and the ntfy app for 'Wpg Open Data: TEST - asset refresh alerts'."

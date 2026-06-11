# lib_mail.ps1
#
# Best-effort failure-email helper. Sourced by scheduled_download.ps1 and
# refresh_assets.ps1 so a silent failure of either unattended job lands
# in Jason's inbox the day it happens, not at the next appraisal.
#
# Tolerant by design: any error (missing module, missing credential,
# SMTP rejection, no network) is logged and swallowed. The FAILED-*.txt
# marker at the WpgSnapshots archive root (written by the .ps1 jobs
# themselves) remains the zero-dependency fallback signal — email is
# additive on top of that.
#
# *** One-time setup on a new machine ***
#
#   1. Install the CredentialManager module (single user, no admin):
#        Install-Module -Name CredentialManager -Scope CurrentUser -Force
#
#   2. Generate a Gmail App Password at
#        https://myaccount.google.com/apppasswords
#      (only available with 2FA on the account).
#
#   3. Store the credential under target name 'WpgScheduleMail':
#        $u = 'jason@jksconsultinginc.com'   # also becomes the From: address
#        $p = ConvertTo-SecureString '<16-char app password>' -AsPlainText -Force
#        New-StoredCredential -Target 'WpgScheduleMail' `
#          -UserName $u -SecurePassword $p `
#          -Persist LocalMachine | Out-Null
#
#   4. Smoke-test:
#        . $PSScriptRoot\lib_mail.ps1
#        Send-FailureMail -Subject 'lib_mail smoke test' -Body 'If you see this, it works.'

function Send-FailureMail {
  param(
    [Parameter(Mandatory)][string]$Subject,
    [Parameter(Mandatory)][string]$Body,
    [string]$To = 'jason@jksconsultinginc.com',
    [string]$CredentialTarget = 'WpgScheduleMail',
    [string]$SmtpServer = 'smtp.gmail.com',
    [int]   $SmtpPort = 587
  )
  try {
    if (-not (Get-Module -ListAvailable -Name CredentialManager)) {
      Write-Output "lib_mail: CredentialManager module not installed — skipping email (see lib_mail.ps1 header for setup)."
      return
    }
    Import-Module CredentialManager -ErrorAction Stop
    $cred = $null
    try { $cred = Get-StoredCredential -Target $CredentialTarget -ErrorAction Stop } catch {}
    if (-not $cred) {
      Write-Output "lib_mail: no '$CredentialTarget' credential found — skipping email (run New-StoredCredential per lib_mail.ps1 setup)."
      return
    }
    $from = $cred.UserName
    # Send-MailMessage is marked obsolete in PowerShell 7 but still works
    # against Gmail's SMTP submission port. Keeps lib_mail dependency-free
    # beyond CredentialManager.
    Send-MailMessage `
      -SmtpServer $SmtpServer -Port $SmtpPort -UseSsl `
      -Credential $cred `
      -From $from -To $To `
      -Subject $Subject -Body $Body `
      -WarningAction SilentlyContinue `
      -ErrorAction Stop
    Write-Output "lib_mail: failure email sent to $To"
  } catch {
    Write-Output "lib_mail: ERROR sending email: $($_.Exception.Message)"
  }
}

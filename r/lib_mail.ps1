# lib_mail.ps1
#
# Best-effort failure-email helper. Sourced by scheduled_download.ps1 and
# refresh_assets.ps1 so a silent failure of either unattended job lands
# in Jason's inbox the day it happens, not at the next appraisal.
#
# Tolerant by design: any error (missing module, missing credential,
# SMTP rejection, no network) is logged and swallowed. The FAILED-*.txt
# marker at the WpgSnapshots archive root (written by the .ps1 jobs
# themselves) remains the zero-dependency fallback signal -- email is
# additive on top of that.
#
# ASCII-ONLY: this file is read by Windows PowerShell 5.1 (the
# scheduled-task runtime), which interprets a BOM-less .ps1 as the ANSI
# codepage, not UTF-8. A non-ASCII byte (e.g. an em-dash) inside a string
# literal gets mis-decoded into a stray quote that breaks the string and
# swallows following code -- a silent parse corruption. Keep this file
# 7-bit ASCII.
#
# *** One-time setup on a new machine ***
#
#   Run setup under Windows PowerShell 5.1 (powershell.exe), NOT pwsh 7 --
#   CredentialManager cannot load under PowerShell 7.
#
#   1. Install the CredentialManager module (single user, no admin):
#        powershell.exe -Command "Install-Module CredentialManager -Scope CurrentUser -Force"
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
    # Force TLS 1.2. Windows PowerShell 5.1 (the scheduled-task runtime)
    # defaults to TLS 1.0/1.1, which Gmail's SMTP submission rejects.
    # Must precede the send. Harmless under PowerShell 7.
    try { [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
    if (-not (Get-Module -ListAvailable -Name CredentialManager)) {
      Write-Output "lib_mail: CredentialManager module not installed - skipping email (see lib_mail.ps1 header for setup)."
      return
    }
    Import-Module CredentialManager -ErrorAction Stop
    $cred = $null
    try { $cred = Get-StoredCredential -Target $CredentialTarget -ErrorAction Stop } catch {}
    if (-not $cred) {
      Write-Output "lib_mail: no '$CredentialTarget' credential found - skipping email (run New-StoredCredential per lib_mail.ps1 setup)."
      return
    }
    $from = $cred.UserName
    # Use System.Net.Mail.SmtpClient directly rather than Send-MailMessage:
    # under Windows PowerShell 5.1 the Send-MailMessage cmdlet hangs on
    # Gmail's STARTTLS negotiation, whereas SmtpClient with an explicit
    # timeout sends in ~3s (verified on JKS11).
    $msg = New-Object System.Net.Mail.MailMessage
    $msg.From = $from
    $msg.To.Add($To)
    $msg.Subject = $Subject
    $msg.Body    = $Body
    $smtp = New-Object System.Net.Mail.SmtpClient($SmtpServer, $SmtpPort)
    $smtp.EnableSsl   = $true
    $smtp.Timeout     = 30000   # 30s - fail fast, never hang an unattended job
    $smtp.Credentials = $cred.GetNetworkCredential()
    try { $smtp.Send($msg) } finally { $msg.Dispose(); $smtp.Dispose() }
    Write-Output "lib_mail: failure email sent to $To"
  } catch {
    Write-Output "lib_mail: ERROR sending email: $($_.Exception.Message)"
  }
}

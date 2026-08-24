# lib_mail.ps1
#
# Best-effort failure-alert helper: EMAIL plus an ntfy.sh PUSH. Sourced by
# scheduled_download.ps1, refresh_assets.ps1 and rebuild_tiles.ps1 so a silent
# failure of an unattended job lands on Jason the day it happens, not at the
# next appraisal.
#
# Tolerant by design: any error (missing module, missing credential,
# SMTP rejection, no network) is logged and swallowed. The FAILED-*.txt
# marker at the WpgSnapshots archive root (written by the .ps1 jobs
# themselves) remains the zero-dependency fallback signal -- email is
# additive on top of that.
#
# *** WHY TWO CHANNELS ***
#
# One channel is one silent failure away from no channel. Email here rides on a
# Gmail app password in Windows Credential Manager; the day that password is
# revoked or the credential store is reset, every alert stops and nothing says
# so -- the watchdogs go quiet exactly when they matter. The Manitoba sister
# project hit this on 2026-08-12 and the fix there was the same shape: send on
# both, and RECORD WHICH CHANNEL ACTUALLY WORKED rather than collapsing the two
# into one boolean.
#
# *** PUSH ACCEPTANCE IS NOT DELIVERY ***
#
# ntfy.sh's anonymous publish answers HTTP 200 for ANY topic string, including
# one that nobody has ever subscribed to. So a successful push proves ntfy took
# the message, never that a human saw it. That is why the topics carry the -jks
# suffix used across these projects: they are the exact strings subscribed in
# the ntfy app on Jason's phone, and a merely-plausible variant would report
# success forever while reaching no one. Do not "tidy" a topic name.
#
# After any Send-FailureMail call, $global:WpgLastAlert holds the per-channel
# outcome and Test-AlertDelivered answers "is this verifiably delivered?".
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

# Default ntfy topic, used when a caller does not name its own. Every job
# SHOULD name its own (see the -Topic parameter) so a push says which job broke
# without opening the body. The -jks suffix is load-bearing -- see the header.
$WPG_NTFY_DEFAULT_TOPIC = 'wpgps-alerts-jks'

# Publish to ntfy.sh. Returns $true when ntfy ACCEPTED the message, which is
# emphatically not the same as a human receiving it (see the header). Never
# throws: an unattended job must not die because a notification service did.
function Send-AlertPush {
  param(
    [Parameter(Mandatory)][string]$Topic,
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][string]$Body
  )
  try {
    # TLS 1.2 for the same reason the mail path forces it: Windows PowerShell
    # 5.1 is the scheduled-task runtime and still defaults to 1.0/1.1.
    try { [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
    # The title rides in an HTTP header, so it must be ASCII.
    Invoke-RestMethod -Uri "https://ntfy.sh/$Topic" -Method Post `
      -Headers @{ Title = $Title; Priority = 'high'; Tags = 'rotating_light' } `
      -Body $Body -ContentType 'text/plain' -TimeoutSec 30 | Out-Null
    Write-Output "lib_mail: pushed to ntfy.sh/$Topic (accepted by ntfy; subscribe to that topic in the ntfy app to receive it)"
    return $true
  } catch {
    Write-Output "lib_mail: ntfy push FAILED: $($_.Exception.Message)"
    return $false
  }
}

# Per-channel outcome of the LAST Send-FailureMail call in this process.
# Keys: Emailed / Pushed / EmailConfigured / Delivered (bool), Subject, Topic,
# To, When. $null before the first call.
#
# Deliberately a side-channel rather than a return value: Send-FailureMail's
# existing callers pipe its output into Tee-Object to get the human lines into
# the task log, so anything it returns would land in the log as noise.
$global:WpgLastAlert = $null

# Is this alert verifiably in front of a human?
#   * email sent                            -> yes.
#   * email not configured AND push accepted -> yes; push is the best channel
#     this install has, and treating it as failure would nag every run.
#   * email configured but FAILED            -> NO, whatever push did. That is
#     the revoked-app-password case, and the point of the distinction: a job
#     that suppresses repeat alerts must keep alerting through it.
function Test-AlertDelivered {
  $s = $global:WpgLastAlert
  if (-not $s) { return $false }
  if ($s.Emailed) { return $true }
  return ((-not $s.EmailConfigured) -and $s.Pushed)
}

# Email half only. Returns $true on a real send. Split out of
# Send-FailureMail so "was the email configured?" and "did the email go?" are
# two separate answers -- collapsing them is what lets a dead SMTP path look
# like a working alert path.
function Send-AlertEmail {
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
      return $false
    }
    Import-Module CredentialManager -ErrorAction Stop
    $cred = $null
    try { $cred = Get-StoredCredential -Target $CredentialTarget -ErrorAction Stop } catch {}
    if (-not $cred) {
      Write-Output "lib_mail: no '$CredentialTarget' credential found - skipping email (run New-StoredCredential per lib_mail.ps1 setup)."
      return $false
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
    return $true
  } catch {
    Write-Output "lib_mail: ERROR sending email: $($_.Exception.Message)"
    return $false
  }
}

# Is the email channel set up at all? Asked in exactly one place so
# "configured" cannot come to mean two different things in two places.
function Test-AlertEmailConfigured {
  param([string]$CredentialTarget = 'WpgScheduleMail')
  if (-not (Get-Module -ListAvailable -Name CredentialManager)) { return $false }
  try {
    Import-Module CredentialManager -ErrorAction Stop
    $c = Get-StoredCredential -Target $CredentialTarget -ErrorAction SilentlyContinue
    return [bool]$c
  } catch { return $false }
}

# Fire BOTH channels for one alert.
#
# Name and output shape are unchanged from when this was email-only, because
# every caller does `Send-FailureMail ... | Tee-Object -FilePath $log -Append`
# and relies on the human-readable lines reaching the task log. It therefore
# returns nothing; the machine-readable outcome is in $global:WpgLastAlert and
# the verdict is Test-AlertDelivered.
function Send-FailureMail {
  param(
    [Parameter(Mandatory)][string]$Subject,
    [Parameter(Mandatory)][string]$Body,
    [string]$To = 'jason@jksconsultinginc.com',
    [string]$CredentialTarget = 'WpgScheduleMail',
    [string]$SmtpServer = 'smtp.gmail.com',
    [int]   $SmtpPort = 587,
    # Per-job ntfy topic. Defaults to the catch-all; every scheduled job
    # should pass its own so the push names the job on the lock screen.
    [string]$Topic = $WPG_NTFY_DEFAULT_TOPIC
  )

  $emailConfigured = Test-AlertEmailConfigured -CredentialTarget $CredentialTarget
  $emailed = Send-AlertEmail -Subject $Subject -Body $Body -To $To `
               -CredentialTarget $CredentialTarget -SmtpServer $SmtpServer -SmtpPort $SmtpPort
  # ntfy caps the title; the body carries the detail either way.
  $pushed = Send-AlertPush -Topic $Topic -Title $Subject -Body $Body

  $global:WpgLastAlert = @{
    Emailed         = [bool]$emailed
    Pushed          = [bool]$pushed
    EmailConfigured = [bool]$emailConfigured
    Subject         = $Subject
    Topic           = $Topic
    To              = $To
    When            = (Get-Date)
  }
  $global:WpgLastAlert.Delivered = [bool](Test-AlertDelivered)

  # One line on EVERY send, so the log records what each channel did. Before
  # this the email half left no trace either way -- which is how a dead SMTP
  # path sits unnoticed for months. Assigned to variables first, not inlined:
  # Windows PowerShell 5.1 will not take an 'if' expression as an argument.
  $emailWord = if (-not $emailConfigured) { 'not-configured' }
               elseif ($emailed)          { 'SENT' }
               else                       { 'FAILED' }
  $pushWord  = if ($pushed) { 'accepted-by-ntfy' } else { 'FAILED' }
  $verdict   = if ($global:WpgLastAlert.Delivered) { 'delivery VERIFIED' }
               else { 'delivery NOT verified' }
  Write-Output "lib_mail: ALERT CHANNELS: email=$emailWord push=$pushWord ($Topic) -- $verdict"
}

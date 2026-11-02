# run_scheduled_job.ps1
#
# Runs a scheduled ParcelSearch job from its OWN clone of the repo, never from
# the shared checkout under Dropbox.
#
# Why: rebuild_tiles.ps1 commits a checksum and pushes it to main, so it
# refuses to run on a feature branch. Sessions do feature work in the shared
# checkout, and on 2026-11-02 one had left it on feat/adf-location-maps
# overnight: the 03:00 rebuild refused, and the month's tiles waited for a
# human. The job clone belongs to the scheduled jobs alone, so nothing done in
# the shared checkout can block what runs at 03:00, or change which code runs.
#
#   D:\wpg-jobs\ParcelSearch   a full clone on main, brought up to origin/main
#                              before every run. Outside Dropbox, and on D:
#                              beside D:\wpg-tile-staging, which the publish
#                              step hardlinks into.
#
# A clone, not a `git worktree`: a worktree keeps its index inside the shared
# checkout's .git, which is under Dropbox, and Dropbox holding that file made
# a rebase fail half-way in testing ("could not write index"), leaving the
# working tree changed with no rebase to abort. A clone has no git state in
# Dropbox at all. The repo is ~8 MB.
#
# The task runs the clone's OWN copy of this launcher, so a feature branch in
# the shared checkout cannot change the launcher either. PowerShell parses the
# whole file before running it, so the rebase below may update this very file
# mid-run; the job itself starts as a fresh process after the rebase and so
# always runs origin/main's code.
#
#   powershell -ExecutionPolicy Bypass -File D:\wpg-jobs\ParcelSearch\r\run_scheduled_job.ps1 -Job rebuild_tiles
#   powershell -ExecutionPolicy Bypass -File <any checkout>\r\run_scheduled_job.ps1 -SetupOnly
#     (create or refresh the job clone and run nothing; r\setup_schedule.ps1 does this)
#
# ASCII-ONLY (same reason as lib_mail.ps1).

param(
  [ValidateSet('rebuild_tiles')] [string] $Job = 'rebuild_tiles',
  [switch] $SetupOnly,
  # Overridable so the launcher can be exercised against a scratch clone of a
  # local repo without touching the real ones.
  [string] $JobTree = 'D:\wpg-jobs\ParcelSearch',
  [string] $Remote  = 'https://github.com/jayschellenberg/winnipeg-opendata-parcelsearch.git',
  [string] $Branch  = 'main',
  # Test hook: log the failure and exit 1 without sending an alert.
  [switch] $NoAlert
)

$ErrorActionPreference = 'Continue'

$archiveRoot = 'D:\Dropbox\Appraisal\Web\WpgSnapshots'
$topics      = @{ rebuild_tiles = 'wpgps-parcel-tiles-jks' }
$base        = "origin/$Branch"

$logDir = Join-Path $archiveRoot '_download_logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("run_scheduled_job_{0}.log" -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
function Log($m) { ('{0}  {1}' -f (Get-Date -Format 's'), $m) | Tee-Object -FilePath $log -Append | Out-Null; Write-Output $m }

. (Join-Path $PSScriptRoot 'lib_mail.ps1')

function Fail($why) {
  Log "FAILED: $why"
  if (-not $NoAlert) {
    Send-FailureMail -Subject "Wpg Open Data: scheduled $Job did NOT run - job clone problem" `
      -Body ("$why`n`nThe job never started: nothing was built or published, and production is unchanged.`n" +
             "Job clone: $JobTree`nLog: $log") `
      -Topic $topics[$Job] | Tee-Object -FilePath $log -Append | Out-Null
  }
  exit 1
}

Log "=== run_scheduled_job: $Job $(if ($SetupOnly) { '(setup only)' }) ==="
Log "  job clone: $JobTree   branch: $Branch"

if (-not (Test-Path (Join-Path $JobTree '.git'))) {
  if ((Test-Path $JobTree) -and (Get-ChildItem $JobTree -Force | Select-Object -First 1)) {
    Fail "$JobTree exists but is not a git clone - move it aside and re-run."
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $JobTree) | Out-Null
  & git clone -q --branch $Branch $Remote $JobTree *>> $log
  if ($LASTEXITCODE -ne 0) { Fail "git clone $Remote into $JobTree failed (exit $LASTEXITCODE)." }
  Log "  cloned $Remote ($Branch)"
}

$fetched = $false
foreach ($wait in @(0, 15, 60)) {
  if ($wait -gt 0) { Start-Sleep -Seconds $wait }
  & git -C $JobTree fetch -q origin *>> $log
  if ($LASTEXITCODE -eq 0) { $fetched = $true; break }
}
if (-not $fetched) { Fail "git fetch failed 3 times in $JobTree." }

$current = ("$(& git -C $JobTree rev-parse --abbrev-ref HEAD)").Trim()
if ($current -ne $Branch) {
  Fail "the job clone is on '$current', not '$Branch'. It belongs to the scheduled jobs: switch it back (git -C $JobTree switch $Branch)."
}

# The jobs revert their own tracked files when they fail, so a tracked edit
# here is a human's or a crashed run's - and the rebase would carry it into
# the next scheduled commit. Stop and let someone look.
$dirty = & git -C $JobTree status --porcelain --untracked-files=no
if ($dirty) {
  Fail ("the job clone has uncommitted tracked changes:`n{0}`nInspect them, then commit or discard (git -C $JobTree restore .)." -f ($dirty -join "`n"))
}

# Rebase, not reset: a checksum commit whose push failed is what pins the live
# release asset, and a reset would throw it away. The rebase keeps it on top of
# origin/main, and the job's own push then delivers it. A conflict means
# origin/main moved the same files (someone else published), so stop rather
# than guess which checksum is right.
$kept = ("$(& git -C $JobTree rev-list --count "$base..HEAD")").Trim()
& git -C $JobTree rebase -q $base *>> $log
if ($LASTEXITCODE -ne 0) {
  & git -C $JobTree rebase --abort *>> $log
  Fail "git rebase onto $base failed in the job clone (its $kept unpushed commit(s) conflict with $base); rebase aborted. Push or drop them by hand."
}
$head = ("$(& git -C $JobTree rev-parse --short HEAD)").Trim()
Log "  job clone at $head ($kept unpushed commit(s) kept on top of $base)"

if ($SetupOnly) { Log '=== setup only: done ==='; exit 0 }

$script = Join-Path $JobTree "r\$Job.ps1"
Log "  running $script"
& powershell -NoProfile -ExecutionPolicy Bypass -File $script
$code = $LASTEXITCODE
Log "=== $Job exited $code ==="
exit $code

# core.ps1 - the Windows counterpart of core.sh for a LOCAL checkout.
#
# Windows had no equivalent at all: core.sh is bash, and install.ps1 is a
# fresh-install bootstrapper that CLONES from GitHub, so neither can build and
# deploy the checkout you already have. Every Windows deploy was therefore done
# by hand - tar, scp, copy files into the install dir - which is exactly how a
# deploy ships the wrong thing (a core/dist-only sync on 2026-07-28 silently
# missed bin/lm-assist.js).
#
# The intended workflow:
#     git pull                      # sync this checkout to main
#     .\core.ps1 deploy             # build -> pack -> install -> verify
#
# Usage:
#   .\core.ps1 build                 Build Core (TypeScript)
#   .\core.ps1 pack                  Build a prod tarball (lm-assist-<ver>.tgz)
#   .\core.ps1 deploy [-AllowDirty]  Pack THIS checkout, install it, verify
#   .\core.ps1 status                Show service status
#   .\core.ps1 help
#
# `deploy` refuses a dirty or behind-origin/main checkout by default: the point
# is that what runs on the node equals what is on main. -AllowDirty when you are
# deliberately testing local changes.

param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [switch]$AllowDirty
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ApiPort = if ($env:API_PORT) { $env:API_PORT } else { '3100' }

function Info($m) { Write-Host "[core] $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host "[core] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[core] $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "[core] $m" -ForegroundColor Red }

# Take only the LAST value a function emits. PowerShell returns every uncaptured
# object, so a stray Write-Output or command stdout would otherwise be read as the
# result - which made a failed deploy exit 0 on 2026-07-28.
function Last($v) { if ($v -is [array]) { return $v[-1] } return $v }


# Resolve a WORKING git. On at least one node a scoop shim shadows a healthy
# Git install and fails with "Could not create process", which breaks any
# sync-then-deploy flow - so prefer a real git.exe over whatever is first on PATH.
function Get-Git {
  foreach ($c in @(
    'C:\Program Files\Git\cmd\git.exe',
    'C:\Program Files (x86)\Git\cmd\git.exe'
  )) { if (Test-Path $c) { return $c } }
  $g = Get-Command git -ErrorAction SilentlyContinue
  if ($g) { return $g.Source }
  return $null
}

function Invoke-Git($gitExe, [string[]]$GitArgs) {
  try { return (& $gitExe @GitArgs 2>$null) } catch { return $null }
}

function Do-Build {
  Info 'Building Core (TypeScript)...'
  Push-Location $Root
  try {
    & npm run build:core | Out-Host
    if ($LASTEXITCODE -ne 0) { Err 'build failed'; return $false }
    Ok 'Core built.'
    return $true
  } finally { Pop-Location }
}

function Do-Pack {
  Info 'Packing prod tarball...'
  Push-Location $Root
  try {
    # --ignore-scripts: onnxruntime-node's native postinstall fails here and is
    # not needed to pack. npm pack itself runs prepare (build:core + build:web).
    Info 'Ensuring dependencies (npm install --ignore-scripts)...'
    & npm install --ignore-scripts --no-audit --no-fund | Out-Null
    if ($LASTEXITCODE -ne 0) { Err 'npm install failed'; return $null }
    Get-ChildItem -Path $Root -Filter 'lm-assist-*.tgz' -ErrorAction SilentlyContinue | Remove-Item -Force
    Info 'Running npm pack (builds core + web)...'
    & npm pack | Out-Null
    if ($LASTEXITCODE -ne 0) { Err 'npm pack failed'; return $null }
    $tgz = Get-ChildItem -Path $Root -Filter 'lm-assist-*.tgz' | Select-Object -First 1
    if (-not $tgz) { Err 'npm pack produced no tarball'; return $null }
    Ok ("Packed: " + $tgz.FullName)
    return $tgz.FullName
  } finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# Elevated-worker relocation
#
# The worker runs FROM the install dir (core\dist\elevated\worker.js). On Windows
# a directory cannot be renamed while a process holds files open inside it, and
# `npm install -g` replaces the package by renaming - so the worker makes every
# upgrade fail with EBUSY. (Linux never hits this: an open file can be renamed.)
#
# Rather than stop a privileged helper on every deploy, relocate it ONCE to a
# 4-file, zero-dependency copy outside node_modules. Verified closure:
#   elevated\worker.js  elevated\common.js  auth\api-token.js  utils\path-utils.js
# ...requiring only node builtins, so no node_modules is needed at the new home.
#
# Order matters. The worker is SINGLE-INSTANCE: a second one exits 0 on
# EADDRINUSE, so "start the new one and let it kill the old" cannot work. And the
# scheduled task must be re-pointed BEFORE the handoff, so a crash midway still
# leaves a task aimed somewhere valid rather than at a path the upgrade deletes.
$WorkerRoot = Join-Path $env:USERPROFILE '.lm-assist\worker-runtime'
$WorkerTask = 'LmAssistElevatedWorker'
$WorkerPort = 3110

function Get-WorkerProc {
  $l = Get-NetTCPConnection -LocalPort $WorkerPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $l) { return $null }
  return (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $l.OwningProcess) -ErrorAction SilentlyContinue)
}

# Ask the RUNNING elevated worker to do a privileged thing. Used for schtasks
# /change, which needs admin - the worker already has it, so the deploy does not.
# NOTE the worker joins `args` with plain spaces and NO quoting
# (`${cmd} ${args.join(' ')}`), so an argument containing quotes or spaces is
# re-parsed by the shell and mangled. Send ONE fully-quoted command string
# instead, and use powershell as the shell because single quotes there preserve
# the embedded double quotes that schtasks /tr requires.
function Invoke-WorkerExec($cmd, $Shell = 'powershell') {
  $tokenFile = Join-Path $env:USERPROFILE '.lm-assist\api-token'
  if (-not (Test-Path $tokenFile)) { return $null }
  $token = (Get-Content $tokenFile -Raw).Trim()
  $body = @{ cmd = $cmd; shell = $Shell } | ConvertTo-Json -Compress
  try {
    return Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$WorkerPort/exec" `
      -Headers @{ 'x-api-key' = $token; 'content-type' = 'application/json' } -Body $body -TimeoutSec 30
  } catch { return $null }
}

function Ensure-WorkerRelocated($installRoot) {
  $proc = Get-WorkerProc
  if (-not $proc) { Info 'elevated worker not running - nothing to relocate'; return $true }
  if ($proc.CommandLine -notlike "*node_modules\lm-assist*") {
    Info 'elevated worker already runs outside the install dir - no relocation needed'
    return $true
  }

  Info 'elevated worker runs FROM the install dir - relocating it so the upgrade cannot hit EBUSY'

  # 1. Copy the closure, mirroring core\dist so the relative requires resolve.
  $srcDist = Join-Path $installRoot 'core\dist'
  $files = @(
    @{ from = 'elevated\worker.js';   to = 'elevated\worker.js' },
    @{ from = 'elevated\common.js';   to = 'elevated\common.js' },
    @{ from = 'auth\api-token.js';    to = 'auth\api-token.js' },
    @{ from = 'utils\path-utils.js';  to = 'utils\path-utils.js' }
  )
  foreach ($f in $files) {
    $src = Join-Path $srcDist $f.from
    if (-not (Test-Path $src)) { Err ("missing from the build: " + $f.from); return $false }
    $dst = Join-Path $WorkerRoot $f.to
    New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
    Copy-Item $src $dst -Force
  }
  $newWorker = Join-Path $WorkerRoot 'elevated\worker.js'
  if (-not (Test-Path $newWorker)) { Err 'copy failed'; return $false }
  Info ("copied worker closure to " + $WorkerRoot)

  # 2. Re-point the task FIRST (via the worker's own elevation).
  $nodeExe = (Get-Command node).Source
  $tr = '"{0}" "{1}" --port {2}' -f $nodeExe, $newWorker, $WorkerPort
  # Single-quoted /tr so the inner double quotes survive to schtasks intact.
  $psCmd = "schtasks /change /tn $WorkerTask /tr '$tr'"
  $r = Invoke-WorkerExec $psCmd
  if (-not $r -or $r.exitCode -ne 0) {
    Warn 'could not re-point the task via the worker; trying directly (needs admin)'
    & schtasks /change /tn $WorkerTask /tr $tr | Out-Host
    if ($LASTEXITCODE -ne 0) { Err 'failed to re-point the scheduled task - aborting relocation'; return $false }
  }
  Info 'scheduled task now points at the relocated worker'

  # 3. Stop the old worker, THEN start the new one (single-instance guard).
  try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch { }
  Start-Sleep -Seconds 3
  & schtasks /run /tn $WorkerTask | Out-Null

  # 4. Verify by OBSERVATION: running, and demonstrably outside the install dir.
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    $now = Get-WorkerProc
    if ($now -and $now.CommandLine -notlike "*node_modules\lm-assist*") {
      Ok ("elevated worker relocated: pid=" + $now.ProcessId + " now outside node_modules")
      return $true
    }
  }
  Err 'worker did not come back outside the install dir - refusing to continue'
  Warn ("start it manually: schtasks /run /tn " + $WorkerTask)
  return $false
}

function Do-Deploy {
  Info 'Deploying this checkout to the local install...'

  # --- provenance gate ---------------------------------------------------
  $git = Get-Git
  if ($git -and (Test-Path (Join-Path $Root '.git'))) {
    $branch = Invoke-Git $git @('-C', $Root, 'rev-parse', '--abbrev-ref', 'HEAD')
    $head   = Invoke-Git $git @('-C', $Root, 'rev-parse', '--short', 'HEAD')
    $dirty  = @(Invoke-Git $git @('-C', $Root, 'status', '--porcelain')).Count
    Invoke-Git $git @('-C', $Root, 'fetch', 'origin', '--quiet') | Out-Null
    $behindRaw = Invoke-Git $git @('-C', $Root, 'rev-list', '--count', 'HEAD..origin/main')
    $behind = if ($behindRaw) { [int]$behindRaw } else { 0 }
    Info ("source: {0} @ {1}  (dirty={2}, behind origin/main={3})" -f $branch, $head, $dirty, $behind)
    if (-not $AllowDirty) {
      if ($dirty -gt 0) {
        Err "Refusing: working tree has $dirty uncommitted file(s)."
        Warn 'A deploy should be reproducible from git. Commit them, or pass -AllowDirty.'
        return $false
      }
      if ($behind -gt 0) {
        Err "Refusing: this checkout is $behind commit(s) behind origin/main."
        Warn 'Run git pull first, or pass -AllowDirty.'
        return $false
      }
    } elseif ($dirty -gt 0 -or $behind -gt 0) {
      Warn '-AllowDirty: deploying a build that does NOT match origin/main.'
    }
  } elseif (-not $git) {
    Warn 'No working git found - deploying without a provenance check.'
    Warn 'If a scoop shim is shadowing Git, prefer C:\Program Files\Git\cmd\git.exe.'
  }

  # --- free the install dir ----------------------------------------------
  # Must happen BEFORE the install: a process running from node_modules\lm-assist
  # makes `npm install -g` fail with EBUSY, and the worker's task restarts it
  # faster than npm can rename the directory.
  $instRoot = Join-Path (& npm root -g) 'lm-assist'
  if (-not (Last(Ensure-WorkerRelocated $instRoot))) { return $false }

  # --- pack --------------------------------------------------------------
  $tgz = Do-Pack
  if (-not $tgz) { return $false }

  # --- install -----------------------------------------------------------
  # `lm-assist upgrade --from` rather than `npm i -g`: it restarts services and
  # records the install source, so `lm-assist version` reports what is actually
  # running instead of what npm last published.
  Info "Installing $tgz via lm-assist upgrade --from ..."
  $cli = Get-Command lm-assist -ErrorAction SilentlyContinue
  if (-not $cli) { Err "lm-assist CLI not on PATH - install once with: npm install -g `"$tgz`""; return $false }
  & lm-assist upgrade --from $tgz | Out-Host
  if ($LASTEXITCODE -ne 0) { Err 'upgrade failed'; return $false }

  # --- verify ------------------------------------------------------------
  # Deploying and declaring success without checking is the failure this command
  # exists to remove.
  Info 'Verifying...'
  $healthy = $false
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/health" -TimeoutSec 8 | Out-Null; $healthy = $true } catch { }
  Info ("core health: " + $(if ($healthy) { 'OK' } else { 'DOWN' }))

  # Windows-specific and the reason this matters here: a Core in session 0 is
  # healthy and can drive nothing. Report the session it actually landed in.
  $l = Get-NetTCPConnection -LocalPort ([int]$ApiPort) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($l) {
    $p = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
    Info ("core pid={0} windows-session={1}" -f $l.OwningProcess, $p.SessionId)
    if ($p.SessionId -eq 0) {
      Err 'Core is in Windows session 0 - it cannot type into sessions or create terminals.'
      Warn 'Start it via: schtasks /run /tn LmAssistCoreInteractive'
      return $false
    }
  }
  if ($healthy) { Ok 'Deployed and healthy.'; return $true }
  Err 'Deployed but Core is not healthy - check: lm-assist logs core'
  return $false
}

switch ($Command.ToLower()) {
  'build'  { if (Last(Do-Build)) { exit 0 } else { exit 1 } }
  'pack'   { if (Last(Do-Pack))  { exit 0 } else { exit 1 } }
  'deploy' { if (Last(Do-Deploy)) { exit 0 } else { exit 1 } }
  'status' { & lm-assist status; exit $LASTEXITCODE }
  default  {
    Write-Host ''
    Write-Host 'core.ps1 - build / pack / deploy this checkout (Windows)'
    Write-Host ''
    Write-Host '  .\core.ps1 build                 Build Core (TypeScript)'
    Write-Host '  .\core.ps1 pack                  Build a prod tarball (lm-assist-<ver>.tgz)'
    Write-Host '  .\core.ps1 deploy [-AllowDirty]  Pack THIS checkout, install it, verify'
    Write-Host '  .\core.ps1 status                Show service status'
    Write-Host ''
    Write-Host '  Typical: git pull ; .\core.ps1 deploy'
    Write-Host ''
    Write-Host '  deploy refuses a dirty or behind-origin/main checkout unless -AllowDirty,'
    Write-Host '  and fails if Core lands in Windows session 0 (where it can drive nothing).'
    Write-Host ''
    exit 0
  }
}

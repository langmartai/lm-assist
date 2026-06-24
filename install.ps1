# install.ps1 - One-command installer for lm-assist (Windows)
#
# Usage:
#   irm https://raw.githubusercontent.com/langmartai/lm-assist/main/install.ps1 | iex
#   # dev mode:  $env:LM_ASSIST_MODE='dev'; irm https://.../install.ps1 | iex
#   # pin a build (tag/branch/commit, no npm publish):  $env:LM_ASSIST_REF='v0.1.76'; irm https://.../install.ps1 | iex
#   # (as a file)  powershell -ExecutionPolicy Bypass -File install.ps1 -Dev -Ref v0.1.76
#   # install a specific published npm version (or latest):
#   #   powershell -ExecutionPolicy Bypass -File install.ps1 -Published 0.1.76
#   #   powershell -ExecutionPolicy Bypass -File install.ps1 -Published        # installs latest
#   # force a source-build even when a prebuilt release tgz is available:
#   #   powershell -ExecutionPolicy Bypass -File install.ps1 -SourceBuild
#
# Mirrors install.sh: bare gate -> plugin -> clone -> PREFLIGHT -> build -> start.
# prod (default): prefer prebuilt GitHub-Release tgz; fall back to source-build.
# -Published:     npm install -g lm-assist@<ver|latest> (registry).
# -SourceBuild:   skip prebuilt tgz, always source-build (npm pack -> npm install -g).
# -Dev:           npm install --ignore-scripts -> build -> node bin\lm-assist.js (dev :3200/:3948).

param([switch]$Dev, [string]$Ref = '', [string]$Published = '', [switch]$SourceBuild)
$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "[lm-assist] $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host "[lm-assist] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[lm-assist] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[lm-assist] $m" -ForegroundColor Red; exit 1 }

function Write-Marker($kind, $source, $version) {
  try {
    $d = if ($env:LM_ASSIST_DATA_DIR) { $env:LM_ASSIST_DATA_DIR } else { Join-Path $env:USERPROFILE '.lm-assist' }
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $v = if ($version) { '"' + $version + '"' } else { 'null' }
    $json = '{ "kind": "' + $kind + '", "source": "' + $source + '", "version": ' + $v + ', "installedAt": "' + (Get-Date).ToUniversalTime().ToString('o') + '" }'
    Set-Content -Path (Join-Path $d 'install-source.json') -Value $json -Encoding ascii
  } catch { }
}

$Mode = if ($Dev -or $env:LM_ASSIST_MODE -eq 'dev') { 'dev' } else { 'prod' }
$InstallDir = if ($env:LM_ASSIST_DIR) { $env:LM_ASSIST_DIR } else { Join-Path $env:USERPROFILE 'lm-assist' }
if (-not $Ref -and $env:LM_ASSIST_REF) { $Ref = $env:LM_ASSIST_REF }   # optional: pin to a tag/branch/commit
if (-not $Published -and $env:LM_ASSIST_PUBLISHED) { $Published = $env:LM_ASSIST_PUBLISHED }

# -Published implies prod (registry) install - ignore -Dev if both given
if ($Published -and $Mode -eq 'dev') { Warn '-Published implies a prod (registry) install - ignoring -Dev'; $Mode = 'prod' }

# --- Prerequisites (bare gate) ---
Info 'Checking prerequisites...'
foreach ($c in @('git','node','npm','claude')) {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) {
    if ($c -eq 'node') { Fail 'node is required (>= 20.9). Install from https://nodejs.org or nvm-windows: nvm install 20.19.6 ; nvm use 20.19.6' }
    elseif ($c -eq 'claude') { Fail 'claude (Claude Code CLI) is required: https://docs.anthropic.com/en/docs/claude-code' }
    else { Fail "$c is required but not installed" }
  }
}
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { Fail "Node.js >= 20.9 is required (found $(node -v)). Upgrade (nvm install 20.19.6 ; nvm use 20.19.6) and re-run." }
Ok "Prereqs present (node $(node -v)) - mode: $Mode"

# --- Step 1: Plugin ---
Info 'Adding marketplace + installing plugin...'
try { claude plugin marketplace add langmartai/lm-assist 2>$null } catch { Warn 'Marketplace may already be added' }
try { claude plugin install lm-assist@langmartai } catch { Warn 'Plugin install returned non-zero (may already be installed)' }

# --- Step 2: Clone / pull (skipped for -Published; optionally pinned to -Ref tag/branch/commit) ---
if (-not $Published) {
  if (Test-Path (Join-Path $InstallDir '.git')) {
    Info "Updating existing checkout at $InstallDir..."
    git -C $InstallDir fetch --tags --quiet origin 2>$null
    if ($Ref) {
      Info "Checking out pinned ref: $Ref"
      git -C $InstallDir checkout --quiet $Ref 2>$null
      if ($LASTEXITCODE -ne 0) { Fail "Could not checkout ref: $Ref" }
    } else {
      git -C $InstallDir pull --ff-only 2>$null
      if ($LASTEXITCODE -ne 0) { Warn 'Could not fast-forward (local changes?) - continuing' }
    }
  } else {
    Info "Cloning lm-assist to $InstallDir..."
    git clone https://github.com/langmartai/lm-assist.git $InstallDir
    if ($Ref) {
      Info "Checking out pinned ref: $Ref"
      git -C $InstallDir checkout --quiet $Ref
      if ($LASTEXITCODE -ne 0) { Fail "Could not checkout ref: $Ref" }
    }
  }
  Set-Location $InstallDir

  # --- Step 3: Install deps (--ignore-scripts) + PREFLIGHT ---
  Info 'Installing dependencies (this can take a minute)...'
  npm install --ignore-scripts --no-audit --no-fund | Select-Object -Last 1
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' }
  Info 'Running preflight (authoritative environment check)...'
  node scripts\preflight.js --phase=post-clone --repo="$InstallDir"
  if ($LASTEXITCODE -ne 0) { Fail 'Preflight failed - resolve the issues above and re-run.' }
}

# --- Step 4: Build + start by mode ---
if ($Mode -eq 'dev') {
  Info 'Building (dev)...'
  npm run build | Select-Object -Last 20
  if ($LASTEXITCODE -ne 0) { Fail 'build failed' }
  Ok "Build complete (dev). Start with: node bin\lm-assist.js start   (dev API :3200 / Web :3948)"
} else {
  if ($Published) {
    $ver = if ($Published -eq '1' -or $Published -eq 'true') { 'latest' } else { $Published }
    Info "Installing published lm-assist@$ver from npm..."
    npm install -g "lm-assist@$ver" | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { Fail 'published install failed' }
    Write-Marker 'published' "lm-assist@$ver" $(if ($ver -eq 'latest') { (npm view lm-assist version) } else { $ver })
    Ok "Installed published lm-assist@$ver."
  } else {
    $assetUrl = ''
    if (-not $SourceBuild) {
      if ($Ref) {
        $v = $Ref -replace '^v',''
        $u = "https://github.com/langmartai/lm-assist/releases/download/$Ref/lm-assist-$v.tgz"
        try { if ((Invoke-WebRequest -UseBasicParsing -Method Head -TimeoutSec 15 $u).StatusCode -eq 200) { $assetUrl = $u } } catch { }
      } else {
        try { $rel = Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 'https://api.github.com/repos/langmartai/lm-assist/releases/latest'; $a = $rel.assets | Where-Object { $_.name -match '^lm-assist-.*\.tgz$' } | Select-Object -First 1; if ($a) { $assetUrl = $a.browser_download_url } } catch { }
      }
    }
    if ($assetUrl) {
      Info "Installing prebuilt release: $assetUrl"
      npm install -g $assetUrl | Select-Object -Last 3
      if ($LASTEXITCODE -ne 0) { Fail 'release install failed' }
      Write-Marker 'custom' $assetUrl $null
      Ok 'Installed prebuilt release build.'
    } else {
      Info 'No prebuilt release - source-building...'
      npm pack | Select-Object -Last 1
      if ($LASTEXITCODE -ne 0) { Fail 'npm pack failed' }
      $tgz = Get-ChildItem -Filter 'lm-assist-*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if (-not $tgz) { Fail 'npm pack did not produce a tgz' }
      npm install -g ".\$($tgz.Name)" | Select-Object -Last 3
      if ($LASTEXITCODE -ne 0) { Fail 'global install failed' }
      $br = if ($Ref) { $Ref } else { (git -C $InstallDir rev-parse --abbrev-ref HEAD) }
      Write-Marker 'custom' "github:langmartai/lm-assist#$br" $null
      Ok 'Installed source build.'
    }
  }
}

# --- .env ---
if (-not (Test-Path (Join-Path $InstallDir '.env')) -and (Test-Path (Join-Path $InstallDir '.env.example'))) {
  Copy-Item (Join-Path $InstallDir '.env.example') (Join-Path $InstallDir '.env')
  Warn 'Created .env from .env.example - edit to add ANTHROPIC_API_KEY'
}

Write-Host ''
Ok "lm-assist installed ($Mode). Source: $InstallDir"
if ($Mode -eq 'dev') {
  Write-Host '  Next: node bin\lm-assist.js start   (dev API :3200 / Web :3948)'
} else {
  Write-Host '  Next: lm-assist status   (API :3100 / Web :3848, auto-started); lm-assist doctor to re-check.'
}
Write-Host '  Then open a NEW Claude Code session (activates MCP/hooks) and run /assist-setup.'
Write-Host '  (Connecting to a hub is a separate, optional step: lm-assist setup --key <KEY>)'

# install.ps1 - One-command installer for lm-assist (Windows)
#
# Usage:
#   irm https://raw.githubusercontent.com/langmartai/lm-assist/main/install.ps1 | iex
#   # dev mode:  $env:LM_ASSIST_MODE='dev'; irm https://.../install.ps1 | iex
#   # (as a file)  powershell -ExecutionPolicy Bypass -File install.ps1 -Dev
#
# Mirrors install.sh: bare gate -> plugin -> clone -> PREFLIGHT -> build -> start.
# prod (default): npm pack -> npm install -g .\tgz (CLI + services :3100/:3848).
# -Dev:           npm install --ignore-scripts -> build -> node bin\lm-assist.js (dev :3200/:3948).

param([switch]$Dev)
$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "[lm-assist] $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host "[lm-assist] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[lm-assist] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[lm-assist] $m" -ForegroundColor Red; exit 1 }

$Mode = if ($Dev -or $env:LM_ASSIST_MODE -eq 'dev') { 'dev' } else { 'prod' }
$InstallDir = if ($env:LM_ASSIST_DIR) { $env:LM_ASSIST_DIR } else { Join-Path $env:USERPROFILE 'lm-assist' }

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

# --- Step 2: Clone / pull ---
if (Test-Path (Join-Path $InstallDir '.git')) {
  Info "Updating existing checkout at $InstallDir..."
  git -C $InstallDir pull --ff-only 2>$null
  if ($LASTEXITCODE -ne 0) { Warn 'Could not fast-forward (local changes?) - continuing' }
} else {
  Info "Cloning lm-assist to $InstallDir..."
  git clone https://github.com/langmartai/lm-assist.git $InstallDir
}
Set-Location $InstallDir

# --- Step 3: Install deps (--ignore-scripts) + PREFLIGHT ---
Info 'Installing dependencies (this can take a minute)...'
npm install --ignore-scripts --no-audit --no-fund | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' }
Info 'Running preflight (authoritative environment check)...'
node scripts\preflight.js --phase=post-clone --repo="$InstallDir"
if ($LASTEXITCODE -ne 0) { Fail 'Preflight failed - resolve the issues above and re-run.' }

# --- Step 4: Build + start by mode ---
if ($Mode -eq 'dev') {
  Info 'Building (dev)...'
  npm run build | Select-Object -Last 3
  if ($LASTEXITCODE -ne 0) { Fail 'build failed' }
  Ok "Build complete (dev). Start with: node bin\lm-assist.js start   (dev API :3200 / Web :3948)"
} else {
  Info 'Packing + installing globally (prod)...'
  npm pack | Select-Object -Last 1
  if ($LASTEXITCODE -ne 0) { Fail 'npm pack failed' }
  $tgz = Get-ChildItem -Filter 'lm-assist-*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $tgz) { Fail 'npm pack did not produce a tgz' }
  Info "Installing $($tgz.Name) globally (compiles better-sqlite3; postinstall auto-starts services)..."
  npm install -g ".\$($tgz.Name)" | Select-Object -Last 3
  if ($LASTEXITCODE -ne 0) { Fail 'global install failed' }
  Ok 'Installed lm-assist CLI (prod). Services start on :3100 (API) / :3848 (Web).'
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

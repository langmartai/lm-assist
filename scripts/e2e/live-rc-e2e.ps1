# E2E for the live-rc-connect feature (Windows node) — sibling of live-rc-e2e.sh.
# Deterministic "live + unreachable" fixture: a real hidden process + a synthetic
# ~/.claude/sessions/<pid>.json (alive pid, no claude console => verdict 'refuse'
# / not windows-driveable => unreachable). Cloud-free safety test.
$ErrorActionPreference = 'Continue'
$api    = if ($env:API) { $env:API } else { 'http://localhost:3100' }
$label  = if ($env:LABEL) { $env:LABEL } else { $env:COMPUTERNAME }
$token  = (Get-Content (Join-Path $env:USERPROFILE '.lm-assist\api-token')).Trim()
$sessDir = Join-Path $env:USERPROFILE '.claude\sessions'
New-Item -ItemType Directory -Force -Path $sessDir | Out-Null
$script:pass = 0; $script:fail = 0
function OK([string]$m){ $script:pass++; Write-Host "  PASS $m" }
function BAD([string]$m){ $script:fail++; Write-Host "  FAIL $m" }

$uuid  = [guid]::NewGuid().ToString()
$proc  = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 99999' -WindowStyle Hidden -PassThru
$owner = $proc.Id
Start-Sleep -Milliseconds 400
$now   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.000Z')
$pidfile = Join-Path $sessDir "$owner.json"
$json  = ('{{"sessionId":"{0}","pid":{1},"cwd":"C:\\tmp","kind":"e2e","entrypoint":"e2e","status":"running","updatedAt":"{2}","version":"e2e"}}' -f $uuid,$owner,$now)
[System.IO.File]::WriteAllText($pidfile, $json)   # UTF-8, no BOM

Write-Host ("=== live-rc E2E on [{0}] via {1}  (owner pid {2}, sid {3}) ===" -f $label,$api,$owner,$uuid.Substring(0,8))
try {
  $pre = Invoke-RestMethod -TimeoutSec 8 "$api/ccr/preflight/$uuid" -Headers @{ 'x-api-key' = $token }
  if ($pre.data.live -eq $true) { OK 'fixture reports live' } else { BAD ('fixture not live: ' + ($pre.data | ConvertTo-Json -Compress)) }
  if ($pre.data.connectStrategy -eq 'refuse') { OK 'verdict=refuse (live, unreachable)' } else { BAD ('verdict=' + $pre.data.connectStrategy) }
} catch { BAD ('preflight failed: ' + $_.Exception.Message) }

Write-Host '-- TEST 1 (safety): no force => CONFLICT(needs-force), owner NEVER killed --'
$code = ''; $body = ''
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 70 -Method Post "$api/ccr/connect" -Headers @{ 'x-api-key' = $token } -ContentType 'application/json' -Body ('{"sessionId":"' + $uuid + '","force":false}') | Out-Null
} catch {
  try { $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream()); $body = $sr.ReadToEnd() } catch {}
  try { $code = ($body | ConvertFrom-Json).error.code } catch {}
}
if ($code -eq 'CONFLICT') { OK 'CONFLICT returned' } else { BAD ("expected CONFLICT, body: $body") }
if ($body -match 'force') { OK 'needs-force hint present' } else { BAD 'no force hint' }
$alive = $null -ne (Get-Process -Id $owner -ErrorAction SilentlyContinue)
if ($alive) { OK 'owner STILL ALIVE — never resumed over a live process' } else { BAD 'owner KILLED without force — SAFETY VIOLATION' }

if ($env:DO_FORCE -eq '1') {
  Write-Host '-- TEST 2 (kill-gated): force:true => owner KILLED via taskkill --'
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 90 -Method Post "$api/ccr/connect" -Headers @{ 'x-api-key' = $token } -ContentType 'application/json' -Body ('{"sessionId":"' + $uuid + '","force":true}') | Out-Null } catch {}
  Start-Sleep -Seconds 2
  $stillAlive = $null -ne (Get-Process -Id $owner -ErrorAction SilentlyContinue)
  if (-not $stillAlive) { OK 'owner KILLED under force:true (Windows taskkill path)' } else { BAD 'owner still alive after force — kill did not fire' }
}

# cleanup
Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
Remove-Item $pidfile -ErrorAction SilentlyContinue
Write-Host ("=== [{0}] RESULT: {1} passed, {2} failed ===" -f $label,$script:pass,$script:fail)
if ($script:fail -ne 0) { exit 1 }

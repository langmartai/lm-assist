/**
 * Windows terminal backend — the Windows substitute for the Linux tmux pane
 * mapping in cc-sessions.ts.
 *
 * Linux maps a live Claude Code session's pid to a tmux pane (so it can
 * send-keys to it). Windows has no tmux: interactive Claude sessions run
 * directly in Windows Terminal tabs (or conhost windows). This module maps a
 * live session's pid to the exact WT window + tab and drives it by bringing
 * that window/tab to the front and pasting text — the Windows equivalent of
 * "attach + send-keys".
 *
 * The pid -> window/tab bridge cannot be done from Node alone (tabs are not
 * windows and carry no pid), so the heavy lifting runs in a bundled PowerShell
 * engine. The hard part is identifying which tab hosts a pid. Rather than
 * READING the tab title (which Claude Code owns and rewrites as the
 * conversation summary evolves — it drifts and races), the engine takes
 * OWNERSHIP of the matching key at drive time:
 *
 *   1. AttachConsole(pid) + GetConsoleTitle to snapshot the current title
 *   2. SetConsoleTitle(pid, "LMASSIST::<pid>::<nonce>") — a unique marker we
 *      control. SetConsoleTitle on an externally-attached ConPTY console
 *      propagates through to the WT tab strip (verified on windows-desk).
 *   3. UI-Automation finds the tab whose title contains our marker -> exact
 *      (window handle, tab index). Re-asserted across a short poll loop to beat
 *      the app's own title updates.
 *   4. Restore the original title.
 *
 * This is deterministic: the match key is a string WE wrote, not Claude's
 * drifting summary. Listing (query) stays passive and non-intrusive (it does
 * not touch titles); `driveable` there means "hosted in a real terminal with a
 * readable console", because the exact tab is resolved authoritatively at drive
 * time regardless of passive title drift.
 *
 * Everything here is a no-op (returns not-supported) on non-Windows.
 */

import { execFile } from '../utils/exec';
import { IS_WINDOWS } from '../utils/process-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listLiveSessions, LiveSession } from './cc-sessions';

// ---------------------------------------------------------------------------
// Embedded PowerShell engine (materialized to a temp .ps1 on first use).
// Embedded rather than shipped as a file because the build is tsc-only (no
// asset copy) and must work from both a dev checkout and an npm install.
// Contains no backticks and no `${`, so it is safe inside a String.raw literal.
// ---------------------------------------------------------------------------
const ENGINE_PS1 = String.raw`
param(
  [Parameter(Mandatory)][ValidateSet('query','locate','send')][string]$Action,
  [string]$PidList = '',
  [int]$ClaudePid = 0,
  [string]$MessageB64 = '',
  [switch]$Submit
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WT {
  [StructLayout(LayoutKind.Sequential)] public struct PE32 {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID;
    public IntPtr th32DefaultHeapID; public uint th32ModuleID; public uint cntThreads;
    public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateToolhelp32Snapshot(uint f, uint pid);
  [DllImport("kernel32.dll")] public static extern bool Process32First(IntPtr h, ref PE32 pe);
  [DllImport("kernel32.dll")] public static extern bool Process32Next(IntPtr h, ref PE32 pe);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern int GetConsoleTitle(StringBuilder sb, int n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleTitle(string t);

  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
}
"@
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$TERMS = @('WindowsTerminal.exe','conhost.exe','OpenConsole.exe')

function Get-ParentMap {
  $parent=@{}; $name=@{}
  $snap=[WT]::CreateToolhelp32Snapshot(2,0)
  $pe=New-Object WT+PE32; $pe.dwSize=[Runtime.InteropServices.Marshal]::SizeOf($pe)
  if([WT]::Process32First($snap,[ref]$pe)){do{$parent[[int]$pe.th32ProcessID]=[int]$pe.th32ParentProcessID;$name[[int]$pe.th32ProcessID]=$pe.szExeFile}while([WT]::Process32Next($snap,[ref]$pe))}
  [WT]::CloseHandle($snap)|Out-Null
  return @{parent=$parent;name=$name}
}
function Normalize-Title([string]$t){ if(-not $t){return ""}; return ($t -replace '^\s*\S+\s+','').Trim() }
function Is-Alive([int]$p){ try{ $null=Get-Process -Id $p -ErrorAction Stop; return $true }catch{ return $false } }
function Resolve-Host([int]$startPid,$map){
  $cur=$startPid
  while($cur -and $map.parent.ContainsKey($cur)){
    if($TERMS -contains $map.name[$cur]){ return @{ pid=$cur; name=$map.name[$cur] } }
    $cur=$map.parent[$cur]; if($cur -eq 0){break}
  }
  return $null
}
function Read-ConsoleTitle([int]$p){
  [WT]::FreeConsole()|Out-Null; $t=""
  if([WT]::AttachConsole([uint32]$p)){ $sb=New-Object System.Text.StringBuilder 1024; $null=[WT]::GetConsoleTitle($sb,1024); $t=$sb.ToString() }
  [WT]::FreeConsole()|Out-Null; return $t
}
function Write-ConsoleTitle([int]$p,[string]$v){
  [WT]::FreeConsole()|Out-Null; $ok=$false
  if([WT]::AttachConsole([uint32]$p)){ $ok=[WT]::SetConsoleTitle($v) }
  [WT]::FreeConsole()|Out-Null; return $ok
}

function Get-TerminalWindows {
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $orCond=New-Object System.Windows.Automation.OrCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,"CASCADIA_HOSTING_WINDOW_CLASS")),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,"ConsoleWindowClass"))
  )
  return @($root.FindAll([System.Windows.Automation.TreeScope]::Children,$orCond))
}
function Get-TabItems($win){
  $tc=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)
  return @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants,$tc))
}

# Authoritative: write a unique marker to the pid's console title, find the tab
# showing it (re-asserting across a short poll loop), restore the title.
function Locate-Authoritative([int]$p){
  $r=@{ found=$false; hwnd=$null; tabIndex=-1; tabElement=$null; origTitle=$null; kind='unknown' }
  $orig = Read-ConsoleTitle $p
  if(-not $orig){ return $r }
  $r.origTitle = $orig
  $marker = "LMASSIST::" + $p + "::" + ([guid]::NewGuid().ToString('N').Substring(0,8))
  try {
    for($i=0; $i -lt 10 -and -not $r.found; $i++){
      Write-ConsoleTitle $p $marker | Out-Null
      Start-Sleep -Milliseconds 120
      foreach($win in (Get-TerminalWindows)){
        $hwnd=[int64]$win.Current.NativeWindowHandle
        $tabs=Get-TabItems $win
        if($tabs.Count -eq 0){
          if($win.Current.Name -like "*$marker*"){ $r.found=$true; $r.hwnd=$hwnd; $r.kind='conhost'; break }
        } else {
          $idx=0
          foreach($t in $tabs){
            if($t.Current.Name -like "*$marker*"){ $r.found=$true; $r.hwnd=$hwnd; $r.tabIndex=$idx; $r.tabElement=$t; $r.kind='windows-terminal'; break }
            $idx++
          }
          if($r.found){ break }
        }
      }
    }
  } finally {
    Write-ConsoleTitle $p $orig | Out-Null
  }
  return $r
}

function Set-Foreground([IntPtr]$hwnd){
  $fg=[WT]::GetForegroundWindow(); $d=0
  $fgT=[WT]::GetWindowThreadProcessId($fg,[ref]$d)
  $me=[WT]::GetCurrentThreadId()
  [WT]::AttachThreadInput($me,$fgT,$true)|Out-Null
  if([WT]::IsIconic($hwnd)){ [WT]::ShowWindow($hwnd,9)|Out-Null }
  [WT]::BringWindowToTop($hwnd)|Out-Null
  [WT]::SetForegroundWindow($hwnd)|Out-Null
  [WT]::AttachThreadInput($me,$fgT,$false)|Out-Null
}

$map = Get-ParentMap

if($Action -eq 'query'){
  $out=@()
  foreach($s in ($PidList -split ',')){
    $p=0; if(-not [int]::TryParse($s.Trim(),[ref]$p)){ continue }
    if(-not (Is-Alive $p)){ $out += [ordered]@{ pid=$p; alive=$false; driveable=$false }; continue }
    $h=Resolve-Host $p $map
    $title=Normalize-Title (Read-ConsoleTitle $p)
    $kind = if($h){ if($h.name -eq 'WindowsTerminal.exe'){'windows-terminal'}elseif($h.name -eq 'conhost.exe' -or $h.name -eq 'OpenConsole.exe'){'conhost'}else{'unknown'} } else {'unknown'}
    $driveable = ($h -ne $null) -and ($title -ne '')
    $out += [ordered]@{ pid=$p; alive=$true; hostPid=($(if($h){$h.pid}else{0})); hostName=($(if($h){$h.name}else{$null})); kind=$kind; consoleTitle=$title; driveable=$driveable }
  }
  ConvertTo-Json @{ sessions=@($out) } -Depth 6 -Compress
  exit 0
}

if($Action -eq 'locate'){
  if($ClaudePid -le 0){ ConvertTo-Json @{ ok=$false; error='ClaudePid required' } -Compress; exit 1 }
  $loc = Locate-Authoritative $ClaudePid
  ConvertTo-Json @{ ok=$loc.found; pid=$ClaudePid; windowHandle=$loc.hwnd; tabIndex=$loc.tabIndex; kind=$loc.kind; origTitle=$loc.origTitle } -Depth 6 -Compress
  exit 0
}

if($Action -eq 'send'){
  if($ClaudePid -le 0){ ConvertTo-Json @{ ok=$false; error='ClaudePid required' } -Compress; exit 1 }
  $loc = Locate-Authoritative $ClaudePid
  if(-not $loc.found -or -not $loc.hwnd){ ConvertTo-Json @{ ok=$false; error='could not locate window/tab for pid'; origTitle=$loc.origTitle } -Compress; exit 2 }
  $hwnd=[IntPtr][int64]$loc.hwnd
  if($loc.tabElement){
    try { $loc.tabElement.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); Start-Sleep -Milliseconds 180 } catch {}
  }
  Set-Foreground $hwnd
  Start-Sleep -Milliseconds 250
  if($MessageB64){
    $msg=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($MessageB64))
    Set-Clipboard -Value $msg
    $sh=New-Object -ComObject WScript.Shell
    $sh.SendKeys("^v")
    if($Submit){ Start-Sleep -Milliseconds 150; $sh.SendKeys("{ENTER}") }
  }
  ConvertTo-Json @{ ok=$true; windowHandle=$loc.hwnd; tabIndex=$loc.tabIndex; kind=$loc.kind; submitted=[bool]$Submit } -Depth 6 -Compress
  exit 0
}
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WinMapping {
  pid: number;
  alive: boolean;
  hostPid?: number;
  hostName?: string | null;
  /** 'windows-terminal' | 'conhost' | 'unknown' */
  kind?: string;
  /** spinner-stripped console title, for display (best-effort, may drift) */
  consoleTitle?: string | null;
  /** hosted in a real terminal with a readable console — the exact tab is
   *  resolved authoritatively (marker) at drive time, so this is NOT gated on
   *  passive title matching. */
  driveable: boolean;
}

export interface LocateResult {
  ok: boolean;
  pid: number;
  windowHandle?: number | null;
  tabIndex?: number;
  kind?: string;
  origTitle?: string | null;
  error?: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  windowHandle?: number;
  tabIndex?: number;
  kind?: string;
  submitted?: boolean;
  origTitle?: string | null;
}

/** A live Claude Code session enriched with its Windows window/tab mapping. */
export interface WinLiveSession extends LiveSession {
  win: WinMapping | null;
  /** true when the session can be brought to front + driven (focus/send). */
  driveable: boolean;
}

// ---------------------------------------------------------------------------
// Engine invocation
// ---------------------------------------------------------------------------

let enginePathCache: string | null = null;

function enginePath(): string {
  if (enginePathCache && fs.existsSync(enginePathCache)) return enginePathCache;
  const p = path.join(os.tmpdir(), 'lm-assist-wt-engine.ps1');
  fs.writeFileSync(p, ENGINE_PS1, 'utf8');
  enginePathCache = p;
  return p;
}

function runEngine(args: string[], timeoutMs = 25000): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', enginePath(), ...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true } as any,
      (err: any, stdout: string, stderr: string) => {
        const text = (stdout || '').trim();
        if (!text) {
          return reject(new Error(stderr?.trim() || (err && err.message) || 'wt-engine produced no output'));
        }
        // The engine emits a JSON envelope even on logical failure (exit 1/2),
        // so prefer parsing stdout over treating a nonzero exit as fatal.
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error('wt-engine returned non-JSON: ' + text.slice(0, 300)));
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True when Windows terminal control is available on this host. */
export function isWindowsTerminalControlSupported(): boolean {
  return IS_WINDOWS;
}

/** Map a set of pids to their terminal host + driveability (passive, non-intrusive). */
export async function mapPidsToWindows(pids: number[]): Promise<WinMapping[]> {
  if (!IS_WINDOWS) return pids.map((p) => ({ pid: p, alive: false, driveable: false }));
  if (pids.length === 0) return [];
  const res = await runEngine(['-Action', 'query', '-PidList', pids.join(',')]);
  return (res?.sessions ?? []) as WinMapping[];
}

/** Authoritatively resolve which WT window+tab hosts a pid (marker method). Read-only. */
export async function locateWindow(pid: number): Promise<LocateResult> {
  if (!IS_WINDOWS) return { ok: false, pid, error: 'windows-only' };
  return (await runEngine(['-Action', 'locate', '-ClaudePid', String(pid)])) as LocateResult;
}

/** List all live Claude Code sessions on this host, enriched with window/tab mapping. */
export async function listWindowsSessions(): Promise<WinLiveSession[]> {
  const live = listLiveSessions();
  if (!IS_WINDOWS) return live.map((s) => ({ ...s, win: null, driveable: false }));
  const pids = live.map((s) => s.owner.pid);
  const maps = await mapPidsToWindows(pids);
  const byPid = new Map<number, WinMapping>(maps.map((m) => [m.pid, m]));
  return live.map((s) => {
    const win = byPid.get(s.owner.pid) ?? null;
    return { ...s, win, driveable: !!(win && win.driveable) };
  });
}

/**
 * Bring the window/tab hosting `pid` to the front and (optionally) paste text.
 * Locates the tab authoritatively via a unique console-title marker (drift-proof),
 * selects it, restores the title, then foregrounds + pastes. With `submit:true`
 * also presses Enter.
 */
export async function focusAndSend(opts: {
  pid: number;
  text?: string;
  submit?: boolean;
}): Promise<SendResult> {
  if (!IS_WINDOWS) return { ok: false, error: 'windows-only' };
  const args = ['-Action', 'send', '-ClaudePid', String(opts.pid)];
  if (opts.text) args.push('-MessageB64', Buffer.from(opts.text, 'utf8').toString('base64'));
  if (opts.submit) args.push('-Submit');
  return (await runEngine(args)) as SendResult;
}

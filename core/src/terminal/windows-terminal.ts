/**
 * Windows terminal backend — the Windows substitute for the Linux tmux pane
 * mapping in cc-sessions.ts.
 *
 * Linux maps a live Claude Code session's pid to a tmux pane (so it can
 * send-keys to it). Windows has no tmux: interactive Claude sessions run
 * directly in Windows Terminal tabs (or conhost windows). This module maps a
 * live session's pid to the exact WT window + tab (or conhost window) that
 * hosts it, and drives it by bringing that window/tab to the front and pasting
 * text — the Windows equivalent of "attach + send-keys".
 *
 * The pid -> window/tab bridge cannot be done from Node alone (tabs are not
 * windows and carry no pid), so the heavy lifting runs in a bundled PowerShell
 * engine that:
 *   - walks the parent-process chain (Toolhelp32) to the terminal host process
 *   - reads each pid's console title via AttachConsole + GetConsoleTitle
 *     (non-destructive: attaches the reader, never detaches the target;
 *      child/subagent claude processes inherit the hosting tab's console, so a
 *      child pid still resolves to its tab)
 *   - enumerates ALL top-level windows of the host process (EnumWindows by pid;
 *     MainWindowHandle is unreliable — WT puts many windows in one process)
 *   - matches the console title against each window's tab titles via UI
 *     Automation, then selects that tab and foregrounds the window
 *
 * Caveat (honest): the only pid->tab key is the console/tab TITLE. If two
 * sessions share a title, or the live title has drifted from what the WT tab
 * strip currently shows, the match can miss — in which case the session is
 * reported focusable:false and we refuse to drive it (rather than risk typing
 * into the wrong tab).
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
  [Parameter(Mandatory)][ValidateSet('query','send')][string]$Action,
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

  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  public static List<IntPtr> WindowsByPid(uint target) {
    var res = new List<IntPtr>();
    EnumWindows((h,l)=>{ uint p; GetWindowThreadProcessId(h, out p);
      if(p==target && IsWindowVisible(h) && GetWindowTextLength(h)>0) res.Add(h); return true; }, IntPtr.Zero);
    return res;
  }
  public static string WinText(IntPtr h){ var sb=new StringBuilder(1024); GetWindowText(h,sb,1024); return sb.ToString(); }

  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
}
"@

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

function Read-ConsoleTitle([int]$p){
  [WT]::FreeConsole()|Out-Null
  $title=""
  if([WT]::AttachConsole([uint32]$p)){
    $sb=New-Object System.Text.StringBuilder 1024
    $null=[WT]::GetConsoleTitle($sb,1024)
    $title=$sb.ToString()
  }
  [WT]::FreeConsole()|Out-Null
  return $title
}

function Resolve-Host([int]$startPid,$map){
  $cur=$startPid
  while($cur -and $map.parent.ContainsKey($cur)){
    if($TERMS -contains $map.name[$cur]){ return @{ pid=$cur; name=$map.name[$cur] } }
    $cur=$map.parent[$cur]; if($cur -eq 0){break}
  }
  return $null
}

function Get-TabItems([IntPtr]$hwnd){
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty,[int]$hwnd)
  $w=$root.FindFirst([System.Windows.Automation.TreeScope]::Children,$cond)
  if(-not $w){ return @() }
  $tc=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)
  return @($w.FindAll([System.Windows.Automation.TreeScope]::Descendants,$tc))
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Locate-WindowTab([int]$claudePid,$map){
  $r=@{ hostPid=0; hostName=$null; kind='unknown'; windowHandle=$null; tabTitle=$null; tabIndex=-1; windowCount=0; focusable=$false; consoleTitle=$null }
  $h=Resolve-Host $claudePid $map
  if(-not $h){ return $r }
  $r.hostPid=$h.pid; $r.hostName=$h.name
  $r.kind = if($h.name -eq 'WindowsTerminal.exe'){'windows-terminal'} elseif($h.name -eq 'conhost.exe' -or $h.name -eq 'OpenConsole.exe'){'conhost'} else {'unknown'}
  $title = Normalize-Title (Read-ConsoleTitle $claudePid)
  $r.consoleTitle = $title
  $wins = [WT]::WindowsByPid([uint32]$h.pid)
  $r.windowCount = $wins.Count
  foreach($wh in $wins){
    $tabs = Get-TabItems $wh
    if($tabs.Count -eq 0){
      if((Normalize-Title ([WT]::WinText($wh))) -eq $title -or $wins.Count -eq 1){
        $r.windowHandle=[int64]$wh; $r.tabTitle=([WT]::WinText($wh)); $r.focusable=$true; break
      }
    } else {
      $idx=0
      foreach($t in $tabs){
        if((Normalize-Title $t.Current.Name) -eq $title){
          $r.windowHandle=[int64]$wh; $r.tabTitle=$t.Current.Name; $r.tabIndex=$idx; $r.focusable=$true; break
        }
        $idx++
      }
      if($r.focusable){ break }
    }
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
    $alive = Is-Alive $p
    if(-not $alive){ $out += [ordered]@{ pid=$p; alive=$false; focusable=$false }; continue }
    $loc = Locate-WindowTab $p $map
    $out += [ordered]@{
      pid=$p; alive=$true;
      hostPid=$loc.hostPid; hostName=$loc.hostName; kind=$loc.kind;
      windowHandle=$loc.windowHandle; tabTitle=$loc.tabTitle; tabIndex=$loc.tabIndex;
      windowCount=$loc.windowCount; focusable=$loc.focusable; consoleTitle=$loc.consoleTitle
    }
  }
  ConvertTo-Json @{ sessions=@($out) } -Depth 6 -Compress
  exit 0
}

if($Action -eq 'send'){
  if($ClaudePid -le 0){ ConvertTo-Json @{ ok=$false; error='ClaudePid required' } -Compress; exit 1 }
  $loc = Locate-WindowTab $ClaudePid $map
  if(-not $loc.focusable -or -not $loc.windowHandle){ ConvertTo-Json @{ ok=$false; error='not focusable'; detail=$loc } -Depth 6 -Compress; exit 2 }
  $hwnd=[IntPtr][int64]$loc.windowHandle
  if($loc.tabIndex -ge 0){
    $tabs = Get-TabItems $hwnd
    if($loc.tabIndex -lt $tabs.Count){
      $si=$tabs[$loc.tabIndex].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $si.Select(); Start-Sleep -Milliseconds 200
    }
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
  ConvertTo-Json @{ ok=$true; windowHandle=$loc.windowHandle; tabTitle=$loc.tabTitle; tabIndex=$loc.tabIndex; submitted=[bool]$Submit } -Depth 6 -Compress
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
  windowHandle?: number | null;
  tabTitle?: string | null;
  /** tab position within the WT window; -1 for conhost / single-window */
  tabIndex?: number;
  windowCount?: number;
  /** true when we located an exact window+tab we can safely drive */
  focusable: boolean;
  consoleTitle?: string | null;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  windowHandle?: number;
  tabTitle?: string | null;
  tabIndex?: number;
  submitted?: boolean;
  detail?: unknown;
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

function runEngine(args: string[], timeoutMs = 20000): Promise<any> {
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

/** Map a set of pids to their hosting WT window/tab (or conhost window). */
export async function mapPidsToWindows(pids: number[]): Promise<WinMapping[]> {
  if (!IS_WINDOWS) return pids.map((p) => ({ pid: p, alive: false, focusable: false }));
  if (pids.length === 0) return [];
  const res = await runEngine(['-Action', 'query', '-PidList', pids.join(',')]);
  return (res?.sessions ?? []) as WinMapping[];
}

/** List all live Claude Code sessions on this host, enriched with window/tab mapping. */
export async function listWindowsSessions(): Promise<WinLiveSession[]> {
  const live = listLiveSessions();
  if (!IS_WINDOWS) return live.map((s) => ({ ...s, win: null, driveable: false }));
  const pids = live.map((s) => s.owner.pid);
  const maps = await mapPidsToWindows(pids);
  const byPid = new Map<number, WinMapping>(maps.map((m) => [m.pid, m]));
  return live.map((s: LiveSession) => {
    const win = byPid.get(s.owner.pid) ?? null;
    return { ...s, win, driveable: !!(win && win.focusable) };
  });
}

/**
 * Bring the window/tab hosting `pid` to the front and (optionally) paste text.
 * With `submit:true`, also presses Enter. Returns ok:false if the session could
 * not be located to an exact tab (title drift / not in a terminal window).
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

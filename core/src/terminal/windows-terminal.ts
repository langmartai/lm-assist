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

import { execFile, spawn } from '../utils/exec';
import { IS_WINDOWS } from '../utils/process-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Embedded PowerShell engine (materialized to a temp .ps1 on first use).
// Embedded rather than shipped as a file because the build is tsc-only (no
// asset copy) and must work from both a dev checkout and an npm install.
// Contains no backticks and no `${`, so it is safe inside a String.raw literal.
// ---------------------------------------------------------------------------
const ENGINE_PS1 = String.raw`
param(
  [Parameter(Mandatory)][ValidateSet('query','locate','send','close','tabids','capture','procs')][string]$Action,
  [string]$PidList = '',
  [int]$ClaudePid = 0,
  [string]$MessageB64 = '',
  [switch]$Submit,
  [switch]$CloseTab,
  [string]$RuntimeId = '',
  [string]$Keys = ''
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
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  // --- screen capture: read the attached console's visible viewport ---------
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI {
    public COORD dwSize; public COORD dwCursorPosition; public ushort wAttributes;
    public SMALL_RECT srWindow; public COORD dwMaximumWindowSize;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder buf, uint len, COORD coord, out uint read);

  // Read the visible viewport of the console this process is currently attached
  // to (caller does AttachConsole(pid) first). With ConPTY (Windows Terminal),
  // the hidden conhost keeps a real screen buffer mirroring what the terminal
  // renders, so this returns the on-screen text. Trailing per-row spaces trimmed.
  public static string CaptureViewport() {
    IntPtr h = CreateFileW("CONOUT$", 0xC0000000u, 3u, IntPtr.Zero, 3u, 0u, IntPtr.Zero);
    if (h == IntPtr.Zero || h == (IntPtr)(-1)) return null;
    try {
      CSBI info;
      if (!GetConsoleScreenBufferInfo(h, out info)) return null;
      int top = info.srWindow.Top, bottom = info.srWindow.Bottom;
      int width = info.dwSize.X;
      if (width <= 0 || bottom < top) return "";
      var all = new StringBuilder();
      for (int y = top; y <= bottom; y++) {
        var buf = new StringBuilder(width);
        COORD c; c.X = 0; c.Y = (short)y;
        uint read;
        if (ReadConsoleOutputCharacterW(h, buf, (uint)width, c, out read) && read > 0) {
          all.AppendLine(buf.ToString(0, (int)read).TrimEnd());
        } else {
          all.AppendLine();
        }
      }
      return all.ToString();
    } finally { CloseHandle(h); }
  }

  // --- input injection: write key events straight into the console buffer -----
  // Focus-independent (no SetForegroundWindow / SendKeys): AttachConsole(pid) +
  // WriteConsoleInput to CONIN$, so the attached app (claude) reads the keys as
  // typed regardless of which window has focus. This is how we drive menus
  // (folder-trust Enter, numbered answers) reliably even from a background
  // service that can't steal foreground.
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct KEY_EVENT_RECORD {
    public int bKeyDown; public ushort wRepeatCount; public ushort wVirtualKeyCode;
    public ushort wVirtualScanCode; public char UnicodeChar; public uint dwControlKeyState;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType; [FieldOffset(4)] public KEY_EVENT_RECORD Key;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buf, uint len, out uint written);

  static INPUT_RECORD MakeKey(bool down, ushort vk, char ch, uint ctrl) {
    var r = new INPUT_RECORD(); r.EventType = 0x0001; // KEY_EVENT
    r.Key.bKeyDown = down ? 1 : 0; r.Key.wRepeatCount = 1; r.Key.wVirtualKeyCode = vk;
    r.Key.wVirtualScanCode = (ushort)MapVirtualKey(vk, 0); r.Key.UnicodeChar = ch; r.Key.dwControlKeyState = ctrl;
    return r;
  }
  // spec = space-separated tokens: ENTER ESC UP DOWN LEFT RIGHT TAB SPACE CTRL_C, or a single literal char.
  public static bool SendConsoleKeys(uint pid, string spec) {
    FreeConsole();
    if (!AttachConsole(pid)) return false;
    try {
      IntPtr h = CreateFileW("CONIN$", 0xC0000000u, 3u, IntPtr.Zero, 3u, 0u, IntPtr.Zero);
      if (h == IntPtr.Zero || h == (IntPtr)(-1)) return false;
      try {
        var recs = new List<INPUT_RECORD>();
        foreach (var raw in spec.Split(' ')) {
          if (raw.Length == 0) continue;
          ushort vk; char ch; uint ctrl = 0;
          switch (raw.ToUpperInvariant()) {
            case "ENTER": vk = 0x0D; ch = '\r'; break;
            case "ESC": vk = 0x1B; ch = (char)27; break;
            case "UP": vk = 0x26; ch = '\0'; break;
            case "DOWN": vk = 0x28; ch = '\0'; break;
            case "LEFT": vk = 0x25; ch = '\0'; break;
            case "RIGHT": vk = 0x27; ch = '\0'; break;
            case "TAB": vk = 0x09; ch = '\t'; break;
            case "SPACE": vk = 0x20; ch = ' '; break;
            case "CTRL_C": vk = 0x43; ch = (char)3; ctrl = 0x0008; break; // LEFT_CTRL_PRESSED + 'C'
            default: ch = raw[0]; vk = (ushort)(VkKeyScan(ch) & 0xFF); break;
          }
          recs.Add(MakeKey(true, vk, ch, ctrl));
          recs.Add(MakeKey(false, vk, ch, ctrl));
        }
        if (recs.Count == 0) return false;
        var arr = recs.ToArray();
        uint written;
        return WriteConsoleInputW(h, arr, (uint)arr.Length, out written) && written > 0;
      } finally { CloseHandle(h); }
    } finally { FreeConsole(); }
  }
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

# Locate a tab by its UIA RuntimeId -- stable across processes and INDEPENDENT of
# title, so it works even while the session is actively animating its title.
function Locate-ByRid([string]$rid){
  $r=@{ found=$false; hwnd=$null; tabIndex=-1; tabElement=$null; kind='windows-terminal' }
  foreach($win in (Get-TerminalWindows)){
    $hwnd=[int64]$win.Current.NativeWindowHandle
    $tabs=Get-TabItems $win
    $idx=0
    foreach($t in $tabs){
      if((($t.GetRuntimeId()) -join '.') -eq $rid){ $r.found=$true; $r.hwnd=$hwnd; $r.tabIndex=$idx; $r.tabElement=$t; return $r }
      $idx++
    }
  }
  return $r
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
    # Poll generously: a busy session (spinner) rewrites its own title each frame
    # and overwrites our marker, but once it settles to idle the marker sticks.
    # ~25 x 100ms spans the busy->idle transition of a freshly-launched session.
    for($i=0; $i -lt 25 -and -not $r.found; $i++){
      Write-ConsoleTitle $p $marker | Out-Null
      Start-Sleep -Milliseconds 100
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

# Bring $hwnd to the foreground and RETURN whether it actually became foreground.
# A background-spawned process can't normally steal focus, so we: attach to the
# current foreground thread's input queue, disable the foreground-lock timeout,
# nudge with an Alt keypress (satisfies the "received input" rule), then set
# foreground and VERIFY. Callers must not SendKeys unless this returns $true,
# else the keystrokes land in the wrong window.
function Set-Foreground([IntPtr]$hwnd){
  $fg=[WT]::GetForegroundWindow(); $d=0
  $fgT=[WT]::GetWindowThreadProcessId($fg,[ref]$d)
  $me=[WT]::GetCurrentThreadId()
  [WT]::AttachThreadInput($me,$fgT,$true)|Out-Null
  [WT]::SystemParametersInfo(0x2001,0,[IntPtr]::Zero,0)|Out-Null  # SPI_SETFOREGROUNDLOCKTIMEOUT = 0
  if([WT]::IsIconic($hwnd)){ [WT]::ShowWindow($hwnd,9)|Out-Null } else { [WT]::ShowWindow($hwnd,5)|Out-Null }
  [WT]::BringWindowToTop($hwnd)|Out-Null
  [WT]::SetForegroundWindow($hwnd)|Out-Null
  # Alt down/up nudge, then retry -- unsticks the foreground lock in many cases.
  [WT]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [WT]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
  [WT]::SetForegroundWindow($hwnd)|Out-Null
  Start-Sleep -Milliseconds 90
  $now=[WT]::GetForegroundWindow()
  [WT]::AttachThreadInput($me,$fgT,$false)|Out-Null
  return ($now -eq $hwnd)
}

$map = Get-ParentMap

if($Action -eq 'query'){
  $coreSession=(Get-Process -Id $PID).SessionId
  $out=@()
  foreach($s in ($PidList -split ',')){
    $p=0; if(-not [int]::TryParse($s.Trim(),[ref]$p)){ continue }
    if(-not (Is-Alive $p)){ $out += [ordered]@{ pid=$p; alive=$false; driveable=$false; reason='not running' }; continue }
    $h=Resolve-Host $p $map
    $tgtSession=$null; try{ $tgtSession=(Get-Process -Id $p -ErrorAction Stop).SessionId }catch{}
    $sameSession = ($tgtSession -ne $null) -and ($tgtSession -eq $coreSession)
    $title=Normalize-Title (Read-ConsoleTitle $p)
    $kind = if($h){ if($h.name -eq 'WindowsTerminal.exe'){'windows-terminal'}elseif($h.name -eq 'conhost.exe' -or $h.name -eq 'OpenConsole.exe'){'conhost'}else{'unknown'} } else {'unknown'}
    # Driveable = hosted in a real terminal AND in the SAME Windows session as the
    # Core. Session 0 isolation blocks a Session-0 Core from attaching to a
    # Session-1 console, so a cross-session pid is NOT driveable regardless of
    # title. (The old non-empty-title proxy mis-reported this: an empty title was
    # actually the cross-session attach failure, not a session that set no title.)
    $driveable = ($h -ne $null) -and $sameSession
    $reason = if(-not $h){ 'no host terminal found for this pid' } elseif(-not $sameSession){ "cross-session: target in Windows session $tgtSession but lm-assist Core runs in session $coreSession (Session 0 isolation) - run the Core in the interactive desktop session" } else { $null }
    $out += [ordered]@{ pid=$p; alive=$true; hostPid=($(if($h){$h.pid}else{0})); hostName=($(if($h){$h.name}else{$null})); kind=$kind; sessionId=$tgtSession; coreSessionId=$coreSession; consoleTitle=$title; driveable=$driveable; reason=$reason }
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

if($Action -eq 'capture'){
  # Read the target console's visible viewport text (works for any pid attached
  # to a console -- including a session stuck at the folder-trust prompt that
  # never registered). Passive: attach the reader, read CONOUT$, detach.
  if($ClaudePid -le 0){ ConvertTo-Json @{ ok=$false; error='ClaudePid required' } -Compress; exit 1 }
  [WT]::FreeConsole()|Out-Null
  $txt=$null
  if([WT]::AttachConsole([uint32]$ClaudePid)){
    $txt=[WT]::CaptureViewport()
    [WT]::FreeConsole()|Out-Null
  } else {
    $err=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [WT]::FreeConsole()|Out-Null
    $coreS=(Get-Process -Id $PID).SessionId; $tgtS=$null; try{ $tgtS=(Get-Process -Id $ClaudePid -ErrorAction Stop).SessionId }catch{}
    $hint = if($err -eq 5 -and $tgtS -ne $null -and $tgtS -ne $coreS){ " - cross-session: target is in Windows session $tgtS but the lm-assist Core runs in session $coreS (Session 0 isolation blocks console access); run the Core in the interactive desktop session" } elseif($err -eq 5){ " - ACCESS_DENIED (target console may be in another Windows session or at a higher integrity level)" } else { " - pid has no attachable console?" }
    ConvertTo-Json @{ ok=$false; error="AttachConsole failed (win32=$err)$hint"; coreSessionId=$coreS; targetSessionId=$tgtS } -Compress; exit 2
  }
  if($null -eq $txt){ ConvertTo-Json @{ ok=$false; error='CONOUT$ read failed' } -Compress; exit 2 }
  $b64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($txt))
  ConvertTo-Json @{ ok=$true; pid=$ClaudePid; textB64=$b64 } -Compress
  exit 0
}

if($Action -eq 'tabids'){
  $out=@()
  foreach($win in (Get-TerminalWindows)){
    $hwnd=[int64]$win.Current.NativeWindowHandle
    $tabs=Get-TabItems $win
    $idx=0
    foreach($t in $tabs){ $out += [ordered]@{ rid=(($t.GetRuntimeId()) -join '.'); hwnd=$hwnd; tabIndex=$idx; name=$t.Current.Name }; $idx++ }
    if($tabs.Count -eq 0){ $out += [ordered]@{ rid=("win." + $hwnd); hwnd=$hwnd; tabIndex=-1; name=$win.Current.Name } }
  }
  ConvertTo-Json @{ tabs=@($out) } -Depth 6 -Compress
  exit 0
}

if($Action -eq 'procs'){
  # Generic terminal listing: every process that IS a tab's top program (its
  # parent is a terminal host) — the cmd/pwsh/claude that owns a tab's console.
  # pid + console title, so the generic wt backend is pid-keyed.
  $out=@()
  foreach($p in $map.parent.Keys){
    $par=$map.parent[$p]
    if($par -and ($TERMS -contains $map.name[$par])){
      $out += [ordered]@{ pid=$p; name=$map.name[$p]; hostPid=$par; hostName=$map.name[$par]; title=(Normalize-Title (Read-ConsoleTitle $p)) }
    }
  }
  ConvertTo-Json @{ procs=@($out) } -Depth 6 -Compress
  exit 0
}

if($Action -eq 'send'){
  # Keys (menu/prompt answers) go straight into the console input buffer via
  # WriteConsoleInput -- focus-free and reliable, no foreground/SendKeys needed.
  if($Keys){
    if($ClaudePid -le 0){ ConvertTo-Json @{ ok=$false; error='ClaudePid required for keys' } -Compress; exit 1 }
    $r=[WT]::SendConsoleKeys([uint32]$ClaudePid, $Keys)
    ConvertTo-Json @{ ok=$r; pid=$ClaudePid; sentKeys=$Keys; via='WriteConsoleInput' } -Compress
    exit ($(if($r){0}else{2}))
  }
  # Text paste: prefer RuntimeId (title-independent), else console-title marker.
  if($RuntimeId){
    $loc = Locate-ByRid $RuntimeId
  } else {
    if($ClaudePid -le 0){ ConvertTo-Json @{ ok=$false; error='ClaudePid or RuntimeId required' } -Compress; exit 1 }
    $loc = Locate-Authoritative $ClaudePid
  }
  if(-not $loc.found -or -not $loc.hwnd){ ConvertTo-Json @{ ok=$false; error='could not locate window/tab'; origTitle=$loc.origTitle } -Compress; exit 2 }
  $hwnd=[IntPtr][int64]$loc.hwnd
  if($loc.tabElement){
    try { $loc.tabElement.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); Start-Sleep -Milliseconds 180 } catch {}
  }
  $fgOk = Set-Foreground $hwnd
  Start-Sleep -Milliseconds 200
  if(-not $fgOk){
    # Could not truly focus the window -- refuse to paste (it would land in
    # whatever IS focused). Caller can retry. (Key presses use the focus-free
    # WriteConsoleInput path above and are unaffected by this.)
    ConvertTo-Json @{ ok=$false; error='could not bring window to foreground (focus blocked)'; windowHandle=$loc.hwnd; tabIndex=$loc.tabIndex } -Compress; exit 3
  }
  if($MessageB64){
    $msg=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($MessageB64))
    Set-Clipboard -Value $msg
    $sh=New-Object -ComObject WScript.Shell
    $sh.SendKeys("^v")
    if($Submit){ Start-Sleep -Milliseconds 150; $sh.SendKeys("{ENTER}") }
  }
  ConvertTo-Json @{ ok=$true; windowHandle=$loc.hwnd; tabIndex=$loc.tabIndex; kind=$loc.kind; submitted=[bool]$Submit; sentKeys=$Keys } -Depth 6 -Compress
  exit 0
}

if($Action -eq 'close'){
  if($ClaudePid -le 0){ ConvertTo-Json @{ ok=$false; error='ClaudePid required' } -Compress; exit 1 }
  $windowClosed=$false
  if($CloseTab){
    # Close the tab through the WT UI. Just killing the process leaves the tab
    # open as "[process exited]" (WT closeOnExit:graceful keeps abnormally-exited
    # panes). Locate the window/tab (RuntimeId preferred, else marker), then:
    #   single-tab window -> WM_CLOSE the window (no keybinding dependency)
    #   multi-tab window  -> select the tab + Ctrl+Shift+W (close just that tab)
    $loc = if($RuntimeId){ Locate-ByRid $RuntimeId } else { Locate-Authoritative $ClaudePid }
    if($loc.found -and $loc.hwnd){
      $hwnd=[IntPtr][int64]$loc.hwnd
      $tabCount=0
      foreach($w in (Get-TerminalWindows)){ if([int64]$w.Current.NativeWindowHandle -eq [int64]$loc.hwnd){ $tabCount=(Get-TabItems $w).Count; break } }
      if($tabCount -le 1){
        [WT]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null  # WM_CLOSE
        $windowClosed=$true
      } else {
        if($loc.tabElement){ try{ $loc.tabElement.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); Start-Sleep -Milliseconds 150 }catch{} }
        Set-Foreground $hwnd
        Start-Sleep -Milliseconds 150
        (New-Object -ComObject WScript.Shell).SendKeys("^+w")  # WT default: close focused tab
        $windowClosed=$true
      }
      Start-Sleep -Milliseconds 500
    }
  }
  # Kill the process subtree as a backstop (and the only action when not CloseTab).
  # Target = tab's host shell for CloseTab, else just claude. taskkill is broken on
  # this host (WMI/RPC critical error) so enumerate the tree ourselves + Stop-Process.
  $target = $ClaudePid
  if($CloseTab){
    $cur=$ClaudePid
    while($cur -and $map.parent.ContainsKey($cur)){
      $par=$map.parent[$cur]
      if($par -and ($TERMS -contains $map.name[$par])){ $target=$cur; break }
      $cur=$par; if($cur -eq 0){break}
    }
  }
  $kids=@{}
  foreach($k in $map.parent.Keys){ $p=$map.parent[$k]; if(-not $kids.ContainsKey($p)){ $kids[$p]=New-Object System.Collections.Generic.List[int] }; $kids[$p].Add($k) }
  $order=New-Object System.Collections.Generic.List[int]
  $stack=New-Object System.Collections.Generic.Stack[int]; $stack.Push($target); $seen=@{}
  while($stack.Count -gt 0){ $n=$stack.Pop(); if($seen.ContainsKey($n)){continue}; $seen[$n]=$true; $order.Add($n); if($kids.ContainsKey($n)){ foreach($c in $kids[$n]){ $stack.Push($c) } } }
  $killed=@()
  for($i=$order.Count-1; $i -ge 0; $i--){ try{ Stop-Process -Id $order[$i] -Force -ErrorAction Stop; $killed+=$order[$i] }catch{} }
  ConvertTo-Json @{ ok=$true; target=$target; killed=@($killed); closedTab=[bool]$CloseTab; windowClosed=$windowClosed } -Depth 6 -Compress
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
  /** Windows session of the target pid, and of the Core. Driving requires they
   *  match — Session 0 isolation blocks cross-session console access. */
  sessionId?: number | null;
  coreSessionId?: number | null;
  /** hosted in a real terminal AND in the same Windows session as the Core (so
   *  the marker locate / console attach at drive time can reach it). */
  driveable: boolean;
  /** when not driveable, why (cross-session / no host) — for diagnostics. */
  reason?: string | null;
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

// ---------------------------------------------------------------------------
// Engine invocation
// ---------------------------------------------------------------------------

let enginePathCache: string | null = null;

function enginePath(): string {
  if (enginePathCache && fs.existsSync(enginePathCache)) return enginePathCache;
  const p = path.join(os.tmpdir(), 'lm-assist-wt-engine.ps1');
  // UTF-8 BOM is REQUIRED: PowerShell 5.1 parses BOM-less files as the ANSI
  // codepage (cp950 here), where a multi-byte char's tail byte can eat a
  // closing quote and break the whole script. Keep the engine ASCII anyway.
  // NOTE: the quoted prefix below is a LITERAL U+FEFF char (invisible).
  fs.writeFileSync(p, "﻿" + ENGINE_PS1, "utf8");
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

/**
 * Bring the window/tab hosting `pid` to the front and (optionally) paste text.
 * Locates the tab authoritatively via a unique console-title marker (drift-proof),
 * selects it, restores the title, then foregrounds + pastes. With `submit:true`
 * also presses Enter.
 */
export async function focusAndSend(opts: {
  pid?: number;
  rid?: string;
  text?: string;
  submit?: boolean;
  /** raw SendKeys string (e.g. "{ENTER}", "1{ENTER}", "{ESC}"); ignores text */
  keys?: string;
}): Promise<SendResult> {
  if (!IS_WINDOWS) return { ok: false, error: 'windows-only' };
  const args = ['-Action', 'send'];
  if (opts.rid) args.push('-RuntimeId', opts.rid); // title-independent, robust
  if (opts.pid) args.push('-ClaudePid', String(opts.pid)); // marker fallback
  if (opts.keys) args.push('-Keys', opts.keys);
  else if (opts.text) args.push('-MessageB64', Buffer.from(opts.text, 'utf8').toString('base64'));
  if (opts.submit) args.push('-Submit');
  return (await runEngine(args)) as SendResult;
}

export interface CaptureResult {
  ok: boolean;
  pid: number;
  /** visible viewport text, rows joined with \n, trailing spaces trimmed */
  text?: string;
  error?: string;
}

/**
 * Read the visible terminal text of the console hosting `pid` — the Windows
 * equivalent of tmux capture-pane. Passive (AttachConsole + read CONOUT$, no
 * focus change, no input). Works for ANY console-attached pid, including a
 * claude stuck at the folder-trust prompt that never registered a session.
 */
export async function captureScreen(pid: number): Promise<CaptureResult> {
  if (!IS_WINDOWS) return { ok: false, pid, error: 'windows-only' };
  const r = await runEngine(['-Action', 'capture', '-ClaudePid', String(pid)]);
  if (r?.ok && typeof r.textB64 === 'string') {
    return { ok: true, pid, text: Buffer.from(r.textB64, 'base64').toString('utf8') };
  }
  return { ok: false, pid, error: r?.error || 'capture failed' };
}

// ---------------------------------------------------------------------------
// Tab RuntimeId cache — stable, title-independent tab handle. Populated when we
// CREATE a session (diff the tab set before/after launch). Lets us drive a
// freshly-created session whose title is still animating (marker can't win then).
// ---------------------------------------------------------------------------
const tabRidBySession = new Map<string, string>();

export function getTabRid(key: string): string | undefined {
  return tabRidBySession.get(key);
}
export function setTabRid(key: string, rid: string): void {
  tabRidBySession.set(key, rid);
}
export function forgetTabRid(key: string): void {
  tabRidBySession.delete(key);
}

interface TabId { rid: string; hwnd: number; tabIndex: number; name: string }

export async function listTabIds(): Promise<TabId[]> {
  if (!IS_WINDOWS) return [];
  const r = await runEngine(['-Action', 'tabids']);
  return (r?.tabs ?? []) as TabId[];
}

export interface TerminalProc {
  pid: number;
  name: string;
  hostPid: number;
  hostName: string;
  /** spinner-stripped console title */
  title: string;
}

/** Generic list of terminal-hosted processes (the program owning each tab's
 *  console) — pid + title. Backs the generic wt terminal backend's list(). */
export async function listTerminalProcs(): Promise<TerminalProc[]> {
  if (!IS_WINDOWS) return [];
  const r = await runEngine(['-Action', 'procs']);
  return (r?.procs ?? []) as TerminalProc[];
}

// ---------------------------------------------------------------------------
// Create (generic — run ANY command) / Delete
// ---------------------------------------------------------------------------

export interface CloseResult {
  ok: boolean;
  target?: number;
  killed?: number[];
  closedTab?: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Spawn a Windows Terminal window (default) or tab running an arbitrary command
 * (`cmd /k <command>`). Fire-and-forget — the Claude layer (or any caller) polls
 * for whatever it needs afterward. windowsHide:false is REQUIRED: the shared
 * spawn wrapper defaults windowsHide:true, which opens the window HIDDEN
 * (IsWindowVisible=false) so it never enters the UIA tab tree.
 */
export function spawnTerminal(opts: { cwd: string; command: string; mode?: 'window' | 'tab' }): void {
  const wtArgs =
    opts.mode === 'tab'
      ? ['-w', '0', 'nt', '-d', opts.cwd, 'cmd', '/k', opts.command]
      : ['-w', 'new', '-d', opts.cwd, 'cmd', '/k', opts.command];
  const child = spawn('wt.exe', wtArgs, { detached: true, stdio: 'ignore', windowsHide: false } as any);
  child.unref();
}

export interface WindowLaunchResult {
  launched: boolean;
  /** stable, title-independent handle for the new tab (diffed from the tab set) */
  tabRid: string | null;
  mode: string;
  cwd: string;
  command: string;
  note?: string;
}

/**
 * Launch ANY command in a new Windows Terminal window/tab and return the new
 * tab's RuntimeId (title-independent handle) once it appears. Generic — no
 * Claude knowledge. Use focusAndSend/captureScreen/closeWindow to drive it.
 */
export async function launchWindow(opts: {
  cwd?: string;
  command: string;
  mode?: 'window' | 'tab';
  waitMs?: number;
}): Promise<WindowLaunchResult> {
  if (!IS_WINDOWS) return { launched: false, tabRid: null, mode: '', cwd: '', command: opts.command, note: 'windows-only' };
  const cwd = opts.cwd || os.homedir();
  const mode = opts.mode || 'window';
  const beforeRids = new Set((await listTabIds()).map((t) => t.rid));
  spawnTerminal({ cwd, command: opts.command, mode });
  const deadline = Date.now() + (opts.waitMs ?? 9000);
  let tabRid: string | null = null;
  while (Date.now() < deadline && !tabRid) {
    await sleep(500);
    const neu = (await listTabIds()).filter((t) => !beforeRids.has(t.rid));
    if (neu.length === 1) tabRid = neu[0].rid;
    else if (neu.length > 1) break; // ambiguous (concurrent launches)
  }
  return {
    launched: true,
    tabRid,
    mode,
    cwd,
    command: opts.command,
    note: tabRid ? undefined : 'launched, but could not isolate the new tab (concurrent launches?)',
  };
}


/**
 * Terminate a session by killing its process subtree (WMI-free — enumerates the
 * tree via the engine's parent map + Stop-Process, since taskkill is unreliable).
 * With `closeTab`, kills the tab's host shell subtree so the WT tab/window closes;
 * otherwise kills just the claude process (the tab may remain at a shell prompt).
 */
export async function closeWindow(pid: number, closeTab = false, rid?: string): Promise<CloseResult> {
  if (!IS_WINDOWS) return { ok: false, error: 'windows-only' };
  const args = ['-Action', 'close', '-ClaudePid', String(pid)];
  if (rid) args.push('-RuntimeId', rid); // precise tab in a multi-tab window
  if (closeTab) args.push('-CloseTab');
  return (await runEngine(args)) as CloseResult;
}

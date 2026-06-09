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
import { listLiveSessions, LiveSession } from './cc-sessions';

// ---------------------------------------------------------------------------
// Embedded PowerShell engine (materialized to a temp .ps1 on first use).
// Embedded rather than shipped as a file because the build is tsc-only (no
// asset copy) and must work from both a dev checkout and an npm install.
// Contains no backticks and no `${`, so it is safe inside a String.raw literal.
// ---------------------------------------------------------------------------
const ENGINE_PS1 = String.raw`
param(
  [Parameter(Mandatory)][ValidateSet('query','locate','send','close','tabids','capture')][string]$Action,
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

  static INPUT_RECORD MakeKey(bool down, ushort vk, char ch) {
    var r = new INPUT_RECORD(); r.EventType = 0x0001; // KEY_EVENT
    r.Key.bKeyDown = down ? 1 : 0; r.Key.wRepeatCount = 1; r.Key.wVirtualKeyCode = vk;
    r.Key.wVirtualScanCode = (ushort)MapVirtualKey(vk, 0); r.Key.UnicodeChar = ch; r.Key.dwControlKeyState = 0;
    return r;
  }
  // spec = space-separated tokens: ENTER ESC UP DOWN LEFT RIGHT TAB SPACE, or a single literal char.
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
          ushort vk; char ch;
          switch (raw.ToUpperInvariant()) {
            case "ENTER": vk = 0x0D; ch = '\r'; break;
            case "ESC": vk = 0x1B; ch = (char)27; break;
            case "UP": vk = 0x26; ch = '\0'; break;
            case "DOWN": vk = 0x28; ch = '\0'; break;
            case "LEFT": vk = 0x25; ch = '\0'; break;
            case "RIGHT": vk = 0x27; ch = '\0'; break;
            case "TAB": vk = 0x09; ch = '\t'; break;
            case "SPACE": vk = 0x20; ch = ' '; break;
            default: ch = raw[0]; vk = (ushort)(VkKeyScan(ch) & 0xFF); break;
          }
          recs.Add(MakeKey(true, vk, ch));
          recs.Add(MakeKey(false, vk, ch));
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
    ConvertTo-Json @{ ok=$false; error="AttachConsole failed (win32=$err) - pid has no console?" } -Compress; exit 2
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

// ---------------------------------------------------------------------------
// Screen-state classifier + auto-handlers
//
// On top of captureScreen: pattern-match the visible terminal text into a
// known state so callers (and the create flow) can react automatically — most
// importantly auto-accepting the folder-trust prompt, but also surfacing
// questions, rate limits, server errors and auth problems instead of silently
// hanging. Patterns are derived from the Claude Code CLI's on-screen strings.
// ---------------------------------------------------------------------------

export type ScreenState =
  | 'folder_trust' // "Is this a project you created or one you trust?"
  | 'await_question' // a numbered choice / permission prompt waiting on the user
  | 'rate_limit_user' // the account's usage limit (5-hour / weekly) is reached
  | 'rate_limit_server' // "Server is temporarily limiting requests (not your usage limit)"
  | 'overloaded' // 529 / Overloaded / "Waiting for capacity"
  | 'server_error' // API Error 5xx / internal server error
  | 'auth_error' // invalid key / expired OAuth / credit too low / needs /login
  | 'busy' // actively working (spinner / "esc to interrupt")
  | 'idle' // at the prompt, ready for input
  | 'unknown';

export interface ScreenClassification {
  state: ScreenState;
  /** the line (or extracted fragment) that triggered the match */
  detail?: string;
  /** for await_question: the numbered options found */
  options?: string[];
  /** for rate_limit_*: extracted reset/retry hint if present */
  retryHint?: string;
}

/** Classify the visible terminal text. Pure + deterministic; order = priority. */
export function classifyScreen(text: string): ScreenClassification {
  const t = text || '';
  const find = (re: RegExp): string | undefined => {
    const m = t.match(re);
    return m ? (m[0].length > 200 ? m[0].slice(0, 200) : m[0]).trim() : undefined;
  };

  // 1. Folder-trust prompt (highest priority — blocks everything, auto-handleable)
  let d =
    find(/Is this a project you created or one you trust\??/i) ||
    find(/Do you trust the files in this folder\??/i) ||
    find(/Yes, I trust this folder/i);
  if (d) return { state: 'folder_trust', detail: d };

  // 2. Auth problems
  d =
    find(/OAuth token has expired[^\n]*/i) ||
    find(/Invalid API key[^\n]*/i) ||
    find(/Invalid authentication credentials[^\n]*/i) ||
    find(/Credit balance is too low[^\n]*/i) ||
    find(/API Error:\s*401[^\n]*/i) ||
    find(/Please run \/login[^\n]*/i);
  if (d) return { state: 'auth_error', detail: d };

  // 3. Server-side throttle — explicitly NOT the user's usage limit (check before user limit)
  d = find(/Server is temporarily limiting requests \(not your usage limit\)[^\n]*/i) || find(/temporarily limiting requests[^\n]*/i);
  if (d) return { state: 'rate_limit_server', detail: d };

  // 4. User account usage limit
  d =
    find(/(Claude )?usage limit reached[^\n]*/i) ||
    find(/5-hour limit[^\n]*/i) ||
    find(/approaching your usage limit[^\n]*/i) ||
    find(/You've been rate limited[^\n]*/i) ||
    find(/limit reached[^\n]*reset[^\n]*/i);
  if (d) {
    return { state: 'rate_limit_user', detail: d, retryHint: find(/resets?\s*(at|in)[^\n]*/i) };
  }

  // 5. Overloaded / capacity (529)
  d = find(/Overloaded[^\n]*/i) || find(/overloaded_error/i) || find(/API Error:\s*529[^\n]*/i) || find(/Waiting for capacity[^\n]*/i);
  if (d) return { state: 'overloaded', detail: d };

  // 6. Other server / API errors (5xx)
  d = find(/API Error:\s*5\d\d[^\n]*/i) || find(/Internal server error[^\n]*/i) || find(/API Error \(.*5\d\d.*\)[^\n]*/i);
  if (d) return { state: 'server_error', detail: d };

  // 7. A question / numbered choice waiting on the user (permission prompts, etc.)
  if (/Enter to confirm|Do you want to (proceed|continue|create|run|make|allow)/i.test(t) || /❯\s*\d+\.\s+\S/.test(t)) {
    const options = (t.match(/^[\s│]*[❯>]?\s*(\d+\.\s+.+?)\s*$/gim) || [])
      .map((l) => l.replace(/^[\s│❯>]+/, '').trim())
      .filter(Boolean)
      .slice(0, 9);
    if (options.length > 0) {
      return { state: 'await_question', detail: find(/(Do you want to[^\n]*|[^\n]*\?)\s*$/m) || options[0], options };
    }
  }

  // 8. Busy (actively working)
  if (/esc to interrupt|\besc\b.*interrupt|Running…|tokens? ·|⏵⏵|✻|✶|·\s*\d+\s*tokens/i.test(t)) {
    return { state: 'busy', detail: find(/[^\n]*esc to interrupt[^\n]*/i) };
  }

  // 9. Idle at the prompt
  if (/[❯>]\s*$|bypass permissions on|for shortcuts|\bctx:\d+%/i.test(t)) {
    return { state: 'idle' };
  }

  return { state: 'unknown' };
}

export interface AutoHandleResult {
  ok: boolean;
  pid: number;
  state: ScreenState;
  detail?: string;
  options?: string[];
  retryHint?: string;
  /** true when we sent keystrokes to advance the prompt */
  handled: boolean;
  action?: string;
  error?: string;
}

/**
 * Capture + classify a session's screen and, when actionable, advance it:
 *   - folder_trust  -> press Enter (confirms the highlighted "Yes, I trust") when trust!==false
 *   - await_question -> press the given `answer` digit (only if provided — never guesses)
 * Everything else (rate limits, server errors, auth) is reported, not actioned.
 */
export async function autoHandle(
  pid: number,
  opts: { trust?: boolean; answer?: number; rid?: string } = {},
): Promise<AutoHandleResult> {
  if (!IS_WINDOWS) return { ok: false, pid, state: 'unknown', handled: false, error: 'windows-only' };
  const cap = await captureScreen(pid);
  if (!cap.ok) return { ok: false, pid, state: 'unknown', handled: false, error: cap.error };
  const cls = classifyScreen(cap.text || '');
  const base: AutoHandleResult = { ok: true, pid, state: cls.state, detail: cls.detail, options: cls.options, retryHint: cls.retryHint, handled: false };

  if (cls.state === 'folder_trust' && opts.trust !== false) {
    const r = await focusAndSend({ pid, rid: opts.rid, keys: 'ENTER' });
    return { ...base, handled: r.ok, action: r.ok ? 'trusted-folder (Enter)' : r.error };
  }
  if (cls.state === 'await_question' && typeof opts.answer === 'number' && opts.answer >= 1 && opts.answer <= 9) {
    const r = await focusAndSend({ pid, rid: opts.rid, keys: `${opts.answer} ENTER` });
    return { ...base, handled: r.ok, action: r.ok ? `answered ${opts.answer}` : r.error };
  }
  return { ...base, action: 'observed' };
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

export function getTabRid(sessionId: string): string | undefined {
  return tabRidBySession.get(sessionId);
}
export function forgetTabRid(sessionId: string): void {
  tabRidBySession.delete(sessionId);
}

interface TabId { rid: string; hwnd: number; tabIndex: number; name: string }

export async function listTabIds(): Promise<TabId[]> {
  if (!IS_WINDOWS) return [];
  const r = await runEngine(['-Action', 'tabids']);
  return (r?.tabs ?? []) as TabId[];
}

// ---------------------------------------------------------------------------
// Create / Delete
// ---------------------------------------------------------------------------

export interface LaunchResult {
  launched: boolean;
  sessionId: string | null;
  win?: WinMapping | null;
  pid?: number;
  /** stable, title-independent tab handle captured at create (for robust drive) */
  tabRid?: string | null;
  /** true when a folder-trust prompt was detected and auto-accepted during launch */
  trustHandled?: boolean;
  mode: string;
  cwd: string;
  note?: string;
}

export interface CloseResult {
  ok: boolean;
  target?: number;
  killed?: number[];
  closedTab?: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** All live claude.exe pids via PowerShell Get-Process (reliable on Windows;
 *  the find-process npm pkg is flaky here). [] on non-Windows or on error. */
function listClaudePids(): Promise<number[]> {
  if (!IS_WINDOWS) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-Process claude -ErrorAction SilentlyContinue).Id'],
      { timeout: 8000, windowsHide: true } as any,
      (_err: any, stdout: string) => {
        resolve(
          String(stdout || '')
            .split(/\r?\n/)
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0),
        );
      },
    );
  });
}

function samePath(a: string, b: string): boolean {
  const norm = (s: string) => (s || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Launch a new Claude Code session in a Windows Terminal window (default) or tab,
 * then poll the live-session registry for the newly-registered sessionId (matched
 * by cwd). Returns the new session + its window mapping once it registers.
 *
 * Note: if the target cwd is not yet folder-trusted, Claude shows a trust prompt
 * and does not register until accepted — `sessionId` comes back null with a note.
 */
export async function launchSession(opts: {
  cwd?: string;
  mode?: 'window' | 'tab';
  resume?: string;
  waitMs?: number;
  skipPermissions?: boolean;
  remoteControl?: boolean | string;
  /** auto-accept the folder-trust prompt if it blocks registration (default true) */
  autoTrust?: boolean;
} = {}): Promise<LaunchResult> {
  if (!IS_WINDOWS) return { launched: false, sessionId: null, mode: '', cwd: '', note: 'windows-only' };
  const cwd = opts.cwd || os.homedir();
  const mode = opts.mode || 'window';
  const autoTrust = opts.autoTrust !== false;
  const before = new Set(listLiveSessions().map((s) => s.sessionId));
  const beforeRids = new Set((await listTabIds()).map((t) => t.rid));
  const beforeClaude = new Set(await listClaudePids());
  const skipFlag = opts.skipPermissions ? ' --dangerously-skip-permissions' : '';
  const rcFlag = opts.remoteControl ? ' --remote-control' + (typeof opts.remoteControl === 'string' ? ` ${opts.remoteControl}` : '') : '';
  const claudeCmd = (opts.resume ? `claude --resume ${opts.resume}` : 'claude') + rcFlag + skipFlag;
  const wtArgs =
    mode === 'tab'
      ? ['-w', '0', 'nt', '-d', cwd, 'cmd', '/k', claudeCmd]
      : ['-w', 'new', '-d', cwd, 'cmd', '/k', claudeCmd];
  // windowsHide:false is REQUIRED — the spawn wrapper defaults windowsHide:true,
  // which opens the terminal window HIDDEN (IsWindowVisible=false) so it never
  // appears in the UIA tab tree and can't be located/driven. Force it visible.
  const child = spawn('wt.exe', wtArgs, { detached: true, stdio: 'ignore', windowsHide: false } as any);
  child.unref();

  const start = Date.now();
  const deadline = start + (opts.waitMs ?? 9000);
  let sid: string | null = null;
  let pid: number | undefined;
  let trustHandled = false;
  let lastTrustTry = 0;
  while (Date.now() < deadline) {
    await sleep(400);
    for (const s of listLiveSessions()) {
      // On resume, `claude --resume <id>` briefly registers a transient session id
      // at startup before settling onto <id>; match the resumed id specifically so
      // we don't return the transient. On fresh create, take the new id by diff.
      const match = opts.resume
        ? s.sessionId === opts.resume && samePath(s.owner.cwd, cwd)
        : !before.has(s.sessionId) && samePath(s.owner.cwd, cwd);
      if (match) {
        sid = s.sessionId;
        pid = s.owner.pid;
        break;
      }
    }
    if (sid) break;

    // Auto-trust: if registration is blocked for a couple seconds, a new claude
    // is probably sitting at the folder-trust prompt (it doesn't register until
    // accepted). Find the new claude pid (reliable Get-Process, not find-process),
    // confirm it's the trust screen, inject Enter into its console buffer, then
    // keep polling for it to register. Retried across the poll until handled.
    if (autoTrust && !trustHandled && Date.now() - start > 2200 && Date.now() - lastTrustTry > 1400) {
      lastTrustTry = Date.now();
      try {
        for (const cp of await listClaudePids()) {
          if (beforeClaude.has(cp)) continue;
          const cap = await captureScreen(cp);
          if (cap.ok && classifyScreen(cap.text || '').state === 'folder_trust') {
            await focusAndSend({ pid: cp, keys: 'ENTER' });
            trustHandled = true;
            break;
          }
        }
      } catch {
        /* best effort */
      }
    }
  }

  // Capture the new tab's RuntimeId by diffing the tab set — a title-independent
  // handle so we can drive this session even while its title is still animating.
  // The new WT window can lag the registry by a few seconds, so poll for it.
  // The new WT window can lag the registry by a few seconds, so poll for it.
  let tabRid: string | null = null;
  if (sid) {
    for (let i = 0; i < 14 && !tabRid; i++) {
      await sleep(500);
      const newTabs = (await listTabIds()).filter((t) => !beforeRids.has(t.rid));
      if (newTabs.length === 1) {
        tabRid = newTabs[0].rid;
        tabRidBySession.set(sid, tabRid);
      } else if (newTabs.length > 1) {
        break; // ambiguous (concurrent launches) — leave uncached, marker fallback
      }
    }
  }

  let win: WinMapping | null = null;
  if (pid) win = (await mapPidsToWindows([pid]))[0] ?? null;
  return {
    launched: true,
    sessionId: sid,
    pid,
    win,
    tabRid,
    trustHandled,
    mode,
    cwd,
    note: sid
      ? trustHandled
        ? 'folder-trust prompt was auto-accepted during launch'
        : undefined
      : 'launched, but no new session registered within the wait window — a folder-trust prompt may still be pending (autoTrust may have been disabled or the prompt differs); GET /terminal/windows/capture?pid=<newClaudePid> to see it',
  };
}

/**
 * Terminate a session by killing its process subtree (WMI-free — enumerates the
 * tree via the engine's parent map + Stop-Process, since taskkill is unreliable).
 * With `closeTab`, kills the tab's host shell subtree so the WT tab/window closes;
 * otherwise kills just the claude process (the tab may remain at a shell prompt).
 */
export async function closeSession(pid: number, closeTab = false, rid?: string): Promise<CloseResult> {
  if (!IS_WINDOWS) return { ok: false, error: 'windows-only' };
  const args = ['-Action', 'close', '-ClaudePid', String(pid)];
  if (rid) args.push('-RuntimeId', rid); // precise tab in a multi-tab window
  if (closeTab) args.push('-CloseTab');
  return (await runEngine(args)) as CloseResult;
}

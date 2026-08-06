# Desktop automation — Windows helper (long-lived JSON-lines process).
#
# Spawned once by win32-backend.ts and kept alive: powershell.exe spawn costs
# ~250ms and the Add-Type P/Invoke compile ~1s more, so per-action spawning is
# ruled out (measured on DESKTOP-GDKLATG 2026-08-05). Protocol: one JSON object
# per stdin line {id, cmd, args} -> one JSON object per stdout line
# {id, ok, data} | {id, ok:false, code, message}. stderr is diagnostics only.
#
# DPI AWARENESS IS DECLARED FIRST — before ANY geometry or capture call. A
# dpi-UNAWARE process on a scaled display (107 runs 200%) sees a virtualized
# 1920x1080 desktop: captures are blurry-upscaled and every coordinate is 2x
# off. With PER_MONITOR_AWARE_V2 all coordinates are PHYSICAL virtual-screen
# pixels, matching the cross-platform contract in ../src/desktop/types.ts.
#
# Owned by the win-automation session (node 107) — see spec §9
# (docs/superpowers/specs/2026-08-05-desktop-automation-design.md).

$ErrorActionPreference = 'Stop'

# ── console wiring: UTF-8 both ways, no BOM (node reads/writes utf8) ─────────
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# ── the one P/Invoke shim (types cannot be redefined in-process) ─────────────
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DeskNative {
  // ── DPI ──
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);

  // ── geometry / structs ──
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public uint length; public uint flags; public uint showCmd;
    public POINT ptMin; public POINT ptMax; public RECT rcNormal;
  }

  // ── window enumeration ──
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT val, int size);

  private static List<long> tops = new List<long>();
  private static bool TopFilter(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    if (GetWindowTextLength(h) == 0) return true;
    int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4); // DWMWA_CLOAKED
    if (cloaked != 0) return true;
    tops.Add(h.ToInt64());
    return true;
  }
  /** Visible, titled, uncloaked top-level windows in z-order (top first). */
  public static long[] EnumTops() {
    tops.Clear();
    EnumWindows(TopFilter, IntPtr.Zero);
    return tops.ToArray();
  }

  // ── focus / show ──
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);

  // ── cursor / input ──
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO ci);
  [DllImport("user32.dll")] public static extern IntPtr CopyIcon(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr h, out ICONINFO ii);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
  [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int w, int h, uint step, IntPtr brush, uint flags);

  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004,
    MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010,
    MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040,
    MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
  public const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_EXTENDEDKEY = 0x0001;

  public static void MouseEvent(uint flags, uint data) {
    INPUT[] inp = new INPUT[1];
    inp[0].type = 0; // INPUT_MOUSE
    inp[0].U.mi.dwFlags = flags;
    inp[0].U.mi.mouseData = data;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void KeyVk(ushort vk, bool down, bool extended) {
    INPUT[] inp = new INPUT[1];
    inp[0].type = 1; // INPUT_KEYBOARD
    inp[0].U.ki.wVk = vk;
    uint f = 0;
    if (!down) f |= KEYEVENTF_KEYUP;
    if (extended) f |= KEYEVENTF_EXTENDEDKEY;
    inp[0].U.ki.dwFlags = f;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void KeyUnicode(ushort unit, bool down) {
    INPUT[] inp = new INPUT[1];
    inp[0].type = 1;
    inp[0].U.ki.wScan = unit;
    inp[0].U.ki.dwFlags = down ? KEYEVENTF_UNICODE : (KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
  /// Inject a prepared sequence RELIABLY. Measured on 107 (2026-08-05):
  ///   - one SendInput call PER EVENT lets the system interleave → Notepad
  ///     drops/doubles characters ("win32" arrived as "iin32");
  ///   - one call for ALL events overflows the input queue → SendInput
  ///     partially injects (100 events, 20 taken → "lm-assist " on disk).
  /// So: sub-batches of 16 events, resume from the reported injected count,
  /// pause to let the queue drain when a batch comes back short.
  private static int InjectSeq(List<INPUT> seq) {
    int injected = 0; int guard = 0;
    int size = Marshal.SizeOf(typeof(INPUT));
    while (injected < seq.Count && guard < 400) {
      guard++;
      int n = Math.Min(16, seq.Count - injected);
      INPUT[] slice = seq.GetRange(injected, n).ToArray();
      uint r = SendInput((uint)n, slice, size);
      injected += (int)r;
      if (r < (uint)n) System.Threading.Thread.Sleep(25); // queue full — drain
      else System.Threading.Thread.Sleep(6);
    }
    return injected;
  }
  /// Play a VK sequence (combos, holds) — batched + resumed like text.
  /// Returns [injected, total] so the caller can refuse a short injection.
  public static int[] KeyBatch(int[] vks, bool[] downs, bool[] exts) {
    List<INPUT> seq = new List<INPUT>();
    for (int i = 0; i < vks.Length; i++) {
      INPUT ev = new INPUT();
      ev.type = 1;
      ev.U.ki.wVk = (ushort)vks[i];
      uint f = 0;
      if (!downs[i]) f |= KEYEVENTF_KEYUP;
      if (exts[i]) f |= KEYEVENTF_EXTENDEDKEY;
      ev.U.ki.dwFlags = f;
      seq.Add(ev);
    }
    return new int[] { InjectSeq(seq), seq.Count };
  }
  // ── deterministic text path: WM_CHAR to the focused control ──
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public int cbSize; public uint flags;
    public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret;
    public RECT rcCaret;
  }
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);

  /// Type text DETERMINISTICALLY: WM_CHAR via SendMessageTimeout to the focused
  /// control. Each message carries its own character and SendMessage to another
  /// thread BLOCKS until that thread has processed it — strict per-char
  /// serialization, immune to the VK_PACKET latest-char race that survives even
  /// atomic-pair pacing ("via /mcp" arrived as "iia mmcp" through the paced
  /// SendInput path — measured cross-node by the 117 session, 2026-08-06).
  /// Newlines map to WM_CHAR '\r' (what Enter produces in edit controls).
  /// Returns [consumedIndex, textLength, focusFound(0|1)]; consumedIndex < length
  /// means the target hung/timed out — the caller resumes from that index on the
  /// SendInput fallback (backing up a dangling high surrogate).
  public static int[] TypeViaMessages(string text) {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero) return new int[] { 0, text.Length, 0 };
    uint pid; uint tid = GetWindowThreadProcessId(fg, out pid);
    GUITHREADINFO gi = new GUITHREADINFO();
    gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    IntPtr target = fg;
    if (GetGUIThreadInfo(tid, ref gi) && gi.hwndFocus != IntPtr.Zero) target = gi.hwndFocus;
    int i = 0;
    while (i < text.Length) {
      char c = text[i];
      int adv = 1;
      bool newline = false;
      if (c == '\r') { newline = true; if (i + 1 < text.Length && text[i + 1] == '\n') adv = 2; }
      else if (c == '\n') { newline = true; }
      IntPtr res;
      IntPtr ok;
      if (newline) {
        // RichEditD2D (Win11 Notepad) inserts NOTHING for WM_CHAR '\r' (measured:
        // 8 typed lines arrived as one). Enter must arrive as the key pair —
        // still via SendMessage so ordering with the WM_CHARs stays strict.
        ok = SendMessageTimeout(target, 0x0100 /*WM_KEYDOWN*/, (IntPtr)0x0D, (IntPtr)0x001C0001, 0x0002, 2000, out res);
        if (ok != IntPtr.Zero) SendMessageTimeout(target, 0x0101 /*WM_KEYUP*/, (IntPtr)0x0D, (IntPtr)unchecked((int)0xC01C0001), 0x0002, 2000, out res);
      } else {
        ok = SendMessageTimeout(target, 0x0102 /*WM_CHAR*/, (IntPtr)c, (IntPtr)1, 0x0002 /*SMTO_ABORTIFHUNG*/, 2000, out res);
      }
      if (ok == IntPtr.Zero) {
        // timed out / hung: don't strand half a surrogate pair on the fallback
        if (i > 0 && char.IsLowSurrogate(text[i]) ) i--;
        break;
      }
      i += adv;
    }
    return new int[] { i, text.Length, 1 };
  }

  /// Type text via UNICODE events, ONE CHARACTER PER SendInput CALL, paced.
  /// Why not batches: KEYEVENTF_UNICODE queues VK_PACKET events whose char is
  /// resolved when the APP translates the message — inject faster than the app
  /// pumps and every backlogged event resolves to the LATEST char (measured on
  /// 107: a 100-event batch arrived as "lm-assist " + 37 spaces + 13 quotes).
  /// Why one call per PAIR: a down and up in separate calls can interleave with
  /// other input (measured: "win32" arrived as "iin32"). Atomic pair + pacing
  /// closes both failure modes. Returns [injected, total].
  public static int[] TypeChunk(string text) {
    int injected = 0, total = 0;
    int size = Marshal.SizeOf(typeof(INPUT));
    for (int i = 0; i < text.Length; i++) {
      char c = text[i];
      if (c == '\r') { if (i + 1 < text.Length && text[i + 1] == '\n') i++; c = '\n'; }
      INPUT[] pair = new INPUT[2];
      if (c == '\n') {
        pair[0].type = 1; pair[0].U.ki.wVk = 0x0D;
        pair[1].type = 1; pair[1].U.ki.wVk = 0x0D; pair[1].U.ki.dwFlags = KEYEVENTF_KEYUP;
      } else {
        pair[0].type = 1; pair[0].U.ki.wScan = c; pair[0].U.ki.dwFlags = KEYEVENTF_UNICODE;
        pair[1].type = 1; pair[1].U.ki.wScan = c; pair[1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      }
      total += 2;
      uint r = SendInput(2, pair, size);
      if (r < 2) { // queue congested — drain and retry the pair once
        System.Threading.Thread.Sleep(40);
        if (r == 0) r = SendInput(2, pair, size);
        else { INPUT[] rest = new INPUT[] { pair[1] }; r += SendInput(1, rest, size); }
      }
      injected += (int)r;
      System.Threading.Thread.Sleep(15); // let the app translate THIS char first
    }
    return new int[] { injected, total };
  }
}
'@

# ── DPI awareness: FIRST geometry-relevant act of the process ────────────────
$script:DpiAware = $false
try {
  # -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
  $script:DpiAware = [DeskNative]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
} catch {}
if (-not $script:DpiAware) {
  try { $script:DpiAware = [DeskNative]::SetProcessDPIAware() } catch {}
}

$script:SessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId

# ── small helpers ────────────────────────────────────────────────────────────

function Rect-ToObj([DeskNative+RECT]$r) {
  return @{ x = $r.L; y = $r.T; width = ($r.R - $r.L); height = ($r.B - $r.T) }
}

# Visual (extended-frame) bounds: what the user SEES. GetWindowRect on Win10+
# includes ~7px invisible resize borders, which would offset every click aimed
# at a reported rect. DWMWA_EXTENDED_FRAME_BOUNDS (9) is the honest rectangle.
function Get-VisualRect([IntPtr]$hwnd) {
  $er = New-Object DeskNative+RECT
  $hr = [DeskNative]::DwmGetWindowAttribute($hwnd, 9, [ref]$er, [System.Runtime.InteropServices.Marshal]::SizeOf([type][DeskNative+RECT]))
  if ($hr -eq 0 -and ($er.R - $er.L) -gt 0) { return $er }
  $wr = New-Object DeskNative+RECT
  [void][DeskNative]::GetWindowRect($hwnd, [ref]$wr)
  return $wr
}

function Get-ScreensData {
  $screens = @()
  $i = 0
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $pt = New-Object DeskNative+POINT
    $pt.X = $s.Bounds.X + [int]($s.Bounds.Width / 2)
    $pt.Y = $s.Bounds.Y + [int]($s.Bounds.Height / 2)
    $dpiX = [uint32]96; $dpiY = [uint32]96
    try {
      $hmon = [DeskNative]::MonitorFromPoint($pt, 2) # MONITOR_DEFAULTTONEAREST
      [void][DeskNative]::GetDpiForMonitor($hmon, 0, [ref]$dpiX, [ref]$dpiY)
    } catch {}
    $screens += @{
      device = $s.DeviceName
      primary = $s.Primary
      bounds = @{ x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height }
      workingArea = @{ x = $s.WorkingArea.X; y = $s.WorkingArea.Y; width = $s.WorkingArea.Width; height = $s.WorkingArea.Height }
      scale = [math]::Round($dpiX / 96.0, 2)
    }
    $i++
  }
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return @{
    screens = $screens
    virtual = @{ x = $vs.X; y = $vs.Y; width = $vs.Width; height = $vs.Height }
  }
}

function Get-WindowRow([long]$h) {
  $hwnd = [IntPtr]$h
  $len = [DeskNative]::GetWindowTextLength($hwnd)
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [void][DeskNative]::GetWindowText($hwnd, $sb, $sb.Capacity)
  $cls = New-Object System.Text.StringBuilder 256
  [void][DeskNative]::GetClassName($hwnd, $cls, $cls.Capacity)
  $pid_ = [uint32]0
  [void][DeskNative]::GetWindowThreadProcessId($hwnd, [ref]$pid_)
  $exe = $null
  try { $exe = (Get-Process -Id $pid_ -ErrorAction Stop).ProcessName } catch {}

  $minimized = [DeskNative]::IsIconic($hwnd)
  $maximized = [DeskNative]::IsZoomed($hwnd)
  if ($minimized) {
    # A minimized window reports a (-32000,-32000) rect; the restore geometry
    # (rcNormal, workspace coords — close enough) is the useful answer.
    $wp = New-Object DeskNative+WINDOWPLACEMENT
    $wp.length = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DeskNative+WINDOWPLACEMENT])
    [void][DeskNative]::GetWindowPlacement($hwnd, [ref]$wp)
    $rect = Rect-ToObj $wp.rcNormal
  } else {
    $rect = Rect-ToObj (Get-VisualRect $hwnd)
  }

  return @{
    hwnd = $h
    title = $sb.ToString()
    class = $cls.ToString()
    exe = $exe
    pid = [int]$pid_
    rect = $rect
    minimized = [bool]$minimized
    maximized = [bool]$maximized
  }
}

# ── command implementations ──────────────────────────────────────────────────

function Cmd-Ping($args_) {
  return @{ ready = $true; dpiAware = $script:DpiAware; sessionId = $script:SessionId; helperPid = $PID; helperVersion = 1 }
}

function Cmd-Status($args_) {
  $sc = Get-ScreensData
  $pt = New-Object DeskNative+POINT
  $cursor = $null
  if ([DeskNative]::GetCursorPos([ref]$pt)) { $cursor = @($pt.X, $pt.Y) }
  $fg = [DeskNative]::GetForegroundWindow()
  $fgRow = $null
  if ($fg -ne [IntPtr]::Zero) {
    try { $fgRow = Get-WindowRow ([long]$fg) } catch {}
  }
  return @{
    dpiAware = $script:DpiAware
    sessionId = $script:SessionId
    screens = $sc.screens
    virtual = $sc.virtual
    cursor = $cursor
    foreground = $fgRow
  }
}

function Cmd-Windows($args_) {
  $rows = @()
  $fg = [long][DeskNative]::GetForegroundWindow()
  foreach ($h in [DeskNative]::EnumTops()) {
    try { $rows += (Get-WindowRow $h) } catch {}
  }
  $sc = Get-ScreensData
  return @{ windows = $rows; foreground = $fg; screens = $sc.screens; virtual = $sc.virtual }
}

function Cmd-Capture($args_) {
  $x = [int]$args_.x; $y = [int]$args_.y
  $w = [int]$args_.w; $h = [int]$args_.h
  $path = [string]$args_.path
  if ($w -le 0 -or $h -le 0) { throw "capture rect has non-positive size (${w}x${h})" }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    if ($args_.cursor) {
      $ci = New-Object DeskNative+CURSORINFO
      $ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DeskNative+CURSORINFO])
      if ([DeskNative]::GetCursorInfo([ref]$ci) -and ($ci.flags -band 1) -and $ci.pt.X -ge $x -and $ci.pt.X -lt ($x + $w) -and $ci.pt.Y -ge $y -and $ci.pt.Y -lt ($y + $h)) {
        $hicon = [DeskNative]::CopyIcon($ci.hCursor)
        if ($hicon -ne [IntPtr]::Zero) {
          $ii = New-Object DeskNative+ICONINFO
          if ([DeskNative]::GetIconInfo($hicon, [ref]$ii)) {
            $hdc = $g.GetHdc()
            try {
              [void][DeskNative]::DrawIconEx($hdc, $ci.pt.X - $ii.xHotspot - $x, $ci.pt.Y - $ii.yHotspot - $y, $hicon, 0, 0, 0, [IntPtr]::Zero, 3) # DI_NORMAL
            } finally { $g.ReleaseHdc($hdc) }
            if ($ii.hbmMask -ne [IntPtr]::Zero) { [void][DeskNative]::DeleteObject($ii.hbmMask) }
            if ($ii.hbmColor -ne [IntPtr]::Zero) { [void][DeskNative]::DeleteObject($ii.hbmColor) }
          }
          [void][DeskNative]::DestroyIcon($hicon)
        }
      }
    }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose(); $bmp.Dispose()
  }
  $size = (Get-Item $path).Length
  return @{ x = $x; y = $y; width = $w; height = $h; path = $path; bytes = [long]$size }
}

function Cmd-MouseMove($args_) {
  if (-not [DeskNative]::SetCursorPos([int]$args_.x, [int]$args_.y)) { throw "SetCursorPos($($args_.x),$($args_.y)) failed" }
  return @{ moved = $true }
}

function Cmd-MouseBtn($args_) {
  $btn = [string]$args_.button
  $ev = [string]$args_.event
  $count = 1
  if ($args_.count) { $count = [int]$args_.count }
  # The contract's left/right are LOGICAL (primary/secondary, computer-use
  # semantics). SendInput flags are PHYSICAL buttons, so on a swapped-buttons
  # system (SM_SWAPBUTTON=23 — true on 107, measured 2026-08-05: a "left_click"
  # opened the context menu) the flags must be crossed to keep the meaning.
  if (($btn -eq 'left' -or $btn -eq 'right') -and [DeskNative]::GetSystemMetrics(23) -ne 0) {
    if ($btn -eq 'left') { $btn = 'right' } else { $btn = 'left' }
  }
  $down = [DeskNative]::MOUSEEVENTF_LEFTDOWN; $up = [DeskNative]::MOUSEEVENTF_LEFTUP
  if ($btn -eq 'right') { $down = [DeskNative]::MOUSEEVENTF_RIGHTDOWN; $up = [DeskNative]::MOUSEEVENTF_RIGHTUP }
  elseif ($btn -eq 'middle') { $down = [DeskNative]::MOUSEEVENTF_MIDDLEDOWN; $up = [DeskNative]::MOUSEEVENTF_MIDDLEUP }
  if ($ev -eq 'down') { [DeskNative]::MouseEvent($down, 0) }
  elseif ($ev -eq 'up') { [DeskNative]::MouseEvent($up, 0) }
  else {
    for ($i = 0; $i -lt $count; $i++) {
      [DeskNative]::MouseEvent($down, 0)
      [DeskNative]::MouseEvent($up, 0)
      if ($i -lt ($count - 1)) { Start-Sleep -Milliseconds 80 }
    }
  }
  return @{ done = $true }
}

function Cmd-Wheel($args_) {
  $axis = [string]$args_.axis
  $delta = [int]$args_.delta   # signed multiples of 120
  $flag = [DeskNative]::MOUSEEVENTF_WHEEL
  if ($axis -eq 'h') { $flag = [DeskNative]::MOUSEEVENTF_HWHEEL }
  # mouseData is a DWORD carrying a SIGNED delta. PS 5.1 parses 0xFFFFFFFF as
  # Int32 -1, so a bitwise mask cannot widen here — two's-complement by hand.
  $ud = if ($delta -lt 0) { [uint32](4294967296 + $delta) } else { [uint32]$delta }
  [DeskNative]::MouseEvent($flag, $ud)
  return @{ done = $true }
}

function Cmd-TypeText($args_) {
  $text = [string]$args_.text
  # Deterministic path first: WM_CHAR via SendMessageTimeout (see TypeViaMessages
  # — the paced-SendInput path still corrupted chars under app pump lag).
  $r = [DeskNative]::TypeViaMessages($text)
  if ($r[2] -eq 1 -and $r[0] -ge $r[1]) {
    return @{ typed = $text.Length; path = 'wmchar' }
  }
  # Fallback: true keyboard injection from where the message path stopped
  # (no focus window resolvable, or the target hung mid-string).
  $rest = $text.Substring([Math]::Max(0, $r[0]))
  $r2 = [DeskNative]::TypeChunk($rest)
  if ($r2[0] -ne $r2[1]) { throw "SendInput injected only $($r2[0]) of $($r2[1]) key events (wmchar consumed $($r[0])/$($r[1]); input queue congested)" }
  return @{ typed = $text.Length; path = "wmchar+$($rest.Length)sendinput" }
}

function Cmd-KeySeq($args_) {
  $steps = @($args_.steps)
  $vks = [int[]]@(); $downs = [bool[]]@(); $exts = [bool[]]@()
  foreach ($step in $steps) {
    $vks += [int]$step.vk
    $downs += [bool]$step.down
    $exts += [bool]$step.extended
  }
  $r = [DeskNative]::KeyBatch($vks, $downs, $exts)
  if ($r[0] -ne $r[1]) { throw "SendInput injected only $($r[0]) of $($r[1]) key events (input queue congested)" }
  return @{ steps = $steps.Count; events = $r[0] }
}

function Cmd-GetCursor($args_) {
  $pt = New-Object DeskNative+POINT
  if (-not [DeskNative]::GetCursorPos([ref]$pt)) { throw 'GetCursorPos failed' }
  return @{ cursor = @($pt.X, $pt.Y) }
}

function Resolve-Hwnd($args_) {
  $h = [IntPtr][long]$args_.hwnd
  if (-not [DeskNative]::IsWindow($h)) { throw "BAD_WINDOW: no window with id $($args_.hwnd)" }
  return $h
}

function Cmd-Window($args_) {
  $hwnd = Resolve-Hwnd $args_
  $action = [string]$args_.action
  switch ($action) {
    'activate' {
      if ([DeskNative]::IsIconic($hwnd)) { [void][DeskNative]::ShowWindow($hwnd, 9) } # SW_RESTORE
      # Foreground-lock workaround: attach to the current foreground thread so
      # SetForegroundWindow is permitted (a background process may not steal
      # focus otherwise — it just flashes the taskbar).
      $fg = [DeskNative]::GetForegroundWindow()
      $attached = $false
      $myTid = [DeskNative]::GetCurrentThreadId()
      $fgTid = [uint32]0
      if ($fg -ne [IntPtr]::Zero -and $fg -ne $hwnd) {
        $dummy = [uint32]0
        $fgTid = [DeskNative]::GetWindowThreadProcessId($fg, [ref]$dummy)
        if ($fgTid -ne 0 -and $fgTid -ne $myTid) { $attached = [DeskNative]::AttachThreadInput($myTid, $fgTid, $true) }
      }
      try {
        [void][DeskNative]::BringWindowToTop($hwnd)
        [void][DeskNative]::SetForegroundWindow($hwnd)
      } finally {
        if ($attached) { [void][DeskNative]::AttachThreadInput($myTid, $fgTid, $false) }
      }
    }
    'close' {
      # Polite WM_CLOSE (0x0010) — never a process kill.
      [void][DeskNative]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    }
    'minimize' { [void][DeskNative]::ShowWindow($hwnd, 6) }  # SW_MINIMIZE
    'maximize' { [void][DeskNative]::ShowWindow($hwnd, 3) }  # SW_MAXIMIZE
    'restore'  { [void][DeskNative]::ShowWindow($hwnd, 9) }  # SW_RESTORE
    'move' {
      # Caller coordinates are VISUAL (extended-frame) px; SetWindowPos wants
      # the outer GetWindowRect origin. Compensate for the invisible border.
      if ([DeskNative]::IsZoomed($hwnd) -or [DeskNative]::IsIconic($hwnd)) { [void][DeskNative]::ShowWindow($hwnd, 9) }
      $wr = New-Object DeskNative+RECT
      [void][DeskNative]::GetWindowRect($hwnd, [ref]$wr)
      $er = Get-VisualRect $hwnd
      $tx = [int]$args_.x + ($wr.L - $er.L)
      $ty = [int]$args_.y + ($wr.T - $er.T)
      # SWP_NOSIZE(1)|SWP_NOZORDER(4)|SWP_NOACTIVATE(0x10)
      [void][DeskNative]::SetWindowPos($hwnd, [IntPtr]::Zero, $tx, $ty, 0, 0, 0x15)
    }
    'resize' {
      if ([DeskNative]::IsZoomed($hwnd) -or [DeskNative]::IsIconic($hwnd)) { [void][DeskNative]::ShowWindow($hwnd, 9) }
      $wr = New-Object DeskNative+RECT
      [void][DeskNative]::GetWindowRect($hwnd, [ref]$wr)
      $er = Get-VisualRect $hwnd
      $tw = [int]$args_.width + (($wr.R - $wr.L) - ($er.R - $er.L))
      $th = [int]$args_.height + (($wr.B - $wr.T) - ($er.B - $er.T))
      # SWP_NOMOVE(2)|SWP_NOZORDER(4)|SWP_NOACTIVATE(0x10)
      [void][DeskNative]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, $tw, $th, 0x16)
    }
    default { throw "BAD_ARGS: unknown window action '$action'" }
  }
  return @{ action = $action; hwnd = [long]$hwnd }
}

function Cmd-Clipboard($args_) {
  $mode = [string]$args_.mode
  if ($mode -eq 'set') {
    $text = [string]$args_.text
    # Set-Clipboard/Get-Clipboard run the clipboard ops on their own STA thread,
    # so they work from this (MTA) helper without declaring -STA at spawn.
    Set-Clipboard -Value $text
    return @{ bytes = [System.Text.Encoding]::UTF8.GetByteCount($text) }
  }
  # get (default): -Raw returns the full multi-line string ($null when empty/non-text).
  $t = Get-Clipboard -Raw -ErrorAction SilentlyContinue
  if ($null -eq $t) { $t = '' }
  return @{ text = [string]$t }
}

function Cmd-Processes($args_) {
  $q = [string]$args_.query
  $limit = [int]$args_.limit
  if ($limit -le 0) { $limit = 50 }
  # Heaviest first (match the X11 backend's rss-desc ordering) so a capped list
  # keeps the biggest processes. WorkingSet64 = resident memory. cpu/user are
  # omitted on Windows: Get-Process reports total CPU *seconds* (not the % the
  # contract means) and the owner needs admin — both are optional in ProcessInfo.
  $procs = Get-Process | Sort-Object -Property WorkingSet64 -Descending
  if ($q) { $procs = @($procs | Where-Object { $_.ProcessName -like "*$q*" }) }
  $rows = @()
  foreach ($p in ($procs | Select-Object -First $limit)) {
    $rows += @{ pid = [int]$p.Id; name = [string]$p.ProcessName; memMiB = [math]::Round($p.WorkingSet64 / 1MB, 1) }
  }
  return @{ processes = @($rows) }
}

# ── main loop: one JSON line in, one JSON line out ───────────────────────────

# Startup hello so the backend can verify liveness + session without a request.
[Console]::Out.WriteLine((@{ hello = $true; dpiAware = $script:DpiAware; sessionId = $script:SessionId; helperPid = $PID; helperVersion = 1 } | ConvertTo-Json -Compress))
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }          # stdin closed → parent gone → exit
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  $reqId = $null
  try {
    $req = $line | ConvertFrom-Json
    $reqId = $req.id
    $a = $req.args
    $data = switch ([string]$req.cmd) {
      'ping'      { Cmd-Ping $a }
      'status'    { Cmd-Status $a }
      'windows'   { Cmd-Windows $a }
      'capture'   { Cmd-Capture $a }
      'mousemove' { Cmd-MouseMove $a }
      'mousebtn'  { Cmd-MouseBtn $a }
      'wheel'     { Cmd-Wheel $a }
      'typetext'  { Cmd-TypeText $a }
      'keyseq'    { Cmd-KeySeq $a }
      'getcursor' { Cmd-GetCursor $a }
      'window'    { Cmd-Window $a }
      'clipboard' { Cmd-Clipboard $a }
      'processes' { Cmd-Processes $a }
      default     { throw "BAD_ARGS: unknown cmd '$($req.cmd)'" }
    }
    $resp = @{ id = $reqId; ok = $true; data = $data } | ConvertTo-Json -Compress -Depth 8
  } catch {
    $msg = $_.Exception.Message
    $code = 'HELPER_ERROR'
    if ($msg -like 'BAD_WINDOW:*') { $code = 'BAD_WINDOW'; $msg = $msg.Substring(11).Trim() }
    elseif ($msg -like 'BAD_ARGS:*') { $code = 'BAD_ARGS'; $msg = $msg.Substring(9).Trim() }
    $resp = @{ id = $reqId; ok = $false; code = $code; message = $msg } | ConvertTo-Json -Compress
  }
  [Console]::Out.WriteLine($resp)
  [Console]::Out.Flush()
}

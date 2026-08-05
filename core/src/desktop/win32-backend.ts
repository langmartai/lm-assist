/**
 * Desktop automation — Windows backend (STUB).
 *
 * 🔴 OWNED BY THE win-automation SESSION on node 107 (DESKTOP-GDKLATG). This file
 * is a typed placeholder so the Linux side builds, ships, and passes tests fleet-
 * wide before the Windows backend exists. The win-automation session REPLACES the
 * body of this class (and adds core/scripts/desktop-helper.ps1 + Windows tests),
 * implementing the DesktopBackend contract from ./types.ts EXACTLY — native-res
 * PNG + geometry out, service.ts owns downscale/encode.
 *
 * Implementation guidance is §9 of docs/superpowers/specs/2026-08-05-desktop-
 * automation-design.md. Summary: ONE long-lived PowerShell helper (JSON-lines),
 * DPI awareness declared FIRST (SetProcessDpiAwarenessContext(-4)), CopyFromScreen
 * capture, SendInput (+KEYEVENTF_UNICODE) input, EnumWindows enumeration, the
 * xdotool-style key names from types.ts mapped to virtual-key codes, and a
 * WINDOWS_SESSION0 guard (reuse windows-session-guard) when Core can't see the
 * desktop.
 */

import {
  DesktopBackend,
  DesktopError,
  DesktopStatus,
  DisplayInfo,
  InputRequest,
  InputResult,
  RawCapture,
  Rect,
  WindowActionRequest,
  WindowActionResult,
  WindowInfo,
  CaptureRequest,
} from './types';

const NOT_IMPLEMENTED =
  'The Windows desktop backend is not implemented yet on this build. It is owned by the ' +
  'win-automation session (node 107) and lands separately — see docs/superpowers/specs/' +
  '2026-08-05-desktop-automation-design.md §9.';

export class Win32Backend implements DesktopBackend {
  readonly platform = 'windows' as const;

  async status(): Promise<DesktopStatus> {
    // status() must never throw — report not-ready with the reason.
    return {
      platform: 'windows',
      ready: false,
      reason: NOT_IMPLEMENTED,
      sessionType: 'windows',
      display: '',
      displays: [],
      screen: { width: 0, height: 0 },
      workarea: null,
      activeWindow: null,
      cursor: null,
      backends: { helper: false },
      warnings: [],
    };
  }

  async windows(): Promise<{ displays: DisplayInfo[]; windows: WindowInfo[]; workarea: Rect | null; activeWindow: string | null }> {
    throw new DesktopError('DESKTOP_UNSUPPORTED', NOT_IMPLEMENTED);
  }
  async capture(_req: CaptureRequest): Promise<RawCapture> {
    throw new DesktopError('DESKTOP_UNSUPPORTED', NOT_IMPLEMENTED);
  }
  async input(_req: InputRequest): Promise<InputResult> {
    throw new DesktopError('DESKTOP_UNSUPPORTED', NOT_IMPLEMENTED);
  }
  async windowAction(_req: WindowActionRequest): Promise<WindowActionResult> {
    throw new DesktopError('DESKTOP_UNSUPPORTED', NOT_IMPLEMENTED);
  }
}

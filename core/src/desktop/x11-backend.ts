/**
 * Desktop automation — Linux/X11 backend.
 *
 * Drives the live X session with the classic X11 toolchain (all verified present
 * + timed on node 117, GNOME 42.9 / Xorg / 3840x2160, 2026-08-05):
 *   capture  — scrot (region, 0.02s) + ffmpeg x11grab (full one-shot, 0.15s)
 *   input    — xdotool (mouse/keyboard/type)
 *   windows  — wmctrl -lGpx (list + activate/close/state) + xprop (EWMH) + xdotool
 *
 * This backend returns NATIVE-RESOLUTION PNG + geometry and typed DesktopError;
 * service.ts owns downscale/crop/encode. No file paths leak in from config here
 * except DESKTOP_TMP_DIR (the one deployment fact a capture needs).
 *
 * GNOME's org.gnome.Shell.Screenshot DBus method is AccessDenied on 41+ (caller
 * allowlist) and is deliberately NOT used — X-side grabs need no compositor
 * cooperation on Xorg. If the session is ever Wayland, ALL of this breaks, so we
 * detect XDG_SESSION_TYPE and refuse LOUDLY (DESKTOP_UNSUPPORTED) rather than
 * silently producing black frames.
 */

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
  WindowState,
  CaptureRequest,
  ClipboardRequest,
  ClipboardResult,
  ProcessInfo,
  ProcessQuery,
} from './types';
import { DESKTOP_TMP_DIR, CAPTURE_TIMEOUT_MS, INPUT_TIMEOUT_MS, WINDOW_TIMEOUT_MS, STATUS_TIMEOUT_MS } from './config';

// ─── process helpers (all async — Core event-loop must never block) ──────────

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a binary with args under DISPLAY, killed on timeout. Never rejects on a
 *  non-zero exit — returns the code so callers classify their own failures. */
function run(bin: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env, maxBuffer: 8 * 1024 * 1024, encoding: 'utf-8' }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: number }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ stdout: stdout || '', stderr: stderr || '', code });
    });
  });
}

/** True when `bin` resolves on PATH. */
function has(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [bin], { timeout: 2000 }, (err, stdout) => resolve(!err && !!stdout.trim()));
  });
}

// ─── display / environment detection ─────────────────────────────────────────

/** Find the live X DISPLAY: prefer $DISPLAY, else the lowest X socket in
 *  /tmp/.X11-unix. Returns null when there is no X server at all. */
function detectDisplay(): string | null {
  if (process.env.DISPLAY && process.env.DISPLAY.trim()) return process.env.DISPLAY.trim();
  try {
    const socks = fs
      .readdirSync('/tmp/.X11-unix')
      .filter((f) => /^X\d+$/.test(f))
      .map((f) => parseInt(f.slice(1), 10))
      .sort((a, b) => a - b);
    if (socks.length) return `:${socks[0]}`;
  } catch {
    /* no X11 socket dir */
  }
  return null;
}

/** Locate an XAUTHORITY for the display, when one is needed (gdm variants). Our
 *  same-uid Xorg on 117 needs none, but pass it through when present so this
 *  works on hosts where the X server was started with -auth. */
function detectXauthority(): string | undefined {
  if (process.env.XAUTHORITY && fs.existsSync(process.env.XAUTHORITY)) return process.env.XAUTHORITY;
  const candidates = [
    path.join(os.homedir(), '.Xauthority'),
    `/run/user/${process.getuid?.() ?? 1000}/gdm/Xauthority`,
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* skip */
    }
  }
  return undefined;
}

/** Build the env a backend command runs under. */
function displayEnv(display: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: display };
  const xauth = detectXauthority();
  if (xauth) env.XAUTHORITY = xauth;
  return env;
}

// ─── parsers (pure — unit-tested against fixture strings) ─────────────────────

/** Parse `xrandr --query` for the current screen size (Screen 0 line). */
export function parseScreenSize(xrandr: string): { width: number; height: number } | null {
  const m = xrandr.match(/current\s+(\d+)\s*x\s*(\d+)/i);
  if (!m) return null;
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/** Parse `xdotool getmouselocation --shell` (X=..\nY=..\n...). */
export function parseMouseLocation(shell: string): [number, number] | null {
  const x = shell.match(/^X=(-?\d+)/m);
  const y = shell.match(/^Y=(-?\d+)/m);
  if (!x || !y) return null;
  return [parseInt(x[1], 10), parseInt(y[1], 10)];
}

/** Parse `xprop -root _NET_ACTIVE_WINDOW` → normalized hex id (or null). */
export function parseActiveWindow(xprop: string): string | null {
  const m = xprop.match(/window id # of group leader:\s*(0x[0-9a-fA-F]+)/) || xprop.match(/_NET_ACTIVE_WINDOW\(WINDOW\):\s*window id # (0x[0-9a-fA-F]+)/);
  if (!m) return null;
  return normalizeWindowId(m[1]);
}

/** Parse `xprop -root _NET_WORKAREA` (first 4 ints = primary desktop workarea). */
export function parseWorkarea(xprop: string): Rect | null {
  const m = xprop.match(/_NET_WORKAREA\(CARDINAL\)\s*=\s*([\d,\s]+)/);
  if (!m) return null;
  const nums = m[1].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
  if (nums.length < 4) return null;
  return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
}

/**
 * Parse `wmctrl -l -G -p -x` rows.
 * Columns: id  desktop  pid  x  y  w  h  WM_CLASS  host  title...
 * Sticky windows report desktop -1. The title is everything after the host col.
 */
export function parseWmctrlWindows(out: string): Omit<WindowInfo, 'state' | 'display'>[] {
  const rows: Omit<WindowInfo, 'state' | 'display'>[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    // Split the first 8 whitespace-delimited fields, keep the rest (host + title).
    const m = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      id: normalizeWindowId(m[1]),
      workspace: parseInt(m[2], 10) < 0 ? null : parseInt(m[2], 10),
      pid: parseInt(m[3], 10) || null,
      bounds: { x: parseInt(m[4], 10), y: parseInt(m[5], 10), width: parseInt(m[6], 10), height: parseInt(m[7], 10) },
      app: m[8], // WM_CLASS as instance.class
      title: m[10].trim(),
    });
  }
  return rows;
}

/** Normalize an X window id to lowercase 0x + no leading-zero padding to 8 hex.
 *  wmctrl prints 0x03600004 while xdotool prints decimal; we standardize on the
 *  0x-hex form for the tool surface and accept either on input (resolveId). */
export function normalizeWindowId(id: string): string {
  const hex = id.trim().toLowerCase().replace(/^0x/, '');
  return `0x${hex.padStart(8, '0')}`;
}

/** Accept an id as the surface hex form OR a decimal (xdotool) and return the
 *  decimal string wmctrl/xdotool -i expects. */
export function toDecimalId(id: string): string {
  const s = id.trim().toLowerCase();
  if (s.startsWith('0x')) return String(parseInt(s, 16));
  if (/^\d+$/.test(s)) return s;
  // hex without 0x
  if (/^[0-9a-f]+$/.test(s)) return String(parseInt(s, 16));
  throw new DesktopError('BAD_WINDOW', `not a window id: ${id}`);
}

/** Parse `xdotool getwindowgeometry --shell <id>` into a Rect (root-space X
 *  window origin — the SAME coordinate space scrot capture and xdotool input use,
 *  unlike `wmctrl -lG`, which double-counts on GNOME/Mutter with GTK CSD and
 *  reports 2x-off positions). Returns null when the fields are absent. */
export function parseWindowGeometry(shell: string): Rect | null {
  const x = shell.match(/^X=(-?\d+)/m);
  const y = shell.match(/^Y=(-?\d+)/m);
  const w = shell.match(/^WIDTH=(\d+)/m);
  const h = shell.match(/^HEIGHT=(\d+)/m);
  if (!x || !y || !w || !h) return null;
  return { x: parseInt(x[1], 10), y: parseInt(y[1], 10), width: parseInt(w[1], 10), height: parseInt(h[1], 10) };
}

/** Parse a window's `_NET_WM_STATE` xprop output into our WindowState. */
export function parseWindowState(xprop: string, isActive: boolean): WindowState {
  if (/_NET_WM_STATE_HIDDEN/.test(xprop)) return 'minimized';
  if (/_NET_WM_STATE_MAXIMIZED_VERT/.test(xprop) && /_NET_WM_STATE_MAXIMIZED_HORZ/.test(xprop)) return 'maximized';
  if (isActive) return 'active';
  return 'normal';
}

// ─── the backend ──────────────────────────────────────────────────────────────

export class X11Backend implements DesktopBackend {
  readonly platform = 'linux-x11' as const;

  /** Resolve display or throw NO_DISPLAY / DESKTOP_UNSUPPORTED. */
  private requireDisplay(): string {
    const sessionType = process.env.XDG_SESSION_TYPE || '';
    if (sessionType.toLowerCase() === 'wayland') {
      throw new DesktopError(
        'DESKTOP_UNSUPPORTED',
        'This session is Wayland (XDG_SESSION_TYPE=wayland). The X11 backend (scrot/xdotool/wmctrl) cannot drive it. ' +
          'Switch the session to Xorg, or wait for the Wayland portal backend (v2).',
      );
    }
    const display = detectDisplay();
    if (!display) {
      throw new DesktopError('NO_DISPLAY', 'No X display found ($DISPLAY unset and no /tmp/.X11-unix/X* socket). Is a desktop session running?');
    }
    return display;
  }

  async status(): Promise<DesktopStatus> {
    const sessionType = process.env.XDG_SESSION_TYPE || 'unknown';
    const base: DesktopStatus = {
      platform: this.platform,
      ready: false,
      sessionType,
      display: '<none>',
      displays: [],
      screen: { width: 0, height: 0 },
      workarea: null,
      activeWindow: null,
      cursor: null,
      backends: {},
      warnings: [],
    };

    if (sessionType.toLowerCase() === 'wayland') {
      return { ...base, platform: 'linux-wayland', reason: 'Wayland session — the X11 backend cannot drive it (v1 supports Xorg only).' };
    }
    const display = detectDisplay();
    if (!display) return { ...base, reason: 'No X display ($DISPLAY unset, no X socket). No desktop session to control.' };
    base.display = display;

    const env = displayEnv(display);
    const [hasScrot, hasXdotool, hasWmctrl, hasFfmpeg, hasXprop, hasXrandr] = await Promise.all([
      has('scrot'), has('xdotool'), has('wmctrl'), has('ffmpeg'), has('xprop'), has('xrandr'),
    ]);
    base.backends = {
      scrot: hasScrot, xdotool: hasXdotool, wmctrl: hasWmctrl, ffmpeg: hasFfmpeg, xprop: hasXprop, xrandr: hasXrandr,
      xauthority: detectXauthority() || false,
    };

    const missing: string[] = [];
    if (!hasScrot && !hasFfmpeg) missing.push('scrot or ffmpeg (capture)');
    if (!hasXdotool) missing.push('xdotool (input)');
    if (!hasWmctrl) missing.push('wmctrl (window management)');
    if (missing.length) {
      return { ...base, reason: `Missing desktop tools: ${missing.join(', ')}. Install with: sudo apt-get install scrot xdotool wmctrl ffmpeg x11-utils` };
    }

    // Screen size + active window + cursor (best effort; a failure here is not fatal to "ready").
    const [xr, activeXprop, mouse] = await Promise.all([
      hasXrandr ? run('xrandr', ['--query'], STATUS_TIMEOUT_MS, env) : Promise.resolve<RunResult>({ stdout: '', stderr: '', code: 1 }),
      hasXprop ? run('xprop', ['-root', '_NET_ACTIVE_WINDOW'], STATUS_TIMEOUT_MS, env) : Promise.resolve<RunResult>({ stdout: '', stderr: '', code: 1 }),
      run('xdotool', ['getmouselocation', '--shell'], STATUS_TIMEOUT_MS, env),
    ]);
    const screen = parseScreenSize(xr.stdout) || { width: 0, height: 0 };
    base.screen = screen;
    base.displays = [{ index: 0, bounds: { x: 0, y: 0, width: screen.width, height: screen.height }, scale: 1, primary: true }];
    base.cursor = parseMouseLocation(mouse.stdout);

    if (hasXprop) {
      const workarea = await run('xprop', ['-root', '_NET_WORKAREA'], STATUS_TIMEOUT_MS, env);
      base.workarea = parseWorkarea(workarea.stdout);
    }
    const activeId = parseActiveWindow(activeXprop.stdout);
    if (activeId && activeId !== '0x00000000') {
      const name = await run('xdotool', ['getwindowname', toDecimalId(activeId)], STATUS_TIMEOUT_MS, env);
      base.activeWindow = { id: activeId, title: name.stdout.trim() };
    }

    // Shared-display warning: the CDP connectors (Gmail/LinkedIn/WhatsApp) drive a
    // real Chrome on THIS display; synthesized input can steal focus from them.
    // Detect them cheaply by their profile dirs so the caller knows to coordinate.
    const cdp = detectCdpBrowsers();
    if (cdp.length) {
      base.warnings.push(
        `A CDP browser connector is signed in on this display (${cdp.join(', ')}). ` +
          'Desktop input/focus shares the display with it — activating windows or typing can interrupt those connectors (one-writer rule).',
      );
    }

    base.ready = true;
    return base;
  }

  async windows(): Promise<{ displays: DisplayInfo[]; windows: WindowInfo[]; workarea: Rect | null; activeWindow: string | null }> {
    const display = this.requireDisplay();
    const env = displayEnv(display);

    const [wm, xr, activeXprop] = await Promise.all([
      run('wmctrl', ['-l', '-G', '-p', '-x'], WINDOW_TIMEOUT_MS, env),
      run('xrandr', ['--query'], WINDOW_TIMEOUT_MS, env),
      run('xprop', ['-root', '_NET_ACTIVE_WINDOW'], WINDOW_TIMEOUT_MS, env),
    ]);
    if (wm.code !== 0 && !wm.stdout.trim()) {
      throw new DesktopError('WINDOW_ACTION_FAILED', `wmctrl failed to list windows: ${wm.stderr.trim() || `exit ${wm.code}`}`);
    }
    const screen = parseScreenSize(xr.stdout) || { width: 0, height: 0 };
    const displays: DisplayInfo[] = [{ index: 0, bounds: { x: 0, y: 0, width: screen.width, height: screen.height }, scale: 1, primary: true }];
    const activeId = parseActiveWindow(activeXprop.stdout);

    const bare = parseWmctrlWindows(wm.stdout);
    // Fetch per-window state AND geometry in parallel (bounded — window counts
    // are small). 🔴 Geometry comes from xdotool, NOT wmctrl's -G columns: on
    // GNOME/Mutter with GTK client-side decorations, `wmctrl -lG` reports
    // positions 2x off (measured: a window at 300,300 read as 600,600), which
    // would send every click to empty space. xdotool's origin matches the
    // capture + input coordinate space (ground-truthed against a screenshot).
    const windows: WindowInfo[] = await Promise.all(
      bare.map(async (w) => {
        const dec = toDecimalId(w.id);
        const [st, geo] = await Promise.all([
          run('xprop', ['-id', dec, '_NET_WM_STATE'], WINDOW_TIMEOUT_MS, env),
          run('xdotool', ['getwindowgeometry', '--shell', dec], WINDOW_TIMEOUT_MS, env),
        ]);
        const state = parseWindowState(st.stdout, w.id === activeId);
        const bounds = parseWindowGeometry(geo.stdout) ?? w.bounds; // fall back to wmctrl only if xdotool fails
        return { ...w, bounds, display: 0, state };
      }),
    );
    const workareaOut = await run('xprop', ['-root', '_NET_WORKAREA'], WINDOW_TIMEOUT_MS, env);
    return { displays, windows, workarea: parseWorkarea(workareaOut.stdout), activeWindow: activeId };
  }

  async capture(req: CaptureRequest): Promise<RawCapture> {
    const display = this.requireDisplay();
    const env = displayEnv(display);

    // Determine the screen size for the RawCapture header.
    const xr = await run('xrandr', ['--query'], CAPTURE_TIMEOUT_MS, env);
    const screen = parseScreenSize(xr.stdout) || { width: 0, height: 0 };

    // Resolve the capture rectangle.
    let rect: Rect;
    if (req.window) {
      rect = await this.windowRect(req.window, env);
    } else if (req.region) {
      const { x1, y1, x2, y2 } = req.region;
      rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    } else {
      rect = { x: 0, y: 0, width: screen.width, height: screen.height };
    }
    if (rect.width <= 0 || rect.height <= 0) {
      throw new DesktopError('BAD_ARGS', `capture region has non-positive size (${rect.width}x${rect.height})`);
    }

    fs.mkdirSync(DESKTOP_TMP_DIR, { recursive: true });
    const outPath = path.join(DESKTOP_TMP_DIR, `cap-${process.pid}-${Date.now()}.png`);

    const isFull = rect.x === 0 && rect.y === 0 && rect.width === screen.width && rect.height === screen.height;
    const hasScrot = await has('scrot');

    try {
      if (isFull && (await has('ffmpeg'))) {
        // Full-screen: ffmpeg one-shot is fastest (0.15s). Cursor drawn by default.
        const args = ['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', req.cursor ? '1' : '0', '-video_size', `${screen.width}x${screen.height}`, '-i', display, '-frames:v', '1', outPath];
        const r = await run('ffmpeg', args, CAPTURE_TIMEOUT_MS, env);
        if (r.code !== 0 || !fs.existsSync(outPath)) {
          // Fall through to scrot if ffmpeg failed.
          if (!hasScrot) throw new DesktopError('CAPTURE_FAILED', `ffmpeg x11grab failed: ${r.stderr.trim() || `exit ${r.code}`}`);
          await this.scrotCapture(rect, req.cursor, outPath, env);
        }
      } else {
        if (!hasScrot) throw new DesktopError('TOOL_MISSING', 'scrot is required for region/window capture (sudo apt-get install scrot)');
        await this.scrotCapture(rect, req.cursor, outPath, env);
      }
      const png = fs.readFileSync(outPath);
      return { png, capture: rect, screen, display: req.display ?? 0 };
    } finally {
      try { fs.unlinkSync(outPath); } catch { /* best-effort cleanup */ }
    }
  }

  /** scrot region/full capture to a file. `-a X,Y,W,H` for a region, `-p` cursor. */
  private async scrotCapture(rect: Rect, cursor: boolean, outPath: string, env: NodeJS.ProcessEnv): Promise<void> {
    const args = ['-o', '-z'];
    if (cursor) args.push('-p');
    // scrot -a takes X,Y,W,H; for a full grab omit -a (scrot grabs the root).
    args.push('-a', `${rect.x},${rect.y},${rect.width},${rect.height}`, outPath);
    const r = await run('scrot', args, CAPTURE_TIMEOUT_MS, env);
    if (r.code !== 0 || !fs.existsSync(outPath)) {
      throw new DesktopError('CAPTURE_FAILED', `scrot failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
  }

  /** Resolve a window id → its current frame rect via xdotool getwindowgeometry. */
  private async windowRect(id: string, env: NodeJS.ProcessEnv): Promise<Rect> {
    const dec = toDecimalId(id);
    const r = await run('xdotool', ['getwindowgeometry', '--shell', dec], WINDOW_TIMEOUT_MS, env);
    if (r.code !== 0) throw new DesktopError('BAD_WINDOW', `window ${id} not found`);
    const x = r.stdout.match(/^X=(-?\d+)/m);
    const y = r.stdout.match(/^Y=(-?\d+)/m);
    const w = r.stdout.match(/^WIDTH=(\d+)/m);
    const h = r.stdout.match(/^HEIGHT=(\d+)/m);
    if (!x || !y || !w || !h) throw new DesktopError('BAD_WINDOW', `could not read geometry of window ${id}`);
    return { x: parseInt(x[1], 10), y: parseInt(y[1], 10), width: parseInt(w[1], 10), height: parseInt(h[1], 10) };
  }

  async input(req: InputRequest): Promise<InputResult> {
    const display = this.requireDisplay();
    const env = displayEnv(display);
    const { action } = req;

    // cursor_position is a pure read.
    if (action === 'cursor_position') {
      const r = await run('xdotool', ['getmouselocation', '--shell'], INPUT_TIMEOUT_MS, env);
      const cursor = parseMouseLocation(r.stdout);
      return { action, ok: !!cursor, cursor: cursor ?? undefined };
    }

    const mods = req.text && MOUSE_ACTIONS.has(action) ? splitModifiers(req.text) : [];

    switch (action) {
      case 'mouse_move': {
        await this.mustClickCoord(req);
        await run('xdotool', ['mousemove', '--sync', String(req.coordinate![0]), String(req.coordinate![1])], INPUT_TIMEOUT_MS, env);
        return { action, ok: true };
      }
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click': {
        await this.mustClickCoord(req);
        const button = action.startsWith('right') ? '3' : action.startsWith('middle') ? '2' : '1';
        const repeat = action.startsWith('double') ? 2 : action.startsWith('triple') ? 3 : 1;
        await run('xdotool', ['mousemove', '--sync', String(req.coordinate![0]), String(req.coordinate![1])], INPUT_TIMEOUT_MS, env);
        await this.withMods(mods, env, async () => {
          const args = ['click', '--repeat', String(repeat)];
          if (repeat > 1) args.push('--delay', '80');
          args.push(button);
          await run('xdotool', args, INPUT_TIMEOUT_MS, env);
        });
        return { action, ok: true };
      }
      case 'left_mouse_down':
        await run('xdotool', ['mousedown', '1'], INPUT_TIMEOUT_MS, env);
        return { action, ok: true };
      case 'left_mouse_up':
        await run('xdotool', ['mouseup', '1'], INPUT_TIMEOUT_MS, env);
        return { action, ok: true };
      case 'left_click_drag': {
        if (!req.startCoordinate) throw new DesktopError('BAD_ARGS', 'start_coordinate is required for left_click_drag');
        await this.mustClickCoord(req);
        await run('xdotool', ['mousemove', '--sync', String(req.startCoordinate[0]), String(req.startCoordinate[1])], INPUT_TIMEOUT_MS, env);
        await run('xdotool', ['mousedown', '1'], INPUT_TIMEOUT_MS, env);
        await run('xdotool', ['mousemove', '--sync', String(req.coordinate![0]), String(req.coordinate![1])], INPUT_TIMEOUT_MS, env);
        await run('xdotool', ['mouseup', '1'], INPUT_TIMEOUT_MS, env);
        return { action, ok: true };
      }
      case 'scroll': {
        if (!req.scrollDirection) throw new DesktopError('BAD_ARGS', 'scroll_direction is required for scroll');
        const amount = Math.max(0, Math.floor(req.scrollAmount ?? 3));
        // xdotool wheel buttons: 4 up, 5 down, 6 left, 7 right.
        const button = req.scrollDirection === 'up' ? '4' : req.scrollDirection === 'down' ? '5' : req.scrollDirection === 'left' ? '6' : '7';
        if (req.coordinate) await run('xdotool', ['mousemove', '--sync', String(req.coordinate[0]), String(req.coordinate[1])], INPUT_TIMEOUT_MS, env);
        await this.withMods(mods, env, async () => {
          if (amount > 0) await run('xdotool', ['click', '--repeat', String(amount), button], INPUT_TIMEOUT_MS, env);
        });
        return { action, ok: true };
      }
      case 'type': {
        if (typeof req.text !== 'string' || req.text.length === 0) throw new DesktopError('BAD_ARGS', 'text is required for type');
        // Chunk to 50 chars at 12ms/key (reference-impl cadence). xdotool `--` stops flag parsing.
        for (let i = 0; i < req.text.length; i += 50) {
          const chunk = req.text.slice(i, i + 50);
          await run('xdotool', ['type', '--delay', '12', '--', chunk], INPUT_TIMEOUT_MS, env);
        }
        return { action, ok: true };
      }
      case 'key': {
        if (typeof req.text !== 'string' || !req.text.trim()) throw new DesktopError('BAD_ARGS', 'text (the key/combo) is required for key');
        await run('xdotool', ['key', '--', req.text.trim()], INPUT_TIMEOUT_MS, env);
        return { action, ok: true };
      }
      case 'hold_key': {
        if (typeof req.text !== 'string' || !req.text.trim()) throw new DesktopError('BAD_ARGS', 'text (the key to hold) is required for hold_key');
        const seconds = Math.max(0, Math.min(100, req.duration ?? 1));
        const keys = req.text.trim();
        await run('xdotool', ['keydown', '--', keys], INPUT_TIMEOUT_MS, env);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        await run('xdotool', ['keyup', '--', keys], INPUT_TIMEOUT_MS + seconds * 1000, env);
        return { action, ok: true };
      }
      default:
        throw new DesktopError('BAD_ARGS', `unknown input action: ${action}`);
    }
  }

  private async mustClickCoord(req: InputRequest): Promise<void> {
    if (!req.coordinate || req.coordinate.length !== 2 || !req.coordinate.every((n) => Number.isInteger(n) && n >= 0)) {
      throw new DesktopError('BAD_ARGS', `coordinate [x,y] (non-negative ints) is required for ${req.action}`);
    }
  }

  /** Hold modifiers down around an action, release after (for modifier-clicks). */
  private async withMods(mods: string[], env: NodeJS.ProcessEnv, fn: () => Promise<void>): Promise<void> {
    for (const m of mods) await run('xdotool', ['keydown', '--', m], INPUT_TIMEOUT_MS, env);
    try {
      await fn();
    } finally {
      for (const m of mods.slice().reverse()) await run('xdotool', ['keyup', '--', m], INPUT_TIMEOUT_MS, env);
    }
  }

  async windowAction(req: WindowActionRequest): Promise<WindowActionResult> {
    const display = this.requireDisplay();
    const env = displayEnv(display);
    const dec = toDecimalId(req.window);
    let note: string | undefined;

    switch (req.action) {
      case 'activate':
        await run('wmctrl', ['-i', '-a', dec], WINDOW_TIMEOUT_MS, env);
        break;
      case 'close':
        // Polite close (WM_DELETE) — never a process kill.
        await run('wmctrl', ['-i', '-c', dec], WINDOW_TIMEOUT_MS, env);
        break;
      case 'minimize':
        await run('xdotool', ['windowminimize', dec], WINDOW_TIMEOUT_MS, env);
        break;
      case 'maximize':
        await run('wmctrl', ['-i', '-r', dec, '-b', 'add,maximized_vert,maximized_horz'], WINDOW_TIMEOUT_MS, env);
        break;
      case 'restore':
        // Un-maximize AND un-minimize (activate to un-hide).
        await run('wmctrl', ['-i', '-r', dec, '-b', 'remove,maximized_vert,maximized_horz'], WINDOW_TIMEOUT_MS, env);
        await run('wmctrl', ['-i', '-a', dec], WINDOW_TIMEOUT_MS, env);
        break;
      case 'move': {
        if (!Number.isInteger(req.x) || !Number.isInteger(req.y)) throw new DesktopError('BAD_ARGS', 'move requires integer x and y');
        // xdotool windowmove --sync (NOT wmctrl -e): its coordinate space matches
        // getwindowgeometry + capture + input, so a move to (x,y) reads back as
        // (x,y). Un-maximize first — a maximized window ignores geometry.
        await run('wmctrl', ['-i', '-r', dec, '-b', 'remove,maximized_vert,maximized_horz'], WINDOW_TIMEOUT_MS, env);
        await run('xdotool', ['windowmove', '--sync', dec, String(req.x), String(req.y)], WINDOW_TIMEOUT_MS, env);
        break;
      }
      case 'resize': {
        if (!Number.isInteger(req.width) || !Number.isInteger(req.height)) throw new DesktopError('BAD_ARGS', 'resize requires integer width and height');
        await run('wmctrl', ['-i', '-r', dec, '-b', 'remove,maximized_vert,maximized_horz'], WINDOW_TIMEOUT_MS, env);
        await run('xdotool', ['windowsize', '--sync', dec, String(req.width), String(req.height)], WINDOW_TIMEOUT_MS, env);
        break;
      }
      default:
        throw new DesktopError('BAD_ARGS', `unknown window action: ${req.action}`);
    }

    // Re-query to VERIFY the outcome rather than assume it.
    await new Promise((r) => setTimeout(r, 120));
    let resulting: WindowInfo | null = null;
    let verified = false;
    try {
      const all = await this.windows();
      resulting = all.windows.find((w) => w.id === normalizeWindowId(req.window) || toDecimalId(w.id) === dec) ?? null;
      if (req.action === 'close') {
        verified = resulting === null; // gone = closed
      } else if (resulting) {
        verified = verifyWindowAction(req, resulting, all.activeWindow);
      }
      if (req.action === 'close' && resulting !== null) note = 'close request sent (WM_DELETE); the app may be prompting to save.';
    } catch {
      note = 'action ran but re-query failed — outcome UNVERIFIED.';
    }
    return { window: normalizeWindowId(req.window), action: req.action, verified, resulting, note };
  }

  async clipboard(req: ClipboardRequest): Promise<ClipboardResult> {
    const display = this.requireDisplay();
    const env = displayEnv(display);
    if (!(await has('xclip'))) {
      throw new DesktopError('TOOL_MISSING', 'xclip is required for clipboard access on X11 (sudo apt-get install xclip)');
    }
    if (req.mode === 'set') {
      const text = req.text ?? '';
      await runWithInput('xclip', ['-selection', 'clipboard', '-in'], text, INPUT_TIMEOUT_MS, env);
      return { bytes: Buffer.byteLength(text, 'utf-8') };
    }
    // get: -o on an EMPTY clipboard exits non-zero with "target STRING not available" → treat as empty.
    const r = await run('xclip', ['-selection', 'clipboard', '-out'], INPUT_TIMEOUT_MS, env);
    if (r.code !== 0 && !r.stdout) {
      if (/not available|no selection|Error:/i.test(r.stderr)) return { text: '' };
      throw new DesktopError('INPUT_FAILED', `xclip read failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    return { text: r.stdout };
  }

  async processes(req: ProcessQuery): Promise<ProcessInfo[]> {
    // rss is KiB; sort by rss desc so the heaviest processes come first when the
    // list is capped. comm can be truncated by ps — good enough for a name filter.
    const r = await run('ps', ['-eo', 'pid,rss,pcpu,user:20,comm', '--sort=-rss', '--no-headers'], STATUS_TIMEOUT_MS, { ...process.env });
    if (r.code !== 0 && !r.stdout) throw new DesktopError('INPUT_FAILED', `ps failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    let rows = parseProcessList(r.stdout);
    if (req.query) {
      const q = req.query.toLowerCase();
      rows = rows.filter((p) => p.name.toLowerCase().includes(q));
    }
    return rows.slice(0, Math.max(1, req.limit));
  }
}

// ─── standalone helpers ──────────────────────────────────────────────────────

/** Parse `ps -eo pid,rss,pcpu,user:20,comm --no-headers` rows into ProcessInfo. */
export function parseProcessList(out: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      pid: parseInt(m[1], 10),
      memMiB: Math.round((parseInt(m[2], 10) / 1024) * 10) / 10,
      cpu: parseFloat(m[3]),
      user: m[4],
      name: m[5].trim(),
    });
  }
  return rows;
}

/**
 * Spawn a binary and write `input` to its stdin (execFile has no stdin path).
 *
 * 🔴 xclip-shaped tools DAEMONIZE: `xclip -i` reads stdin, then FORKS a background
 * child to keep OWNING the X11 selection (a selection must be held by a live
 * client) and the parent exits. That daemon child inherits stdout/stderr, so a
 * `close` listener (which waits for all stdio to end) NEVER fires and the call
 * hangs forever. So: ignore stdout/stderr (don't hand the daemon our pipes),
 * detach + unref it, and resolve on the PARENT's `exit` — the write is complete
 * once the parent has consumed stdin and forked.
 */
function runWithInput(bin: string, args: string[], input: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      reject(new DesktopError('BACKEND_TIMEOUT', `${bin} did not accept input within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new DesktopError('INPUT_FAILED', `${bin} failed: ${e.message}`)); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) resolve(); // null = parent exited after forking the selection holder
      else reject(new DesktopError('INPUT_FAILED', `${bin} exited ${code}`));
    });
    child.stdin.write(input);
    child.stdin.end();
    child.unref();
  });
}

const MOUSE_ACTIONS = new Set(['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'scroll']);

/** Split a modifier string like "ctrl+shift" into xdotool key names. */
export function splitModifiers(text: string): string[] {
  return text
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((m) => (m.toLowerCase() === 'super' ? 'super' : m));
}

/** Decide whether a re-queried window confirms the requested action. */
export function verifyWindowAction(req: WindowActionRequest, w: WindowInfo, activeWindow: string | null): boolean {
  switch (req.action) {
    case 'activate':
      return activeWindow === w.id || w.state === 'active';
    case 'minimize':
      return w.state === 'minimized';
    case 'maximize':
      return w.state === 'maximized';
    case 'restore':
      return w.state !== 'minimized' && w.state !== 'maximized';
    case 'move':
      return Math.abs(w.bounds.x - (req.x ?? w.bounds.x)) <= 40 && Math.abs(w.bounds.y - (req.y ?? w.bounds.y)) <= 40;
    case 'resize':
      return Math.abs(w.bounds.width - (req.width ?? w.bounds.width)) <= 40 && Math.abs(w.bounds.height - (req.height ?? w.bounds.height)) <= 40;
    default:
      return false;
  }
}

/** Detect signed-in CDP browser connectors by their profile dirs (cheap, sync). */
function detectCdpBrowsers(): string[] {
  const found: string[] = [];
  const dir = path.join(os.homedir(), '.lm-assist');
  for (const [name, sub] of [['Gmail', 'gmail'], ['LinkedIn', 'linkedin'], ['WhatsApp', 'whatsapp']] as const) {
    try {
      if (fs.existsSync(path.join(dir, sub)) || fs.existsSync(path.join(dir, `${sub}-dev`))) found.push(name);
    } catch {
      /* skip */
    }
  }
  return found;
}

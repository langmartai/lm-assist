/**
 * Desktop automation — Windows backend.
 *
 * Drives the interactive Windows desktop through ONE long-lived PowerShell
 * helper (core/scripts/desktop-helper.ps1) speaking JSON-lines over stdio.
 * Why a persistent child: powershell.exe spawn is ~250ms and the Add-Type
 * P/Invoke compile ~1s more (measured on DESKTOP-GDKLATG 2026-08-05) — per-call
 * spawning would put a third of a second of dead time in front of every click.
 * The helper declares PER_MONITOR_AWARE_V2 DPI awareness before ANY geometry
 * call, so every coordinate is PHYSICAL virtual-screen pixels (107 runs 200%
 * scaling; a dpi-unaware process would see 1920x1080 and land clicks 2x off).
 *
 * Discipline learned elsewhere in this repo (singleflight memory): every
 * request has a deadline, and a TIMED-OUT helper is KILLED and respawned —
 * never waited on. A wedged helper must cost one action, not the whole surface.
 *
 * This backend returns NATIVE-RESOLUTION PNG + geometry and typed DesktopError;
 * service.ts owns downscale/crop/encode. No model-facing formatting here.
 *
 * Owned by the win-automation session (node 107) — spec §9. The shared contract
 * (types.ts) is owned by the linux-automation session; report needed changes,
 * never fork.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
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
} from './types';
import {
  DESKTOP_TMP_DIR,
  CAPTURE_TIMEOUT_MS,
  INPUT_TIMEOUT_MS,
  WINDOW_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
} from './config';
import { comboToSteps, holdSteps, modifierSteps } from './win32/keymap';

// ─── helper-process wire types (JSON-lines) ──────────────────────────────────

interface HelperScreen {
  device: string;
  primary: boolean;
  bounds: Rect;
  workingArea: Rect;
  scale: number;
}

interface HelperWindowRow {
  hwnd: number;
  title: string;
  class: string;
  exe: string | null;
  pid: number;
  rect: Rect;
  minimized: boolean;
  maximized: boolean;
}

interface HelperStatusData {
  dpiAware: boolean;
  sessionId: number;
  screens: HelperScreen[];
  virtual: Rect;
  cursor: [number, number] | null;
  foreground: HelperWindowRow | null;
}

interface HelperWindowsData {
  windows: HelperWindowRow[];
  foreground: number;
  screens: HelperScreen[];
  virtual: Rect;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Where the helper script lives: core/dist/desktop → core/scripts. */
function helperScriptPath(): string {
  return path.join(__dirname, '..', '..', 'scripts', 'desktop-helper.ps1');
}

/**
 * The long-lived helper child. Lazily spawned, restarted on death; a request
 * timeout KILLS the child (a helper stuck inside a Win32 call would otherwise
 * wedge every subsequent request behind it — bounded, never unbounded).
 */
class HelperClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private buffer = '';
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** From the hello line — the Windows session the helper (= Core) runs in. */
  sessionId: number | null = null;
  dpiAware = false;

  async request<T>(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
    await this.ensure();
    const proc = this.proc;
    if (!proc) throw new DesktopError('TOOL_MISSING', 'desktop helper process is not running');
    const id = this.nextId++;
    const line = JSON.stringify({ id, cmd, args });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Kill-on-timeout: the helper is single-threaded — a stuck command means
        // every queued command is stuck too. Respawn lazily on the next call.
        this.kill(`helper did not answer "${cmd}" within ${timeoutMs}ms`);
        reject(new DesktopError('BACKEND_TIMEOUT', `desktop helper timed out on ${cmd} after ${timeoutMs}ms (helper restarted)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
      proc.stdin.write(line + '\n', (err) => {
        if (err) {
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            reject(new DesktopError('TOOL_MISSING', `could not write to desktop helper: ${err.message}`));
          }
        }
      });
    });
  }

  private ensure(): Promise<void> {
    if (this.proc) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.spawnHelper().finally(() => (this.starting = null));
    return this.starting;
  }

  private spawnHelper(): Promise<void> {
    const script = helperScriptPath();
    if (!fs.existsSync(script)) {
      return Promise.reject(new DesktopError('TOOL_MISSING', `desktop helper script not found at ${script}`));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      // Hello must arrive fast; Add-Type compile dominates (~1-3s cold).
      const bootTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { proc.kill(); } catch { /* already gone */ }
          reject(new DesktopError('BACKEND_TIMEOUT', 'desktop helper did not start within 20s'));
        }
      }, 20_000);

      proc.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(bootTimer);
          reject(new DesktopError('TOOL_MISSING', `could not spawn powershell.exe: ${err.message}`));
        }
      });
      proc.on('exit', () => {
        if (this.proc === proc) this.proc = null;
        const dead = new DesktopError('INPUT_FAILED', 'desktop helper exited mid-request');
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(dead);
        }
        this.pending.clear();
      });
      proc.stdout.setEncoding('utf-8');
      proc.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue; // stray non-JSON output — ignore
          }
          if (msg.hello) {
            this.sessionId = typeof msg.sessionId === 'number' ? msg.sessionId : null;
            this.dpiAware = !!msg.dpiAware;
            if (!settled) {
              settled = true;
              clearTimeout(bootTimer);
              this.proc = proc;
              resolve();
            }
            continue;
          }
          const p = this.pending.get(msg.id as number);
          if (!p) continue;
          this.pending.delete(msg.id as number);
          clearTimeout(p.timer);
          if (msg.ok) {
            p.resolve(msg.data);
          } else {
            const code = msg.code === 'BAD_WINDOW' || msg.code === 'BAD_ARGS' ? (msg.code as 'BAD_WINDOW' | 'BAD_ARGS') : 'INPUT_FAILED';
            p.reject(new DesktopError(code, String(msg.message ?? 'helper error')));
          }
        }
      });
      // stderr: diagnostics only — keep the last chunk for error context.
      proc.stderr.setEncoding('utf-8');
      proc.stderr.on('data', () => { /* diagnostics; deliberately unbuffered */ });
    });
  }

  kill(reason?: string): void {
    const proc = this.proc;
    this.proc = null;
    this.buffer = '';
    if (proc) {
      try { proc.kill(); } catch { /* already gone */ }
    }
    void reason;
  }
}

// ─── row → contract mapping ──────────────────────────────────────────────────

/** Order displays deterministically: primary first, then by x, then y. */
function orderDisplays(screens: HelperScreen[]): DisplayInfo[] {
  const sorted = screens
    .slice()
    .sort((a, b) => (a.primary === b.primary ? a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y : a.primary ? -1 : 1));
  return sorted.map((s, index) => ({ index, bounds: s.bounds, scale: s.scale, primary: s.primary }));
}

function displayIndexFor(rect: Rect, displays: DisplayInfo[]): number {
  const cx = rect.x + Math.floor(rect.width / 2);
  const cy = rect.y + Math.floor(rect.height / 2);
  for (const d of displays) {
    if (cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height) return d.index;
  }
  return 0;
}

function toWindowInfo(row: HelperWindowRow, foreground: number, displays: DisplayInfo[]): WindowInfo {
  // Priority mirrors the X11 backend: minimized → maximized → active → normal
  // (a maximized foreground window must verify as "maximized").
  let state: WindowState = 'normal';
  if (row.minimized) state = 'minimized';
  else if (row.maximized) state = 'maximized';
  else if (row.hwnd === foreground) state = 'active';
  return {
    id: String(row.hwnd),
    title: row.title,
    app: row.exe || row.class,
    pid: row.pid || null,
    display: displayIndexFor(row.rect, displays),
    workspace: null, // Windows virtual-desktop ordinal needs COM; null per contract
    bounds: row.rect,
    state,
  };
}

/** Accept a decimal HWND string (the surface form). Hex is tolerated. */
function toHwnd(id: string): number {
  const s = id.trim().toLowerCase();
  let n: number;
  if (/^\d+$/.test(s)) n = parseInt(s, 10);
  else if (/^0x[0-9a-f]+$/.test(s)) n = parseInt(s, 16);
  else throw new DesktopError('BAD_WINDOW', `not a window id: ${id}`);
  if (!Number.isFinite(n) || n <= 0) throw new DesktopError('BAD_WINDOW', `not a window id: ${id}`);
  return n;
}

/** Detect signed-in CDP browser connectors by their profile dirs (cheap, sync)
 *  — same one-writer warning the X11 backend raises (107 runs the Gmail
 *  connector's Chrome on this desktop). */
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

const SESSION0_REASON =
  'Core is running in Windows session 0 (service session) — Session 0 isolation hides the interactive ' +
  'desktop, so nothing can be captured or driven. Restart Core via the "LmAssistCoreInteractive" ' +
  'scheduled task so it lands in the logged-on user’s session.';

// ─── the backend ─────────────────────────────────────────────────────────────

export class Win32Backend implements DesktopBackend {
  readonly platform = 'windows' as const;
  private helper = new HelperClient();

  /** Helper answered AND is in an interactive session — or throw. */
  private async requireInteractive(): Promise<void> {
    await this.helper.request('ping', {}, STATUS_TIMEOUT_MS);
    if (this.helper.sessionId === 0) throw new DesktopError('WINDOWS_SESSION0', SESSION0_REASON);
  }

  async status(): Promise<DesktopStatus> {
    const base: DesktopStatus = {
      platform: this.platform,
      ready: false,
      sessionType: 'windows',
      display: '',
      displays: [],
      screen: { width: 0, height: 0 },
      workarea: null,
      activeWindow: null,
      cursor: null,
      backends: {},
      warnings: [],
    };
    let data: HelperStatusData;
    try {
      data = await this.helper.request<HelperStatusData>('status', {}, STATUS_TIMEOUT_MS);
    } catch (e) {
      const err = e as DesktopError;
      return { ...base, reason: `desktop helper unavailable: ${err.message}`, backends: { helper: false } };
    }
    base.backends = { helper: true, dpiAware: data.dpiAware, powershell: true };
    base.displays = orderDisplays(data.screens);
    base.screen = { width: data.virtual.width, height: data.virtual.height };
    base.cursor = data.cursor;
    // Workarea: the primary display's working area (taskbar excluded) — the
    // closest Windows equivalent of the EWMH workarea.
    const primary = data.screens.find((s) => s.primary);
    base.workarea = primary ? primary.workingArea : null;
    if (data.foreground) base.activeWindow = { id: String(data.foreground.hwnd), title: data.foreground.title };

    const cdp = detectCdpBrowsers();
    if (cdp.length) {
      base.warnings.push(
        `A CDP browser connector is signed in on this display (${cdp.join(', ')}). ` +
          'Desktop input/focus shares the display with it — activating windows or typing can interrupt those connectors (one-writer rule).',
      );
    }
    if (!data.dpiAware) {
      base.warnings.push('helper could not declare DPI awareness — coordinates may be scaled on high-DPI displays.');
    }

    if (data.sessionId === 0) {
      return { ...base, ready: false, reason: SESSION0_REASON };
    }
    base.ready = true;
    return base;
  }

  async windows(): Promise<{ displays: DisplayInfo[]; windows: WindowInfo[]; workarea: Rect | null; activeWindow: string | null }> {
    await this.requireInteractive();
    const data = await this.helper.request<HelperWindowsData>('windows', {}, WINDOW_TIMEOUT_MS);
    const displays = orderDisplays(data.screens);
    const windows = data.windows.map((row) => toWindowInfo(row, data.foreground, displays));
    const primary = data.screens.find((s) => s.primary);
    return {
      displays,
      windows,
      workarea: primary ? primary.workingArea : null,
      activeWindow: data.foreground ? String(data.foreground) : null,
    };
  }

  async capture(req: CaptureRequest): Promise<RawCapture> {
    await this.requireInteractive();

    // Resolve the capture rectangle (virtual-screen px; negatives legal).
    const data = await this.helper.request<HelperStatusData>('status', {}, STATUS_TIMEOUT_MS);
    const displays = orderDisplays(data.screens);
    const screen = { width: data.virtual.width, height: data.virtual.height };

    let rect: Rect;
    let displayIndex = 0;
    if (req.window) {
      const all = await this.helper.request<HelperWindowsData>('windows', {}, WINDOW_TIMEOUT_MS);
      const hwnd = toHwnd(req.window);
      const row = all.windows.find((w) => w.hwnd === hwnd);
      if (!row) throw new DesktopError('BAD_WINDOW', `window ${req.window} not found`);
      rect = row.rect;
      displayIndex = displayIndexFor(rect, displays);
    } else if (req.region) {
      rect = { x: req.region.x1, y: req.region.y1, width: req.region.x2 - req.region.x1, height: req.region.y2 - req.region.y1 };
      displayIndex = displayIndexFor(rect, displays);
    } else {
      const d = displays.find((x) => x.index === (req.display ?? 0)) ?? displays[0];
      if (!d) throw new DesktopError('CAPTURE_FAILED', 'no display found to capture');
      rect = d.bounds;
      displayIndex = d.index;
    }
    if (rect.width <= 0 || rect.height <= 0) {
      throw new DesktopError('BAD_ARGS', `capture region has non-positive size (${rect.width}x${rect.height})`);
    }

    fs.mkdirSync(DESKTOP_TMP_DIR, { recursive: true });
    const outPath = path.join(DESKTOP_TMP_DIR, `cap-${process.pid}-${Date.now()}.png`);
    try {
      await this.helper.request('capture', { x: rect.x, y: rect.y, w: rect.width, h: rect.height, cursor: req.cursor, path: outPath }, CAPTURE_TIMEOUT_MS);
      const png = fs.readFileSync(outPath);
      return { png, capture: rect, screen, display: displayIndex };
    } catch (e) {
      if (e instanceof DesktopError) throw e;
      throw new DesktopError('CAPTURE_FAILED', `capture failed: ${(e as Error).message}`);
    } finally {
      try { fs.unlinkSync(outPath); } catch { /* best-effort cleanup */ }
    }
  }

  async input(req: InputRequest): Promise<InputResult> {
    await this.requireInteractive();
    const { action } = req;

    if (action === 'cursor_position') {
      const data = await this.helper.request<{ cursor: [number, number] }>('getcursor', {}, INPUT_TIMEOUT_MS);
      return { action, ok: !!data.cursor, cursor: data.cursor };
    }

    const mods = req.text && MOUSE_ACTIONS.has(action) ? req.text : undefined;

    switch (action) {
      case 'mouse_move': {
        this.mustCoord(req);
        await this.helper.request('mousemove', { x: req.coordinate![0], y: req.coordinate![1] }, INPUT_TIMEOUT_MS);
        return { action, ok: true };
      }
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click': {
        this.mustCoord(req);
        const button = action.startsWith('right') ? 'right' : action.startsWith('middle') ? 'middle' : 'left';
        const count = action.startsWith('double') ? 2 : action.startsWith('triple') ? 3 : 1;
        await this.helper.request('mousemove', { x: req.coordinate![0], y: req.coordinate![1] }, INPUT_TIMEOUT_MS);
        await this.withMods(mods, async () => {
          await this.helper.request('mousebtn', { button, event: 'click', count }, INPUT_TIMEOUT_MS);
        });
        return { action, ok: true };
      }
      case 'left_mouse_down':
        await this.helper.request('mousebtn', { button: 'left', event: 'down' }, INPUT_TIMEOUT_MS);
        return { action, ok: true };
      case 'left_mouse_up':
        await this.helper.request('mousebtn', { button: 'left', event: 'up' }, INPUT_TIMEOUT_MS);
        return { action, ok: true };
      case 'left_click_drag': {
        if (!req.startCoordinate) throw new DesktopError('BAD_ARGS', 'start_coordinate is required for left_click_drag');
        this.mustCoord(req);
        await this.helper.request('mousemove', { x: req.startCoordinate[0], y: req.startCoordinate[1] }, INPUT_TIMEOUT_MS);
        await this.helper.request('mousebtn', { button: 'left', event: 'down' }, INPUT_TIMEOUT_MS);
        await sleep(60);
        // A mid-point step helps apps that ignore teleport-drags.
        const mx = Math.round((req.startCoordinate[0] + req.coordinate![0]) / 2);
        const my = Math.round((req.startCoordinate[1] + req.coordinate![1]) / 2);
        await this.helper.request('mousemove', { x: mx, y: my }, INPUT_TIMEOUT_MS);
        await sleep(30);
        await this.helper.request('mousemove', { x: req.coordinate![0], y: req.coordinate![1] }, INPUT_TIMEOUT_MS);
        await sleep(30);
        await this.helper.request('mousebtn', { button: 'left', event: 'up' }, INPUT_TIMEOUT_MS);
        return { action, ok: true };
      }
      case 'scroll': {
        if (!req.scrollDirection) throw new DesktopError('BAD_ARGS', 'scroll_direction is required for scroll');
        const amount = Math.max(0, Math.floor(req.scrollAmount ?? 3));
        if (req.coordinate) await this.helper.request('mousemove', { x: req.coordinate[0], y: req.coordinate[1] }, INPUT_TIMEOUT_MS);
        const axis = req.scrollDirection === 'left' || req.scrollDirection === 'right' ? 'h' : 'v';
        // Wheel sign: vertical up = +120; horizontal right = +120.
        const sign = req.scrollDirection === 'up' || req.scrollDirection === 'right' ? 1 : -1;
        await this.withMods(mods, async () => {
          for (let i = 0; i < amount; i++) {
            await this.helper.request('wheel', { axis, delta: sign * 120 }, INPUT_TIMEOUT_MS);
          }
        });
        return { action, ok: true };
      }
      case 'type': {
        if (typeof req.text !== 'string' || req.text.length === 0) throw new DesktopError('BAD_ARGS', 'text is required for type');
        // 50-char chunks (reference-impl cadence); each chunk is one helper call
        // so a timeout can only eat one chunk, not the whole paste.
        for (let i = 0; i < req.text.length; i += 50) {
          const chunk = req.text.slice(i, i + 50);
          await this.helper.request('typetext', { text: chunk }, INPUT_TIMEOUT_MS);
        }
        return { action, ok: true };
      }
      case 'key': {
        if (typeof req.text !== 'string' || !req.text.trim()) throw new DesktopError('BAD_ARGS', 'text (the key/combo) is required for key');
        const steps = comboToSteps(req.text.trim());
        await this.helper.request('keyseq', { steps }, INPUT_TIMEOUT_MS);
        return { action, ok: true };
      }
      case 'hold_key': {
        if (typeof req.text !== 'string' || !req.text.trim()) throw new DesktopError('BAD_ARGS', 'text (the key to hold) is required for hold_key');
        const seconds = Math.max(0, Math.min(100, req.duration ?? 1));
        await this.helper.request('keyseq', { steps: holdSteps(req.text.trim(), true) }, INPUT_TIMEOUT_MS);
        await sleep(seconds * 1000);
        await this.helper.request('keyseq', { steps: holdSteps(req.text.trim(), false) }, INPUT_TIMEOUT_MS);
        return { action, ok: true };
      }
      default:
        throw new DesktopError('BAD_ARGS', `unknown input action: ${action}`);
    }
  }

  private mustCoord(req: InputRequest): void {
    if (!req.coordinate || req.coordinate.length !== 2 || !req.coordinate.every((n) => Number.isInteger(n))) {
      throw new DesktopError('BAD_ARGS', `coordinate [x,y] (two integers) is required for ${req.action}`);
    }
  }

  /** Hold click/scroll modifiers around an action, always released. */
  private async withMods(modText: string | undefined, fn: () => Promise<void>): Promise<void> {
    if (!modText) return fn();
    const downs = modifierSteps(modText, true);
    const ups = modifierSteps(modText, false);
    await this.helper.request('keyseq', { steps: downs }, INPUT_TIMEOUT_MS);
    try {
      await fn();
    } finally {
      await this.helper.request('keyseq', { steps: ups }, INPUT_TIMEOUT_MS).catch(() => {
        // A stuck modifier is worse than a lost release-error — kill the helper
        // so its next spawn starts with a clean keyboard state.
        this.helper.kill('modifier release failed');
      });
    }
  }

  async windowAction(req: WindowActionRequest): Promise<WindowActionResult> {
    await this.requireInteractive();
    const hwnd = toHwnd(req.window);
    let note: string | undefined;

    await this.helper.request('window', { hwnd, action: req.action, x: req.x, y: req.y, width: req.width, height: req.height }, WINDOW_TIMEOUT_MS);

    // Re-query to VERIFY the outcome rather than assume it (contract).
    await sleep(150);
    let resulting: WindowInfo | null = null;
    let verified = false;
    try {
      const all = await this.windows();
      resulting = all.windows.find((w) => w.id === String(hwnd)) ?? null;
      if (req.action === 'close') {
        verified = resulting === null; // gone = closed
        if (!verified) note = 'close request sent (WM_CLOSE); the app may be prompting to save.';
      } else if (resulting) {
        verified = verifyWin32WindowAction(req, resulting, all.activeWindow);
      }
    } catch {
      note = 'action ran but re-query failed — outcome UNVERIFIED.';
    }
    return { window: String(hwnd), action: req.action, verified, resulting, note };
  }
}

// ─── standalone helpers (exported for tests) ─────────────────────────────────

const MOUSE_ACTIONS = new Set(['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'scroll']);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Decide whether a re-queried window confirms the requested action — same
 *  thresholds as the X11 backend (40px slack: WMs adjust a little). */
export function verifyWin32WindowAction(req: WindowActionRequest, w: WindowInfo, activeWindow: string | null): boolean {
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

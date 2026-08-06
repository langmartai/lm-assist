/**
 * Desktop automation MCP tools — cross-platform desktop control.
 *
 * Five tools: desktop_status, desktop_windows, desktop_screenshot (reads);
 * desktop_window, desktop_input (writes). Each wraps this node's own /desktop/*
 * REST route on loopback (single source of truth) so the same behavior serves
 * stdio MCP, HTTP /mcp, and the hub relay. Works on any node with a real desktop
 * — X11 today, Windows when the win-automation backend ships.
 *
 * 🔴 IMAGE RETURN: desktop_screenshot returns a REAL MCP image content block
 * ({type:'image', data:<base64>, mimeType}) after a leading text block. This is
 * why this file types its results against configure.ts's McpToolResult (which has
 * data/mimeType) rather than _passthrough's text-only shape. The central result
 * cap passes image blocks through untruncated (result-cap.ts), and the hub relays
 * them as-is. The text block leads so the origin footer can attach.
 *
 * The input action vocabulary mirrors Anthropic's computer-use tool verbatim
 * (left_click / type / key / scroll / left_click_drag / …) so the models are on
 * familiar ground; coordinates are a single [x,y] `coordinate` array (not x/y
 * fields), durations are seconds, zoom is via desktop_screenshot's `region`.
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts),
 * scoped in configure.ts TOOL_SCOPES, catalogued in registry/catalog.ts, budgeted
 * in tool-output-budget.ts.
 *
 * NOTE ON LENGTH: every byte of these descriptions is multiplied by the whole
 * advertised tool count at connect time. Keep the trigger words; cut the rest.
 */

import { err, workerGet, workerPostRaw } from './_passthrough';
import type { McpToolResult } from '../configure';

// ─── tool defs ───────────────────────────────────────────────────────────────

export const desktopStatusToolDef = {
  name: 'desktop_status',
  description:
    'Desktop control readiness on this node: platform, whether the desktop is driveable, display size, active ' +
    'window, warnings. Call FIRST; if ready is false the reason says what to fix. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const desktopWindowsToolDef = {
  name: 'desktop_windows',
  description:
    'List the desktop windows: id, title, app, pid, geometry, state, plus displays + workarea. Trigger words: ' +
    '"what windows are open", "list windows". Use a returned id with desktop_screenshot/window/input. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const desktopScreenshotToolDef = {
  name: 'desktop_screenshot',
  description:
    'See the desktop as an image. No args = full-screen overview (downscaled). To READ small text, pass ' +
    'region:[x1,y1,x2,y2] to zoom that rectangle at native resolution (overview first, then zoom — how you ' +
    '"scroll" a big screen). Trigger words: "screenshot", "what is on screen", "read that dialog", "zoom in". ' +
    'The result states the image→desktop pixel mapping so click coordinates are correct. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      region: {
        type: 'array' as const,
        items: { type: 'number' as const },
        description: 'Zoom rectangle [x1,y1,x2,y2] in desktop pixels (top-left, bottom-right). Returned at native resolution for legibility.',
      },
      window: { type: 'string' as const, description: 'Capture this window id (from desktop_windows) instead of the whole screen. Activate it first for an unobscured view.' },
      max_px: { type: 'number' as const, description: 'Long-edge cap of the returned image (default 1568; up to 2576). Lower = smaller/cheaper, higher = more detail.' },
      format: { type: 'string' as const, enum: ['png', 'jpeg'], description: 'Default: png for small zoom regions (crisp), jpeg for large overviews (small).' },
      cursor: { type: 'boolean' as const, description: 'Draw the mouse pointer (default true).' },
    },
  },
};

export const desktopWindowToolDef = {
  name: 'desktop_window',
  description:
    'Manage one desktop window (activate/close/minimize/maximize/restore/move/resize). move needs x,y; resize ' +
    'needs width,height (desktop px). Trigger words: "focus that window", "maximize", "close the window", "move it". ' +
    'close is a polite WM close (no process kill). Needs a window id; the result re-queries and reports VERIFIED.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      window: { type: 'string' as const, description: 'Window id from desktop_windows.' },
      action: { type: 'string' as const, enum: ['activate', 'close', 'minimize', 'maximize', 'restore', 'move', 'resize'] },
      x: { type: 'number' as const, description: 'move: new left (desktop px).' },
      y: { type: 'number' as const, description: 'move: new top (desktop px).' },
      width: { type: 'number' as const, description: 'resize: new width (px).' },
      height: { type: 'number' as const, description: 'resize: new height (px).' },
    },
    required: ['window', 'action'],
  },
};

export const desktopInputToolDef = {
  name: 'desktop_input',
  description:
    'Pointer + keyboard input, computer-use vocabulary (clicks, mouse_move, type, key, hold_key, scroll, drag — ' +
    'see the action enum). Clicks/move/scroll take coordinate:[x,y] desktop pixels from a desktop_screenshot. type ' +
    'takes text; key/hold_key take an xdotool combo ("ctrl+s","Return","alt+Tab"); a click may hold a modifier via ' +
    'text ("shift"). type/key go to the FOCUSED window — pass window to activate it first. screenshot_after_ms ' +
    'returns a screenshot after the action to verify it. Trigger words: "click", "type", "press", "scroll", "drag".',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string' as const,
        enum: ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'mouse_move', 'type', 'key', 'hold_key', 'scroll', 'cursor_position'],
      },
      coordinate: { type: 'array' as const, items: { type: 'number' as const }, description: '[x,y] desktop pixels. Required for clicks, mouse_move, drag end, scroll anchor.' },
      start_coordinate: { type: 'array' as const, items: { type: 'number' as const }, description: 'left_click_drag origin [x,y].' },
      text: { type: 'string' as const, description: 'type: the text. key/hold_key: the combo. click/scroll: a held modifier (shift/ctrl/alt/super).' },
      scroll_direction: { type: 'string' as const, enum: ['up', 'down', 'left', 'right'] },
      scroll_amount: { type: 'number' as const, description: 'scroll: wheel clicks (default 3).' },
      duration: { type: 'number' as const, description: 'hold_key: seconds to hold (0–100).' },
      window: { type: 'string' as const, description: 'Activate this window id first (convenience, so type/key land where you mean).' },
      screenshot_after_ms: { type: 'number' as const, description: 'After the action, wait this many ms and return a screenshot (0–10000).' },
    },
    required: ['action'],
  },
};

export const desktopClipboardToolDef = {
  name: 'desktop_clipboard',
  description:
    'Read or write the system clipboard on a node. mode "get" returns the current clipboard text; mode "set" ' +
    'puts text on it. Trigger words: "copy that", "what is on the clipboard", "paste this". PREFER set + a ' +
    'ctrl+v (desktop_input key) over typing long/special text — it is exact and dodges keystroke glitches.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string' as const, enum: ['get', 'set'] },
      text: { type: 'string' as const, description: 'set only: the text to place on the clipboard.' },
    },
    required: ['mode'],
  },
};

export const desktopProcessToolDef = {
  name: 'desktop_process',
  description:
    'List running processes on a node (pid, name, cpu%, memory, user), heaviest first. Pass query to filter by ' +
    'name substring. Trigger words: "what is running", "list processes", "is X running", "find the chrome process". ' +
    'Read-only — it does not kill anything. Cross-node with node=<host>.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string' as const, description: 'Case-insensitive name substring to filter by (e.g. "chrome").' },
      limit: { type: 'number' as const, description: 'Max rows (default 50, the ceiling).' },
    },
  },
};

export const desktopWaitForToolDef = {
  name: 'desktop_wait_for',
  description:
    'Wait until a window matching title and/or app appears (optionally in a given state), or the timeout elapses. ' +
    'Use after launching/switching an app instead of guessing a sleep. Trigger words: "wait for the window", ' +
    '"until X opens". Returns the matched window (with its id/geometry) or found:false on timeout. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' as const, description: 'Case-insensitive substring of the window title to wait for.' },
      app: { type: 'string' as const, description: 'Case-insensitive substring of the app/WM_CLASS to wait for.' },
      state: { type: 'string' as const, enum: ['active', 'minimized', 'maximized', 'normal'], description: 'Also require this window state.' },
      timeout_ms: { type: 'number' as const, description: 'Give up after this many ms (default 10000, max 60000).' },
    },
  },
};

export const desktopFindTextToolDef = {
  name: 'desktop_find_text',
  description:
    'OCR the screen (or region/window) → the visible TEXT lines with each one\'s click-center in desktop pixels. ' +
    'query filters to lines containing it. Locate a menu item / button / link by its LABEL instead of guessing ' +
    'pixels, then click its center (or use desktop_click_text). Trigger: "where does it say X", "read the screen". Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string' as const, description: 'Case-insensitive substring to filter recognized lines by (omit to get all text).' },
      region: { type: 'array' as const, items: { type: 'number' as const }, description: 'OCR only this rectangle [x1,y1,x2,y2] (desktop px). Default: whole screen.' },
      window: { type: 'string' as const, description: 'OCR this window id (from desktop_windows) instead of the screen.' },
      min_confidence: { type: 'number' as const, description: 'Drop text below this OCR confidence 0-100 (default 50).' },
    },
  },
};

export const desktopClickTextToolDef = {
  name: 'desktop_click_text',
  description:
    'Click an on-screen element BY ITS VISIBLE TEXT (button/menu item/link) — re-OCRs fresh then clicks the match ' +
    'center, so the coordinate never goes stale. Trigger: "click the X button", "press Save". index disambiguates ' +
    'multiple matches; match:"exact" = whole-line equals text; screenshot_after_ms verifies. No match → lists what was seen.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string' as const, description: 'The visible label to click.' },
      index: { type: 'number' as const, description: 'Which match when several contain the text (default 0 = first in reading order).' },
      match: { type: 'string' as const, enum: ['substring', 'exact'], description: 'Default substring (case-insensitive); exact requires the whole line to equal text.' },
      button: { type: 'string' as const, enum: ['left', 'right', 'middle'], description: 'Default left.' },
      double: { type: 'boolean' as const, description: 'Double-click instead of single (left only).' },
      window: { type: 'string' as const, description: 'Scope OCR to this window id and activate it first.' },
      screenshot_after_ms: { type: 'number' as const, description: 'After clicking, wait this many ms and return a screenshot (0-10000).' },
    },
    required: ['text'],
  },
};

// ─── handlers ────────────────────────────────────────────────────────────────

interface StatusData {
  platform: string; ready: boolean; reason?: string; sessionType: string; display: string;
  screen: { width: number; height: number }; displays: unknown[];
  activeWindow: { id: string; title: string } | null; cursor: [number, number] | null;
  backends: Record<string, unknown>; warnings: string[];
}

async function handleStatus(): Promise<McpToolResult> {
  try {
    const d = await workerGet<StatusData>('/desktop/status');
    const lines = [
      `Desktop control on this node — ${d.ready ? 'READY' : 'NOT READY'}`,
      `  platform:  ${d.platform} (${d.sessionType}${d.display ? `, ${d.display}` : ''})`,
      `  screen:    ${d.screen.width}x${d.screen.height} · ${d.displays.length} display(s)`,
      `  active:    ${d.activeWindow ? `${d.activeWindow.title} (${d.activeWindow.id})` : '(none)'}`,
      `  cursor:    ${d.cursor ? `[${d.cursor[0]}, ${d.cursor[1]}]` : '(unknown)'}`,
      `  backends:  ${Object.entries(d.backends).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    ];
    if (!d.ready && d.reason) lines.push('', `Not ready: ${d.reason}`);
    for (const w of d.warnings || []) lines.push('', `⚠️  ${w}`);
    if (d.ready) lines.push('', 'Use desktop_windows to list windows, desktop_screenshot to see the screen, desktop_input to click/type.');
    return textResult(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface WindowsData {
  displays: { index: number; bounds: { x: number; y: number; width: number; height: number }; primary: boolean }[];
  windows: { id: string; title: string; app: string; pid: number | null; display: number; bounds: { x: number; y: number; width: number; height: number }; state: string }[];
  workarea: { x: number; y: number; width: number; height: number } | null;
  activeWindow: string | null;
  truncated: boolean;
}

async function handleWindows(): Promise<McpToolResult> {
  try {
    const d = await workerGet<WindowsData>('/desktop/windows');
    const lines = [`${d.windows.length} window(s)${d.truncated ? ' (truncated to the cap — narrow with desktop_status/app)' : ''}:`];
    for (const w of d.windows) {
      const active = w.id === d.activeWindow ? ' *ACTIVE*' : '';
      lines.push(`  ${w.id}  ${w.bounds.width}x${w.bounds.height}+${w.bounds.x}+${w.bounds.y}  [${w.state}]  ${w.app}  — ${w.title}${active}`);
    }
    if (d.workarea) lines.push('', `workarea: ${d.workarea.width}x${d.workarea.height}+${d.workarea.x}+${d.workarea.y}  ·  displays: ${d.displays.map((x) => `${x.bounds.width}x${x.bounds.height}`).join(', ')}`);
    return textResult(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface ScreenshotData {
  meta: {
    platform: string; display: number; screen: { width: number; height: number };
    capture: { x: number; y: number; width: number; height: number };
    image: { width: number; height: number }; scale: number; format: 'png' | 'jpeg'; cursor: boolean; mapping: string;
  };
  base64: string;
  mimeType: string;
}

async function handleScreenshot(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const body: Record<string, unknown> = {};
    if (Array.isArray(args.region)) body.region = args.region;
    if (typeof args.window === 'string') body.window = args.window;
    if (typeof args.max_px === 'number') body.max_px = args.max_px;
    if (args.format === 'png' || args.format === 'jpeg') body.format = args.format;
    if (typeof args.cursor === 'boolean') body.cursor = args.cursor;
    const resp = await workerPostRaw('/desktop/screenshot', body);
    if (resp.success === false) {
      const bits = [`desktop_screenshot failed: ${String(resp.error || 'unknown error')}`];
      if (resp.code) bits.push(`(${String(resp.code)})`);
      return err(bits.join(' '));
    }
    const d = (resp.data || {}) as ScreenshotData;
    const m = d.meta;
    const caption =
      `Screenshot (${m.platform}) — captured ${m.capture.width}x${m.capture.height} at desktop (${m.capture.x},${m.capture.y}) ` +
      `on a ${m.screen.width}x${m.screen.height} screen; returned ${m.image.width}x${m.image.height} ${m.format} (scale ${m.scale.toFixed(4)}). ` +
      m.mapping;
    // Lead with the text block (so the origin footer attaches) then the image.
    return {
      content: [
        { type: 'text', text: caption },
        { type: 'image', data: d.base64, mimeType: d.mimeType },
      ],
    };
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface WindowActionData {
  window: string; action: string; verified: boolean;
  resulting: { id: string; title: string; state: string; bounds: { x: number; y: number; width: number; height: number } } | null;
  note?: string;
}

async function handleWindow(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const resp = await workerPostRaw('/desktop/window', {
      window: args.window, action: args.action, x: args.x, y: args.y, width: args.width, height: args.height,
    });
    if (resp.success === false) return err(`desktop_window failed: ${String(resp.error || 'unknown')}${resp.code ? ` (${String(resp.code)})` : ''}`);
    const d = (resp.data || {}) as WindowActionData;
    const verdict = d.verified ? 'VERIFIED' : 'UNVERIFIED';
    const lines = [`${d.action} on ${d.window} — ${verdict}`];
    if (d.resulting) lines.push(`  now: [${d.resulting.state}] ${d.resulting.bounds.width}x${d.resulting.bounds.height}+${d.resulting.bounds.x}+${d.resulting.bounds.y}  — ${d.resulting.title}`);
    else if (d.action === 'close' && d.verified) lines.push('  window is gone.');
    if (d.note) lines.push('', d.note);
    return textResult(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface InputData {
  result: { action: string; ok: boolean; cursor?: [number, number]; detail?: string };
  screenshot?: ScreenshotData;
}

async function handleInput(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const resp = await workerPostRaw('/desktop/input', {
      action: args.action, coordinate: args.coordinate, start_coordinate: args.start_coordinate,
      text: args.text, scroll_direction: args.scroll_direction, scroll_amount: args.scroll_amount,
      duration: args.duration, window: args.window, screenshot_after_ms: args.screenshot_after_ms,
    });
    if (resp.success === false) return err(`desktop_input failed: ${String(resp.error || 'unknown')}${resp.code ? ` (${String(resp.code)})` : ''}`);
    const d = (resp.data || {}) as InputData;
    const r = d.result;
    let head = `${r.action}: ${r.ok ? 'ok' : 'FAILED'}`;
    if (r.action === 'cursor_position' && r.cursor) head += ` — cursor at [${r.cursor[0]}, ${r.cursor[1]}]`;
    if (r.detail) head += ` — ${r.detail}`;
    if (d.screenshot) {
      const m = d.screenshot.meta;
      return {
        content: [
          { type: 'text', text: `${head}\nScreenshot after action — ${m.image.width}x${m.image.height} ${m.format}. ${m.mapping}` },
          { type: 'image', data: d.screenshot.base64, mimeType: d.screenshot.mimeType },
        ],
      };
    }
    return textResult(head);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface ClipboardData { mode: 'get' | 'set'; text?: string; bytes?: number }
async function handleClipboard(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const resp = await workerPostRaw('/desktop/clipboard', { mode: args.mode, text: args.text });
    if (resp.success === false) return err(`desktop_clipboard failed: ${String(resp.error || 'unknown')}${resp.code ? ` (${String(resp.code)})` : ''}`);
    const d = (resp.data || {}) as ClipboardData;
    if (d.mode === 'set') return textResult(`Clipboard set (${d.bytes ?? 0} bytes). Tip: desktop_input key "ctrl+v" pastes it into the focused window.`);
    const t = d.text ?? '';
    return textResult(t ? `Clipboard contains (${Buffer.byteLength(t, 'utf-8')} bytes):\n${t}` : 'Clipboard is empty (or holds non-text content).');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface ProcData { query: string | null; total: number; processes: { pid: number; name: string; cpu?: number; memMiB?: number; user?: string }[] }
async function handleProcess(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const q = new URLSearchParams();
    if (typeof args.query === 'string' && args.query.trim()) q.set('query', args.query.trim());
    if (typeof args.limit === 'number') q.set('limit', String(args.limit));
    const d = await workerGet<ProcData>(`/desktop/process${q.toString() ? `?${q}` : ''}`);
    const lines = [`${d.total} process(es)${d.query ? ` matching "${d.query}"` : ''} (heaviest first):`];
    for (const p of d.processes) lines.push(`  ${String(p.pid).padStart(7)}  ${(p.memMiB ?? 0).toFixed(0).padStart(6)}MiB  ${(p.cpu ?? 0).toFixed(1).padStart(5)}%  ${p.user ?? ''}  ${p.name}`);
    return textResult(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface WaitData { found: boolean; waitedMs: number; window: { id: string; title: string; app: string; state: string; bounds: { x: number; y: number; width: number; height: number } } | null }
async function handleWaitFor(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const resp = await workerPostRaw('/desktop/wait', { title: args.title, app: args.app, state: args.state, timeout_ms: args.timeout_ms });
    if (resp.success === false) return err(`desktop_wait_for failed: ${String(resp.error || 'unknown')}${resp.code ? ` (${String(resp.code)})` : ''}`);
    const d = (resp.data || {}) as WaitData;
    if (!d.found) return textResult(`Timed out after ${d.waitedMs}ms — no matching window appeared.`);
    const w = d.window!;
    return textResult(`Found after ${d.waitedMs}ms: ${w.id} [${w.state}] ${w.bounds.width}x${w.bounds.height}+${w.bounds.x}+${w.bounds.y} ${w.app} — ${w.title}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface OcrMatchRow { text: string; confidence: number; bounds: { x: number; y: number; width: number; height: number }; center: [number, number] }
interface FindTextData { screen: { width: number; height: number }; capture: { x: number; y: number; width: number; height: number }; total: number; truncated: boolean; matches: OcrMatchRow[] }
async function handleFindText(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const resp = await workerPostRaw('/desktop/find-text', {
      query: args.query, region: args.region, window: args.window, min_confidence: args.min_confidence,
    });
    if (resp.success === false) return err(`desktop_find_text failed: ${String(resp.error || 'unknown')}${resp.code ? ` (${String(resp.code)})` : ''}`);
    const d = (resp.data || {}) as FindTextData;
    const lines = [`${d.total} text line(s)${d.truncated ? ' (capped)' : ''}${args.query ? ` matching "${String(args.query)}"` : ''} — center is where to click:`];
    for (const m of d.matches) lines.push(`  [${String(m.confidence).padStart(3)}%] (${m.center[0]},${m.center[1]})  "${m.text}"`);
    return textResult(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface ClickTextData { clicked: { text: string; center: [number, number] }; candidates: number; index: number; screenshot?: ScreenshotData }
async function handleClickText(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const resp = await workerPostRaw('/desktop/click-text', {
      text: args.text, index: args.index, match: args.match, button: args.button, double: args.double, window: args.window, screenshot_after_ms: args.screenshot_after_ms,
    });
    if (resp.success === false) return err(`desktop_click_text failed: ${String(resp.error || 'unknown')}${resp.code ? ` (${String(resp.code)})` : ''}`);
    const d = (resp.data || {}) as ClickTextData;
    const head = `Clicked "${d.clicked.text}" at (${d.clicked.center[0]},${d.clicked.center[1]})${d.candidates > 1 ? ` — match ${d.index + 1} of ${d.candidates}` : ''}`;
    if (d.screenshot) {
      const m = d.screenshot.meta;
      return { content: [
        { type: 'text', text: `${head}\nScreenshot after click — ${m.image.width}x${m.image.height} ${m.format}. ${m.mapping}` },
        { type: 'image', data: d.screenshot.base64, mimeType: d.screenshot.mimeType },
      ] };
    }
    return textResult(head);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/** Wrap text as a successful MCP result typed against configure's McpToolResult. */
function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

// ─── exports ──────────────────────────────────────────────────────────────────

export const DESKTOP_TOOL_DEFS = [
  desktopStatusToolDef,
  desktopWindowsToolDef,
  desktopScreenshotToolDef,
  desktopWindowToolDef,
  desktopInputToolDef,
  desktopClipboardToolDef,
  desktopProcessToolDef,
  desktopWaitForToolDef,
  desktopFindTextToolDef,
  desktopClickTextToolDef,
];

export const DESKTOP_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  desktop_status: () => handleStatus(),
  desktop_windows: () => handleWindows(),
  desktop_screenshot: handleScreenshot,
  desktop_window: handleWindow,
  desktop_input: handleInput,
  desktop_clipboard: handleClipboard,
  desktop_process: handleProcess,
  desktop_wait_for: handleWaitFor,
  desktop_find_text: handleFindText,
  desktop_click_text: handleClickText,
};

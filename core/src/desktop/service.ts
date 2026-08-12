/**
 * Desktop automation — THE single import surface (gmail cdp-client pattern).
 *
 * Routes and MCP tools import from HERE and nowhere else. This module:
 *   - selects the platform backend (X11 today; Win32 when 107 ships it),
 *   - VALIDATES caller arguments (the computer-use validation semantics),
 *   - runs the sharp image pipeline (crop already done by the backend region;
 *     downscale to max_px, choose PNG vs JPEG, enforce the byte ceiling),
 *   - serializes desktop WRITES behind a bounded single-flight mutex,
 *   - owns the one coordinate-mapping sentence every screenshot result carries.
 *
 * A backend command (xdotool flag, PowerShell shim) must never appear here; a
 * model-facing string must never appear in a backend.
 */

import sharp from 'sharp';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  DesktopBackend,
  DesktopError,
  DesktopInputAction,
  DesktopStatus,
  DisplayInfo,
  InputRequest,
  InputResult,
  OcrMatch,
  ProcessInfo,
  Rect,
  ScrollDirection,
  WindowAction,
  WindowActionResult,
  WindowInfo,
} from './types';
import { DESKTOP_TMP_DIR } from './config';
import { autoDetectLang, ensureBase, ensureLang, isValidLangCode, LM_TESSDATA } from './ocr-lang';
import { X11Backend } from './x11-backend';
import { Win32Backend } from './win32-backend';
import {
  DEFAULT_JPEG_QUALITY,
  DEFAULT_MAX_PX,
  MAX_IMAGE_BYTES,
  MAX_MAX_PX,
  MIN_MAX_PX,
  MUTEX_WAIT_MS,
  PNG_AREA_THRESHOLD,
  ACTIVATE_SETTLE_MS,
} from './config';

// ─── backend selection (cached per process) ──────────────────────────────────

let cached: DesktopBackend | null = null;
function backend(): DesktopBackend {
  if (cached) return cached;
  cached = process.platform === 'win32' ? new Win32Backend() : new X11Backend();
  return cached;
}

// ─── single-flight mutex for desktop WRITES (input + window actions) ──────────
//
// Two synthesized inputs interleaving on one display corrupt each other (a
// keydown from A between B's down and up). Serialize writes per process, but
// BOUND the wait — an unbounded queue is how a hung backend wedges every future
// call. Reads (status/windows/screenshot) do NOT take the lock.

let writeChain: Promise<unknown> = Promise.resolve();
async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = writeChain;
  let release!: () => void;
  writeChain = new Promise<void>((r) => (release = r));
  // Wait for the prior write, but not forever.
  const waited = await Promise.race([
    prior.then(() => true).catch(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), MUTEX_WAIT_MS)),
  ]);
  if (!waited) {
    release();
    throw new DesktopError('BUSY', `desktop is busy with another input/window action (waited ${MUTEX_WAIT_MS}ms). Retry shortly.`);
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

// ─── status / windows (reads) ─────────────────────────────────────────────────

export function desktopStatus(): Promise<DesktopStatus> {
  return backend().status();
}

export async function desktopWindows(): Promise<{ displays: DisplayInfo[]; windows: WindowInfo[]; workarea: Rect | null; activeWindow: string | null; truncated: boolean }> {
  const r = await backend().windows();
  // MAX_WINDOWS bound with an explicit truncation flag (never a silent cap).
  const { MAX_WINDOWS } = await import('./config');
  const truncated = r.windows.length > MAX_WINDOWS;
  return { ...r, windows: truncated ? r.windows.slice(0, MAX_WINDOWS) : r.windows, truncated };
}

// ─── screenshot (read + image pipeline) ───────────────────────────────────────

export interface ScreenshotArgs {
  region?: [number, number, number, number];
  window?: string;
  display?: number;
  maxPx?: number;
  format?: 'jpeg' | 'png';
  quality?: number;
  cursor?: boolean;
}

export interface ScreenshotResult {
  meta: {
    platform: string;
    display: number;
    screen: { width: number; height: number };
    capture: Rect;
    image: { width: number; height: number };
    /** image px → desktop px: desktop = capture.origin + round(imagePx / scale). */
    scale: number;
    format: 'jpeg' | 'png';
    cursor: boolean;
    /** The one fixed mapping sentence, ready to print. */
    mapping: string;
  };
  /** base64 image bytes for the MCP image block. */
  base64: string;
  mimeType: string;
}

export async function desktopScreenshot(args: ScreenshotArgs): Promise<ScreenshotResult> {
  // Validate region.
  let region: { x1: number; y1: number; x2: number; y2: number } | undefined;
  if (args.region) {
    const [x1, y1, x2, y2] = args.region;
    if (![x1, y1, x2, y2].every((n) => Number.isInteger(n))) throw new DesktopError('BAD_ARGS', 'region must be four integers [x1,y1,x2,y2]');
    if (x2 <= x1 || y2 <= y1) throw new DesktopError('BAD_ARGS', 'region must have x1<x2 and y1<y2');
    region = { x1, y1, x2, y2 };
  }
  const maxPx = clamp(args.maxPx ?? DEFAULT_MAX_PX, MIN_MAX_PX, MAX_MAX_PX);
  const cursor = args.cursor ?? true;

  const raw = await backend().capture({ region, window: args.window, display: args.display, cursor });

  // sharp pipeline: downscale to maxPx long edge (never upscale), choose format.
  const meta0 = await sharp(raw.png).metadata();
  const nativeW = meta0.width ?? raw.capture.width;
  const nativeH = meta0.height ?? raw.capture.height;
  const longEdge = Math.max(nativeW, nativeH);
  let scale = longEdge > maxPx ? maxPx / longEdge : 1;

  const area = nativeW * nativeH;
  let format: 'jpeg' | 'png' = args.format ?? (area * scale * scale <= PNG_AREA_THRESHOLD ? 'png' : 'jpeg');
  let quality = clamp(args.quality ?? DEFAULT_JPEG_QUALITY, 1, 100);

  const { buf, width, height, usedScale, usedFormat } = await encodeUnderCeiling(raw.png, nativeW, nativeH, scale, format, quality);
  scale = usedScale;
  format = usedFormat;

  const mapping =
    `image pixel (u,v) → desktop pixel (${raw.capture.x} + round(u/${scale.toFixed(4)}), ${raw.capture.y} + round(v/${scale.toFixed(4)})). ` +
    (scale === 1 ? 'Image is native resolution — coordinates map 1:1 within the captured region.' : 'Image is downscaled — divide your click coordinates by the scale to reach desktop pixels, then add the capture origin.');

  return {
    meta: {
      platform: backend().platform,
      display: raw.display,
      screen: raw.screen,
      capture: raw.capture,
      image: { width, height },
      scale,
      format,
      cursor,
      mapping,
    },
    base64: buf.toString('base64'),
    mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
  };
}

/** Encode, dropping resolution/quality until under the byte ceiling. */
async function encodeUnderCeiling(
  png: Buffer,
  nativeW: number,
  nativeH: number,
  scale: number,
  format: 'jpeg' | 'png',
  quality: number,
): Promise<{ buf: Buffer; width: number; height: number; usedScale: number; usedFormat: 'jpeg' | 'png' }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = Math.max(1, Math.round(nativeW * scale));
    const h = Math.max(1, Math.round(nativeH * scale));
    let pipe = sharp(png).resize(w, h, { fit: 'fill' });
    pipe = format === 'png' ? pipe.png({ compressionLevel: 9 }) : pipe.jpeg({ quality });
    const buf = await pipe.toBuffer();
    if (buf.length <= MAX_IMAGE_BYTES) return { buf, width: w, height: h, usedScale: scale, usedFormat: format };
    // Over ceiling: first switch PNG→JPEG, then drop quality, then shrink.
    if (format === 'png') {
      format = 'jpeg';
    } else if (quality > 55) {
      quality -= 15;
    } else {
      scale *= 0.75;
    }
  }
  // Final attempt result (already computed on the last loop) — shrink hard once more.
  const w = Math.max(1, Math.round(nativeW * scale));
  const h = Math.max(1, Math.round(nativeH * scale));
  const buf = await sharp(png).resize(w, h, { fit: 'fill' }).jpeg({ quality: 50 }).toBuffer();
  return { buf, width: w, height: h, usedScale: scale, usedFormat: 'jpeg' };
}

// ─── input (write, validated, computer-use semantics) ─────────────────────────

const CLICK_ACTIONS: DesktopInputAction[] = ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click'];
const COORD_REQUIRED: DesktopInputAction[] = [...CLICK_ACTIONS, 'mouse_move', 'left_click_drag'];
const NO_TEXT: DesktopInputAction[] = ['mouse_move', 'left_mouse_down', 'left_mouse_up', 'left_click_drag', 'cursor_position'];
const SCROLL_DIRS: ScrollDirection[] = ['up', 'down', 'left', 'right'];

export interface InputArgs {
  action: string;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  text?: string;
  scroll_direction?: string;
  scroll_amount?: number;
  duration?: number;
  window?: string;
  screenshot_after_ms?: number;
}

/** Validate + normalize raw MCP args into a typed InputRequest. */
export function validateInput(args: InputArgs): InputRequest {
  const action = args.action as DesktopInputAction;
  const ALL: DesktopInputAction[] = [
    'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag',
    'left_mouse_down', 'left_mouse_up', 'mouse_move', 'type', 'key', 'hold_key', 'scroll', 'cursor_position',
  ];
  if (!ALL.includes(action)) throw new DesktopError('BAD_ARGS', `unknown action "${args.action}". Valid: ${ALL.join(', ')}`);

  const coord = normCoord(args.coordinate);
  const startCoord = normCoord(args.start_coordinate);

  if (COORD_REQUIRED.includes(action) && !coord) throw new DesktopError('BAD_ARGS', `coordinate [x,y] (two non-negative ints) is required for ${action}`);
  if (action === 'left_click_drag' && !startCoord) throw new DesktopError('BAD_ARGS', 'start_coordinate [x,y] is required for left_click_drag');
  if (NO_TEXT.includes(action) && typeof args.text === 'string' && args.text.length > 0 && !CLICK_ACTIONS.includes(action)) {
    throw new DesktopError('BAD_ARGS', `${action} does not accept text`);
  }
  if (action === 'type' && (typeof args.text !== 'string' || args.text.length === 0)) throw new DesktopError('BAD_ARGS', 'text is required for type');
  if ((action === 'key' || action === 'hold_key') && (typeof args.text !== 'string' || !args.text.trim())) {
    throw new DesktopError('BAD_ARGS', `text (the key/combo, e.g. "ctrl+s") is required for ${action}`);
  }
  if (action === 'scroll') {
    if (!args.scroll_direction || !SCROLL_DIRS.includes(args.scroll_direction as ScrollDirection)) {
      throw new DesktopError('BAD_ARGS', `scroll_direction (${SCROLL_DIRS.join('|')}) is required for scroll`);
    }
    if (args.scroll_amount !== undefined && (!Number.isInteger(args.scroll_amount) || args.scroll_amount < 0)) {
      throw new DesktopError('BAD_ARGS', 'scroll_amount must be a non-negative integer');
    }
  }
  if (action === 'hold_key' && args.duration !== undefined && (typeof args.duration !== 'number' || args.duration < 0 || args.duration > 100)) {
    throw new DesktopError('BAD_ARGS', 'duration must be a number of seconds in [0,100]');
  }

  return {
    action,
    coordinate: coord,
    startCoordinate: startCoord,
    text: typeof args.text === 'string' ? args.text : undefined,
    scrollDirection: args.scroll_direction as ScrollDirection | undefined,
    scrollAmount: args.scroll_amount,
    duration: args.duration,
  };
}

export async function desktopInput(args: InputArgs): Promise<{ result: InputResult; screenshot?: ScreenshotResult }> {
  const req = validateInput(args);
  return withWriteLock(async () => {
    const b = backend();
    if (args.window) {
      await b.windowAction({ window: args.window, action: 'activate' });
      await new Promise((r) => setTimeout(r, ACTIVATE_SETTLE_MS));
    }
    const result = await b.input(req);
    let screenshot: ScreenshotResult | undefined;
    if (args.screenshot_after_ms !== undefined) {
      const wait = clamp(args.screenshot_after_ms, 0, 10_000);
      await new Promise((r) => setTimeout(r, wait));
      screenshot = await desktopScreenshot({ maxPx: DEFAULT_MAX_PX, cursor: true });
    }
    return { result, screenshot };
  });
}

// ─── window actions (write) ───────────────────────────────────────────────────

export interface WindowArgs {
  window: string;
  action: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

const WINDOW_ACTIONS: WindowAction[] = ['activate', 'close', 'minimize', 'maximize', 'restore', 'move', 'resize'];

export async function desktopWindowAction(args: WindowArgs): Promise<WindowActionResult> {
  if (!args.window || typeof args.window !== 'string') throw new DesktopError('BAD_ARGS', 'window id is required (from desktop_windows)');
  const action = args.action as WindowAction;
  if (!WINDOW_ACTIONS.includes(action)) throw new DesktopError('BAD_ARGS', `unknown window action "${args.action}". Valid: ${WINDOW_ACTIONS.join(', ')}`);
  if (action === 'move' && (!Number.isInteger(args.x) || !Number.isInteger(args.y))) throw new DesktopError('BAD_ARGS', 'move requires integer x and y');
  if (action === 'resize' && (!Number.isInteger(args.width) || !Number.isInteger(args.height))) throw new DesktopError('BAD_ARGS', 'resize requires integer width and height');

  return withWriteLock(() =>
    backend().windowAction({ window: args.window, action, x: args.x, y: args.y, width: args.width, height: args.height }),
  );
}

// ─── clipboard (read/write via the backend) ───────────────────────────────────

export async function desktopClipboard(args: { mode?: string; text?: string }): Promise<{ mode: 'get' | 'set'; text?: string; bytes?: number }> {
  const mode = args.mode === 'set' ? 'set' : args.mode === 'get' ? 'get' : undefined;
  if (!mode) throw new DesktopError('BAD_ARGS', 'mode must be "get" or "set"');
  if (mode === 'set' && typeof args.text !== 'string') throw new DesktopError('BAD_ARGS', 'text is required for clipboard set');
  const b = backend();
  if (!b.clipboard) throw new DesktopError('DESKTOP_UNSUPPORTED', `clipboard is not implemented on the ${b.platform} backend yet`);
  // A clipboard write is a real mutation → serialize behind the same lock as input.
  const run = () => b.clipboard!({ mode, text: args.text });
  const r = mode === 'set' ? await withWriteLock(run) : await run();
  return { mode, text: r.text, bytes: r.bytes };
}

// ─── process query (read) ──────────────────────────────────────────────────────

export const MAX_PROCESS_ROWS = 50;

export async function desktopProcess(args: { query?: string; limit?: number }): Promise<{ query: string | null; total: number; processes: ProcessInfo[] }> {
  const b = backend();
  if (!b.processes) throw new DesktopError('DESKTOP_UNSUPPORTED', `process query is not implemented on the ${b.platform} backend yet`);
  const limit = clamp(args.limit ?? MAX_PROCESS_ROWS, 1, MAX_PROCESS_ROWS);
  const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined;
  const rows = await b.processes({ query, limit });
  return { query: query ?? null, total: rows.length, processes: rows };
}

// ─── wait_for (backend-free: polls the window list) ────────────────────────────

export interface WaitForArgs {
  title?: string;
  app?: string;
  state?: string;
  timeout_ms?: number;
}

/**
 * Poll the window list until a window matching title/app (and optional state)
 * appears, or the timeout elapses. Backend-agnostic — it only calls windows(),
 * so it works on every platform the moment that platform lists windows.
 */
export async function desktopWaitFor(args: WaitForArgs): Promise<{ found: boolean; waitedMs: number; window: WindowInfo | null }> {
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().toLowerCase() : undefined;
  const app = typeof args.app === 'string' && args.app.trim() ? args.app.trim().toLowerCase() : undefined;
  const state = typeof args.state === 'string' ? args.state.trim().toLowerCase() : undefined;
  if (!title && !app) throw new DesktopError('BAD_ARGS', 'wait_for needs a title or app substring to match');
  const timeout = clamp(args.timeout_ms ?? 10_000, 200, 60_000);
  const started = Date.now();
  const b = backend();
  const match = (w: WindowInfo): boolean =>
    (title ? w.title.toLowerCase().includes(title) : true) &&
    (app ? w.app.toLowerCase().includes(app) : true) &&
    (state ? w.state === state : true);
  for (;;) {
    let hit: WindowInfo | null = null;
    try {
      const r = await b.windows();
      hit = r.windows.find(match) ?? null;
    } catch {
      /* transient (e.g. WM briefly unavailable) — keep polling until timeout */
    }
    if (hit) return { found: true, waitedMs: Date.now() - started, window: hit };
    if (Date.now() - started >= timeout) return { found: false, waitedMs: Date.now() - started, window: null };
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ─── OCR-anchored text targeting (find_text / click_text) ──────────────────────

export const MAX_TEXT_MATCHES = 60;
const OCR_TIMEOUT_MS = 20_000;

/** One line parsed from tesseract tsv, in IMAGE pixels (pre coordinate-mapping). */
interface TsvLine { text: string; conf: number; left: number; top: number; width: number; height: number }

/**
 * Parse `tesseract … tsv` output into text LINES (a label/menu item is a line,
 * not one word). Pure + exported for tests. tsv columns:
 *   level page block par line word left top width height conf text
 * Words (level 5) are grouped by (block,par,line); the line box is the union of
 * its word boxes and its confidence the mean of theirs. Words below minConf drop.
 */
export function parseTsvLines(tsv: string, minConf: number): TsvLine[] {
  const groups = new Map<string, { texts: string[]; confs: number[]; l: number; t: number; r: number; b: number }>();
  const order: string[] = [];
  // Split on CRLF or LF — Windows tesseract emits CRLF, and splitting only on \n
  // leaves a trailing \r on every word's text field (so "OK" becomes "OK\r" and
  // exact matches / display break). Trim the word defensively too.
  for (const raw of tsv.split(/\r?\n/)) {
    const c = raw.split('\t');
    if (c.length < 12 || c[0] === 'level' || c[0] !== '5') continue; // level 5 = word
    const conf = parseFloat(c[10]);
    const text = (c[11] ?? '').replace(/[\r\n]+$/, '').trim();
    if (!text || !Number.isFinite(conf) || conf < minConf) continue;
    const left = parseInt(c[6], 10), top = parseInt(c[7], 10), w = parseInt(c[8], 10), h = parseInt(c[9], 10);
    if (![left, top, w, h].every(Number.isFinite)) continue;
    const key = `${c[2]}.${c[3]}.${c[4]}`; // block.par.line
    let g = groups.get(key);
    if (!g) { g = { texts: [], confs: [], l: left, t: top, r: left + w, b: top + h }; groups.set(key, g); order.push(key); }
    g.texts.push(text);
    g.confs.push(conf);
    g.l = Math.min(g.l, left); g.t = Math.min(g.t, top); g.r = Math.max(g.r, left + w); g.b = Math.max(g.b, top + h);
  }
  return order.map((k) => {
    const g = groups.get(k)!;
    return {
      text: g.texts.join(' '),
      conf: Math.round(g.confs.reduce((a, b) => a + b, 0) / g.confs.length),
      left: g.l, top: g.t, width: g.r - g.l, height: g.b - g.t,
    };
  });
}

/** Resolve the tesseract binary: PATH first, then the standard Windows install
 *  dir (choco/UB-Mannheim land it there, but the running Core may predate the
 *  PATH update). */
function tesseractBin(): string {
  if (process.platform === 'win32') {
    for (const p of ['C:\\Program Files\\Tesseract-OCR\\tesseract.exe', 'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe']) {
      try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
    }
  }
  return 'tesseract';
}

function runTesseract(pngPath: string, lang: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // TSV via the PARAMETER (-c tessedit_create_tsv=1), NOT the `tsv` config file:
    // with --tessdata-dir pointing at our user dir, tesseract can't find the `tsv`
    // config (it lives in the system tessdata's configs/), which on Windows fails
    // with "Can't open tsv" and emits no TSV (0 lines). The -c param needs no file.
    execFile(tesseractBin(), [pngPath, 'stdout', '-l', lang, '--psm', '11', '--tessdata-dir', LM_TESSDATA, '-c', 'tessedit_create_tsv=1'], { timeout: OCR_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf-8' }, (error, stdout) => {
      if (error && !stdout) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOENT') return reject(new DesktopError('TOOL_MISSING', 'tesseract is required for text targeting (Linux: sudo apt-get install tesseract-ocr; Windows: choco install tesseract, then restart Core)'));
        return reject(new DesktopError('CAPTURE_FAILED', `tesseract failed: ${error.message}`));
      }
      resolve(stdout || '');
    });
  });
}

/** Resolve the requested `lang` arg into (a) the tesseract -l string and (b) a
 *  note, ensuring every needed pack is present (auto-detect + auto-install). */
async function resolveOcrLang(reqRaw: string | undefined, pngPath: string): Promise<{ lang: string; note: string }> {
  const req = (reqRaw ?? 'auto').trim() || 'auto';
  if (req === 'auto') {
    const d = await autoDetectLang(tesseractBin(), pngPath);
    const lang = d.lang === 'eng' ? 'eng' : `${d.lang}+eng`;
    let note = `lang=${lang} (auto, via ${d.via})`;
    if (d.install?.source === 'downloaded') note += ` — installed ${d.install.lang}.traineddata`;
    else if (d.install && !d.install.available) note += ` — ${d.install.lang} pack unavailable, using eng`;
    return { lang, note };
  }
  if (req === 'eng' || req === 'off') { await ensureBase(); return { lang: 'eng', note: 'lang=eng' }; }
  // Explicit code(s), e.g. "chi_sim" or "jpn+eng".
  await ensureBase();
  const parts = req.split('+').map((s) => s.trim()).filter(Boolean);
  // Reject anything that isn't a clean tesseract code BEFORE it reaches the
  // filesystem path in ensureLang (defense-in-depth against path traversal).
  const bad = parts.find((p) => !isValidLangCode(p));
  if (bad) throw new DesktopError('BAD_ARGS', `invalid language code "${bad}" — use codes like "eng", "chi_sim", "jpn" (or "auto")`);
  const installed: string[] = [];
  for (const l of parts) {
    if (l === 'eng') continue;
    const r = await ensureLang(l);
    if (r.source === 'downloaded') installed.push(l);
    if (!r.available) return { lang: 'eng', note: `lang ${l} unavailable (auto-install off or unknown) — using eng` };
  }
  const lang = parts.includes('eng') ? parts.join('+') : `${parts.join('+')}+eng`;
  return { lang, note: `lang=${lang}${installed.length ? ` — installed ${installed.join(', ')}` : ''}` };
}

export interface FindTextArgs {
  query?: string;
  region?: [number, number, number, number];
  window?: string;
  min_confidence?: number;
  /** 'auto' (default: OSD/locale detect + auto-install), 'eng', or a tesseract code like 'chi_sim'. */
  lang?: string;
}

export interface FindTextResult {
  screen: { width: number; height: number };
  capture: Rect;
  total: number;
  truncated: boolean;
  matches: OcrMatch[];
  /** The tesseract -l string actually used + how it was chosen / installed. */
  lang: string;
}

/** OCR the screen/region/window and return recognized text lines in desktop px. */
export async function desktopFindText(args: FindTextArgs): Promise<FindTextResult> {
  let region: { x1: number; y1: number; x2: number; y2: number } | undefined;
  if (args.region) {
    const [x1, y1, x2, y2] = args.region;
    if (![x1, y1, x2, y2].every(Number.isInteger) || x2 <= x1 || y2 <= y1) throw new DesktopError('BAD_ARGS', 'region must be four ints [x1,y1,x2,y2] with x1<x2,y1<y2');
    region = { x1, y1, x2, y2 };
  }
  const minConf = clamp(args.min_confidence ?? 50, 0, 100);
  const raw = await backend().capture({ region, window: args.window, cursor: false });
  fs.mkdirSync(DESKTOP_TMP_DIR, { recursive: true });
  const outPath = path.join(DESKTOP_TMP_DIR, `ocr-${process.pid}-${Date.now()}.png`);
  try {
    fs.writeFileSync(outPath, raw.png);
    const resolved = await resolveOcrLang(args.lang, outPath);
    const tsv = await runTesseract(outPath, resolved.lang);
    const lines = parseTsvLines(tsv, minConf);
    let matches: OcrMatch[] = lines.map((l) => ({
      text: l.text,
      confidence: l.conf,
      bounds: { x: raw.capture.x + l.left, y: raw.capture.y + l.top, width: l.width, height: l.height },
      center: [raw.capture.x + l.left + Math.round(l.width / 2), raw.capture.y + l.top + Math.round(l.height / 2)],
    }));
    if (args.query && args.query.trim()) {
      const q = args.query.trim().toLowerCase();
      matches = matches.filter((m) => m.text.toLowerCase().includes(q));
    }
    const total = matches.length;
    return { screen: raw.screen, capture: raw.capture, total, truncated: total > MAX_TEXT_MATCHES, matches: matches.slice(0, MAX_TEXT_MATCHES), lang: resolved.note };
  } finally {
    try { fs.unlinkSync(outPath); } catch { /* best-effort */ }
  }
}

export interface ClickTextArgs {
  text: string;
  index?: number;
  match?: string;
  button?: string;
  double?: boolean;
  window?: string;
  screenshot_after_ms?: number;
  lang?: string;
}

/** Find `text` on screen (fresh OCR) and click its center — atomic, no stale coords. */
export async function desktopClickText(args: ClickTextArgs): Promise<{ clicked: { text: string; center: [number, number] }; candidates: number; index: number; screenshot?: ScreenshotResult }> {
  if (!args.text || typeof args.text !== 'string' || !args.text.trim()) throw new DesktopError('BAD_ARGS', 'text is required (the on-screen label to click)');
  const exact = args.match === 'exact';
  const found = await desktopFindText({ query: exact ? undefined : args.text, window: args.window, lang: args.lang });
  const want = args.text.trim().toLowerCase();
  const candidates = exact ? found.matches.filter((m) => m.text.trim().toLowerCase() === want) : found.matches;
  if (!candidates.length) {
    // Near-misses: what text WAS recognized (unfiltered), so the caller can adjust.
    const all = await desktopFindText({ window: args.window, lang: args.lang });
    const near = all.matches.slice(0, 8).map((m) => `"${m.text}"`).join(', ');
    throw new DesktopError('BAD_ARGS', `no on-screen text ${exact ? 'exactly matched' : 'contained'} "${args.text}". Recognized nearby: ${near || '(nothing legible)'}`);
  }
  const index = clamp(args.index ?? 0, 0, candidates.length - 1);
  const target = candidates[index];
  const button = args.button === 'right' ? 'right_click' : args.button === 'middle' ? 'middle_click' : args.double ? 'double_click' : 'left_click';
  return withWriteLock(async () => {
    const b = backend();
    if (args.window) {
      await b.windowAction({ window: args.window, action: 'activate' });
      await new Promise((r) => setTimeout(r, ACTIVATE_SETTLE_MS));
    }
    await b.input({ action: button as DesktopInputAction, coordinate: target.center });
    let screenshot: ScreenshotResult | undefined;
    if (args.screenshot_after_ms !== undefined) {
      await new Promise((r) => setTimeout(r, clamp(args.screenshot_after_ms ?? 0, 0, 10_000)));
      screenshot = await desktopScreenshot({ maxPx: DEFAULT_MAX_PX, cursor: true });
    }
    return { clicked: { text: target.text, center: target.center }, candidates: candidates.length, index, screenshot };
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/** Normalize a coordinate arg to [x,y] of ints, or undefined. Non-negative is
 *  NOT enforced here (Windows virtual screen allows negatives); backends /
 *  action validation enforce platform-specific bounds. */
function normCoord(c: unknown): [number, number] | undefined {
  if (!Array.isArray(c) || c.length !== 2) return undefined;
  const [x, y] = c;
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new DesktopError('BAD_ARGS', 'coordinate must be two integers [x,y]');
  return [x, y];
}

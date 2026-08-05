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
import {
  DesktopBackend,
  DesktopError,
  DesktopInputAction,
  DesktopStatus,
  DisplayInfo,
  InputRequest,
  InputResult,
  Rect,
  ScrollDirection,
  WindowAction,
  WindowActionResult,
  WindowInfo,
} from './types';
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

/**
 * Desktop Automation Routes — cross-platform desktop control.
 *
 * Single source of truth for desktop_* behavior; the MCP tools wrap these on
 * loopback. Backend = X11 today (node 117), Windows lands from the win-automation
 * session (node 107). Reads: status, windows, screenshot. Writes: window, input.
 *
 *   GET  /desktop/status                platform + readiness + displays + windows-at-a-glance + warnings
 *   GET  /desktop/windows               displays + top-level windows (id/title/app/pid/geom/state)
 *   POST /desktop/screenshot            { region?, window?, display?, max_px?, format?, quality?, cursor? } → image
 *   POST /desktop/window                { window, action, x?, y?, width?, height? } — activate/close/min/max/restore/move/resize
 *   POST /desktop/input                 { action, coordinate?, start_coordinate?, text?, scroll_direction?, scroll_amount?, duration?, window?, screenshot_after_ms? }
 *
 * Envelope: hand-rolled { success, data } / fail(e) — matching the gmail/linkedin
 * connector routes — so the DesktopError `code` reaches the MCP layer intact.
 */

import type { RouteHandler, RouteContext } from '../index';
import { DesktopError } from '../../desktop/types';
import {
  desktopStatus,
  desktopWindows,
  desktopScreenshot,
  desktopInput,
  desktopWindowAction,
  desktopClipboard,
  desktopProcess,
  desktopWaitFor,
  desktopFindText,
  desktopClickText,
  type ScreenshotArgs,
  type InputArgs,
  type WindowArgs,
} from '../../desktop/service';

/** Map a thrown error to the structured { success:false, error, code } envelope. */
function fail(e: unknown): { success: false; error: string; code?: string } {
  if (e instanceof DesktopError) return { success: false, error: e.message, code: e.code };
  return { success: false, error: e instanceof Error ? e.message : String(e) };
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function coord(v: unknown): [number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const x = Number(v[0]);
  const y = Number(v[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return [Math.round(x), Math.round(y)];
}

export function createDesktopRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/desktop\/status$/,
      handler: async () => {
        try {
          return { success: true, data: await desktopStatus() };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/desktop\/windows$/,
      handler: async () => {
        try {
          return { success: true, data: await desktopWindows() };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/desktop\/screenshot$/,
      handler: async (req) => {
        try {
          const b = (req.body ?? {}) as Record<string, unknown>;
          const region4 =
            Array.isArray(b.region) && b.region.length === 4 && b.region.every((n) => Number.isFinite(Number(n)))
              ? (b.region.map((n) => Math.round(Number(n))) as [number, number, number, number])
              : undefined;
          const args: ScreenshotArgs = {
            region: region4,
            window: typeof b.window === 'string' ? b.window : undefined,
            display: num(b.display),
            maxPx: num(b.max_px),
            format: b.format === 'png' || b.format === 'jpeg' ? b.format : undefined,
            quality: num(b.quality),
            cursor: typeof b.cursor === 'boolean' ? b.cursor : undefined,
          };
          return { success: true, data: await desktopScreenshot(args) };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/desktop\/window$/,
      handler: async (req) => {
        try {
          const b = (req.body ?? {}) as Record<string, unknown>;
          const args: WindowArgs = {
            window: typeof b.window === 'string' ? b.window : String(b.window ?? ''),
            action: String(b.action ?? ''),
            x: num(b.x),
            y: num(b.y),
            width: num(b.width),
            height: num(b.height),
          };
          return { success: true, data: await desktopWindowAction(args) };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/desktop\/input$/,
      handler: async (req) => {
        try {
          const b = (req.body ?? {}) as Record<string, unknown>;
          const args: InputArgs = {
            action: String(b.action ?? ''),
            coordinate: coord(b.coordinate),
            start_coordinate: coord(b.start_coordinate),
            text: typeof b.text === 'string' ? b.text : undefined,
            scroll_direction: typeof b.scroll_direction === 'string' ? b.scroll_direction : undefined,
            scroll_amount: num(b.scroll_amount),
            duration: num(b.duration),
            window: typeof b.window === 'string' ? b.window : undefined,
            screenshot_after_ms: num(b.screenshot_after_ms),
          };
          return { success: true, data: await desktopInput(args) };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/desktop\/clipboard$/,
      handler: async (req) => {
        try {
          const b = (req.body ?? {}) as Record<string, unknown>;
          return { success: true, data: await desktopClipboard({ mode: typeof b.mode === 'string' ? b.mode : undefined, text: typeof b.text === 'string' ? b.text : undefined }) };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/desktop\/process$/,
      handler: async (req) => {
        try {
          return { success: true, data: await desktopProcess({ query: req.query.query, limit: num(req.query.limit) }) };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/desktop\/wait$/,
      handler: async (req) => {
        try {
          const b = (req.body ?? {}) as Record<string, unknown>;
          return { success: true, data: await desktopWaitFor({
            title: typeof b.title === 'string' ? b.title : undefined,
            app: typeof b.app === 'string' ? b.app : undefined,
            state: typeof b.state === 'string' ? b.state : undefined,
            timeout_ms: num(b.timeout_ms),
          }) };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/desktop\/find-text$/,
      handler: async (req) => {
        try {
          const b = (req.body ?? {}) as Record<string, unknown>;
          const region4 = Array.isArray(b.region) && b.region.length === 4 && b.region.every((n) => Number.isFinite(Number(n)))
            ? (b.region.map((n) => Math.round(Number(n))) as [number, number, number, number]) : undefined;
          return { success: true, data: await desktopFindText({
            query: typeof b.query === 'string' ? b.query : undefined,
            region: region4,
            window: typeof b.window === 'string' ? b.window : undefined,
            min_confidence: num(b.min_confidence),
            lang: typeof b.lang === 'string' ? b.lang : undefined,
          }) };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/desktop\/click-text$/,
      handler: async (req) => {
        try {
          const b = (req.body ?? {}) as Record<string, unknown>;
          return { success: true, data: await desktopClickText({
            text: typeof b.text === 'string' ? b.text : String(b.text ?? ''),
            index: num(b.index),
            match: typeof b.match === 'string' ? b.match : undefined,
            button: typeof b.button === 'string' ? b.button : undefined,
            double: typeof b.double === 'boolean' ? b.double : undefined,
            window: typeof b.window === 'string' ? b.window : undefined,
            screenshot_after_ms: num(b.screenshot_after_ms),
            lang: typeof b.lang === 'string' ? b.lang : undefined,
          }) };
        } catch (e) {
          return fail(e);
        }
      },
    },
  ];
}

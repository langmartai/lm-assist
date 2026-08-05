/**
 * Desktop automation — the CROSS-PLATFORM contract.
 *
 * 🔴 THIS FILE IS THE SHARED INTERFACE between the Linux backend (x11-backend.ts,
 * this checkout) and the Windows backend (win32-backend.ts, implemented by the
 * win-automation session on node 107). `service.ts` talks to a `DesktopBackend`
 * and knows nothing platform-specific; both backends implement THIS. Changing a
 * shape here is a fleet-wide change — coordinate it across both sessions, never
 * fork it.
 *
 * Coordinate convention (all platforms): PHYSICAL desktop pixels, top-left
 * origin, in VIRTUAL-screen space. On Windows a secondary monitor left of / above
 * the primary gives NEGATIVE coordinates — never clamp to zero. A backend returns
 * captures at NATIVE resolution + the capture geometry; `service.ts` owns all
 * downscaling, cropping-for-return, and encoding (via sharp) so the two platforms
 * share one image pipeline and one coordinate-mapping story.
 *
 * The action vocabulary (DesktopInputAction) deliberately mirrors Anthropic's
 * computer-use tool (computer_20251124): the models are natively trained on these
 * exact names and param shapes, so we do not invent our own.
 */

/** Which desktop stack a node presents. */
export type DesktopPlatform =
  | 'linux-x11'
  | 'linux-wayland' // detected, but not driveable in v1 — reported, refused loudly
  | 'windows'
  | 'unsupported';

/** Stable error codes shared by both backends and surfaced to the caller. */
export type DesktopErrorCode =
  | 'DESKTOP_UNSUPPORTED' // platform/session cannot do desktops (message says why)
  | 'NO_DISPLAY' // no X server / no interactive desktop session
  | 'TOOL_MISSING' // a required binary/helper is absent (message names it)
  | 'BAD_WINDOW' // window id unknown or stale
  | 'BAD_ARGS' // validation failure (message names the param + action)
  | 'CAPTURE_FAILED'
  | 'INPUT_FAILED'
  | 'WINDOW_ACTION_FAILED'
  | 'BACKEND_TIMEOUT'
  | 'WINDOWS_SESSION0' // Windows: Core is not in the interactive session
  | 'BUSY'; // single-flight queue full / timed out

/** A typed desktop error. Backends throw this; routes render {code,message}. */
export class DesktopError extends Error {
  code: DesktopErrorCode;
  constructor(code: DesktopErrorCode, message: string) {
    super(message);
    this.name = 'DesktopError';
    this.code = code;
  }
}

/** A rectangle in physical desktop pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One display/monitor. */
export interface DisplayInfo {
  index: number;
  bounds: Rect;
  /** Effective scale factor (1 = 100%, 1.5 = 150% DPI). 1 when unknown. */
  scale: number;
  primary: boolean;
}

/** Window liveness/geometry state. */
export type WindowState = 'active' | 'minimized' | 'maximized' | 'normal';

/** One top-level window. */
export interface WindowInfo {
  /** Native id rendered as a string: X11 hex ("0x03600004"); Windows decimal HWND. */
  id: string;
  title: string;
  /** WM_CLASS (X11) or executable basename (Windows). */
  app: string;
  pid: number | null;
  /** Which display index the window's top-left falls on. */
  display: number;
  /** X11 desktop / Windows virtual-desktop ordinal, when known. */
  workspace: number | null;
  bounds: Rect;
  state: WindowState;
}

/** Result of a readiness/doctor probe (desktop_status). */
export interface DesktopStatus {
  platform: DesktopPlatform;
  ready: boolean;
  /** Present only when ready === false: why, and what would fix it. */
  reason?: string;
  /** e.g. "x11" / "wayland" / "windows". */
  sessionType: string;
  /** X DISPLAY on Linux ("<none>" when absent); "" on Windows. */
  display: string;
  displays: DisplayInfo[];
  screen: { width: number; height: number };
  /** EWMH workarea (screen minus panels/docks); null on Windows. */
  workarea: Rect | null;
  activeWindow: { id: string; title: string } | null;
  cursor: [number, number] | null;
  /** Which backend binaries/helpers were found (backend-specific keys). */
  backends: Record<string, string | boolean>;
  /** Non-fatal cautions — e.g. a CDP browser shares this display (one-writer). */
  warnings: string[];
}

/** A NATIVE-RESOLUTION capture from a backend, before service-side processing. */
export interface RawCapture {
  /** PNG bytes at native resolution. */
  png: Buffer;
  /** The desktop-space rectangle these pixels cover. */
  capture: Rect;
  /** Full screen size the capture was taken from. */
  screen: { width: number; height: number };
  /** Display index captured. */
  display: number;
}

/** What a backend is asked to capture. service.ts does the downscale/encode. */
export interface CaptureRequest {
  /** Native-res region [x1,y1,x2,y2] in desktop px, or a whole display. */
  region?: { x1: number; y1: number; x2: number; y2: number };
  /** Capture this window's current bounds (backend resolves id → rect). */
  window?: string;
  /** Display index (default: primary). */
  display?: number;
  /** Draw the mouse cursor into the capture. */
  cursor: boolean;
}

/** The computer-use action vocabulary (computer_20251124), verbatim names. */
export type DesktopInputAction =
  | 'left_click'
  | 'right_click'
  | 'middle_click'
  | 'double_click'
  | 'triple_click'
  | 'left_click_drag'
  | 'left_mouse_down'
  | 'left_mouse_up'
  | 'mouse_move'
  | 'type'
  | 'key'
  | 'hold_key'
  | 'scroll'
  | 'cursor_position';

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** A fully-validated input request handed to a backend (service.ts validates). */
export interface InputRequest {
  action: DesktopInputAction;
  coordinate?: [number, number];
  startCoordinate?: [number, number];
  /** Text to type, key/combo to press, or the modifier held during a click/scroll. */
  text?: string;
  scrollDirection?: ScrollDirection;
  scrollAmount?: number;
  /** Seconds (hold_key). */
  duration?: number;
}

/** Outcome of an input action. cursor_position fills `cursor`. */
export interface InputResult {
  action: DesktopInputAction;
  ok: boolean;
  cursor?: [number, number];
  detail?: string;
}

export type WindowAction =
  | 'activate'
  | 'close'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'move'
  | 'resize';

export interface WindowActionRequest {
  window: string;
  action: WindowAction;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** Outcome of a window action — re-queried state, never assumed. */
export interface WindowActionResult {
  window: string;
  action: WindowAction;
  /** True only when the post-action re-query CONFIRMS the intended change. */
  verified: boolean;
  /** The window's state after the action (re-read from the WM). */
  resulting: WindowInfo | null;
  note?: string;
}

/**
 * The platform backend contract. `service.ts` depends ONLY on this; each
 * platform implements it. Backends return native-resolution data + typed
 * DesktopError on failure, and do NO model-facing formatting.
 */
export interface DesktopBackend {
  readonly platform: DesktopPlatform;
  /** Readiness/doctor. Must never throw — reports ready:false with a reason. */
  status(): Promise<DesktopStatus>;
  /** Enumerate displays + top-level windows. */
  windows(): Promise<{ displays: DisplayInfo[]; windows: WindowInfo[]; workarea: Rect | null; activeWindow: string | null }>;
  /** Capture at native resolution. */
  capture(req: CaptureRequest): Promise<RawCapture>;
  /** Pointer/keyboard input. Assumes a pre-validated request. */
  input(req: InputRequest): Promise<InputResult>;
  /** Window management. Re-queries state for the verified outcome. */
  windowAction(req: WindowActionRequest): Promise<WindowActionResult>;
}

# Desktop Automation — cross-platform `desktop_*` MCP tool family

**Date:** 2026-08-05 · **Status:** approved for implementation
**Owners:** Linux side + shared surface = `linux-automation` session (node 117, this repo checkout);
Windows backend = `win-automation` CCR session (node 107 / DESKTOP-GDKLATG, its own clone).

## 1. Goal

Give lm-assist full desktop control on every node with a real desktop, through ONE
platform-agnostic MCP tool surface:

- **See** the desktop: list displays + windows (id, title, app, geometry, state).
- **Read** the display: screenshots as JPEG/PNG sized for model consumption, with
  **region zoom** at native resolution when the overview is too small to read
  (a 4K screen downscaled to fit model image limits is legible at UI level but not
  at fine-text level — measured on 117), and paging/scrolling via repeated region
  captures.
- **Act**: pointer + keyboard input mirroring Anthropic's computer-use action
  vocabulary; window activate/close/minimize/maximize/restore/move/resize.

Same tool names, params, and response shapes on Linux (X11) and Windows. macOS,
Wayland, and headless nodes fail loudly with a typed error — never silently.

## 2. Research inputs (2026-08-05 survey)

- **Anthropic computer-use** (`computer_20251124`): action enum with
  `coordinate:[x,y]`, `start_coordinate`, `text`, `scroll_direction`/`scroll_amount`,
  `duration` (seconds), `region:[x1,y1,x2,y2]` zoom. Models are natively trained on
  THIS vocabulary — deviating (separate x/y fields, ms durations, renamed actions)
  forfeits that training. Reference impl: downscale toward ~XGA/WXGA, scale
  coordinates both ways, 2s settle before screenshots, type in 50-char chunks.
- **Linux survey**: healthiest native project (agent-sh/computer-use-linux) returns
  screenshot metadata (`coordinate_width/height`, `scale`) so the caller owns the
  coordinate math; caps payloads (1920px / 2 MiB); marks discovery tools
  `readOnlyHint` and input tools `destructiveHint`. X11 stack = xdotool + scrot/
  ffmpeg + wmctrl/EWMH. Wayland breaks all of it → detect and refuse loudly.
- **Windows survey**: accessibility-tree projects (Windows-MCP 6.6k★, terminator,
  FlaUI-MCP) lead the space, but for a no-new-runtime Node service the proven
  primitives are: DPI-aware helper (`SetProcessDpiAwarenessContext(-4)` FIRST),
  `CopyFromScreen` capture, `SendInput` (+`KEYEVENTF_UNICODE` for text),
  `EnumWindows`/`GetWindowRect` enumeration, `ShowWindow(SW_RESTORE)` →
  `SetForegroundWindow` with foreground-lock workaround. One long-lived PowerShell
  child with a JSON-lines loop (spawn-per-action costs 200-600ms). MCPControl's
  image defaults (resize 1280, jpeg q85) are the byte-economy precedent; its
  DPI-unaware coordinate bug is the cautionary tale.
- **This repo**: images ARE first-class MCP content (`{type:'image', data, mimeType}`
  — configure.ts:59-63, result-cap.ts:130-177 passes them through untruncated; the
  hub relays them as-is). Registration = the 10-step checklist in §8.
- **Host 117 probe**: GNOME 42.9 on Xorg `:0`, 3840×2160. Timings: ffmpeg one-shot
  full grab+scale+jpeg 0.15s; `scrot -a` region 0.02s; sharp (0.34.5, in repo)
  crop/resize/encode 35-43ms; ImageMagick 0.2-0.6s (avoid). GNOME Shell DBus
  screenshot is AccessDenied (allowlist) — irrelevant on X11. scrot omits cursor
  unless `-p`; ffmpeg draws it unless `-draw_mouse 0`.

## 3. Alternatives considered

1. **One `computer`-style mega-tool** (action enum incl. screenshot): most compact
   catalogue entry, but forces a single MCP scope — screenshots (read) and input
   (write) can't be gated separately. Rejected.
2. **Many fine-grained tools** (MCPControl: ~25): per-action safety, but the
   catalogue connect-time tax multiplies every description byte by every
   conversation. Rejected.
3. **Hybrid — 5 tools, reads/writes split, input tool carries the computer-use
   action enum verbatim** (chosen): read tools scope `read`, act tools scope
   `write`; native vocabulary preserved where it matters (pointer/keyboard).
4. **Accessibility-tree first** (AT-SPI/UIA snapshot with element refs): the
   strongest pattern in the wild, but heavy (toolkit bridges, surface-local coord
   caveats) and not what the goal needs first. Deferred to v2 as `desktop_snapshot`
   (name reserved); the backend interface keeps room for it.

## 4. Tool surface (the cross-platform contract)

Conventions for ALL tools:
- **Coordinates are physical desktop pixels, top-left origin, virtual-screen
  space** (Windows virtual screen may have negative origins on multi-monitor;
  never clamp). Every screenshot result states the exact image→desktop mapping.
- Every result leads with a **text block** (metadata/outcome); screenshots append
  an image block after it. Errors are typed: `{code, message}` with codes from §7.
- Window ids are the platform's native id rendered as a string (X11: `0x03600004`;
  Windows: decimal HWND). Ids come from `desktop_windows` and are passed back
  verbatim.
- No `node` param in any schema — the shared `withNodeParam` injection routes
  cross-node like every other tool.

### 4.1 `desktop_status` (read)
Doctor/readiness. No params.
Returns: `platform` (linux-x11 | linux-wayland | windows | unsupported), `ready`
bool, `reason` when not ready, display server info (session type, DISPLAY),
displays [{index, bounds{x,y,width,height}, scale, primary}], screen size,
workarea, active window {id, title}, cursor [x,y], backend inventory (which
binaries/helpers found), and `warnings[]` — MUST include a shared-display warning
when the node also runs CDP browser connectors (Gmail/LinkedIn drive a real
Chrome on the same display; synthesized input can interfere — one-writer rule).

### 4.2 `desktop_windows` (read)
List displays + windows. No params (always full detail; window counts are small).
Returns text table: displays as in status; windows [{id, title, app (WM_CLASS /
exe name), pid, display, desktop/workspace, bounds{x,y,width,height}, state
(active|minimized|maximized|normal), layer notes}], active window id, workarea.
Cap 100 windows with an explicit `truncated` note (never a silent cap).

### 4.3 `desktop_screenshot` (read)
Read the display. Params (all optional):
- `region: [x1,y1,x2,y2]` — desktop-px rectangle, **native-resolution zoom** (the
  computer-use `zoom` convention). x1<x2, y1<y2, non-negative ints on Linux;
  Windows allows negatives (virtual screen).
- `window: string` — capture that window's bounds (occlusion note: capture is a
  screen crop, not a compositor redirect; an overlapped window shows what's on
  top. Activate it first for a clean read).
- `display: number` — display index (default: primary / the X screen).
- `max_px: number` — long-edge cap of the RETURNED image. Default **1568**
  (safe across models), allowed 256–2576.
- `format: 'jpeg'|'png'` — default: **png when the output area ≤ ~1.2 MP**
  (crisp zoom), else **jpeg** (byte economy). `quality: 1-100` (jpeg, default 85).
- `cursor: boolean` — draw pointer (default true).

Result text block (JSON): `{platform, display, screen:{width,height},
capture:{x,y,width,height}, image:{width,height}, scale, format, cursor}` plus one
fixed sentence: `image pixel (u,v) → desktop pixel (capture.x + round(u/scale),
capture.y + round(v/scale))`. Then the image block.
**Scrolling a too-large display** = repeated `region` calls; the tool description
tells the model: overview first, then zoom regions of interest (matches the
computer-use zoom pattern the models already know).
Image bytes are kept ≤ ~700 KB base64 (downscale/quality enforce this server-side)
— survey shows ~1 MB is where MCP clients start choking.

### 4.4 `desktop_window` (write)
Manage one window. Params: `window` (required), `action` (required):
`activate | close | minimize | maximize | restore | move | resize`,
plus `x,y` (move) / `width,height` (resize) — ints, desktop px.
Returns the window's re-queried state+bounds after the action (verified outcome,
never assumed — `requested` vs `resulting` both reported; a failed verify is
reported as UNVERIFIED, not success). `close` is polite close
(`_NET_CLOSE_WINDOW` / `WM_CLOSE`), never a process kill.

### 4.5 `desktop_input` (write)
Pointer/keyboard in the computer-use vocabulary. Params:
- `action` (required): `left_click | right_click | middle_click | double_click |
  triple_click | left_click_drag | left_mouse_down | left_mouse_up | mouse_move |
  type | key | hold_key | scroll | cursor_position`
- `coordinate: [x,y]` — required for clicks/`mouse_move`/drag end/`scroll` anchor.
- `start_coordinate: [x,y]` — `left_click_drag` origin.
- `text: string` — the text for `type`; xdotool-style key/combo for `key`/
  `hold_key` (`ctrl+s`, `Return`, `Page_Down`, `alt+Tab`, `super`); the held
  modifier for click/scroll actions (`shift`, `ctrl`, `alt`, `super`).
- `scroll_direction: up|down|left|right` + `scroll_amount: int ≥ 0` (wheel clicks).
- `duration: number` — seconds 0–100 (`hold_key`).
- `window: string` — optional: activate this window first (convenience; saves a
  round-trip; small settle delay after activation).
- `screenshot_after_ms: number` — optional 0–10000: after the action, wait N ms
  and append a downscaled screenshot to the result (click-and-verify without a
  second call).

Validation mirrors the computer-use reference: `coordinate` = exactly 2
non-negative ints (Windows: ints; may be negative in virtual-screen space);
required-param errors name the action (`coordinate is required for left_click`);
`text` rejected on actions that don't accept it. `type` is chunked (50 chars,
~12ms/key). **`type`/`key` go to the FOCUSED window** — the description says so
and recommends `window` or a prior click.
`cursor_position` returns `[x,y]` desktop px (no mutation — kept here for
vocabulary parity; also reported by `desktop_status`).

## 5. Architecture

```
core/src/desktop/
  config.ts         deployment facts only: tmp dir (~/.lm-assist/desktop[-dev]/tmp),
                    defaults (max_px 1568, jpeg 85, caps), dev/prod split
  types.ts          DesktopBackend interface, request/response shapes, error codes
  service.ts        THE single import surface (gmail cdp-client pattern):
                    backend selection + caching, arg validation, bounded
                    single-flight mutex for input/window writes (queue cap +
                    timeout — never unbounded), sharp post-processing
                    (crop/downscale/encode), byte-ceiling enforcement
  x11-backend.ts    Linux: spawns xdotool/wmctrl/scrot/ffmpeg with DISPLAY
                    autodetect (X socket scan + XDG_SESSION_TYPE guard);
                    parsers for wmctrl -lGpx / xdotool --shell / xprop EWMH
  win32-backend.ts  v1: typed stub throwing DESKTOP_UNSUPPORTED("win32 backend
                    lands with the Windows implementation — see §9").
                    Replaced wholesale by the win-automation session.
core/src/routes/core/desktop.routes.ts   REST: single source of truth
core/src/mcp-server/tools/desktop.ts     MCP defs + handlers (loopback via
                                         _passthrough workerGet/workerPost)
```

- **Backend contract**: backends return NATIVE-RESOLUTION captures (PNG buffer +
  capture geometry); `service.ts` does all downscale/encode via sharp so both
  platforms share one image pipeline. Backends never do model-facing formatting.
- **REST routes** (`GET /desktop/status`, `GET /desktop/windows`,
  `POST /desktop/screenshot`, `POST /desktop/window`, `POST /desktop/input`)
  use the connector envelope (`{success,data} | {success:false,error:{code,
  message}}`) to preserve typed codes; screenshot rides as base64 JSON on the
  route and becomes a real MCP image block in the tool handler.
- **Process hygiene**: every spawn has a kill-on-expiry timeout (capture 10s,
  input 5s, window 5s); all-async (no execSync — Core event-loop rule);
  `_passthrough` handler types widen to the image-bearing McpToolResult from
  configure.ts (the local text-only interface is too narrow — known).
- **Sharp**: promote to an explicit `core` dependency (already resolves at root,
  0.34.5, native binding verified on 117). Windows must verify its platform
  binding during e2e; System.Drawing pre-scaling in the helper is the fallback.

## 6. Linux backend mapping (117-verified primitives)

| Operation | Primitive |
|---|---|
| detect | `XDG_SESSION_TYPE`/X socket scan; wayland → `DESKTOP_UNSUPPORTED` (loud) |
| displays | `xrandr --query` (single X screen = display 0 v1) |
| list windows | `wmctrl -l -G -p -x` + `xprop -root _NET_ACTIVE_WINDOW` + per-window `_NET_WM_STATE`; workarea `_NET_WORKAREA` |
| full capture | `ffmpeg -f x11grab -video_size WxH -i :0 -frames:v 1` (0.15s, cursor default) or `scrot -o -z [-p]` fallback |
| region capture | `scrot -o -z -a X,Y,W,H` (0.02s) — native res |
| activate/close | `wmctrl -i -a` / `wmctrl -i -c` |
| min/max/restore | `xdotool windowminimize` / `wmctrl -b add,maximized_vert,maximized_horz` / `-b remove,...` (+`hidden` remove) |
| move/resize | `wmctrl -i -r -e 0,x,y,w,h` (gravity 0) |
| pointer | `xdotool mousemove --sync` / `click` / `mousedown/mouseup` (buttons: 1 left, 2 middle, 3 right; wheel: 4 up / 5 down / 6 left / 7 right × amount) |
| drag | `mousemove --sync` → `mousedown 1` → stepped `mousemove --sync` → `mouseup 1` |
| modifier-click | `keydown <mod>` → click → `keyup <mod>` |
| type | `xdotool type --delay 12 --` in 50-char chunks |
| key/hold | `xdotool key --` / `keydown` + sleep + `keyup` |
| cursor | `xdotool getmouselocation --shell` |

Environment: `DISPLAY=:N` only (same-uid Xorg; no XAUTHORITY gymnastics on 117 —
but pass `XAUTHORITY` through when the autodetect finds one, for gdm variants).

## 7. Error codes (shared)

`DESKTOP_UNSUPPORTED` (platform/session can't do desktops — message says why and
what would make it work) · `NO_DISPLAY` (no X server / no interactive session) ·
`TOOL_MISSING` (named binary absent — message names the apt package) ·
`BAD_WINDOW` (id unknown/stale) · `BAD_ARGS` (validation; names the param+action) ·
`CAPTURE_FAILED` · `INPUT_FAILED` · `WINDOW_ACTION_FAILED` (with UNVERIFIED
semantics when the action ran but verify failed) · `BACKEND_TIMEOUT` ·
`WINDOWS_SESSION0` (Windows only: Core not in the interactive session — reuse
windows-session-guard detection) · `BUSY` (single-flight queue full/timed out).

## 8. Registration checklist (repo-verified, apply in this order)

1. Module `core/src/desktop/` (§5).
2. Routes file + register in `routes/core/index.ts`.
3. `tools/desktop.ts`: defs (annotations: `readOnlyHint:true` on status/windows/
   screenshot) + handlers; export `DESKTOP_TOOL_DEFS`/`DESKTOP_HANDLERS`.
4. Spread both into `tools/expanded.ts` (EXPANDED_TOOL_DEFS / EXPANDED_HANDLERS).
5. `configure.ts` TOOL_SCOPES: status/windows/screenshot `read`; window/input
   `write`. **Missing entry = Core crash on first tools/list.**
6. `registry/catalog.ts`: `mod('desktop.ts','desktop',[...5 names])` + add
   `desktop` to CATEGORY_ORDER.
7. `tool-output-budget.ts`: status/windows/screenshot → MEASURED (text bytes;
   images deliberately uncounted by design); window/input → NOT_MEASURED
   (write tools). Screenshot text must stay small; the tool has narrowing args
   (`region`, `max_px`) so the truncation ratchet is satisfied.
8. NOT in TOPIC_TOOLS (ungated by the bootstrap gate — gmail/linkedin precedent;
   avoids seam-test hangs). Guide topic deferred.
9. Tests: full `cd core && npm test` (one run at a time); new pure tests for
   parsers/arg-builders/validation; handler test in mcp-expanded-handlers style;
   live-Core checks (output-size, tools/list) against dev :3200.
10. `./core.sh build && ./core.sh restart` (dev) → verify tools/list + calls →
    later `refresh_connector_tools` + fresh claude.ai session to surface.

## 9. Windows implementation protocol (for the win-automation session, node 107)

**You own:** `core/src/desktop/win32-backend.ts` (replace the stub) + a helper
script `core/scripts/desktop-helper.ps1` (or `core/src/desktop/win32/` if you
split) + Windows-only tests. **Do not edit** the shared files (types.ts,
service.ts, routes, tools/desktop.ts, expanded/configure/catalog/budget) — if the
contract needs a change, report back and the linux-automation session amends it
fleet-wide. This split exists so two sessions on two machines can't cross-clobber.

Requirements:
- Implement `DesktopBackend` exactly (types.ts is the contract; native-res PNG +
  geometry out, service does the rest).
- ONE long-lived PowerShell helper child (JSON-lines stdin/stdout), spawned lazily,
  restarted on death; declare DPI awareness (`SetProcessDpiAwarenessContext(-4)`,
  fallback `SetProcessDPIAware`) BEFORE any capture/measure call.
- Capture: `Graphics.CopyFromScreen` over virtual-screen bounds (negatives legal)
  / per-display via `[Screen]::AllScreens`; region = direct sub-rect copy.
- Windows enum: `EnumWindows` + `IsWindowVisible` + `GetWindowTextW` +
  `GetWindowRect` + `GetWindowThreadProcessId`; class via `GetClassName`;
  state via `IsIconic`/`IsZoomed`; displays with bounds + per-monitor scale
  (`GetDpiForMonitor`) — the DisplayInventory idea.
- Input: `SetCursorPos` + `SendInput` mouse events (`MOUSEEVENTF_VIRTUALDESK`
  when absolute); text via `SendInput` `KEYEVENTF_UNICODE` (never SendKeys for
  text); combos via virtual-key down/up sequences; map the xdotool-style names
  from §4.5 (`ctrl+s`, `Return`, `Page_Down`, `alt+Tab`, `super` = Win key).
- Window actions: `ShowWindow` (SW_RESTORE/SW_MINIMIZE/SW_MAXIMIZE) +
  `SetForegroundWindow` with the foreground-lock workaround; `close` =
  `WM_CLOSE` post, never TerminateProcess.
- Guard: interactive-session check (reuse windows-session-guard) →
  `WINDOWS_SESSION0` error when Core can't see the desktop.
- e2e on 107's real desktop before reporting done: status → windows → screenshot
  (overview + region zoom readable) → activate + move a window → type into
  Notepad → verify via screenshot. Then `./core.sh build`, full `npm test`, and
  deploy per the repo's build/pack docs.

## 10. Safety

- Read tools are `read`-scoped and annotated read-only; input/window tools are
  `write`-scoped — claude.ai approval gating applies per tool.
- Shared-display coordination: `desktop_status.warnings` names the CDP-driven
  browsers on this display; tool descriptions carry a one-line caution. The
  single-flight mutex serializes desktop writes within a node; it does NOT
  coordinate with CDP connectors (documented limitation, revisit if bites).
- Screenshots can capture sensitive content (the 117 display shows a signed-in
  mailbox); results are data for the calling conversation — same trust model as
  gmail_* reads. No screenshot persistence beyond the tmp file (best-effort
  cleanup, bounded dir).
- No destructive verbs: no process kill, no logoff/shutdown, `close` is polite.

## 11. Testing

- **Pure unit** (both platforms, CI-safe): wmctrl/xprop/xdotool output parsers
  against fixture strings; arg-builder correctness (incl. negative-coordinate
  refusal on Linux); validation matrix per action; helper JSON-line protocol
  codec (win32).
- **Handler**: stubbed loopback fetch → URL/body/isError mapping; image block
  pass-through (text-first ordering preserved).
- **Live e2e (Linux, this session)**: against dev :3200 with the real `:0` —
  the §9 e2e sequence, plus: 4K overview legibility, region zoom on small text,
  scroll-by-regions across a tall window, input into a scratch text editor
  (never into the Gmail Chrome), window move/resize/restore round-trip verified
  by re-query + screenshot.
- **Live e2e (Windows, 107 session)**: §9 sequence.
- Suite discipline: one `npm test` at a time (runner kills concurrent runs).

## 12. Future (explicitly out of v1)

`desktop_snapshot` accessibility tree (AT-SPI / UIA) with element refs and
click-by-ref; clipboard tools; app launch; Wayland portals (+ ydotool);
multi-X-screen; OCR-assisted targeting; persistent capture stream.

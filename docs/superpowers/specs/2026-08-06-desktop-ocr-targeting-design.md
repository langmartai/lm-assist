# Desktop OCR-anchored element targeting — `desktop_find_text` + `desktop_click_text`

**Date:** 2026-08-06 · **Status:** approved for implementation
**Owners:** Linux + shared service = this session (117). Windows = tesseract install + redeploy on 107 (win-automation CCR); **no Windows code** (backend-free).

## 1. Goal

Let a model click/read a UI element by its **visible text label** instead of hunting pixels — the pragmatic "click by element" for the `desktop_*` family. Chosen over an AT-SPI/UIA accessibility tree after a feasibility probe (2026-08-06): on 117 AT-SPI is disabled, has no Python/Node bindings, and Chrome/Electron won't export a tree — whereas OCR works on **any visible app, cross-platform, with no accessibility deps**.

## 2. Feasibility (measured on 117)

`tesseract 5.x` reads UI text with word-level boxes + confidence via `--psm 11 tsv` (verified: "Activities" @ (18,8), "Google chrome" @ (140,7), conf 82-94). Runs on Linux and Windows. The existing `backend.capture` already yields a native-resolution PNG, so OCR needs **no new backend method** — same pattern as `desktop_wait_for`.

## 3. Tools

### `desktop_find_text` (read)
OCR the screen/region/window; return recognized text with locations.
- Args (all optional): `query` (case-insensitive substring filter; omit → all text), `region:[x1,y1,x2,y2]`, `window` (OCR that window's bounds), `min_confidence` (default 50, 0-100).
- Returns: `matches[]` grouped into **lines** (a label/menu item is a line, not one word): `{ text, confidence, bounds:{x,y,width,height}, center:[x,y] }` in **desktop pixels**; plus `screen`, `capture`, `total`, `truncated`. Capped at `MAX_TEXT_MATCHES=60`, reading order (top→bottom, left→right). Doubles as "read the text on screen."

### `desktop_click_text` (write)
Find the label **fresh, then click its center** — re-OCRs immediately before clicking so the coordinate can't go stale.
- Args: `text` (required), `index` (which match when several, default 0), `match` (`substring`|`exact`, default substring, case-insensitive), `button` (`left`|`right`|`middle`, default left), `double` (bool), `window` (scope), `screenshot_after_ms` (0-10000, verify).
- Returns: `{ clicked:{text,center}, candidates:N, index }` (+ optional image block). No match → typed error listing the closest recognized lines (near-misses) so the caller can adjust.

**Why coordinates, not durable refs:** an OCR result is a moment in time; a "ref" that resolves later would silently drift. So `find_text` returns live coordinates, and `click_text` re-OCRs atomically — honest about what OCR can and can't promise.

## 4. Architecture

Backend-free, in `core/src/desktop/service.ts` (like `wait_for`):
1. `backend.capture({region|window})` → native-res PNG + capture Rect.
2. Write PNG to `DESKTOP_TMP_DIR`; run `tesseract <png> stdout --psm 11 tsv` (async, timeout, killed on expiry).
3. `parseTsvLines(tsv, minConf)` (pure, unit-tested): drop words below `minConf`; group words by `(block,par,line)`; line text = words joined by space; line bbox = union of word bboxes; line conf = mean word conf.
4. Map image px → desktop px: `desktop = capture.origin + imagePx` (native res, scale 1).
5. Filter by `query`/`text`, sort reading-order, cap.
6. `click_text`: pick the match at `index`, `backend.input(left_click, center)` under the existing write mutex; optional post-screenshot.

Missing tesseract → `TOOL_MISSING` naming the package (`sudo apt-get install tesseract-ocr` / Windows: UB-Mannheim installer or `choco install tesseract`). No `DesktopBackend` interface change.

## 5. Registration (repo checklist)

`types.ts` (a small `OcrMatch` result type; no backend method) · `service.ts` (`desktopFindText`, `desktopClickText`, `parseTsvLines`) · `desktop.routes.ts` (`GET /desktop/find-text`, `POST /desktop/click-text`) · `tools/desktop.ts` (2 defs + handlers) · spread into `expanded.ts` · `configure.ts` TOOL_SCOPES (`desktop_find_text`=read, `desktop_click_text`=write) · `registry/catalog.ts` mod list · `tool-output-budget.ts` (find_text MEASURED ~5 KB capped; click_text NOT_MEASURED write) · `guide.ts` desktop topic (mention text-targeting as the robust menu/button path) · catalogue connect-time budget (2 lean tools — trim/bump if needed).

## 6. Testing

- **Unit:** `parseTsvLines` against a fixture tsv (word grouping into lines, conf filter, bbox union); image→desktop coord mapping.
- **Handler:** stubbed loopback → URL/body/isError mapping; near-miss error path.
- **Live e2e (Linux 117):** `find_text` over a real UI (assert known labels + plausible boxes); `desktop_click_text` on a known button/menu label → verify by screenshot that the click landed.
- **Live e2e (Windows 107):** after tesseract install + redeploy — `find_text` + `click_text` on a real Win11 app, verified by screenshot pulled to 117.
- Full suite green; one `npm test` at a time.

## 7. Windows coordination

No code. The win-automation CCR session: install tesseract on 107, redeploy main, run the Windows e2e above, report. `desktop_find_text`/`desktop_click_text` return `TOOL_MISSING` on 107 until tesseract is present.

## 8. Out of scope

AT-SPI/UIA semantic tree (roles, icons, off-screen elements, set-value) — deferred until a case needs what OCR can't do; UIA-on-Windows would be the first step there.

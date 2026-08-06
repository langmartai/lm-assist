import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_HANDLERS, DESKTOP_TOOL_DEFS } from '../../mcp-server/tools/desktop';
import { EXPANDED_HANDLERS, EXPANDED_TOOL_DEFS } from '../../mcp-server/tools/expanded';
import { TOOL_SCOPES, assertScopesCoverTools } from '../../mcp-server/configure';

/**
 * desktop_* MCP tools — thin loopback wrappers over /desktop/*. Verify each
 * handler hits the right route with the right body, maps a route failure to an
 * isError result, and — critically — that desktop_screenshot returns a real MCP
 * IMAGE block (base64 data + mimeType) led by a text block, since the whole
 * point is Claude SEEING the screen.
 */

const realFetch = global.fetch;
let lastUrl = '';
let lastBody: Record<string, unknown> | null = null;

function stubFetch(payload: Record<string, unknown>, ok = true, status = 200): void {
  const text = JSON.stringify(payload);
  // @ts-expect-error - test stub
  global.fetch = async (url: string, opts?: { body?: string }) => {
    lastUrl = String(url);
    lastBody = opts?.body ? JSON.parse(opts.body) : null;
    return { ok, status, async text() { return text; }, async json() { return payload; } };
  };
}

afterEach(() => {
  global.fetch = realFetch;
  lastUrl = '';
  lastBody = null;
});

test('all ten tools are registered, scoped, and flow into the expanded surface', () => {
  const names = DESKTOP_TOOL_DEFS.map((t) => t.name);
  assert.deepStrictEqual(names.sort(), ['desktop_click_text', 'desktop_clipboard', 'desktop_find_text', 'desktop_input', 'desktop_process', 'desktop_screenshot', 'desktop_status', 'desktop_wait_for', 'desktop_window', 'desktop_windows']);
  for (const n of names) {
    assert.ok(n in DESKTOP_HANDLERS, `${n} has no handler`);
    assert.ok(n in TOOL_SCOPES, `${n} has no scope`);
    assert.ok(EXPANDED_TOOL_DEFS.some((d) => d.name === n), `${n} not in EXPANDED_TOOL_DEFS`);
    assert.ok(n in EXPANDED_HANDLERS, `${n} not in EXPANDED_HANDLERS`);
  }
  // reads are read-scoped, writes are write-scoped
  assert.strictEqual(TOOL_SCOPES.desktop_status, 'read');
  assert.strictEqual(TOOL_SCOPES.desktop_windows, 'read');
  assert.strictEqual(TOOL_SCOPES.desktop_screenshot, 'read');
  assert.strictEqual(TOOL_SCOPES.desktop_process, 'read');
  assert.strictEqual(TOOL_SCOPES.desktop_wait_for, 'read');
  assert.strictEqual(TOOL_SCOPES.desktop_find_text, 'read');
  assert.strictEqual(TOOL_SCOPES.desktop_window, 'write');
  assert.strictEqual(TOOL_SCOPES.desktop_input, 'write');
  assert.strictEqual(TOOL_SCOPES.desktop_clipboard, 'write');
  assert.strictEqual(TOOL_SCOPES.desktop_click_text, 'write');
  // and the boot-time guard is satisfied (this is what crashes Core if a scope is missing)
  assert.doesNotThrow(() => assertScopesCoverTools());
});

test('desktop_find_text lists recognized lines with their click centers', async () => {
  stubFetch({ success: true, data: { screen: { width: 3840, height: 2160 }, capture: { x: 0, y: 0, width: 3840, height: 2160 }, total: 2, truncated: false, matches: [
    { text: 'Compose', confidence: 95, bounds: { x: 40, y: 170, width: 90, height: 20 }, center: [85, 180] },
    { text: 'Inbox', confidence: 92, bounds: { x: 40, y: 220, width: 60, height: 18 }, center: [70, 229] },
  ] } });
  const r = await DESKTOP_HANDLERS.desktop_find_text({ query: 'compose' });
  assert.match(lastUrl, /\/desktop\/find-text$/);
  assert.deepStrictEqual(lastBody, { query: 'compose' });
  assert.match(r.content[0].text as string, /\(85,180\)\s+"Compose"/);
});

test('desktop_click_text reports what it clicked, and can return a verify image', async () => {
  stubFetch({ success: true, data: { clicked: { text: 'Compose', center: [85, 180] }, candidates: 1, index: 0 } });
  let r = await DESKTOP_HANDLERS.desktop_click_text({ text: 'Compose' });
  assert.match(lastUrl, /\/desktop\/click-text$/);
  assert.strictEqual(lastBody!.text, 'Compose');
  assert.match(r.content[0].text as string, /Clicked "Compose" at \(85,180\)/);
  stubFetch({ success: true, data: { clicked: { text: 'Save', center: [10, 20] }, candidates: 2, index: 0, screenshot: { meta: { image: { width: 1568, height: 882 }, format: 'jpeg', mapping: 'm' }, base64: 'ZZZ', mimeType: 'image/jpeg' } } });
  r = await DESKTOP_HANDLERS.desktop_click_text({ text: 'Save', screenshot_after_ms: 400 });
  assert.strictEqual(r.content.length, 2);
  assert.strictEqual(r.content[1].type, 'image');
  assert.match(r.content[0].text as string, /match 1 of 2/);
});

test('desktop_click_text surfaces a no-match error with near-misses', async () => {
  stubFetch({ success: false, error: 'no on-screen text contained "Nope". Recognized nearby: "Compose", "Inbox"', code: 'BAD_ARGS' });
  const r = await DESKTOP_HANDLERS.desktop_click_text({ text: 'Nope' });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text as string, /Recognized nearby/);
});

test('desktop_process renders the heaviest-first table from /desktop/process', async () => {
  stubFetch({ success: true, data: { query: 'chrome', total: 2, processes: [
    { pid: 771, name: 'google-chrome', cpu: 3.4, memMiB: 1024, user: 'ubuntu' },
    { pid: 812, name: 'chrome-sandbox', cpu: 0.1, memMiB: 40, user: 'ubuntu' },
  ] } });
  const r = await DESKTOP_HANDLERS.desktop_process({ query: 'chrome' });
  assert.match(lastUrl, /\/desktop\/process\?query=chrome/);
  assert.match(r.content[0].text as string, /google-chrome/);
  assert.match(r.content[0].text as string, /matching "chrome"/);
});

test('desktop_clipboard get/set map to /desktop/clipboard and report bytes', async () => {
  stubFetch({ success: true, data: { mode: 'set', bytes: 12 } });
  let r = await DESKTOP_HANDLERS.desktop_clipboard({ mode: 'set', text: 'hello clip42' });
  assert.match(lastUrl, /\/desktop\/clipboard$/);
  assert.deepStrictEqual(lastBody, { mode: 'set', text: 'hello clip42' });
  assert.match(r.content[0].text as string, /Clipboard set \(12 bytes\)/);
  stubFetch({ success: true, data: { mode: 'get', text: 'copied text' } });
  r = await DESKTOP_HANDLERS.desktop_clipboard({ mode: 'get' });
  assert.match(r.content[0].text as string, /copied text/);
});

test('desktop_wait_for reports a found window or a timeout', async () => {
  stubFetch({ success: true, data: { found: true, waitedMs: 850, window: { id: '0x1', title: 'Untitled - Notepad', app: 'Notepad', state: 'active', bounds: { x: 0, y: 0, width: 800, height: 600 } } } });
  let r = await DESKTOP_HANDLERS.desktop_wait_for({ title: 'Notepad' });
  assert.match(lastUrl, /\/desktop\/wait$/);
  assert.match(r.content[0].text as string, /Found after 850ms.*Notepad/);
  stubFetch({ success: true, data: { found: false, waitedMs: 10000, window: null } });
  r = await DESKTOP_HANDLERS.desktop_wait_for({ title: 'Nope' });
  assert.match(r.content[0].text as string, /Timed out after 10000ms/);
});

test('desktop_status renders the readiness table from /desktop/status', async () => {
  stubFetch({ success: true, data: {
    platform: 'linux-x11', ready: true, sessionType: 'x11', display: ':0',
    screen: { width: 3840, height: 2160 }, displays: [{}], activeWindow: { id: '0x1', title: 'Term' },
    cursor: [10, 20], backends: { scrot: true, xdotool: true }, warnings: ['a browser shares this display'],
  } });
  const r = await DESKTOP_HANDLERS.desktop_status({});
  assert.match(lastUrl, /\/desktop\/status$/);
  const text = r.content[0].text as string;
  assert.match(text, /READY/);
  assert.match(text, /3840x2160/);
  assert.match(text, /browser shares this display/);
});

test('desktop_screenshot returns a text block THEN an image block', async () => {
  stubFetch({ success: true, data: {
    meta: {
      platform: 'linux-x11', display: 0, screen: { width: 3840, height: 2160 },
      capture: { x: 0, y: 0, width: 3840, height: 2160 }, image: { width: 1568, height: 882 },
      scale: 0.4083, format: 'jpeg', cursor: true, mapping: 'image pixel (u,v) → desktop pixel ...',
    },
    base64: 'AAAA', mimeType: 'image/jpeg',
  } });
  const r = await DESKTOP_HANDLERS.desktop_screenshot({ region: [0, 0, 100, 100] });
  assert.match(lastUrl, /\/desktop\/screenshot$/);
  assert.deepStrictEqual(lastBody, { region: [0, 0, 100, 100] });
  assert.strictEqual(r.content.length, 2);
  assert.strictEqual(r.content[0].type, 'text');
  assert.match(r.content[0].text as string, /Screenshot/);
  assert.strictEqual(r.content[1].type, 'image');
  assert.strictEqual((r.content[1] as { data: string }).data, 'AAAA');
  assert.strictEqual((r.content[1] as { mimeType: string }).mimeType, 'image/jpeg');
});

test('desktop_input forwards the action + coordinate and reports the outcome', async () => {
  stubFetch({ success: true, data: { result: { action: 'left_click', ok: true } } });
  const r = await DESKTOP_HANDLERS.desktop_input({ action: 'left_click', coordinate: [100, 200] });
  assert.match(lastUrl, /\/desktop\/input$/);
  assert.strictEqual(lastBody!.action, 'left_click');
  assert.deepStrictEqual(lastBody!.coordinate, [100, 200]);
  assert.match(r.content[0].text as string, /left_click: ok/);
});

test('desktop_input can return a screenshot-after image block', async () => {
  stubFetch({ success: true, data: {
    result: { action: 'left_click', ok: true },
    screenshot: { meta: { image: { width: 1568, height: 882 }, format: 'jpeg', mapping: 'm' }, base64: 'BBBB', mimeType: 'image/jpeg' },
  } });
  const r = await DESKTOP_HANDLERS.desktop_input({ action: 'left_click', coordinate: [1, 2], screenshot_after_ms: 500 });
  assert.strictEqual(r.content.length, 2);
  assert.strictEqual(r.content[1].type, 'image');
  assert.strictEqual((r.content[1] as { data: string }).data, 'BBBB');
});

test('a route failure becomes an isError result with the code', async () => {
  stubFetch({ success: false, error: 'No X display', code: 'NO_DISPLAY' });
  const r = await DESKTOP_HANDLERS.desktop_screenshot({});
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text as string, /No X display/);
  assert.match(r.content[0].text as string, /NO_DISPLAY/);
});

test('desktop_window reports VERIFIED / UNVERIFIED honestly', async () => {
  stubFetch({ success: true, data: {
    window: '0x1', action: 'maximize', verified: true,
    resulting: { id: '0x1', title: 'App', state: 'maximized', bounds: { x: 0, y: 0, width: 3840, height: 2160 } },
  } });
  const r = await DESKTOP_HANDLERS.desktop_window({ window: '0x1', action: 'maximize' });
  assert.match(lastUrl, /\/desktop\/window$/);
  assert.match(r.content[0].text as string, /VERIFIED/);
  assert.match(r.content[0].text as string, /maximized/);
});

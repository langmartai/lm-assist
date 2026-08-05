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

test('all five tools are registered, scoped, and flow into the expanded surface', () => {
  const names = DESKTOP_TOOL_DEFS.map((t) => t.name);
  assert.deepStrictEqual(names.sort(), ['desktop_input', 'desktop_screenshot', 'desktop_status', 'desktop_window', 'desktop_windows']);
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
  assert.strictEqual(TOOL_SCOPES.desktop_window, 'write');
  assert.strictEqual(TOOL_SCOPES.desktop_input, 'write');
  // and the boot-time guard is satisfied (this is what crashes Core if a scope is missing)
  assert.doesNotThrow(() => assertScopesCoverTools());
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

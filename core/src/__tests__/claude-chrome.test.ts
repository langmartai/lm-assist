import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeMgr, ChromeMgrError } from '../voice/claude-chrome';

// ensureLoaded's real ~9s CF-settle wait is a production requirement, not something a unit
// test should pay for on every run — set before any test calls ensureLoaded. Read at call
// time (not module load) inside claude-chrome.ts, so this takes effect for the whole file.
process.env.VOICE_CHROME_SETTLE_MS = '0';

// Brief's Step 1 test, verbatim — the mandatory RED/GREEN case (browser reuse across
// ensureLoaded calls). Everything below extends coverage to the rest of the ChromeMgr
// interface, using the same injected-fake pattern so no test ever touches real Chrome.
test('reuses one browser across ensureLoaded calls', async () => {
  let launches = 0;
  const fakePage = { evaluate: async () => null, close: async () => {}, on: () => {}, setCookie: async () => {}, goto: async () => {}, addScriptToEvaluateOnNewDocument: async () => {}, addStyleTag: async () => {} };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, process: () => ({}) };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => { launches++; return fakeBrowser as any; } });
  await mgr.ensureLoaded('sessionKey=x');
  await mgr.ensureLoaded('sessionKey=x');
  assert.equal(launches, 1);
});

// A fresh fake page for the openVoicePage tests — needs evaluateOnNewDocument (the real
// puppeteer-core Page method; see task-4-report.md for why this differs from the brief's
// literal "addScriptToEvaluateOnNewDocument", which is the CDP wire name, not a Page method).
function makeVoicePageFake(calls: string[]) {
  return {
    evaluate: async (_src: unknown) => { calls.push('evaluate'); return null; },
    close: async () => { calls.push('close'); },
    on: () => {},
    setCookie: async () => {},
    goto: async () => { calls.push('goto'); },
    evaluateOnNewDocument: async (_fn: unknown, ..._args: unknown[]) => { calls.push('evaluateOnNewDocument'); },
  };
}

test('openVoicePage registers the globals via evaluateOnNewDocument, THEN navigates, THEN injects the relay asset', async () => {
  const calls: string[] = [];
  const fakePage = makeVoicePageFake(calls);
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, process: () => ({}) };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  await mgr.openVoicePage('wss://claude.ai/voice', 'wss://127.0.0.1/bridge');
  // Order matters: the relay asset (claude-ws-relay.js) reads window.__VOICE_URL__/__BRIDGE_URL__
  // synchronously at injection time — if evaluateOnNewDocument ran after the asset, the asset
  // would throw `new WebSocket(undefined)`.
  assert.deepEqual(calls, ['evaluateOnNewDocument', 'goto', 'evaluate']);
});

test('openVoicePage passes voiceUrl/bridgeUrl through to the globals setter, and injects the real relay asset', async () => {
  let globalsArgs: unknown[] = [];
  let injectedSource = '';
  const fakePage = {
    evaluate: async (src: unknown) => { injectedSource = String(src); return null; },
    close: async () => {},
    on: () => {},
    setCookie: async () => {},
    goto: async () => {},
    evaluateOnNewDocument: async (_fn: unknown, ...args: unknown[]) => { globalsArgs = args; },
  };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, process: () => ({}) };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  await mgr.openVoicePage('wss://VOICE-URL', 'wss://BRIDGE-URL');
  assert.deepEqual(globalsArgs, ['wss://VOICE-URL', 'wss://BRIDGE-URL']);
  // Sanity check we loaded Task 3's actual asset off disk, not a stub — look for a
  // recognizable symbol from core/src/voice/assets/claude-ws-relay.js.
  assert.match(injectedSource, /__VOICE_URL__/);
  assert.match(injectedSource, /__page_status/);
});

test('openVoicePage returns the live page (caller owns close(), not torn down on success)', async () => {
  const calls: string[] = [];
  const fakePage = makeVoicePageFake(calls);
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, process: () => ({}) };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  const page = await mgr.openVoicePage('v', 'b');
  assert.equal(calls.includes('close'), false);
  assert.equal(typeof page.evaluate, 'function');
  assert.equal(typeof page.close, 'function');
  assert.equal(typeof page.on, 'function');
});

test('ensureLoaded parses "name=value; name2=value2" into setCookie pairs scoped to https://claude.ai', async () => {
  let captured: unknown[] = [];
  const fakePage = {
    evaluate: async () => null, close: async () => {}, on: () => {}, goto: async () => {}, evaluateOnNewDocument: async () => {},
    setCookie: async (...cookies: unknown[]) => { captured = cookies; },
  };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, process: () => ({}) };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  await mgr.ensureLoaded('sessionKey=sk-ant-abc; lastActiveOrg=org-123');
  assert.deepEqual(captured, [
    { name: 'sessionKey', value: 'sk-ant-abc', url: 'https://claude.ai' },
    { name: 'lastActiveOrg', value: 'org-123', url: 'https://claude.ai' },
  ]);
});

// A signal-killed process (SIGKILL, OOM) leaves exitCode === null too — it sets signalCode
// instead — so a process().exitCode-only check would misreport a signal-crashed Chrome as
// "alive" and hand back a dead browser reference. Real puppeteer-core's Browser emits
// 'disconnected' whenever its CDP transport closes, which covers crash/signal-kill/clean
// close uniformly (verified against node_modules/puppeteer-core/lib/esm/puppeteer/cdp/{Connection,Browser}.js:
// transport 'close' -> Connection emits CDPSessionEvent.Disconnected -> Browser re-emits
// 'disconnected'). This test drives that real callback, not a process()/exitCode mock.
test('relaunches if the reused browser disconnects (crash / signal kill, not just a recorded exitCode)', async () => {
  let launches = 0;
  const calls: string[] = [];
  const fakePage = makeVoicePageFake(calls);
  let disconnectHandler: (() => void) | null = null;
  const mgr = createChromeMgr({
    chromePath: '/fake',
    launch: async () => {
      launches++;
      disconnectHandler = null;
      return {
        newPage: async () => fakePage,
        close: async () => {},
        on: (ev: string, cb: () => void) => { if (ev === 'disconnected') disconnectHandler = cb; },
      } as any;
    },
  });
  await mgr.ensureLoaded('sessionKey=x');
  assert.equal(launches, 1);
  assert.ok(disconnectHandler, 'createChromeMgr must register a disconnected listener on each launched browser');
  // Simulate a signal kill: exitCode would still read null on a real ChildProcess (signalCode
  // would be set instead) — but the browser's own transport still tears down and fires this.
  (disconnectHandler as unknown as () => void)();
  await mgr.ensureLoaded('sessionKey=x');
  assert.equal(launches, 2, 'a disconnected browser must trigger a relaunch, not a silent reuse');
});

test('a browser that never disconnects is reused as-is (no spurious relaunch)', async () => {
  let launches = 0;
  const calls: string[] = [];
  const fakePage = makeVoicePageFake(calls);
  const mgr = createChromeMgr({
    chromePath: '/fake',
    launch: async () => {
      launches++;
      return { newPage: async () => fakePage, close: async () => {}, on: () => {} } as any;
    },
  });
  await mgr.ensureLoaded('sessionKey=x');
  await mgr.openVoicePage('v', 'b');
  await mgr.ensureLoaded('sessionKey=x');
  assert.equal(launches, 1);
});

test('teardownIfIdle closes the browser once VOICE_CHROME_IDLE_MS has elapsed since the last openVoicePage', async () => {
  const prevIdle = process.env.VOICE_CHROME_IDLE_MS;
  process.env.VOICE_CHROME_IDLE_MS = '10';
  try {
    let closed = 0;
    const calls: string[] = [];
    const fakePage = makeVoicePageFake(calls);
    const fakeBrowser = { newPage: async () => fakePage, close: async () => { closed++; }, process: () => ({}) };
    const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
    await mgr.openVoicePage('v', 'b');

    await mgr.teardownIfIdle();
    assert.equal(closed, 0, 'not idle yet — must not close');

    await new Promise((r) => setTimeout(r, 25));
    await mgr.teardownIfIdle();
    assert.equal(closed, 1, 'idle window elapsed — must close exactly once');

    await mgr.teardownIfIdle();
    assert.equal(closed, 1, 'already torn down — a second call is a no-op, not a double-close');
  } finally {
    if (prevIdle === undefined) delete process.env.VOICE_CHROME_IDLE_MS;
    else process.env.VOICE_CHROME_IDLE_MS = prevIdle;
  }
});

test('a launch failure throws a typed ChromeMgrError (launch_failed)', async () => {
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => { throw new Error('spawn ENOENT'); } });
  await assert.rejects(() => mgr.ensureLoaded('sessionKey=x'), (err: unknown) => {
    assert.ok(err instanceof ChromeMgrError);
    assert.equal((err as ChromeMgrError).code, 'launch_failed');
    assert.match((err as Error).message, /spawn ENOENT/);
    return true;
  });
});

test('no chromePath and no injected launch fails fast with a typed error — never touches real Chrome', async () => {
  const mgr = createChromeMgr({ chromePath: null });
  await assert.rejects(() => mgr.ensureLoaded('a=b'), (err: unknown) => {
    assert.ok(err instanceof ChromeMgrError);
    assert.equal((err as ChromeMgrError).code, 'launch_failed');
    return true;
  });
});

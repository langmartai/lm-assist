import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeMgr, ChromeMgrError } from '../voice/claude-chrome';

// ensureLoaded / openVoicePage's real CF-settle wait is a production requirement, not something
// a unit test should pay for on every run — set before any test runs. Read at call time (not
// module load) inside claude-chrome.ts, so this takes effect for the whole file.
process.env.VOICE_CHROME_SETTLE_MS = '0';

const tick = () => new Promise<void>((r) => setImmediate(r));

// Brief's Step 1 test, verbatim — the mandatory RED/GREEN case (browser reuse across
// ensureLoaded calls). Everything below extends coverage to the rest of the ChromeMgr
// interface, using the same injected-fake pattern so no test ever touches real Chrome.
test('reuses one browser across ensureLoaded calls', async () => {
  let launches = 0;
  const fakePage = { evaluate: async () => null, close: async () => {}, on: () => {}, setCookie: async () => {}, goto: async () => {}, exposeFunction: async () => {}, evaluateOnNewDocument: async () => {} };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => { launches++; return fakeBrowser as any; } });
  await mgr.ensureLoaded('sessionKey=x');
  await mgr.ensureLoaded('sessionKey=x');
  assert.equal(launches, 1);
});

// A fresh fake page for the openVoicePage tests — needs exposeFunction (the page->Core CDP
// binding) + evaluateOnNewDocument (the __VOICE_URL__ global) + evaluate (asset injection).
function makeVoicePageFake(calls: string[]) {
  return {
    exposeFunction: async (_name: string, _fn: (...a: unknown[]) => unknown) => { calls.push('exposeFunction'); },
    evaluate: async (_src: unknown, ..._args: unknown[]) => { calls.push('evaluate'); return null; },
    close: async () => { calls.push('close'); },
    on: () => {},
    setCookie: async () => {},
    goto: async () => { calls.push('goto'); },
    evaluateOnNewDocument: async (_fn: unknown, ..._args: unknown[]) => { calls.push('evaluateOnNewDocument'); },
  };
}

test('openVoicePage installs the __lmToCore binding + __VOICE_URL__ global BEFORE navigating, THEN injects the relay asset', async () => {
  const calls: string[] = [];
  const fakePage = makeVoicePageFake(calls);
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  await mgr.openVoicePage('wss://claude.ai/voice', { onFrame: () => {}, onStatus: () => {} });
  // Order matters: exposeFunction + evaluateOnNewDocument BOTH run before goto (the asset reads
  // globalThis.__VOICE_URL__ and calls globalThis.__lmToCore synchronously at injection); then,
  // after navigation + the CF settle, the __cf_bm refresh (page.evaluate GET /api/account) runs,
  // and the asset itself (page.evaluate) is injected LAST.
  assert.deepEqual(calls, ['exposeFunction', 'evaluateOnNewDocument', 'goto', 'evaluate', 'evaluate']);
});

test('openVoicePage passes voiceUrl to the __VOICE_URL__ setter and injects the real Task 3 asset', async () => {
  let globalsArgs: unknown[] = [];
  let injectedSource = '';
  const fakePage = {
    exposeFunction: async () => {},
    evaluate: async (src: unknown) => { injectedSource = String(src); return null; },
    close: async () => {},
    on: () => {},
    setCookie: async () => {},
    goto: async () => {},
    evaluateOnNewDocument: async (_fn: unknown, ...args: unknown[]) => { globalsArgs = args; },
  };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  await mgr.openVoicePage('wss://VOICE-URL', { onFrame: () => {}, onStatus: () => {} });
  assert.deepEqual(globalsArgs, ['wss://VOICE-URL']);
  // Confirm we loaded Task 3's actual asset off disk, not a stub — look for symbols unique to
  // core/src/voice/assets/claude-ws-relay.js.
  assert.match(injectedSource, /__VOICE_URL__/);
  assert.match(injectedSource, /__lmFromCore/);
});

test('openVoicePage registers the __lmToCore CDP binding, which routes status/text/bin envelopes to the handlers', async () => {
  let boundName = '';
  // Init to a no-op (not `| null`): the real fn is captured inside the exposeFunction closure,
  // which TS flow-analysis can't see — a null union would narrow to `never` at the call sites.
  let boundFn: (env: any) => void = () => {};
  const fakePage = {
    exposeFunction: async (name: string, fn: (env: any) => void) => { boundName = name; boundFn = fn; },
    evaluate: async () => null,
    close: async () => {},
    on: () => {},
    setCookie: async () => {},
    goto: async () => {},
    evaluateOnNewDocument: async () => {},
  };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
  const frames: Array<{ data: Buffer; binary: boolean }> = [];
  const statuses: Array<{ state: string; timeout?: boolean }> = [];
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  await mgr.openVoicePage('v', {
    onFrame: (data, binary) => { frames.push({ data, binary }); },
    onStatus: (state, info) => { statuses.push({ state, timeout: info?.timeout }); },
  });
  assert.equal(boundName, '__lmToCore', 'the page->Core binding is named __lmToCore');

  boundFn({ t: 'status', state: 'up_open' });
  boundFn({ t: 'status', state: 'up_close', timeout: true });
  boundFn({ t: 'text', d: 'hello' });
  boundFn({ t: 'bin', d: Buffer.from([1, 2, 3]).toString('base64') });

  assert.deepEqual(statuses, [{ state: 'up_open', timeout: undefined }, { state: 'up_close', timeout: true }]);
  assert.equal(frames.length, 2, 'text + bin routed to onFrame; status routed to onStatus');
  assert.equal(frames[0].binary, false);
  assert.equal(frames[0].data.toString('utf8'), 'hello');
  assert.equal(frames[1].binary, true);
  assert.deepEqual([...frames[1].data], [1, 2, 3], 'base64 bin envelope decoded to the original bytes');
});

test('the returned channel.send(data, binary) invokes page.evaluate with the __lmFromCore envelope (text vs base64 bin)', async () => {
  const evalCalls: unknown[][] = [];
  const fakePage = {
    exposeFunction: async () => {},
    evaluate: async (...args: unknown[]) => { evalCalls.push(args); return null; },
    close: async () => {},
    on: () => {},
    setCookie: async () => {},
    goto: async () => {},
    evaluateOnNewDocument: async () => {},
  };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  const channel = await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });
  evalCalls.length = 0; // drop the asset-injection evaluate call

  channel.send(Buffer.from('ctrl'), false);
  channel.send(Buffer.from([9, 9]), true);
  await tick(); // send is fire-and-forget (void page.evaluate(...).catch())

  assert.equal(evalCalls.length, 2);
  assert.equal(typeof evalCalls[0][0], 'function', 'first evaluate arg is the page-side __lmFromCore invoker');
  assert.deepEqual(evalCalls[0][1], { t: 'text', d: 'ctrl' }, 'text frame → utf8 envelope');
  assert.deepEqual(evalCalls[1][1], { t: 'bin', d: Buffer.from([9, 9]).toString('base64') }, 'binary frame → base64 envelope');
});

test('channel.close() closes the underlying page (reclaims the tab)', async () => {
  let closed = 0;
  const fakePage = {
    exposeFunction: async () => {},
    evaluate: async () => null,
    close: async () => { closed++; },
    on: () => {},
    setCookie: async () => {},
    goto: async () => {},
    evaluateOnNewDocument: async () => {},
  };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  const channel = await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });
  await channel.close();
  assert.equal(closed, 1);
});

test('openVoicePage returns a channel (send + close) and does not close the page on success', async () => {
  const calls: string[] = [];
  const fakePage = makeVoicePageFake(calls);
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  const channel = await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });
  assert.equal(calls.includes('close'), false, 'the live page is not torn down on success');
  assert.equal(typeof channel.send, 'function');
  assert.equal(typeof channel.close, 'function');
});

test('ensureLoaded parses "name=value; name2=value2" into setCookie pairs scoped to https://claude.ai', async () => {
  let captured: unknown[] = [];
  const fakePage = {
    evaluate: async () => null, close: async () => {}, on: () => {}, goto: async () => {}, exposeFunction: async () => {}, evaluateOnNewDocument: async () => {},
    setCookie: async (...cookies: unknown[]) => { captured = cookies; },
  };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
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
  await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });
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
    const fakeBrowser = { newPage: async () => fakePage, close: async () => { closed++; }, on: () => {} };
    const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
    await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });

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

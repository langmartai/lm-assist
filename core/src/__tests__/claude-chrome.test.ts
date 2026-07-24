import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeMgr, ChromeMgrError } from '../voice/claude-chrome';

// ensureLoaded / openVoicePage's real CF-settle wait is a production requirement, not something
// a unit test should pay for on every run — set before any test runs. Read at call time (not
// module load) inside claude-chrome.ts, so this takes effect for the whole file. `0` means the
// readiness POLL is skipped entirely (see waitForClaudeReady); the individual latency tests
// below opt back in around themselves.
process.env.VOICE_CHROME_SETTLE_MS = '0';
// Background timers off by default so no stray keepalive/sweep can race an assertion. The two
// tests that exercise them turn them on locally.
process.env.VOICE_CF_KEEPALIVE_MS = '0';
process.env.VOICE_CHROME_IDLE_SWEEP_MS = '0';

/** Run `fn` with env overrides applied, restoring the previous values afterwards. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

/**
 * A page fake that can answer the readiness probe. `evaluate` is overloaded in the real code, so
 * the fake demuxes the same way production does:
 *   evaluate(fn)          -> the same-origin GET /api/account probe  (returns `status`)
 *   evaluate(string)      -> relay-asset injection
 *   evaluate(fn, envObj)  -> a channel send
 */
function makeProbePageFake(cfg: { status?: number; cookies?: Array<{ name: string; value: string }> } = {}) {
  const state = {
    status: cfg.status ?? 200,
    cookies: cfg.cookies ?? [{ name: 'sessionKey', value: 'sk-ant-SECRETVALUE' }, { name: 'cf_clearance', value: 'CF-SECRET-VALUE' }, { name: '__cf_bm', value: 'BM-SECRET-VALUE' }],
    gotos: 0,
    probes: 0,
    closed: false,
    assetInjected: 0,
  };
  const page = {
    state,
    exposeFunction: async () => {},
    evaluateOnNewDocument: async () => {},
    setCookie: async () => {},
    goto: async () => { state.gotos++; },
    cookies: async (_url?: string) => state.cookies.map((c) => ({ ...c })),
    isClosed: () => state.closed,
    close: async () => { state.closed = true; },
    evaluate: async (a: unknown, ...rest: unknown[]) => {
      if (typeof a === 'string') { state.assetInjected++; return null; }
      if (typeof a === 'function' && rest.length === 0) { state.probes++; return state.status; }
      return null;
    },
  };
  return page;
}

/** Capture console.log lines emitted while `fn` runs — used to prove no cookie VALUE is logged. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

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

test('teardownIfIdle closes the browser once VOICE_CHROME_IDLE_MS has elapsed and no channel is live', async () => {
  const prevIdle = process.env.VOICE_CHROME_IDLE_MS;
  process.env.VOICE_CHROME_IDLE_MS = '10';
  try {
    let closed = 0;
    const calls: string[] = [];
    const fakePage = makeVoicePageFake(calls);
    const fakeBrowser = { newPage: async () => fakePage, close: async () => { closed++; }, on: () => {} };
    const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
    const channel = await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });

    await mgr.teardownIfIdle();
    assert.equal(closed, 0, 'not idle yet — must not close');

    await channel.close(); // releases the live-channel hold added by the latency pass
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

// The idle sweep is now WIRED (an internal unref'd interval calls teardownIfIdle — before this
// pass nothing called it at all and the browser lived until Core restarted). That makes this
// case load-bearing rather than theoretical: `lastOpenAt` is stamped when a channel OPENS, so a
// long conversation looks "idle" by timestamp alone. Only the live-channel count keeps the sweep
// from closing Chrome mid-call.
test('teardownIfIdle refuses to close while a voice channel is still live, however long it has run', async () => {
  const prevIdle = process.env.VOICE_CHROME_IDLE_MS;
  process.env.VOICE_CHROME_IDLE_MS = '10';
  try {
    let closed = 0;
    const calls: string[] = [];
    const fakePage = makeVoicePageFake(calls);
    const fakeBrowser = { newPage: async () => fakePage, close: async () => { closed++; }, on: () => {} };
    const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
    const channel = await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });

    await new Promise((r) => setTimeout(r, 25)); // idle window elapsed, but the call is ongoing
    await mgr.teardownIfIdle();
    assert.equal(closed, 0, 'a live channel must veto the idle teardown — this would kill a call');

    await channel.close();
    await mgr.teardownIfIdle();
    assert.equal(closed, 1, 'once the last channel closes, the same idle window applies');
  } finally {
    if (prevIdle === undefined) delete process.env.VOICE_CHROME_IDLE_MS;
    else process.env.VOICE_CHROME_IDLE_MS = prevIdle;
  }
});

test('two channels: teardown waits for BOTH to close, and a double close() cannot strand the count', async () => {
  const prevIdle = process.env.VOICE_CHROME_IDLE_MS;
  process.env.VOICE_CHROME_IDLE_MS = '10';
  try {
    let closed = 0;
    const calls: string[] = [];
    const fakePage = makeVoicePageFake(calls);
    const fakeBrowser = { newPage: async () => fakePage, close: async () => { closed++; }, on: () => {} };
    const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
    const a = await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });
    const b = await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });
    await new Promise((r) => setTimeout(r, 25));

    await a.close();
    await a.close(); // the relay closes from several paths — must not decrement twice
    await mgr.teardownIfIdle();
    assert.equal(closed, 0, 'channel b is still live');

    await b.close();
    await mgr.teardownIfIdle();
    assert.equal(closed, 1);
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

// ── condition-based readiness (replaces the two blind 10s sleeps) ────────────────
// docs/superpowers/specs/2026-07-25-voice-v2-latency-hardening-design.md §2.

test('openVoicePage returns as soon as /api/account is 200 AND cf_clearance is present — it does not burn the cap', async () => {
  await withEnv({ VOICE_CHROME_SETTLE_MS: '5000', VOICE_CHROME_READY_POLL_MS: '10' }, async () => {
    const fakePage = makeProbePageFake({ status: 200 }); // cf_clearance present by default
    const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
    const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
    const t0 = Date.now();
    await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });
    const elapsed = Date.now() - t0;
    // The whole point of the pass: this used to be a hardcoded 10_000ms sleep.
    assert.ok(elapsed < 1000, `must not sleep out the cap when both signals are already up (took ${elapsed}ms)`);
    assert.equal(fakePage.state.assetInjected, 1, 'the relay asset is still injected');
  });
});

test('openVoicePage proceeds (does not fail) when the cap is reached with a 200 but no cf_clearance', async () => {
  await withEnv({ VOICE_CHROME_SETTLE_MS: '60', VOICE_CHROME_READY_POLL_MS: '10' }, async () => {
    // Cloudflare never challenged this already-trusted browser, so cf_clearance is never minted.
    // Waiting forever would be the wrong call — a 200 means claude.ai is answering us.
    const fakePage = makeProbePageFake({ status: 200, cookies: [{ name: 'sessionKey', value: 'v' }] });
    const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
    const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
    const t0 = Date.now();
    await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });
    assert.ok(Date.now() - t0 >= 60, 'it should have polled up to the cap');
    assert.equal(fakePage.state.assetInjected, 1, 'cap reached must still inject the asset, not throw');
  });
});

test('a same-origin GET /api/account always runs immediately before the relay asset is injected (the CF fix invariant)', async () => {
  // 0f33806 / lm-mobile §4: __cf_bm is short-lived and the WS upgrade must present a fresh one.
  // This ordering is the one thing the latency work must never regress — assert it even in the
  // cap<=0 configuration, where the readiness poll is skipped entirely.
  const order: string[] = [];
  const fakePage = {
    exposeFunction: async () => {}, evaluateOnNewDocument: async () => {}, setCookie: async () => {},
    goto: async () => { order.push('goto'); }, cookies: async () => [], isClosed: () => false, close: async () => {},
    evaluate: async (a: unknown, ...rest: unknown[]) => {
      if (typeof a === 'string') order.push('asset');
      else if (typeof a === 'function' && rest.length === 0) order.push('account-get');
      return 200;
    },
  };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });
  assert.deepEqual(order, ['goto', 'account-get', 'asset']);
});

// ── persistent primed page + CF keepalive (removes the per-session repeat) ───────
// design §3. ensureLoaded used to navigate a throwaway page and close it EVERY session.

test('ensureLoaded navigates once, then REUSES the primed page on subsequent calls', async () => {
  const fakePage = makeProbePageFake({ status: 200 });
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  await mgr.ensureLoaded('sessionKey=x');
  assert.equal(fakePage.state.gotos, 1);
  await mgr.ensureLoaded('sessionKey=x');
  await mgr.ensureLoaded('sessionKey=x');
  assert.equal(fakePage.state.gotos, 1, 'a healthy primed page must not re-navigate');
  assert.equal(fakePage.state.closed, false, 'the primed page stays open across sessions');
});

test('the primed page is validated before reuse — an unhealthy one is dropped and re-primed', async () => {
  const fakePage = makeProbePageFake({ status: 200 });
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  await mgr.ensureLoaded('sessionKey=x');
  assert.equal(fakePage.state.gotos, 1);
  fakePage.state.status = 0;   // the session died / Cloudflare started challenging again
  fakePage.state.closed = false;
  await mgr.ensureLoaded('sessionKey=x');
  assert.equal(fakePage.state.gotos, 2, 'an unhealthy primed page must trigger a full re-prime');
});

test('a rotated claude.ai cookie re-primes rather than reusing a page primed with the old one', async () => {
  const fakePage = makeProbePageFake({ status: 200 });
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  await mgr.ensureLoaded('sessionKey=OLD');
  await mgr.ensureLoaded('sessionKey=OLD');
  assert.equal(fakePage.state.gotos, 1);
  await mgr.ensureLoaded('sessionKey=NEW');
  assert.equal(fakePage.state.gotos, 2, 'a different cookie header must invalidate the primed page');
});

test('VOICE_PRIMED_MAX_AGE_MS recycles the primed page instead of letting it live forever', async () => {
  await withEnv({ VOICE_PRIMED_MAX_AGE_MS: '15' }, async () => {
    const fakePage = makeProbePageFake({ status: 200 });
    const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
    const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
    await mgr.ensureLoaded('sessionKey=x');
    assert.equal(fakePage.state.gotos, 1);
    await new Promise((r) => setTimeout(r, 30));
    fakePage.state.closed = false;
    await mgr.ensureLoaded('sessionKey=x');
    assert.equal(fakePage.state.gotos, 2, 'past its max age the page is recycled, not reused');
  });
});

test('concurrent ensureLoaded calls prime exactly once (single-flight)', async () => {
  const fakePage = makeProbePageFake({ status: 200 });
  let pages = 0;
  const fakeBrowser = { newPage: async () => { pages++; return fakePage; }, close: async () => {}, on: () => {} };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
  await Promise.all([mgr.ensureLoaded('sessionKey=x'), mgr.ensureLoaded('sessionKey=x'), mgr.ensureLoaded('sessionKey=x')]);
  assert.equal(pages, 1, 'two sessions starting together must not each build a primed page');
  assert.equal(fakePage.state.gotos, 1);
});

test('the CF keepalive issues a REAL same-origin GET /api/account on its interval (a no-op ping would not refresh cookies)', async () => {
  await withEnv({ VOICE_CF_KEEPALIVE_MS: '20' }, async () => {
    const fakePage = makeProbePageFake({ status: 200 });
    const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
    const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
    await mgr.ensureLoaded('sessionKey=x');
    const afterPrime = fakePage.state.probes;
    await new Promise((r) => setTimeout(r, 90));
    assert.ok(fakePage.state.probes > afterPrime, `keepalive must hit /api/account (probes ${afterPrime} -> ${fakePage.state.probes})`);
    assert.equal(fakePage.state.gotos, 1, 'the keepalive refreshes cookies in place — it must not re-navigate');
  });
});

test('VOICE_PRIMED_PAGE=0 falls back to throwaway priming (navigates and closes every call)', async () => {
  await withEnv({ VOICE_PRIMED_PAGE: '0' }, async () => {
    const pages: Array<ReturnType<typeof makeProbePageFake>> = [];
    const fakeBrowser = { newPage: async () => { const p = makeProbePageFake({ status: 200 }); pages.push(p); return p; }, close: async () => {}, on: () => {} };
    const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
    await mgr.ensureLoaded('sessionKey=x');
    await mgr.ensureLoaded('sessionKey=x');
    assert.equal(pages.length, 2, 'the kill switch restores one priming page per call');
    assert.ok(pages.every((p) => p.state.closed), 'each throwaway priming page is closed again');
  });
});

// ── safety: cookie NAMES only, never values ─────────────────────────────────────

test('readiness + keepalive logging emits cookie NAMES only — never a cookie value', async () => {
  await withEnv({ VOICE_CHROME_SETTLE_MS: '40', VOICE_CHROME_READY_POLL_MS: '10' }, async () => {
    const fakePage = makeProbePageFake({
      status: 200,
      cookies: [{ name: 'sessionKey', value: 'sk-ant-MUST-NOT-APPEAR' }, { name: '__cf_bm', value: 'BM-MUST-NOT-APPEAR' }],
    });
    const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, on: () => {} };
    const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => fakeBrowser as any });
    const lines = await captureLogs(async () => {
      await mgr.ensureLoaded('sessionKey=sk-ant-MUST-NOT-APPEAR');
      await mgr.openVoicePage('v', { onFrame: () => {}, onStatus: () => {} });
    });
    const blob = lines.join('\n');
    assert.ok(blob.length > 0, 'the pass is supposed to add measurable phase logging');
    assert.ok(!blob.includes('MUST-NOT-APPEAR'), `a cookie value leaked into the logs:\n${blob}`);
    assert.match(blob, /__cf_bm/, 'cookie NAMES are what we report');
  });
});

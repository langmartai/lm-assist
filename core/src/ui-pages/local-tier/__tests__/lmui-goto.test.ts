/**
 * lmui.goto — the SHIPPED shim, loaded verbatim into a fake window.
 *
 * The shim is a plain ES5 asset with no build step, so nothing else would ever type-check
 * or exercise it; the only way it gets tested is by running the real bytes. This loads
 * ui-apps/assist-scheduler/assets/lmui.js (byte-identical to every other pane — see
 * lmui-shim-identity.test.ts) in a node:vm with a hand-built `window`.
 *
 * What it pins: the channel choice (standalone assigns, embedded ASKS the shell), the
 * negative-ack and old-shell fallbacks, and that a malformed call throws SYNCHRONOUSLY at
 * the call site rather than silently producing a wrong URL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function repoRoot(): string {
  let d = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'ui-apps')) && fs.existsSync(path.join(d, 'package.json'))) return d;
    d = path.dirname(d);
  }
  throw new Error(`could not locate the repo root above ${__dirname}`);
}

const SHIM_PATH = path.join(repoRoot(), 'ui-apps', 'assist-scheduler', 'assets', 'lmui.js');
const SHIM = fs.readFileSync(SHIM_PATH, 'utf8');

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Posted { msg: { type?: string; v?: number; uiId?: string; params?: string; from?: string }; origin: string }
interface Harness {
  lmui: { goto: (id: string, params?: unknown, opts?: unknown) => void };
  opened: string[];
  assigned: string[];
  posted: Posted[];
  ack: (body: unknown, origin: string) => void;
}

/** A fresh sandbox per call — the shim keeps pending-navigation state at module scope. */
function load(o: { shellOrigin?: string; framed?: boolean } = {}): Harness {
  const opened: string[] = [];
  const assigned: string[] = [];
  const posted: Posted[] = [];
  const listeners: Array<(e: { data: unknown; origin: string }) => void> = [];

  const win: Record<string, unknown> = {
    __VIEW_TOKEN__: 'lvt1.fake.token',
    __UI_ID__: 'demo-pane',
    __UI_KEY__: 'demo-pane',
    __SHELL_ORIGIN__: o.shellOrigin || '',
    location: { search: '', assign: (h: string) => { assigned.push(h); } },
    open: (h: string) => { opened.push(h); return null; },
    addEventListener: (type: string, fn: (e: { data: unknown; origin: string }) => void) => {
      if (type === 'message') listeners.push(fn);
    },
    setTimeout, clearTimeout,
    fetch: () => Promise.reject(new Error('no network in this test')),
    console,
  };
  win.window = win;
  win.parent = o.framed
    ? { postMessage: (msg: Posted['msg'], origin: string) => { posted.push({ msg, origin }); } }
    : win;

  vm.createContext(win);
  vm.runInContext(SHIM, win, { filename: SHIM_PATH });
  return {
    lmui: win.lmui as Harness['lmui'],
    opened, assigned, posted,
    ack: (body, origin) => { for (const fn of listeners) fn({ data: body, origin }); },
  };
}

// ── serialization ────────────────────────────────────────────────────────────────────────

test('goto builds a ROOT-relative /go link (a bare one would resolve under <base href>)', () => {
  const h = load();
  h.lmui.goto('assist-memory', { tab: 'rules' });
  assert.deepEqual(h.assigned, ['/go/assist-memory?tab=rules']);
});

test('no params → a bare /go link', () => {
  const h = load();
  h.lmui.goto('assist-memory');
  assert.deepEqual(h.assigned, ['/go/assist-memory']);
});

test('scalars are coerced and values percent-encoded', () => {
  const h = load();
  h.lmui.goto('assist-memory', { n: 7, on: true, q: 'a b&c=d#e' });
  assert.equal(h.assigned[0], '/go/assist-memory?n=7&on=true&q=a%20b%26c%3Dd%23e');
});

test('null/undefined values drop the key rather than serializing "null"', () => {
  const h = load();
  h.lmui.goto('assist-memory', { a: 1, b: null, c: undefined });
  assert.equal(h.assigned[0], '/go/assist-memory?a=1');
});

test('an array repeats the key', () => {
  const h = load();
  h.lmui.goto('assist-memory', { tag: ['a', 'b'] });
  assert.equal(h.assigned[0], '/go/assist-memory?tag=a&tag=b');
});

test('malformed input THROWS synchronously — never a silently wrong URL', () => {
  const h = load();
  assert.throws(() => h.lmui.goto('Assist-Memory'), /is not a uiId/);
  assert.throws(() => h.lmui.goto('../etc'), /is not a uiId/);
  assert.throws(() => h.lmui.goto(''), /is not a uiId/);
  assert.throws(() => h.lmui.goto('assist-memory', 'tab=1'), /must be a plain object/);
  assert.throws(() => h.lmui.goto('assist-memory', [1, 2]), /must be a plain object/);
  assert.throws(() => h.lmui.goto('assist-memory', { 'bad key': 1 }), /illegal param name/);
  assert.throws(() => h.lmui.goto('assist-memory', { deep: { a: 1 } }), /string, number or boolean/);
  assert.equal(h.assigned.length, 0, 'a throwing call must not navigate');
});

test('reserved keys throw LOUDLY in the shim (they are only dropped server-side)', () => {
  const h = load();
  for (const k of ['lt', 'embed', 'theme', 'code', 'token', 'returnTo', '_lmX']) {
    assert.throws(() => h.lmui.goto('assist-memory', { [k]: '1' }), /reserved by the serving tier/, k);
  }
});

test('caps refuse rather than truncate', () => {
  const h = load();
  assert.throws(() => h.lmui.goto('assist-memory', { v: 'x'.repeat(513) }), /exceeds 512 chars/);
  const many: Record<string, string> = {};
  for (let i = 0; i < 17; i++) many[`k${i}`] = '1';
  assert.throws(() => h.lmui.goto('assist-memory', many), /at most 16 params/);
  const long: Record<string, string> = {};
  for (let i = 0; i < 6; i++) long[`k${i}`] = 'x'.repeat(400);
  assert.throws(() => h.lmui.goto('assist-memory', long), /query too long/);
});

test('a view/entry token as a param value is refused outright', () => {
  const h = load();
  assert.throws(() => h.lmui.goto('assist-memory', { t: 'lvt1.abc.def' }), /refusing to put a token in a URL/);
  assert.throws(() => h.lmui.goto('assist-memory', { t: 'let1.abc.def' }), /refusing to put a token in a URL/);
});

// ── channel choice ───────────────────────────────────────────────────────────────────────

test('standalone assigns location; embedded never does', () => {
  const solo = load();
  solo.lmui.goto('assist-memory');
  assert.equal(solo.assigned.length, 1);
  assert.equal(solo.posted.length, 0);

  const framed = load({ framed: true, shellOrigin: 'https://shell.example' });
  framed.lmui.goto('assist-memory');
  assert.equal(framed.assigned.length, 0, 'a framed pane must never move its own top-level location');
  assert.equal(framed.posted.length, 1);
});

test('the message carries an ID and a query string — never a URL, origin or path', () => {
  const h = load({ framed: true, shellOrigin: 'https://shell.example' });
  h.lmui.goto('assist-memory', { file: 'MEMORY.md' });
  const { msg, origin } = h.posted[0];
  // Field-wise: the object was authored inside the vm realm, so deepStrictEqual would trip
  // on its prototype rather than on its contents.
  assert.equal(msg.type, 'lmui:navigate');
  assert.equal(msg.v, 1);
  assert.equal(msg.uiId, 'assist-memory');
  assert.equal(msg.params, 'file=MEMORY.md');
  assert.equal(msg.from, 'demo-pane');
  assert.deepEqual(Object.keys(msg).sort(), ['from', 'params', 'type', 'uiId', 'v']);
  assert.ok(!JSON.stringify(msg).includes('/go/'), 'no URL in the message');
  assert.equal(origin, 'https://shell.example', 'the post is PINNED to the known shell');
});

test('no __SHELL_ORIGIN__ → the post is wildcard (there is nothing to pin to)', () => {
  const h = load({ framed: true, shellOrigin: '' });
  h.lmui.goto('assist-memory');
  assert.equal(h.posted[0].origin, '*');
});

test('newTab opens a tab on both tiers, without asking the shell', () => {
  const h = load({ framed: true, shellOrigin: 'https://shell.example' });
  h.lmui.goto('assist-memory', { a: '1' }, { newTab: true });
  assert.deepEqual(h.opened, ['/go/assist-memory?a=1']);
  assert.equal(h.posted.length, 0);
});

// ── acks + fallbacks ─────────────────────────────────────────────────────────────────────

test('ok:true → the shell is routing; the pane opens nothing', async () => {
  const h = load({ framed: true, shellOrigin: 'https://shell.example' });
  h.lmui.goto('assist-memory');
  h.ack({ type: 'lmui:navigate:ack', v: 1, uiId: 'assist-memory', ok: true }, 'https://shell.example');
  await delay(900);
  assert.equal(h.opened.length, 0, 'an acked navigation must not also open a tab');
  assert.equal(h.posted.length, 1, 'and must not re-post');
});

test('ok:false → a new tab IMMEDIATELY, not after the 750ms timeout', async () => {
  const h = load({ framed: true, shellOrigin: 'https://shell.example' });
  h.lmui.goto('assist-memory', { a: '1' });
  h.ack({ type: 'lmui:navigate:ack', v: 1, uiId: 'assist-memory', ok: false }, 'https://shell.example');
  assert.deepEqual(h.opened, ['/go/assist-memory?a=1'], 'fallback must be synchronous with the negative ack');
  await delay(900);
  assert.equal(h.opened.length, 1, 'and must not fire a second time on the timeout');
});

test('an ack from the wrong origin is ignored (the pane still falls back)', async () => {
  const h = load({ framed: true, shellOrigin: 'https://shell.example' });
  h.lmui.goto('assist-memory');
  h.ack({ type: 'lmui:navigate:ack', v: 1, uiId: 'assist-memory', ok: true }, 'https://evil.example');
  await delay(900);
  assert.deepEqual(h.opened, ['/go/assist-memory'], 'a spoofed ack must not suppress the fallback');
});

test('old shell (no listener): wildcard re-post at 300ms, new tab at 750ms', async () => {
  const h = load({ framed: true, shellOrigin: 'https://shell.example' });
  h.lmui.goto('assist-memory');
  assert.equal(h.posted.length, 1);
  await delay(450);
  assert.equal(h.posted.length, 2, 'a pane framed by embedAncestors[1..n] only hears the wildcard post');
  assert.equal(h.posted[1].origin, '*');
  assert.equal(h.opened.length, 0, 'still waiting at 450ms');
  await delay(500);
  assert.deepEqual(h.opened, ['/go/assist-memory']);
});

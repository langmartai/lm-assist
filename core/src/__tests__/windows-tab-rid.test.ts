// The Windows Terminal tab-id cache must survive a Core restart and be relearnable.
//
// Incident 2026-09-05 (107): after the 0.2.2 upgrade restarted Core, the first native drive to
// the Mission Control controller succeeded (idle session) but the next one FAILED with
// "could not locate window/tab". The tab RuntimeId learned at launch lived only in the old
// process's memory; without it the engine falls back to writing a marker into the console
// title, and a BUSY Claude session rewrites its title every frame so the marker never sticks.
// Three consecutive failures relaunch the controller — a slower version of the very loop the
// liveness fix had just closed.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  normalizeTabTitle,
  pickTabRidForPid,
  looksLikeTabRid,
  parseTabRidFile,
  renderTabRidFile,
  resolveTabRid,
  type TabRidCache,
} from '../terminal/windows-tab-rid';

test('normalizeTabTitle mirrors the engine: drop the leading token (spinner glyph), trim', () => {
  assert.equal(normalizeTabTitle('✳ Thinking…'), 'Thinking…');
  assert.equal(normalizeTabTitle('  ✳ Mission-control main  '), 'Mission-control main');
  assert.equal(normalizeTabTitle('Claude Code'), 'Code'); // same rule as Normalize-Title in the engine
  assert.equal(normalizeTabTitle(''), '');
});

const tabs = [
  { rid: '42.1.4.10', hwnd: 1, tabIndex: 0, name: '✳ Mission-control main' },
  { rid: '42.2.4.11', hwnd: 1, tabIndex: 1, name: 'Claude Code' },
];
const procs = [
  { pid: 12952, name: 'claude.exe', hostPid: 25940, hostName: 'WindowsTerminal.exe', title: 'Mission-control main' },
  { pid: 22300, name: 'claude.exe', hostPid: 25940, hostName: 'WindowsTerminal.exe', title: 'Code' },
];

test('pickTabRidForPid: the ONE tab whose normalized name equals the pid title, even mid-animation', () => {
  assert.equal(pickTabRidForPid(tabs, procs, 12952), '42.1.4.10');
  assert.equal(pickTabRidForPid(tabs, procs, 22300), '42.2.4.11');
});

test('pickTabRidForPid: unknown pid, empty title, or any ambiguity → null (never guess a tab)', () => {
  assert.equal(pickTabRidForPid(tabs, procs, 999), null);
  assert.equal(pickTabRidForPid(tabs, [{ ...procs[0], title: '' }], 12952), null);
  // two tabs with the same title
  assert.equal(pickTabRidForPid([...tabs, { rid: '42.3.4.12', hwnd: 1, tabIndex: 2, name: '⠋ Mission-control main' }], procs, 12952), null);
  // another process shares the title
  assert.equal(pickTabRidForPid(tabs, [...procs, { ...procs[1], pid: 777, title: 'Mission-control main' }], 12952), null);
});

test('looksLikeTabRid: a dotted UIA RuntimeId, not a bare pid or a tmux name', () => {
  assert.equal(looksLikeTabRid('42.7933118.4.10118'), true);
  assert.equal(looksLikeTabRid('12952'), false);
  assert.equal(looksLikeTabRid('lmcc-orig'), false);
  assert.equal(looksLikeTabRid(''), false);
  assert.equal(looksLikeTabRid(null), false);
});

test('tab-rid file: renders and parses a plain sessionId → rid map; garbage parses to empty', () => {
  const m = new Map([['sid-a', '42.1.4.10'], ['sid-b', '42.2.4.11']]);
  assert.deepEqual([...parseTabRidFile(renderTabRidFile(m)).entries()], [...m.entries()]);
  assert.equal(parseTabRidFile('not json').size, 0);
  assert.equal(parseTabRidFile('{"sid":123}').size, 0); // only string rids are accepted
});

function cache(initial: Array<[string, string]> = []): TabRidCache & { writes: number } {
  const map = new Map(initial);
  const c = {
    writes: 0,
    get: (k: string) => map.get(k),
    set: (k: string, v: string) => { map.set(k, v); c.writes += 1; },
  };
  return c;
}

test('resolveTabRid: a cached rid is returned without probing the terminal', async () => {
  let probed = 0;
  const c = cache([['sid-a', '42.1.4.10']]);
  const rid = await resolveTabRid('sid-a', 12952, c, { listTabs: async () => { probed += 1; return tabs; }, listProcs: async () => { probed += 1; return procs; } });
  assert.equal(rid, '42.1.4.10');
  assert.equal(probed, 0);
});

test('resolveTabRid: on a miss it relearns the rid from the live tab set and caches it', async () => {
  const c = cache();
  const rid = await resolveTabRid('sid-a', 12952, c, { listTabs: async () => tabs, listProcs: async () => procs });
  assert.equal(rid, '42.1.4.10');
  assert.equal(c.get('sid-a'), '42.1.4.10');
  assert.equal(c.writes, 1);
});

test('resolveTabRid: ambiguity or a probe failure → undefined and nothing cached (engine falls back to its marker)', async () => {
  const c = cache();
  const dup = [...tabs, { rid: '42.3.4.12', hwnd: 1, tabIndex: 2, name: '⠋ Mission-control main' }];
  assert.equal(await resolveTabRid('sid-a', 12952, c, { listTabs: async () => dup, listProcs: async () => procs }), undefined);
  assert.equal(await resolveTabRid('sid-a', 12952, c, { listTabs: async () => { throw new Error('engine down'); }, listProcs: async () => procs }), undefined);
  assert.equal(await resolveTabRid('sid-a', null, c, { listTabs: async () => tabs, listProcs: async () => procs }), undefined);
  assert.equal(c.writes, 0);
});

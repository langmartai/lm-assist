import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fsp = require('fs/promises');
import * as osmod from 'os';
import * as pathmod from 'path';
import { SessionIdentifier, listSessionDir, clearDirListingCache, buildSessionText } from '../session-identifier';
// Bind the REAL module objects: `import * as x` compiles to an __importStar copy
// whose properties are getters, and mock.method reads descriptor.value on those.
import pu = require('../utils/process-utils');
import execMod = require('../utils/exec');

/**
 * The synchronous work that blocked Core's single main thread.
 *
 * Measured on prod 117 with a 45s V8 CPU profile of the live process: the loop was
 * busy 52.6% of wall clock, and ~82% of that busy time came from the 1-second
 * process-status refresh — identify() 26.9%, getRunningClaudeProcesses() 14.1%
 * (three blocking `ps`/`pgrep` spawns), getSystemStats() 2.2%.
 *
 * These tests lock in the three properties that keep it off the main thread:
 * bounded retries, one scan at a time, and sync readers served by an async snapshot.
 */

const IDENTIFIED = {
  sessionId: 'sess-1',
  confidence: 1,
  matchDetails: { userPromptMatches: 0, filePathMatches: 0, commitHashMatches: 0, score: 100, maxScore: 100 },
};

// ─── Retry backoff ──────────────────────────────────────────────────

test('backs off exponentially when identification keeps failing', async () => {
  const si = new SessionIdentifier();
  mock.method(si, 'identify', async () => null);
  let now = 1_000_000;
  mock.method(Date, 'now', () => now);
  try {
    const PID = 4242;
    assert.equal(si.shouldAttempt(PID), true, 'the first attempt is allowed');

    await si.identifyForPid(PID, 'tmux-x', '/proj', new Date(0)); // failure #1
    now += 29_000;
    assert.equal(si.shouldAttempt(PID), false, 'still inside the 30s base cooldown');
    now += 2_000;
    assert.equal(si.shouldAttempt(PID), true, 'base cooldown elapsed');

    await si.identifyForPid(PID, 'tmux-x', '/proj', new Date(0)); // failure #2
    now += 31_000;
    assert.equal(si.shouldAttempt(PID), false, 'a second failure must double the wait to 60s');
    now += 31_000;
    assert.equal(si.shouldAttempt(PID), true, 'doubled cooldown elapsed');
  } finally {
    mock.restoreAll();
  }
});

test('the backed-off retry interval is capped', async () => {
  const si = new SessionIdentifier();
  mock.method(si, 'identify', async () => null);
  let now = 1_000_000;
  mock.method(Date, 'now', () => now);
  try {
    const PID = 99;
    // Many consecutive failures — the wait must not grow without bound.
    for (let i = 0; i < 12; i++) {
      now += 60 * 60_000;
      assert.equal(si.shouldAttempt(PID), true, `attempt ${i} should be allowed after an hour`);
      await si.identifyForPid(PID, 'tmux-x', '/proj', new Date(0));
    }
    now += 15 * 60_000 + 1_000;
    assert.equal(si.shouldAttempt(PID), true, 'cooldown must be capped at 15 minutes');
  } finally {
    mock.restoreAll();
  }
});

test('a successful identification stops further attempts and clears the failure count', async () => {
  const si = new SessionIdentifier();
  mock.method(si, 'identify', async () => IDENTIFIED as any);
  try {
    const PID = 7;
    const res = await si.identifyForPid(PID, 'tmux-x', '/proj', new Date(0));
    assert.equal(res?.sessionId, 'sess-1');
    assert.equal(si.shouldAttempt(PID), false, 'an identified PID is never re-scanned');
    assert.equal(si.getCachedIdentification(PID)?.sessionId, 'sess-1');
  } finally {
    mock.restoreAll();
  }
});

test('cleanup forgets dead PIDs so a recycled PID starts fresh', async () => {
  const si = new SessionIdentifier();
  mock.method(si, 'identify', async () => null);
  try {
    const PID = 555;
    await si.identifyForPid(PID, 'tmux-x', '/proj', new Date(0));
    assert.equal(si.shouldAttempt(PID), false, 'inside the cooldown');

    si.cleanup(new Set<number>()); // PID no longer running
    assert.equal(si.shouldAttempt(PID), true, 'a recycled PID must not inherit the old backoff');
  } finally {
    mock.restoreAll();
  }
});

// ─── Concurrency cap ──────────────────────────────────────────────────

test('runs only one identification at a time', async () => {
  const si = new SessionIdentifier();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  mock.method(si, 'identify', async () => { await gate; return null; });
  try {
    const running = si.identifyForPid(1, 't1', '/p', new Date(0));
    await new Promise(r => setImmediate(r));

    assert.equal(si.shouldAttempt(2), false, 'a second PID must wait while a scan is running');

    release();
    await running;
    assert.equal(si.shouldAttempt(2), true, 'the cap lifts once the scan finishes');
  } finally {
    mock.restoreAll();
  }
});

// ─── ps/pgrep snapshot ──────────────────────────────────────────────────

function stubAsyncExec(): string[] {
  const spawned: string[] = [];
  mock.method(execMod, 'execFile', ((file: string, args: string[], _opts: any, cb: any) => {
    spawned.push(file);
    const out = file === 'pgrep'
      ? '111\n222'
      : args.includes('--no-headers') ? 'PS_PIDPPID' : 'PS_FULL';
    cb(null, out, '');
    return undefined;
  }) as any);
  return spawned;
}

test('synchronous readers serve the async snapshot without spawning', async () => {
  pu.clearProcessSnapshot();
  const syncSpawns: string[] = [];
  mock.method(execMod, 'execFileSync', ((file: string) => { syncSpawns.push(file); return ''; }) as any);
  stubAsyncExec();
  try {
    await pu.refreshProcessSnapshot(['ttyd']);

    assert.equal(pu.getPsOutput(), 'PS_FULL');
    assert.equal(pu.getPsPidPpidOutput(), 'PS_PIDPPID');
    assert.deepEqual(pu.findProcessesByNameSync('ttyd'), [111, 222]);
    // This is the whole point: the 1s refresh must not block the loop on spawns.
    assert.deepEqual(syncSpawns, [], `no synchronous spawn may occur, got ${JSON.stringify(syncSpawns)}`);
  } finally {
    mock.restoreAll();
    pu.clearProcessSnapshot();
  }
});

test('falls back to the synchronous call when no snapshot exists', () => {
  pu.clearProcessSnapshot();
  const syncSpawns: string[] = [];
  mock.method(execMod, 'execFileSync', ((file: string) => { syncSpawns.push(file); return 'SYNC_PS'; }) as any);
  try {
    // A caller running without the background refresh must behave exactly as before.
    assert.equal(pu.getPsOutput(), 'SYNC_PS');
    assert.deepEqual(syncSpawns, ['ps']);
  } finally {
    mock.restoreAll();
    pu.clearProcessSnapshot();
  }
});

// ─── Session text: capped, tail-biased ──────────────────────────────

test('caps the searchable session text and keeps the most RECENT content', () => {
  // Sessions on a long-lived host reach 163MB. Every n-gram is a full scan of
  // this string — 50 `includes` over 100MB costs 1179ms of unbroken main-thread
  // time (measured), which is how one candidate produced a 17s stall.
  const responses = [];
  for (let i = 0; i < 20_000; i++) responses.push({ text: `line ${i} ` + 'x'.repeat(200) });
  responses.push({ text: 'NEEDLE_MOST_RECENT' });

  const out = buildSessionText({ userPrompts: [], responses, toolUses: [] });

  assert.ok(out.length <= 220_000, `text must be capped, got ${out.length} bytes`);
  assert.ok(out.includes('NEEDLE_MOST_RECENT'), 'the newest content must survive the cap');
  assert.ok(!out.includes('line 0 '), 'the oldest content is what gets dropped');
});

test('leaves a small session completely intact', () => {
  const out = buildSessionText({
    userPrompts: [{ text: 'hello' }],
    responses: [{ text: 'world' }],
    toolUses: [{ input: { a: 1 } }],
  });
  assert.ok(out.includes('hello') && out.includes('world') && out.includes('"a":1'),
    `a small session must not be truncated at all, got: ${out}`);
});

// ─── Session-dir listing: bounded fan-out ──────────────────────────────

test('stats a large session dir with BOUNDED concurrency, not all at once', async () => {
  const dir = await fsp.mkdtemp(pathmod.join(osmod.tmpdir(), 'lm-listdir-'));
  try {
    // Comfortably more files than the concurrency bound.
    for (let i = 0; i < 200; i++) await fsp.writeFile(pathmod.join(dir, `s${i}.jsonl`), 'x');
    clearDirListingCache();

    // Watch how many stats are in flight at once. An unbounded Promise.all over a
    // real project dir (4678 files here) floods libuv's 4-thread pool and starves
    // every other async fs op in Core — that regression made tail latency WORSE.
    let inFlight = 0;
    let peak = 0;
    const realStat = fsp.stat;
    mock.method(fsp, 'stat', async (...args: any[]) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await (realStat as any)(...args);
      } finally {
        inFlight--;
      }
    });

    const entries = await listSessionDir(dir);
    assert.equal(entries.length, 200, 'every session file must still be listed');
    assert.ok(peak > 1, `precondition: stats should run concurrently, peak was ${peak}`);
    assert.ok(peak <= 24, `stat fan-out must stay bounded, peaked at ${peak}`);
  } finally {
    mock.restoreAll();
    clearDirListingCache();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('reuses a recent directory listing instead of re-statting for every PID', async () => {
  const dir = await fsp.mkdtemp(pathmod.join(osmod.tmpdir(), 'lm-listdir-'));
  try {
    for (let i = 0; i < 10; i++) await fsp.writeFile(pathmod.join(dir, `s${i}.jsonl`), 'x');
    clearDirListingCache();

    await listSessionDir(dir); // populate

    let statsAfterWarm = 0;
    mock.method(fsp, 'stat', async (...args: any[]) => {
      statsAfterWarm++;
      return (fsp.stat as any)(...args);
    });
    const again = await listSessionDir(dir);

    assert.equal(again.length, 10);
    assert.equal(statsAfterWarm, 0, 'a warm listing must not re-stat the directory');
  } finally {
    mock.restoreAll();
    clearDirListingCache();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a stale snapshot is not served — it falls back rather than lying', async () => {
  pu.clearProcessSnapshot();
  stubAsyncExec();
  await pu.refreshProcessSnapshot(['ttyd']);
  mock.restoreAll();

  const syncSpawns: string[] = [];
  mock.method(execMod, 'execFileSync', ((file: string) => { syncSpawns.push(file); return 'SYNC_PS'; }) as any);
  const realNow = Date.now();
  mock.method(Date, 'now', () => realNow + pu.SNAPSHOT_MAX_AGE_MS + 1);
  try {
    assert.equal(pu.getPsOutput(), 'SYNC_PS', 'past its max age the snapshot must not be used');
    assert.deepEqual(syncSpawns, ['ps']);
  } finally {
    mock.restoreAll();
    pu.clearProcessSnapshot();
  }
});

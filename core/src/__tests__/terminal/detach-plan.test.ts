/**
 * Unit tests for detach-plan.ts — how the tmux SERVER is launched so that its
 * lifetime is independent of Core's.
 *
 * Measured on yitest 2026-07-28: the tmux server was ALREADY ppid=1 (tmux
 * self-daemonizes) and `systemctl restart lm-assist` still reaped it, because it
 * sat in Core's cgroup and KillMode defaults to control-group. So the planner is
 * asserted on ONE thing above all: a systemd host must produce a cgroup move, not
 * a setsid, because setsid does not change a cgroup.
 *
 * Pure function; every environment fact is injected, so no real systemd/tmux is
 * touched.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { planDetachedTmuxSpawn, type DetachProbe } from '../../terminal/detach-plan';

const TMUX_ARGS = ['new-session', '-d', '-s', 'claude-abc', '-c', '/home/yi'];

function probe(over: Partial<DetachProbe> = {}): DetachProbe {
  return {
    hasBinary: (n) => n === 'systemd-run' || n === 'setsid',
    pathExists: (p) => p === '/run/systemd/system' || p === '/run/user/1000' || p === '/run/user/1000/bus',
    uid: 1000,
    xdgRuntimeDir: null,
    dbusAddress: null,
    ...over,
  };
}

// ── the core guarantee ────────────────────────────────────────────────────

test('systemd host: plans a --user SCOPE (a cgroup move), never setsid', () => {
  const plan = planDetachedTmuxSpawn(TMUX_ARGS, probe());
  assert.equal(plan.kind, 'systemd-scope');
  assert.equal(plan.file, 'systemd-run');
  assert.deepEqual(plan.args, ['--user', '--scope', '--quiet', '--', 'tmux', ...TMUX_ARGS]);
});

test('systemd host: SYNTHESIZES the bus env Core lacks (measured: "Failed to connect to bus")', () => {
  // Core runs as a SYSTEM service (User=yi) with neither var set. Without these
  // two, systemd-run --user fails outright and no tmux server is created at all.
  const plan = planDetachedTmuxSpawn(TMUX_ARGS, probe());
  assert.equal(plan.env.XDG_RUNTIME_DIR, '/run/user/1000');
  assert.equal(plan.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
});

test('an inherited XDG_RUNTIME_DIR / DBUS address is preferred over the synthesized one', () => {
  const plan = planDetachedTmuxSpawn(TMUX_ARGS, probe({
    xdgRuntimeDir: '/custom/run',
    dbusAddress: 'unix:path=/custom/bus',
    pathExists: (p) => p === '/run/systemd/system' || p === '/custom/run',
  }));
  assert.equal(plan.kind, 'systemd-scope');
  assert.equal(plan.env.XDG_RUNTIME_DIR, '/custom/run');
  assert.equal(plan.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/custom/bus');
});

test('the tmux args are passed through after `--`, unreordered and unmangled', () => {
  // `-d`/`-s`/`-c` must reach tmux, not be eaten by systemd-run.
  const plan = planDetachedTmuxSpawn(TMUX_ARGS, probe());
  const sep = plan.args.indexOf('--');
  assert.ok(sep > 0, 'expected a `--` separator');
  assert.deepEqual(plan.args.slice(sep + 1), ['tmux', ...TMUX_ARGS]);
});

// ── root / container ──────────────────────────────────────────────────────

test('root: plans a SYSTEM scope (no /run/user/0, no user manager)', () => {
  const plan = planDetachedTmuxSpawn(TMUX_ARGS, probe({
    uid: 0,
    pathExists: (p) => p === '/run/systemd/system',
  }));
  assert.equal(plan.kind, 'systemd-scope');
  assert.deepEqual(plan.args, ['--scope', '--quiet', '--', 'tmux', ...TMUX_ARGS]);
  assert.deepEqual(plan.env, {}, 'the system bus needs no injected env');
});

// ── degradation, in order ─────────────────────────────────────────────────

test('systemd NOT running (e.g. a Docker CCR): falls back to setsid', () => {
  const plan = planDetachedTmuxSpawn(TMUX_ARGS, probe({
    pathExists: () => false, // no /run/systemd/system
  }));
  assert.equal(plan.kind, 'setsid');
  assert.deepEqual(plan.args, ['tmux', ...TMUX_ARGS]);
});

test('systemd-run absent: falls back to setsid', () => {
  const plan = planDetachedTmuxSpawn(TMUX_ARGS, probe({ hasBinary: (n) => n === 'setsid' }));
  assert.equal(plan.kind, 'setsid');
});

test('no user bus socket: falls back rather than planning a scope that cannot connect', () => {
  // /run/user/1000 exists but the bus socket does not — systemd-run --user would
  // fail at runtime, so do not plan it.
  const plan = planDetachedTmuxSpawn(TMUX_ARGS, probe({
    pathExists: (p) => p === '/run/systemd/system' || p === '/run/user/1000',
  }));
  assert.equal(plan.kind, 'setsid');
});

test('nothing available: falls back to a PLAIN tmux invocation (never fails to plan)', () => {
  const plan = planDetachedTmuxSpawn(TMUX_ARGS, probe({ hasBinary: () => false, pathExists: () => false }));
  assert.equal(plan.kind, 'plain');
  assert.equal(plan.file, 'tmux');
  assert.deepEqual(plan.args, [...TMUX_ARGS]);
});

test('every plan runs tmux with the SAME arguments — only the wrapper differs', () => {
  const plans = [
    planDetachedTmuxSpawn(TMUX_ARGS, probe()),
    planDetachedTmuxSpawn(TMUX_ARGS, probe({ uid: 0, pathExists: (p) => p === '/run/systemd/system' })),
    planDetachedTmuxSpawn(TMUX_ARGS, probe({ pathExists: () => false })),
    planDetachedTmuxSpawn(TMUX_ARGS, probe({ hasBinary: () => false, pathExists: () => false })),
  ];
  for (const plan of plans) {
    const tail = plan.args.slice(plan.args.indexOf('new-session'));
    assert.deepEqual(tail, TMUX_ARGS, `plan ${plan.kind} altered the tmux args`);
  }
});

test('the planner never mutates the caller\'s args array', () => {
  const args = [...TMUX_ARGS];
  planDetachedTmuxSpawn(args, probe());
  assert.deepEqual(args, TMUX_ARGS);
});

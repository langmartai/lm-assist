import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  decideWatchdog, pidFileFacts, probePort, watchdogDisabled, WATCHDOG_DEFAULTS,
  CORE_LAUNCH_TASK, coreRestartCommand,
  type WatchdogFacts, type WatchdogState,
} from '../elevated/watchdog';
import { INTERACTIVE_TASK } from '../windows-session-guard';

test('the restart goes ONLY through the interactive task — never a direct start from the elevated worker', () => {
  assert.deepEqual(coreRestartCommand(true), { cmd: 'schtasks', args: ['/run', '/tn', 'LmAssistCoreInteractive'] });
  assert.equal(coreRestartCommand(false), null, 'no task: refuse rather than start an ELEVATED Core');
  assert.equal(CORE_LAUNCH_TASK, INTERACTIVE_TASK, 'must name the same task the start planner redirects through');
});

const fresh: WatchdogState = { failures: 0, lastStartAt: null };
const dead: WatchdogFacts = { disabled: false, portOpen: false, pidFilePresent: true, pidAlive: false, now: 1_000_000 };

test('an open port is healthy and clears the failure count — even a slow Core is never restarted', () => {
  const r = decideWatchdog({ failures: 2, lastStartAt: null }, { ...dead, portOpen: true });
  assert.equal(r.action, 'healthy');
  assert.equal(r.next.failures, 0);
});

test('no pidfile = stopped on purpose (lm-assist stop / upgrade / lifecycle exit) — never restarted', () => {
  let s = fresh;
  for (let i = 0; i < 10; i++) {
    const r = decideWatchdog(s, { ...dead, pidFilePresent: false });
    assert.equal(r.action, 'stopped-on-purpose');
    s = r.next;
  }
  assert.equal(s.lastStartAt, null);
});

test('a live pid with a closed port (booting / stuck before listen) is left alone — a start would duplicate it', () => {
  const r = decideWatchdog({ failures: 2, lastStartAt: null }, { ...dead, pidAlive: true });
  assert.equal(r.action, 'pid-alive');
  assert.equal(r.next.failures, 0);
});

test('a dead Core is confirmed over `threshold` probes before the watchdog acts', () => {
  let s = fresh;
  const seen: string[] = [];
  for (let i = 0; i < WATCHDOG_DEFAULTS.threshold; i++) {
    const r = decideWatchdog(s, dead);
    seen.push(r.action);
    s = r.next;
  }
  assert.deepEqual(seen, [...Array(WATCHDOG_DEFAULTS.threshold - 1).fill('confirming'), 'start']);
  assert.equal(s.lastStartAt, dead.now);
  assert.equal(s.failures, 0);
});

test('one healthy probe in between resets the confirmation — flapping never reaches a restart', () => {
  let s = decideWatchdog(fresh, dead).next;
  s = decideWatchdog(s, { ...dead, portOpen: true }).next;
  const r = decideWatchdog(s, dead);
  assert.equal(r.action, 'confirming');
});

test('after a restart attempt the cooldown holds off the next one, then it may retry', () => {
  const s: WatchdogState = { failures: WATCHDOG_DEFAULTS.threshold - 1, lastStartAt: dead.now };
  const soon = decideWatchdog(s, { ...dead, now: dead.now + WATCHDOG_DEFAULTS.cooldownMs - 1 });
  assert.equal(soon.action, 'cooldown');
  const later = decideWatchdog(s, { ...dead, now: dead.now + WATCHDOG_DEFAULTS.cooldownMs });
  assert.equal(later.action, 'start');
});

test('disabled wins over everything', () => {
  assert.equal(decideWatchdog({ failures: 99, lastStartAt: null }, { ...dead, disabled: true }).action, 'disabled');
});

test('pidFileFacts — absent / live / dead / pre-boot pidfile / garbage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  const f = path.join(dir, 'core-prod.pid');
  assert.deepEqual(pidFileFacts(f, () => true), { present: false, alive: false, pid: null });

  fs.writeFileSync(f, '4242');
  const boot = Date.now() - 60_000;
  assert.deepEqual(pidFileFacts(f, (p) => p === 4242, boot), { present: true, alive: true, pid: 4242 });
  assert.deepEqual(pidFileFacts(f, () => false, boot), { present: true, alive: false, pid: 4242 });

  // Written before the last boot: that pid may belong to anything now — never "alive".
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(f, past, past);
  assert.deepEqual(pidFileFacts(f, () => true, Date.now() - 60_000), { present: true, alive: false, pid: 4242 });

  fs.writeFileSync(f, 'not-a-pid');
  assert.deepEqual(pidFileFacts(f, () => true, boot), { present: true, alive: false, pid: null });
});

test('watchdogDisabled — env values and the flag file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  const flag = path.join(dir, 'watchdog.off');
  assert.equal(watchdogDisabled(flag, {}), false);
  for (const v of ['0', 'off', 'FALSE', ' no ']) assert.equal(watchdogDisabled(flag, { LM_CORE_WATCHDOG: v }), true, v);
  assert.equal(watchdogDisabled(flag, { LM_CORE_WATCHDOG: '1' }), false);
  fs.writeFileSync(flag, '');
  assert.equal(watchdogDisabled(flag, {}), true);
});

test('probePort — true while something listens, false once it is gone', async () => {
  const srv = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  assert.equal(await probePort(port), true);
  await new Promise<void>((r) => srv.close(() => r()));
  assert.equal(await probePort(port), false);
});

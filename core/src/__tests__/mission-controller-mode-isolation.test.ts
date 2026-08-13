// DEV/PROD controller isolation on ONE host.
//
// Incident 2026-08-12→13 (117): a dev Core (:3200) and a prod Core (:3100) BOTH ran the
// mission-controller supervisor, both elected themselves monitor (separate hubs → separate
// elections), and shared every piece of node-local controller state:
//   • the workspace ~/.lm-assist/mission-control (→ the same resumable lineage, so BOTH
//     resumed the same session 5a2f797e and hammered it),
//   • the `lmcc-` tmux namespace (→ each one's stray-sweep killed the OTHER's controller,
//     which made isLive() false, which relaunched, which swept … 136 launches in 8 hours),
//   • the controller extras dir ~/.lm-assist/controller (dev's hub key + :3200 MCP config
//     overwriting prod's, and vice versa).
// The mode suffix makes all three disjoint, so the two Cores cannot see — or destroy —
// each other's controller.
import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  pickStrayControllers,
  controllerTmuxPrefix,
  controllerModeSuffix,
  controllerExtrasDir,
  ensureControllerWorkspace,
} from '../mission/mission-controller';

test('controllerTmuxPrefix: dev and prod names are mutually non-prefixing', () => {
  const prod = controllerTmuxPrefix(false);
  const dev = controllerTmuxPrefix(true);
  assert.notEqual(prod, dev);
  // The sweep matches on `<prefix>-`; neither namespace may match the other's names.
  assert.equal(`${dev}-abc`.startsWith(`${prod}-`), false);
  assert.equal(`${prod}-abc`.startsWith(`${dev}-`), false);
});

test('pickStrayControllers: a Core never sweeps the OTHER mode\'s controller', () => {
  const prod = controllerTmuxPrefix(false);
  const dev = controllerTmuxPrefix(true);
  const live = [`${prod}-mine`, `${prod}-dup`, `${dev}-theirs`, 'lmt-x', 'lmx-executor'];

  // Prod's sweep: its own duplicate only. The dev controller is NOT a stray.
  assert.deepEqual(pickStrayControllers(live, `${prod}-mine`, prod), [`${prod}-dup`]);
  // Dev's sweep: prod's windows are invisible to it, and its own recorded one survives.
  assert.deepEqual(pickStrayControllers(live, `${dev}-theirs`, dev), []);
  assert.deepEqual(pickStrayControllers([...live, `${dev}-dup`], `${dev}-theirs`, dev), [`${dev}-dup`]);
});

test('pickStrayControllers: default prefix is this process\'s own mode', () => {
  const mine = controllerTmuxPrefix();
  assert.deepEqual(pickStrayControllers([`${mine}-a`, `${mine}-b`], `${mine}-a`), [`${mine}-b`]);
});

test('controllerModeSuffix: empty for prod, marked for dev', () => {
  assert.equal(controllerModeSuffix(false), '');
  assert.notEqual(controllerModeSuffix(true), '');
});

test('workspace + extras dirs are disjoint between dev and prod', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mode-'));
  try {
    const prodWs = ensureControllerWorkspace(base, false);
    const devWs = ensureControllerWorkspace(base, true);
    assert.notEqual(prodWs, devWs);
    assert.ok(fs.existsSync(prodWs) && fs.existsSync(devWs));
    // Each workspace is self-seeded (CLAUDE.md) — a dev controller must not inherit
    // prod's lineage/journal, which is what made both resume the same session.
    assert.ok(fs.existsSync(path.join(devWs, 'CLAUDE.md')));

    assert.notEqual(controllerExtrasDir(base, false), controllerExtrasDir(base, true));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/**
 * Unit tests for inspector.ts — phase / dialog / mode / context detection.
 *
 * Pure functions against canned screen text. No tmux, no CC, no API.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { derivePhase, deriveMode, deriveDialog, parseContextPct, getAuthInfo } from '../../terminal/inspector';

// Canned screen fragments lifted from real CC v2.1.x output.
const TRUST_SCREEN = `
╭─ Quick safety check ──────────────────────────╮
│ Is this a project you created or one you trust?
│
│  ❯ 1. Yes, I trust this folder
│    2. No, exit
╰───────────────────────────────────────────────╯
`;

const IDLE_SCREEN = `
────────────────────────────────────────────────────
❯ Try "fix lint errors"
────────────────────────────────────────────────────
  /tmp main · no worktrees · ctx: 7% · ram:276M
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

const BUSY_SCREEN = `
⏺ Working on your request...

  Using tool: Bash
  Command: ls /tmp

────────────────────────────────────────────────────
  ctx: 12% · ram:280M
`;

const PERMISSION_SCREEN = `
────────────────────────────────────────────────────
Do you want to allow this action?
   ❯ 1. Yes
     2. No
────────────────────────────────────────────────────
`;

const COMPACT_SCREEN = `
You're approaching the context limit.
Compact this conversation now? (y/n)
   ❯ y
`;

const PLAN_SCREEN = `
⏺ plan mode

  Step 1: ...
  Step 2: ...
────────────────────────────────────────────────────
❯
  ctx: 35% · plan mode on
`;

const CHOICE_SCREEN = `
Please pick an option:
   ❯ 1. Option A
     2. Option B
     3. Option C
     4. Cancel
`;

const BASH_ONLY_SCREEN = `
ubuntu@host:/tmp$ ls
file1  file2
ubuntu@host:/tmp$
`;

// ---------- derivePhase ----------

test('derivePhase: null paneCommand → dead', () => {
  assert.equal(derivePhase(null, ''), 'dead');
});

test('derivePhase: bash + no markers → dead', () => {
  assert.equal(derivePhase('bash', BASH_ONLY_SCREEN), 'dead');
});

test('derivePhase: node + no markers → launching (CC starting up)', () => {
  assert.equal(derivePhase('node', ''), 'launching');
});

test('derivePhase: zsh + no markers → dead (known shell)', () => {
  assert.equal(derivePhase('zsh', BASH_ONLY_SCREEN), 'dead');
});

test('derivePhase: trust prompt screen → trust-prompt', () => {
  assert.equal(derivePhase('node', TRUST_SCREEN), 'trust-prompt');
});

test('derivePhase: idle screen → idle', () => {
  assert.equal(derivePhase('node', IDLE_SCREEN), 'idle');
});

test('derivePhase: busy screen → busy', () => {
  assert.equal(derivePhase('node', BUSY_SCREEN), 'busy');
});

test('derivePhase: permission screen → permission', () => {
  assert.equal(derivePhase('node', PERMISSION_SCREEN), 'permission');
});

test('derivePhase: plan mode screen → plan-mode', () => {
  assert.equal(derivePhase('node', PLAN_SCREEN), 'plan-mode');
});

// ---------- deriveDialog ----------

test('deriveDialog: trust', () => { assert.equal(deriveDialog(TRUST_SCREEN), 'trust'); });
test('deriveDialog: permission', () => { assert.equal(deriveDialog(PERMISSION_SCREEN), 'permission'); });
test('deriveDialog: compact', () => { assert.equal(deriveDialog(COMPACT_SCREEN), 'compact'); });
test('deriveDialog: choice', () => { assert.equal(deriveDialog(CHOICE_SCREEN), 'choice'); });
test('deriveDialog: no dialog on idle', () => { assert.equal(deriveDialog(IDLE_SCREEN), null); });
test('deriveDialog: no dialog on busy', () => { assert.equal(deriveDialog(BUSY_SCREEN), null); });
test('deriveDialog: no dialog on bash-only', () => { assert.equal(deriveDialog(BASH_ONLY_SCREEN), null); });

// ---------- deriveMode ----------

test('deriveMode: idle screen → normal', () => { assert.equal(deriveMode(IDLE_SCREEN), 'normal'); });
test('deriveMode: plan screen → plan', () => { assert.equal(deriveMode(PLAN_SCREEN), 'plan'); });
test('deriveMode: bash-only screen → unknown (no CC footer)', () => {
  assert.equal(deriveMode(BASH_ONLY_SCREEN), 'unknown');
});

// ---------- parseContextPct ----------

test('parseContextPct: "ctx: 7%" → 7', () => { assert.equal(parseContextPct('foo ctx: 7% bar'), 7); });
test('parseContextPct: "ctx:42%" (no space) → 42', () => { assert.equal(parseContextPct('ctx:42%'), 42); });
test('parseContextPct: "ctx: 100%" → 100', () => { assert.equal(parseContextPct('ctx: 100%'), 100); });
test('parseContextPct: missing → null', () => { assert.equal(parseContextPct('no footer here'), null); });
test('parseContextPct: out of range (200%) → null', () => { assert.equal(parseContextPct('ctx: 200%'), null); });

// ---------- getAuthInfo ----------
//
// We can't unit-test the config-file path without mocking fs; that's covered
// by the live T1b integration test. But we CAN unit-test the screen fallback
// path by passing screen text. The function tries fs FIRST though, so if
// ~/.claude.json is readable on this host, we'll get the config-derived
// answer. The test below works on EITHER outcome — what matters is that the
// function returns a well-formed { state, email } shape.

test('getAuthInfo: returns well-formed shape', () => {
  const info = getAuthInfo('');
  assert.ok(['authenticated', 'unauthenticated', 'unknown'].includes(info.state));
  assert.ok(info.email === null || typeof info.email === 'string');
});

test('getAuthInfo: with no fs path (impossible to force here without mock) — sanity', () => {
  // The screen-fallback indicators only kick in if ~/.claude.json doesn't
  // exist. On a dev machine it does. This test just verifies the function
  // doesn't crash on any input.
  const info = getAuthInfo('Please log in via OAuth at auth.anthropic.com');
  assert.ok(typeof info.state === 'string');
});

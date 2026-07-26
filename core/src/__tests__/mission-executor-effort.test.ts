import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effortFlags, buildLaunchCmd } from '../terminal/cc';
import { missionEffort } from '../mission/mission-model';

// Executors used to launch with NO --effort at all, so every worker silently ran at the
// CLI default while briefs claimed "max thinking". These lock the flag in.

test('valid levels are forwarded', () => {
  for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(effortFlags(lvl), ['--effort', lvl]);
  }
});

test('an INVALID level is dropped, never forwarded', () => {
  // claude warns + falls back to default on an unknown value, so forwarding it would
  // look like effort was applied when it was not.
  for (const bad of ['bogus', 'MAX', 'ultra', ' ', '']) {
    assert.deepEqual(effortFlags(bad), [], `should drop: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(effortFlags(undefined), []);
});

test('buildLaunchCmd emits --effort only when set', () => {
  const base = { cwd: '/tmp', model: null, extraFlags: [], skipPermissions: true, remoteControl: true,
    cols: 200, rows: 50, readyPattern: 'ctx:', readyTimeoutMs: 1000, autoAcceptTrust: true } as never;
  assert.match(buildLaunchCmd({ ...(base as object), effort: 'max' } as never), /--effort max/);
  assert.doesNotMatch(buildLaunchCmd(base), /--effort/);
  assert.doesNotMatch(buildLaunchCmd({ ...(base as object), effort: 'nope' } as never), /--effort/);
});

test('policy: explicit env.effort wins over priority', () => {
  assert.equal(missionEffort({ env: { effort: 'low' }, tags: { priority: ['critical'] } }), 'low');
});

test('policy: critical/high default to max, others inherit the CLI default', () => {
  assert.equal(missionEffort({ tags: { priority: ['critical'] } }), 'max');
  assert.equal(missionEffort({ tags: { priority: ['high'] } }), 'max');
  assert.equal(missionEffort({ tags: { priority: ['med'] } }), undefined);
  assert.equal(missionEffort({ tags: {} }), undefined);
  assert.equal(missionEffort(null), undefined);
});

// MCP exposure: an LLM must be able to CHOOSE effort, and its choice must survive a
// connector that drops nested objects.
import { liftEffort } from '../mcp-server/tools/mission';

test('top-level effort is folded into env.effort (survives nested-env drop)', () => {
  const out = liftEffort({ title: 't', effort: 'max' } as Record<string, unknown>);
  assert.deepEqual((out as { env: Record<string, unknown> }).env, { effort: 'max' });
  assert.equal((out as { effort?: string }).effort, undefined, 'flat alias is consumed');
});

test('explicit env.effort always wins over the alias', () => {
  const out = liftEffort({ effort: 'low', env: { effort: 'max', repo: '/x' } } as Record<string, unknown>);
  assert.equal((out as { env: { effort: string } }).env.effort, 'max');
  assert.equal((out as { env: { repo: string } }).env.repo, '/x', 'other env fields preserved');
});

test('no effort given → payload untouched', () => {
  const input = { title: 't', env: { repo: '/x' } };
  assert.deepEqual(liftEffort({ ...input } as Record<string, unknown>), input);
});

// The persistence gap that made the whole feature look wired-but-dead: the create/patch
// routes whitelist env fields, so an un-whitelisted `effort` was silently DROPPED — the
// mission stored no effort and the executor launched at default while the caller believed
// it had asked for max. (Caught live: env.effort came back empty on a real create.)
test('effort must survive create/patch — it is whitelisted, not free-form', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../routes/core/mission.routes.ts'), 'utf8') as string;
  const create = src.slice(src.indexOf('resources: arr(env.resources)'));
  assert.match(create.slice(0, 600), /effort:\s*ccEffortOrUndefined/, 'create must carry env.effort');
  assert.match(src, /if \(e\.effort !== undefined\)/, 'patch must carry env.effort');
  assert.match(src, /INVALID_EFFORT/, 'an unknown level must be rejected, not stored');
});

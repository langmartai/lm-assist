import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  repoFromConfig,
  mapAccountSession,
  normalizePermissionMode,
  buildSetModelEvent,
  buildSetPermissionModeEvent,
  buildCreateBody,
} from '../terminal/ccr-cloud';

test('repoFromConfig: prefers outcomes git_info (repo + first branch)', () => {
  const r = repoFromConfig({ outcomes: [{ type: 'git_repository', git_info: { repo: 'langmartai/lm-assist', branches: ['feat/x', 'main'] } }] });
  assert.deepEqual(r, { repo: 'langmartai/lm-assist', branch: 'feat/x' });
});

test('repoFromConfig: falls back to sources url + revision', () => {
  const r = repoFromConfig({ sources: [{ type: 'git_repository', url: 'https://github.com/langmartai/lm-assist', revision: 'main' }] });
  assert.deepEqual(r, { repo: 'langmartai/lm-assist', branch: 'main' });
});

test('repoFromConfig: null repo/branch when neither present', () => {
  assert.deepEqual(repoFromConfig({}), { repo: null, branch: null });
  assert.deepEqual(repoFromConfig({ sources: [{ type: 'git_repository', url: 'not-a-repo' }] }), { repo: null, branch: null });
});

test('mapAccountSession: full cloud row from a real list payload', () => {
  const raw = {
    id: 'cse_01ABC',
    title: 'build-cowork-chat-ui',
    config: { model: 'claude-sonnet-5', outcomes: [{ git_info: { repo: 'langmartai/lm-assist', branches: ['main'] } }] },
    connection_status: 'connected',
    environment_kind: 'anthropic_cloud',
    status_bucket: 'review_ready',
    worker_status: 'idle',
    unread: true,
    created_at: '2026-07-10T21:17:30Z',
    last_event_at: '2026-07-11T07:38:02Z',
    tags: ['cowork'],
    external_metadata: { post_turn_summary: { status_category: 'need_input', status_detail: 'Which would you like?', needs_action: 'pick one' } },
  };
  const s = mapAccountSession(raw);
  assert.equal(s.sid, 'cse_01ABC');
  assert.equal(s.title, 'build-cowork-chat-ui');
  assert.equal(s.model, 'claude-sonnet-5');
  assert.equal(s.repo, 'langmartai/lm-assist');
  assert.equal(s.branch, 'main');
  assert.equal(s.kind, 'cloud');
  assert.equal(s.statusBucket, 'review_ready');
  assert.equal(s.workerStatus, 'idle');
  assert.equal(s.statusCategory, 'need_input');
  assert.equal(s.statusDetail, 'Which would you like?');
  assert.equal(s.needsAction, 'pick one');
  assert.equal(s.unread, true);
  assert.equal(s.webUrl, 'https://claude.ai/code/cse_01ABC');
});

test('mapAccountSession: bridge env → kind:remote; current_branches overrides branch', () => {
  const s = mapAccountSession({
    id: 'cse_02',
    environment_kind: 'bridge',
    config: { outcomes: [{ git_info: { repo: 'o/r', branches: ['stale'] } }] },
    external_metadata: { current_branches: { 'o/r': 'live-branch' } },
  });
  assert.equal(s.kind, 'remote');
  assert.equal(s.branch, 'live-branch');
  assert.equal(s.title, '(untitled)');
});

test('normalizePermissionMode: UI labels → wire values', () => {
  assert.equal(normalizePermissionMode('Manual'), 'default');
  assert.equal(normalizePermissionMode('Accept edits'), 'acceptEdits');
  assert.equal(normalizePermissionMode('accept-edits'), 'acceptEdits');
  assert.equal(normalizePermissionMode('Plan'), 'plan');
  assert.equal(normalizePermissionMode('Auto'), 'auto');
  assert.equal(normalizePermissionMode('nonsense'), 'default');
  assert.equal(normalizePermissionMode(undefined), 'default');
});

test('buildSetModelEvent: control_request payload with fixed ids', () => {
  assert.deepEqual(buildSetModelEvent('claude-opus-4-8', { requestId: 'r1', uuid: 'u1' }), {
    payload: { type: 'control_request', request_id: 'r1', request: { subtype: 'set_model', model: 'claude-opus-4-8' }, uuid: 'u1' },
  });
});

test('buildSetPermissionModeEvent: control_request payload with fixed ids', () => {
  assert.deepEqual(buildSetPermissionModeEvent('plan', { requestId: 'r2', uuid: 'u2' }), {
    payload: { type: 'control_request', request_id: 'r2', request: { subtype: 'set_permission_mode', mode: 'plan' }, uuid: 'u2' },
  });
});

test('buildCreateBody: effort → session_context.effort_level (only when provided)', () => {
  const withEffort = buildCreateBody({ model: 'claude-sonnet-5', environmentId: 'env_1', effort: 'high' });
  assert.equal((withEffort.session_context as any).effort_level, 'high');
  const without = buildCreateBody({ model: 'claude-sonnet-5', environmentId: 'env_1' });
  assert.equal('effort_level' in (without.session_context as any), false);
});

// Summary projections + paging for the collection tools (backlog bl_5cc4bad9).
//
// The central ceiling in result-cap.ts makes an oversized result survivable; these
// projections make it unnecessary. Sizes quoted below were measured live on node 117
// prod (:3100) on 2026-07-26 before the change.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detailLevel,
  intArg,
  paginate,
  clip,
  missionSummary,
  ccSessionSummary,
  claudeaiPluginSummary,
  backlogItemSummary,
  compactBacklogWrite,
  compactActor,
  missionWorkflowSummary,
  missionChangeSummary,
  projectMissions,
  DEFAULT_LIMIT_FULL,
  DEFAULT_LIMIT_SUMMARY,
} from '../mcp-server/tools/projections';

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v, null, 2), 'utf8');

/** A mission shaped like the real ones: the bulk is narrative, not identity. */
function fatMission(i: number): Record<string, unknown> {
  return {
    id: `mission_${i}`,
    title: `Mission ${i}`,
    status: 'active',
    progress: { percent: 40 },
    parentId: null,
    dependsOn: [`mission_${i - 1}`],
    binding: { sessionId: `cse_${i}`, kind: 'worker', extra: 'x'.repeat(200) },
    env: { host: 'node-117', isolation: 'worktree', repo: '/home/ubuntu/lm-assist', branch: 'main', resources: [] },
    tags: { ctl: ['surfaced:' + 'y'.repeat(400)] },
    objective: 'o'.repeat(8_348), // measured length of a live objective
    plan: 'p'.repeat(2_000),
    nextSteps: ['a', 'b', 'c'],
    results: Array.from({ length: 20 }, () => ({ ref: 'r'.repeat(500), summary: 's'.repeat(2_000) })),
    history: Array.from({ length: 50 }, () => ({ actor: { a: 1, b: 2 }, diff: { objective: { from: 'f'.repeat(500), to: 't'.repeat(500) } } })),
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-26T00:00:00Z',
  };
}

// ─── the core claim ──────────────────────────────────────────────────────

test('the summary projection collapses a fleet of missions from ~MB to ~KB', () => {
  const fleet = Array.from({ length: 50 }, (_, i) => fatMission(i));
  const before = bytes(fleet);
  const after = bytes(projectMissions(fleet, {}, 'mission_list'));
  // Live measurement before the change was 923,758 bytes for this fleet.
  assert.ok(before > 500_000, `fixture must be realistically fat, was ${before}`);
  assert.ok(after < 65_536, `summary must fit the default ceiling, was ${after}`);
  assert.ok(before / after > 20, `expected a >20x cut, got ${(before / after).toFixed(1)}x`);
});

test('a summary keeps identity, state and everything placement needs', () => {
  const s = missionSummary(fatMission(7));
  for (const k of ['id', 'title', 'status', 'progressPercent', 'dependsOn', 'binding', 'env', 'tags']) {
    assert.ok(k in s, `summary dropped ${k}, which the Mission Controller needs`);
  }
  assert.equal((s.binding as Record<string, unknown>).sessionId, 'cse_7');
  assert.equal((s.env as Record<string, unknown>).host, 'node-117');
});

test('a summary drops ONLY the narrative bulk, and says what it dropped', () => {
  const s = missionSummary(fatMission(1));
  for (const k of ['objective', 'plan', 'results', 'history', 'adjustments']) {
    assert.ok(!(k in s), `summary must not carry ${k}`);
  }
  // …but a list with no hint of what each mission is FOR is barely a list, so the
  // objective survives as a bounded preview (audit: objective is 20.1% of the payload,
  // mean 2,836 chars, max 15,890 — whole is untenable, absent is useless).
  assert.match(String(s.objectivePreview), /^o{200}… \[\+8148 chars\]$/);
  // Silence here is the danger: a caller must not conclude "this mission has no results".
  const omitted = s.omitted as Record<string, number>;
  assert.equal(omitted.objectiveChars, 8_348);
  assert.equal(omitted.results, 20);
  assert.equal(omitted.history, 50);
});

test('detail:"full" still returns whole missions — the controller depends on it', () => {
  const fleet = [fatMission(1), fatMission(2)];
  const res = projectMissions(fleet, { detail: 'full' }, 'mission_list') as Record<string, unknown>;
  const rows = res.missions as Array<Record<string, unknown>>;
  assert.equal(res.detail, 'full');
  assert.equal(typeof rows[0].objective, 'string');
  assert.equal((rows[0].objective as string).length, 8_348, 'full mode must not clip');
  assert.ok(Array.isArray(rows[0].history), 'full mode must keep history');
});

test('an unrecognised detail value fails SAFE (summary), never open', () => {
  // This is a size guard: guessing "full" from a typo would reopen the hole.
  for (const v of ['detailed', 'FULLY', 'yes', '', null, undefined, 0, {}]) {
    assert.equal(detailLevel(v), 'summary', `detail=${JSON.stringify(v)} must fall back to summary`);
  }
  for (const v of ['full', 'FULL', 'all', true]) assert.equal(detailLevel(v), 'full');
});

// ─── paging ──────────────────────────────────────────────────────────────

test('paging reports total and hasMore, so a page is never mistaken for the whole set', () => {
  const fleet = Array.from({ length: 50 }, (_, i) => fatMission(i));
  const page1 = projectMissions(fleet, { limit: 10, offset: 0 }, 'mission_list') as Record<string, unknown>;
  assert.equal(page1.shown, 10);
  assert.equal(page1.total, 50);
  assert.equal(page1.hasMore, true);
  const last = projectMissions(fleet, { limit: 10, offset: 45 }, 'mission_list') as Record<string, unknown>;
  assert.equal(last.shown, 5);
  assert.equal(last.hasMore, false, 'the final page must say so');
});

test('full mode pages smaller than summary mode, because a full record is ~20KB', () => {
  const fleet = Array.from({ length: 50 }, (_, i) => fatMission(i));
  const full = projectMissions(fleet, { detail: 'full' }, 'mission_list') as Record<string, unknown>;
  const summary = projectMissions(fleet, {}, 'mission_list') as Record<string, unknown>;
  assert.equal(full.shown, DEFAULT_LIMIT_FULL);
  assert.equal(summary.shown, DEFAULT_LIMIT_SUMMARY);
  assert.ok(DEFAULT_LIMIT_FULL < DEFAULT_LIMIT_SUMMARY);
});

test('id scopes the result — the cheap way to ask for one full mission', () => {
  const fleet = Array.from({ length: 50 }, (_, i) => fatMission(i));
  const res = projectMissions(fleet, { id: 'mission_7', detail: 'full' }, 'mission_list') as Record<string, unknown>;
  assert.equal(res.total, 1);
  assert.equal((res.missions as Array<Record<string, unknown>>)[0].id, 'mission_7');
});

test('every summarised result carries a hint saying how to get the rest', () => {
  const res = projectMissions([fatMission(1)], {}, 'mission_list') as Record<string, unknown>;
  assert.match(String(res.hint), /detail:"full"/);
  assert.match(String(res.hint), /limit, offset/);
});

test('intArg / paginate / clip edge cases', () => {
  assert.equal(intArg('25', 5), 25, 'MCP clients send numbers as strings');
  assert.equal(intArg(undefined, 5), 5);
  assert.equal(intArg(-3, 5), 5, 'negatives fall back');
  assert.equal(intArg('nonsense', 5), 5);
  assert.equal(intArg(99_999, 5), 1000, 'clamped to the hard max');
  assert.deepEqual(paginate([1, 2, 3], 2, 0).rows, [1, 2]);
  assert.deepEqual(paginate([1, 2, 3], 2, 2).rows, [3]);
  assert.deepEqual(paginate([1, 2, 3], 10, 99).rows, []);
  assert.equal(clip('short', 100), 'short');
  assert.match(String(clip('x'.repeat(50), 10)), /^x{10}… \[\+40 chars\]$/);
  assert.equal(clip('', 10), undefined);
});

// ─── the other offenders ─────────────────────────────────────────────────

test('cc_sessions summary drops the prose verdict and the absolute jsonl path', () => {
  const s = ccSessionSummary({
    sessionId: 'abc', jsonl: '/home/ubuntu/.claude/projects/x/sessions/abc.jsonl',
    owner: { pid: 42, cwd: '/repo', kind: 'code', status: 'running', entrypoint: 'e'.repeat(500) },
    verdict: { live: true, connectStrategy: 'attach-existing', reason: 'r'.repeat(400) },
  });
  assert.equal(s.sessionId, 'abc');
  assert.equal(s.pid, 42);
  assert.equal(s.live, true);
  assert.equal(s.connectStrategy, 'attach-existing');
  assert.ok(!('jsonl' in s) && !('reason' in s) && !('entrypoint' in s));
});

test('claudeai plugin summary replaces capability bodies with counts', () => {
  // Measured 1,156,396 bytes for 92 plugins — the largest result on the MCP surface.
  const plugin = {
    id: 'p1', name: 'thing', display_name: 'Thing', enabled: true, version: '1.0',
    description: 'd'.repeat(900),
    skills: Array.from({ length: 12 }, () => ({ name: 's', body: 'b'.repeat(2_000) })),
    commands: [{ name: 'c' }, { name: 'd' }],
    mcp_servers: [{ name: 'm' }],
  };
  const s = claudeaiPluginSummary(plugin);
  assert.equal(s.id, 'p1');
  assert.deepEqual(s.provides, { skills: 12, commands: 2, mcp_servers: 1 });
  assert.ok(!('skills' in s), 'capability bodies must be gone');
  assert.match(String(s.description), /\[\+700 chars\]$/, 'description clipped, not dropped');
  assert.ok(bytes(s) < bytes(plugin) / 20);
});

test('backlog write echo drops the accumulated discussion/review bodies', () => {
  // The 63KB backlog_create came from the IDEMPOTENT path echoing an existing item's
  // whole discussion history — the more an item is discussed, the more a write cost.
  const item = {
    id: 'bl_abc', title: 'T', type: 'feature', status: 'open', priority: 'med',
    description: 'd'.repeat(5_000),
    discussion: Array.from({ length: 16 }, () => ({ note: 'n'.repeat(4_000) })),
    reviews: Array.from({ length: 5 }, () => ({ note: 'r'.repeat(4_000) })),
    version: 3, rev: 3,
  };
  const s = backlogItemSummary(item);
  assert.ok(!('discussion' in s) && !('reviews' in s));
  assert.deepEqual(s.omitted, { descriptionChars: 5_000, discussion: 16, reviews: 5 });
  assert.equal(s.fullItem, 'backlog_get({id:"bl_abc"})', 'must say where the full item lives');
  assert.ok(bytes(s) < 2_000, `write echo should be ~1KB, was ${bytes(s)}`);
});

test('compactBacklogWrite preserves every non-item key the route returned', () => {
  const res = compactBacklogWrite({
    item: { id: 'bl_1', title: 'T', discussion: [{ note: 'x'.repeat(9_000) }] },
    changed: true, idempotent: true, idempotentReason: 'requestId',
    possibleDuplicates: [{ id: 'bl_2', title: 'U', score: 0.9 }],
  }) as Record<string, unknown>;
  assert.equal(res.changed, true);
  assert.equal(res.idempotent, true);
  assert.equal(res.idempotentReason, 'requestId');
  assert.deepEqual(res.possibleDuplicates, [{ id: 'bl_2', title: 'U', score: 0.9 }]);
  assert.ok(!('discussion' in (res.item as Record<string, unknown>)));
});

test('compactBacklogWrite passes through anything that is not an item envelope', () => {
  assert.equal(compactBacklogWrite(null), null);
  assert.equal(compactBacklogWrite('text'), 'text');
  assert.deepEqual(compactBacklogWrite({ error: 'nope' }), { error: 'nope' });
});

// ─── truncating tools must be NARROWABLE (audit mission_8bc12731 finding) ────

test('workflow summary drops the body — the body IS the workflow, and a list is not a read', () => {
  // Measured 116,668 B for 35 workflows; body ~2KB each plus a full state per rev.
  const w = { id: 'controller.pass', title: 'Controller pass', editPolicy: 'open', rev: 4,
    body: 'b'.repeat(2_000), history: [{}, {}, {}],
    lastUpdatedBy: { kind: 'local-session', id: 'ce6749c4-9b56-4', node: 'gw4-x', channel: 'mcp', label: '/very/long/path', toolUseId: 'toolu_x', at: 1 } };
  const s = missionWorkflowSummary(w);
  assert.ok(!('body' in s) && !('history' in s));
  assert.deepEqual(s.omitted, { bodyChars: 2_000, history: 3 });
  assert.equal(s.fullDoc, 'mission_workflow_get({id:"controller.pass"})');
  assert.equal(s.lastUpdatedBy, 'local-session:ce6749c4', 'the 7-field actor collapses');
});

test('mission change summary collapses the per-row actor', () => {
  const c = { missionId: 'mission_8bc12731', rev: 9, at: 1785033412982,
    actor: { kind: 'local-session', id: 'ce6749c4-9b56-4', node: 'gw4-x', channel: 'mcp', label: '/home/ubuntu/lm-assist/.claude/worktrees/x', toolUseId: 'toolu_x', at: 1 },
    changedFields: ['tags.ctl:readiness'] };
  const s = missionChangeSummary(c);
  assert.equal(s.by, 'local-session:ce6749c4');
  assert.ok(!('actor' in s), 'the full actor was the fattest field on every row');
  assert.deepEqual(s.changedFields, ['tags.ctl:readiness']);
  assert.ok(bytes(s) < bytes(c) / 2);
});

test('compactActor never throws on junk', () => {
  assert.equal(compactActor(null), undefined);
  assert.equal(compactActor('nope'), undefined);
  assert.equal(compactActor({}), 'actor');
  assert.equal(compactActor({ kind: 'human' }), 'human');
});

test('every tool the ceiling can truncate exposes a narrowing argument', () => {
  // The truncation marker tells the model to "pass this tool's paging/filter arguments".
  // For a tool with NO such argument that advice cannot be followed and repeating returns
  // the same prefix forever — the cap saves the conversation but becomes a dead end.
  const { MISSION_WORKFLOW_TOOL_DEFS } = require('../mcp-server/tools/mission-workflow');
  const { MISSION_SCHEDULE_TOOL_DEFS } = require('../mcp-server/tools/mission-schedule');
  const { MISSION_TOOL_DEFS } = require('../mcp-server/tools/mission');
  const { MISSION_QUERY_TOOL_DEFS } = require('../mcp-server/tools/mission-query');
  const defs = [...MISSION_WORKFLOW_TOOL_DEFS, ...MISSION_SCHEDULE_TOOL_DEFS, ...MISSION_TOOL_DEFS, ...MISSION_QUERY_TOOL_DEFS];
  const NARROWING = ['limit', 'offset', 'cursor', 'id', 'filter', 'since', 'sinceTs', 'detail'];
  for (const name of ['mission_workflow_list', 'mission_changes', 'mission_list', 'mission_query']) {
    const def = defs.find((d: { name: string }) => d.name === name);
    assert.ok(def, `${name} must be advertised`);
    const props = Object.keys(def.inputSchema.properties || {});
    assert.ok(props.some((p) => NARROWING.includes(p)),
      `${name} can be truncated but exposes no narrowing argument (has: ${props.join(',') || 'none'})`);
  }
});

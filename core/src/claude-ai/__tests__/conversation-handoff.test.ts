import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoff, extractPointers, humanTurns, toolsUsed } from '../conversation-handoff';

function conv(messages: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { uuid: 'src-uuid', name: 'Source chat', chat_messages: messages, ...extra };
}
const human = (text: string) => ({ sender: 'human', content: [{ type: 'text', text }] });
const asst = (blocks: Array<Record<string, unknown>>) => ({ sender: 'assistant', content: blocks });

// ── pointers ────────────────────────────────────────────────────────────────

test('extracts fleet ids by kind from text and tool payloads', () => {
  const p = extractPointers([
    human('check mission_df5c1595 and bl_e97d8da1'),
    asst([
      { type: 'tool_use', name: 'get_execution', input: { id: 'exec_abc123def' } },
      { type: 'tool_result', content: [{ type: 'text', text: 'node gw4-332c6620-92db-4d57-99dc-db49f29faa39 ok, see K001' }] },
    ]),
  ]);
  assert.deepEqual(p.missions, ['mission_df5c1595']);
  assert.deepEqual(p.backlog, ['bl_e97d8da1']);
  assert.deepEqual(p.executions, ['exec_abc123def']);
  assert.deepEqual(p.nodes, ['gw4-332c6620-92db-4d57-99dc-db49f29faa39']);
  assert.deepEqual(p.knowledge, ['K001']);
});

test('a TOOL NAME is not offered as a session id', () => {
  // `session_footprints` is a tool; a pointer that leads nowhere costs the
  // successor a turn to discover. Real ids are session_01…/cse_01… (digit-led).
  const p = extractPointers([human('ran session_footprints, then read cse_01T4vuRjS5dawgfNRAwaasnS')]);
  assert.ok(!p.sessions.includes('session_footprints'), 'tool name must not be a session pointer');
  assert.deepEqual(p.sessions, ['cse_01T4vuRjS5dawgfNRAwaasnS']);
});

test('a node id\'s uuid half is not re-offered as a conversation uuid', () => {
  const p = extractPointers([human('node gw4-332c6620-92db-4d57-99dc-db49f29faa39 is the host')]);
  assert.deepEqual(p.nodes, ['gw4-332c6620-92db-4d57-99dc-db49f29faa39']);
  assert.deepEqual(p.conversations, [], 'the uuid inside a gw4- id is not a conversation');
});

test('a real bare uuid is still captured', () => {
  const p = extractPointers([human('conversation f3737f46-2359-4604-be1c-e68933a223f6 is the source')]);
  assert.deepEqual(p.conversations, ['f3737f46-2359-4604-be1c-e68933a223f6']);
});

test('pointers are de-duplicated and capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => human(`mission_${String(i).padStart(8, 'a')}`));
  const p = extractPointers([...many, human('mission_aaaaaaa0'), human('mission_aaaaaaa0')]);
  assert.ok(p.missions.length <= 12, 'capped');
  assert.equal(new Set(p.missions).size, p.missions.length, 'de-duplicated');
});

// ── human turns ─────────────────────────────────────────────────────────────

test('carries human turns VERBATIM, newest-last', () => {
  const turns = humanTurns([human('first'), asst([{ type: 'text', text: 'reply' }]), human('second')]);
  assert.deepEqual(turns, ['first', 'second'], 'assistant prose is not carried');
});

test('keeps the most RECENT turns when over the cap', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => human(`turn${i}`));
  const turns = humanTurns(msgs, 3);
  assert.deepEqual(turns, ['turn7', 'turn8', 'turn9']);
});

test('an over-long human turn is truncated with an explicit marker', () => {
  const t = humanTurns([human('x'.repeat(5000))])[0];
  assert.ok(t.length < 5000);
  assert.match(t, /\[\+\d+ chars\]/);
});

test('sender "user" is accepted alongside "human"', () => {
  assert.deepEqual(humanTurns([{ sender: 'user', content: [{ type: 'text', text: 'hi' }] }]), ['hi']);
});

// ── tools ───────────────────────────────────────────────────────────────────

test('tool names are ranked by use and stripped of the connector prefix', () => {
  const t = toolsUsed([
    asst([{ type: 'tool_use', name: 'lm-assist langmart:guide', input: {} }]),
    asst([{ type: 'tool_use', name: 'lm-assist langmart:guide', input: {} }]),
    asst([{ type: 'tool_use', name: 'mission_update', input: {} }]),
  ]);
  assert.deepEqual(t, ['guide', 'mission_update'], 'most-used first, prefix stripped');
});

// ── the seed ────────────────────────────────────────────────────────────────

test('seed carries pointers + verbatim turns and tells the successor to RE-READ', () => {
  const built = buildHandoff({
    body: conv([
      human('use guide("ccr"), do not infer the taxonomy'),
      asst([{ type: 'tool_use', name: 'lm-assist langmart:guide', input: { topic: 'ccr' } }]),
      human('check mission_df5c1595'),
    ]),
  });
  assert.match(built.seed, /RE-READ the pointer/i);
  assert.match(built.seed, /mission_df5c1595/);
  assert.match(built.seed, /use guide\(\\"ccr\\"\), do not infer the taxonomy/);
  assert.match(built.seed, /https:\/\/claude\.ai\/chat\/src-uuid/);
  assert.equal(built.humanTurns, 2);
});

test('tool RESULT bodies are NOT copied into the seed', () => {
  // Re-importing them would recreate the context pressure the fork relieves —
  // tool results were 77% of the measured source record.
  const bulk = 'BULKRESULTBODY'.repeat(500);
  const built = buildHandoff({
    body: conv([asst([{ type: 'tool_result', content: [{ type: 'text', text: bulk }] }])]),
  });
  assert.ok(!built.seed.includes('BULKRESULTBODY'), 'tool result bodies must not ride along');
  assert.ok(built.seedChars < 5000);
});

test('a prior compaction summary is carried but explicitly flagged as inferred', () => {
  const built = buildHandoff({
    body: conv([
      { sender: 'assistant', content: [{ type: 'text', text: 'ok' }], compaction_summary: [{ type: 'text', text: 'EARLIER STUFF' }] },
    ]),
  });
  assert.match(built.seed, /EARLIER STUFF/);
  assert.match(built.seed, /SUMMARY/);
  assert.match(built.seed, /inferred/i, 'a summary must not be presented as verified');
});

test('the LAST compaction summary wins', () => {
  const built = buildHandoff({
    body: conv([
      { sender: 'assistant', content: [], compaction_summary: [{ type: 'text', text: 'OLDSUMMARY' }] },
      { sender: 'assistant', content: [], compaction_summary: [{ type: 'text', text: 'NEWSUMMARY' }] },
    ]),
  });
  assert.match(built.seed, /NEWSUMMARY/);
  assert.ok(!built.seed.includes('OLDSUMMARY'));
});

test('overrides set the title and objective', () => {
  const built = buildHandoff({
    body: conv([human('hi')]),
    overrides: { title: 'My Fork', objective: 'Finish the estimator.', extraPointers: ['docs/foo.md — the spec'] },
  });
  assert.equal(built.title, 'My Fork');
  assert.match(built.seed, /Finish the estimator\./);
  assert.match(built.seed, /docs\/foo\.md — the spec/);
});

test('default title derives from the source name', () => {
  assert.equal(buildHandoff({ body: conv([human('hi')]) }).title, 'Continued: Source chat');
});

test('an empty or malformed conversation still yields a usable seed', () => {
  for (const b of [null, {}, { chat_messages: 'nope' }]) {
    const built = buildHandoff({ body: b as unknown });
    assert.ok(built.seed.length > 0);
    assert.equal(built.humanTurns, 0);
  }
});

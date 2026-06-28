import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMergePrompt, extractMerged, llmMerge } from '../memory/llm-merge';

const input = {
  filename: 'fact.md',
  base: '---\nname: fact\ntype: project\n---\nbase body',
  local: '---\nname: fact\ntype: project\n---\nlocal change',
  peer: '---\nname: fact\ntype: project\n---\npeer change',
};

test('buildMergePrompt includes base/local/peer, filename, and the merge rules (no Claude Code impersonation)', () => {
  const { system, user } = buildMergePrompt(input);
  assert.doesNotMatch(system, /You are Claude Code/);
  assert.match(system, /merge two diverged versions/i);
  assert.match(system, /lose NO information/i);
  assert.match(user, /fact\.md/);
  assert.match(user, /base body/);
  assert.match(user, /local change/);
  assert.match(user, /peer change/);
});

test('extractMerged strips a ``` fence the model may add', () => {
  assert.equal(extractMerged('```markdown\nhello\n```'), 'hello');
  assert.equal(extractMerged('  plain\n'), 'plain');
});

test('llmMerge returns the merged file from the (mock) runner', async () => {
  const merged = '---\nname: fact\ntype: project\n---\nlocal change + peer change';
  const r = await llmMerge(input, async () => merged);
  assert.equal(r, merged);
});

test('llmMerge rejects a frontmatter-less merge when inputs had valid frontmatter', async () => {
  const r = await llmMerge(input, async () => 'just body, no frontmatter');
  assert.equal(r, null);
});

test('llmMerge degrades to null when the runner throws', async () => {
  const r = await llmMerge(input, async () => { throw new Error('LLM down'); });
  assert.equal(r, null);
});

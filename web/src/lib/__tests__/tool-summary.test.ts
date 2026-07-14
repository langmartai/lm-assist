import { describe, it, expect } from 'vitest';
import { summarizeToolCall, formatSummary, groupLabel, lineDiff, prettyToolName } from '../tool-summary';

describe('lineDiff', () => {
  it('counts added/removed lines by multiset', () => {
    expect(lineDiff('a\nb\nc', 'a\nb\nc\nd')).toEqual({ added: 1, removed: 0 });
    expect(lineDiff('a\nold\nc', 'a\nnew\nc')).toEqual({ added: 1, removed: 1 });
    expect(lineDiff('', 'x\ny')).toEqual({ added: 2, removed: 0 });
  });
});

describe('summarizeToolCall', () => {
  it('Read → basename target', () => {
    expect(summarizeToolCall('Read', { file_path: '/home/u/repo/App.tsx' })).toEqual({ verb: 'Read', target: 'App.tsx' });
  });
  it('Edit → diff stats', () => {
    const s = summarizeToolCall('Edit', { file_path: 'x/App.tsx', old_string: 'a\nb', new_string: 'a\nc\nd' });
    expect(s.verb).toBe('Edited');
    expect(s.target).toBe('App.tsx');
    expect(s.added).toBe(2); expect(s.removed).toBe(1);
  });
  it('Write → created + line count', () => {
    const s = summarizeToolCall('Write', { file_path: 'a/new.ts', content: 'one\ntwo\nthree' });
    expect(s).toEqual({ verb: 'Created', target: 'new.ts', added: 3, removed: 0 });
  });
  it('Bash → Ran + command', () => {
    expect(summarizeToolCall('Bash', { command: 'npm test' })).toEqual({ verb: 'Ran', target: 'npm test' });
  });
  it('MCP tool → Used + pretty name', () => {
    expect(summarizeToolCall('mcp__lm-assist__fs_read', { path: '/x' })).toEqual({ verb: 'Used', target: 'fs read' });
  });
});

describe('formatSummary', () => {
  it('adds +N -M for edits', () => {
    expect(formatSummary({ verb: 'Edited', target: 'App.tsx', added: 4, removed: 1 })).toBe('Edited App.tsx +4 -1');
  });
  it('omits stats when absent', () => {
    expect(formatSummary({ verb: 'Read', target: 'App.tsx' })).toBe('Read App.tsx');
  });
});

describe('groupLabel', () => {
  it('single call → its summary', () => {
    expect(groupLabel([{ name: 'Edit', input: { file_path: 'App.tsx', old_string: 'a', new_string: 'b' } }])).toBe('Edited App.tsx +1 -1');
  });
  it('multiple → category phrase, Ran-led when commands present', () => {
    expect(groupLabel([
      { name: 'Bash', input: { command: 'ls' } },
      { name: 'Bash', input: { command: 'pwd' } },
      { name: 'Read', input: { file_path: 'a.ts' } },
    ])).toBe('Ran 2 commands, read a file');
  });
  it('multiple reads', () => {
    expect(groupLabel([
      { name: 'Read', input: { file_path: 'a' } },
      { name: 'Read', input: { file_path: 'b' } },
    ])).toBe('Used read 2 files');
  });
  it('empty → empty string', () => {
    expect(groupLabel([])).toBe('');
  });
});

describe('prettyToolName', () => {
  it('strips the mcp prefix', () => {
    expect(prettyToolName('mcp__claude-in-chrome__navigate')).toBe('navigate');
    expect(prettyToolName('mcp__lm-assist__list_nodes')).toBe('list nodes');
  });
});

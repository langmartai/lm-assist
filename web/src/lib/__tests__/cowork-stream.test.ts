import { describe, it, expect } from 'vitest';
import { parseSseChunk, shouldUseSse, mergeEvents } from '../cowork-stream';

describe('parseSseChunk', () => {
  it('splits complete frames and keeps the remainder', () => {
    const { frames, rest } = parseSseChunk('id: 1\ndata: {"a":1}\n\nid: 2\ndata: partial');
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe('1');
    expect(frames[0].data).toBe('{"a":1}');
    expect(rest).toBe('id: 2\ndata: partial');
  });
});

describe('shouldUseSse', () => {
  it('polls (no SSE) for a relayed remote node', () => {
    expect(shouldUseSse({ isRemoteNode: true })).toBe(false);
    expect(shouldUseSse({ isRemoteNode: false })).toBe(true);
  });
});

describe('mergeEvents', () => {
  it('appends by sequence_num, dedups, keeps order', () => {
    const prev = [{ seq: 1, role: 'user' as const, text: 'hi' }];
    const next = mergeEvents(prev, [
      { sequence_num: '1', payload: { message: { role: 'user', content: 'hi' } } }, // dup
      { sequence_num: '2', payload: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendUserMessage', input: { message: 'DONE' } }] } } },
    ]);
    expect(next).toHaveLength(2);
    expect(next[1].text).toBe('DONE');
  });
});

/**
 * Compact chat extras for GET /sessions/:id — includeToolResults / includeSystemMessages.
 *
 * These extractors exist because includeRawMessages ships the whole raw stream
 * (measured 15x the payload) to answer "what did each tool return" and "what did
 * the system say". The tests pin the compact shape: pairing by tool_use_id, text
 * assembly from both content forms, per-entry caps with surrogate-safe cuts, and
 * the system-row content rules (turn_duration synthesis, summary fallback).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { extractCompactToolResults, extractCompactSystemMessages } from '../api/sessions-api';

function userMsg(lineIndex: number, blocks: any[]) {
  return { type: 'user', lineIndex, message: { role: 'user', content: blocks } };
}

test('tool results pair by tool_use_id and assemble text from both content forms', () => {
  const raw = [
    userMsg(10, [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'plain string result' }]),
    userMsg(12, [{
      type: 'tool_result', tool_use_id: 'tu_2',
      content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }],
    }]),
    // Non-result noise the extractor must skip
    { type: 'assistant', lineIndex: 11, message: { content: [{ type: 'text', text: 'hi' }] } },
    userMsg(13, [{ type: 'text', text: 'a normal user prompt' }]),
  ];
  const out = extractCompactToolResults(raw)!;
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].toolUseId, 'tu_1');
  assert.strictEqual(out[0].content, 'plain string result');
  assert.strictEqual(out[0].lineIndex, 10);
  assert.strictEqual(out[1].content, 'part one\npart two');
});

test('tool results: is_error survives, images are counted, empty input is undefined', () => {
  const raw = [
    userMsg(5, [{ type: 'tool_result', tool_use_id: 'tu_err', is_error: true, content: 'boom' }]),
    userMsg(6, [{
      type: 'tool_result', tool_use_id: 'tu_img',
      content: [{ type: 'image', source: {} }, { type: 'text', text: 'screenshot taken' }],
    }]),
  ];
  const out = extractCompactToolResults(raw)!;
  assert.strictEqual(out[0].isError, true);
  assert.strictEqual(out[1].isError, undefined);
  assert.match(out[1].content, /screenshot taken\n\[1 image\]/);
  assert.strictEqual(extractCompactToolResults([]), undefined);
  assert.strictEqual(extractCompactToolResults(undefined), undefined);
});

test('onlyIds restricts pairing to the returned toolUses window', () => {
  const raw = [
    userMsg(1, [{ type: 'tool_result', tool_use_id: 'tu_in', content: 'kept' }]),
    userMsg(2, [{ type: 'tool_result', tool_use_id: 'tu_out', content: 'dropped' }]),
  ];
  const out = extractCompactToolResults(raw, new Set(['tu_in']))!;
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].toolUseId, 'tu_in');
  // An empty window means NO extras — never the whole session's.
  assert.strictEqual(extractCompactToolResults(raw, new Set()), undefined);
});

test('tool results cap at 4000 chars without splitting a surrogate pair', () => {
  // 3999 chars then an emoji (2-unit surrogate pair) straddling the cap boundary
  const text = 'x'.repeat(3999) + '😀' + 'y'.repeat(50);
  const raw = [userMsg(1, [{ type: 'tool_result', tool_use_id: 'tu_cap', content: text }])];
  const out = extractCompactToolResults(raw)!;
  assert.strictEqual(out[0].truncated, true);
  assert.strictEqual(out[0].fullLength, text.length);
  // The cut must not end on a lone high surrogate
  const last = out[0].content.charCodeAt(out[0].content.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'content ends on a lone high surrogate');
  assert.ok(out[0].content.length <= 4000);
});

test('system rows: turn_duration synthesizes, summary falls back, caps apply', () => {
  const raw = [
    { type: 'system', subtype: 'turn_duration', durationMs: 95000, lineIndex: 2, timestamp: 't1' },
    { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', lineIndex: 3 },
    { type: 'system', subtype: 'init', lineIndex: 4 },
    { type: 'summary', summary: 'Session about widgets', lineIndex: 5 },
    { type: 'summary', lineIndex: 6 },
    { type: 'system', content: 'z'.repeat(2500), lineIndex: 7 },
    { type: 'progress', data: {}, lineIndex: 8 }, // must be skipped
  ];
  const out = extractCompactSystemMessages(raw)!;
  assert.strictEqual(out.length, 6);
  assert.strictEqual(out[0].content, 'Turn duration: 1m 35s');
  assert.strictEqual(out[0].durationMs, 95000);
  assert.strictEqual(out[1].content, 'Conversation compacted');
  assert.strictEqual(out[2].content, 'System: init');
  assert.strictEqual(out[3].content, 'Session about widgets');
  assert.strictEqual(out[4].content, 'Summary');
  assert.strictEqual(out[5].truncated, true);
  assert.strictEqual(out[5].content.length, 2000);
  assert.strictEqual(extractCompactSystemMessages([]), undefined);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeVoiceUrl } from '../voice/claude-voice-url';

test('base params always present; model/effort/thinking only when set', () => {
  const base = buildClaudeVoiceUrl({ org: 'O', conv: 'C', tz: 'Asia/Singapore' });
  assert.match(base, /^wss:\/\/claude\.ai\/api\/ws\/voice\/organizations\/O\/chat_conversations\/C\?/);
  assert.match(base, /input_encoding=opus/); assert.match(base, /output_format=pcm_16000/);
  assert.match(base, /voice=buttery/); assert.match(base, /client_platform=web_claude_ai/);
  assert.doesNotMatch(base, /(^|&)model=/);
  const full = buildClaudeVoiceUrl({ org: 'O', conv: 'C', model: 'claude-sonnet-5', effort: 'high', thinkingMode: 'on' });
  assert.match(full, /[?&]model=claude-sonnet-5/); assert.match(full, /[?&]effort=high/); assert.match(full, /[?&]thinking_mode=on/);
});

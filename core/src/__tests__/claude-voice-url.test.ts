import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaudeVoiceUrl,
  normalizeVoice,
  CLAUDE_VOICES,
  DEFAULT_CLAUDE_VOICE,
} from '../voice/claude-voice-url';

test('base params always present; model/effort/thinking only when set', () => {
  const base = buildClaudeVoiceUrl({ org: 'O', conv: 'C', tz: 'Asia/Singapore' });
  assert.match(base, /^wss:\/\/claude\.ai\/api\/ws\/voice\/organizations\/O\/chat_conversations\/C\?/);
  assert.match(base, /input_encoding=opus/); assert.match(base, /output_format=pcm_16000/);
  assert.match(base, /voice=buttery/); assert.match(base, /client_platform=web_claude_ai/);
  assert.doesNotMatch(base, /(^|&)model=/);
  const full = buildClaudeVoiceUrl({ org: 'O', conv: 'C', model: 'claude-sonnet-5', effort: 'high', thinkingMode: 'on' });
  assert.match(full, /[?&]model=claude-sonnet-5/); assert.match(full, /[?&]effort=high/); assert.match(full, /[?&]thinking_mode=on/);
});

test('the catalogue is claude.ai\'s own five voices, buttery first + default', () => {
  assert.deepEqual(
    CLAUDE_VOICES.map((v) => v.id),
    ['buttery', 'airy', 'mellow', 'glassy', 'rounded'],
    'ids must match claude.ai\'s shipped validator set exactly — a name it does not know is rejected at the WS upgrade',
  );
  assert.deepEqual(CLAUDE_VOICES.map((v) => v.label), ['Buttery', 'Airy', 'Mellow', 'Glassy', 'Rounded']);
  assert.equal(DEFAULT_CLAUDE_VOICE, 'buttery');
});

test('EVERY catalogue voice reaches the URL as voice=<id>', () => {
  for (const v of CLAUDE_VOICES) {
    const url = buildClaudeVoiceUrl({ org: 'O', conv: 'C', voice: v.id });
    assert.match(url, new RegExp(`[?&]voice=${v.id}(&|$)`), `${v.id} must survive into the query`);
  }
});

test('a selected voice does not disturb the other params', () => {
  const url = buildClaudeVoiceUrl({ org: 'O', conv: 'C', voice: 'glassy', model: 'claude-opus-4-8', effort: 'max', thinkingMode: 'on' });
  assert.match(url, /[?&]voice=glassy(&|$)/);
  assert.match(url, /[?&]model=claude-opus-4-8/);
  assert.match(url, /[?&]effort=max/);
  assert.match(url, /[?&]thinking_mode=on/);
  assert.match(url, /[?&]tts_speed=1\.00/);
  assert.doesNotMatch(url, /voice=buttery/);
});

test('unknown/empty voice degrades to the default instead of poisoning the upgrade', () => {
  // An unrecognised voice is not a soft error on claude.ai's side: the WS upgrade is
  // rejected and the session dies with no audio. Falling back keeps the call alive.
  for (const bad of ['Buttery', 'BUTTERY', 'nope', '', ' ', 'buttery ', 'airy;drop']) {
    assert.equal(normalizeVoice(bad), 'buttery', `${JSON.stringify(bad)} must fall back`);
    assert.match(buildClaudeVoiceUrl({ org: 'O', conv: 'C', voice: bad }), /[?&]voice=buttery(&|$)/);
  }
  assert.equal(normalizeVoice(undefined), 'buttery');
  assert.equal(normalizeVoice('mellow'), 'mellow');
});

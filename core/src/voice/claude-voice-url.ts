export interface ClaudeVoiceParams {
  org: string;
  conv: string;
  model?: string;
  effort?: string;
  thinkingMode?: string;
  voice?: string;
  tz?: string;
}

export function buildClaudeVoiceUrl(p: ClaudeVoiceParams): string {
  const q = new URLSearchParams({
    input_encoding: 'opus',
    input_sample_rate: '16000',
    input_channels: '1',
    output_format: 'pcm_16000',
    language: 'en',
    timezone: p.tz || 'UTC',
    tts_speed: '1.00',
    server_interrupt_enabled: 'true',
    voice: p.voice || 'buttery',
    client_aec: 'true',
    client_platform: 'web_claude_ai',
  });
  if (p.model) q.set('model', p.model);
  if (p.effort) q.set('effort', p.effort);
  if (p.thinkingMode) q.set('thinking_mode', p.thinkingMode);
  return `wss://claude.ai/api/ws/voice/organizations/${encodeURIComponent(p.org)}/chat_conversations/${encodeURIComponent(p.conv)}?${q.toString()}`;
}

/**
 * THE claude.ai voice WS URL contract. Mirrors claude.ai's own query builder verbatim
 * (its bundled `Rg(e)` — same keys, same order-independent set), so a URL we build is
 * indistinguishable from one its web app builds.
 */

/**
 * The voice/actor catalogue — WHO speaks back.
 *
 * Not invented and not guessed: read out of claude.ai's own shipped bundle, where two
 * independent definitions corroborate each other — the picker list
 * `[{id:"buttery",label:"Buttery"},…]` and the closed validator
 * `new Set(["buttery","airy","mellow","glassy","rounded"])`. There is no voice-catalogue
 * API (every plausible route 404s); the list ships in the client. See
 * `docs/claude-ai-voice-protocol.md` for the discovery method and how to re-derive it
 * when claude.ai ships new voices.
 */
export const CLAUDE_VOICES = [
  { id: 'buttery', label: 'Buttery' },
  { id: 'airy', label: 'Airy' },
  { id: 'mellow', label: 'Mellow' },
  { id: 'glassy', label: 'Glassy' },
  { id: 'rounded', label: 'Rounded' },
] as const;

/** claude.ai's own default (its bundled `JA="buttery"`). */
export const DEFAULT_CLAUDE_VOICE = 'buttery';

const VOICE_IDS: ReadonlySet<string> = new Set(CLAUDE_VOICES.map((v) => v.id));

/**
 * Whitelist a caller-supplied voice, falling back to the default — exactly what claude.ai
 * does when reading its own persisted choice (`if (set.has(v)) return v; … ?? "buttery"`).
 *
 * Load-bearing, not defensive dressing: the voice is a WS query param fixed at connect, so
 * an unknown value is not a soft error — claude.ai rejects the upgrade and the session dies
 * as `up_error` with no audio at all. Degrading to the default keeps the call alive.
 */
export function normalizeVoice(voice?: string): string {
  return voice && VOICE_IDS.has(voice) ? voice : DEFAULT_CLAUDE_VOICE;
}

export interface ClaudeVoiceParams {
  org: string;
  conv: string;
  model?: string;
  effort?: string;
  thinkingMode?: string;
  /** A `CLAUDE_VOICES` id. Anything else (or absent) degrades to `DEFAULT_CLAUDE_VOICE`. */
  voice?: string;
  tz?: string;
}

/**
 * A conversation uuid claude.ai will actually accept in the voice path.
 *
 * NOT cosmetic validation. Measured against the live upstream (2026-07-26):
 *   - a malformed id (`conv-e2e`, empty)  -> the WS upgrade is REJECTED, close 1006
 *   - a WELL-FORMED id that does not exist -> the upgrade is ACCEPTED: up_open,
 *     session_server_initialized, live interim transcripts — and every turn is then
 *     SILENTLY DISCARDED (`message_complete` never fires, nothing is persisted).
 *
 * So shape alone proves nothing about where speech will land; it only lets us refuse the
 * hopeless case in ~0ms instead of after ~3s of Chrome startup and a bare 1006. Existence
 * is what actually matters, and that is `assertConversationBinding` in claude-chrome.ts.
 */
export function isValidConversationUuid(conv: unknown): conv is string {
  return typeof conv === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conv);
}

/**
 * Recover `{org, conv}` from a URL built by `buildClaudeVoiceUrl`.
 *
 * The binding guard verifies THE URL IT IS ABOUT TO DIAL rather than a pair of ids passed
 * alongside it, so the thing checked and the thing used can never drift apart. Returns null
 * for anything that is not a claude.ai voice URL.
 */
export function parseClaudeVoiceUrl(url: string): { org: string; conv: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== 'claude.ai') return null;
  const m = u.pathname.match(/^\/api\/ws\/voice\/organizations\/([^/]+)\/chat_conversations\/([^/]+)$/);
  if (!m) return null;
  return { org: decodeURIComponent(m[1]), conv: decodeURIComponent(m[2]) };
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
    voice: normalizeVoice(p.voice),
    client_aec: 'true',
    client_platform: 'web_claude_ai',
  });
  if (p.model) q.set('model', p.model);
  if (p.effort) q.set('effort', p.effort);
  if (p.thinkingMode) q.set('thinking_mode', p.thinkingMode);
  return `wss://claude.ai/api/ws/voice/organizations/${encodeURIComponent(p.org)}/chat_conversations/${encodeURIComponent(p.conv)}?${q.toString()}`;
}

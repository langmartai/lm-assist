/**
 * Inspect a session JSONL to determine whether the Anthropic prompt cache is
 * still likely to be hot for that session, plus extract the model used.
 *
 * Anthropic ephemeral cache TTLs:
 *   - default: 5 min, sliding (refreshes on every cache read)
 *   - extended: 1 hour, sliding, requires beta header
 *
 * We can't directly observe the server-side cache state. We approximate it by:
 *   1. Finding the most recent assistant message timestamp
 *   2. Detecting which TTL tier the session uses (presence of
 *      `ephemeral_1h_input_tokens` in usage indicates 1h tier)
 *   3. Comparing now - lastTimestamp against the TTL minus a safety margin
 *
 * Returns "hot" only when high-confidence the cache is still valid. False
 * negatives (saying "cold" when actually still hot) just cost us a missed
 * optimization. False positives would waste a fork attempt that pays full
 * input rate, so we err conservative.
 */
import { readSessionLines, type SessionLine } from './jsonl-utils';

export interface SessionCacheState {
  /** True if cache likely still warm. */
  hot: boolean;
  /** The model used by the most recent assistant turn. */
  lastModel: string | null;
  /** Most recent assistant timestamp (ISO). */
  lastInferenceAt: string | null;
  /** Inferred TTL tier of the session ('1h' or '5m'). */
  ttlTier: '1h' | '5m';
  /** Computed elapsed milliseconds since lastInferenceAt. */
  elapsedMs: number;
  /** Effective TTL ms after subtracting safety margin. */
  effectiveTtlMs: number;
  /** Reason string for diagnostics. */
  reason: string;
}

/** Safety margin subtracted from raw TTL to avoid edge-of-window misses. */
const SAFETY_MARGIN_MS = 30_000;
const TTL_5M_MS = 5 * 60 * 1000;
const TTL_1H_MS = 60 * 60 * 1000;

export function detectSessionCacheState(sessionFile: string): SessionCacheState {
  const lines = readSessionLines(sessionFile);

  // Find most recent assistant message — we want both timestamp + model + usage tier
  let lastAssistant: SessionLine | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].type === 'assistant') {
      lastAssistant = lines[i];
      break;
    }
  }

  if (!lastAssistant || !lastAssistant.timestamp) {
    return {
      hot: false,
      lastModel: null,
      lastInferenceAt: null,
      ttlTier: '5m',
      elapsedMs: 0,
      effectiveTtlMs: TTL_5M_MS,
      reason: 'no assistant message in session',
    };
  }

  // Extract last model — but skip synthetic/placeholder models from curated sessions.
  // Scan backwards for the first real model (starts with 'claude-').
  let lastModel: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].type !== 'assistant') continue;
    const m = (lines[i].message as any)?.model;
    if (m && typeof m === 'string' && m.startsWith('claude-')) {
      lastModel = m;
      break;
    }
  }
  const usage = (lastAssistant.message as any)?.usage;

  // Detect TTL tier from cache_creation hints
  // - Presence of ephemeral_1h_input_tokens > 0 anywhere → session uses 1h tier
  // - Otherwise default to 5m
  let ttlTier: '1h' | '5m' = '5m';
  for (let i = lines.length - 1; i >= 0; i--) {
    const u = (lines[i].message as any)?.usage;
    const cc = u?.cache_creation;
    if (cc && (cc.ephemeral_1h_input_tokens > 0)) {
      ttlTier = '1h';
      break;
    }
    if (cc && (cc.ephemeral_5m_input_tokens > 0) && ttlTier === '5m') {
      // Confirmed at least one 5m write — keep tier as-is unless we find 1h
    }
  }

  const ttlMs = ttlTier === '1h' ? TTL_1H_MS : TTL_5M_MS;
  const effectiveTtlMs = ttlMs - SAFETY_MARGIN_MS;
  const lastInferenceAt = lastAssistant.timestamp!;
  const elapsedMs = Date.now() - new Date(lastInferenceAt).getTime();

  const hot = elapsedMs < effectiveTtlMs && elapsedMs >= 0;
  return {
    hot,
    lastModel,
    lastInferenceAt,
    ttlTier,
    elapsedMs,
    effectiveTtlMs,
    reason: hot
      ? `last inference ${Math.round(elapsedMs / 1000)}s ago, within ${ttlTier} TTL window (-30s margin)`
      : `last inference ${Math.round(elapsedMs / 1000)}s ago, exceeds ${ttlTier} TTL window`,
  };
}

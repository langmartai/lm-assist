/**
 * Server-side context estimate for a claude.ai WEB conversation — numbers only.
 *
 * Pure. Takes the raw conversation body from
 * `GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true`
 * (i.e. `readConversation(...).body`) and returns token estimates. It NEVER
 * returns message content: measuring a conversation's budget must not consume
 * the budget being measured.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Four things a naive implementation gets wrong. All four were MEASURED on a
 * real 62-message operational conversation (2.0 MB record), not assumed:
 *
 * 1. `msg.text` — the flat mirror field — was EMPTY on all 62 messages. Content
 *    lives only in `content[]` blocks, so a counter keyed on `msg.text` reports
 *    zero for a conversation that is nearly at its ceiling.
 *
 * 2. `display_content` is a SEPARATE, non-identical copy of a tool block used to
 *    RENDER the chat; it is not model input. It was 669 KB of that record's
 *    1.81 MB. Serializing whole blocks therefore roughly doubles the count. We
 *    read only the model-bearing fields: text.text, thinking.thinking,
 *    tool_use.input, tool_result.content.
 *
 * 3. The messages form a TREE, not a list. 10 of those 62 messages sat on dead
 *    branches (edited/retried turns) and are not in context at all. We walk the
 *    parent chain back from `current_leaf_message_uuid` and count only that.
 *
 * 4. 🔴 COMPACTION. claude.ai compacts a long conversation in place and records
 *    it as a `compaction_summary` on the assistant message where it happened.
 *    Its own note says: "This conversation was successfully compacted to free up
 *    space in the context window. This is a summary of the content that was
 *    discussed prior to compaction." So after a compaction the model no longer
 *    sees the earlier turns — it sees the summary. On that record:
 *
 *      naive whole-block JSON .............. 1,808,999 chars
 *      all chain messages, model fields only.. 892,971 chars
 *      LIVE context (post-compaction) ........ 475,302 chars
 *
 *    Naive counting over-reports the live figure by 3.8x — which would trip a
 *    "fork now" threshold on a conversation sitting at half its budget.
 *
 * ⇒ The estimate is NOT simply a lower bound (as the originating backlog item
 *   assumed). It over-counts (compaction, dead branches, display_content) AND
 *   under-counts (system prompt, tool schemas, other connectors). We therefore
 *   report `live` and `total` separately, plus an explicit `unmeasured[]`.
 */

/** Root sentinel claude.ai uses as the parent of the first message. */
export const ROOT_PARENT_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * chars-per-token, calibrated against Anthropic's /v1/messages/count_tokens
 * using real blocks sampled from a real operational conversation (6 samples per
 * class, 166 KB total). Measured 2026-07-26:
 *
 *   text                 6,674 chars ->  1,638 tok -> 4.074
 *   tool_use.input      21,452 chars ->  5,985 tok -> 3.584
 *   tool_result.content 138,140 chars -> 48,751 tok -> 2.834
 *
 * A single flat "4 chars/token" would under-count tool_result — the dominant
 * class in any operational chat — by about 30%. Ratios are deliberately per
 * block class for that reason. Prose-like classes (text, thinking) share the
 * text ratio; thinking is natural language and was not separately sampled.
 */
export const CHARS_PER_TOKEN = {
  text: 4.074,
  thinking: 4.074,
  tool_use: 3.584,
  tool_result: 2.834,
} as const;

export type BlockKind = keyof typeof CHARS_PER_TOKEN;

/** Default assumed context ceiling. claude.ai exposes no per-conversation
 *  ceiling on any account endpoint we can read, so this is an assumption and is
 *  reported as one (`ceilingSource: 'assumed'`). */
export const DEFAULT_CEILING_TOKENS = 1_000_000;

export interface TokenBreakdown {
  text: number;
  thinking: number;
  tool_use: number;
  tool_result: number;
}

export interface ConversationTokenEstimate {
  conversationUuid: string;
  /** What the model sees NOW: post-compaction summary + everything after it. */
  liveTokens: number;
  /** Every message on the active branch, as if never compacted. */
  totalTokens: number;
  /** liveTokens as a fraction of the ceiling, 0-100, one decimal. */
  pctOfCeiling: number;
  ceilingTokens: number;
  ceilingSource: 'assumed' | 'reported';
  /** Per-block-class breakdown of the LIVE window. */
  breakdown: TokenBreakdown;
  messages: {
    total: number;
    onActiveBranch: number;
    /** Dead branches — edited/retried turns that are NOT in context. */
    offBranch: number;
    /** Messages superseded by a compaction summary (not in context). */
    compactedAway: number;
    /** Messages actually in the live window. */
    live: number;
  };
  compaction: {
    compacted: boolean;
    events: number;
    /** Tokens the surviving summary costs (it replaces what came before). */
    summaryTokens: number;
  };
  confidence: 'low' | 'medium' | 'high';
  /** Named context costs this estimate does NOT include. Honesty, not decoration. */
  unmeasured: string[];
  chars: { live: number; total: number };
}

interface RawMsg {
  uuid?: string;
  parent_message_uuid?: string;
  sender?: string;
  index?: number;
  content?: unknown;
  compaction_summary?: unknown;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Chars of a tool_result's model-visible content.
 * Measured shape is always `[{type:'text', text}]`, but a string body and image
 * blocks both occur in the wild (see chat-read.test.ts fixtures), so handle all
 * three. An image is an opaque `file_uuid` reference — no bytes reach the text
 * budget, so only the reference itself is counted.
 */
function toolResultChars(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const inner of content) {
      if (inner && typeof inner === 'object') {
        const b = inner as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') n += b.text.length;
        else n += safeJsonLen(b);
      } else if (typeof inner === 'string') n += inner.length;
    }
    return n;
  }
  return safeJsonLen(content);
}

function safeJsonLen(v: unknown): number {
  try {
    const s = JSON.stringify(v);
    return s ? s.length : 0;
  } catch {
    return String(v).length;
  }
}

/** Model-relevant chars per block class for ONE message. */
export function messageChars(msg: unknown): TokenBreakdown {
  const out: TokenBreakdown = { text: 0, thinking: 0, tool_use: 0, tool_result: 0 };
  const m = (msg || {}) as RawMsg;
  const content = m.content;
  // A message's content is normally a block array; a bare string occurs too.
  if (typeof content === 'string') {
    out.text += content.length;
    return out;
  }
  for (const raw of asArray(content)) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string') out.text += b.text.length;
        break;
      case 'thinking':
        // Measured: on a real conversation ALL 116 thinking blocks carried
        // `thinking_hidden: true` with an EMPTY `.thinking` — claude.ai does not
        // persist the reasoning text, only a one-line `summaries[].summary`.
        // Count what is actually stored; the hidden remainder is declared in
        // unmeasured[] rather than silently reported as zero.
        if (typeof b.thinking === 'string') out.thinking += b.thinking.length;
        for (const s of asArray(b.summaries)) {
          if (s && typeof s === 'object') {
            const sum = (s as Record<string, unknown>).summary;
            if (typeof sum === 'string') out.thinking += sum.length;
          }
        }
        break;
      case 'tool_use':
        if (b.input !== undefined) out.tool_use += safeJsonLen(b.input);
        // render_all_tools=true can inline the result on the tool_use block.
        if (typeof b.result === 'string') out.tool_result += b.result.length;
        break;
      case 'tool_result':
        out.tool_result += toolResultChars(b.content);
        break;
      default:
        break;
    }
  }
  return out;
}

function addInto(dst: TokenBreakdown, src: TokenBreakdown): void {
  dst.text += src.text;
  dst.thinking += src.thinking;
  dst.tool_use += src.tool_use;
  dst.tool_result += src.tool_result;
}

function sumChars(b: TokenBreakdown): number {
  return b.text + b.thinking + b.tool_use + b.tool_result;
}

function toTokens(b: TokenBreakdown): TokenBreakdown {
  return {
    text: Math.round(b.text / CHARS_PER_TOKEN.text),
    thinking: Math.round(b.thinking / CHARS_PER_TOKEN.thinking),
    tool_use: Math.round(b.tool_use / CHARS_PER_TOKEN.tool_use),
    tool_result: Math.round(b.tool_result / CHARS_PER_TOKEN.tool_result),
  };
}

function sumTokens(b: TokenBreakdown): number {
  return b.text + b.thinking + b.tool_use + b.tool_result;
}

/**
 * Messages on the active branch, root-first.
 *
 * Walks parent links back from `current_leaf_message_uuid`. Falls back to the
 * raw array (ordered by `index`) when the leaf is missing or the chain breaks —
 * a partial walk must never silently report a fraction of the conversation.
 * Cycle-guarded: a self-referencing parent would otherwise spin forever.
 */
export function activeBranch(body: unknown): RawMsg[] {
  const b = (body || {}) as Record<string, unknown>;
  const msgs = asArray(b.chat_messages) as RawMsg[];
  if (!msgs.length) return [];
  const byUuid = new Map<string, RawMsg>();
  for (const m of msgs) if (m && typeof m.uuid === 'string') byUuid.set(m.uuid, m);

  const leaf = typeof b.current_leaf_message_uuid === 'string' ? b.current_leaf_message_uuid : '';
  const chain: RawMsg[] = [];
  const seen = new Set<string>();
  let cur = leaf;
  while (cur && cur !== ROOT_PARENT_UUID && byUuid.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const m = byUuid.get(cur)!;
    chain.push(m);
    cur = typeof m.parent_message_uuid === 'string' ? m.parent_message_uuid : '';
  }
  if (!chain.length) {
    return [...msgs].sort((x, y) => (Number(x.index) || 0) - (Number(y.index) || 0));
  }
  chain.reverse();
  return chain;
}

/** Text of a compaction summary, if this message carries one. */
function compactionSummaryChars(m: RawMsg): number {
  const cs = m.compaction_summary;
  if (cs == null) return 0;
  if (typeof cs === 'string') return cs.length;
  let n = 0;
  for (const raw of asArray(cs)) {
    if (raw && typeof raw === 'object') {
      const b = raw as Record<string, unknown>;
      if (typeof b.text === 'string') n += b.text.length;
      else n += safeJsonLen(b);
    } else if (typeof raw === 'string') n += raw.length;
  }
  return n;
}

/**
 * Estimate a conversation's context usage.
 *
 * @param body raw conversation record (`readConversation(...).body`)
 * @param opts.ceilingTokens override the assumed ceiling
 */
export function estimateConversationTokens(
  body: unknown,
  opts: { ceilingTokens?: number } = {},
): ConversationTokenEstimate {
  const b = (body || {}) as Record<string, unknown>;
  const uuid = typeof b.uuid === 'string' ? b.uuid : '';
  const all = asArray(b.chat_messages) as RawMsg[];
  const chain = activeBranch(body);

  // Last compaction on the active branch wins: each one summarises everything
  // before it, so only the most recent survives in context.
  let lastCompactionIdx = -1;
  let compactionEvents = 0;
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].compaction_summary != null && compactionSummaryChars(chain[i]) > 0) {
      lastCompactionIdx = i;
      compactionEvents++;
    }
  }

  const totalBd: TokenBreakdown = { text: 0, thinking: 0, tool_use: 0, tool_result: 0 };
  for (const m of chain) addInto(totalBd, messageChars(m));

  // Live window: the surviving summary (counted as text) + every message after it.
  const liveBd: TokenBreakdown = { text: 0, thinking: 0, tool_use: 0, tool_result: 0 };
  let summaryChars = 0;
  if (lastCompactionIdx >= 0) {
    summaryChars = compactionSummaryChars(chain[lastCompactionIdx]);
    liveBd.text += summaryChars;
    for (let i = lastCompactionIdx + 1; i < chain.length; i++) addInto(liveBd, messageChars(chain[i]));
  } else {
    addInto(liveBd, totalBd);
  }

  const liveTok = toTokens(liveBd);
  const liveTokens = sumTokens(liveTok);
  const totalTokens = sumTokens(toTokens(totalBd));
  const ceilingTokens = opts.ceilingTokens && opts.ceilingTokens > 0 ? opts.ceilingTokens : DEFAULT_CEILING_TOKENS;

  const liveMsgCount = lastCompactionIdx >= 0 ? chain.length - lastCompactionIdx - 1 : chain.length;

  const unmeasured = [
    'claude.ai system prompt',
    'tool schemas advertised this turn (all connectors + built-ins)',
    'built-in tools (web search, artifacts, analysis tool)',
    'skills / project files / user memory injected per request',
    'attachments and image bytes (image tool_results are opaque file_uuid refs)',
    'hidden thinking text (stored with thinking_hidden=true and an empty body; only one-line summaries persist)',
  ];
  if (lastCompactionIdx >= 0) {
    unmeasured.push(
      'exact compaction semantics — the summary is assumed to fully replace prior turns',
    );
  }

  // Confidence is about the SHAPE of what we measured, not the arithmetic.
  // A compacted conversation depends on an assumption we cannot verify from the
  // record, so it can never be 'high'.
  const confidence: 'low' | 'medium' | 'high' = !chain.length
    ? 'low'
    : lastCompactionIdx >= 0
      ? 'medium'
      : 'high';

  return {
    conversationUuid: uuid,
    liveTokens,
    totalTokens,
    pctOfCeiling: Math.round((liveTokens / ceilingTokens) * 1000) / 10,
    ceilingTokens,
    ceilingSource: opts.ceilingTokens ? 'reported' : 'assumed',
    breakdown: liveTok,
    messages: {
      total: all.length,
      onActiveBranch: chain.length,
      offBranch: Math.max(0, all.length - chain.length),
      compactedAway: lastCompactionIdx >= 0 ? lastCompactionIdx + 1 : 0,
      live: liveMsgCount,
    },
    compaction: {
      compacted: lastCompactionIdx >= 0,
      events: compactionEvents,
      summaryTokens: Math.round(summaryChars / CHARS_PER_TOKEN.text),
    },
    confidence,
    unmeasured,
    chars: { live: sumChars(liveBd), total: sumChars(totalBd) },
  };
}

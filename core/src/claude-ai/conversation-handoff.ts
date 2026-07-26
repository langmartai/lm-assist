/**
 * Build a structured handoff from a claude.ai conversation — POINTERS, not prose.
 *
 * ── Why pointers ───────────────────────────────────────────────────────────
 * The feature this module implements was itself scoped inside an ALREADY-COMPACTED
 * conversation. That compaction preserved the narrative and dropped the
 * provenance, and the assistant then re-derived the local/bridged/cloud CCR
 * taxonomy from inference instead of re-reading `guide("ccr")` — and got it
 * wrong, needing two human corrections. The mission plan's own §0 is a second
 * instance of the same failure: a conclusion ("no node holds a cookie") carried
 * forward without the verification that would have refuted it.
 *
 * A handoff carrying POINTERS would have prevented both. A handoff carrying
 * PROSE caused them. So this builder deliberately emits:
 *
 *   • verbatim human turns — corrections especially, since a summary damages
 *     those first and they are the cheapest thing in the transcript to keep;
 *   • ids (missions, backlog, sessions, executions, nodes) as re-readable
 *     handles, each with the command that re-reads it;
 *   • the NAMES of the tools/playbooks the work depended on, so the successor
 *     re-reads the authority instead of reconstructing it;
 *   • an explicit provenance banner telling the successor to re-read.
 *
 * It deliberately does NOT emit tool_result bodies. Re-importing those would
 * recreate the very context pressure the fork exists to relieve — the source's
 * tool results were 77% of a 2 MB record when measured.
 */

/** Handles that point back into durable fleet state, by kind. */
export interface HandoffPointers {
  missions: string[];
  backlog: string[];
  sessions: string[];
  executions: string[];
  nodes: string[];
  knowledge: string[];
  conversations: string[];
  files: string[];
}

export interface HandoffInput {
  /** raw conversation record (readConversation(...).body) */
  body: unknown;
  /** caller-supplied additions/overrides */
  overrides?: {
    title?: string;
    /** free-text goal for the new conversation — the ONE place prose is wanted */
    objective?: string;
    /** extra pointers the caller knows about */
    extraPointers?: string[];
    /** cap on verbatim human turns carried over (default 12) */
    maxHumanTurns?: number;
  };
}

export interface BuiltHandoff {
  title: string;
  /** the seed message text for the new conversation */
  seed: string;
  pointers: HandoffPointers;
  humanTurns: number;
  /** approximate chars of the seed — the fork's cost to the NEW conversation */
  seedChars: number;
}

const MAX_TURN_CHARS = 1200;
const DEFAULT_MAX_HUMAN_TURNS = 12;

/**
 * Id shapes used across the fleet. Anchored to their prefixes so a random hex
 * blob in a tool result cannot masquerade as a handle.
 */
const ID_PATTERNS: Array<{ key: keyof HandoffPointers; re: RegExp }> = [
  { key: 'missions', re: /\bmission_[0-9a-f]{6,}\b/gi },
  { key: 'backlog', re: /\bbl_[0-9a-f]{6,}\b/gi },
  { key: 'executions', re: /\bexec_[0-9a-zA-Z]{6,}\b/gi },
  { key: 'nodes', re: /\bgw4-[0-9a-f-]{8,}\b/gi },
  // Real CCR ids are `session_01…`/`cse_01…` (ULID-ish, always digit-led). The
  // looser `\w{10,}` form matched the TOOL NAME `session_footprints` and offered
  // it as a session to re-read — a pointer that leads nowhere is worse than no
  // pointer, because the successor spends a turn chasing it.
  { key: 'sessions', re: /\b(?:cse|session)_0[0-9A-Za-z]{10,}\b/g },
  { key: 'knowledge', re: /\bK\d{3,}\b/g },
];

/** A bare uuid — a conversation, a session, an org. Deliberately unclassified:
 *  guessing which kind it is produces confidently-wrong pointers. */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** `gw4-<uuid>` — a NODE id, whose uuid half must not be re-offered as a
 *  conversation uuid. Stripped before the bare-uuid scan. */
const NODE_ID_RE = /\bgw4-[0-9a-f-]{8,}\b/gi;
/** Absolute-ish repo/doc paths worth re-reading (memory files, case docs, specs). */
const FILE_RE = /\b(?:[\w.-]+\/)*(?:case\.[\w.-]+|[\w-]+)\.(?:md|ts|tsx|json)\b/g;

function uniqCap(arr: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Collect the model-visible text of a message for id scanning (NOT for output). */
function scanText(msg: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = msg.content;
  if (typeof content === 'string') return content;
  for (const raw of asArray(content)) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'tool_use') {
      if (typeof b.name === 'string') parts.push(b.name);
      try { parts.push(JSON.stringify(b.input ?? '')); } catch { /* ignore */ }
    } else if (b.type === 'tool_result') {
      const c = b.content;
      if (typeof c === 'string') parts.push(c);
      else for (const inner of asArray(c)) {
        if (inner && typeof inner === 'object') {
          const t = (inner as Record<string, unknown>).text;
          if (typeof t === 'string') parts.push(t);
        }
      }
    }
  }
  return parts.join('\n');
}

/** Tool names invoked, most-used first — the authorities the work leaned on. */
export function toolsUsed(messages: Array<Record<string, unknown>>, cap = 12): string[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    for (const raw of asArray(m.content)) {
      if (!raw || typeof raw !== 'object') continue;
      const b = raw as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        // strip the connector prefix ("lm-assist langmart:foo" -> "foo")
        const n = b.name.includes(':') ? b.name.slice(b.name.lastIndexOf(':') + 1) : b.name;
        counts.set(n, (counts.get(n) || 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([n]) => n);
}

export function extractPointers(messages: Array<Record<string, unknown>>): HandoffPointers {
  const acc: HandoffPointers = {
    missions: [], backlog: [], sessions: [], executions: [],
    nodes: [], knowledge: [], conversations: [], files: [],
  };
  const uuids: string[] = [];
  for (const m of messages) {
    const text = scanText(m);
    if (!text) continue;
    for (const { key, re } of ID_PATTERNS) {
      const found = text.match(re);
      if (found) acc[key].push(...found);
    }
    const f = text.match(FILE_RE);
    if (f) acc.files.push(...f);
    // Remove node ids first: `gw4-332c6620-92db-…` contains a full uuid, which
    // would otherwise be re-offered as a conversation to read.
    const u = text.replace(NODE_ID_RE, ' ').match(UUID_RE);
    if (u) uuids.push(...u);
  }
  acc.conversations = uniqCap(uuids, 8);
  acc.missions = uniqCap(acc.missions, 12);
  acc.backlog = uniqCap(acc.backlog, 12);
  acc.sessions = uniqCap(acc.sessions, 10);
  acc.executions = uniqCap(acc.executions, 10);
  acc.nodes = uniqCap(acc.nodes, 6);
  acc.knowledge = uniqCap(acc.knowledge, 10);
  acc.files = uniqCap(acc.files, 15);
  return acc;
}

/** Verbatim human turns, newest-last, each capped. These survive compaction badly
 *  and are the highest-value, lowest-cost thing to carry forward. */
export function humanTurns(
  messages: Array<Record<string, unknown>>,
  max = DEFAULT_MAX_HUMAN_TURNS,
): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const sender = m.sender;
    if (sender !== 'human' && sender !== 'user') continue;
    const parts: string[] = [];
    const content = m.content;
    if (typeof content === 'string') parts.push(content);
    else for (const raw of asArray(content)) {
      if (raw && typeof raw === 'object') {
        const b = raw as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    const t = parts.join('\n').trim();
    if (!t) continue;
    out.push(t.length > MAX_TURN_CHARS ? `${t.slice(0, MAX_TURN_CHARS)} …[+${t.length - MAX_TURN_CHARS} chars]` : t);
  }
  // keep the most RECENT turns — the live thread of intent
  return out.slice(-max);
}

function renderPointerSection(p: HandoffPointers, extra: string[]): string[] {
  const rows: Array<[string, string[], string]> = [
    ['missions', p.missions, 'mission_list({id})'],
    ['backlog', p.backlog, 'backlog_get({id})'],
    ['sessions', p.sessions, 'ccr_remote_list / mission_session_read'],
    ['executions', p.executions, 'get_execution({id})'],
    ['nodes', p.nodes, 'list_nodes / node_status({node})'],
    ['knowledge', p.knowledge, 'detail({id})'],
    ['uuids seen (unclassified — conversation / session / org)', p.conversations, 'read_conversation({conversation_uuid}) if it is a chat'],
    ['files / docs', p.files, 'fs_read / memory_file'],
  ];
  const lines: string[] = [];
  for (const [label, ids, how] of rows) {
    if (!ids.length) continue;
    lines.push(`- **${label}** — re-read with \`${how}\``);
    lines.push(`  ${ids.join(', ')}`);
  }
  for (const e of extra) lines.push(`- ${e}`);
  return lines;
}

export function buildHandoff(input: HandoffInput): BuiltHandoff {
  const body = (input.body || {}) as Record<string, unknown>;
  const ov = input.overrides || {};
  const messages = asArray(body.chat_messages) as Array<Record<string, unknown>>;
  const sourceUuid = typeof body.uuid === 'string' ? body.uuid : '';
  const sourceName = typeof body.name === 'string' && body.name ? body.name : '(untitled)';

  const pointers = extractPointers(messages);
  const turns = humanTurns(messages, ov.maxHumanTurns ?? DEFAULT_MAX_HUMAN_TURNS);
  const tools = toolsUsed(messages);

  // The most recent compaction summary is the source's own best statement of
  // what came before — carry it as ORIENTATION, explicitly flagged as a summary.
  let priorSummary = '';
  for (const m of messages) {
    const cs = m.compaction_summary;
    if (cs == null) continue;
    const parts: string[] = [];
    for (const raw of asArray(cs)) {
      if (raw && typeof raw === 'object') {
        const t = (raw as Record<string, unknown>).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    if (parts.length) priorSummary = parts.join('\n');
  }

  const title = ov.title || `Continued: ${sourceName}`.slice(0, 200);

  const L: string[] = [];
  L.push(`# Handoff — continuation of "${sourceName}"`);
  L.push('');
  L.push(`Source conversation: \`${sourceUuid}\``);
  if (sourceUuid) L.push(`Source URL: https://claude.ai/chat/${sourceUuid}`);
  L.push('');
  L.push('> **How to use this handoff.** Everything below is a POINTER or a VERBATIM');
  L.push('> quote. It is deliberately NOT a summary of findings. Before acting on any');
  L.push('> topic here, RE-READ the pointer — do not reconstruct the answer by');
  L.push('> inference. This handoff exists because a previous compaction preserved a');
  L.push('> narrative but dropped its provenance, and the successor then re-derived a');
  L.push('> playbook it should have re-read, getting it wrong twice.');
  L.push('');

  if (ov.objective) {
    L.push('## Objective for this continuation');
    L.push('');
    L.push(ov.objective);
    L.push('');
  }

  const ptrLines = renderPointerSection(pointers, ov.extraPointers || []);
  if (ptrLines.length) {
    L.push('## Pointers into durable state — re-read these, do not trust a retelling');
    L.push('');
    L.push(...ptrLines);
    L.push('');
  }

  if (turns.length) {
    L.push('## Human instructions, verbatim');
    L.push('');
    L.push('These are quoted exactly. Corrections and constraints are what a summary');
    L.push('damages first, so they are carried literally rather than paraphrased.');
    L.push('');
    turns.forEach((t, i) => {
      L.push(`${i + 1}. ${JSON.stringify(t)}`);
    });
    L.push('');
  }

  if (tools.length) {
    L.push('## Tools/playbooks this work depended on');
    L.push('');
    L.push(`Re-read the authority rather than recalling it: ${tools.map((t) => `\`${t}\``).join(', ')}`);
    L.push('');
  }

  if (priorSummary) {
    L.push('## Prior-context summary (from the source conversation\'s own compaction)');
    L.push('');
    L.push('⚠️ This is a SUMMARY — provenance-lossy by construction. Treat every claim');
    L.push('in it as *inferred* until re-verified through a pointer above.');
    L.push('');
    L.push(priorSummary.length > 6000 ? `${priorSummary.slice(0, 6000)}\n…[truncated]` : priorSummary);
    L.push('');
  }

  L.push('## Provenance markers');
  L.push('');
  L.push('- **verified** — carried as a pointer above; re-read it to confirm.');
  L.push('- **inferred** — anything in the prior-context summary section.');
  L.push('- Tool RESULTS from the source are deliberately NOT copied here: they were');
  L.push('  the bulk of the source\'s context, and re-importing them would recreate the');
  L.push('  pressure this fork exists to relieve.');

  const seed = L.join('\n');
  return { title, seed, pointers, humanTurns: turns.length, seedChars: seed.length };
}

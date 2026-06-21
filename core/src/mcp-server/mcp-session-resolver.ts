// core/src/mcp-server/mcp-session-resolver.ts
// Identify WHICH conversation/session is driving this MCP call and hand the id back so the
// conversation becomes aware of itself + we can track per-session state ("has it bootstrapped").
//
// TWO mechanisms, best-first:
//
//  1. PRECISE (deterministic) — the connector DOES carry a unique id per call:
//     `_meta["claudecode/toolUseId"]` is the calling conversation's `tool_use` block id (a
//     `toolu_…`). Verified live: the worker received `toolu_013FqFduTAdYYUhMwmVvaGFG` and that
//     exact id was the `tool_use` id in the caller's session JSONL. mcp.routes.ts lifts it into
//     the per-request McpCallContext; here we match it against the parsed tool_use ids of the
//     cached Claude Code sessions → the ONE session that owns this call. No guessing.
//
//  2. RECENCY (heuristic fallback) — when no tool-call id is present (older client, or a
//     claude.ai web caller whose client doesn't tag `claudecode/toolUseId`), the request alone
//     can't name the caller: a claude.ai conversation and a Claude Code session using the
//     connector are BOTH `cloud` principals with identical headers. So we resolve BOTH
//     candidates by recency from the node's own APIs — the most-recently-active claude.ai
//     conversation AND the most-recently-modified Claude Code session — and the LLM, which knows
//     its OWN runtime, picks the matching one.
//
// Bounded everywhere: resolved only for bootstrap/session_status, cached, timeout-guarded, graceful.
import type { McpToolResult } from './configure';
import { listConversations } from '../utils/claudeai-session';
import { getSessionCache } from '../session-cache';
import { currentMcpContext } from './principal-context';
import type { WorkerRecord } from '../worker-role/types';
import { liveness } from '../worker-role/model';
import { getRecord } from '../worker-role/worker-store';

export interface Candidate { id: string; label?: string; updatedAt?: string }
export interface CallerCandidates { claudeAi?: Candidate; claudeCode?: Candidate; precise?: boolean; resolvedAt: number }

interface SessionState { firstSeen: number; lastSeen: number; bootstrappedAt?: number }
const REGISTRY = new Map<string, SessionState>();           // keyed by candidate id
const RESOLVE_TTL_MS = 8000;
const RESOLVE_TIMEOUT_MS = 2500;
let cache: { at: number; value: CallerCandidates } | null = null;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error('resolve timeout')), ms); timer.unref?.(); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// ── precise match: tool-call id → exact session ────────────────────────────

type SessionRow = { sessionId?: string; filePath?: string; cacheData?: { cwd?: string; fileMtime?: number; toolUses?: Array<{ id?: string }> } };

function candidateFromRow(s: SessionRow): Candidate {
  return {
    id: String(s.sessionId),
    label: s.cacheData?.cwd,
    updatedAt: s.cacheData?.fileMtime ? new Date(s.cacheData.fileMtime).toISOString() : undefined,
  };
}

/** Pure: find the session whose parsed tool_use ids include `toolUseId`. Exported for tests. */
export function matchSessionByToolUseId(sessions: SessionRow[], toolUseId: string): Candidate | null {
  if (!toolUseId) return null;
  for (const s of sessions) {
    const tus = s?.cacheData?.toolUses;
    if (s?.sessionId && Array.isArray(tus) && tus.some((t) => t?.id === toolUseId)) return candidateFromRow(s);
  }
  return null;
}

/** Read only the last `tailBytes` of a file and test for a (unique) needle — the just-written
 *  tool_use lives in the final lines, so this stays cheap even on large session logs. */
function fileTailIncludes(filePath: string, needle: string, tailBytes = 256 * 1024): boolean {
  const fs = require('fs') as typeof import('fs');
  let fd: number | null = null;
  try {
    const st = fs.statSync(filePath);
    const start = Math.max(0, st.size - tailBytes);
    const len = st.size - start;
    if (len <= 0) return false;
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.includes(needle);
  } catch { return false; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* */ } } }
}

/** Resolve the EXACT Claude Code session that owns `toolUseId`, or null. In-memory first
 *  (the file-watched cache has already parsed the tool_use blocks); a bounded file-tail scan
 *  of the most-recent sessions covers the brief window where the cache lags the just-written line. */
function findPreciseClaudeCodeSession(toolUseId: string): Candidate | null {
  let sessions: SessionRow[] = [];
  try { sessions = getSessionCache().getAllSessionsFromCache() as unknown as SessionRow[]; } catch { return null; }
  const inMem = matchSessionByToolUseId(sessions, toolUseId);
  if (inMem) return inMem;
  const recent = [...sessions]
    .sort((a, b) => (b.cacheData?.fileMtime || 0) - (a.cacheData?.fileMtime || 0))
    .slice(0, 25);
  for (const s of recent) {
    if (s.sessionId && s.filePath && fileTailIncludes(s.filePath, toolUseId)) return candidateFromRow(s);
  }
  return null;
}

// ── recency fallback (cached) ──────────────────────────────────────────────

/** Resolve BOTH the most-recent claude.ai conversation and Claude Code session by recency. */
async function resolveRecencyCandidates(): Promise<CallerCandidates> {
  const now = Date.now();
  if (cache && now - cache.at < RESOLVE_TTL_MS) return cache.value;
  const out: CallerCandidates = { resolvedAt: now };
  // claude.ai (network; the node's real cookie) — most-recently-updated conversation.
  try {
    const resp: any = await withTimeout(listConversations({ limit: 5, consistency: 'eventual' }), RESOLVE_TIMEOUT_MS);
    const arr: any[] = Array.isArray(resp) ? resp : (resp?.conversations ?? resp?.data ?? []);
    const top = arr.filter((c) => c && c.uuid).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];
    if (top) out.claudeAi = { id: String(top.uuid), label: top.name || '(untitled)', updatedAt: top.updated_at };
  } catch { /* claude.ai not configured / timeout → omit */ }
  // Claude Code (in-memory session cache) — most-recently-modified session.
  try {
    const all = getSessionCache().getAllSessionsFromCache();
    const top = all.filter((s: any) => s?.sessionId).sort((a: any, b: any) => (b.cacheData?.fileMtime || 0) - (a.cacheData?.fileMtime || 0))[0];
    if (top) out.claudeCode = candidateFromRow(top as SessionRow);
  } catch { /* no sessions → omit */ }
  cache = { at: now, value: out };
  return out;
}

/** Resolve the caller: precise tool-call-id match when available (overrides the CC candidate and
 *  marks `precise`), else the recency candidates. The expensive recency part is cached; the
 *  per-call precise match is cheap (in-memory) so it runs every call. */
export async function resolveCallerCandidates(): Promise<CallerCandidates> {
  const base = await resolveRecencyCandidates();
  const toolUseId = currentMcpContext()?.toolUseId;
  if (!toolUseId) return base;
  const precise = findPreciseClaudeCodeSession(toolUseId);
  if (!precise) return base;
  return { ...base, claudeCode: precise, precise: true };
}

// ── presentation ───────────────────────────────────────────────────────────

/** Render the identity line(s): one DEFINITIVE line when the tool-call id pinned the caller,
 *  else the two-candidate "pick the one matching your runtime" framing. Exported for tests. */
export function describeCandidates(c: CallerCandidates): string {
  if (c.precise && c.claudeCode) {
    return `• You ARE Claude Code session ${c.claudeCode.id}${c.claudeCode.label ? ` (cwd ${c.claudeCode.label})` : ''} — CONFIRMED by matching this MCP call's tool-call id to its conversation. This is the exact caller, not a guess.`;
  }
  const lines: string[] = [];
  if (c.claudeAi) lines.push(`• If you are a claude.ai CONVERSATION → "${c.claudeAi.label}" (${c.claudeAi.id})${c.claudeAi.updatedAt ? `, updated ${c.claudeAi.updatedAt}` : ''}`);
  if (c.claudeCode) lines.push(`• If you are a Claude Code SESSION → ${c.claudeCode.id}${c.claudeCode.label ? ` (cwd ${c.claudeCode.label})` : ''}${c.claudeCode.updatedAt ? `, updated ${c.claudeCode.updatedAt}` : ''}`);
  if (!lines.length) return '(could not resolve — claude.ai not configured on this node and no recent Claude Code session).';
  return lines.join('\n');
}

/** Pure: the ROLE section appended to the identity block. Exported for tests. */
export function renderRoleSection(rec: WorkerRecord | null, now: number): string {
  if (!rec || rec.role !== 'worker') {
    return '[lm-assist — role]\nThis session has no worker role. If you are meant to be a worker, call set_role({sessionId, task:{title}}).\n\n';
  }
  const live = liveness(rec.orchestrator, now);
  const tasks = rec.tasks.map((t) => `  - ${t.id} "${t.title}" [${t.status}]${t.gate?.state === 'open' ? ' (GATE OPEN: ' + t.gate.reason + ')' : ''}`).join('\n') || '  (none yet)';
  return [
    '[lm-assist — You are a WORKER]',
    `Tasks (worker-owned):\n${tasks}`,
    `Orchestrator: ${rec.orchestrator.id ?? 'none'} (${live}).`,
    'CONTRACT: every turn, print a ⟦WORKER-STATUS⟧ … ⟦/WORKER-STATUS⟧ block (Way 1 — always). If an orchestrator is active you MAY also report_status (Way 3) and message it (Way 2). Before any gated step, report_status(status:"need_approval", reason) and STOP until the gate is agreed.',
    '',
    '',
  ].join('\n');
}

/** The full identity block prefixed onto a bootstrap result. Pure; exported for tests. */
export function identityHeader(c: CallerCandidates): string {
  const callerId = (c.precise ? c.claudeCode?.id : undefined) ?? c.claudeAi?.id ?? c.claudeCode?.id;
  const roleSection = renderRoleSection(callerId ? getRecord(callerId) : null, Date.now());
  const body = describeCandidates(c);
  if (c.precise && c.claudeCode) {
    return `[lm-assist — your session identity]\nThis MCP call carries a tool-call id that pins the caller exactly:\n${body}\nThis session is now recorded as BOOTSTRAPPED.\n\n` + roleSection;
  }
  return `[lm-assist — your session identity]\nThe connector does not pass your exact id, so here are the most-recently-active candidates — pick the one matching where you are running (you know your own runtime):\n${body}\nThis session is now recorded as BOOTSTRAPPED.\n\n` + roleSection;
}

function bootstrapState(c: CallerCandidates): { id?: string } {
  // Mark whichever candidate(s) exist as bootstrapped; report the precise/claude.ai id preferentially.
  for (const cand of [c.claudeAi, c.claudeCode]) if (cand) {
    const st = REGISTRY.get(cand.id) ?? { firstSeen: Date.now(), lastSeen: Date.now() };
    st.lastSeen = Date.now(); st.bootstrappedAt = Date.now(); REGISTRY.set(cand.id, st);
  }
  return { id: (c.precise ? c.claudeCode?.id : undefined) ?? c.claudeAi?.id ?? c.claudeCode?.id };
}

function prefixText(result: McpToolResult, note: string): McpToolResult {
  const content = Array.isArray(result.content) ? [...result.content] : [];
  const i = content.findIndex((x: any) => x?.type === 'text');
  if (i >= 0) content[i] = { ...content[i], text: note + (content[i] as any).text } as any;
  else content.unshift({ type: 'text', text: note } as any);
  return { ...result, content } as McpToolResult;
}

/** Enrich a bootstrap result: give the conversation its candidate id(s) back + record bootstrapped. */
export async function enrichBootstrapWithIdentity(result: McpToolResult): Promise<McpToolResult> {
  try {
    const c = await resolveCallerCandidates();
    bootstrapState(c);
    return prefixText(result, identityHeader(c));
  } catch { return result; }
}

function pretty(v: unknown): string { return JSON.stringify(v, null, 2); }

async function handleSessionStatus(_args: Record<string, unknown>): Promise<McpToolResult> {
  const c = await resolveCallerCandidates();
  const bootstrapped = (id?: string) => (id ? !!REGISTRY.get(id)?.bootstrappedAt : false);
  return { content: [{ type: 'text', text: pretty(c.precise && c.claudeCode ? {
    note: 'PRECISE: this MCP call carried a tool-call id (_meta["claudecode/toolUseId"]) that matched the calling conversation exactly — no guessing.',
    callerType: 'claude-code',
    claudeCodeSession: { ...c.claudeCode, matchedBy: 'tool-call-id', bootstrapped: bootstrapped(c.claudeCode.id) },
    howTo: 'If you have not bootstrapped, call bootstrap() once to load all lm-assist capabilities.',
  } : {
    note: 'No tool-call id on this call. These are the most-recently-active candidates resolved from the node APIs — PICK the one matching your runtime (claude.ai conversation vs Claude Code session). Heuristic by recency.',
    claudeAiConversation: c.claudeAi ? { ...c.claudeAi, bootstrapped: bootstrapped(c.claudeAi.id) } : 'unavailable (claude.ai not configured on this node)',
    claudeCodeSession: c.claudeCode ? { ...c.claudeCode, bootstrapped: bootstrapped(c.claudeCode.id) } : 'none recent',
    howTo: 'If you have not bootstrapped, call bootstrap() once to load all lm-assist capabilities.',
  }) }] };
}

export const SESSION_STATUS_TOOL_DEFS = [
  {
    name: 'session_status',
    description:
      'Report WHICH conversation/session is driving this MCP call (so a conversation can learn its own id) and whether it has bootstrapped. When the call carries a tool-call id (Claude Code clients tag it), lm-assist pins the EXACT caller session. Otherwise it returns the most-recently-active candidates from the node APIs — the claude.ai conversation AND the Claude Code session — and YOU pick the one matching your runtime. Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
] as const;

export const SESSION_STATUS_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  session_status: handleSessionStatus,
};

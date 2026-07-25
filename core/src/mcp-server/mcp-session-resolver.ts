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
// Bounded everywhere: cached, deadline-guarded, graceful — and it MUST stay that way, because
// this is NOT the rare read-path cost the header used to claim ("resolved only for
// bootstrap/session_status"). The backlog/mission write paths call it on EVERY write via
// `_actor`, so anything expensive added here is paid by every connector MCP tool call, on the
// hot path, in front of the relay's fixed 25s local / 30s gateway cutoffs. Keep the hot path
// free of: full store sweeps, unbounded network calls, and timer-only deadlines.
import type { McpToolResult } from './configure';
import { fleetIdentity } from './fleet-identity';
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
/** Beyond this, a stale identity stops being "best-effort" and we block for a fresh one.
 *  Between TTL and here, callers are served stale while a refresh runs behind them. */
const RESOLVE_MAX_STALE_MS = 60_000;
/** How long ONE listing of the recent sessions is reused — see walkRecentSessions(). */
const SESSIONS_TTL_MS = 3000;
let cache: { at: number; value: CallerCandidates } | null = null;

/** Bound `deps.conversations()` with a deadline the runtime CANNOT starve.
 *
 *  The previous bound was `Promise.race` against a `setTimeout`, and it did not hold: a
 *  2.5s bound let an 8229ms call through on prod. A timer only fires when the event loop
 *  gets a turn, and this resolver used to share the loop with a synchronous multi-second
 *  store sweep (removed — see walkRecentSessions). Measured here: a 2500ms timer did not
 *  fire AT ALL during a 6s synchronous block. `Promise.race` also never cancelled the
 *  underlying request, so a "timed-out" fetch kept running. Two mechanisms replace it,
 *  neither of which depends on a timer being punctual:
 *    - an AbortController actually cancels the fetch, and
 *    - the WALL CLOCK is re-checked after the await, so a late timer cannot smuggle a
 *      long result back in. */
async function loadConversationsBounded(deps: RecencyDeps): Promise<unknown> {
  const ctrl = new AbortController();
  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const resp = await deps.conversations(ctrl.signal);
    if (Date.now() > deadline) { ctrl.abort(); throw new Error('resolve deadline exceeded'); }
    return resp;
  } finally { clearTimeout(timer); }
}

/** How many recent sessions the resolver considers. The caller's own session is being
 *  written AS the call arrives, so it is the most-recently-modified one — a small window
 *  is all this can ever need. */
const RECENT_SESSIONS = 25;

/** ONE listing of the recent sessions, reused for SESSIONS_TTL_MS by BOTH the recency
 *  resolution and the per-call precise match. */
let sessionsMemo: { at: number; rows: SessionRow[] } | null = null;
function sessionRows(deps: RecencyDeps): SessionRow[] {
  const now = Date.now();
  if (sessionsMemo && now - sessionsMemo.at < SESSIONS_TTL_MS) return sessionsMemo.rows;
  const rows = (deps.sessions() ?? []) as SessionRow[];
  sessionsMemo = { at: now, rows };
  return rows;
}

/** The N most-recently-modified session files, by a plain directory walk.
 *
 *  This replaces getAllSessionsFromCache() on this path. That call iterates lmdb
 *  `getRange()` in a SYNCHRONOUS generator and msgpack-decodes EVERY cached session, so it
 *  is neither cheap nor interruptible — measured on prod 117: 1663-1977ms per call, against
 *  6-8ms for the file-tail scan it exists to accelerate. It ran on EVERY call carrying a
 *  tool-call id, which is why a warm cache did not help that shape at all (4 concurrent warm
 *  calls: 9359ms server-side WITH a tool-call id versus 9ms without one).
 *
 *  Walking the tree and stat-ing instead measures 37-53ms for the same 6,610 files, needs no
 *  decode, and is never stale. The values it drops are recovered by an O(1) point get for the
 *  ONE session actually chosen (see enrichRow) — never for all of them. */
function walkRecentSessions(limit = RECENT_SESSIONS): SessionRow[] {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const os = require('os') as typeof import('os');
  const root = path.join(os.homedir(), '.claude', 'projects');
  const rows: SessionRow[] = [];
  let projects: string[] = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return rows; }
  for (const proj of projects) {
    const dir = path.join(root, proj);
    let entries: import('fs').Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      // Only top-level project session files: subagent sessions live in nested dirs and
      // are excluded from this candidate set, exactly as getAllSessionsFromCache() does.
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const sessionId = e.name.slice(0, -'.jsonl'.length);
      if (sessionId.startsWith('agent-')) continue;
      const filePath = path.join(dir, e.name);
      try { rows.push({ sessionId, filePath, cacheData: { fileMtime: fs.statSync(filePath).mtimeMs } }); } catch { /* vanished */ }
    }
  }
  rows.sort((a, b) => (b.cacheData?.fileMtime || 0) - (a.cacheData?.fileMtime || 0));
  return rows.slice(0, limit);
}

/** Fill in the fields the cheap walk cannot know (the `cwd` label) for ONE row, via an O(1)
 *  point get. Never sweeps; a cache miss just leaves the row unlabelled.
 *
 *  Only `liveDeps` wires this. Injected deps deliberately get NO enrichment, because
 *  getSessionCache() constructs the cache AND starts its chokidar watcher — an open handle
 *  that keeps a test process alive forever (the hang class scripts/run-tests.js exists for). */
function liveEnrichRow(row: SessionRow): SessionRow {
  try {
    const data = getSessionCache().getSessionDataFromMemory(row.filePath!) as { cwd?: string } | null;
    if (data?.cwd) return { ...row, cacheData: { ...row.cacheData, cwd: data.cwd } };
  } catch { /* cache unavailable — the label is cosmetic */ }
  return row;
}

function enrichRow(row: SessionRow, deps: RecencyDeps): SessionRow {
  return deps.enrich ? deps.enrich(row) : row;
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

/** Resolve the EXACT Claude Code session that owns `toolUseId`, or null.
 *
 *  In-memory first when the rows carry parsed tool_use blocks, then a bounded file-tail scan
 *  of the most-recent sessions. The tail scan is the reliable half AND the cheap half (6-8ms):
 *  the caller's tool_use was written moments ago, so it is in the newest file and in its final
 *  bytes — which is precisely the window where the parsed cache still LAGS. */
function findPreciseClaudeCodeSession(toolUseId: string, deps: RecencyDeps): Candidate | null {
  let sessions: SessionRow[] = [];
  try { sessions = sessionRows(deps); } catch { return null; }
  const inMem = matchSessionByToolUseId(sessions, toolUseId);
  if (inMem) return inMem;
  const recent = [...sessions]
    .sort((a, b) => (b.cacheData?.fileMtime || 0) - (a.cacheData?.fileMtime || 0))
    .slice(0, RECENT_SESSIONS);
  for (const s of recent) {
    if (s.sessionId && s.filePath && fileTailIncludes(s.filePath, toolUseId)) return candidateFromRow(enrichRow(s, deps));
  }
  return null;
}

// ── recency fallback (cached) ──────────────────────────────────────────────

/** The two expensive loaders, injectable so the concurrency behaviour is testable. */
export interface RecencyDeps {
  conversations: (signal?: AbortSignal) => Promise<unknown>;
  sessions: () => unknown[];
  /** Optional O(1) per-row lookup for fields the cheap listing cannot know. Wired only by
   *  liveDeps — see liveEnrichRow for why injected deps must not get it. */
  enrich?: (row: { sessionId?: string; filePath?: string; cacheData?: Record<string, unknown> }) => any;
}
const liveDeps: RecencyDeps = {
  conversations: (signal) =>
    listConversations({ limit: 5, consistency: 'eventual', signal, timeoutMs: RESOLVE_TIMEOUT_MS }) as Promise<unknown>,
  sessions: () => walkRecentSessions() as unknown[],
  enrich: liveEnrichRow,
};

/** The resolution currently running, shared by every caller that arrives while it is in
 *  flight. WITHOUT this the 8s cache is useless under concurrency: it is written only
 *  AFTER the network call returns, so N simultaneous callers all miss it, all call
 *  claude.ai, and all queue on a single-threaded Core — measured on prod 117 as
 *  server_ms p50 8804ms / max 14867ms at just 4 concurrent, versus 8ms with no identity
 *  resolution at all. That latency is what walks a write toward the relay's fixed 25s
 *  local / 30s gateway cutoffs, and a write that COMMITS and then blows the cutoff is
 *  precisely the lost ack (write applied, caller sees a failure, caller retries).
 *
 *  This resolver was designed for bootstrap/session_status (see the file header — "resolved
 *  only for bootstrap/session_status"); the backlog/mission write paths later put it on
 *  EVERY write, which is how a rare read-path cost became a hot write-path cost. */
let inFlight: Promise<CallerCandidates> | null = null;

/** Tests only: drop the cache, the session snapshot and any in-flight resolution. */
export function __resetRecencyCacheForTest(): void {
  cache = null;
  inFlight = null;
  sessionsMemo = null;
}

/** Tests only: age the cached entry so the TTL / stale-while-revalidate boundaries can be
 *  exercised without sleeping through them. */
export function __ageCacheForTest(ms: number): void {
  if (cache) cache.at -= ms;
  if (sessionsMemo) sessionsMemo.at -= ms;
}

/** Tests only: how old the cached entry already is. A freshly-written entry must be ~0ms
 *  old however long the resolution took — stamping it with the START time is what made a
 *  slow resolution write an already-expired cache. */
export function __cacheAgeForTest(): number | null {
  return cache ? Date.now() - cache.at : null;
}

/** Start (or join) the one shared resolution. Never throws: a degraded result is still an
 *  answer, and callers of this resolver only ever want a best-effort identity. */
function refresh(deps: RecencyDeps): Promise<CallerCandidates> {
  if (inFlight) return inFlight;
  const run = (async (): Promise<CallerCandidates> => {
    const out: CallerCandidates = { resolvedAt: Date.now() };
    // claude.ai (network; the node's real cookie) — most-recently-updated conversation.
    try {
      const resp: any = await loadConversationsBounded(deps);
      const arr: any[] = Array.isArray(resp) ? resp : (resp?.conversations ?? resp?.data ?? []);
      const top = arr.filter((c) => c && c.uuid).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];
      if (top) out.claudeAi = { id: String(top.uuid), label: top.name || '(untitled)', updatedAt: top.updated_at };
    } catch { /* claude.ai not configured / deadline → omit */ }
    // Claude Code (session store snapshot) — most-recently-modified session.
    try {
      const all = sessionRows(deps) as any[];
      const top = all.filter((s: any) => s?.sessionId).sort((a: any, b: any) => (b.cacheData?.fileMtime || 0) - (a.cacheData?.fileMtime || 0))[0];
      if (top) out.claudeCode = candidateFromRow(enrichRow(top as SessionRow, deps));
    } catch { /* no sessions → omit */ }
    // Stamp at COMPLETION, not at start. Stamping the start time meant a resolution that
    // took longer than the TTL wrote an ALREADY-EXPIRED entry, so the very next caller
    // re-resolved from cold — measured on prod as an 8.2s call landing right after a warm
    // round. The slower the resolution, the shorter its cache lived; exactly backwards.
    cache = { at: Date.now(), value: out };
    return out;
  })();
  inFlight = run;
  // Release the slot however it settles — a failed resolution must never wedge it.
  void run.then(() => undefined, () => undefined).finally(() => { if (inFlight === run) inFlight = null; });
  return run;
}

/** Resolve BOTH the most-recent claude.ai conversation and Claude Code session by recency.
 *  SINGLE-FLIGHT while running, and STALE-WHILE-REVALIDATE once resolved: a caller past the
 *  TTL is served the previous answer immediately while the refresh runs behind it, so the
 *  network call leaves the hot path after the first resolution. Identity here is explicitly
 *  best-effort (the caller may still be wrong about which candidate it is), so a
 *  seconds-old answer now beats a fresh one that costs the write its relay deadline. */
export async function resolveRecencyCandidates(deps: RecencyDeps = liveDeps): Promise<CallerCandidates> {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && age < RESOLVE_TTL_MS) return cache.value;
  if (cache && age < RESOLVE_MAX_STALE_MS) { void refresh(deps); return cache.value; }
  return refresh(deps);
}

/** Resolve the caller: precise tool-call-id match when available (overrides the CC candidate and
 *  marks `precise`), else the recency candidates. The expensive recency part is cached; the
 *  per-call precise match is cheap (in-memory) so it runs every call. */
export async function resolveCallerCandidates(deps: RecencyDeps = liveDeps): Promise<CallerCandidates> {
  const base = await resolveRecencyCandidates(deps);
  const toolUseId = currentMcpContext()?.toolUseId;
  if (!toolUseId) return base;
  const precise = findPreciseClaudeCodeSession(toolUseId, deps);
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
    'CONTRACT: every turn, print a ⟦WORKER-STATUS⟧ … ⟦/WORKER-STATUS⟧ block (Way 1 — always). If an orchestrator is active you MAY also report_status (writes your durable record — Way 3) and separately send_session_message to the orchestrator (Way 2). Before any gated step, report_status(status:"need_approval", reason) and STOP until the gate is agreed.',
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

async function getNodeClusterInfo(): Promise<{ cluster: string; otherClusters?: Array<{ name: string; description?: string; status?: string }> }> {
  try {
    const { getMyCluster } = require('../cluster/cluster-config') as typeof import('../cluster/cluster-config');
    const myCluster = getMyCluster();
    const result: { cluster: string; otherClusters?: Array<{ name: string; description?: string; status?: string }> } = { cluster: myCluster };
    // Populate otherClusters from the data service (guarded so errors don't throw).
    try {
      const { getClusterMeta } = require('../cluster/cluster-store') as typeof import('../cluster/cluster-store');
      const allMetas = await getClusterMeta();
      const others = allMetas.filter((m) => m.name !== myCluster);
      if (others.length > 0) {
        result.otherClusters = others.map((m) => ({
          name: m.name,
          ...(m.description !== undefined && { description: m.description }),
          ...(m.status !== undefined && { status: m.status }),
        }));
      }
    } catch { /* data service not enabled or error — otherClusters remains absent */ }
    return result;
  } catch { return { cluster: 'default' }; }
}

async function handleSessionStatus(_args: Record<string, unknown>): Promise<McpToolResult> {
  const c = await resolveCallerCandidates();
  const bootstrapped = (id?: string) => (id ? !!REGISTRY.get(id)?.bootstrappedAt : false);
  const clusterInfo = await getNodeClusterInfo();
  const obj = c.precise && c.claudeCode ? {
    note: 'PRECISE: this MCP call carried a tool-call id (_meta["claudecode/toolUseId"]) that matched the calling conversation exactly — no guessing.',
    callerType: 'claude-code',
    claudeCodeSession: { ...c.claudeCode, matchedBy: 'tool-call-id', bootstrapped: bootstrapped(c.claudeCode.id) },
    ...clusterInfo,
    howTo: 'If you have not bootstrapped, call bootstrap() once to load all lm-assist capabilities.',
  } : {
    note: 'No tool-call id on this call. These are the most-recently-active candidates resolved from the node APIs — PICK the one matching your runtime (claude.ai conversation vs Claude Code session). Heuristic by recency.',
    claudeAiConversation: c.claudeAi ? { ...c.claudeAi, bootstrapped: bootstrapped(c.claudeAi.id) } : 'unavailable (claude.ai not configured on this node)',
    claudeCodeSession: c.claudeCode ? { ...c.claudeCode, bootstrapped: bootstrapped(c.claudeCode.id) } : 'none recent',
    ...clusterInfo,
    howTo: 'If you have not bootstrapped, call bootstrap() once to load all lm-assist capabilities.',
  };
  // Lead with the fleet/connector identity so a conversation knows WHICH fleet it is on.
  return { content: [{ type: 'text', text: fleetIdentity() + '\n\n' + pretty(obj) }] };
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

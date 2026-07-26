/**
 * conversation_tokens + conversation_fork — measure a claude.ai web conversation's
 * context, and carry it forward before it hits the ceiling.
 *
 * ── Credential-aware routing (the defining constraint) ─────────────────────
 * Both tools are REGISTERED on every node (every node runs Core) but only
 * FUNCTIONAL on a node holding a valid claude.ai cookie. So each call:
 *   1. preflights the LOCAL cookie;
 *   2. if local is good, serves in place (no hop);
 *   3. if not, finds a cookie-bearing node and FORWARDS there via /mcp-call
 *      (relay-allowed), reporting `servedByNodeId`;
 *   4. if nothing is eligible, refuses with an actionable message naming the
 *      eligible hostIds — never a raw 401 or a page of HTML.
 *
 * `servedByNodeId` is always a hostId (gw4-…), never a hostname: a live fleet
 * sweep returned `vm` 4x and `ubuntu-Virtual-Machine` 3x, and a dev-repo Core
 * appends " (dev)". A display name cannot identify a node.
 *
 * Node choice implicitly selects an ACCOUNT (different nodes may hold cookies
 * for different logins), so the resolved account is reported on every result and
 * an explicit `node` that lacks a cookie is REFUSED rather than rerouted.
 *
 * ── No self-identification, ever ───────────────────────────────────────────
 * The claude.ai web client does not tag MCP calls with a caller id — verified
 * live: `session_status` from a claude.ai conversation returns "No tool-call id
 * on this call", and `rename_conversation` falls back to a RECENCY GUESS that
 * once returned an unrelated session entirely. Both tools therefore require an
 * explicit `conversation_uuid`. There is no "this conversation".
 */
import { ok, err, workerGet, workerPostRaw } from './_passthrough';
import type { McpToolResult } from './_passthrough';
import { collectLocalCredential } from '../../fleet/credential-collector';
import { getCredentialFleet, pickCredentialedNode, describeNoCredential } from '../../fleet/credential-fleet';
import { credentialDeps } from '../../routes/core/fleet.routes';
import { proxyPost } from '../../hub-client/hub-proxy';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which claude.ai ACCOUNT served this. Falls back to the org uuid: measured on
 *  prod, /api/account_profile carries no organization object, so a name is often
 *  absent — but an unlabelled result would hide which login a fork landed in. */
function acctLabel(a: { organizationName?: string; orgUuid?: string } | undefined): string {
  if (!a) return '';
  if (a.organizationName) return ` · account: ${a.organizationName}`;
  if (a.orgUuid) return ` · account org: ${a.orgUuid}`;
  return '';
}

/** Set on a forwarded call so a hop can never forward again. Two nodes each
 *  believing the other holds the cookie would otherwise ping-pong. */
const NO_FORWARD = '_noForward';

function readUuid(args: Record<string, unknown>): string | null {
  const raw = args.conversation_uuid ?? args.conversationUuid ?? args.uuid;
  const s = typeof raw === 'string' ? raw.trim() : '';
  return UUID_RE.test(s) ? s : null;
}

/**
 * Resolve where this call should run.
 * Returns either `{ serve: true }` (run here) or a forwarding target, or an
 * actionable refusal.
 */
async function resolveTarget(
  args: Record<string, unknown>,
): Promise<{ kind: 'serve'; hostId: string } | { kind: 'forward'; hostId: string } | { kind: 'refuse'; text: string }> {
  const requested = typeof args.node === 'string' ? args.node.trim() : '';
  const local = await collectLocalCredential(true);

  // Already the requested node, or no request and we hold a good cookie: serve.
  const requestedIsSelf = !requested || requested === local.hostId || requested === local.displayName;
  if (local.cookie.ok && requestedIsSelf) return { kind: 'serve', hostId: local.hostId };

  // A forwarded call never forwards again; it answers with what it has.
  if (args[NO_FORWARD]) {
    const composed = { generatedAt: Date.now(), scope: 'fleet' as const, nodes: [local], unreachable: [], partial: false };
    return { kind: 'refuse', text: describeNoCredential(composed, requested || undefined) };
  }

  const composed = await getCredentialFleet('fleet', credentialDeps());
  const picked = pickCredentialedNode(composed, { requested: requested || undefined, selfId: local.hostId });
  if (!picked.node) return { kind: 'refuse', text: describeNoCredential(composed, requested || undefined) };
  if (picked.node.hostId === local.hostId) return { kind: 'serve', hostId: local.hostId };
  return { kind: 'forward', hostId: picked.node.hostId };
}

/** Re-issue this tool call on a cookie-bearing node over the relay-allowed shim. */
async function forward(tool: string, args: Record<string, unknown>, hostId: string): Promise<McpToolResult> {
  const fwd = { ...args, [NO_FORWARD]: true };
  delete (fwd as Record<string, unknown>).node;
  try {
    const res = (await proxyPost(hostId, '/mcp-call', { tool, args: fwd })) as
      | { data?: McpToolResult; error?: { message?: string } }
      | McpToolResult;
    const payload = (res as { data?: McpToolResult })?.data ?? (res as McpToolResult);
    if (payload && Array.isArray((payload as McpToolResult).content)) {
      const r = payload as McpToolResult;
      const first = r.content[0];
      if (first && first.type === 'text') {
        return { ...r, content: [{ type: 'text', text: `${first.text}\n\n(auto-routed to ${hostId} — the node holding a claude.ai cookie)` }, ...r.content.slice(1)] };
      }
      return r;
    }
    const e = (res as { error?: { message?: string } })?.error;
    return err(`Auto-routing to ${hostId} returned no usable result${e?.message ? `: ${e.message}` : ''}.`);
  } catch (e) {
    return err(
      `Could not reach ${hostId} to serve this call: ${e instanceof Error ? e.message : String(e)}. ` +
      `That node holds the claude.ai cookie; retry with node:"${hostId}" once it is reachable.`,
    );
  }
}

// ── conversation_tokens ─────────────────────────────────────────────────────

export const conversationTokensToolDef = {
  name: 'conversation_tokens',
  description:
    "Estimate a claude.ai WEB conversation's context usage — NUMBERS ONLY, no message content. " +
    'Counts tool_use/tool_result blocks (usually most of an operational chat), walks only the ACTIVE ' +
    'branch, and honours COMPACTION: a compacted chat reports `liveTokens` (what the model sees now) ' +
    'well below `totalTokens`. Requires an explicit conversation_uuid — the connector is never told ' +
    'which conversation called it. Auto-routes to a node holding a claude.ai cookie. ' +
    'Reports `unmeasured[]` (system prompt, tool schemas) — the number is an estimate, not a ceiling reading.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      conversation_uuid: { type: 'string', description: 'Conversation uuid (from list_claudeai_conversations). Required — there is no "this conversation".' },
      ceiling_tokens: { type: 'number', description: 'Override the assumed 1M context ceiling used for pctOfCeiling.' },
    },
    required: ['conversation_uuid'],
  },
};

export async function handleConversationTokens(args: Record<string, unknown>): Promise<McpToolResult> {
  const uuid = readUuid(args);
  if (!uuid) return err('conversation_uuid is required and must be a uuid. List candidates with list_claudeai_conversations.');

  const target = await resolveTarget(args);
  if (target.kind === 'refuse') return err(target.text);
  if (target.kind === 'forward') return forward('conversation_tokens', args, target.hostId);

  const ceiling = Number(args.ceiling_tokens ?? args.ceilingTokens);
  const qs = Number.isFinite(ceiling) && ceiling > 0 ? `?ceiling=${Math.floor(ceiling)}` : '';
  try {
    const d = await workerGet<Record<string, any>>(`/claude-ai/conversations/${encodeURIComponent(uuid)}/tokens${qs}`);
    const b = d.breakdown || {};
    const m = d.messages || {};
    const c = d.compaction || {};
    const lines = [
      `Conversation: ${d.name || '(untitled)'}`,
      `uuid: ${d.conversationUuid || uuid}`,
      '',
      `LIVE context : ${Number(d.liveTokens).toLocaleString()} tokens  (${d.pctOfCeiling}% of ${Number(d.ceilingTokens).toLocaleString()}, ceiling ${d.ceilingSource})`,
      `Whole thread : ${Number(d.totalTokens).toLocaleString()} tokens  (if it had never been compacted)`,
      '',
      'Live breakdown:',
      `  tool_result ${Number(b.tool_result || 0).toLocaleString()}`,
      `  tool_use    ${Number(b.tool_use || 0).toLocaleString()}`,
      `  text        ${Number(b.text || 0).toLocaleString()}`,
      `  thinking    ${Number(b.thinking || 0).toLocaleString()}`,
      '',
      `Messages: ${m.total} total · ${m.onActiveBranch} on the active branch · ${m.offBranch} on dead branches · ${m.live} in the live window`,
      c.compacted
        ? `Compaction: ${c.events} event(s); the surviving summary costs ~${Number(c.summaryTokens || 0).toLocaleString()} tokens and replaces ${m.compactedAway} earlier messages.`
        : 'Compaction: none — live equals the whole thread.',
      `Confidence: ${d.confidence}`,
      '',
      'NOT included in this estimate:',
      ...(Array.isArray(d.unmeasured) ? d.unmeasured.map((u: string) => `  - ${u}`) : []),
      '',
      `Served by ${d.servedByNodeId}${acctLabel(d.account)}`,
    ];
    return ok(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ── conversation_fork ───────────────────────────────────────────────────────

export const conversationForkToolDef = {
  name: 'conversation_fork',
  description:
    'Fork a claude.ai WEB conversation: build a structured handoff from it and seed a NEW conversation ' +
    'with that handoff. Returns the new uuid + web URL. The handoff is POINTERS, not prose — ids with the ' +
    'command that re-reads each, verbatim human instructions, and the playbooks the work relied on; tool ' +
    'RESULT bodies are excluded so the fork does not re-import the bulk it exists to escape. ' +
    'Use dry_run:true to inspect the handoff before creating anything. WRITE: creates a conversation.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      conversation_uuid: { type: 'string', description: 'Source conversation uuid. Required — there is no "this conversation".' },
      title: { type: 'string', description: 'Title for the new conversation. Default "Continued: <source name>".' },
      objective: { type: 'string', description: 'What the continuation is for — the one place prose is wanted.' },
      extra_pointers: { type: 'array', items: { type: 'string' }, description: 'Extra pointers to carry (e.g. "docs/foo.md — the spec").' },
      max_human_turns: { type: 'number', description: 'How many recent human turns to carry verbatim (default 12).' },
      dry_run: { type: 'boolean', description: 'Render the handoff without creating a conversation.' },
    },
    required: ['conversation_uuid'],
  },
};

export async function handleConversationFork(args: Record<string, unknown>): Promise<McpToolResult> {
  const uuid = readUuid(args);
  if (!uuid) return err('conversation_uuid is required and must be a uuid. List candidates with list_claudeai_conversations.');

  const target = await resolveTarget(args);
  if (target.kind === 'refuse') return err(target.text);
  if (target.kind === 'forward') return forward('conversation_fork', args, target.hostId);

  const dryRun = args.dry_run === true || args.dry_run === 'true' || args.dryRun === true;
  const body: Record<string, unknown> = { dryRun };
  if (typeof args.title === 'string') body.title = args.title;
  if (typeof args.objective === 'string') body.objective = args.objective;
  if (Array.isArray(args.extra_pointers)) body.extraPointers = args.extra_pointers;
  const mht = Number(args.max_human_turns ?? args.maxHumanTurns);
  if (Number.isFinite(mht) && mht > 0) body.maxHumanTurns = mht;
  if (typeof args.model === 'string') body.model = args.model;

  try {
    // workerPost's 30s budget is shorter than a fork (create + seed + drain),
    // and a timeout there would report failure for a conversation that WAS
    // created — measured. workerPostRaw allows 120s and keeps error.code.
    const env = await workerPostRaw(`/claude-ai/conversations/${encodeURIComponent(uuid)}/fork`, body);
    if (env && env.success === false) {
      const e = (env.error || {}) as { code?: string; message?: string };
      return err(`${e.code ? `[${e.code}] ` : ''}${e.message || 'fork failed'}`);
    }
    const d = ((env || {}).data || {}) as Record<string, any>;
    const p = d.pointers || {};
    const ptrLine = Object.entries(p)
      .filter(([, v]) => Array.isArray(v) && (v as unknown[]).length)
      .map(([k, v]) => `${k}:${(v as unknown[]).length}`)
      .join(' · ');

    if (d.dryRun) {
      return ok([
        `DRY RUN — nothing was created.`,
        `Would title  : ${d.title}`,
        `Handoff size : ${Number(d.seedChars).toLocaleString()} chars (source live context ~${Number(d.sourceEstimate?.liveTokens || 0).toLocaleString()} tokens)`,
        `Pointers     : ${ptrLine || '(none found)'}`,
        `Human turns  : ${d.humanTurns}`,
        '',
        '--- handoff that would be sent ---',
        String(d.seed || ''),
      ].join('\n'));
    }

    const lines = [
      d.seeded
        ? (d.replyPending
            ? 'Forked. The handoff landed; the model is still composing its first reply.'
            : 'Forked.')
        : 'Conversation CREATED but the handoff did NOT land — open it and paste the handoff, or retry.',
      `New conversation: ${d.conversationUuid}`,
      `URL             : ${d.webUrl}`,
      `Title           : ${d.title}`,
      `Handoff         : ${Number(d.seedChars).toLocaleString()} chars · ${d.humanTurns} verbatim human turns · pointers ${ptrLine || '(none)'}`,
      `Source          : ${d.sourceUuid} (live ~${Number(d.sourceEstimate?.liveTokens || 0).toLocaleString()} tokens)`,
      ...(d.seedError ? [`Seed error      : ${d.seedError}`] : []),
      '',
      `Served by ${d.servedByNodeId}${acctLabel(d.account)}`,
    ];
    return ok(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const CONVERSATION_OPS_TOOL_DEFS = [conversationTokensToolDef, conversationForkToolDef];
export const CONVERSATION_OPS_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  conversation_tokens: handleConversationTokens,
  conversation_fork: handleConversationFork,
};

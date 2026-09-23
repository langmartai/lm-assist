/**
 * mcp_connectors — one claude.ai connector per tool-loading profile.
 *
 * A thin client of the REST surface in routes/core/mcp-tools.routes.ts
 * (GET/POST /mcp-tools/profile-connectors, DELETE /mcp-tools/profile-connectors/:profile), reached
 * on loopback like the other claude.ai connector tools. Output is bounded by construction: one
 * line per profile, never tool names. Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS.
 */
import { ok, err, workerGet, workerPost, workerDelete, type McpToolResult } from './_passthrough';

export const mcpConnectorsToolDef = {
  name: 'mcp_connectors',
  description:
    'One claude.ai connector PER tool-loading profile on this hub — e.g. "lm-assist langmart basic" at ' +
    'https://mcp.<domain>/mcp/basic advertises only the basic profile, while the unpinned /mcp connector ' +
    'follows the node default. action="list" (default): each profile\'s URL and its claude.ai connector ' +
    '(connected, auth, tool count) or none. action="create" + profile: registers that connector on claude.ai ' +
    '(idempotent by URL); ONE browser step remains — claude.ai → Customize → Connectors → Connect. ' +
    'action="delete" + profile: removes it. A profile is a context budget, not a permission. WRITE on ' +
    'create/delete (changes the user\'s claude.ai account); runs where the claude.ai cookie lives (use `node`).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['list', 'create', 'delete'], description: 'list (default) | create | delete.' },
      profile: { type: 'string', description: 'Profile for create/delete (e.g. "basic", "extended").' },
    },
  },
};

export const MCP_CONNECTORS_TOOL_DEFS = [mcpConnectorsToolDef] as const;

interface ConnView { uuid: string | null; name: string; connected: boolean; authStatus: string | null; toolCount: number | null }
interface Row { profile: string; url: string; suggestedName: string; connector: ConnView | null; duplicates: number }
interface ListData {
  base: string;
  hub: string;
  nodeDefault: string;
  claudeai: { ok: boolean; error?: string };
  unpinned: Omit<Row, 'profile'>;
  profiles: Row[];
  unknownPins: Array<{ profile: string; url: string; connector: ConnView | null }>;
}

function describe(c: ConnView | null): string {
  if (!c) return 'no claude.ai connector';
  const status = [c.connected ? 'connected' : 'NOT connected', c.authStatus].filter(Boolean).join(', ');
  return `"${c.name}" [${status}]${c.toolCount !== null ? ` ${c.toolCount} tools` : ''}${c.uuid ? ` · uuid ${c.uuid}` : ''}`;
}

async function handleList(): Promise<McpToolResult> {
  const d = await workerGet<ListData>('/mcp-tools/profile-connectors');
  const lines = [`lm-assist connectors on ${d.base} (node default profile: ${d.nodeDefault})`];
  if (!d.claudeai.ok) lines.push(`WARNING: claude.ai is not readable from this node (${d.claudeai.error}) — the URLs below are still valid.`);
  lines.push(`- unpinned  ${d.unpinned.url} → ${describe(d.unpinned.connector)} (follows the node default)`);
  for (const r of d.profiles) {
    lines.push(`- ${r.profile}  ${r.url} → ${describe(r.connector)}${r.duplicates ? ` (+${r.duplicates} duplicate)` : ''}`);
  }
  for (const u of d.unknownPins) {
    lines.push(`- ${u.profile} (unknown to this node — served the node default)  ${u.url} → ${describe(u.connector)}`);
  }
  lines.push('');
  lines.push('→ mcp_connectors(action="create", profile="…") for a missing one; each new connector needs one Connect click on claude.ai.');
  lines.push('Every enabled connector loads its tools into a conversation — enable the ONE you want per conversation.');
  return ok(lines.join('\n'));
}

async function handleCreate(profile: string): Promise<McpToolResult> {
  const d = await workerPost<{ created: boolean; profile: string; url: string; connector: ConnView | null; nextStep: string | null }>(
    '/mcp-tools/profile-connectors', { profile });
  return ok([
    d.created
      ? `Created the claude.ai connector for profile "${d.profile}".`
      : `A claude.ai connector for profile "${d.profile}" already exists — nothing created.`,
    `url: ${d.url}`,
    `connector: ${describe(d.connector)}`,
    d.nextStep ? `NEXT: ${d.nextStep}` : 'It is connected — start a fresh conversation to use it.',
  ].join('\n'));
}

async function handleDelete(profile: string): Promise<McpToolResult> {
  const d = await workerDelete<{ profile: string; url: string; removed: Array<{ uuid: string; name: string }>; failed: Array<{ uuid: string; error: string }> }>(
    `/mcp-tools/profile-connectors/${encodeURIComponent(profile)}`);
  return ok(
    `Removed ${d.removed.length} claude.ai connector(s) for profile "${d.profile}" (${d.url}): ` +
      d.removed.map((r) => `"${r.name}"`).join(', ') +
      (d.failed.length ? `. FAILED: ${d.failed.map((f) => `${f.uuid} (${f.error})`).join('; ')}` : '.'),
  );
}

async function handleMcpConnectors(args: Record<string, unknown>): Promise<McpToolResult> {
  const action = typeof args.action === 'string' && args.action.trim() ? args.action.trim().toLowerCase() : 'list';
  const profile = typeof args.profile === 'string' ? args.profile.trim() : '';
  try {
    if (action === 'list') return await handleList();
    if (action === 'create' || action === 'delete') {
      if (!profile) return err(`profile is required for action="${action}".`);
      return action === 'create' ? await handleCreate(profile) : await handleDelete(profile);
    }
    return err(`unknown action "${action}" — use list, create or delete.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const MCP_CONNECTORS_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  mcp_connectors: handleMcpConnectors,
};

/**
 * session_dag MCP tool — the message-TREE structure of a Claude Code session
 * (what `detail`/`search` can't show): where the session FORKED from edits /
 * rewinds / compactions, and a way to walk any message's lineage or subtree.
 *
 * Default `view=summary` returns the fork points (lean — `/dag/branches`, no
 * node dump). Drill-in views take a `message` uuid:
 *   node     → that message + parent/children/siblings/depth
 *   ancestry → the path from the root to that message
 *   subtree  → everything under that message
 *
 * (Cross-session relations — subagents/teams — are intentionally NOT here:
 * `/session-dag` is heavy and times out on large sessions.)
 * Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS; scoped read.
 */
import { ok, err, workerGet, type McpToolResult } from './_passthrough';

export const sessionDagToolDef = {
  name: 'session_dag',
  description:
    'Show the message-TREE structure of a CODE SESSION — where it FORKED (edits, ' +
    'rewinds, /compact create alternate paths) and each path\'s size, which a linear ' +
    'transcript hides. Trigger words: "how did this session branch", "fork points", "did ' +
    'I rewind / edit", "session structure", "message tree", "alternate paths", "how did we ' +
    'get to X". Pass the code-session UUID as `id` (from search / list_recent_sessions). ' +
    'Default `view="summary"` = fork points. Drill in with `view="node"|"ancestry"|"subtree"` ' +
    '+ a `message` uuid (from a fork point). For the linear transcript use ' +
    'detail(id, section="conversation"). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Code session UUID (from search / list_recent_sessions / detail).' },
      view: { type: 'string', enum: ['summary', 'node', 'ancestry', 'subtree'], description: 'summary (default) = fork points; node/ancestry/subtree drill into a message.' },
      message: { type: 'string', description: 'A message UUID for the node/ancestry/subtree views (from a summary fork point).' },
    },
    required: ['id'],
  },
};

export const SESSION_DAG_TOOL_DEFS = [sessionDagToolDef] as const;

interface DagNode { id?: string; type?: string; label?: string; metadata?: { lineIndex?: number; toolName?: string; timestamp?: string; model?: string } }
interface ForkPoint { forkNode?: DagNode; branches?: Array<{ firstNode?: DagNode; messageCount?: number }> }

function enc(s: string): string { return encodeURIComponent(s); }

function when(ts?: string): string { return ts ? ts.replace('T', ' ').slice(0, 16) : ''; }
function preview(label?: string): string {
  const s = (label || '').replace(/\s+/g, ' ').trim();
  return s.length > 70 ? s.slice(0, 70) + '…' : s;
}
/** One compact line for a DAG node. */
function fmtNode(n: DagNode): string {
  const m = n.metadata || {};
  const tool = m.toolName ? `/${m.toolName}` : '';
  return `[line ${m.lineIndex ?? '?'}] ${n.type || '?'}${tool}: ${preview(n.label) || '—'}`;
}

async function handleSessionDag(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id || '').trim();
  if (!id) return err('id is required (a code session UUID from search / list_recent_sessions).');
  const view = String(args.view || 'summary');
  const message = String(args.message || '').trim();
  if (view !== 'summary' && !message) {
    return err(`view="${view}" needs a \`message\` uuid (take one from a session_dag summary fork point, or a dag node).`);
  }

  try {
    if (view === 'summary') {
      const r = (await workerGet(`/sessions/${enc(id)}/dag/branches`)) as { forkPoints?: ForkPoint[] };
      const forks = r.forkPoints || [];
      if (forks.length === 0) {
        return ok(`Session ${id} is LINEAR — no fork points (no edits/rewinds/compactions created alternate paths). Use detail("${id}", section="conversation") for the transcript.`);
      }
      const sorted = forks
        .map((f) => ({ f, total: (f.branches || []).reduce((s, b) => s + (b.messageCount || 0), 0) }))
        .sort((a, b) => b.total - a.total);
      const lines = [
        `Session ${id} — branch structure: ${forks.length} fork point(s) where the message tree splits (edits, rewinds, /compact, or parallel/sidechain messages):`,
        '',
      ];
      for (const { f } of sorted.slice(0, 12)) {
        const m = f.forkNode?.metadata || {};
        const tool = m.toolName ? `/${m.toolName}` : '';
        const sizes = (f.branches || []).map((b) => `${b.messageCount ?? '?'} msgs`).join(' | ');
        lines.push(`  • line ${m.lineIndex ?? '?'} (${f.forkNode?.type || '?'}${tool}${when(m.timestamp) ? `, ${when(m.timestamp)}` : ''}) → ${(f.branches || []).length} paths: ${sizes}`);
        lines.push(`      fork uuid: ${f.forkNode?.id}`);
      }
      if (forks.length > 12) lines.push(`  … and ${forks.length - 12} more fork point(s).`);
      lines.push('');
      lines.push(`→ Drill in: session_dag(id="${id}", view="ancestry"|"subtree"|"node", message="<fork uuid>").`);
      return ok(lines.join('\n'));
    }

    if (view === 'node') {
      const r = (await workerGet(`/sessions/${enc(id)}/dag/node/${enc(message)}`)) as {
        node?: DagNode; parent?: DagNode | null; children?: DagNode[]; siblings?: DagNode[]; depth?: number; branch?: string;
      };
      if (!r.node) return ok(`No message ${message} in session ${id}.`);
      const lines = [`Message ${message} (depth ${r.depth ?? '?'}${r.branch ? `, branch ${r.branch}` : ''}):`, `  ${fmtNode(r.node)}`];
      if (r.parent) lines.push(`  parent: ${fmtNode(r.parent)}`);
      lines.push(`  children (${r.children?.length || 0})${r.children?.length ? ':' : ''}`);
      for (const c of (r.children || []).slice(0, 8)) lines.push(`    └ ${fmtNode(c)}`);
      if ((r.siblings?.length || 0) > 1) lines.push(`  siblings: ${r.siblings!.length} (this message is one of several children of its parent → a fork)`);
      return ok(lines.join('\n'));
    }

    if (view === 'ancestry') {
      const r = (await workerGet(`/sessions/${enc(id)}/dag/ancestors/${enc(message)}`)) as { path?: DagNode[]; depth?: number };
      const path = r.path || [];
      if (path.length === 0) return ok(`No ancestry for ${message} in session ${id} (root, or not found).`);
      const lines = [`Ancestry of ${message} (depth ${r.depth ?? path.length}) — root → message:`, ''];
      for (const n of path) lines.push(`  ${fmtNode(n)}`);
      return ok(lines.join('\n'));
    }

    if (view === 'subtree') {
      const r = (await workerGet(`/sessions/${enc(id)}/dag/descendants/${enc(message)}`)) as { subtree?: { nodes?: DagNode[] } };
      const nodes = r.subtree?.nodes || [];
      if (nodes.length === 0) return ok(`Message ${message} has no descendants (it's a leaf) in session ${id}.`);
      const lines = [`Subtree under ${message}: ${nodes.length} message(s). First ${Math.min(15, nodes.length)}:`, ''];
      for (const n of nodes.slice(0, 15)) lines.push(`  ${fmtNode(n)}`);
      if (nodes.length > 15) lines.push(`  … and ${nodes.length - 15} more.`);
      return ok(lines.join('\n'));
    }

    return err(`unknown view "${view}" — use summary | node | ancestry | subtree.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const SESSION_DAG_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  session_dag: handleSessionDag,
};

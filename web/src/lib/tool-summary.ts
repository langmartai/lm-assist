/**
 * Pure tool-call summarizer for the CCR transcript — renders a claude.ai/code-style compact
 * one-line summary for a tool call ("Edited App.tsx +4 -1") and a grouped label for a run of
 * consecutive calls ("Ran 2 commands, read a file"). Unit-tested in __tests__/tool-summary.test.ts.
 */

export interface ToolCallLite { name: string; input?: unknown; result?: string; isError?: boolean }

function basename(p: string): string {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

function truncate(s: string, n: number): string {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** Multiset line diff → added/removed counts (a close approximation of claude.ai's +N -M). */
export function lineDiff(oldS: string, newS: string): { added: number; removed: number } {
  const o = oldS ? String(oldS).split('\n') : [];
  const n = newS ? String(newS).split('\n') : [];
  const oCount = new Map<string, number>();
  for (const l of o) oCount.set(l, (oCount.get(l) || 0) + 1);
  const nCount = new Map<string, number>();
  for (const l of n) nCount.set(l, (nCount.get(l) || 0) + 1);
  let added = 0, removed = 0;
  for (const [l, c] of nCount) added += Math.max(0, c - (oCount.get(l) || 0));
  for (const [l, c] of oCount) removed += Math.max(0, c - (nCount.get(l) || 0));
  return { added, removed };
}

export interface ToolSummary { verb: string; target: string; added?: number; removed?: number }

/** Summarize a single tool call → verb + target (+ diff stats for edits/writes). Pure. */
export function summarizeToolCall(name: string, input?: unknown): ToolSummary {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const file = () => basename(String(inp.file_path || inp.path || ''));
  switch (name) {
    case 'Read':
      return { verb: 'Read', target: file() };
    case 'Edit': {
      const d = lineDiff(String(inp.old_string || ''), String(inp.new_string || ''));
      return { verb: 'Edited', target: file(), added: d.added, removed: d.removed };
    }
    case 'MultiEdit': {
      let added = 0, removed = 0;
      for (const e of (Array.isArray(inp.edits) ? inp.edits : [])) {
        const d = lineDiff(String(e?.old_string || ''), String(e?.new_string || ''));
        added += d.added; removed += d.removed;
      }
      return { verb: 'Edited', target: file(), added, removed };
    }
    case 'Write': {
      const c = String(inp.content ?? inp.file_text ?? '');
      return { verb: 'Created', target: file(), added: c ? c.split('\n').length : 0, removed: 0 };
    }
    case 'Bash':
      return { verb: 'Ran', target: truncate(String(inp.command || inp.cmd || ''), 70) };
    case 'Grep':
    case 'Glob':
      return { verb: 'Searched', target: String(inp.pattern || '') };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { verb: 'Updated', target: 'tasks' };
    default: {
      if (/web.?fetch|fetch|^http|url|browse|navigate/i.test(name)) return { verb: 'Fetched', target: String(inp.url || inp.query || '') };
      if (/web.?search|search|grep|glob|find/i.test(name)) return { verb: 'Searched', target: String(inp.query || inp.pattern || '') };
      return { verb: 'Used', target: prettyToolName(name) };
    }
  }
}

/** A readable tool name for MCP / connector tools (mcp__x__do_thing → "do thing"). */
export function prettyToolName(name: string): string {
  const n = String(name || '');
  const m = n.replace(/^mcp__[^_]+__/, '').replace(/^mcp__/, '');
  return m.replace(/_/g, ' ');
}

/** Format one summary → "Edited App.tsx +4 -1". */
export function formatSummary(s: ToolSummary): string {
  const stat = (s.added != null || s.removed != null) ? ` +${s.added || 0} -${s.removed || 0}` : '';
  return `${s.verb} ${s.target}${stat}`.trim();
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A single compact label for a run of tool calls (claude.ai groups consecutive calls):
 *  - one call → its own summary ("Edited App.tsx +4 -1")
 *  - many → a category phrase ("Ran 2 commands, read a file")
 * Pure.
 */
export function groupLabel(toolCalls: ToolCallLite[]): string {
  if (!toolCalls || toolCalls.length === 0) return '';
  if (toolCalls.length === 1) return formatSummary(summarizeToolCall(toolCalls[0].name, toolCalls[0].input));

  let commands = 0, reads = 0, edits = 0, searches = 0, other = 0;
  for (const t of toolCalls) {
    if (t.name === 'Bash') commands++;
    else if (t.name === 'Read') reads++;
    else if (t.name === 'Edit' || t.name === 'MultiEdit' || t.name === 'Write') edits++;
    else if (t.name === 'Grep' || t.name === 'Glob') searches++;
    else other++;
  }
  const parts: string[] = [];
  if (commands) parts.push(plural(commands, 'command', 'commands'));
  if (edits) parts.push(plural(edits, 'edit', 'edits'));
  if (reads) parts.push(reads === 1 ? 'read a file' : `read ${reads} files`);
  if (searches) parts.push(plural(searches, 'search', 'searches'));
  if (other) parts.push(plural(other, 'tool call', 'tool calls'));

  // Lead with "Ran" when commands dominate, else a generic verb.
  const lead = commands ? 'Ran ' : 'Used ';
  const phrase = parts.join(', ');
  // "Ran 2 commands, read a file" — capitalize the first letter only.
  const s = commands ? `${lead}${phrase}` : `${lead}${phrase}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

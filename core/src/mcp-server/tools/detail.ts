/**
 * detail tool — Unified progressive disclosure for any item by ID
 *
 * Replaces: session_context, session_conversation, knowledge_detail
 *
 * ID detection:
 *   K001.2        → knowledge part
 *   K001          → knowledge doc
 *   hexId         → session
 */

import { getSessionCache, isRealUserPrompt } from '../../session-cache';
import { getKnowledgeStore } from '../../knowledge/store';

// ─── Tool Definition (canonical source: definitions.ts) ─────────────

export { detailToolDef } from './definitions';

// ─── ID Detection ──────────────────────────────────────────────────

type IdType = 'knowledge_part' | 'knowledge_doc' | 'session' | 'unknown';

function detectIdType(id: string): IdType {
  if (/^K\d+\.\d+$/.test(id)) return 'knowledge_part';
  if (/^K\d+$/.test(id)) return 'knowledge_doc';
  // Session ID: strict UUID format or hex string (8+ chars, may include hyphens)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return 'session';
  if (/^[0-9a-f-]{8,}$/i.test(id)) return 'session';
  return 'unknown';
}

// ─── Handler ──────────────────────────────────────────────────

export async function handleDetail(args: Record<string, unknown>): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const id = String(args.id || '').trim();
  if (!id) {
    return { content: [{ type: 'text', text: 'Error: id is required' }] };
  }

  const section = args.section as string | undefined;
  const offset = Math.max(args.offset !== undefined ? Number(args.offset) : 0, 0);
  const limit = Math.max(args.limit !== undefined ? Number(args.limit) : 10, 1);

  const idType = detectIdType(id);

  switch (idType) {
    case 'knowledge_part':
      return handleKnowledgePart(id, section);
    case 'knowledge_doc':
      return handleKnowledgeDoc(id, section);
    case 'session':
      return handleSession(id, section, offset, limit);
    default:
      return { content: [{ type: 'text', text: `Unknown ID format: "${id}". Expected: K001, K001.2, or sessionId` }] };
  }
}

// ─── Knowledge Part (K001.2) ──────────────────────────────────────────

async function handleKnowledgePart(id: string, section?: string): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const store = getKnowledgeStore();

  // Extract knowledge ID from part ID (K001.2 → K001)
  const knowledgeId = id.replace(/\.\d+$/, '');
  const knowledge = store.findKnowledgeByOriginalId(knowledgeId);
  if (!knowledge) {
    return { content: [{ type: 'text', text: `Knowledge document ${knowledgeId} not found` }] };
  }

  const part = knowledge.parts.find(p => p.partId === id);
  if (!part) {
    return { content: [{ type: 'text', text: `Part ${id} not found in ${knowledgeId}` }] };
  }

  const lines: string[] = [];

  lines.push(`${id}: ${knowledge.title} → ${part.title} [${knowledge.type}]`);
  const originLine = knowledge.origin === 'remote'
    ? ` | Origin: remote (${knowledge.machineHostname || 'unknown'}, ${knowledge.machineOS || 'unknown'})`
    : '';
  lines.push(`Status: ${knowledge.status} | Updated: ${knowledge.updatedAt}${originLine}`);
  lines.push('');

  // Show content
  if (part.content) {
    lines.push(part.content);
  } else {
    lines.push(part.summary);
  }

  // Unaddressed comments for this part
  const comments = store.getComments(knowledgeId, false)
    .filter(c => c.partId === id);
  if (comments.length > 0) {
    lines.push('');
    lines.push(`⚠ Feedback (${comments.length} unaddressed):`);
    for (const c of comments) {
      const ago = formatTimeAgo(c.createdAt);
      lines.push(`  [${c.type}] "${c.content}" — ${ago}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push(`If outdated, use feedback("${id}", "outdated", "reason")`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Knowledge Doc (K001) ──────────────────────────────────────────

async function handleKnowledgeDoc(id: string, section?: string): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const store = getKnowledgeStore();
  const knowledge = store.findKnowledgeByOriginalId(id);
  if (!knowledge) {
    return { content: [{ type: 'text', text: `Knowledge document ${id} not found` }] };
  }

  const lines: string[] = [];

  lines.push(`${id}: ${knowledge.title} [${knowledge.type}]`);
  const docOriginLine = knowledge.origin === 'remote'
    ? ` | Origin: remote (${knowledge.machineHostname || 'unknown'}, ${knowledge.machineOS || 'unknown'})`
    : '';
  lines.push(`Status: ${knowledge.status} | ${knowledge.parts.length} parts | Updated: ${knowledge.updatedAt}${docOriginLine}`);
  lines.push('');

  lines.push('Parts:');
  for (const part of knowledge.parts) {
    lines.push(`  ${part.partId}: ${part.title} — ${part.summary}`);
  }

  // Unaddressed comments summary
  const comments = store.getComments(id, false);
  if (comments.length > 0) {
    lines.push('');
    lines.push(`⚠ ${comments.length} unaddressed comment${comments.length > 1 ? 's' : ''}`);
  }

  lines.push('');
  lines.push(`→ detail("${knowledge.parts[0]?.partId || id + '.1'}") for full part content`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Session (UUID) ──────────────────────────────────────────────────

async function handleSession(id: string, section?: string, offset = 0, limit = 10): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const cache = getSessionCache();
  const sessions = cache.getAllSessionsFromCache();
  const session = sessions.find(s => s.sessionId === id);

  if (!session) {
    return { content: [{ type: 'text', text: `Session not found: ${id}` }] };
  }

  // Section: conversation — full session conversation with pagination
  if (section === 'conversation') {
    return renderConversation(id, undefined, undefined, offset, limit, `Session ${id}`);
  }

  // Default: session overview
  const cd = session.cacheData;
  const lines: string[] = [];

  lines.push(`Session ${id}`);
  lines.push(`Project: ${cd.cwd || 'unknown'} | Model: ${cd.model} | Turns: ${cd.numTurns} | Cost: $${cd.totalCostUsd.toFixed(2)}`);
  lines.push('');

  // User prompts summary
  const realPrompts = cd.userPrompts.filter(isRealUserPrompt);
  if (realPrompts.length > 0) {
    lines.push(`User Prompts (${realPrompts.length}):`);
    for (const p of realPrompts.slice(0, 10)) {
      const preview = p.text.length > 120 ? p.text.slice(0, 120) + '...' : p.text;
      lines.push(`  [turn ${p.turnIndex}] ${preview}`);
    }
    if (realPrompts.length > 10) {
      lines.push(`  ... and ${realPrompts.length - 10} more`);
    }
    lines.push('');
  }

  // Tasks summary
  if (cd.tasks.length > 0) {
    lines.push(`Tasks (${cd.tasks.length}):`);
    for (const t of cd.tasks.slice(0, 10)) {
      const icon = t.status === 'completed' ? 'done' :
                   t.status === 'in_progress' ? 'wip' :
                   t.status === 'deleted' ? 'del' : 'todo';
      lines.push(`  [${icon}] ${t.subject}`);
    }
    if (cd.tasks.length > 10) {
      lines.push(`  ... and ${cd.tasks.length - 10} more`);
    }
    lines.push('');
  }

  // Result
  if (cd.result) {
    lines.push('Result:');
    const preview = cd.result.length > 300 ? cd.result.slice(0, 300) + '...' : cd.result;
    lines.push(preview);
    lines.push('');
  }

  lines.push(`→ detail("${id}", section="conversation") for raw conversation`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Conversation Renderer (shared) ──────────────────────────────────

async function renderConversation(
  sessionId: string,
  fromTurn: number | undefined,
  toTurn: number | undefined,
  offset: number,
  limit: number,
  label: string,
  itemId?: string,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const cache = getSessionCache();
  const sessions = cache.getAllSessionsFromCache();
  const session = sessions.find(s => s.sessionId === sessionId);

  if (!session) {
    return { content: [{ type: 'text', text: `Session not found: ${sessionId}` }] };
  }

  const messages = await cache.getRawMessages(session.filePath);
  if (!messages) {
    return { content: [{ type: 'text', text: 'Could not read session messages' }] };
  }

  // Track turn index: starts at 0, increments on each 'assistant' message
  let turnIndex = 0;
  const lines: string[] = [];

  if (fromTurn !== undefined || toTurn !== undefined) {
    lines.push(`# ${label} (turns ${fromTurn ?? 0}-${toTurn ?? '...'})`);
  } else {
    lines.push(`# ${label}`);
  }
  lines.push('');

  // Collect messages in the turn range, then apply offset/limit
  const collected: Array<{ turnIdx: number; text: string }> = [];

  for (const msg of messages) {
    if (msg.type === 'assistant') {
      turnIndex++;
    }

    // Apply turn range filter
    if (fromTurn !== undefined && turnIndex < fromTurn) continue;
    if (toTurn !== undefined && turnIndex > toTurn) continue;

    // Format message
    if (msg.type === 'user') {
      const content = msg.message?.content;
      let text = '';

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') text += block.text;
        }
      } else if (typeof content === 'string') {
        text = content;
      }

      if (text) {
        const trimmed = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
        collected.push({
          turnIdx: turnIndex,
          text: `## User [turn ${turnIndex}]\n${trimmed}\n`,
        });
      }
    }

    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        const textBlocks: string[] = [];
        const toolCalls: string[] = [];

        for (const block of content) {
          if (block.type === 'text' && block.text) {
            textBlocks.push(block.text);
          }
          if (block.type === 'tool_use') {
            toolCalls.push(formatToolSummary(block));
          }
        }

        if (textBlocks.length > 0 || toolCalls.length > 0) {
          let formatted = `## Assistant [turn ${turnIndex}]\n`;
          for (const t of textBlocks) {
            const trimmed = t.length > 3000 ? t.slice(0, 3000) + '...' : t;
            formatted += trimmed + '\n';
          }
          for (const tc of toolCalls) {
            formatted += tc + '\n';
          }
          collected.push({ turnIdx: turnIndex, text: formatted });
        }
      }
    }

    if (msg.type === 'result') {
      let formatted = `## Result\nStatus: ${msg.subtype || 'unknown'}\n`;
      if (msg.result) {
        const trimmed = msg.result.length > 500 ? msg.result.slice(0, 500) + '...' : msg.result;
        formatted += trimmed + '\n';
      }
      collected.push({ turnIdx: turnIndex, text: formatted });
    }
  }

  // Apply offset/limit pagination
  const page = collected.slice(offset, offset + limit);

  if (page.length === 0) {
    lines.push('No messages found in the specified range.');
  } else {
    for (const entry of page) {
      lines.push(entry.text);
    }
  }

  // Pagination hints
  if (offset + limit < collected.length) {
    const nextOffset = offset + limit;
    const remaining = collected.length - nextOffset;
    lines.push(`--- Page ${Math.floor(offset / limit) + 1} of ${Math.ceil(collected.length / limit)} | ${remaining} more messages`);

    const paginationId = itemId || sessionId;
    lines.push(`→ detail("${paginationId}", section="conversation", offset=${nextOffset}) for next page`);
  } else if (offset > 0) {
    lines.push(`--- End of conversation (${collected.length} messages total)`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Formatting Helpers (from session-conversation.ts) ──────────────

function formatToolSummary(block: any): string {
  const name = block.name || 'unknown';
  const input = block.input || {};

  switch (name) {
    case 'Read':
      return `  [Read] ${input.file_path || '?'}`;
    case 'Write':
      return `  [Write] ${input.file_path || '?'}`;
    case 'Edit':
      return `  [Edit] ${input.file_path || '?'}`;
    case 'Bash':
      return `  [Bash] ${(input.command || '').slice(0, 100)}`;
    case 'Glob':
      return `  [Glob] ${input.pattern || '?'}`;
    case 'Grep':
      return `  [Grep] ${input.pattern || '?'}`;
    case 'Task':
      return `  [Task] ${input.description || input.prompt?.slice(0, 80) || '?'}`;
    default:
      return `  [${name}]`;
  }
}

// ─── Utility Helpers ──────────────────────────────────────────────────

function formatTimeAgo(timestamp: string): string {
  const ts = Date.parse(timestamp);
  if (isNaN(ts)) return timestamp;

  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'just now';

  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;

  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;

  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;

  return timestamp.slice(0, 10);
}

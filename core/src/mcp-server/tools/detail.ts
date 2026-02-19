/**
 * detail tool — Unified progressive disclosure for any item by ID
 *
 * Replaces: milestone_detail, session_context, session_conversation,
 *           knowledge_detail, and architecture detail views.
 *
 * ID detection:
 *   K001.2        → knowledge part
 *   K001          → knowledge doc
 *   arch:name     → architecture component
 *   hexId:index   → milestone
 *   hexId         → session
 */

import { getSessionCache, isRealUserPrompt } from '../../session-cache';
import { getMilestoneStore } from '../../milestone/store';
import { getKnowledgeStore } from '../../knowledge/store';
import type { Milestone } from '../../milestone/types';
import { loadModelCache, type ArchitectureModel } from '../../architecture-llm';
import { getProjectArchitectureData } from './project-architecture';

// ─── Tool Definition ──────────────────────────────────────────────────

export const detailToolDef = {
  name: 'detail',
  description: 'Get details for any item by ID — knowledge, session. Progressive disclosure: summary first, section parameter for specific parts.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'K001, K001.2, sessionId:index, or sessionId' },
      section: { type: 'string', description: 'Expand specific section: facts, files, content, conversation' },
      offset: { type: 'number', description: 'For paginated content (conversation turns, file lists)' },
      limit: { type: 'number', description: 'Items per page (default: 10)' },
    },
    required: ['id'],
  },
};

/** Full description used when experiment features (milestones/architecture) are enabled */
export const detailToolDefExperiment = {
  ...detailToolDef,
  description: 'Get details for any item by ID — knowledge, milestone, session, or architecture component. Progressive disclosure: summary first, section parameter for specific parts.',
  inputSchema: {
    ...detailToolDef.inputSchema,
    properties: {
      id: { type: 'string', description: 'K001, K001.2, sessionId:index, sessionId, or arch:component-name' },
      section: { type: 'string', description: 'Expand specific section: facts, files, content, conversation, milestones, connections, diagram' },
      offset: { type: 'number', description: 'For paginated content (conversation turns, file lists)' },
      limit: { type: 'number', description: 'Items per page (default: 10)' },
    },
  },
};

// ─── ID Detection ──────────────────────────────────────────────────

type IdType = 'knowledge_part' | 'knowledge_doc' | 'milestone' | 'session' | 'architecture' | 'unknown';

function detectIdType(id: string): IdType {
  if (/^K\d+\.\d+$/.test(id)) return 'knowledge_part';
  if (/^K\d+$/.test(id)) return 'knowledge_doc';
  if (/^arch:/.test(id)) return 'architecture';
  // Milestone ID: hex/uuid:index (8+ chars before colon, may include hyphens)
  if (/^[0-9a-f-]{8,}:\d+$/i.test(id)) return 'milestone';
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
    case 'milestone':
      return handleMilestone(id, section, offset, limit);
    case 'session':
      return handleSession(id, section, offset, limit);
    case 'architecture':
      return handleArchitecture(id, section);
    default:
      return { content: [{ type: 'text', text: `Unknown ID format: "${id}". Expected: K001, K001.2, sessionId:index, sessionId, or arch:component-name` }] };
  }
}

// ─── Knowledge Part (K001.2) ──────────────────────────────────────────

async function handleKnowledgePart(id: string, section?: string): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const store = getKnowledgeStore();

  // Extract knowledge ID from part ID (K001.2 → K001)
  const knowledgeId = id.replace(/\.\d+$/, '');
  const knowledge = store.getKnowledge(knowledgeId);
  if (!knowledge) {
    return { content: [{ type: 'text', text: `Knowledge document ${knowledgeId} not found` }] };
  }

  const part = knowledge.parts.find(p => p.partId === id);
  if (!part) {
    return { content: [{ type: 'text', text: `Part ${id} not found in ${knowledgeId}` }] };
  }

  const lines: string[] = [];

  lines.push(`${id}: ${knowledge.title} → ${part.title} [${knowledge.type}]`);
  lines.push(`Status: ${knowledge.status} | Updated: ${knowledge.updatedAt}`);
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
  const knowledge = store.getKnowledge(id);
  if (!knowledge) {
    return { content: [{ type: 'text', text: `Knowledge document ${id} not found` }] };
  }

  const lines: string[] = [];

  lines.push(`${id}: ${knowledge.title} [${knowledge.type}]`);
  lines.push(`Status: ${knowledge.status} | ${knowledge.parts.length} parts | Updated: ${knowledge.updatedAt}`);
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

// ─── Milestone (sessionId:index) ──────────────────────────────────────

async function handleMilestone(id: string, section?: string, offset = 0, limit = 10): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const store = getMilestoneStore();
  const milestone = store.getMilestoneById(id);

  if (!milestone) {
    return { content: [{ type: 'text', text: `Milestone not found: ${id}` }] };
  }

  // Section: conversation — scoped to milestone turn range
  if (section === 'conversation') {
    return renderConversation(
      milestone.sessionId,
      milestone.startTurn,
      milestone.endTurn,
      offset,
      limit,
      `Milestone ${id}`,
      id,
    );
  }

  // Section: files — complete file lists
  if (section === 'files') {
    return renderMilestoneFiles(milestone);
  }

  // Default: summary
  const lines: string[] = [];

  const typeTag = milestone.type ? ` [${milestone.type}]` : '';
  const phaseTag = ` (Phase ${milestone.phase})`;
  lines.push(`${id}: ${milestone.title || 'Untitled'}${typeTag}${phaseTag}`);
  lines.push(`Session: ${milestone.sessionId} | Turns ${milestone.startTurn}-${milestone.endTurn} | ${milestone.startTimestamp || '?'}`);
  lines.push('');

  if (milestone.description) {
    lines.push(milestone.description);
    lines.push('');
  }

  if (milestone.outcome) {
    lines.push(`Outcome: ${milestone.outcome}`);
    lines.push('');
  }

  if (milestone.facts && milestone.facts.length > 0) {
    lines.push('Facts:');
    for (const fact of milestone.facts) {
      lines.push(`- ${fact}`);
    }
    lines.push('');
  }

  if (milestone.concepts && milestone.concepts.length > 0) {
    lines.push(`Concepts: ${milestone.concepts.join(', ')}`);
    lines.push('');
  }

  // Files summary (abbreviated)
  if (milestone.filesModified.length > 0) {
    const fileNames = milestone.filesModified.map(f => basename(f));
    lines.push(`Files modified: ${fileNames.join(', ')}`);
  }
  if (milestone.filesRead.length > 0) {
    const shown = milestone.filesRead.slice(0, 5).map(f => basename(f));
    const more = milestone.filesRead.length > 5 ? ` (+${milestone.filesRead.length - 5} more)` : '';
    lines.push(`Files read: ${shown.join(', ')}${more}`);
  }

  lines.push('');
  lines.push(`→ detail("${id}", section="conversation") for turn-by-turn`);
  lines.push(`→ detail("${id}", section="files") for full file lists`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function renderMilestoneFiles(milestone: Milestone): {
  content: Array<{ type: string; text: string }>;
} {
  const lines: string[] = [];

  lines.push(`# Files for milestone ${milestone.id}`);
  lines.push('');

  if (milestone.filesModified.length > 0) {
    lines.push(`## Modified (${milestone.filesModified.length})`);
    for (const f of milestone.filesModified) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  if (milestone.filesRead.length > 0) {
    lines.push(`## Read (${milestone.filesRead.length})`);
    for (const f of milestone.filesRead) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  if (Object.keys(milestone.toolUseSummary).length > 0) {
    const toolStr = Object.entries(milestone.toolUseSummary)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}(${count})`)
      .join(', ');
    lines.push(`Tools used: ${toolStr}`);
  }

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

  // Default: session overview with milestones
  const cd = session.cacheData;
  const lines: string[] = [];

  lines.push(`Session ${id}`);
  lines.push(`Project: ${cd.cwd || 'unknown'} | Model: ${cd.model} | Turns: ${cd.numTurns} | Cost: $${cd.totalCostUsd.toFixed(2)}`);
  lines.push('');

  // Milestones
  const milestoneStore = getMilestoneStore();
  const milestones = milestoneStore.getMilestones(id);

  if (milestones.length > 0) {
    lines.push(`Milestones (${milestones.length}):`);
    for (const m of milestones) {
      const typeTag = m.type ? ` [${m.type}]` : '';
      lines.push(`  ${m.id}: ${m.title || `Milestone #${m.index}`}${typeTag}`);
    }
    lines.push('');
  }

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

  if (milestones.length > 0) {
    lines.push(`→ detail("${milestones[0].id}") for milestone details`);
  }
  lines.push(`→ detail("${id}", section="conversation") for raw conversation`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Architecture (arch:component-name) ──────────────────────────────

async function handleArchitecture(id: string, section?: string): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const componentName = id.replace(/^arch:/, '');

  // Get architecture data
  const archData = await getProjectArchitectureData();
  if (!archData) {
    return { content: [{ type: 'text', text: 'No architecture data available. Run project_architecture() first.' }] };
  }

  // Try to find as a directory component
  // IDs from search use hyphens (arch:src-mcp-server), directories use slashes (src/mcp-server/)
  const component = archData.components.find(c => {
    const dir = c.directory === '(project root)' ? '.' : c.directory;
    const dirNormalized = dir.replace(/\/$/, '');
    const dirHyphenated = dirNormalized.replace(/\//g, '-');
    return dirNormalized === componentName || dir === componentName ||
           dirHyphenated === componentName ||
           c.directory === componentName || c.directory === componentName + '/';
  });

  // Also try matching against service names from LLM model
  const modelCache = loadModelCache(archData.project);
  const model = modelCache?.model;
  const service = model?.services.find(s =>
    s.id === componentName || s.name.toLowerCase().replace(/\s+/g, '-') === componentName
  );

  if (!component && !service) {
    // List available components
    const lines: string[] = [];
    lines.push(`Component not found: ${componentName}`);
    lines.push('');
    lines.push('Available components:');
    for (const c of archData.components.slice(0, 15)) {
      const dir = c.directory === '(project root)' ? '.' : c.directory;
      const dirHyphenated = dir === '.' ? '.' : dir.replace(/\/$/, '').replace(/\//g, '-');
      lines.push(`  arch:${dirHyphenated}`);
    }
    if (model && model.services.length > 0) {
      lines.push('');
      lines.push('Available services:');
      for (const s of model.services) {
        lines.push(`  arch:${s.id}`);
      }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // Section: connections — show connections for this component
  if (section === 'connections') {
    return renderArchConnections(componentName, model ? model : null, archData);
  }

  // Section: diagram
  if (section === 'diagram') {
    if (!model || !model.mermaidDiagram) {
      return { content: [{ type: 'text', text: 'No diagram available. Architecture model has not been generated.' }] };
    }
    const lines: string[] = [];
    lines.push('## Architecture Diagram');
    lines.push('');
    lines.push('```mermaid');
    lines.push(model.mermaidDiagram);
    lines.push('```');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // Default: component detail
  const lines: string[] = [];

  if (component) {
    const dir = component.directory === '(project root)' ? '.' : component.directory;
    const tempLabel = component.temperature === 'hot' ? 'hot' : component.temperature === 'warm' ? 'warm' : 'cold';
    const lastTouched = component.lastTouched ? formatTimeAgo(component.lastTouched) : 'unknown';

    lines.push(`arch:${dir}: ${component.purpose}`);
    lines.push(`Directory: ${component.directory}/ | Temperature: ${tempLabel} | Last touched: ${lastTouched}`);
    lines.push('');

    // Purpose from types
    if (Object.keys(component.types).length > 0) {
      const typeStr = Object.entries(component.types)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}:${n}`)
        .join(', ');
      lines.push(`Activity: ${typeStr}`);
    }

    lines.push(`Files: ${component.fileCount} | Milestones: ${component.milestoneCount}`);
    lines.push('');

    // Recent milestones
    if (component.recentMilestones.length > 0) {
      lines.push('Recent milestones:');
      for (const title of component.recentMilestones) {
        lines.push(`  - ${title}`);
      }
      lines.push('');
    }

    // Key files in this directory
    const dirPath = component.directory === '(project root)' ? '' : component.directory;
    const matchingFiles = archData.keyFiles.filter(f =>
      dirPath === '' ? true : (f.filePath.startsWith(dirPath + '/') || f.filePath === dirPath)
    );

    if (matchingFiles.length > 0) {
      lines.push(`Key files (${matchingFiles.length}):`);
      for (const f of matchingFiles.slice(0, 10)) {
        let detail = `${f.modifyCount} modifies, ${f.readCount} reads`;
        if (f.lastMilestoneTitle) {
          detail += ` — ${f.lastMilestoneTitle}`;
        }
        lines.push(`  ${f.filePath} (${detail})`);
      }
      if (matchingFiles.length > 10) {
        lines.push(`  ... and ${matchingFiles.length - 10} more`);
      }
      lines.push('');
    }
  }

  // Service info from LLM model
  if (service) {
    if (component) lines.push('---');
    const portStr = service.port ? `:${service.port}` : '';
    const techStr = service.technologies.length > 0 ? ` [${service.technologies.join(', ')}]` : '';
    lines.push(`Service: ${service.name} (${service.type}${portStr})${techStr}`);
    lines.push(service.description);
    if (service.responsibilities.length > 0) {
      lines.push('');
      lines.push('Responsibilities:');
      for (const r of service.responsibilities) {
        lines.push(`  - ${r}`);
      }
    }
    lines.push('');
  }

  lines.push(`→ detail("${id}", section="connections") for connection details`);
  lines.push(`→ detail("${id}", section="diagram") for architecture diagram`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function renderArchConnections(
  componentName: string,
  model: ArchitectureModel | null,
  archData: Awaited<ReturnType<typeof getProjectArchitectureData>>
): { content: Array<{ type: string; text: string }> } {
  const lines: string[] = [];

  if (!model) {
    return { content: [{ type: 'text', text: 'No architecture model available. Model has not been generated.' }] };
  }

  // Find connections involving this component
  const relevantConnections = model.connections.filter(c =>
    c.from === componentName || c.to === componentName ||
    c.from.toLowerCase().replace(/\s+/g, '-') === componentName ||
    c.to.toLowerCase().replace(/\s+/g, '-') === componentName
  );

  if (relevantConnections.length === 0) {
    lines.push(`No connections found for: ${componentName}`);
    lines.push('');
    lines.push('All connections:');
    for (const conn of model.connections.slice(0, 10)) {
      const portStr = conn.port ? ` :${conn.port}` : '';
      lines.push(`  ${conn.from} → ${conn.to} (${conn.type}${portStr}) — ${conn.label}`);
    }
  } else {
    lines.push(`## Connections for ${componentName} (${relevantConnections.length})`);
    lines.push('');
    for (const conn of relevantConnections) {
      const portStr = conn.port ? ` :${conn.port}` : '';
      const direction = conn.from === componentName || conn.from.toLowerCase().replace(/\s+/g, '-') === componentName
        ? `→ ${conn.to}`
        : `← ${conn.from}`;
      lines.push(`- ${direction} (${conn.type}${portStr}) — ${conn.label}`);
      if (conn.description) {
        lines.push(`  ${conn.description}`);
      }
    }
  }

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

function basename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

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


/**
 * Knowledge Parser
 *
 * Parses knowledge Markdown documents with YAML frontmatter and numbered parts.
 * Format:
 *   ---
 *   id: K001
 *   title: "..."
 *   type: algorithm
 *   project: /path/to/project
 *   status: active
 *   createdAt: 2024-01-15T10:00:00Z
 *   updatedAt: 2024-01-20T14:30:00Z
 *   ---
 *   # K001: Title
 *   ## K001.1: Part Title
 *   One-liner summary paragraph.
 *
 *   Full content...
 */

import type { Knowledge, KnowledgePart, KnowledgeType } from './types';
import { KNOWLEDGE_TYPES } from './types';

// ─── Frontmatter Parsing ──────────────────────────────────────────────────

interface Frontmatter {
  id: string;
  title: string;
  type: KnowledgeType;
  project: string;
  status: 'active' | 'outdated' | 'archived';
  createdAt: string;
  updatedAt: string;
  sourceSessionId?: string;
  sourceAgentId?: string;
  sourceTimestamp?: string;
  origin?: 'local' | 'remote';
  machineId?: string;
  machineHostname?: string;
  machineOS?: string;
}

function parseFrontmatter(raw: string): Frontmatter | null {
  const lines = raw.split('\n');
  const fm: Record<string, string> = {};

  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      const key = match[1];
      let value = match[2].trim();
      // Strip surrounding quotes and unescape
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      fm[key] = value;
    }
  }

  if (!fm.id || !fm.title) return null;

  return {
    id: fm.id,
    title: fm.title,
    type: KNOWLEDGE_TYPES.includes(fm.type as KnowledgeType) ? fm.type as KnowledgeType : 'algorithm',
    project: fm.project || '',
    status: (['active', 'outdated', 'archived'].includes(fm.status) ? fm.status : 'active') as Frontmatter['status'],
    createdAt: fm.createdAt || new Date().toISOString(),
    updatedAt: fm.updatedAt || new Date().toISOString(),
    sourceSessionId: fm.sourceSessionId || undefined,
    sourceAgentId: fm.sourceAgentId || undefined,
    sourceTimestamp: fm.sourceTimestamp || undefined,
    origin: (fm.origin === 'remote' ? 'remote' : undefined) as Frontmatter['origin'],
    machineId: fm.machineId || undefined,
    machineHostname: fm.machineHostname || undefined,
    machineOS: fm.machineOS || undefined,
  };
}

function renderFrontmatter(k: Knowledge): string {
  const lines = [
    '---',
    `id: ${k.id}`,
    `title: "${k.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    `type: ${k.type}`,
    `project: ${k.project}`,
    `status: ${k.status}`,
    `createdAt: ${k.createdAt}`,
    `updatedAt: ${k.updatedAt}`,
  ];
  if (k.sourceSessionId) lines.push(`sourceSessionId: ${k.sourceSessionId}`);
  if (k.sourceAgentId) lines.push(`sourceAgentId: ${k.sourceAgentId}`);
  if (k.sourceTimestamp) lines.push(`sourceTimestamp: ${k.sourceTimestamp}`);
  if (k.origin === 'remote') lines.push(`origin: remote`);
  if (k.machineId) lines.push(`machineId: ${k.machineId}`);
  if (k.machineHostname) lines.push(`machineHostname: ${k.machineHostname}`);
  if (k.machineOS) lines.push(`machineOS: ${k.machineOS}`);
  lines.push('---');
  return lines.join('\n');
}

// ─── Part Parsing ──────────────────────────────────────────────────

// Matches: ## K001.1: Part Title (also KNEXT.1 for LLM-generated docs before ID allocation)
const PART_HEADING_RE = /^##\s+(K[\w]+\.\d+):\s+(.+)$/;

function parseParts(body: string): KnowledgePart[] {
  const parts: KnowledgePart[] = [];
  const lines = body.split('\n');

  let currentPart: { partId: string; title: string; lines: string[] } | null = null;

  for (const line of lines) {
    const match = line.match(PART_HEADING_RE);
    if (match) {
      // Save previous part
      if (currentPart) {
        parts.push(finalizePart(currentPart));
      }
      currentPart = {
        partId: match[1],
        title: match[2],
        lines: [],
      };
    } else if (currentPart) {
      currentPart.lines.push(line);
    }
    // Lines before any part heading are ignored (they're the main # heading)
  }

  // Save last part
  if (currentPart) {
    parts.push(finalizePart(currentPart));
  }

  return parts;
}

function finalizePart(raw: { partId: string; title: string; lines: string[] }): KnowledgePart {
  // Trim leading/trailing empty lines
  const lines = raw.lines;
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  // First paragraph = summary (up to first empty line)
  let summary = '';
  let contentStart = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      summary = lines.slice(0, i).join('\n').trim();
      contentStart = i + 1;
      break;
    }
  }

  // If no empty line found, entire content is the summary
  if (!summary && lines.length > 0) {
    summary = lines.join('\n').trim();
    contentStart = lines.length;
  }

  const content = lines.slice(contentStart).join('\n').trim();

  return {
    partId: raw.partId,
    title: raw.title,
    summary,
    content,
  };
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Parse a knowledge Markdown document into structured data.
 */
export function parseKnowledgeMd(mdContent: string): Knowledge | null {
  // Split frontmatter and body
  const fmMatch = mdContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = parseFrontmatter(fmMatch[1]);
  if (!frontmatter) return null;

  const body = fmMatch[2];
  const parts = parseParts(body);

  return {
    id: frontmatter.id,
    title: frontmatter.title,
    type: frontmatter.type,
    project: frontmatter.project,
    status: frontmatter.status,
    createdAt: frontmatter.createdAt,
    updatedAt: frontmatter.updatedAt,
    parts,
    sourceSessionId: frontmatter.sourceSessionId,
    sourceAgentId: frontmatter.sourceAgentId,
    sourceTimestamp: frontmatter.sourceTimestamp,
    origin: frontmatter.origin,
    machineId: frontmatter.machineId,
    machineHostname: frontmatter.machineHostname,
    machineOS: frontmatter.machineOS,
  };
}

/**
 * Render a Knowledge object back to Markdown.
 */
export function renderKnowledgeMd(knowledge: Knowledge): string {
  const lines: string[] = [];

  // Frontmatter
  lines.push(renderFrontmatter(knowledge));
  lines.push('');

  // Main heading
  lines.push(`# ${knowledge.id}: ${knowledge.title}`);
  lines.push('');

  // Parts
  for (const part of knowledge.parts) {
    lines.push(`## ${part.partId}: ${part.title}`);
    lines.push(part.summary);
    if (part.content) {
      lines.push('');
      lines.push(part.content);
    }
    lines.push('');
  }

  return lines.join('\n');
}

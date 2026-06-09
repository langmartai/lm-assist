/**
 * Frontmatter parser for memory files
 *
 * This parser is intentionally small -- key: value form only.
 * Handles: name, description, type, originSessionId, category, validity,
 * validationTier, lastValidatedMs, supersededBy.
 */

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** Valid validation-tier values (used by the apply pipeline). */
export type ValidationTier = 'code-confirmed' | 'session-confirmed' | 'asserted' | 'unvalidated';
export const VALIDATION_TIERS: ValidationTier[] = ['code-confirmed', 'session-confirmed', 'asserted', 'unvalidated'];

/** Valid validity values (used by the apply pipeline). */
export type ValidityValue = 'current' | 'stale' | 'outdated' | 'superseded';
export const VALIDITY_VALUES: ValidityValue[] = ['current', 'stale', 'outdated', 'superseded'];

/** Valid category values (must match categorize() in record-extract.ts). */
export const KNOWN_CATEGORIES = ['index', 'endpoint', 'deployment', 'architecture', 'component', 'feature', 'lesson', 'config', 'knowledge'] as const;
export type KnownCategory = typeof KNOWN_CATEGORIES[number];

export interface MemoryFrontmatter {
  name?: string;
  description?: string;
  type?: MemoryType;
  originSessionId?: string;
  /** Validated category -- preferred over rule-based categorize() when present. */
  category?: KnownCategory;
  /** Validity state -- preferred over default current when present. */
  validity?: ValidityValue;
  /** Validation tier -- preferred over default unvalidated when present. */
  validationTier?: ValidationTier;
  /** Unix epoch ms when last validated -- preferred over mtime when present. */
  lastValidatedMs?: number;
  /** RecordId that supersedes this record -- set by the apply pipeline. */
  supersededBy?: string;
  /** Any extra keys the parser found -- kept for forward compatibility */
  extra?: Record<string, string>;
}

export interface ParsedFrontmatter {
  frontmatter: MemoryFrontmatter;
  body: string;
  /** True if a --- fenced block was found and parsed */
  hasFrontmatter: boolean;
}

// known-keys: name|description|type|originSessionId|category|validity|validationTier|lastValidatedMs|supersededBy

/**
 * Parse a memory file frontmatter.
 * Returns body without the frontmatter block.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/\r\n/g, '\n');
  const bom = '﻿';
  const stripped = normalized.startsWith(bom) ? normalized.slice(1) : normalized;
  if (!stripped.startsWith('---\n') && stripped !== '---' && !stripped.startsWith('---\r')) {
    return { frontmatter: {}, body: stripped, hasFrontmatter: false };
  }
  const lines = stripped.split('\n');
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '---\r') { endIndex = i; break; }
  }
  if (endIndex === -1) {
    return { frontmatter: {}, body: stripped, hasFrontmatter: false };
  }
  const fmLines = lines.slice(1, endIndex);
  const bodyLines = lines.slice(endIndex + 1);
  const fm: MemoryFrontmatter = {};
  const extra: Record<string, string> = {};
  for (const rawLine of fmLines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    if (key === 'type') {
      if ((MEMORY_TYPES as string[]).includes(value)) fm.type = value as MemoryType;
    } else if (key === 'name') {
      fm.name = value;
    } else if (key === 'description') {
      fm.description = value;
    } else if (key === 'originSessionId') {
      fm.originSessionId = value;
    } else if (key === 'category') {
      if ((KNOWN_CATEGORIES as readonly string[]).includes(value)) fm.category = value as KnownCategory;
      else extra[key] = value;
    } else if (key === 'validity') {
      if ((VALIDITY_VALUES as string[]).includes(value)) fm.validity = value as ValidityValue;
      else extra[key] = value;
    } else if (key === 'validationTier') {
      if ((VALIDATION_TIERS as string[]).includes(value)) fm.validationTier = value as ValidationTier;
      else extra[key] = value;
    } else if (key === 'lastValidatedMs') {
      const n = parseInt(value, 10);
      if (!isNaN(n) && n > 0) fm.lastValidatedMs = n; else extra[key] = value;
    } else if (key === 'supersededBy') {
      if (value) fm.supersededBy = value;
    } else {
      extra[key] = value;
    }
  }
  if (Object.keys(extra).length > 0) fm.extra = extra;
  return {
    frontmatter: fm,
    body: bodyLines.join('\n').replace(/^\n+/, ''),
    hasFrontmatter: true,
  };
}

/**
 * Serialize a MemoryFrontmatter object back to a YAML frontmatter block.
 * Key order: name, description, type, originSessionId, then validation keys,
 * then extra. Returns the complete file content (frontmatter + body).
 */
export function serializeFrontmatter(fm: MemoryFrontmatter, body: string): string {
  const NL = String.fromCharCode(10);
  const lines: string[] = ['---'];
  if (fm.name !== undefined) lines.push('name: ' + fm.name);
  if (fm.description !== undefined) lines.push('description: ' + fm.description);
  if (fm.type !== undefined) lines.push('type: ' + fm.type);
  if (fm.originSessionId !== undefined) lines.push('originSessionId: ' + fm.originSessionId);
  if (fm.category !== undefined) lines.push('category: ' + fm.category);
  if (fm.validity !== undefined) lines.push('validity: ' + fm.validity);
  if (fm.validationTier !== undefined) lines.push('validationTier: ' + fm.validationTier);
  if (fm.lastValidatedMs !== undefined) lines.push('lastValidatedMs: ' + fm.lastValidatedMs);
  if (fm.supersededBy !== undefined) lines.push('supersededBy: ' + fm.supersededBy);
  if (fm.extra) {
    for (const [k, v] of Object.entries(fm.extra)) lines.push(k + ': ' + v);
  }
  lines.push('---');
  const bodyStr = body.trimStart();
  return lines.join(NL) + NL + (bodyStr ? NL + bodyStr : '');
}

/**
 * Validate that a parsed frontmatter has the required type field.
 */
export function isValidMemoryFrontmatter(fm: MemoryFrontmatter): boolean {
  return !!fm.type && (MEMORY_TYPES as string[]).includes(fm.type);
}
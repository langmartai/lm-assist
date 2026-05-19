/**
 * Frontmatter parser for memory files
 *
 * Memory files in `~/.claude/projects/<slug>/memory/` use a YAML-fenced
 * frontmatter at the top:
 *
 *   ---
 *   name: <title>
 *   description: <one-line hook>
 *   type: user | feedback | project | reference
 *   originSessionId: <optional>
 *   ---
 *   <body markdown>
 *
 * This parser is intentionally small — it handles only the simple
 * `key: value` form used by Claude Code's memory files (matches the
 * `xS6` template in the leaked v2.1.92 bundle, line 4121).
 *
 * Multi-line YAML, nested keys, arrays, anchors etc. are not supported.
 * If the file uses anything more complex, we return `frontmatter: {}`
 * and the full text as `body` — caller can fall back to raw.
 */

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

export interface MemoryFrontmatter {
  name?: string;
  description?: string;
  type?: MemoryType;
  originSessionId?: string;
  /** Any extra keys the parser found — kept for forward compatibility */
  extra?: Record<string, string>;
}

export interface ParsedFrontmatter {
  frontmatter: MemoryFrontmatter;
  body: string;
  /** True if a `---` fenced block was found and parsed */
  hasFrontmatter: boolean;
}

const KNOWN_KEYS = new Set(['name', 'description', 'type', 'originSessionId']);

/**
 * Parse a memory file's frontmatter.
 * Returns body without the frontmatter block.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  // Accept LF and CRLF line endings
  const normalized = content.replace(/\r\n/g, '\n');

  // Frontmatter must start with `---` on its own line (allow a leading BOM)
  const stripped = normalized.startsWith('﻿') ? normalized.slice(1) : normalized;
  if (!stripped.startsWith('---\n') && stripped !== '---' && !stripped.startsWith('---\r')) {
    return { frontmatter: {}, body: stripped, hasFrontmatter: false };
  }

  // Find the closing `---` on its own line
  const lines = stripped.split('\n');
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '---\r') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    // Unterminated frontmatter — treat as no frontmatter
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

    // Strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key === 'type') {
      if ((MEMORY_TYPES as string[]).includes(value)) {
        fm.type = value as MemoryType;
      }
      // Unknown type — drop silently (matches what claude-code does via `c0K`)
    } else if (key === 'name') {
      fm.name = value;
    } else if (key === 'description') {
      fm.description = value;
    } else if (key === 'originSessionId') {
      fm.originSessionId = value;
    } else {
      extra[key] = value;
    }
  }

  if (Object.keys(extra).length > 0) {
    fm.extra = extra;
  }

  return {
    frontmatter: fm,
    body: bodyLines.join('\n').replace(/^\n+/, ''),
    hasFrontmatter: true,
  };
}

/**
 * Validate that a parsed frontmatter has the required type field.
 * Used to filter out malformed files from listings.
 */
export function isValidMemoryFrontmatter(fm: MemoryFrontmatter): boolean {
  return !!fm.type && (MEMORY_TYPES as string[]).includes(fm.type);
}

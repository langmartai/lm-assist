/**
 * Pure helpers for the /mcp-tools page (spec §4.6) — grouping by category,
 * badge derivation, counts, rev-conflict detection, truncation. Mirrors
 * lib/mission-process.ts + its test structure. No IO.
 */
import { describe, it, expect } from 'vitest';
import {
  groupTools,
  toolBadges,
  summarizeCounts,
  revConflictMessage,
  truncateDescription,
  type McpToolRow,
} from '../mcp-tools';

function row(partial: Partial<McpToolRow> & { name: string }): McpToolRow {
  return {
    category: 'core',
    module: 'core/src/mcp-server/tools/expanded.ts',
    scope: 'read',
    protected: false,
    defaultDescription: 'default words',
    effectiveDescription: 'default words',
    enabled: true,
    hasOverride: false,
    ...partial,
  };
}

describe('groupTools', () => {
  const rows = [
    row({ name: 'detail', category: 'core' }),
    row({ name: 'search', category: 'core' }),
    row({ name: 'mission_create', category: 'mission' }),
    row({ name: 'zz-mystery', category: 'other' }),
  ];

  it('groups by category in the server-provided order, tools alphabetical inside', () => {
    const groups = groupTools(rows, ['core', 'mission']);
    expect(groups.map((g) => g.category)).toEqual(['core', 'mission', 'other']);
    expect(groups[0].tools.map((t) => t.name)).toEqual(['detail', 'search']);
  });

  it('puts categories missing from the order (e.g. "other") last', () => {
    const groups = groupTools(rows, ['mission', 'core']);
    expect(groups[groups.length - 1].category).toBe('other');
  });

  it('drops empty categories from the order', () => {
    const groups = groupTools(rows, ['core', 'whatsapp', 'mission']);
    expect(groups.map((g) => g.category)).toEqual(['core', 'mission', 'other']);
  });
});

describe('toolBadges', () => {
  it('scope always present; off/override/protected derived', () => {
    expect(toolBadges(row({ name: 'a', scope: 'admin' }))).toEqual({ scope: 'admin', off: false, override: false, protected: false });
    expect(toolBadges(row({ name: 'b', enabled: false, hasOverride: true, protected: true, scope: 'write' })))
      .toEqual({ scope: 'write', off: true, override: true, protected: true });
  });
});

describe('summarizeCounts', () => {
  it('counts tools, overridden, disabled', () => {
    const rows = [
      row({ name: 'a' }),
      row({ name: 'b', hasOverride: true }),
      row({ name: 'c', enabled: false }),
      row({ name: 'd', hasOverride: true, enabled: false }),
    ];
    expect(summarizeCounts(rows)).toEqual({ tools: 4, overridden: 2, disabled: 2 });
  });
});

describe('revConflictMessage', () => {
  it('no conflict when the fresh doc matches the loaded rev (or nothing stored yet)', () => {
    expect(revConflictMessage(0, null)).toBeNull();
    expect(revConflictMessage(3, { rev: 3 })).toBeNull();
  });
  it('conflict when someone else bumped the rev since load', () => {
    expect(revConflictMessage(3, { rev: 5 })).toMatch(/rev 5/);
    expect(revConflictMessage(0, { rev: 1 })).toMatch(/rev 1/);
  });
});

describe('truncateDescription', () => {
  it('passes short strings through and ellipsizes long ones on the cap', () => {
    expect(truncateDescription('short', 20)).toBe('short');
    const out = truncateDescription('x'.repeat(300), 120);
    expect(out.length).toBe(121); // 120 + ellipsis char
    expect(out.endsWith('…')).toBe(true);
  });
  it('collapses newlines so rows stay one line', () => {
    expect(truncateDescription('a\nb\nc', 50)).toBe('a b c');
  });
});

describe('truncateDescription astral safety', () => {
  it('never splits a surrogate pair at the cut point', () => {
    const out = truncateDescription('🚀'.repeat(80), 99); // odd UTF-16 cut lands mid-pair if sliced naively
    const lone = Array.from(out).filter((ch) => ch.length === 1 && /[\uD800-\uDFFF]/.test(ch));
    expect(lone).toEqual([]);
    expect(out.endsWith('…')).toBe(true);
  });
});

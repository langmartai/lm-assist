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
  sortProfiles,
  activeProfileRow,
  profileDeltaLabel,
  profileUnavailableMessage,
  unmatchedSelectorNote,
  type McpToolRow,
  type McpProfileStatus,
  type McpProfileSummary,
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

// ── tool loading profile ─────────────────────────────────────────────────────
// Shapes taken from a live GET /mcp-tools/profile on this node (dev Core :3200).

function prof(partial: Partial<McpProfileSummary> & { name: string }): McpProfileSummary {
  return { description: 'd', tools: 10, unmatchedSelectors: [], active: false, ...partial };
}

function status(partial: Partial<McpProfileStatus> = {}): McpProfileStatus {
  return {
    active: 'admin',
    setAt: null,
    setBy: null,
    selectors: { categories: ['core', 'session'], plugins: ['ext__langmart'] },
    profiles: [
      prof({ name: 'basic', tools: 42 }),
      prof({ name: 'langmart', tools: 75 }),
      prof({ name: 'extended', tools: 168 }),
      prof({ name: 'admin', tools: 320, active: true }),
    ],
    ...partial,
  };
}

describe('sortProfiles', () => {
  it('orders narrow → wide so the list reads as a cost ladder', () => {
    const out = sortProfiles(status().profiles);
    expect(out.map((p) => p.name)).toEqual(['basic', 'langmart', 'extended', 'admin']);
  });
  it('breaks ties on the name so the order is stable across refreshes', () => {
    const out = sortProfiles([prof({ name: 'zeta', tools: 5 }), prof({ name: 'alpha', tools: 5 })]);
    expect(out.map((p) => p.name)).toEqual(['alpha', 'zeta']);
  });
  it('does not mutate the input', () => {
    const rows = [prof({ name: 'b', tools: 9 }), prof({ name: 'a', tools: 1 })];
    sortProfiles(rows);
    expect(rows.map((p) => p.name)).toEqual(['b', 'a']);
  });
});

describe('activeProfileRow', () => {
  it('returns the row named by status.active', () => {
    expect(activeProfileRow(status())?.name).toBe('admin');
  });
  it('trusts status.active over a stale per-row flag', () => {
    const s = status({ active: 'basic' }); // rows still flag admin as active
    expect(activeProfileRow(s)?.name).toBe('basic');
  });
  it('returns null for an active profile this build does not define, rather than inventing a count', () => {
    expect(activeProfileRow(status({ active: 'from-a-newer-build' }))).toBeNull();
    expect(activeProfileRow(null)).toBeNull();
  });
});

describe('profileDeltaLabel', () => {
  const active = prof({ name: 'admin', tools: 320 });
  it('is empty for the active row itself', () => {
    expect(profileDeltaLabel(active, active)).toBe('');
  });
  it('is empty when the active row is unknown — a delta against a guess reads as measured', () => {
    expect(profileDeltaLabel(null, prof({ name: 'basic', tools: 42 }))).toBe('');
  });
  it('counts down for a narrower profile and up for a wider one', () => {
    expect(profileDeltaLabel(active, prof({ name: 'basic', tools: 42 }))).toBe('278 fewer advertised');
    expect(profileDeltaLabel(prof({ name: 'basic', tools: 42 }), active)).toBe('278 more advertised');
  });
  it('says so when two different profiles resolve to the same size on this node', () => {
    expect(profileDeltaLabel(active, prof({ name: 'other', tools: 320 }))).toBe('same size');
  });
});

describe('unmatchedSelectorNote', () => {
  it('is null when every selector matched', () => {
    expect(unmatchedSelectorNote(prof({ name: 'basic' }))).toBeNull();
  });
  it('names the selectors that matched nothing', () => {
    const note = unmatchedSelectorNote(prof({ name: 'langmart', unmatchedSelectors: ['ext__langmart'] }));
    expect(note).toContain('ext__langmart');
    expect(note).toContain('this selector matches');
  });
  it('pluralises for more than one', () => {
    const note = unmatchedSelectorNote(prof({ name: 'x', unmatchedSelectors: ['ext__a', 'typo'] }));
    expect(note).toContain('ext__a, typo');
    expect(note).toContain('these selectors match');
  });
});

describe('profileUnavailableMessage', () => {
  it('translates the older-Core fall-through, which 404s on a TOOL named "profile"', () => {
    // Verbatim from this box's prod Core (:3100, 0.2.4) on 2026-09-09.
    const raw = 'no advertised tool or registry doc named "profile"';
    const msg = profileUnavailableMessage(raw);
    expect(msg).toContain('predates the profile feature');
    expect(msg).not.toContain('registry doc');
  });
  it('passes any other failure through unchanged, so a real error is not disguised', () => {
    expect(profileUnavailableMessage('ECONNREFUSED')).toBe('Profile unavailable: ECONNREFUSED');
  });
});

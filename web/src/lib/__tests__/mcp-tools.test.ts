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
  CONNECT_STEP,
  applyCreateResult,
  applyDeleteResult,
  connectorActions,
  connectorStateLabel,
  connectorStatusLines,
  createConnectorMessage,
  legacyConnectorLine,
  noHubProfileConnectors,
  normalizeProfileConnectors,
  orderConnectorRows,
  parseProfileConnectors,
  profileConnectorsHubMissing,
  profileConnectorsRouteMissing,
  type ClaudeAiConnectorState,
  type McpToolRow,
  type McpProfileStatus,
  type McpProfileSummary,
  type ProfileConnectorRow,
  type ProfileConnectorsStatus,
  type ProfileConnectorsWire,
  type WireConn,
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
      prof({ name: 'platform', tools: 75 }),
      prof({ name: 'extended', tools: 168 }),
      prof({ name: 'admin', tools: 320, active: true }),
    ],
    ...partial,
  };
}

describe('sortProfiles', () => {
  it('orders narrow → wide so the list reads as a cost ladder', () => {
    const out = sortProfiles(status().profiles);
    expect(out.map((p) => p.name)).toEqual(['basic', 'platform', 'extended', 'admin']);
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
  it('is empty for the node-default row itself', () => {
    expect(profileDeltaLabel(active, active)).toBe('');
  });
  it('is empty when the node default is unknown — a delta against a guess reads as measured', () => {
    expect(profileDeltaLabel(null, prof({ name: 'basic', tools: 42 }))).toBe('');
  });
  it('counts against the NODE DEFAULT — not against any one connector', () => {
    expect(profileDeltaLabel(active, prof({ name: 'basic', tools: 42 }))).toBe('278 fewer than the node default');
    expect(profileDeltaLabel(prof({ name: 'basic', tools: 42 }), active)).toBe('278 more than the node default');
  });
  it('says so when two different profiles resolve to the same size on this node', () => {
    expect(profileDeltaLabel(active, prof({ name: 'other', tools: 320 }))).toBe('same size as the node default');
  });
});

describe('unmatchedSelectorNote', () => {
  it('is null when every selector matched', () => {
    expect(unmatchedSelectorNote(prof({ name: 'basic' }))).toBeNull();
  });
  it('names the selectors that matched nothing', () => {
    const note = unmatchedSelectorNote(prof({ name: 'platform', unmatchedSelectors: ['ext__langmart'] }));
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

// ── one connector per profile ─────────────────────────────────────────────────

/** GET /mcp/profile-connectors → data, copied VERBATIM from the REST task's
 *  core/src/__tests__/profile-connectors-routes.test.ts `WIRE_FIXTURE` (which that suite deep-equals
 *  against the real handler). If the REST shape changes, that fixture changes, and this copy must
 *  change with it — that is the point of copying it. */
const WIRE_FIXTURE: ProfileConnectorsWire = {
  base: 'https://mcp.langmart.ai',
  hub: 'langmart',
  nodeDefault: 'admin',
  claudeai: { ok: true },
  unpinned: {
    url: 'https://mcp.langmart.ai/mcp',
    suggestedName: 'lm-assist langmart',
    connector: { uuid: '8f61a74e-9d48-44b6-9ba0-a8d4873a86c2', name: 'lm-assist langmart', connected: true, authStatus: 'authenticated', toolCount: 320 },
    duplicates: 0,
  },
  profiles: [
    {
      profile: 'basic', url: 'https://mcp.langmart.ai/mcp/basic', suggestedName: 'lm-assist langmart basic',
      connector: { uuid: '3b3b3b3b-0000-4000-8000-00000000000b', name: 'lm-assist langmart basic', connected: false, authStatus: 'auth_required', toolCount: 0 },
      duplicates: 0,
    },
    { profile: 'platform', url: 'https://mcp.langmart.ai/mcp/platform', suggestedName: 'lm-assist langmart platform', connector: null, duplicates: 0 },
    { profile: 'extended', url: 'https://mcp.langmart.ai/mcp/extended', suggestedName: 'lm-assist langmart extended', connector: null, duplicates: 0 },
    { profile: 'admin', url: 'https://mcp.langmart.ai/mcp/admin', suggestedName: 'lm-assist langmart admin', connector: null, duplicates: 0 },
  ],
  unknownPins: [
    {
      profile: 'nextgen', url: 'https://mcp.langmart.ai/mcp/nextgen',
      connector: { uuid: '5d5d5d5d-0000-4000-8000-00000000000d', name: 'from a newer build', connected: true, authStatus: 'authenticated', toolCount: 3 },
    },
  ],
};

describe('normalizeProfileConnectors (the REST wire shape → the table model)', () => {
  it('flattens unpinned + profiles into one row list, unpinned first as profile:null', () => {
    expect(normalizeProfileConnectors(WIRE_FIXTURE)).toEqual({
      base: 'https://mcp.langmart.ai',
      nodeDefault: 'admin',
      claudeaiError: null,
      connectors: [
        { profile: null, url: 'https://mcp.langmart.ai/mcp', name: 'lm-assist langmart',
          claudeai: { uuid: '8f61a74e-9d48-44b6-9ba0-a8d4873a86c2', name: 'lm-assist langmart', connected: true, authStatus: 'authenticated', toolCount: 320 } },
        { profile: 'basic', url: 'https://mcp.langmart.ai/mcp/basic', name: 'lm-assist langmart basic',
          claudeai: { uuid: '3b3b3b3b-0000-4000-8000-00000000000b', name: 'lm-assist langmart basic', connected: false, authStatus: 'auth_required', toolCount: 0 } },
        { profile: 'platform', url: 'https://mcp.langmart.ai/mcp/platform', name: 'lm-assist langmart platform', claudeai: null },
        { profile: 'extended', url: 'https://mcp.langmart.ai/mcp/extended', name: 'lm-assist langmart extended', claudeai: null },
        { profile: 'admin', url: 'https://mcp.langmart.ai/mcp/admin', name: 'lm-assist langmart admin', claudeai: null },
      ],
    });
  });
  it('feeds the helpers the page renders from without a TypeError', () => {
    const s = normalizeProfileConnectors(WIRE_FIXTURE);
    expect(orderConnectorRows(s.connectors, status().profiles).map((r) => r.profile)).toEqual([null, 'basic', 'platform', 'extended', 'admin']);
    expect(connectorStatusLines(s)).toEqual([
      { label: 'Connector', ok: true, detail: 'lm-assist langmart · connected · 320 tools' },
      { label: 'Connector · basic', ok: false, detail: 'lm-assist langmart basic · not connected (auth_required)' },
    ]);
  });
  it('turns claudeai.ok:false into claudeaiError (with a fallback text) — the rows stay, as URLs', () => {
    const down = normalizeProfileConnectors({
      ...WIRE_FIXTURE,
      claudeai: { ok: false, error: 'No claude.ai session configured' },
      unpinned: { ...WIRE_FIXTURE.unpinned, connector: null },
    });
    expect(down.claudeaiError).toBe('No claude.ai session configured');
    expect(down.connectors.map((r) => r.url)).toContain('https://mcp.langmart.ai/mcp/basic');
    expect(normalizeProfileConnectors({ ...WIRE_FIXTURE, claudeai: { ok: false } }).claudeaiError).toBe('claude.ai unreadable');
  });
  it('a null uuid (claude.ai named none) becomes the empty string, never null', () => {
    const s = normalizeProfileConnectors({
      ...WIRE_FIXTURE,
      profiles: [{ ...WIRE_FIXTURE.profiles[0], connector: { ...(WIRE_FIXTURE.profiles[0].connector as WireConn), uuid: null } }],
    });
    expect(s.connectors[1].claudeai?.uuid).toBe('');
  });
});

describe('parseProfileConnectors / profileConnectorsHubMissing / noHubProfileConnectors', () => {
  it('parses the wire body', () => {
    expect(parseProfileConnectors(WIRE_FIXTURE)).toEqual(normalizeProfileConnectors(WIRE_FIXTURE));
  });
  it('throws — with the code in the message — on an error envelope passed through as data', () => {
    const body = { success: false, error: { code: 'HUB_NOT_CONFIGURED', message: 'this node has no hub configured' } };
    expect(() => parseProfileConnectors(body)).toThrow(/HUB_NOT_CONFIGURED/);
    expect(() => parseProfileConnectors(null)).toThrow(/unexpected/);
  });
  it('recognises HUB_NOT_CONFIGURED in the raw error string, which errText would drop', () => {
    expect(profileConnectorsHubMissing(
      'Error: API 400: {"success":false,"error":{"code":"HUB_NOT_CONFIGURED","message":"this node has no hub configured"}}',
    )).toBe(true);
    expect(profileConnectorsHubMissing('this node has no hub configured')).toBe(false);
  });
  it('maps a hub-less node to an empty table that says "no hub"', () => {
    expect(noHubProfileConnectors()).toEqual({ base: null, nodeDefault: '', connectors: [], claudeaiError: null });
    expect(connectorStatusLines(noHubProfileConnectors())[0]).toEqual({
      label: 'Connector', ok: null, detail: 'no hub on this node, so no connector URL',
    });
  });
});

function crow(partial: Partial<ProfileConnectorRow> & { profile: string | null }): ProfileConnectorRow {
  const p = partial.profile;
  return {
    url: p ? `https://mcp.langmart.ai/mcp/${p}` : 'https://mcp.langmart.ai/mcp',
    name: p ? `lm-assist langmart ${p}` : 'lm-assist langmart',
    claudeai: null,
    ...partial,
  };
}
function made(name: string, over: Partial<ClaudeAiConnectorState> = {}): ClaudeAiConnectorState {
  return { uuid: `u-${name}`, name, connected: true, authStatus: 'authenticated', toolCount: 42, ...over };
}
/** A connector as POST /mcp/profile-connectors returns it (uuid may be null). */
function wire(name: string, over: Partial<WireConn> = {}): WireConn {
  return { uuid: `u-${name}`, name, connected: true, authStatus: 'authenticated', toolCount: 42, ...over };
}
function conns(partial: Partial<ProfileConnectorsStatus> = {}): ProfileConnectorsStatus {
  return {
    base: 'https://mcp.langmart.ai',
    nodeDefault: 'admin',
    connectors: [
      crow({ profile: null, claudeai: made('lm-assist langmart', { toolCount: 320 }) }),
      crow({ profile: 'admin' }),
      crow({ profile: 'basic', claudeai: made('lm-assist langmart basic') }),
      crow({ profile: 'extended' }),
      crow({ profile: 'platform' }),
    ],
    claudeaiError: null,
    ...partial,
  };
}

describe('profileConnectorsRouteMissing', () => {
  // An older Core has no /mcp/<x> catch-all, so it answers rest-server's generic 404. The message
  // is verbatim from core/src/rest-server.ts, unchanged from v0.2.0 through v0.2.5.
  it('recognises an older Core\'s generic 404 for the route', () => {
    expect(profileConnectorsRouteMissing('Route not found: GET /mcp/profile-connectors')).toBe(true);
    expect(profileConnectorsRouteMissing(
      'Error: API 404: {"success":false,"error":{"code":"NOT_FOUND","message":"Route not found: GET /mcp/profile-connectors"}}',
    )).toBe(true);
    expect(profileConnectorsRouteMissing('Route not found: DELETE /mcp/profile-connectors/basic')).toBe(true);
  });
  it('does not mistake the route\'s own NOT_FOUND, another missing route, or any other failure, for it', () => {
    expect(profileConnectorsRouteMissing('no claude.ai connector points at https://mcp.langmart.ai/mcp/basic')).toBe(false);
    expect(profileConnectorsRouteMissing('Route not found: GET /mcp-tools/profile')).toBe(false);
    expect(profileConnectorsRouteMissing('Route not found: GET /mcp/profile-connectors-v2')).toBe(false);
    expect(profileConnectorsRouteMissing('no advertised tool or registry doc named "profile"')).toBe(false);
    expect(profileConnectorsRouteMissing('ECONNREFUSED')).toBe(false);
  });
});

describe('orderConnectorRows', () => {
  it('puts the unpinned connector first, then narrow → wide by this node\'s counts', () => {
    const out = orderConnectorRows(conns().connectors, status().profiles);
    expect(out.map((r) => r.profile)).toEqual([null, 'basic', 'platform', 'extended', 'admin']);
  });
  it('sorts profiles with no count last, by name', () => {
    const out = orderConnectorRows([crow({ profile: 'zz-new' }), crow({ profile: 'aa-new' }), crow({ profile: 'basic' })], status().profiles);
    expect(out.map((r) => r.profile)).toEqual(['basic', 'aa-new', 'zz-new']);
  });
  it('does not mutate the input', () => {
    const rows = conns().connectors;
    const before = rows.map((r) => r.profile);
    orderConnectorRows(rows, status().profiles);
    expect(rows.map((r) => r.profile)).toEqual(before);
  });
});

describe('connectorStateLabel', () => {
  it('says "not created" only when claude.ai was actually read', () => {
    expect(connectorStateLabel(crow({ profile: 'basic' }))).toEqual({ text: 'not created', tone: 'none' });
    const unknown = connectorStateLabel(crow({ profile: 'basic' }), 'no claude.ai cookie on this node');
    expect(unknown.tone).toBe('unknown');
    expect(unknown.text).not.toContain('not created');
  });
  it('reports the loaded tool count for a connected connector', () => {
    expect(connectorStateLabel(crow({ profile: 'basic', claudeai: made('x') }))).toEqual({ text: 'connected · 42 tools', tone: 'ok' });
  });
  it('names the Connect step and claude.ai\'s auth status for one not yet connected', () => {
    const s = connectorStateLabel(crow({ profile: 'basic', claudeai: made('x', { connected: false, authStatus: 'auth_required', toolCount: 0 }) }));
    expect(s.tone).toBe('warn');
    expect(s.text).toContain('auth_required');
    expect(s.text).toContain(CONNECT_STEP);
  });
});

describe('connectorActions', () => {
  it('never offers Create or Delete on the unpinned connector', () => {
    expect(connectorActions(crow({ profile: null, claudeai: made('x') }), { busy: null }))
      .toEqual({ create: false, remove: false, disabled: true });
  });
  it('offers Create when missing and Delete when present', () => {
    expect(connectorActions(crow({ profile: 'basic' }), { busy: null })).toEqual({ create: true, remove: false, disabled: false });
    expect(connectorActions(crow({ profile: 'basic', claudeai: made('x') }), { busy: null }))
      .toEqual({ create: false, remove: true, disabled: false });
  });
  it('offers nothing while claude.ai is unreadable — "missing" is then a guess', () => {
    expect(connectorActions(crow({ profile: 'basic' }), { busy: null, claudeaiError: 'no cookie' }))
      .toEqual({ create: false, remove: false, disabled: true });
  });
  it('runs one write at a time (the hub registers each with a read-modify-write)', () => {
    expect(connectorActions(crow({ profile: 'extended' }), { busy: 'basic' }).disabled).toBe(true);
  });
});

describe('createConnectorMessage', () => {
  const base = { profile: 'basic', url: 'https://mcp.langmart.ai/mcp/basic' };
  it('names the one step left after a create', () => {
    const m = createConnectorMessage({
      ...base, created: true, connector: wire('lm-assist langmart basic', { connected: false }),
      nextStep: 'claude.ai → Customize → Connectors → Connect.',
    });
    expect(m).toBe('Created "lm-assist langmart basic" for the basic profile. One step left: claude.ai → Customize → Connectors → Connect.');
  });
  it('says nothing was created when the URL already had a connector (nextStep null when connected)', () => {
    const connected = createConnectorMessage({ ...base, created: false, connector: wire('lm-assist langmart basic'), nextStep: null });
    expect(connected).toContain('already exists');
    expect(connected).toContain('nothing to do');
    expect(createConnectorMessage({ ...base, created: false, connector: wire('n', { connected: false }) })).toContain(CONNECT_STEP);
  });
});

describe('applyCreateResult / applyDeleteResult', () => {
  it('patch only the named row and leave the input alone', () => {
    const s = conns();
    const c = wire('lm-assist langmart extended', { connected: false });
    const after = applyCreateResult(s, { profile: 'extended', url: 'u', created: true, connector: c });
    expect(after.connectors.find((r) => r.profile === 'extended')?.claudeai).toEqual(c);
    expect(s.connectors.find((r) => r.profile === 'extended')?.claudeai).toBeNull();
    const gone = applyDeleteResult(after, 'basic');
    expect(gone.connectors.find((r) => r.profile === 'basic')?.claudeai).toBeNull();
    expect(gone.connectors.find((r) => r.profile === null)?.claudeai?.name).toBe('lm-assist langmart');
  });
  it('a create whose uuid is still unknown (null) patches the row with an empty uuid', () => {
    const after = applyCreateResult(conns(), { profile: 'extended', url: 'u', created: true, connector: wire('x', { uuid: null }) });
    expect(after.connectors.find((r) => r.profile === 'extended')?.claudeai?.uuid).toBe('');
  });
});

describe('connectorStatusLines', () => {
  it('lists every connector that exists — not the first /langmart/i match', () => {
    const lines = connectorStatusLines(conns());
    expect(lines.map((l) => l.label)).toEqual(['Connector', 'Connector · basic']);
    expect(lines[0].detail).toBe('lm-assist langmart · connected · 320 tools');
    expect(lines.every((l) => l.ok === true)).toBe(true);
  });
  it('says claude.ai could not be read instead of claiming there is nothing', () => {
    expect(connectorStatusLines(conns({ claudeaiError: 'no claude.ai cookie on this node' })))
      .toEqual([{ label: 'Connector', ok: false, detail: 'claude.ai unreadable — no claude.ai cookie on this node' }]);
  });
  it('says none exist for this hub when claude.ai has none on its URLs', () => {
    const lines = connectorStatusLines(conns({ connectors: [crow({ profile: null }), crow({ profile: 'basic' })] }));
    expect(lines[0].detail).toContain('none in claude.ai for https://mcp.langmart.ai');
  });
  it('a node with no hub has no URL to match', () => {
    expect(connectorStatusLines(conns({ base: null, connectors: [] }))[0].ok).toBeNull();
  });
});

describe('legacyConnectorLine', () => {
  it('keeps the older-Core pick: first /langmart/i by url or name, else the first server', () => {
    expect(legacyConnectorLine([{ name: 'gh', url: 'https://gh' },
      { name: 'x', url: 'https://mcp.langmart.ai/mcp', connected: true, toolCount: 9 }]).detail).toBe('x · connected · 9 tools');
    expect(legacyConnectorLine([{ name: 'gh', url: 'https://gh', connected: false }]).detail).toBe('gh · disconnected');
    expect(legacyConnectorLine([])).toEqual({ label: 'Connector', ok: false, detail: 'no connector' });
  });
});

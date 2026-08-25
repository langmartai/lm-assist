import { describe, it, expect } from 'vitest';
import {
  namespacedToolName, shortChecksum, capabilitySummary, phaseBadge,
  needsReapproval, enableAction, summarizePluginCounts, trustSource, type PluginView,
} from '../mcp-plugins';

const base: PluginView = {
  name: 'chart-context',
  phase: 'disabled',
  tools: [{ name: 'get_view_context', description: 'ctx' }],
  capabilities: { network: [], fs: ['/a/b.json:ro'], env: ['CHART_VIEW_CONTEXT_PATH'] },
  payloadChecksum: 'sha256:41cec871597eeb348ecc137a8dbb583aa6961f64771d8be89fa4a40830f86dc8',
  pinMatches: false,
  grantedEnv: [],
  health: { failures: 0 },
  manifestErrors: [],
};

describe('namespacedToolName', () => {
  it('matches the loader rule, including hyphenated plugin names', () => {
    expect(namespacedToolName('chart-context', 'get_view_context')).toBe('ext__chart-context__get_view_context');
  });
});

describe('shortChecksum', () => {
  it('shortens a sha256 digest and survives absent values', () => {
    expect(shortChecksum(base.payloadChecksum)).toBe('41cec871597e…');
    expect(shortChecksum(null)).toBe('—');
    expect(shortChecksum(undefined)).toBe('—');
  });
});

describe('capabilitySummary', () => {
  it('never renders blank for a plugin that declared nothing', () => {
    expect(capabilitySummary({ network: [], fs: [], env: [] })).toBe('no declared access');
    expect(capabilitySummary(undefined)).toBe('no declared access');
  });
  it('summarises each declared kind', () => {
    expect(capabilitySummary({ network: ['a.com', 'b.com'], fs: ['/x'], env: ['K'] }))
      .toBe('2 network hosts · 1 fs path · 1 env var');
  });
});

describe('phaseBadge', () => {
  it('explains why a disabled plugin is disabled', () => {
    const b = phaseBadge({ ...base, reason: 'payload checksum changed since approval' });
    expect(b.tone).toBe('grey');
    expect(b.hint).toMatch(/payload checksum changed/);
  });
  it('surfaces the manifest error for an invalid plugin', () => {
    const b = phaseBadge({ ...base, phase: 'invalid', manifestErrors: ['entry.command must be "node"'] });
    expect(b.tone).toBe('red');
    expect(b.hint).toMatch(/entry.command/);
  });
  it('surfaces the last error for an unhealthy plugin', () => {
    const b = phaseBadge({ ...base, phase: 'unhealthy', health: { failures: 3, lastError: 'timeout after 30000ms' } });
    expect(b.tone).toBe('amber');
    expect(b.hint).toMatch(/timeout/);
  });
  it('marks an enabled plugin green', () => {
    expect(phaseBadge({ ...base, phase: 'enabled' }).tone).toBe('green');
  });
});

describe('needsReapproval / enableAction', () => {
  it('detects a payload that moved after approval', () => {
    const drifted = { ...base, approvedChecksum: 'sha256:' + 'a'.repeat(64) };
    expect(needsReapproval(drifted)).toBe(true);
    const action = enableAction(drifted);
    expect(action.canEnable).toBe(true);
    expect(action.label).toMatch(/re-approve/i);
    expect(action.note).toMatch(/changed/);
  });
  it('never offers to enable an invalid plugin', () => {
    const bad = { ...base, phase: 'invalid' as const, manifestErrors: ['bad entry'] };
    expect(enableAction(bad).canEnable).toBe(false);
  });
  it('offers a plain enable for a freshly discovered plugin', () => {
    expect(enableAction(base)).toEqual({ canEnable: true, label: 'Enable plugin' });
  });
  it('does not offer enable for an already-enabled plugin', () => {
    expect(enableAction({ ...base, phase: 'enabled' }).canEnable).toBe(false);
  });
});

describe('summarizePluginCounts', () => {
  it('counts what still needs a human decision', () => {
    const plugins: PluginView[] = [
      { ...base, phase: 'enabled', approvedChecksum: base.payloadChecksum! },
      { ...base, name: 'b', phase: 'disabled' },
      { ...base, name: 'c', phase: 'invalid' },
      { ...base, name: 'd', phase: 'enabled', approvedChecksum: 'sha256:' + 'f'.repeat(64) }, // drifted
    ];
    expect(summarizePluginCounts(plugins)).toEqual({ total: 4, enabled: 2, needsReview: 3 });
  });
});

describe('bundled provenance', () => {
  const base: PluginView = {
    name: 'langmart-design', phase: 'enabled', tools: [],
    capabilities: { network: [], fs: [], env: [] },
    payloadChecksum: 'sha256:aa', pinMatches: true, grantedEnv: [],
    health: { failures: 0 }, manifestErrors: [],
  };

  it('reports package trust for a plugin the build enabled, not owner trust', () => {
    expect(trustSource({ ...base, enabledBy: 'bundled@0.1.0' })).toBe('package');
  });

  it('reports owner trust for a human approval', () => {
    expect(trustSource({ ...base, enabledBy: 'owner@console' })).toBe('owner');
  });

  it('reports no trust source while a plugin is not enabled', () => {
    // A disabled plugin carries a stale enabledBy; the badge must not resurrect it.
    expect(trustSource({ ...base, phase: 'disabled', enabledBy: 'bundled@0.1.0' })).toBe('none');
  });
});

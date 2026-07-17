import { describe, it, expect } from 'vitest';
import { orderRows, groupRows, filterRows, categoryCounts, DEFAULT_CCR_VIEW, type CcrView } from '../ccr-view';
import type { CcrRow } from '@/components/ccr/ccrTypes';

const row = (over: Partial<CcrRow>): CcrRow => ({
  key: over.key || `k:${over.id}`, kind: 'cloud', id: 'x', title: 't', status: {},
  ...over,
} as CcrRow);

const rows: CcrRow[] = [
  row({ key: 'cloud:a', id: 'a', kind: 'cloud', title: 'Alpha', time: '2026-07-17T10:00:00Z', node: null, status: { statusBucket: 'working' } }),
  row({ key: 'cloud:b', id: 'b', kind: 'cloud', title: 'Beta', time: '2026-07-17T12:00:00Z', node: 'gw-117', status: {} }),
  row({ key: 'rc:gw-123:c', id: 'c', kind: 'remote', title: 'Gamma', time: null, node: 'gw-123', status: {} }),
  row({ key: 'local:gw-117:d', id: 'd', kind: 'local', title: 'Delta', time: null, node: 'gw-117', status: { live: true } }),
  row({ key: 'local:gw-117:e', id: 'e', kind: 'local', title: 'Epsilon', time: null, node: 'gw-117', status: { live: false } }),
  row({ key: 'local:gw-123:f', id: 'f', kind: 'local', title: 'Zeta', time: null, node: 'gw-123', status: { live: false } }),
];

const v = (over: Partial<CcrView> = {}): CcrView => ({ ...DEFAULT_CCR_VIEW, ...over });

describe('ordering is deterministic (the anti-reshuffle contract)', () => {
  it('is input-order independent: shuffled input yields the identical order', () => {
    const a = orderRows(rows, v()).map((r) => r.key);
    const b = orderRows([...rows].reverse(), v()).map((r) => r.key);
    expect(a).toEqual(b);
  });

  it('recency desc first, then live-first among timeless ties, then stable key', () => {
    const keys = orderRows(rows, v()).map((r) => r.key);
    expect(keys[0]).toBe('cloud:b');      // newest
    expect(keys[1]).toBe('cloud:a');
    expect(keys[2]).toBe('local:gw-117:d'); // live local beats idle timeless rows
    expect(keys.slice(3)).toEqual(['local:gw-117:e', 'local:gw-123:f', 'rc:gw-123:c']); // key order
  });
});

describe('category is a priority, not a hide', () => {
  it('floats the chosen category to the top and keeps everything visible', () => {
    const keys = orderRows(rows, v({ category: 'local' })).map((r) => r.key);
    expect(keys.slice(0, 3)).toEqual(['local:gw-117:d', 'local:gw-117:e', 'local:gw-123:f']);
    expect(keys).toHaveLength(rows.length);
  });

  it('groupRows renders the chosen category as the first group', () => {
    expect(groupRows(rows, v({ category: 'local' })).map((g) => g.kind)).toEqual(['local', 'cloud', 'remote']);
    expect(groupRows(rows, v()).map((g) => g.kind)).toEqual(['cloud', 'remote', 'local']);
  });
});

describe('node is a filter over node-attributed rows; cloud rows always pass', () => {
  it('keeps only the chosen node + account-wide rows', () => {
    const keys = filterRows(rows, v({ node: 'gw-117' })).map((r) => r.key);
    expect(keys).toContain('cloud:a');          // node:null — account-wide
    expect(keys).toContain('cloud:b');
    expect(keys).toContain('local:gw-117:d');
    expect(keys).not.toContain('local:gw-123:f');
    expect(keys).not.toContain('rc:gw-123:c');
  });

  it("puts the chosen node's own rows first in the flat order", () => {
    const keys = orderRows(rows, v({ node: 'gw-117' })).map((r) => r.key);
    expect(keys[0]).toBe('cloud:b'); // attributed to gw-117
    expect(keys[keys.length - 1]).toBe('cloud:a'); // account-wide row sorts after node-attributed ones
  });

  it('default view shows every machine (nothing node-filtered)', () => {
    expect(filterRows(rows, v())).toHaveLength(rows.length);
  });
});

describe('status hides, counts follow the filters', () => {
  it('status filter hides non-matching rows', () => {
    const out = filterRows(rows, v({ status: 'Working' }));
    expect(out.map((r) => r.key)).toEqual(['cloud:a']);
  });

  it('categoryCounts reflect node+status filtering', () => {
    // gw-123 keeps: cloud:a (account-wide), rc:gw-123:c, local:gw-123:f. cloud:b/d/e are gw-117.
    const c = categoryCounts(rows, v({ node: 'gw-123' }));
    expect(c).toEqual({ all: 3, cloud: 1, remote: 1, local: 1 });
  });
});

describe('cloud stale warning is age-gated (blips invisible)', async () => {
  const { cloudStaleWarning, CLOUD_STALE_WARN_MS } = await import('@/components/ccr/useCcrData');
  const base = { generatedAt: 0, self: 's', cloud: [], nodes: [], unreachable: [], partial: false };
  it('no error → no warning; recent success absorbs the blip', () => {
    expect(cloudStaleWarning({ ...base, cloudError: null }, 1000)).toBeNull();
    expect(cloudStaleWarning({ ...base, cloudError: 'HTTP 401', cloudFetchedAt: 1000 }, 1000 + CLOUD_STALE_WARN_MS - 1)).toBeNull();
  });
  it('genuinely stale → warn with age; never-succeeded → unavailable', () => {
    expect(cloudStaleWarning({ ...base, cloudError: 'HTTP 401', cloudFetchedAt: 0o0 }, 5000)).toMatch(/unavailable/);
    expect(cloudStaleWarning({ ...base, cloudError: 'HTTP 401', cloudFetchedAt: 60_000 }, 60_000 + CLOUD_STALE_WARN_MS + 30_000)).toMatch(/stale \(2m old\)/);
  });
});

describe('name sort', () => {
  it('orders by title with the stable key tiebreak', () => {
    const titles = orderRows(rows, v({ sort: 'name' })).map((r) => r.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  });
});

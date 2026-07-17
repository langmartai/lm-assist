import { describe, it, expect } from 'vitest';
import { buildFleetRows, countRowsByNode, singleNodePayload } from '../ccr-rows';
import type { CcrFleetPayload, CloudSessionInfo } from '@/components/ccr/ccrTypes';

const cloud = (sid: string, over: Partial<CloudSessionInfo> = {}): CloudSessionInfo => ({
  sid, title: `T ${sid}`, model: 'm', repo: null, branch: null, cwd: null, webUrl: `https://claude.ai/code/${sid}`,
  createdAt: '2026-07-17T10:00:00Z', lastEventAt: null, kind: 'cloud', environmentKind: 'cloud',
  connectionStatus: null, statusBucket: null, workerStatus: null, statusCategory: null,
  statusDetail: null, needsAction: null, unread: false, tags: [], ...over,
});

const payload: CcrFleetPayload = {
  generatedAt: 1, self: 'gw-117', unreachable: ['gw-999'], partial: true,
  cloud: [cloud('cse_1'), cloud('cse_exec', { kind: 'remote' })],
  nodes: [
    {
      node: 'gw-117',
      remotes: [{ id: 'ccr-aaaa1111', mode: 'connected', sessionId: 'u-1', webUrl: 'https://claude.ai/code/cse_b' }],
      rc: { controller: { sid: 's-ctl', cse: 'cse_ctl', title: 'Mission Controller' }, executors: [{ sid: 's-ex', cse: 'cse_exec', title: 'Exec One' }], accountRc: [] },
      locals: [
        { sessionId: 'u-1', owner: { cwd: '/home/u/repo-a' }, verdict: { live: true, allowedModes: ['mirror'], connectStrategy: 'attach-existing', safeToCreateTmux: false } },
        { sessionId: 'u-2', jsonl: '/x/u-2.jsonl', verdict: { live: false, allowedModes: ['load'], connectStrategy: 'none', safeToCreateTmux: true } },
      ],
    },
    {
      node: 'gw-123',
      remotes: [],
      rc: { controller: null, executors: [], accountRc: [] },
      locals: [{ sessionId: 'u-3', owner: { cwd: '/home/y/repo-b' } }],
    },
  ],
};

describe('buildFleetRows', () => {
  const rows = buildFleetRows(payload);
  const byKey = new Map(rows.map((r) => [r.key, r]));

  it('tags cloud rows with their RC node when a node claims the cse, else account-wide', () => {
    expect(byKey.get('cloud:cse_1')?.node).toBeNull();
    expect(byKey.get('cloud:cse_exec')?.node).toBe('gw-117'); // executor's cse claimed by gw-117 rc
    expect(byKey.get('cloud:cse_exec')?.title).toBe('Exec One'); // rc title wins over cloud title
  });

  it('emits rc rows (controller not in cloud list) node-scoped, deduped by cse', () => {
    expect(byKey.get('rc:gw-117:cse_ctl')?.kind).toBe('remote');
    expect(rows.filter((r) => r.id === 'cse_exec')).toHaveLength(1); // cloud row won; no rc dup
  });

  it('emits local rows with node-scoped stable keys and bridge attribution', () => {
    expect(byKey.get('local:gw-117:u-1')?.remoteBridge?.id).toBe('ccr-aaaa1111');
    expect(byKey.get('local:gw-117:u-1')?.title).toBe('repo-a');
    expect(byKey.get('local:gw-117:u-2')?.title).toBe('u-2.jsonl');
    expect(byKey.get('local:gw-123:u-3')?.node).toBe('gw-123');
  });

  it('uses the joined session NAME as the title and moves the folder to the repo chip', () => {
    const p = {
      ...payload,
      nodes: [{
        node: 'gw-117', remotes: [], rc: { controller: null, executors: [], accountRc: [] },
        locals: [
          { sessionId: 'u-9', owner: { cwd: '/home/u/lm-assist' }, title: 'Fix the CCR filter flip-flop' },
          { sessionId: 'u-10', owner: { cwd: '/home/u/lm-assist' } }, // no name → folder stays the title
        ],
      }],
    };
    const r = buildFleetRows(p);
    const named = r.find((x) => x.id === 'u-9')!;
    expect(named.title).toBe('Fix the CCR filter flip-flop');
    expect(named.repo).toBe('lm-assist');
    const unnamed = r.find((x) => x.id === 'u-10')!;
    expect(unnamed.title).toBe('lm-assist');
    expect(unnamed.repo).toBeNull();
  });

  it('normalizes an unknown cloud kind to cloud (registry fallback rows)', () => {
    const p = { ...payload, cloud: [cloud('cse_x', { kind: undefined as unknown as 'cloud' })], nodes: [] };
    expect(buildFleetRows(p)[0].kind).toBe('cloud');
  });

  it('countRowsByNode counts node-attributed rows only', () => {
    const counts = countRowsByNode(rows);
    expect(counts.get('gw-117')).toBe(4); // cse_exec(cloud) + cse_ctl(rc) + u-1 + u-2
    expect(counts.get('gw-123')).toBe(1);
  });

  it('singleNodePayload wraps one node for back-compat callers', () => {
    const p = singleNodePayload('gw-a', [], { remotes: [], rc: { controller: null, executors: [], accountRc: [] }, locals: [] });
    expect(p.self).toBe('gw-a');
    expect(buildFleetRows(p)).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { mergeSessionLists, sortByLastModifiedDesc, machinesSignature, applySummaries } from '../session-list';
import type { Machine, Session } from '../types';

const s = (sessionId: string, lastModified: string, extra: Record<string, unknown> = {}) =>
  ({ sessionId, lastModified, ...extra }) as any;

describe('sortByLastModifiedDesc', () => {
  it('orders newest first', () => {
    const out = sortByLastModifiedDesc([
      s('a', '2026-07-01T00:00:00Z'),
      s('b', '2026-07-03T00:00:00Z'),
      s('c', '2026-07-02T00:00:00Z'),
    ]);
    expect(out.map(x => x.sessionId)).toEqual(['b', 'c', 'a']);
  });

  it('sorts in place and returns the same array (matches the existing call sites)', () => {
    const arr = [s('a', '2026-07-01T00:00:00Z'), s('b', '2026-07-02T00:00:00Z')];
    expect(sortByLastModifiedDesc(arr)).toBe(arr);
    expect(arr.map(x => x.sessionId)).toEqual(['b', 'a']);
  });

  it('is stable for equal timestamps — insertion order wins', () => {
    const t = '2026-07-01T00:00:00Z';
    const out = sortByLastModifiedDesc([s('a', t), s('b', t), s('c', t)]);
    expect(out.map(x => x.sessionId)).toEqual(['a', 'b', 'c']);
  });
});

describe('mergeSessionLists', () => {
  it('unions by sessionId and sorts newest first', () => {
    const base = [s('a', '2026-07-05T00:00:00Z'), s('b', '2026-07-04T00:00:00Z')];
    const incoming = [s('c', '2026-07-03T00:00:00Z'), s('d', '2026-07-06T00:00:00Z')];

    expect(mergeSessionLists(base, incoming).map(x => x.sessionId))
      .toEqual(['d', 'a', 'b', 'c']);
  });

  it('lets incoming win on conflict — the fuller fetch is authoritative', () => {
    const base = [s('a', '2026-07-01T00:00:00Z', { numTurns: 1 })];
    const incoming = [s('a', '2026-07-02T00:00:00Z', { numTurns: 9 })];

    const out = mergeSessionLists(base, incoming);
    expect(out).toHaveLength(1);
    expect(out[0].numTurns).toBe(9);
    expect(out[0].lastModified).toBe('2026-07-02T00:00:00Z');
  });

  it('never drops a row that only the fast slice had (no flicker)', () => {
    const base = [s('fast', '2026-07-09T00:00:00Z')];
    const incoming = [s('x', '2026-07-01T00:00:00Z')];

    expect(mergeSessionLists(base, incoming).map(x => x.sessionId))
      .toEqual(['fast', 'x']);
  });

  it('handles empty inputs on either side', () => {
    expect(mergeSessionLists([], [])).toEqual([]);
    expect(mergeSessionLists([], [s('a', '2026-07-01T00:00:00Z')]).map(x => x.sessionId)).toEqual(['a']);
    expect(mergeSessionLists([s('a', '2026-07-01T00:00:00Z')], []).map(x => x.sessionId)).toEqual(['a']);
  });

  it('does not mutate either input', () => {
    const base = [s('a', '2026-07-01T00:00:00Z')];
    const incoming = [s('b', '2026-07-02T00:00:00Z')];
    mergeSessionLists(base, incoming);
    expect(base.map(x => x.sessionId)).toEqual(['a']);
    expect(incoming.map(x => x.sessionId)).toEqual(['b']);
  });

  it('de-duplicates repeats inside the incoming list itself', () => {
    const out = mergeSessionLists([], [
      s('a', '2026-07-01T00:00:00Z', { n: 1 }),
      s('a', '2026-07-02T00:00:00Z', { n: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].n).toBe(2);
  });
});

describe('applySummaries', () => {
  const sess = (id: string, over: Partial<Session> = {}): Session =>
    ({ sessionId: id, lastModified: '2026-07-01T00:00:00Z', ...over }) as Session;

  it('attaches llmSummary and displayName', () => {
    const out = applySummaries(
      [sess('a')],
      new Map([['a', { summary: 'did a thing', displayName: 'Thing' }]]),
    );
    expect(out[0].llmSummary).toBe('did a thing');
    expect(out[0].displayName).toBe('Thing');
  });

  it('never overwrites a user-set customTitle with displayName', () => {
    const out = applySummaries(
      [sess('a', { customTitle: 'My name' })],
      new Map([['a', { summary: 's', displayName: 'Auto' }]]),
    );
    expect(out[0].llmSummary).toBe('s');
    expect(out[0].displayName).toBeUndefined();
  });

  it('does NOT mutate the inputs — the sessions cache holds these objects', () => {
    const original = sess('a');
    const out = applySummaries([original], new Map([['a', { summary: 's' }]]));
    expect(original.llmSummary).toBeUndefined();
    expect(out[0]).not.toBe(original);
    expect(out[0].llmSummary).toBe('s');
  });

  it('returns the SAME array identity when nothing matched (no needless re-render)', () => {
    const list = [sess('a')];
    expect(applySummaries(list, new Map())).toBe(list);
    expect(applySummaries(list, new Map([['other', { summary: 's' }]]))).toBe(list);
  });

  it('leaves unmatched sessions untouched by identity', () => {
    const a = sess('a');
    const b = sess('b');
    const out = applySummaries([a, b], new Map([['a', { summary: 's' }]]));
    expect(out[1]).toBe(b);
    expect(out[0]).not.toBe(a);
  });

  it('is a no-op on an empty list', () => {
    const empty: Session[] = [];
    expect(applySummaries(empty, new Map([['a', { summary: 's' }]]))).toBe(empty);
  });
});

describe('machinesSignature', () => {
  const m = (over: Partial<Machine> = {}): Machine => ({
    id: 'localhost',
    hostname: 'host-a',
    platform: 'linux',
    status: 'online',
    ...over,
  });

  it('ignores lastHeartbeat — getMachines() stamps a fresh one every call', () => {
    expect(machinesSignature([m({ lastHeartbeat: '2026-07-01T00:00:00Z' })]))
      .toBe(machinesSignature([m({ lastHeartbeat: '2026-07-25T12:34:56Z' })]));
  });

  it('changes when a machine goes offline', () => {
    expect(machinesSignature([m({ status: 'online' })]))
      .not.toBe(machinesSignature([m({ status: 'offline' })]));
  });

  it('changes when a machine is added or removed', () => {
    expect(machinesSignature([m()])).not.toBe(machinesSignature([m(), m({ id: 'gw4-2' })]));
    expect(machinesSignature([])).not.toBe(machinesSignature([m()]));
  });

  it('changes when identity fields change', () => {
    const base = machinesSignature([m()]);
    expect(machinesSignature([m({ hostname: 'other' })])).not.toBe(base);
    expect(machinesSignature([m({ id: 'gw4-9' })])).not.toBe(base);
    expect(machinesSignature([m({ platform: 'win32' })])).not.toBe(base);
    expect(machinesSignature([m({ isLocal: true })])).not.toBe(base);
    expect(machinesSignature([m({ localIp: '10.0.1.117' })])).not.toBe(base);
  });

  it('is insensitive to property insertion order', () => {
    const a = { id: 'x', hostname: 'h', platform: 'linux', status: 'online' } as Machine;
    const b = { status: 'online', platform: 'linux', hostname: 'h', id: 'x' } as Machine;
    expect(machinesSignature([a])).toBe(machinesSignature([b]));
  });

  it('is order-sensitive across machines (list order is what consumers render)', () => {
    const x = m({ id: 'x' });
    const y = m({ id: 'y' });
    expect(machinesSignature([x, y])).not.toBe(machinesSignature([y, x]));
  });

  it('reacts to enriched counts so count-only updates still render', () => {
    expect(machinesSignature([m({ sessionCount: 1 })]))
      .not.toBe(machinesSignature([m({ sessionCount: 2 })]));
  });
});

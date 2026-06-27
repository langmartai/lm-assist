import { describe, it, expect } from 'vitest';
import { computeMissionLayout, connectedComponents } from '../mission-layout';

const E = (from: string, to: string, type: 'parent' | 'dependsOn' = 'dependsOn') => ({ from, to, type });

describe('connectedComponents', () => {
  it('splits two disconnected chains and groups singletons separately', () => {
    const comps = connectedComponents(['a', 'b', 'c', 'd', 's1', 's2'], [E('a', 'b'), E('b', 'c')]);
    const sizes = comps.map((c) => c.length).sort();
    expect(sizes).toEqual([1, 1, 1, 3]); // {a,b,c}, {d}, {s1}, {s2}
    expect(comps.find((c) => c.includes('a'))!.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('computeMissionLayout — clusters', () => {
  it('lays two disconnected components into non-overlapping regions', () => {
    const r = computeMissionLayout({
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id })),
      edges: [E('a', 'b'), E('c', 'd')],
      strategy: 'clusters',
    });
    expect(r.positions.size).toBe(4);
    // component {a,b} and {c,d} must not overlap: their x-or-y ranges are disjoint
    const box = (ids: string[]) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const id of ids) { const p = r.positions.get(id)!; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + r.nodeW); y1 = Math.max(y1, p.y + r.nodeH); }
      return { x0, y0, x1, y1 };
    };
    const A = box(['a', 'b']), B = box(['c', 'd']);
    const disjoint = A.x1 <= B.x0 || B.x1 <= A.x0 || A.y1 <= B.y0 || B.y1 <= A.y0;
    expect(disjoint).toBe(true);
  });

  it('packs singletons (no edges) into a sqrt-ish grid block', () => {
    const r = computeMissionLayout({ nodes: ['s1', 's2', 's3', 's4'].map((id) => ({ id })), edges: [], strategy: 'clusters' });
    expect(r.positions.size).toBe(4);
    // 4 singletons → 2 columns → at least 2 distinct x AND 2 distinct y
    const xs = new Set([...r.positions.values()].map((p) => Math.round(p.x)));
    const ys = new Set([...r.positions.values()].map((p) => Math.round(p.y)));
    expect(xs.size).toBeGreaterThanOrEqual(2);
    expect(ys.size).toBeGreaterThanOrEqual(2);
  });

  it('returns empty bounds for empty input', () => {
    const r = computeMissionLayout({ nodes: [], edges: [], strategy: 'clusters' });
    expect(r.width).toBe(0); expect(r.height).toBe(0); expect(r.positions.size).toBe(0);
  });

  it('every edge endpoint has a position', () => {
    const edges = [E('a', 'b'), E('b', 'c')];
    const r = computeMissionLayout({ nodes: ['a', 'b', 'c'].map((id) => ({ id })), edges, strategy: 'clusters' });
    for (const e of edges) { expect(r.positions.has(e.from)).toBe(true); expect(r.positions.has(e.to)).toBe(true); }
  });
});

describe('computeMissionLayout — hubs & focus', () => {
  // star: hub connected to 4 leaves
  const star = { nodes: ['h', 'l1', 'l2', 'l3', 'l4'].map((id) => ({ id })), edges: [E('h', 'l1'), E('h', 'l2'), E('h', 'l3'), E('h', 'l4')] };

  it('hubs: the highest-degree node sits closest to the component centroid', () => {
    const r = computeMissionLayout({ ...star, strategy: 'hubs' });
    const center = (id: string) => { const p = r.positions.get(id)!; return { x: p.x + r.nodeW / 2, y: p.y + r.nodeH / 2 }; };
    const ids = ['h', 'l1', 'l2', 'l3', 'l4'];
    const cx = ids.reduce((s, id) => s + center(id).x, 0) / ids.length;
    const cy = ids.reduce((s, id) => s + center(id).y, 0) / ids.length;
    const dist = (id: string) => { const c = center(id); return Math.hypot(c.x - cx, c.y - cy); };
    const hubDist = dist('h');
    for (const l of ['l1', 'l2', 'l3', 'l4']) expect(hubDist).toBeLessThanOrEqual(dist(l) + 1);
  });

  it('focus: selected node is the centroid of its component; other components are dimmed', () => {
    const two = {
      nodes: ['h', 'l1', 'l2', 'x', 'y'].map((id) => ({ id })),
      edges: [E('h', 'l1'), E('h', 'l2'), E('x', 'y')],
      strategy: 'focus' as const,
      selectedId: 'l1',
    };
    const r = computeMissionLayout(two);
    // l1's component is {h,l1,l2}; x and y are in another component → dimmed
    expect(r.dimmed?.has('x')).toBe(true);
    expect(r.dimmed?.has('y')).toBe(true);
    expect(r.dimmed?.has('l1')).toBe(false);
  });

  it('focus with no selection === clusters (no dimming)', () => {
    const r = computeMissionLayout({ ...star, strategy: 'focus', selectedId: null });
    expect(r.dimmed).toBeUndefined();
  });
});

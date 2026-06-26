'use client';
import Link from 'next/link';
import type { MissionNode } from '@/lib/mission-graph-types';

export function MissionNodeDetail({ node, onClose }: { node: MissionNode | null; onClose: () => void }) {
  if (!node) return null;
  return (
    <div className="w-72 shrink-0 border-l border-neutral-800 p-4 text-sm">
      <div className="mb-2 flex items-start justify-between">
        <h3 className="font-semibold text-neutral-100">{node.title}</h3>
        <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200">✕</button>
      </div>
      <div className="space-y-1 text-neutral-300">
        <div>Status: <span className="text-neutral-100">{node.status}</span></div>
        {node.progressPercent != null && <div>Progress: {node.progressPercent}%</div>}
        {Object.entries(node.tags ?? {}).map(([dim, vals]) => (
          <div key={dim} className="text-xs">{dim}: {vals.join(', ')}</div>
        ))}
      </div>
      <Link href="/missions" className="mt-3 inline-block text-xs text-blue-400 hover:underline">Open in Missions →</Link>
    </div>
  );
}

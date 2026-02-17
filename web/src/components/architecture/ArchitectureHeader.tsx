'use client';

import { Milestone, FolderTree, FileCode, ExternalLink, Layers } from 'lucide-react';
import type { ReactNode } from 'react';

interface Props {
  projectName: string;
  milestoneCount: number;
  componentCount: number;
  keyFileCount: number;
  externalProjectCount?: number;
  resourceCount?: number;
  /** Optional slot rendered next to the project name (e.g., project selector) */
  headerSlot?: ReactNode;
}

export function ArchitectureHeader({ projectName, milestoneCount, componentCount, keyFileCount, externalProjectCount, resourceCount, headerSlot }: Props) {
  const stats = [
    { label: 'Milestones', value: milestoneCount, color: '#fbbf24', icon: Milestone },
    { label: 'Directories', value: componentCount, color: '#60a5fa', icon: FolderTree },
    { label: 'Key Files', value: keyFileCount, color: '#4ade80', icon: FileCode },
    ...(externalProjectCount ? [{ label: 'External', value: externalProjectCount, color: '#a78bfa', icon: ExternalLink }] : []),
    ...(resourceCount ? [{ label: 'Resources', value: resourceCount, color: '#fb923c', icon: Layers }] : []),
  ];

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        {headerSlot || <h2 style={{ fontSize: 16, fontWeight: 600 }}>{projectName}</h2>}
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Architecture</span>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        {stats.map(s => (
          <div key={s.label} style={{
            flex: 1, padding: '10px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-secondary)',
            borderLeft: `3px solid ${s.color}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <s.icon size={12} style={{ color: s.color }} />
              <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {s.label}
              </span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)' }}>
              {s.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

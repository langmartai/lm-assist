'use client';

import type { ArchitectureComponent } from '@/lib/types';
import { typeColors, getDominantType } from './colors';

interface Props {
  component: ArchitectureComponent;
  onClick?: () => void;
}

const TEMP_STYLES: Record<string, { color: string; bg: string; label: string }> = {
  hot: { color: '#f97316', bg: '#f9731615', label: 'Active' },
  warm: { color: '#eab308', bg: '#eab30815', label: 'Idle' },
  cold: { color: '#64748b', bg: '#64748b15', label: 'Undiscovered' },
};

function formatTimeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (isNaN(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

export function ComponentCard({ component, onClick }: Props) {
  const dominant = getDominantType(component.types);
  const dominantColor = typeColors[dominant] || '#94a3b8';
  const total = Object.values(component.types).reduce((a, b) => a + b, 0);
  const temp = component.temperature || (component.milestoneCount > 0 ? 'hot' : 'cold');
  const tempStyle = TEMP_STYLES[temp] || TEMP_STYLES.cold;

  return (
    <div
      className="card"
      onClick={onClick}
      style={{
        padding: 14,
        borderTop: `2px solid ${dominantColor}`,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'transform 0.15s, box-shadow 0.15s',
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.transform = 'scale(1.01)';
          e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
        e.currentTarget.style.boxShadow = '';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {component.directory === '(project root)' ? '(root)' : component.directory}
        </div>
        <span style={{
          fontSize: 9,
          fontWeight: 600,
          padding: '1px 5px',
          borderRadius: 3,
          background: tempStyle.bg,
          color: tempStyle.color,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}>
          {tempStyle.label}{component.lastTouched ? ` — ${formatTimeAgo(component.lastTouched)}` : ''}
        </span>
      </div>
      <div style={{
        fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 8,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {component.purpose}
      </div>

      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
        <span>{component.fileCount} files</span>
        <span>{component.milestoneCount} milestones</span>
      </div>

      {/* Type distribution bar */}
      {total > 0 && (
        <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', gap: 1 }}>
          {Object.entries(component.types)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => (
              <div
                key={type}
                title={`${type}: ${count}`}
                style={{
                  width: `${(count / total) * 100}%`,
                  background: typeColors[type] || '#94a3b8',
                  opacity: 0.8,
                  minWidth: 2,
                }}
              />
            ))}
        </div>
      )}
    </div>
  );
}

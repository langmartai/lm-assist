'use client';

import type { TaskCounts } from '@/lib/types';

interface CrossRefStatsProps {
  projects?: number;
  sessions?: number;
  runningSessions?: number;
  taskCounts?: TaskCounts;
  terminals?: number;
  cost?: number;
  compact?: boolean;
}

export function CrossRefStats({
  projects,
  sessions,
  runningSessions,
  taskCounts,
  terminals,
  cost,
  compact,
}: CrossRefStatsProps) {
  const items: { label: string; value: string; color?: string }[] = [];

  if (projects !== undefined) {
    items.push({ label: 'Projects', value: String(projects) });
  }
  if (sessions !== undefined) {
    const runPart = runningSessions ? ` (${runningSessions} running)` : '';
    items.push({ label: 'Sessions', value: `${sessions}${runPart}` });
  }
  if (taskCounts) {
    items.push({
      label: 'Tasks',
      value: `${taskCounts.pending} pending · ${taskCounts.inProgress} active · ${taskCounts.completed} done`,
    });
  }
  if (terminals !== undefined) {
    items.push({
      label: 'Terminals',
      value: String(terminals),
      color: terminals > 0 ? 'var(--color-status-green)' : undefined,
    });
  }
  if (cost !== undefined) {
    items.push({ label: 'Cost', value: `$${cost.toFixed(2)}` });
  }

  if (compact) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
        {items.map(item => (
          <span key={item.label}>
            <span style={{ color: item.color }}>{item.value}</span>
            {' '}{item.label.toLowerCase()}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      {items.map(item => (
        <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--color-text-tertiary)' }}>{item.label}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: item.color || 'var(--color-text-secondary)' }}>
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

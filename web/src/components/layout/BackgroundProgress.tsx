'use client';

import { useState } from 'react';
import { HardDrive, Layers, BookOpen, Database } from 'lucide-react';
import { useBackgroundProgress, type ProcessStatus } from '@/hooks/useBackgroundProgress';
import { useExperiment } from '@/hooks/useExperiment';

const stateColors: Record<string, string> = {
  idle: 'var(--color-text-tertiary)',
  running: 'var(--color-status-blue)',
  complete: 'var(--color-status-green)',
  error: 'var(--color-status-red)',
};

function ProgressChip({
  status,
  icon: Icon,
}: {
  status: ProcessStatus;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const color = stateColors[status.state];
  const isIdle = status.state === 'idle';

  return (
    <div
      className="bg-progress-chip"
      style={{ opacity: isIdle ? 0.5 : 1, position: 'relative' }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <Icon
        size={11}
        style={{
          color,
          animation: status.state === 'running' ? 'pulse-dot 2s ease-in-out infinite' : undefined,
        }}
      />
      <span className="bg-progress-label">{status.label}</span>
      <div className="bg-progress-track">
        <div
          className="bg-progress-bar"
          style={{
            width: isIdle ? '0%' : `${Math.min(status.percent, 100)}%`,
            background: color,
          }}
        />
      </div>
      {!isIdle && (
        <span className="bg-progress-pct">{status.percent}%</span>
      )}
      {showTooltip && (
        <div className="bg-progress-tooltip">
          <div className="bg-progress-tooltip-title">{status.label}</div>
          <div className="bg-progress-tooltip-desc">{status.description}</div>
          {status.detail && (
            <div className="bg-progress-tooltip-detail">{status.detail}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function BackgroundProgress() {
  const { cacheStatus, milestone, knowledge, vectorStore } = useBackgroundProgress();
  const { isExperiment } = useExperiment();

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <ProgressChip status={cacheStatus} icon={HardDrive} />
      {isExperiment && <ProgressChip status={milestone} icon={Layers} />}
      {isExperiment && <ProgressChip status={vectorStore} icon={Database} />}
      <ProgressChip status={knowledge} icon={BookOpen} />
    </div>
  );
}

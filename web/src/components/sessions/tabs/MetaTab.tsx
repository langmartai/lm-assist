'use client';

import { useState } from 'react';
import {
  Info,
  Copy,
  Check,
  Clock,
  DollarSign,
  Cpu,
  Zap,
  FileCode,
  FolderOpen,
  Hash,
  Shield,
  Globe,
} from 'lucide-react';
import { formatCost } from '@/lib/utils';
import type { SessionDetail } from '@/lib/types';

interface MetaTabProps {
  detail: SessionDetail;
  machineId?: string;
}

export function MetaTab({ detail, machineId }: MetaTabProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = (value: string, field: string) => {
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const sections: {
    title: string;
    icon: typeof Info;
    items: { label: string; value: string; copyable?: boolean; mono?: boolean }[];
  }[] = [
    {
      title: 'Session',
      icon: Hash,
      items: [
        { label: 'Session ID', value: detail.sessionId, copyable: true, mono: true },
        ...(detail.status ? [{ label: 'Status', value: detail.isActive ? 'Active (Running)' : detail.status }] : []),
        ...(detail.lastModified ? [{ label: 'Last Modified', value: new Date(detail.lastModified).toLocaleString() }] : []),
        ...(detail.duration !== undefined ? [{ label: 'Duration', value: formatDuration(detail.duration) }] : []),
        ...(detail.permissionMode ? [{ label: 'Permission Mode', value: detail.permissionMode }] : []),
        ...(detail.claudeCodeVersion ? [{ label: 'Claude Code Version', value: detail.claudeCodeVersion, mono: true }] : []),
      ],
    },
    {
      title: 'Project',
      icon: FolderOpen,
      items: [
        ...(detail.projectPath ? [{ label: 'Project Path', value: detail.projectPath, copyable: true, mono: true }] : []),
        ...(detail.cwd ? [{ label: 'Working Directory', value: detail.cwd, copyable: true, mono: true }] : []),
      ],
    },
    {
      title: 'Model & Cost',
      icon: Cpu,
      items: [
        ...(detail.model ? [{ label: 'Model', value: detail.model, mono: true }] : []),
        ...(detail.totalCostUsd !== undefined && isFinite(detail.totalCostUsd) ? [{ label: 'Total Cost', value: `$${detail.totalCostUsd.toFixed(4)}` }] : []),
        ...(detail.numTurns !== undefined ? [{ label: 'Turns', value: String(detail.numTurns) }] : []),
        ...(detail.messageCount !== undefined ? [{ label: 'Messages', value: String(detail.messageCount) }] : []),
      ],
    },
    {
      title: 'Tokens',
      icon: Zap,
      items: [
        ...(detail.inputTokens !== undefined && isFinite(detail.inputTokens) ? [{ label: 'Input Tokens', value: detail.inputTokens.toLocaleString() }] : []),
        ...(detail.outputTokens !== undefined && isFinite(detail.outputTokens) ? [{ label: 'Output Tokens', value: detail.outputTokens.toLocaleString() }] : []),
        ...(detail.cacheReadInputTokens !== undefined && isFinite(detail.cacheReadInputTokens) ? [{ label: 'Cache Read', value: detail.cacheReadInputTokens.toLocaleString() }] : []),
        ...(detail.cacheCreationInputTokens !== undefined && isFinite(detail.cacheCreationInputTokens) ? [{ label: 'Cache Creation', value: detail.cacheCreationInputTokens.toLocaleString() }] : []),
      ],
    },
  ];

  // Add machine section if we have machineId
  if (machineId) {
    sections.push({
      title: 'Machine',
      icon: Globe,
      items: [
        { label: 'Machine ID', value: machineId, copyable: true, mono: true },
      ],
    });
  }

  // Filter out empty sections
  const nonEmpty = sections.filter(s => s.items.length > 0);

  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%' }} className="scrollbar-thin">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {nonEmpty.map(section => {
          const SectionIcon = section.icon;
          return (
            <div key={section.title}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 10,
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
              }}>
                <SectionIcon size={14} style={{ color: 'var(--color-accent)' }} />
                {section.title}
              </div>

              <div style={{
                display: 'grid',
                gridTemplateColumns: '140px 1fr',
                gap: '6px 16px',
                fontSize: 12,
                padding: '8px 12px',
                background: 'var(--color-bg-surface)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border-default)',
              }}>
                {section.items.map(item => (
                  <MetaRow
                    key={item.label}
                    label={item.label}
                    value={item.value}
                    copyable={item.copyable}
                    mono={item.mono}
                    copied={copiedField === item.label}
                    onCopy={() => handleCopy(item.value, item.label)}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {/* Raw data toggle */}
        <RawJsonSection detail={detail} />
      </div>
    </div>
  );
}

function MetaRow({
  label,
  value,
  copyable,
  mono,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copyable?: boolean;
  mono?: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <>
      <span style={{ color: 'var(--color-text-tertiary)' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)',
          fontSize: mono ? 11 : 12,
          color: 'var(--color-text-secondary)',
          wordBreak: 'break-all',
        }}>
          {value}
        </span>
        {copyable && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={onCopy}
            style={{ padding: 2, minWidth: 0 }}
          >
            {copied ? (
              <Check size={10} style={{ color: 'var(--color-status-green)' }} />
            ) : (
              <Copy size={10} />
            )}
          </button>
        )}
      </div>
    </>
  );
}

function RawJsonSection({ detail }: { detail: SessionDetail }) {
  const [showRaw, setShowRaw] = useState(false);

  // Create a summary object without messages (too large)
  const summary = {
    sessionId: detail.sessionId,
    projectPath: detail.projectPath,
    model: detail.model,
    status: detail.status,
    isActive: detail.isActive,
    numTurns: detail.numTurns,
    messageCount: detail.messageCount,
    totalCostUsd: detail.totalCostUsd,
    inputTokens: detail.inputTokens,
    outputTokens: detail.outputTokens,
    cacheReadInputTokens: detail.cacheReadInputTokens,
    cacheCreationInputTokens: detail.cacheCreationInputTokens,
    duration: detail.duration,
    cwd: detail.cwd,
    claudeCodeVersion: detail.claudeCodeVersion,
    permissionMode: detail.permissionMode,
    lastModified: detail.lastModified,
    lineCount: detail.lineCount,
  };

  return (
    <div>
      <button
        className="btn btn-sm btn-ghost"
        onClick={() => setShowRaw(!showRaw)}
        style={{ gap: 4, fontSize: 11 }}
      >
        <FileCode size={12} />
        {showRaw ? 'Hide' : 'Show'} Raw Metadata
      </button>

      {showRaw && (
        <pre style={{
          marginTop: 8,
          padding: 12,
          background: 'var(--color-bg-surface)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-border-default)',
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-text-secondary)',
          overflow: 'auto',
          maxHeight: 400,
          whiteSpace: 'pre-wrap',
        }}>
          {JSON.stringify(summary, null, 2)}
        </pre>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

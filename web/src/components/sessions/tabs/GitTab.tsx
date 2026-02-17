'use client';

import { useState, useMemo } from 'react';
import {
  GitCommit,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Upload,
  Download,
  Tag,
  Archive,
  Terminal,
  Globe,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { GitOperation, GitOperationType } from '@/lib/types';

interface GitTabProps {
  operations: GitOperation[];
}

const TYPE_CONFIG: Record<GitOperationType, { icon: typeof GitCommit; label: string; color: string }> = {
  commit: { icon: GitCommit, label: 'Commit', color: 'var(--color-status-green)' },
  push: { icon: Upload, label: 'Push', color: 'var(--color-status-blue)' },
  pull: { icon: Download, label: 'Pull', color: 'var(--color-status-cyan)' },
  fetch: { icon: Download, label: 'Fetch', color: 'var(--color-text-tertiary)' },
  merge: { icon: GitMerge, label: 'Merge', color: 'var(--color-status-purple)' },
  branch: { icon: GitBranch, label: 'Branch', color: 'var(--color-status-yellow)' },
  rebase: { icon: GitMerge, label: 'Rebase', color: 'var(--color-status-orange)' },
  tag: { icon: Tag, label: 'Tag', color: 'var(--color-status-cyan)' },
  stash: { icon: Archive, label: 'Stash', color: 'var(--color-text-tertiary)' },
  'gh-cli': { icon: GitPullRequest, label: 'GitHub CLI', color: 'var(--color-status-purple)' },
  remote: { icon: Globe, label: 'Remote', color: 'var(--color-text-tertiary)' },
};

export function GitTab({ operations }: GitTabProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [filterType, setFilterType] = useState<GitOperationType | 'all'>('all');

  const typeCounts = useMemo(() => {
    const counts: Partial<Record<GitOperationType, number>> = {};
    for (const op of operations) {
      counts[op.type] = (counts[op.type] || 0) + 1;
    }
    return counts;
  }, [operations]);

  const filtered = useMemo(() =>
    filterType === 'all' ? operations : operations.filter(op => op.type === filterType),
    [operations, filterType]
  );

  if (operations.length === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <GitCommit size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>No git operations in this session</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Filter bar */}
      <div style={{
        padding: '6px 16px',
        borderBottom: '1px solid var(--color-border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
      }}>
        <button
          className={`btn btn-sm ${filterType === 'all' ? 'btn-secondary' : 'btn-ghost'}`}
          onClick={() => setFilterType('all')}
          style={{ fontSize: 11 }}
        >
          All ({operations.length})
        </button>
        {Object.entries(typeCounts).map(([type, count]) => {
          const cfg = TYPE_CONFIG[type as GitOperationType];
          if (!cfg) return null;
          const Icon = cfg.icon;
          return (
            <button
              key={type}
              className={`btn btn-sm ${filterType === type ? 'btn-secondary' : 'btn-ghost'}`}
              onClick={() => setFilterType(type as GitOperationType)}
              style={{ gap: 4, fontSize: 11 }}
            >
              <Icon size={11} style={{ color: cfg.color }} />
              {cfg.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Operations list */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }} className="scrollbar-thin">
        {filtered.length === 0 && (
          <div className="empty-state" style={{ height: 200 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No matching operations</span>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filtered.map((op, i) => {
            const cfg = TYPE_CONFIG[op.type] || { icon: Terminal, label: op.type, color: 'var(--color-text-tertiary)' };
            const Icon = cfg.icon;
            const isExpanded = expandedIndex === i;

            return (
              <div
                key={`${op.type}-${op.turnIndex ?? i}`}
                style={{
                  borderRadius: 'var(--radius-md)',
                  borderLeft: `2px solid ${cfg.color}`,
                  background: 'var(--color-bg-surface)',
                  overflow: 'hidden',
                }}
              >
                {/* Op header */}
                <div
                  onClick={() => setExpandedIndex(isExpanded ? null : i)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  <Icon size={14} style={{ color: cfg.color, flexShrink: 0 }} />
                  <span className={`badge`} style={{
                    fontSize: 10,
                    background: `${cfg.color}20`,
                    color: cfg.color,
                    border: `1px solid ${cfg.color}40`,
                  }}>
                    {cfg.label}
                  </span>

                  {/* Contextual info */}
                  {op.commitMessage && (
                    <span style={{ color: 'var(--color-text-secondary)', flex: 1 }}>
                      {op.commitMessage.length > 80 ? op.commitMessage.slice(0, 80) + '...' : op.commitMessage}
                    </span>
                  )}
                  {op.branch && !op.commitMessage && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-status-yellow)' }}>
                      {op.branch}
                    </span>
                  )}
                  {op.prNumber && (
                    <span className="badge badge-purple" style={{ fontSize: 10 }}>
                      PR #{op.prNumber}
                    </span>
                  )}
                  {op.remote && !op.commitMessage && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                      {op.remote}
                    </span>
                  )}

                  <div style={{ flex: op.commitMessage ? 0 : 1 }} />

                  {op.turnIndex !== undefined && (
                    <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                      T{op.turnIndex}
                    </span>
                  )}
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </div>

                {/* Expanded: full command */}
                {isExpanded && op.command && (
                  <div style={{
                    padding: '8px 12px 8px 36px',
                    borderTop: '1px solid var(--color-border-default)',
                    background: 'rgba(0,0,0,0.2)',
                  }}>
                    <pre style={{
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-text-secondary)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      margin: 0,
                    }}>
                      $ {op.command}
                    </pre>

                    {/* Extra metadata */}
                    <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 10 }}>
                      {op.branch && (
                        <span style={{ color: 'var(--color-status-yellow)' }}>
                          <GitBranch size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }} />
                          {op.branch}
                        </span>
                      )}
                      {op.remote && (
                        <span style={{ color: 'var(--color-text-tertiary)' }}>
                          remote: {op.remote}
                        </span>
                      )}
                      {op.tag && (
                        <span style={{ color: 'var(--color-status-cyan)' }}>
                          <Tag size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }} />
                          {op.tag}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

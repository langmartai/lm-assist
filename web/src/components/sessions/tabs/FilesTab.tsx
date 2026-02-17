'use client';

import { useState, useMemo } from 'react';
import {
  FileText,
  FilePlus,
  FileEdit,
  Eye,
  Trash2,
  Copy,
  ArrowRight,
  Download,
  Archive,
  Link2,
  Shield,
  FolderOpen,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { FileChange, FileAction } from '@/lib/types';

interface FilesTabProps {
  fileChanges: FileChange[];
}

const ACTION_CONFIG: Record<FileAction, { icon: typeof FileText; label: string; color: string }> = {
  created: { icon: FilePlus, label: 'Created', color: 'var(--color-status-green)' },
  edited: { icon: FileEdit, label: 'Edited', color: 'var(--color-status-blue)' },
  read: { icon: Eye, label: 'Read', color: 'var(--color-text-tertiary)' },
  deleted: { icon: Trash2, label: 'Deleted', color: 'var(--color-status-red)' },
  copied: { icon: Copy, label: 'Copied', color: 'var(--color-status-cyan)' },
  moved: { icon: ArrowRight, label: 'Moved', color: 'var(--color-status-yellow)' },
  downloaded: { icon: Download, label: 'Downloaded', color: 'var(--color-status-purple)' },
  archive: { icon: Archive, label: 'Archived', color: 'var(--color-status-orange)' },
  extract: { icon: FolderOpen, label: 'Extracted', color: 'var(--color-status-orange)' },
  permission: { icon: Shield, label: 'Permission', color: 'var(--color-status-yellow)' },
  link: { icon: Link2, label: 'Linked', color: 'var(--color-status-cyan)' },
  remote: { icon: Download, label: 'Remote', color: 'var(--color-status-purple)' },
};

type GroupMode = 'file' | 'action' | 'timeline';

export function FilesTab({ fileChanges }: FilesTabProps) {
  const [groupMode, setGroupMode] = useState<GroupMode>('file');
  const [showReads, setShowReads] = useState(false);

  const filtered = useMemo(() =>
    showReads ? fileChanges : fileChanges.filter(f => f.action !== 'read'),
    [fileChanges, showReads]
  );

  const grouped = useMemo(() => {
    if (groupMode === 'file') {
      const map = new Map<string, FileChange[]>();
      for (const fc of filtered) {
        const existing = map.get(fc.filePath) || [];
        existing.push(fc);
        map.set(fc.filePath, existing);
      }
      return Array.from(map.entries()).map(([path, changes]) => ({ key: path, label: path, changes }));
    }
    if (groupMode === 'action') {
      const map = new Map<FileAction, FileChange[]>();
      for (const fc of filtered) {
        const existing = map.get(fc.action) || [];
        existing.push(fc);
        map.set(fc.action, existing);
      }
      return Array.from(map.entries()).map(([action, changes]) => ({
        key: action,
        label: ACTION_CONFIG[action]?.label || action,
        changes,
      }));
    }
    // timeline — chronological order by turnIndex
    const sorted = [...filtered].sort((a, b) => (a.turnIndex ?? 0) - (b.turnIndex ?? 0));
    return [{ key: 'all', label: 'All Operations', changes: sorted }];
  }, [filtered, groupMode]);

  // Stats
  const stats = useMemo(() => {
    const counts: Partial<Record<FileAction, number>> = {};
    for (const fc of fileChanges) {
      counts[fc.action] = (counts[fc.action] || 0) + 1;
    }
    return counts;
  }, [fileChanges]);

  if (fileChanges.length === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <FileText size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>No file operations in this session</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Controls */}
      <div style={{
        padding: '6px 16px',
        borderBottom: '1px solid var(--color-border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Group:</span>
        {([
          { id: 'file' as GroupMode, label: 'By File' },
          { id: 'action' as GroupMode, label: 'By Action' },
          { id: 'timeline' as GroupMode, label: 'Timeline' },
        ]).map(g => (
          <button
            key={g.id}
            className={`btn btn-sm ${groupMode === g.id ? 'btn-secondary' : 'btn-ghost'}`}
            onClick={() => setGroupMode(g.id)}
          >
            {g.label}
          </button>
        ))}

        <div style={{ width: 1, height: 16, background: 'var(--color-border-default)' }} />

        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: 'var(--color-text-tertiary)' }}>
          <input
            type="checkbox"
            checked={showReads}
            onChange={e => setShowReads(e.target.checked)}
            style={{ accentColor: 'var(--color-accent)' }}
          />
          Show reads
        </label>

        <div style={{ flex: 1 }} />

        {/* Stats */}
        <div style={{ display: 'flex', gap: 8, fontSize: 10, fontFamily: 'var(--font-mono)' }}>
          {Object.entries(stats).filter(([action]) => action !== 'read' || showReads).map(([action, count]) => {
            const cfg = ACTION_CONFIG[action as FileAction];
            return cfg ? (
              <span key={action} style={{ color: cfg.color }}>{cfg.label}: {count}</span>
            ) : null;
          })}
        </div>
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }} className="scrollbar-thin">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {grouped.map(group => (
            <FileGroup key={group.key} label={group.label} changes={group.changes} groupMode={groupMode} />
          ))}
        </div>
      </div>
    </div>
  );
}

function FileGroup({
  label,
  changes,
  groupMode,
}: {
  label: string;
  changes: FileChange[];
  groupMode: GroupMode;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      {/* Group header (only for grouped modes) */}
      {groupMode !== 'timeline' && (
        <div
          onClick={() => setExpanded(!expanded)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 0',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--color-text-secondary)',
          }}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span style={{ fontFamily: groupMode === 'file' ? 'var(--font-mono)' : 'var(--font-ui)', fontSize: 11 }}>
            {groupMode === 'file' ? shortenPath(label) : label}
          </span>
          <span className="badge badge-default" style={{ fontSize: 9 }}>{changes.length}</span>
        </div>
      )}

      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginLeft: groupMode !== 'timeline' ? 20 : 0 }}>
          {changes.map((fc, i) => {
            const cfg = ACTION_CONFIG[fc.action] || { icon: FileText, label: fc.action, color: 'var(--color-text-tertiary)' };
            const Icon = cfg.icon;
            return (
              <div
                key={`${fc.filePath}-${fc.action}-${fc.turnIndex ?? i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 8px',
                  fontSize: 12,
                  borderRadius: 'var(--radius-sm)',
                  borderLeft: `2px solid ${cfg.color}`,
                  background: 'var(--color-bg-surface)',
                }}
              >
                <Icon size={12} style={{ color: cfg.color, flexShrink: 0 }} />
                {groupMode !== 'file' && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-secondary)', flex: 1 }}>
                    {shortenPath(fc.filePath)}
                  </span>
                )}
                {groupMode === 'file' && (
                  <span style={{ fontSize: 11, color: cfg.color }}>{cfg.label}</span>
                )}
                {fc.turnIndex !== undefined && (
                  <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', marginLeft: 'auto' }}>
                    T{fc.turnIndex}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-3).join('/');
}

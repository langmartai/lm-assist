'use client';

import { useState } from 'react';
import {
  Database,
  ChevronRight,
  ChevronDown,
  Table2,
  Play,
  Plus,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import type { DbOperation } from '@/lib/types';

interface DbTabProps {
  operations: DbOperation[];
}

export function DbTab({ operations }: DbTabProps) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  if (operations.length === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Database size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>No database operations detected</span>
      </div>
    );
  }

  const counts: Record<string, number> = {};
  for (const op of operations) {
    counts[op.type] = (counts[op.type] || 0) + 1;
  }

  const typeColor: Record<string, string> = {
    query: 'var(--color-status-cyan)',
    migrate: 'var(--color-status-purple)',
    create: 'var(--color-status-green)',
    drop: 'var(--color-status-red)',
    seed: 'var(--color-status-yellow)',
    backup: 'var(--color-status-blue)',
  };

  const TypeIcon: Record<string, typeof Play> = {
    query: Play,
    migrate: RotateCcw,
    create: Plus,
    drop: Trash2,
  };

  return (
    <div style={{ padding: 12, overflowY: 'auto', height: '100%' }} className="scrollbar-thin">
      {/* Summary */}
      <div style={{ display: 'flex', gap: 12, fontSize: 11, marginBottom: 12 }}>
        {Object.entries(counts).map(([type, count]) => (
          <span key={type} style={{ color: typeColor[type] || 'var(--color-text-tertiary)' }}>
            {count} {type}{count !== 1 ? 's' : ''}
          </span>
        ))}
      </div>

      {/* Operations list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {operations.map((op, idx) => {
          const isExpanded = expanded[idx];
          const Icon = TypeIcon[op.type] || Database;
          const color = typeColor[op.type] || 'var(--color-text-tertiary)';

          return (
            <div
              key={idx}
              style={{
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border-default)',
                background: 'var(--color-bg-surface)',
                cursor: 'pointer',
              }}
              onClick={() => setExpanded(prev => ({ ...prev, [idx]: !prev[idx] }))}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {isExpanded ? (
                  <ChevronDown size={10} style={{ color: 'var(--color-text-tertiary)' }} />
                ) : (
                  <ChevronRight size={10} style={{ color: 'var(--color-text-tertiary)' }} />
                )}

                {/* Table badge */}
                {op.tables && op.tables.length > 0 ? (
                  <span className="badge" style={{
                    fontSize: 10,
                    background: 'rgba(245,158,11,0.15)',
                    color: 'rgb(245,158,11)',
                    gap: 3,
                  }}>
                    <Table2 size={10} />
                    {op.tables[0]}
                    {op.tables.length > 1 && ` +${op.tables.length - 1}`}
                  </span>
                ) : (
                  <span className="badge badge-default" style={{ fontSize: 10, gap: 3 }}>
                    <Database size={10} />
                    no table
                  </span>
                )}

                {/* Type badge */}
                <span className="badge" style={{
                  fontSize: 10,
                  border: `1px solid ${color}`,
                  color,
                  background: 'transparent',
                  gap: 3,
                }}>
                  <Icon size={10} />
                  {op.type}
                </span>

                {op.tool && (
                  <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>{op.tool}</span>
                )}
              </div>

              {/* Columns */}
              {op.columns && op.columns.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 10, color: 'var(--color-text-tertiary)', marginLeft: 16 }}>
                  <span style={{ opacity: 0.6 }}>cols: </span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{op.columns.join(', ')}</span>
                </div>
              )}

              {/* SQL */}
              {op.sql && (
                isExpanded ? (
                  <pre style={{
                    marginTop: 8,
                    marginLeft: 16,
                    padding: 8,
                    background: 'var(--color-bg-base)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-secondary)',
                    overflow: 'auto',
                    maxHeight: 200,
                    whiteSpace: 'pre-wrap',
                  }}>
                    {op.sql}
                  </pre>
                ) : (
                  <div style={{
                    marginTop: 4,
                    marginLeft: 16,
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-tertiary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {op.sql.length > 80 ? op.sql.slice(0, 80) + '...' : op.sql}
                  </div>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

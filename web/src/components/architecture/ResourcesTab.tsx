'use client';

import { useMemo } from 'react';
import { Database, Terminal, Globe, Container, Server } from 'lucide-react';
import type { ArchitectureResource, ResourceCategory } from '@/lib/types';

interface Props {
  resources: ArchitectureResource[];
}

const CATEGORY_CONFIG: Record<ResourceCategory, { icon: typeof Database; color: string; label: string }> = {
  database: { icon: Database, color: '#22d3ee', label: 'Database' },
  ssh:      { icon: Terminal, color: '#f87171', label: 'SSH' },
  api:      { icon: Globe,    color: '#60a5fa', label: 'API' },
  docker:   { icon: Container, color: '#a78bfa', label: 'Docker' },
  service:  { icon: Server,   color: '#fbbf24', label: 'Service' },
};

const CATEGORY_ORDER: ResourceCategory[] = ['database', 'ssh', 'api', 'docker', 'service'];

export function ResourcesTab({ resources }: Props) {
  const grouped = useMemo(() => {
    const map = new Map<ResourceCategory, ArchitectureResource[]>();
    for (const r of resources) {
      const arr = map.get(r.category) || [];
      arr.push(r);
      map.set(r.category, arr);
    }
    // Sort each group by accessCount desc
    for (const arr of map.values()) {
      arr.sort((a, b) => b.accessCount - a.accessCount);
    }
    return map;
  }, [resources]);

  if (resources.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
        No external resources detected in session commands.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {CATEGORY_ORDER.filter(cat => grouped.has(cat)).map(cat => {
        const config = CATEGORY_CONFIG[cat];
        const items = grouped.get(cat)!;
        const Icon = config.icon;

        return (
          <div key={cat}>
            {/* Category header */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
              paddingBottom: 6, borderBottom: `1px solid ${config.color}33`,
            }}>
              <Icon size={14} style={{ color: config.color }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: config.color, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {config.label}
              </span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                {items.length}
              </span>
            </div>

            {/* Resource cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {items.map(r => (
                <ResourceCard key={r.key} resource={r} categoryColor={config.color} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ResourceCard({ resource: r, categoryColor }: { resource: ArchitectureResource; categoryColor: string }) {
  const scopeColor = r.scope === 'internal' ? '#4ade80' : '#fb923c';

  return (
    <div style={{
      padding: '10px 14px',
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg-secondary)',
      borderLeft: `3px solid ${categoryColor}`,
    }}>
      {/* Top row: name + scope badge + access count */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1 }}>
          {r.name}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px',
          padding: '1px 6px', borderRadius: 'var(--radius-sm)',
          background: `${scopeColor}18`, color: scopeColor,
        }}>
          {r.scope}
        </span>
        <span style={{
          fontSize: 12, fontFamily: 'var(--font-mono)',
          color: 'var(--color-text-tertiary)',
        }}>
          {r.accessCount}x
        </span>
      </div>

      {/* Target (subtle mono) */}
      <div style={{
        fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)',
        marginBottom: r.commands.length > 0 || (r.dbTables && r.dbTables.length > 0) ? 6 : 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {r.target}
      </div>

      {/* Context badge (if present, e.g. "docker exec" or "ssh") */}
      {r.executionContext && (
        <div style={{ marginBottom: 6 }}>
          <span style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 'var(--radius-sm)',
            background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)',
          }}>
            via {r.executionContext}
          </span>
        </div>
      )}

      {/* Commands pills */}
      {r.commands.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: (r.dbTables && r.dbTables.length > 0) ? 6 : 0 }}>
          {r.commands.map(cmd => (
            <span key={cmd} style={{
              fontSize: 10, fontFamily: 'var(--font-mono)',
              padding: '1px 6px', borderRadius: 'var(--radius-sm)',
              background: `${categoryColor}15`, color: categoryColor,
            }}>
              {cmd}
            </span>
          ))}
        </div>
      )}

      {/* DB details: tables and operations */}
      {r.dbTables && r.dbTables.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 4 }}>
            {r.dbTables.slice(0, 20).map(t => (
              <span key={t} style={{
                fontSize: 9, fontFamily: 'var(--font-mono)',
                padding: '1px 5px', borderRadius: 'var(--radius-sm)',
                background: '#22d3ee12', color: '#22d3ee',
              }}>
                {t}
              </span>
            ))}
            {r.dbTables.length > 20 && (
              <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                +{r.dbTables.length - 20} more
              </span>
            )}
          </div>
          {r.dbOperations && r.dbOperations.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {r.dbOperations.map(op => (
                <span key={op} style={{
                  fontSize: 9, fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
                  padding: '1px 5px', borderRadius: 'var(--radius-sm)',
                  background: op === 'drop' || op === 'delete' || op === 'truncate'
                    ? '#f8717112' : '#4ade8012',
                  color: op === 'drop' || op === 'delete' || op === 'truncate'
                    ? '#f87171' : '#4ade80',
                }}>
                  {op}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

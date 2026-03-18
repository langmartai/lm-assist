'use client';

import { useState, useEffect, useMemo } from 'react';
import { Search, ChevronRight, ChevronDown, Loader2, Zap } from 'lucide-react';

interface SkillItem {
  skillName: string;
  pluginName: string;
  shortName: string;
  description: string;
  totalInvocations: number;
  directInvocations: number;
  successCount: number;
  failCount: number;
  lastUsed: string | null;
  firstUsed: string | null;
}

interface SkillListProps {
  apiFetch: <T>(path: string) => Promise<T>;
  selectedSkill: string | null;
  onSelectSkill: (skillName: string) => void;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function SkillList({ apiFetch, selectedSkill, onSelectSkill }: SkillListProps) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<{ skills: SkillItem[]; total: number }>('/skills')
      .then(data => {
        if (!cancelled) {
          setSkills(data.skills || []);
          // Expand all plugins by default
          const plugins = new Set((data.skills || []).map(s => s.pluginName));
          setExpandedPlugins(plugins);
        }
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [apiFetch]);

  const filtered = useMemo(() => {
    if (!searchQuery) return skills;
    const q = searchQuery.toLowerCase();
    return skills.filter(s =>
      s.skillName.toLowerCase().includes(q) ||
      s.shortName.toLowerCase().includes(q) ||
      s.pluginName.toLowerCase().includes(q)
    );
  }, [skills, searchQuery]);

  const grouped = useMemo(() => {
    const map = new Map<string, SkillItem[]>();
    for (const skill of filtered) {
      const list = map.get(skill.pluginName) || [];
      list.push(skill);
      map.set(skill.pluginName, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const togglePlugin = (pluginName: string) => {
    setExpandedPlugins(prev => {
      const next = new Set(prev);
      if (next.has(pluginName)) next.delete(pluginName);
      else next.add(pluginName);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
        <span style={{ fontSize: 12 }}>Loading skills...</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid var(--color-border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <Zap size={14} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Skills</span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 'auto' }}>
          {skills.length}
        </span>
      </div>

      {/* Search */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-default)' }}>
        <div style={{ position: 'relative' }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: 7, color: 'var(--color-text-tertiary)' }} />
          <input
            type="text"
            placeholder="Filter skills..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '5px 8px 5px 26px',
              fontSize: 12,
              border: '1px solid var(--color-border-default)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-bg-surface)',
              color: 'var(--color-text-primary)',
              outline: 'none',
            }}
          />
        </div>
      </div>

      {/* Skill list grouped by plugin */}
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }} className="scrollbar-thin">
        {grouped.length === 0 && (
          <div className="empty-state" style={{ padding: 24 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              {searchQuery ? 'No matching skills' : 'No skills found'}
            </span>
          </div>
        )}

        {grouped.map(([pluginName, pluginSkills]) => {
          const isExpanded = expandedPlugins.has(pluginName);
          const totalCount = pluginSkills.reduce((sum, s) => sum + s.totalInvocations, 0);
          return (
            <div key={pluginName}>
              {/* Plugin header */}
              <div
                onClick={() => togglePlugin(pluginName)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--color-text-secondary)',
                  userSelect: 'none',
                }}
              >
                {isExpanded
                  ? <ChevronDown size={12} />
                  : <ChevronRight size={12} />
                }
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {pluginName}
                </span>
                <span style={{
                  fontSize: 10,
                  color: 'var(--color-text-tertiary)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {pluginSkills.length} / {totalCount}
                </span>
              </div>

              {/* Skill rows */}
              {isExpanded && pluginSkills.map(skill => (
                <div
                  key={skill.skillName}
                  onClick={() => onSelectSkill(skill.skillName)}
                  className={selectedSkill === skill.skillName ? 'active' : ''}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 12px 5px 28px',
                    cursor: 'pointer',
                    fontSize: 12,
                    opacity: skill.totalInvocations === 0 ? 0.5 : 1,
                    background: selectedSkill === skill.skillName ? 'var(--color-bg-active)' : undefined,
                    borderLeft: selectedSkill === skill.skillName ? '2px solid var(--color-accent)' : '2px solid transparent',
                  }}
                >
                  <span style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--color-text-primary)',
                  }}>
                    {skill.shortName}
                  </span>
                  {skill.totalInvocations > 0 && (
                    <span className="badge badge-default" style={{ fontSize: 9, padding: '0 4px' }}>
                      {skill.totalInvocations}
                    </span>
                  )}
                  <span style={{
                    fontSize: 10,
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                    flexShrink: 0,
                  }}>
                    {formatRelativeTime(skill.lastUsed)}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

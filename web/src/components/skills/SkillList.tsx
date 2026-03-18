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
        padding: '10px 14px',
        borderBottom: '1px solid var(--color-border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <Zap size={14} style={{ color: 'var(--color-accent)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>Skills</span>
        <span style={{
          fontSize: 11,
          color: 'var(--color-text-tertiary)',
          fontFamily: 'var(--font-mono)',
          marginLeft: 'auto',
        }}>
          {skills.length}
        </span>
      </div>

      {/* Search */}
      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--color-border-subtle)' }}>
        <div style={{ position: 'relative' }}>
          <Search size={12} style={{
            position: 'absolute',
            left: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--color-text-tertiary)',
            pointerEvents: 'none',
          }} />
          <input
            type="text"
            placeholder="Filter skills..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '6px 10px 6px 28px',
              fontSize: 12,
              border: '1px solid var(--color-border-default)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-bg-root)',
              color: 'var(--color-text-primary)',
              outline: 'none',
              transition: 'border-color 0.15s ease',
            }}
            onFocus={e => { e.target.style.borderColor = 'var(--color-border-focus)'; }}
            onBlur={e => { e.target.style.borderColor = 'var(--color-border-default)'; }}
          />
        </div>
      </div>

      {/* Skill list grouped by plugin */}
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }} className="scrollbar-thin">
        {grouped.length === 0 && (
          <div className="empty-state" style={{ padding: 32 }}>
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
              {/* Plugin group header */}
              <div
                onClick={() => togglePlugin(pluginName)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '7px 14px',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-secondary)',
                  userSelect: 'none',
                  letterSpacing: '0.3px',
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                {isExpanded
                  ? <ChevronDown size={12} style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
                  : <ChevronRight size={12} style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
                }
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {pluginName}
                </span>
                <span style={{
                  fontSize: 10,
                  color: 'var(--color-text-tertiary)',
                  fontFamily: 'var(--font-mono)',
                  flexShrink: 0,
                }}>
                  {pluginSkills.length} &middot; {totalCount}
                </span>
              </div>

              {/* Skill rows */}
              {isExpanded && pluginSkills.map(skill => {
                const isSelected = selectedSkill === skill.skillName;
                const isUnused = skill.totalInvocations === 0;
                return (
                  <div
                    key={skill.skillName}
                    onClick={() => onSelectSkill(skill.skillName)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 14px 6px 32px',
                      cursor: 'pointer',
                      fontSize: 12,
                      opacity: isUnused ? 0.4 : 1,
                      background: isSelected ? 'var(--color-bg-active)' : 'transparent',
                      borderLeft: isSelected ? '2px solid var(--color-accent)' : '2px solid transparent',
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={e => {
                      if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)';
                    }}
                    onMouseLeave={e => {
                      if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent';
                    }}
                  >
                    <span style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: isSelected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                      fontWeight: isSelected ? 500 : 400,
                    }}>
                      {skill.shortName}
                    </span>
                    {skill.totalInvocations > 0 && (
                      <span className="badge badge-amber" style={{ fontSize: 9, padding: '0 5px', lineHeight: '16px' }}>
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
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

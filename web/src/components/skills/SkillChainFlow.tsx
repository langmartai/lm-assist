'use client';

/**
 * SkillChainFlow — Horizontal chain flow visualization.
 *
 * Shows a sequence of skill invocations as connected pills.
 * Used in both the Skills dashboard and the Session Skills tab.
 */

interface SkillInvocation {
  skillName: string;
  shortName: string;
  success?: boolean;
  toolUseCount: number;
}

interface SkillChainFlowProps {
  skills: SkillInvocation[];
}

export function SkillChainFlow({ skills }: SkillChainFlowProps) {
  if (skills.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', textAlign: 'center', padding: 12 }}>
        No skills to display
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      overflow: 'auto',
      padding: '8px 0',
    }} className="scrollbar-thin">
      {skills.map((skill, i) => (
        <span key={`${skill.skillName}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {i > 0 && (
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              {'\u2192'}
            </span>
          )}
          <span
            className="badge"
            style={{
              fontSize: 10,
              padding: '2px 8px',
              background: skill.success === true
                ? 'rgba(34,197,94,0.15)'
                : skill.success === false
                  ? 'rgba(239,68,68,0.15)'
                  : 'var(--color-bg-surface)',
              color: skill.success === true
                ? 'var(--color-status-green)'
                : skill.success === false
                  ? 'var(--color-status-red)'
                  : 'var(--color-text-secondary)',
              border: `1px solid ${
                skill.success === true
                  ? 'rgba(34,197,94,0.3)'
                  : skill.success === false
                    ? 'rgba(239,68,68,0.3)'
                    : 'var(--color-border-default)'
              }`,
              whiteSpace: 'nowrap',
            }}
          >
            {skill.shortName}
            {skill.toolUseCount > 0 && (
              <span style={{ marginLeft: 4, opacity: 0.7, fontSize: 9 }}>
                ({skill.toolUseCount})
              </span>
            )}
          </span>
        </span>
      ))}
    </div>
  );
}

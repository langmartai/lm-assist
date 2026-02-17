'use client';

import type { ArchitectureComponent } from '@/lib/types';
import { ComponentCard } from './ComponentCard';
import { ActivityTreemap } from './ActivityTreemap';

interface Props {
  components: ArchitectureComponent[];
  onSelectDir: (dir: string | null) => void;
}

export function OverviewTab({ components, onSelectDir }: Props) {
  return (
    <div>
      <ActivityTreemap components={components} onSelectDir={onSelectDir} />

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 10,
      }}>
        {components.slice(0, 40).map(comp => (
          <ComponentCard
            key={comp.directory}
            component={comp}
            onClick={comp.directory !== '(project root)' ? () => onSelectDir(comp.directory) : undefined}
          />
        ))}
      </div>
      {components.length > 40 && (
        <div style={{ textAlign: 'center', padding: 12, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Showing top 40 of {components.length} directories. Use the tree to drill down.
        </div>
      )}
    </div>
  );
}

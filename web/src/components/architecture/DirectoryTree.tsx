'use client';

import { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, Folder, ExternalLink } from 'lucide-react';
import type { ArchitectureComponent, ExternalProject } from '@/lib/types';

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  component?: ArchitectureComponent;
  totalMilestones: number;
}

interface Props {
  components: ArchitectureComponent[];
  externalProjects?: ExternalProject[];
  selectedDir: string | null;
  onSelectDir: (dir: string | null) => void;
  onMilestoneClick?: (directory: string) => void;
}

function buildTree(components: ArchitectureComponent[]): TreeNode {
  const root: TreeNode = { name: '(root)', path: '', children: [], totalMilestones: 0 };

  for (const comp of components) {
    if (comp.directory === '(project root)') {
      root.component = comp;
      root.totalMilestones += comp.milestoneCount;
      continue;
    }

    const parts = comp.directory.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const fullPath = parts.slice(0, i + 1).join('/');
      let child = current.children.find(c => c.name === part);
      if (!child) {
        child = { name: part, path: fullPath, children: [], totalMilestones: 0 };
        current.children.push(child);
      }
      current = child;
    }
    current.component = comp;
    current.totalMilestones += comp.milestoneCount;
  }

  // Propagate milestone counts up
  function propagate(node: TreeNode): number {
    let total = node.component?.milestoneCount || 0;
    for (const child of node.children) {
      total += propagate(child);
    }
    node.totalMilestones = total;
    return total;
  }
  propagate(root);

  // Sort children by milestone count descending
  function sortChildren(node: TreeNode) {
    node.children.sort((a, b) => b.totalMilestones - a.totalMilestones);
    for (const child of node.children) sortChildren(child);
  }
  sortChildren(root);

  return root;
}

function TreeNodeItem({
  node, depth, selectedDir, onSelectDir, extPrefix, defaultExpanded, onMilestoneClick
}: {
  node: TreeNode; depth: number;
  selectedDir: string | null; onSelectDir: (dir: string | null) => void;
  extPrefix?: string;          // When set, keys use ext:project/path and accent is purple
  defaultExpanded?: boolean;
  onMilestoneClick?: (directory: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? depth < 1);
  const selectionKey = extPrefix ? `${extPrefix}/${node.path}` : node.path;
  const isSelected = selectedDir === selectionKey;
  const hasChildren = node.children.length > 0;
  const accentColor = extPrefix ? '#a78bfa' : '#60a5fa';

  return (
    <div>
      <div
        onClick={() => {
          if (hasChildren) setExpanded(!expanded);
          onSelectDir(isSelected ? null : selectionKey);
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '3px 6px', paddingLeft: depth * 14 + 6,
          cursor: 'pointer', fontSize: 12,
          borderRadius: 'var(--radius-sm)',
          background: isSelected ? 'var(--color-bg-tertiary)' : 'transparent',
          color: isSelected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
          transition: 'background 0.1s',
        }}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.background = 'var(--color-bg-secondary)';
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.background = 'transparent';
        }}
      >
        {hasChildren ? (
          expanded ? <ChevronDown size={12} style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
                    : <ChevronRight size={12} style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}
        <Folder size={12} style={{ flexShrink: 0, color: isSelected ? accentColor : 'var(--color-text-tertiary)' }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.name}
        </span>
        {node.totalMilestones > 0 && onMilestoneClick ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onMilestoneClick(node.path);
            }}
            style={{
              fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', flexShrink: 0,
              cursor: 'pointer', padding: '0 4px', borderRadius: 'var(--radius-sm)',
              transition: 'background 0.1s, color 0.1s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-accent-glow)';
              e.currentTarget.style.color = 'var(--color-accent)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--color-text-tertiary)';
            }}
            title="Search milestones in this directory"
          >
            {node.totalMilestones}
          </span>
        ) : (
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
            {node.totalMilestones}
          </span>
        )}
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children.map(child => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedDir={selectedDir}
              onSelectDir={onSelectDir}
              extPrefix={extPrefix}
              defaultExpanded={false}
              onMilestoneClick={onMilestoneClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ExternalProjectNode({
  project, selectedDir, onSelectDir, onMilestoneClick
}: {
  project: ExternalProject;
  selectedDir: string | null;
  onSelectDir: (dir: string | null) => void;
  onMilestoneClick?: (directory: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const extKey = `ext:${project.displayName}`;
  const isSelected = selectedDir === extKey;
  const tree = useMemo(() => buildTree(project.components), [project.components]);

  return (
    <div>
      <div
        onClick={() => {
          setExpanded(!expanded);
          onSelectDir(isSelected ? null : extKey);
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '3px 6px',
          cursor: 'pointer', fontSize: 12,
          borderRadius: 'var(--radius-sm)',
          background: isSelected ? 'var(--color-bg-tertiary)' : 'transparent',
          color: isSelected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
          transition: 'background 0.1s',
        }}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.background = 'var(--color-bg-secondary)';
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.background = 'transparent';
        }}
      >
        {expanded
          ? <ChevronDown size={12} style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
          : <ChevronRight size={12} style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
        }
        <ExternalLink size={12} style={{ flexShrink: 0, color: isSelected ? '#a78bfa' : 'var(--color-text-tertiary)' }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
          {project.displayName}
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
          {project.totalMilestones}
        </span>
      </div>
      {expanded && tree.children.length > 0 && (
        <div>
          {tree.children.map(child => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={1}
              extPrefix={extKey}
              selectedDir={selectedDir}
              onSelectDir={onSelectDir}
              defaultExpanded={false}
              onMilestoneClick={onMilestoneClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function DirectoryTree({ components, externalProjects, selectedDir, onSelectDir, onMilestoneClick }: Props) {
  const tree = useMemo(() => buildTree(components), [components]);

  return (
    <div style={{
      width: 240, flexShrink: 0, overflowY: 'auto',
      borderRight: '1px solid var(--color-border-default)',
      paddingRight: 8, paddingTop: 4,
    }} className="scrollbar-thin">
      <div style={{
        fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
        color: 'var(--color-text-tertiary)', letterSpacing: '0.5px',
        padding: '4px 6px', marginBottom: 4,
      }}>
        Directories
      </div>
      <div
        onClick={() => onSelectDir(null)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '3px 6px', cursor: 'pointer', fontSize: 12,
          borderRadius: 'var(--radius-sm)',
          background: selectedDir === null ? 'var(--color-bg-tertiary)' : 'transparent',
          color: selectedDir === null ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
          marginBottom: 2,
        }}
      >
        <Folder size={12} style={{ color: selectedDir === null ? '#60a5fa' : 'var(--color-text-tertiary)' }} />
        <span style={{ flex: 1 }}>All</span>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {tree.totalMilestones}
        </span>
      </div>
      {tree.children.map(child => (
        <TreeNodeItem
          key={child.path}
          node={child}
          depth={0}
          selectedDir={selectedDir}
          onSelectDir={onSelectDir}
          onMilestoneClick={onMilestoneClick}
        />
      ))}

      {externalProjects && externalProjects.length > 0 && (
        <>
          <div style={{
            fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
            color: 'var(--color-text-tertiary)', letterSpacing: '0.5px',
            padding: '4px 6px', marginTop: 14, marginBottom: 4,
            borderTop: '1px solid var(--color-border-default)',
            paddingTop: 10,
          }}>
            External Projects
          </div>
          {externalProjects.map(ext => (
            <ExternalProjectNode
              key={ext.displayName}
              project={ext}
              selectedDir={selectedDir}
              onSelectDir={onSelectDir}
              onMilestoneClick={onMilestoneClick}
            />
          ))}
        </>
      )}
    </div>
  );
}

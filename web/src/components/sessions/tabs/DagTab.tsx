'use client';

import { useState, useEffect, useMemo } from 'react';
import { GitBranch, Network, Layers, RefreshCw, ExternalLink } from 'lucide-react';
import { useSessionDag } from '@/hooks/useSessionDag';
import { DagGraph } from '@/components/dag/DagGraph';
import type { DagNode, DagViewMode, DagGraph as DagGraphType } from '@/components/dag/dag-types';

interface DagTabProps {
  sessionId: string;
  machineId?: string;
}

type SubView = 'session' | 'message' | 'unified';

const SUB_VIEWS: { id: SubView; label: string; icon: typeof Network }[] = [
  { id: 'session', label: 'Session', icon: Network },
  { id: 'message', label: 'Message', icon: GitBranch },
  { id: 'unified', label: 'Unified', icon: Layers },
];

export function DagTab({ sessionId, machineId }: DagTabProps) {
  const [activeView, setActiveView] = useState<SubView>('session');
  const [selectedNode, setSelectedNode] = useState<DagNode | null>(null);
  const [highlightDepth, setHighlightDepth] = useState(1);

  const {
    sessionDag,
    messageDag,
    unifiedDag,
    related,
    loading,
    error,
    fetchSessionDag,
    fetchMessageDag,
    fetchUnifiedDag,
    refetch,
  } = useSessionDag(sessionId);

  // Lazy fetch per view
  useEffect(() => {
    if (activeView === 'session') fetchSessionDag();
    else if (activeView === 'message') fetchMessageDag();
    else if (activeView === 'unified') fetchUnifiedDag();
  }, [activeView, fetchSessionDag, fetchMessageDag, fetchUnifiedDag]);

  // Get the active graph
  const activeGraph = useMemo((): DagGraphType | null => {
    if (activeView === 'session') return sessionDag?.graph ?? null;
    if (activeView === 'message') return messageDag?.graph ?? null;
    if (activeView === 'unified') {
      if (!unifiedDag) return null;
      // Merge sessions + tasks into a single graph
      const nodes = [...unifiedDag.sessions.nodes, ...unifiedDag.tasks.nodes];
      const edges = [...unifiedDag.sessions.edges, ...unifiedDag.tasks.edges];
      // Add cross-links as edges
      for (const link of unifiedDag.crossLinks) {
        const taskNodes = unifiedDag.tasks.nodes.filter(
          n => (n.metadata as any).taskListId === link.taskListId
        );
        if (taskNodes.length > 0) {
          edges.push({
            from: link.sessionId,
            to: taskNodes[0].id,
            type: 'cross_link',
          });
        }
      }
      return {
        nodes,
        edges,
        rootId: unifiedDag.sessions.nodes[0]?.id ?? null,
        stats: {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          maxDepth: 0,
          branchCount: 0,
        },
      };
    }
    return null;
  }, [activeView, sessionDag, messageDag, unifiedDag]);

  // Stats for the active graph
  const stats = activeGraph?.stats;

  const handleNodeClick = (node: DagNode) => {
    setSelectedNode(prev => prev?.id === node.id ? null : node);
  };

  const handleOpenSubagent = (node: DagNode) => {
    const meta = node.metadata;
    const agentId = meta.agentId || meta.sessionId;
    if (!agentId) return;
    const params = new URLSearchParams();
    params.set('session', String(agentId));
    // Forks aren't subagents — don't set parent param for fork nodes
    if (node.type !== 'fork') {
      params.set('parent', sessionId);
    }
    if (machineId) params.set('machine', machineId);
    window.open(`/sessions?${params.toString()}`, '_blank');
  };

  const handleRefresh = () => {
    refetch();
    setSelectedNode(null);
    // Re-trigger fetch for active view
    setTimeout(() => {
      if (activeView === 'session') fetchSessionDag();
      else if (activeView === 'message') fetchMessageDag();
      else if (activeView === 'unified') fetchUnifiedDag();
    }, 50);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Sub-view tabs + stats bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '6px 12px',
        borderBottom: '1px solid var(--color-border-subtle)',
        fontSize: 11,
      }}>
        {/* Sub-view toggles */}
        {SUB_VIEWS.map(v => {
          const Icon = v.icon;
          return (
            <button
              key={v.id}
              onClick={() => { setActiveView(v.id); setSelectedNode(null); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                fontSize: 10,
                borderRadius: 10,
                border: '1px solid',
                borderColor: activeView === v.id ? 'var(--color-accent)' : 'var(--color-border-default)',
                background: activeView === v.id ? 'var(--color-accent-bg)' : 'transparent',
                color: activeView === v.id ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                cursor: 'pointer',
              }}
            >
              <Icon size={10} />
              {v.label}
            </button>
          );
        })}

        {/* Stats */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {stats && (
            <>
              <span>{stats.nodeCount} nodes</span>
              <span>{stats.edgeCount} edges</span>
              {stats.maxDepth > 0 && <span>depth {stats.maxDepth}</span>}
              {stats.branchCount > 0 && <span>{stats.branchCount} branches</span>}
            </>
          )}
          {messageDag?.branches && activeView === 'message' && messageDag.branches.length > 0 && (
            <span>{messageDag.branches.length} forks</span>
          )}
          {sessionDag?.team && activeView === 'session' && (
            <span className="badge badge-purple" style={{ fontSize: 9, padding: '1px 6px' }}>
              {sessionDag.team.name}
            </span>
          )}
        </div>

        {/* Highlight depth */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          padding: '1px 6px',
          borderRadius: 10,
          border: '1px solid var(--color-border-default)',
          fontSize: 9,
          color: 'var(--color-text-secondary)',
          fontFamily: 'var(--font-mono)',
        }}>
          <span>Depth</span>
          {[1, 2, 3, 5].map(d => (
            <button
              key={d}
              onClick={() => setHighlightDepth(d)}
              style={{
                padding: '1px 5px',
                fontSize: 9,
                borderRadius: 6,
                border: 'none',
                background: highlightDepth === d ? 'var(--color-accent)' : 'transparent',
                color: highlightDepth === d ? '#fff' : 'var(--color-text-tertiary)',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {d}
            </button>
          ))}
        </div>

        {/* Refresh */}
        <button
          className="btn btn-sm btn-ghost"
          onClick={handleRefresh}
          title="Refresh FlowGraph"
          style={{ padding: '2px 4px' }}
        >
          <RefreshCw size={10} />
        </button>
      </div>

      {/* Main content area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {/* Graph */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {loading && !activeGraph && (
            <div className="empty-state" style={{ height: '100%' }}>
              <div className="skeleton" style={{ width: 200, height: 20 }} />
              <div className="skeleton" style={{ width: 300, height: 16 }} />
            </div>
          )}

          {error && (
            <div className="empty-state" style={{ height: '100%' }}>
              <span style={{ fontSize: 12, color: 'var(--color-status-red)' }}>Error: {error}</span>
              <button className="btn btn-sm btn-secondary" onClick={handleRefresh}>Retry</button>
            </div>
          )}

          {!loading && !error && !activeGraph && (
            <div className="empty-state" style={{ height: '100%' }}>
              <Network size={28} className="empty-state-icon" />
              <span style={{ fontSize: 13 }}>No FlowGraph data available</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                {activeView === 'session' ? 'Session hierarchy will appear here' :
                 activeView === 'message' ? 'Message flow graph will appear here' :
                 'Combined session + task graph will appear here'}
              </span>
            </div>
          )}

          {activeGraph && (
            <DagGraph
              graph={activeGraph}
              selectedNodeId={selectedNode?.id ?? null}
              highlightDepth={highlightDepth}
              onNodeClick={handleNodeClick}
              onNodeHover={(node) => setSelectedNode(node)}
            />
          )}
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <div style={{
            width: 280,
            borderLeft: '1px solid var(--color-border-default)',
            overflowY: 'auto',
            padding: 12,
            fontSize: 11,
          }} className="scrollbar-thin">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 12 }}>Node Detail</span>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setSelectedNode(null)}
                style={{ marginLeft: 'auto', padding: '1px 4px', fontSize: 10 }}
              >
                ✕
              </button>
            </div>

            {/* Type & ID */}
            <div style={{ marginBottom: 8 }}>
              <span className="badge badge-purple" style={{ fontSize: 9 }}>{selectedNode.type}</span>
              <span style={{
                fontSize: 9,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-tertiary)',
                marginLeft: 6,
              }}>
                {selectedNode.id.slice(0, 20)}
              </span>
            </div>

            {/* Label */}
            <p style={{
              fontSize: 11,
              color: 'var(--color-text-primary)',
              lineHeight: 1.5,
              marginBottom: 10,
              wordBreak: 'break-word',
            }}>
              {selectedNode.label}
            </p>

            {/* Metadata */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: 8,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-bg-base)',
            }}>
              {Object.entries(selectedNode.metadata)
                .filter(([, v]) => v !== undefined && v !== null && v !== '')
                .map(([key, value]) => (
                  <div key={key} style={{ display: 'flex', gap: 6 }}>
                    <span style={{
                      fontSize: 9,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-text-tertiary)',
                      minWidth: 70,
                      flexShrink: 0,
                    }}>
                      {key}
                    </span>
                    <span style={{
                      fontSize: 9,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-text-secondary)',
                      wordBreak: 'break-all',
                    }}>
                      {typeof value === 'string' ? value.slice(0, 100) : String(value)}
                    </span>
                  </div>
                ))
              }
            </div>

            {/* Actions */}
            {(selectedNode.type === 'subagent' || selectedNode.type === 'session' || selectedNode.type === 'teammate' || selectedNode.type === 'fork') && (
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => handleOpenSubagent(selectedNode)}
                style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 4, width: '100%', justifyContent: 'center' }}
              >
                <ExternalLink size={10} />
                Open Session
              </button>
            )}

            {/* Related sessions */}
            {related && activeView === 'session' && (
              <div style={{ marginTop: 12 }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Related</span>
                {related.parent && (
                  <div style={{ marginTop: 4, fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                    Parent: {related.parent.sessionId.slice(0, 8)} ({related.parent.type})
                  </div>
                )}
                {related.children.length > 0 && (
                  <div style={{ marginTop: 4, fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                    Children: {related.children.length}
                  </div>
                )}
                {related.siblings.length > 0 && (
                  <div style={{ marginTop: 4, fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                    Siblings: {related.siblings.length}
                  </div>
                )}
                {related.team && (
                  <div style={{ marginTop: 4, fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                    Team: {related.team.name} ({related.team.members.length} members)
                  </div>
                )}
                {related.forkedFrom && (
                  <div style={{ marginTop: 4, fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                    Forked from: {related.forkedFrom.sessionId.slice(0, 8)}
                  </div>
                )}
                {related.forkChildren && related.forkChildren.length > 0 && (
                  <div style={{ marginTop: 4, fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                    Forks: {related.forkChildren.length}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

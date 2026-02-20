'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useRunningProcesses } from '@/hooks/useRunningProcesses';
import { useSessionEnrichment } from '@/hooks/useSessionEnrichment';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import { usePlatform } from '@/hooks/usePlatform';
import Link from 'next/link';
import {
  Activity,
  RefreshCw,
  ExternalLink,
  Cpu,
  X,
  XCircle,
  MessageSquare,
  User,
  ListChecks,
  Users,
  HardDrive,
  Eye,
  Layers,
  Terminal,
} from 'lucide-react';
import type { ClaudeProcessInfo, ProcessManagedBy, SystemStats } from '@/lib/types';
import type { BatchCheckListSession, IdentifiedProcess } from '@/lib/api-client';

// ============================================================================
// Category metadata
// ============================================================================

interface CategoryMeta {
  label: string;
  badge: string;  // CSS badge class
  color: string;  // CSS color variable
  description: string;
}

const CATEGORY_META: Record<ProcessManagedBy, CategoryMeta> = {
  'ttyd':                { label: 'Managed (ttyd)',       badge: 'badge-green',  color: 'var(--color-status-green)',  description: 'Direct ttyd-managed sessions' },
  'ttyd-tmux':           { label: 'Managed (ttyd+tmux)',  badge: 'badge-blue',   color: 'var(--color-status-blue)',   description: 'Shared tmux sessions via ttyd' },
  'ttyd-shell':          { label: 'Shell Terminals',      badge: 'badge-default',color: 'var(--color-text-tertiary)', description: 'Plain shell terminals (no Claude)' },
  'wrapper':             { label: 'External',             badge: 'badge-default',color: 'var(--color-text-tertiary)', description: 'External Claude instances' },
  'unmanaged-terminal':  { label: 'External Terminal',    badge: 'badge-orange', color: 'var(--color-status-orange)', description: 'Running in an external terminal' },
  'unmanaged-tmux':      { label: 'External Tmux',        badge: 'badge-orange', color: 'var(--color-status-orange)', description: 'Running in an external tmux session' },
  'unknown':             { label: 'Unknown',              badge: 'badge-default',color: 'var(--color-text-tertiary)', description: 'Unclassified Claude processes' },
};

// Display order for categories
const CATEGORY_ORDER: ProcessManagedBy[] = [
  'ttyd', 'ttyd-tmux', 'ttyd-shell', 'unmanaged-tmux', 'wrapper', 'unmanaged-terminal', 'unknown',
];

// ============================================================================
// Helpers
// ============================================================================

function formatUptime(startedAt?: string): string {
  if (!startedAt) return '--';
  const diff = Date.now() - new Date(startedAt).getTime();
  if (diff < 0) return '--';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d${hrs % 24}h`;
}

function formatTimeAgo(isoDate?: string): string {
  if (!isoDate) return '';
  const diff = Date.now() - new Date(isoDate).getTime();
  if (diff < 0) return 'just now';
  const secs = Math.floor(diff / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function formatMemoryMb(kb?: number): string {
  if (kb === undefined || kb === null) return '--';
  const mb = kb / 1024;
  if (mb < 1) return `${kb}K`;
  if (mb < 1024) return `${mb.toFixed(0)}M`;
  return `${(mb / 1024).toFixed(1)}G`;
}

function formatCpu(percent?: number): string {
  if (percent === undefined || percent === null) return '--';
  return `${percent.toFixed(1)}%`;
}

function extractProjectName(path?: string): string {
  if (!path) return '--';
  const parts = path.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || '--';
}

function shortSessionId(sessionId?: string): string {
  if (!sessionId || sessionId === 'unknown' || sessionId === 'chrome-session') return sessionId || '--';
  return sessionId.slice(0, 8);
}

/** Extract pts number from tty string, e.g. "pts/166" → "166" */
function ptsNumber(tty?: string): string | null {
  if (!tty) return null;
  const match = tty.match(/pts\/(\d+)/);
  return match ? match[1] : null;
}

// ============================================================================
// Subcomponents
// ============================================================================

/** CSS class for stat-card top bar based on usage percentage */
function barClass(pct: number): string {
  return pct > 80 ? 'red' : pct > 50 ? 'orange' : 'green';
}

/** Inline color matching the stat-card bar class */
function barColor(pct: number): string {
  return pct > 80 ? 'var(--color-status-red)' : pct > 50 ? 'var(--color-status-orange)' : 'var(--color-status-green)';
}

function SummaryBar({
  totalClaude,
  totalManaged,
  unmanagedCount,
  byCategory,
  stats,
  totalProcessCpu,
  totalProcessMemKb,
}: {
  totalClaude: number;
  totalManaged: number;
  unmanagedCount: number;
  byCategory: Record<string, number>;
  stats?: SystemStats;
  totalProcessCpu: number;
  totalProcessMemKb: number;
}) {
  const detailStyle: React.CSSProperties = {
    fontSize: 9, color: 'var(--color-text-tertiary)', marginTop: 4, whiteSpace: 'nowrap',
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'stretch' }}>
      {/* Process stat cards */}
      <div className="stat-card green" style={{ minWidth: 80 }}>
        <div className="stat-label">Total</div>
        <div className="stat-value" style={{ fontSize: 20 }}>{totalClaude}</div>
      </div>
      <div className="stat-card blue" style={{ minWidth: 80 }}>
        <div className="stat-label">Managed</div>
        <div className="stat-value" style={{ fontSize: 20 }}>{totalManaged}</div>
      </div>
      <div className="stat-card amber" style={{ minWidth: 80 }}>
        <div className="stat-label">Unmanaged</div>
        <div className="stat-value" style={{ fontSize: 20 }}>{unmanagedCount}</div>
      </div>

      {/* CPU stat card */}
      {stats && (
        <div
          className={`stat-card ${barClass(stats.cpuUsagePercent)}`}
          style={{ minWidth: 100 }}
          title={`CPU: ${stats.cpuUsagePercent}% · load ${stats.loadAvg1} · ${stats.cpuCount} cores\nClaude: ${totalProcessCpu.toFixed(1)}%`}
        >
          <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <Cpu size={10} /> CPU
          </div>
          <div className="stat-value" style={{ fontSize: 20 }}>{stats.cpuUsagePercent}%</div>
          <div style={detailStyle}>{stats.cpuCount} cores · claude {totalProcessCpu.toFixed(0)}%</div>
        </div>
      )}

      {/* Memory stat card */}
      {stats && (
        <div
          className={`stat-card ${barClass(stats.memoryUsagePercent)}`}
          style={{ minWidth: 100 }}
          title={`Memory: ${stats.memoryUsagePercent}% · ${(stats.usedMemoryMb / 1024).toFixed(1)}G / ${(stats.totalMemoryMb / 1024).toFixed(1)}G\nClaude: ${formatMemoryMb(totalProcessMemKb)}`}
        >
          <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <HardDrive size={10} /> Mem
          </div>
          <div className="stat-value" style={{ fontSize: 20 }}>{stats.memoryUsagePercent}%</div>
          <div style={detailStyle}>{(stats.usedMemoryMb / 1024).toFixed(0)}G / {(stats.totalMemoryMb / 1024).toFixed(0)}G · claude {formatMemoryMb(totalProcessMemKb)}</div>
        </div>
      )}

      {/* Disk stat card */}
      {stats && stats.totalDiskGb > 0 && (
        <div
          className={`stat-card ${barClass(stats.diskUsagePercent)}`}
          style={{ minWidth: 100 }}
          title={`Disk: ${stats.diskUsagePercent}% · ${stats.usedDiskGb}G / ${stats.totalDiskGb}G\nFree: ${stats.freeDiskGb}G`}
        >
          <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <HardDrive size={10} /> Disk
          </div>
          <div className="stat-value" style={{ fontSize: 20 }}>{stats.diskUsagePercent}%</div>
          <div style={detailStyle}>{stats.usedDiskGb}G / {stats.totalDiskGb}G · {stats.freeDiskGb}G free</div>
        </div>
      )}

    </div>
  );
}

/** Inline icon stat */
function IconStat({ icon, value, title }: { icon: React.ReactNode; value: string | number; title: string }) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        fontSize: 10,
        color: 'var(--color-text-tertiary)',
        whiteSpace: 'nowrap',
      }}
    >
      {icon}
      <span style={{ fontFamily: 'var(--font-mono)' }}>{value}</span>
    </span>
  );
}

function ProcessRow({
  process,
  enrichment,
  identify,
  onConnect,
  onConnectTmux,
  onKill,
  killing,
  isSingleMachine,
}: {
  process: ClaudeProcessInfo;
  enrichment?: BatchCheckListSession;
  identify?: IdentifiedProcess;
  onConnect?: (process: ClaudeProcessInfo) => void;
  onConnectTmux?: (process: ClaudeProcessInfo) => void;
  onKill?: (process: ClaudeProcessInfo) => void;
  killing?: boolean;
  isSingleMachine: boolean;
}) {
  const { isLocal, proxy } = useAppMode();
  const hasValidSession = !!process.sessionId && process.sessionId !== 'unknown' && process.sessionId !== 'chrome-session';
  const isConnectable = hasValidSession && (process.managedBy === 'ttyd' || process.managedBy === 'ttyd-tmux');
  const hasExternalTtyd = process.hasAttachedTtyd && process.externalTtydPort;
  const isLinkable = hasValidSession;
  const pts = ptsNumber(process.tty);

  return (
    <div
      style={{
        borderBottom: '1px solid var(--color-border-subtle)',
        opacity: killing ? 0.5 : 1,
      }}
    >
      {/* Main row: PID, session, project, uptime, pts, machine, actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 12px 2px 12px',
          fontSize: 12,
        }}
      >
        {/* PID */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text-secondary)',
            minWidth: 64,
          }}
        >
          PID {process.pid}
        </span>

        {/* Role badge (from identify) */}
        {identify?.role && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '0 5px',
              borderRadius: 3,
              fontSize: 9,
              fontWeight: 500,
              lineHeight: '16px',
              whiteSpace: 'nowrap',
              ...(identify.role === 'original' ? {
                background: 'rgba(34,197,94,0.15)',
                color: '#22c55e',
                border: '1px solid rgba(34,197,94,0.3)',
              } : identify.role === 'console-tab' ? {
                background: 'rgba(245,158,11,0.15)',
                color: '#f59e0b',
                border: '1px solid rgba(245,158,11,0.3)',
              } : identify.role === 'resumed' ? {
                background: 'rgba(59,130,246,0.15)',
                color: '#3b82f6',
                border: '1px solid rgba(59,130,246,0.3)',
              } : {
                background: 'rgba(148,163,184,0.15)',
                color: '#94a3b8',
                border: '1px solid rgba(148,163,184,0.3)',
              }),
            }}
          >
            {identify.role}
          </span>
        )}

        {/* Screen turn indicator (from identify) */}
        {identify?.screenTurn && identify.screenTurn.lastReadTurnIndex !== null && (() => {
          const lastTurn = identify.sessionStats?.lastTurnIndex ?? identify.screenTurn!.lastReadTurnIndex!;
          const readTurn = identify.screenTurn!.lastReadTurnIndex!;
          const isLive = readTurn >= lastTurn;
          const pct = lastTurn > 0 ? Math.min(100, (readTurn / lastTurn) * 100) : 100;
          const gap = lastTurn - readTurn;
          return (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              title={identify.screenTurn!.matchedText ? identify.screenTurn!.matchedText.slice(0, 200) : undefined}
            >
              {/* Progress bar */}
              <span style={{
                position: 'relative',
                width: 48,
                height: 5,
                borderRadius: 3,
                background: 'rgba(148,163,184,0.2)',
                overflow: 'hidden',
              }}>
                <span style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  height: '100%',
                  width: `${pct}%`,
                  borderRadius: 3,
                  background: isLive ? '#22c55e' : '#f59e0b',
                  transition: 'width 0.3s',
                }} />
              </span>
              {/* Turn label */}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                T{readTurn}/{lastTurn}
              </span>
              {/* Live/Stale badge */}
              <span
                style={{
                  fontSize: 8,
                  fontWeight: 600,
                  padding: '0 3px',
                  borderRadius: 2,
                  lineHeight: '14px',
                  ...(isLive ? {
                    background: 'rgba(34,197,94,0.15)',
                    color: '#22c55e',
                    border: '1px solid rgba(34,197,94,0.3)',
                  } : {
                    background: 'rgba(245,158,11,0.15)',
                    color: '#f59e0b',
                    border: '1px solid rgba(245,158,11,0.3)',
                  }),
                }}
              >
                {isLive ? 'Live' : `Stale -${gap}`}
              </span>
            </span>
          );
        })()}

        {/* Session ID */}
        <span style={{ minWidth: 72, fontFamily: 'var(--font-mono)' }}>
          {isLinkable ? (
            <Link
              href={`/sessions?session=${process.sessionId}${!isLocal && process.machineId ? `&machine=${process.machineId}` : ''}`}
              target="_blank"
              style={{ color: 'var(--color-accent)', textDecoration: 'none' }}
            >
              {shortSessionId(process.sessionId)}
            </Link>
          ) : (
            <span style={{ color: 'var(--color-text-tertiary)' }}>--</span>
          )}
        </span>

        {/* Project */}
        <span
          style={{
            minWidth: 80,
            maxWidth: 140,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--color-text-secondary)',
          }}
          title={process.projectPath}
        >
          {extractProjectName(process.projectPath)}
        </span>

        {/* Uptime */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text-tertiary)',
            minWidth: 52,
            textAlign: 'right',
          }}
        >
          {formatUptime(process.startedAt)}
        </span>

        {/* CPU */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            color: barColor(process.cpuPercent ?? 0),
            minWidth: 44,
            textAlign: 'right',
            fontSize: 11,
          }}
          title={`CPU: ${formatCpu(process.cpuPercent)}`}
        >
          {formatCpu(process.cpuPercent)}
        </span>

        {/* Memory — color by MB: green <700M, orange 700M-1.2G, red >1.2G */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            color: barColor((process.memoryRssKb ?? 0) / 1024 / 14),
            minWidth: 48,
            textAlign: 'right',
            fontSize: 11,
          }}
          title={`RSS: ${process.memoryRssKb ? (process.memoryRssKb / 1024).toFixed(1) + ' MB' : '--'}`}
        >
          {formatMemoryMb(process.memoryRssKb)}
        </span>

        {/* Disk (session file size) — color: green <5M, orange 5-10M, red >10M */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            color: enrichment?.fileSize != null
              ? barColor(enrichment.fileSize / (1024 * 1024) / 0.125)
              : 'var(--color-text-tertiary)',
            minWidth: 44,
            textAlign: 'right',
            fontSize: 11,
          }}
          title={enrichment?.fileSize != null ? `Session file: ${enrichment.fileSize.toLocaleString()} bytes` : 'No session data'}
        >
          {enrichment?.fileSize != null ? formatFileSize(enrichment.fileSize) : '--'}
        </span>

        {/* PTS */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text-tertiary)',
            minWidth: 40,
            textAlign: 'center',
            fontSize: 11,
          }}
          title={process.tty || undefined}
        >
          {pts ? `pts/${pts}` : '--'}
        </span>

        {/* Machine (multi-machine only) */}
        {!isSingleMachine && (
          <span
            style={{
              color: 'var(--color-text-tertiary)',
              minWidth: 70,
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={process.machineHostname}
          >
            {process.machineHostname || '--'}
          </span>
        )}

        {/* Enrichment stats (icon-based, right-aligned) */}
        <span style={{ flex: 1, display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center' }}>
          {enrichment?.numTurns != null && (
            <IconStat icon={<MessageSquare size={10} />} value={enrichment.numTurns} title="Conversation turns" />
          )}
          {enrichment?.userPromptCount != null && (
            <IconStat icon={<User size={10} />} value={enrichment.userPromptCount} title="User prompts" />
          )}
          {enrichment?.agentCount != null && enrichment.agentCount > 0 && (
            <IconStat icon={<Cpu size={10} />} value={enrichment.agentCount} title="Subagents" />
          )}
          {enrichment?.taskCount != null && enrichment.taskCount > 0 && (
            <IconStat icon={<ListChecks size={10} />} value={enrichment.taskCount} title="Tasks" />
          )}
          {enrichment?.teamName && (
            <span
              title={enrichment.allTeams && enrichment.allTeams.length > 1 ? enrichment.allTeams.join(', ') : enrichment.teamName}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                padding: '0px 4px',
                background: 'rgba(139,92,246,0.15)',
                color: '#8b5cf6',
                border: '1px solid rgba(139,92,246,0.3)',
                borderRadius: 3,
                fontSize: 9,
                whiteSpace: 'nowrap',
              }}
            >
              <Users size={10} />{enrichment.teamName}
            </span>
          )}
        </span>

        {/* Actions */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 100, justifyContent: 'flex-end' }}>
          {isConnectable && onConnect ? (
            <button
              className="badge badge-green"
              style={{ cursor: 'pointer', border: 'none', fontSize: 11 }}
              onClick={() => onConnect(process)}
            >
              Open <ExternalLink size={10} />
            </button>
          ) : (process.managedBy === 'unmanaged-tmux' || (process.managedBy === 'ttyd-tmux' && !hasValidSession)) && onConnectTmux ? (
            <button
              className="badge badge-orange"
              style={{ cursor: 'pointer', border: 'none', fontSize: 11 }}
              onClick={() => onConnectTmux(process)}
            >
              {process.managedBy === 'ttyd-tmux' ? 'Open' : 'Connect'} <ExternalLink size={10} />
            </button>
          ) : (
            <span className="badge badge-default" style={{ fontSize: 11 }}>External</span>
          )}

          {/* Kill button */}
          {onKill && (
            <button
              style={{
                display: 'flex',
                alignItems: 'center',
                background: 'none',
                border: 'none',
                cursor: killing ? 'wait' : 'pointer',
                padding: 2,
                color: 'var(--color-text-tertiary)',
                opacity: killing ? 0.3 : 0.6,
                transition: 'opacity 0.15s',
              }}
              title={`Kill PID ${process.pid}`}
              onClick={() => onKill(process)}
              disabled={killing}
              onMouseEnter={e => { (e.target as HTMLElement).style.opacity = '1'; (e.target as HTMLElement).style.color = 'var(--color-status-red)'; }}
              onMouseLeave={e => { (e.target as HTMLElement).style.opacity = '0.6'; (e.target as HTMLElement).style.color = 'var(--color-text-tertiary)'; }}
            >
              <X size={14} />
            </button>
          )}
        </span>
      </div>

      {/* Detail row: last user prompt + updated ago */}
      {enrichment && (enrichment.lastUserMessage || enrichment.lastModified) ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 12px 6px 12px',
            fontSize: 11,
          }}
        >
          {/* Last user prompt */}
          {enrichment.lastUserMessage && (
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--color-text-tertiary)',
                fontStyle: 'italic',
              }}
              title={enrichment.lastUserMessage}
            >
              {enrichment.lastUserMessage}
            </span>
          )}

          {/* Updated X ago */}
          {enrichment.lastModified && (
            <span
              style={{
                whiteSpace: 'nowrap',
                color: 'var(--color-text-tertiary)',
                fontSize: 10,
                opacity: 0.7,
              }}
              title={new Date(enrichment.lastModified).toLocaleString()}
            >
              updated {formatTimeAgo(enrichment.lastModified)}
            </span>
          )}
        </div>
      ) : !hasValidSession && (process as any).cmdline ? (
        <div
          style={{
            padding: '0 12px 6px 12px',
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={(process as any).cmdline}
        >
          {(process as any).cmdline}
        </div>
      ) : null}
    </div>
  );
}

// ============================================================================
// Role color helpers (shared)
// ============================================================================

const ROLE_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  original:      { bg: 'rgba(34,197,94,0.15)',  color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)' },
  'console-tab': { bg: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)' },
  resumed:       { bg: 'rgba(59,130,246,0.15)',  color: '#3b82f6', border: '1px solid rgba(59,130,246,0.3)' },
  unknown:       { bg: 'rgba(148,163,184,0.15)', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.3)' },
};

function getRoleStyle(role?: string | null) {
  return ROLE_STYLES[role || 'unknown'] || ROLE_STYLES.unknown;
}

// ============================================================================
// Session-grouped view (matches admin portal layout)
// ============================================================================

function ScreenTurnBar({ identify }: { identify: IdentifiedProcess }) {
  const { screenTurn, sessionStats } = identify;

  if (!screenTurn) {
    return <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>TUI (no capture)</span>;
  }
  if (screenTurn.lastReadTurnIndex === null) {
    return <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>No turn match</span>;
  }

  const lastTurn = sessionStats?.lastTurnIndex ?? screenTurn.lastReadTurnIndex;
  const readTurn = screenTurn.lastReadTurnIndex;
  const isLive = readTurn >= lastTurn;
  const pct = lastTurn > 0 ? Math.min(100, (readTurn / lastTurn) * 100) : 100;
  const gap = lastTurn - readTurn;

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
      title={screenTurn.matchedText ? screenTurn.matchedText.slice(0, 200) : undefined}
    >
      {/* Progress bar */}
      <span style={{
        position: 'relative',
        width: 52,
        height: 5,
        borderRadius: 3,
        background: 'rgba(148,163,184,0.2)',
        overflow: 'hidden',
        flexShrink: 0,
      }}>
        <span style={{
          position: 'absolute',
          left: 0,
          top: 0,
          height: '100%',
          width: `${pct}%`,
          borderRadius: 3,
          background: isLive ? '#22c55e' : '#f59e0b',
          transition: 'width 0.3s',
        }} />
      </span>
      {/* Turn label */}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--color-text-tertiary)' }}>
        T{readTurn}/{lastTurn}
      </span>
      {/* Live/Stale badge */}
      <span
        style={{
          fontSize: 8,
          fontWeight: 600,
          padding: '0 4px',
          borderRadius: 3,
          lineHeight: '15px',
          ...(isLive ? {
            background: 'rgba(34,197,94,0.15)',
            color: '#22c55e',
            border: '1px solid rgba(34,197,94,0.3)',
          } : {
            background: 'rgba(245,158,11,0.15)',
            color: '#f59e0b',
            border: '1px solid rgba(245,158,11,0.3)',
          }),
        }}
      >
        {isLive ? 'Live' : `Stale -${gap}`}
      </span>
    </span>
  );
}

function SessionProcessRow({ identify }: { identify: IdentifiedProcess }) {
  const roleStyle = getRoleStyle(identify.role);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 12px',
        borderBottom: '1px solid var(--color-border-subtle)',
        fontSize: 11,
      }}
    >
      {/* PID */}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-secondary)', minWidth: 56, flexShrink: 0 }}>
        {identify.pid}
      </span>

      {/* Role badge */}
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '0 5px',
          borderRadius: 3,
          fontSize: 8,
          fontWeight: 600,
          lineHeight: '16px',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          background: roleStyle.bg,
          color: roleStyle.color,
          border: roleStyle.border,
        }}
      >
        {identify.role || 'unknown'}
      </span>

      {/* tmux session name */}
      {identify.tmuxSessionName && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--color-text-tertiary)',
            maxWidth: 90,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
          title={identify.tmuxSessionName}
        >
          {identify.tmuxSessionName}
        </span>
      )}

      {/* Screen turn indicator */}
      <span style={{ flex: 1, minWidth: 0 }}>
        <ScreenTurnBar identify={identify} />
      </span>

      {/* Managed by */}
      <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
        {identify.managedBy}
      </span>

      {/* Started */}
      {identify.processStartedAt && (
        <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
          {formatTimeAgo(identify.processStartedAt)}
        </span>
      )}
    </div>
  );
}

function SessionGroupCard({ sessionId, processes }: { sessionId: string; processes: IdentifiedProcess[] }) {
  const stats = processes[0]?.sessionStats;
  const { isLocal } = useAppMode();

  return (
    <div
      style={{
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border-default)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}
    >
      {/* Card header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--color-border-default)',
          background: 'rgba(255,255,255,0.02)',
        }}
      >
        <Terminal size={13} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
        <Link
          href={`/sessions?session=${sessionId}`}
          target="_blank"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--color-accent)',
            textDecoration: 'none',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {sessionId.slice(0, 12)}...
        </Link>
        <ExternalLink size={10} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />

        <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          {/* Process count */}
          <span
            style={{
              fontSize: 9,
              padding: '1px 6px',
              borderRadius: 3,
              background: 'rgba(148,163,184,0.15)',
              color: 'var(--color-text-secondary)',
              border: '1px solid rgba(148,163,184,0.2)',
            }}
          >
            {processes.length} process{processes.length !== 1 ? 'es' : ''}
          </span>

          {/* Session stats */}
          {stats && (
            <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>
              {stats.numTurns} turns
              {stats.lastTimestamp && ` · ${formatTimeAgo(stats.lastTimestamp)}`}
            </span>
          )}
        </span>
      </div>

      {/* Process rows */}
      {processes.map(proc => (
        <SessionProcessRow key={proc.pid} identify={proc} />
      ))}
    </div>
  );
}

function SessionGroupedView({
  identifyMap,
}: {
  identifyMap: Map<number, IdentifiedProcess>;
}) {
  // Group by sessionId
  const grouped = useMemo(() => {
    const map = new Map<string, IdentifiedProcess[]>();
    for (const proc of identifyMap.values()) {
      const key = proc.sessionId || `unidentified-${proc.pid}`;
      const list = map.get(key) || [];
      list.push(proc);
      map.set(key, list);
    }
    // Sort: identified sessions first (by process count desc), then unidentified
    return Array.from(map.entries()).sort(([aKey, aProcs], [bKey, bProcs]) => {
      const aId = !aKey.startsWith('unidentified-');
      const bId = !bKey.startsWith('unidentified-');
      if (aId !== bId) return aId ? -1 : 1;
      return bProcs.length - aProcs.length;
    });
  }, [identifyMap]);

  if (identifyMap.size === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--color-text-tertiary)' }}>
        <Eye size={32} style={{ opacity: 0.2, marginBottom: 12 }} />
        <div style={{ fontSize: 13 }}>Waiting for process identification...</div>
        <div style={{ fontSize: 11, marginTop: 4 }}>Data loads automatically (max 20 PIDs)</div>
      </div>
    );
  }

  const identifiedCount = grouped.filter(([k]) => !k.startsWith('unidentified-')).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Summary */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'var(--color-text-tertiary)' }}>
        <span>{identifyMap.size} process{identifyMap.size !== 1 ? 'es' : ''}</span>
        <span>·</span>
        <span>{identifiedCount} session{identifiedCount !== 1 ? 's' : ''}</span>
      </div>

      {/* Session cards */}
      {grouped.map(([sessionKey, procs]) => {
        const isUnidentified = sessionKey.startsWith('unidentified-');
        if (isUnidentified) {
          return (
            <div
              key={sessionKey}
              style={{
                background: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-lg)',
                overflow: 'hidden',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: '1px solid var(--color-border-subtle)', background: 'rgba(255,255,255,0.01)' }}>
                <Cpu size={12} style={{ color: 'var(--color-text-tertiary)' }} />
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>Unidentified</span>
              </div>
              {procs.map(proc => (
                <SessionProcessRow key={proc.pid} identify={proc} />
              ))}
            </div>
          );
        }
        return <SessionGroupCard key={sessionKey} sessionId={sessionKey} processes={procs} />;
      })}
    </div>
  );
}

function ProcessCategoryGroup({
  category,
  processes,
  enrichment,
  identifyMap,
  onConnect,
  onConnectTmux,
  onKill,
  onKillAll,
  killingPids,
  isSingleMachine,
}: {
  category: ProcessManagedBy;
  processes: ClaudeProcessInfo[];
  enrichment: Record<string, BatchCheckListSession>;
  identifyMap: Map<number, IdentifiedProcess>;
  onConnect?: (process: ClaudeProcessInfo) => void;
  onConnectTmux?: (process: ClaudeProcessInfo) => void;
  onKill?: (process: ClaudeProcessInfo) => void;
  onKillAll?: (processes: ClaudeProcessInfo[]) => void;
  killingPids?: Set<number>;
  isSingleMachine: boolean;
}) {
  const meta = CATEGORY_META[category];

  return (
    <div
      style={{
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border-default)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid var(--color-border-default)',
          borderLeft: `3px solid ${meta.color}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: meta.color, fontSize: 13, fontWeight: 600 }}>
            {meta.label}
          </span>
          <span style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}>
            {meta.description}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className={`badge ${meta.badge}`}>
            {processes.length} process{processes.length !== 1 ? 'es' : ''}
          </span>
          {onKillAll && processes.length > 1 && (
            <button
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                background: 'none',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-sm)',
                padding: '2px 8px',
                fontSize: 10,
                color: 'var(--color-text-tertiary)',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
              title={`Close all ${processes.length} processes in this group`}
              onClick={() => onKillAll(processes)}
              onMouseEnter={e => { const el = e.currentTarget; el.style.color = 'var(--color-status-red)'; el.style.borderColor = 'var(--color-status-red)'; }}
              onMouseLeave={e => { const el = e.currentTarget; el.style.color = 'var(--color-text-tertiary)'; el.style.borderColor = 'var(--color-border-default)'; }}
            >
              <XCircle size={10} />
              Close All
            </button>
          )}
        </div>
      </div>

      {/* Process rows */}
      {processes.map((process, idx) => (
        <ProcessRow
          key={`${process.pid}-${idx}`}
          process={process}
          enrichment={process.sessionId ? enrichment[process.sessionId] : undefined}
          identify={identifyMap.get(process.pid)}
          onConnect={onConnect}
          onConnectTmux={onConnectTmux}
          onKill={onKill}
          killing={killingPids?.has(process.pid)}
          isSingleMachine={isSingleMachine}
        />
      ))}
    </div>
  );
}

// ============================================================================
// Page
// ============================================================================

export default function ProcessDashboardPage() {
  const { apiClient, isLocal, proxy } = useAppMode();
  const { isSingleMachine } = useMachineContext();
  const { isWindows } = usePlatform();
  const { data, isLoading, error, refetch } = useRunningProcesses(5000);
  const [killingPids, setKillingPids] = useState<Set<number>>(new Set());
  const [identifyMap, setIdentifyMap] = useState<Map<number, IdentifiedProcess>>(new Map());
  const identifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build set of session IDs that have active ttyd servers (from managed array)
  const managedSessionIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of data.managed) {
      if (m.sessionId) set.add(m.sessionId);
    }
    return set;
  }, [data.managed]);

  // Map ttyd port → managed sessionId (for reusing existing ttyd instances)
  const managedPortToSessionId = useMemo(() => {
    const map = new Map<number, string>();
    for (const m of data.managed) {
      if (m.port && m.sessionId) map.set(m.port, m.sessionId);
    }
    return map;
  }, [data.managed]);

  // ── Process Identification polling ──────────────────────────────────────
  // Calls identifyProcesses for ALL PIDs (batched in chunks of 20) every 10s
  const allPids = useMemo(() => {
    return data.allClaudeProcesses.map(p => p.pid).sort((a, b) => a - b);
  }, [data.allClaudeProcesses]);

  useEffect(() => {
    if (allPids.length === 0) {
      setIdentifyMap(new Map());
      return;
    }

    let cancelled = false;

    async function fetchIdentify() {
      try {
        // Batch PIDs into chunks of 20 (backend limit)
        const chunks: number[][] = [];
        for (let i = 0; i < allPids.length; i += 20) {
          chunks.push(allPids.slice(i, i + 20));
        }
        const results = await Promise.all(
          chunks.map(chunk => apiClient.identifyProcesses(chunk).catch(() => ({ processes: [] })))
        );
        if (cancelled) return;
        const map = new Map<number, IdentifiedProcess>();
        for (const result of results) {
          for (const proc of result.processes) {
            map.set(proc.pid, proc);
          }
        }
        setIdentifyMap(map);
      } catch {
        // Ignore errors, keep previous data
      }
      if (!cancelled) {
        identifyTimerRef.current = setTimeout(fetchIdentify, 10000);
      }
    }

    fetchIdentify();

    return () => {
      cancelled = true;
      if (identifyTimerRef.current) clearTimeout(identifyTimerRef.current);
    };
  }, [allPids, apiClient]);

  // Enrich processes: if a process's sessionId matches a managed ttyd session,
  // upgrade its managedBy to 'ttyd' so it gets the "Open" button.
  // Also match by externalTtydPort for processes without sessionId (e.g., unmanaged tmux).
  // Inject managed ttyd instances that have no matching Claude process.
  const enrichedProcesses = useMemo(() => {
    const matchedManagedIds = new Set<string>();
    const matchedManagedPorts = new Set<number>();
    const enriched = data.allClaudeProcesses.map(proc => {
      // Match by sessionId
      if (
        proc.sessionId &&
        managedSessionIds.has(proc.sessionId) &&
        proc.managedBy !== 'wrapper'
      ) {
        matchedManagedIds.add(proc.sessionId);
        return { ...proc, managedBy: 'ttyd' as ProcessManagedBy };
      }
      if (proc.sessionId && managedSessionIds.has(proc.sessionId)) {
        matchedManagedIds.add(proc.sessionId);
      }
      // Match by port: ttyd-tmux processes with no sessionId but with externalTtydPort
      if (proc.externalTtydPort && (proc.managedBy === 'ttyd-tmux' || proc.managedBy === 'ttyd')) {
        matchedManagedPorts.add(proc.externalTtydPort);
      }
      return proc;
    });

    // Add synthetic entries for managed ttyd instances with no matching Claude process
    for (const m of data.managed) {
      if (m.sessionId && !matchedManagedIds.has(m.sessionId) && !matchedManagedPorts.has(m.port)) {
        enriched.push({
          pid: m.pid,
          sessionId: m.sessionId,
          projectPath: m.projectPath,
          managedBy: 'ttyd' as ProcessManagedBy,
          source: 'console-tab',
          startedAt: m.startedAt,
        } as ClaudeProcessInfo);
      }
    }

    return enriched;
  }, [data.allClaudeProcesses, managedSessionIds, data.managed]);

  // Deduplicate: multiple PIDs often share the same sessionId (parent+child).
  // Keep the process with the highest RSS (the real claude runtime, not the bash launcher).
  const deduped = useMemo(() => {
    const bestByKey = new Map<string, ClaudeProcessInfo>();
    const noKey: ClaudeProcessInfo[] = [];
    for (const proc of enrichedProcesses) {
      const sid = proc.sessionId;
      if (!sid || sid === 'unknown' || sid === 'chrome-session') {
        noKey.push(proc);
        continue;
      }
      const key = `${proc.managedBy}:${sid}`;
      const existing = bestByKey.get(key);
      if (!existing || (proc.memoryRssKb ?? 0) > (existing.memoryRssKb ?? 0)) {
        bestByKey.set(key, proc);
      }
    }
    return [...bestByKey.values(), ...noKey];
  }, [enrichedProcesses]);

  // Async session enrichment — loads independently from process polling
  const { enrichment } = useSessionEnrichment(deduped, 15000);

  // Group processes by managedBy category
  const grouped = useMemo(() => {
    const groups = new Map<ProcessManagedBy, ClaudeProcessInfo[]>();
    for (const cat of CATEGORY_ORDER) {
      groups.set(cat, []);
    }
    for (const proc of deduped) {
      const cat = proc.managedBy || 'unknown';
      const list = groups.get(cat as ProcessManagedBy);
      if (list) {
        list.push(proc);
      } else {
        groups.get('unknown')!.push(proc);
      }
    }
    return groups;
  }, [deduped]);

  // Group ALL processes by sessionId (pre-dedup so multi-PID sessions show all processes)
  // Use identifyMap sessionId as fallback when basic process data lacks it
  // Filter out non-session helper processes (MCP servers, worker daemons)
  const sessionGrouped = useMemo(() => {
    const map = new Map<string, ClaudeProcessInfo[]>();
    for (const proc of enrichedProcesses) {
      // Skip non-session helper processes (MCP servers, worker daemons with managedBy=unknown and no tmux)
      const identify = identifyMap.get(proc.pid);
      if (identify && identify.managedBy === 'unknown' && !identify.tmuxSessionName) continue;

      // Try basic process sessionId first, then fall back to identify endpoint's sessionId
      const basicSid = proc.sessionId && proc.sessionId !== 'unknown' && proc.sessionId !== 'chrome-session'
        ? proc.sessionId : null;
      const identifySid = identify?.sessionId || null;
      // Group all unidentified processes together in a single card
      const key = basicSid || identifySid || 'unidentified';
      const list = map.get(key) || [];
      list.push(proc);
      map.set(key, list);
    }
    // Sort: identified sessions first (by process count desc), then unidentified
    return Array.from(map.entries()).sort(([aKey, aProcs], [bKey, bProcs]) => {
      const aId = aKey !== 'unidentified';
      const bId = bKey !== 'unidentified';
      if (aId !== bId) return aId ? -1 : 1;
      return bProcs.length - aProcs.length;
    });
  }, [enrichedProcesses, identifyMap]);

  // Compute total CPU and memory across all Claude processes
  const totalProcessCpu = useMemo(() => deduped.reduce((sum, p) => sum + (p.cpuPercent || 0), 0), [deduped]);
  const totalProcessMemKb = useMemo(() => deduped.reduce((sum, p) => sum + (p.memoryRssKb || 0), 0), [deduped]);

  // Connect handler: open console wrapper
  const handleConnect = useCallback((process: ClaudeProcessInfo) => {
    if (!process.sessionId) return;
    const params = new URLSearchParams({ sessionId: process.sessionId });
    if (process.projectPath) params.set('projectPath', process.projectPath);
    // Include machineId for hub mode or proxy mode (needed by LangMartDesign console page)
    const mid = proxy.isProxied ? proxy.machineId : (!isLocal ? process.machineId : null);
    if (mid) params.set('machineId', mid);
    const basePath = proxy.isProxied ? proxy.basePath : '';
    window.open(`${basePath}/console?${params.toString()}`, `terminal-${process.sessionId}`);
  }, [isLocal, proxy]);

  // Connect handler for unmanaged/managed-tmux processes
  const handleConnectTmux = useCallback((process: ClaudeProcessInfo) => {
    // If ttyd is already attached, reuse it via the managed sessionId
    // The console page will find the existing ttyd instance and skip starting a new one
    const existingSessionId = process.externalTtydPort
      ? managedPortToSessionId.get(process.externalTtydPort)
      : undefined;
    if (existingSessionId) {
      const params = new URLSearchParams({ sessionId: existingSessionId });
      if (process.projectPath) params.set('projectPath', process.projectPath);
      const mid = proxy.isProxied ? proxy.machineId : (!isLocal ? process.machineId : null);
      if (mid) params.set('machineId', mid);
      const basePath = proxy.isProxied ? proxy.basePath : '';
      window.open(`${basePath}/console?${params.toString()}`, `terminal-pid-${process.pid}`);
      return;
    }

    // No existing ttyd — start a new one via connectPid
    const params = new URLSearchParams();
    // Pass real sessionId when available (extracted from --resume in cmdline)
    if (process.sessionId && process.sessionId !== 'unknown') params.set('sessionId', process.sessionId);
    if (process.projectPath) params.set('projectPath', process.projectPath);
    params.set('connectPid', String(process.pid));
    if (process.tmuxSessionName) params.set('existingTmuxSession', process.tmuxSessionName);
    // Include machineId for hub/proxy mode
    const mid = proxy.isProxied ? proxy.machineId : (!isLocal ? process.machineId : null);
    if (mid) params.set('machineId', mid);
    // Route through langmart-assistant console page (supports connectPid without sessionId)
    const basePath = proxy.isProxied ? proxy.basePath : '';
    window.open(`${basePath}/console?${params.toString()}`, `terminal-pid-${process.pid}`);
  }, [isLocal, proxy, managedPortToSessionId]);

  // Kill a single process by PID
  const handleKill = useCallback(async (process: ClaudeProcessInfo) => {
    if (killingPids.has(process.pid)) return;
    setKillingPids(prev => new Set(prev).add(process.pid));
    try {
      // Use session kill if we have a sessionId, otherwise kill by PID
      if (process.sessionId && process.sessionId !== 'unknown' && process.sessionId !== 'chrome-session') {
        await apiClient.killSessionProcesses(process.sessionId, isLocal ? undefined : process.machineId);
      } else {
        await apiClient.killProcess(process.pid, isLocal ? undefined : process.machineId);
      }
      // Delay refetch slightly so backend state settles
      setTimeout(() => refetch(), 500);
    } catch {
      // Ignore errors, refetch will update state
    } finally {
      setKillingPids(prev => {
        const next = new Set(prev);
        next.delete(process.pid);
        return next;
      });
    }
  }, [apiClient, isLocal, killingPids, refetch]);

  // Kill all processes in a group
  const handleKillAll = useCallback(async (processes: ClaudeProcessInfo[]) => {
    const pids = processes.map(p => p.pid);
    setKillingPids(prev => {
      const next = new Set(prev);
      pids.forEach(pid => next.add(pid));
      return next;
    });
    try {
      // Kill by sessionId where possible (deduped by sessionId to avoid duplicate calls)
      const bySession = new Map<string, ClaudeProcessInfo>();
      const noSession: ClaudeProcessInfo[] = [];
      for (const p of processes) {
        if (p.sessionId && p.sessionId !== 'unknown' && p.sessionId !== 'chrome-session') {
          bySession.set(p.sessionId, p);
        } else {
          noSession.push(p);
        }
      }
      await Promise.allSettled([
        ...Array.from(bySession.values()).map(p =>
          apiClient.killSessionProcesses(p.sessionId!, isLocal ? undefined : p.machineId)
        ),
        ...noSession.map(p =>
          apiClient.killProcess(p.pid, isLocal ? undefined : p.machineId)
        ),
      ]);
      setTimeout(() => refetch(), 500);
    } catch {
      // Ignore
    } finally {
      setKillingPids(prev => {
        const next = new Set(prev);
        pids.forEach(pid => next.delete(pid));
        return next;
      });
    }
  }, [apiClient, isLocal, refetch]);

  // Kill ALL processes
  const handleKillAllGlobal = useCallback(async () => {
    await handleKillAll(deduped);
  }, [deduped, handleKillAll]);

  // ─── Render ─────────────────────────────────────────────────────────────

  if (isWindows) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'var(--color-text-tertiary)' }}>
          <Activity size={32} style={{ opacity: 0.3 }} />
          <span style={{ fontSize: 14, fontWeight: 500 }}>Process management is not supported on Windows</span>
          <span style={{ fontSize: 12 }}>Process scanning requires a Unix-based platform (Linux or macOS).</span>
        </div>
      </div>
    );
  }

  if (isLoading && data.allClaudeProcesses.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--color-text-tertiary)', animation: 'pulse 2s infinite' }}>
          Loading processes...
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid var(--color-border-default)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Activity size={16} style={{ color: 'var(--color-accent)' }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>
            Process Dashboard
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {deduped.length > 0 && (
            <button
              onClick={handleKillAllGlobal}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                background: 'none',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-md)',
                padding: '4px 10px',
                fontSize: 11,
                color: 'var(--color-text-tertiary)',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { const el = e.currentTarget; el.style.color = 'var(--color-status-red)'; el.style.borderColor = 'var(--color-status-red)'; }}
              onMouseLeave={e => { const el = e.currentTarget; el.style.color = 'var(--color-text-tertiary)'; el.style.borderColor = 'var(--color-border-default)'; }}
            >
              <XCircle size={12} />
              Close All
            </button>
          )}
          <button
            onClick={refetch}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'var(--color-bg-active)',
              border: '1px solid var(--color-border-default)',
              borderRadius: 'var(--radius-md)',
              padding: '4px 10px',
              fontSize: 11,
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {error && (
          <div
            style={{
              padding: '8px 12px',
              marginBottom: 12,
              background: 'rgba(248, 113, 113, 0.1)',
              border: '1px solid var(--color-status-red)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-status-red)',
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        {/* Summary bar */}
        <div style={{ marginBottom: 16 }}>
          <SummaryBar
            totalClaude={deduped.length}
            totalManaged={deduped.filter(p => p.managedBy === 'ttyd' || p.managedBy === 'ttyd-tmux').length}
            unmanagedCount={deduped.filter(p => p.managedBy === 'unmanaged-terminal' || p.managedBy === 'unmanaged-tmux').length}
            byCategory={Object.fromEntries(
              CATEGORY_ORDER.map(cat => [cat, (grouped.get(cat) || []).length])
            )}
            stats={data.systemStats}
            totalProcessCpu={totalProcessCpu}
            totalProcessMemKb={totalProcessMemKb}
          />
        </div>

        {/* Empty state */}
        {deduped.length === 0 && !isLoading && (
          <div className="empty-state">
            <Cpu size={36} className="empty-state-icon" />
            <span style={{ fontSize: 13 }}>No Claude processes running</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              Start a Claude Code session to see it here
            </span>
          </div>
        )}

        {/* Session-grouped process cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sessionGrouped.map(([sessionKey, procs]) => {
            const isUnidentified = sessionKey === 'unidentified';
            // Get identify data for the first process to show session-level info
            const firstIdentify = procs[0] ? identifyMap.get(procs[0].pid) : undefined;
            const stats = firstIdentify?.sessionStats;

            return (
              <div
                key={sessionKey}
                style={{
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 'var(--radius-lg)',
                  overflow: 'hidden',
                }}
              >
                {/* Session card header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--color-border-default)',
                    background: 'rgba(255,255,255,0.02)',
                  }}
                >
                  {isUnidentified ? (
                    <>
                      <Cpu size={13} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                      <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>Unidentified</span>
                    </>
                  ) : (
                    <>
                      <Terminal size={13} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                      <Link
                        href={`/sessions?session=${sessionKey}`}
                        target="_blank"
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          color: 'var(--color-accent)',
                          textDecoration: 'none',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {sessionKey.slice(0, 12)}...
                      </Link>
                      <ExternalLink size={10} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                    </>
                  )}

                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                    {/* Identify-based role + turn summary per process */}
                    {procs.length > 1 && procs.map(p => {
                      const id = identifyMap.get(p.pid);
                      if (!id?.role) return null;
                      const roleStyle = getRoleStyle(id.role);
                      const st = id.screenTurn;
                      const lastTurn = id.sessionStats?.lastTurnIndex ?? st?.lastReadTurnIndex ?? 0;
                      const readTurn = st?.lastReadTurnIndex;
                      const isLive = readTurn != null && readTurn >= lastTurn;
                      return (
                        <span
                          key={p.pid}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                            fontSize: 8,
                            padding: '0 4px',
                            borderRadius: 3,
                            background: 'rgba(255,255,255,0.03)',
                            border: '1px solid var(--color-border-subtle)',
                          }}
                        >
                          <span style={{ width: 5, height: 5, borderRadius: '50%', background: roleStyle.color, flexShrink: 0 }} />
                          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{p.pid}</span>
                          {readTurn != null && (
                            <span style={{ color: isLive ? '#22c55e' : '#f59e0b', fontWeight: 600 }}>
                              {isLive ? 'Live' : `S-${lastTurn - readTurn}`}
                            </span>
                          )}
                        </span>
                      );
                    })}

                    {/* Process count (filtered to identified PIDs if available) */}
                    {(() => {
                      const hasAny = procs.some(p => identifyMap.has(p.pid));
                      const count = hasAny ? procs.filter(p => identifyMap.has(p.pid)).length : procs.length;
                      return (
                        <span
                          style={{
                            fontSize: 9,
                            padding: '1px 6px',
                            borderRadius: 3,
                            background: 'rgba(148,163,184,0.15)',
                            color: 'var(--color-text-secondary)',
                            border: '1px solid rgba(148,163,184,0.2)',
                          }}
                        >
                          {count} process{count !== 1 ? 'es' : ''}
                        </span>
                      );
                    })()}

                    {/* Session stats from identify */}
                    {stats && (
                      <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                        {stats.numTurns} turns
                        {stats.lastTimestamp && ` · ${formatTimeAgo(stats.lastTimestamp)}`}
                      </span>
                    )}
                  </span>
                </div>

                {/* Process rows — if identify data exists, filter to only identified PIDs (skip child/helper processes) */}
                {(() => {
                  const hasAnyIdentify = procs.some(p => identifyMap.has(p.pid));
                  const visible = hasAnyIdentify ? procs.filter(p => identifyMap.has(p.pid)) : procs;
                  return visible.map((proc, idx) => (
                    <ProcessRow
                      key={`${proc.pid}-${idx}`}
                      process={proc}
                      enrichment={proc.sessionId ? enrichment[proc.sessionId] : undefined}
                      identify={identifyMap.get(proc.pid)}
                      onConnect={handleConnect}
                      onConnectTmux={handleConnectTmux}
                      onKill={handleKill}
                      killing={killingPids.has(proc.pid)}
                      isSingleMachine={isSingleMachine}
                    />
                  ));
                })()}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

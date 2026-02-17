'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import {
  Terminal,
  Play,
  Square,
  Loader2,
  ExternalLink,
  Monitor,
  Zap,
} from 'lucide-react';
import { type ProcessRunningInfo, managedByLabel } from '@/lib/types';

interface ConsoleTabProps {
  sessionId: string;
  machineId?: string;
  projectPath?: string;
  running?: ProcessRunningInfo;
}

type ConsoleMode = 'direct' | 'shared';

export function ConsoleTab({ sessionId, machineId, projectPath, running }: ConsoleTabProps) {
  const { apiClient } = useAppMode();
  const [consoleUrl, setConsoleUrl] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoConnectAttempted = useRef(false);

  const [mode, setMode] = useState<ConsoleMode>('direct');

  const handleStart = useCallback(async () => {
    setIsStarting(true);
    setError(null);
    try {
      const result = await apiClient.startTerminal(sessionId, projectPath, machineId);
      setConsoleUrl(result.consoleUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start terminal');
    } finally {
      setIsStarting(false);
    }
  }, [apiClient, sessionId, projectPath, machineId]);

  // Auto-connect when a process is running
  useEffect(() => {
    if (running && !consoleUrl && !isStarting && !autoConnectAttempted.current) {
      autoConnectAttempted.current = true;
      handleStart();
    }
  }, [running, consoleUrl, isStarting, handleStart]);

  // Reset auto-connect flag when session changes
  useEffect(() => {
    autoConnectAttempted.current = false;
  }, [sessionId]);

  const handleStop = useCallback(async () => {
    setConsoleUrl(null);
    try {
      await apiClient.stopTerminal(sessionId, machineId);
    } catch {
      // Best effort — server may already be stopped
    }
  }, [apiClient, sessionId, machineId]);

  // Disconnect iframe, stop ttyd, start fresh, then open in target
  const handleOpenIn = useCallback(async (target: 'tab' | 'window') => {
    // 1. Open window immediately (must be synchronous from user click, or browser blocks it)
    const windowName = target === 'window' ? `console-${sessionId}` : '_blank';
    const windowFeatures = target === 'window' ? 'width=900,height=600' : undefined;
    const newWindow = window.open('about:blank', windowName, windowFeatures);

    // 2. Disconnect iframe by clearing URL
    setConsoleUrl(null);

    // 3. Stop existing ttyd (direct mode -o may have already exited)
    try { await apiClient.stopTerminal(sessionId, machineId); } catch {}

    // 4. Wait for ttyd to fully release
    await new Promise(r => setTimeout(r, 500));

    // 5. Start fresh ttyd
    try {
      const result = await apiClient.startTerminal(sessionId, projectPath, machineId);
      const url = result.consoleUrl;
      if (url && newWindow && !newWindow.closed) {
        newWindow.location.href = url;
      } else if (url && (!newWindow || newWindow.closed)) {
        // Popup was blocked — fall back to reconnecting in console tab
        setConsoleUrl(url);
        setError('Popup blocked — reconnected in console tab instead');
      }
    } catch (e) {
      // Start failed — close the blank window if it opened
      if (newWindow && !newWindow.closed) newWindow.close();
      setError(e instanceof Error ? e.message : 'Failed to start terminal');
    }
  }, [apiClient, sessionId, projectPath, machineId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--color-border-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        {!consoleUrl ? (
          <>
            {/* Show connecting status when auto-connecting, or start button when no process */}
            {isStarting ? (
              <span style={{
                fontSize: 11,
                color: 'var(--color-text-secondary)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}>
                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                {running ? 'Connecting...' : 'Starting...'}
              </span>
            ) : !running ? (
              <>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleStart}
                  style={{ gap: 4 }}
                >
                  <Play size={12} />
                  Start Console
                </button>

                {/* Mode toggle */}
                <div style={{
                  display: 'flex',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                }}>
                  <button
                    className="btn btn-sm"
                    style={{
                      borderRadius: 0,
                      border: 'none',
                      padding: '3px 8px',
                      fontSize: 10,
                      gap: 3,
                      background: mode === 'direct'
                        ? 'rgba(251, 146, 60, 0.2)'
                        : 'transparent',
                      color: mode === 'direct'
                        ? 'var(--color-status-orange)'
                        : 'var(--color-text-tertiary)',
                    }}
                    onClick={() => setMode('direct')}
                    title="Direct: --chrome/MCP enabled, direct TTY access"
                  >
                    <Zap size={10} />
                    Direct
                  </button>
                  <button
                    className="btn btn-sm"
                    style={{
                      borderRadius: 0,
                      border: 'none',
                      borderLeft: '1px solid var(--color-border-default)',
                      padding: '3px 8px',
                      fontSize: 10,
                      gap: 3,
                      background: mode === 'shared'
                        ? 'rgba(96, 165, 250, 0.2)'
                        : 'transparent',
                      color: mode === 'shared'
                        ? 'var(--color-status-blue)'
                        : 'var(--color-text-tertiary)',
                    }}
                    onClick={() => setMode('shared')}
                    title="Shared: Uses tmux, multiple tabs can view same session"
                  >
                    <Monitor size={10} />
                    Shared
                  </button>
                </div>
              </>
            ) : (
              /* Process is running but auto-connect failed — show retry */
              <span style={{
                fontSize: 10,
                color: 'var(--color-text-tertiary)',
                fontFamily: 'var(--font-mono)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}>
                <span className="status-dot running" style={{ width: 6, height: 6 }} />
                PID {running.pid} via {managedByLabel(running.managedBy)}
                {running.tmuxSessionName && ` in ${running.tmuxSessionName}`}
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => { autoConnectAttempted.current = false; handleStart(); }}
                  style={{ fontSize: 10, padding: '1px 6px' }}
                >
                  Retry
                </button>
              </span>
            )}
          </>
        ) : (
          <>
            {/* Running status badge */}
            <span className="badge badge-green" style={{
              fontSize: 9,
              padding: '1px 6px',
            }}>
              Running
            </span>

            {/* Mode indicator */}
            <span className={`badge ${mode === 'direct' ? 'badge-orange' : 'badge-blue'}`} style={{
              fontSize: 9,
              padding: '1px 6px',
            }}>
              {mode === 'direct' ? 'Direct' : 'Shared'}
            </span>

            {/* Connection indicator */}
            <span className="badge badge-cyan" style={{ fontSize: 9, padding: '1px 6px' }}>
              Console Tab
            </span>

            {/* Process info */}
            <div className="process-status">
              <span>Session: {sessionId.slice(0, 8)}...</span>
            </div>

            <button className="btn btn-sm btn-ghost" onClick={() => handleOpenIn('tab')} title="Move to new tab (disconnects here)">
              <ExternalLink size={12} />
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => handleOpenIn('window')} title="Move to full window (disconnects here)">
              <Monitor size={12} />
              <span style={{ fontSize: 10 }}>Full Window</span>
            </button>
            <div style={{ flex: 1 }} />
            <button className="btn btn-sm btn-secondary" onClick={handleStop} style={{ gap: 4 }}>
              <Square size={10} />
              Disconnect
            </button>
          </>
        )}

        {error && (
          <span style={{ fontSize: 11, color: 'var(--color-status-red)' }}>{error}</span>
        )}
      </div>

      {/* Terminal area */}
      <div style={{ flex: 1, overflow: 'hidden', background: '#000' }}>
        {consoleUrl ? (
          <iframe
            src={consoleUrl}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
            }}
            title="Claude Code Terminal"
            onLoad={(e) => {
              const iframe = e.target as HTMLIFrameElement;
              setTimeout(() => iframe.focus(), 500);
            }}
          />
        ) : isStarting ? (
          <div className="empty-state" style={{ height: '100%' }}>
            <Loader2 size={32} style={{ opacity: 0.4, color: '#fff', animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
              {running ? 'Connecting to running session...' : 'Starting console...'}
            </span>
          </div>
        ) : (
          <div className="empty-state" style={{ height: '100%' }}>
            <Terminal size={32} style={{ opacity: 0.2, color: '#fff' }} />
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
              {running ? 'Session is running — click Retry to reconnect' : 'Click "Start Console" to launch a web terminal'}
            </span>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
              Connects to the Claude Code session via ttyd
            </span>
            {!running && (
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Zap size={10} style={{ color: 'var(--color-status-orange)' }} />
                  <span><strong>Direct</strong>: --chrome/MCP, direct TTY</span>
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Monitor size={10} style={{ color: 'var(--color-status-blue)' }} />
                  <span><strong>Shared</strong>: tmux, multi-tab viewing</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

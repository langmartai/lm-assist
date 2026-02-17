'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { detectAppMode, detectProxyInfo, resolveConsoleUrl } from '@/lib/api-client';

/** Extract a string error message from various response formats. */
function extractErrorMessage(data: any, fallback = 'Failed to start console'): string {
  if (!data) return fallback;
  // data.error could be a string or an object
  const err = data.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') return err.message || err.code || JSON.stringify(err);
  // Top-level message field (hub error format: {code, message, type, status})
  if (typeof data.message === 'string') return data.message;
  return fallback;
}

/** Normalize console URLs: convert localhost URLs to relative paths for proxy/hub mode.
 * On public domains, the main web's Next.js rewrites proxy /api/tier-agent/* to Gateway Type 1. */
function normalizeConsoleUrl(url: string): string {
  if (!url) return url;
  try {
    if (url.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/)) {
      const parsed = new URL(url);
      return parsed.pathname + parsed.search;
    }
  } catch { /* not valid URL */ }
  return url;
}

function FullScreenConsole() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('sessionId');
  const projectPath = searchParams.get('projectPath');
  const machineId = searchParams.get('machineId');
  const existingTmuxSession = searchParams.get('existingTmuxSession');
  const connectPid = searchParams.get('connectPid');
  const newSession = searchParams.get('newSession') === 'true';
  const isShell = searchParams.get('shell') === 'true';
  const isFork = searchParams.get('fork') === 'true';

  const [ttydUrl, setTtydUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch/start ttyd and get the URL
  useEffect(() => {
    // Allow: shell+projectPath, sessionId+projectPath, connectPid+projectPath, or newSession+projectPath
    const hasShell = isShell && projectPath;
    const hasSession = sessionId && projectPath;
    const hasPidConnect = connectPid && projectPath;
    const hasNewSession = newSession && projectPath;
    if (!hasShell && !hasSession && !hasPidConnect && !hasNewSession) {
      setLoading(false);
      return;
    }

    async function initializeTtyd() {
      if (!projectPath) return;

      const proxy = detectProxyInfo();
      const { baseUrl } = detectAppMode();

      try {
        // Shell mode: start a plain shell terminal (no Claude session)
        if (isShell) {
          const localBase = baseUrl || `http://localhost:${process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100'}`;
          const startRes = await fetch(`${localBase}/ttyd/shell/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath }),
          });
          const startData = await startRes.json();

          if (startData.success && startData.data?.url) {
            setTtydUrl(resolveConsoleUrl(startData.data.url));
          } else {
            setError(extractErrorMessage(startData));
          }
          return;
        }

        // Use real sessionId, or generate a tracking-only ID for new/unmanaged sessions.
        // The tracking ID is NOT a Claude Code session ID — it's only used for ttyd/tmux management.
        const effectiveSessionId = sessionId || `new-${Date.now()}`;
        const pidNum = connectPid ? parseInt(connectPid, 10) : undefined;

        if (proxy.isProxied && proxy.machineId) {
          // Proxy mode: use hub's console start endpoint
          const hubPath = `/api/tier-agent/machines/${proxy.machineId}/console/${effectiveSessionId}/start`;
          const startRes = await fetch(hubPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectPath,
              force: true,
              ...(newSession ? { resume: false } : {}),
              ...(isFork ? { forkSession: true } : {}),
              existingTmuxSession: existingTmuxSession || undefined,
              connectPid: pidNum,
            }),
          });
          const startData = await startRes.json();

          if (startData.success && startData.consoleUrl) {
            setTtydUrl(normalizeConsoleUrl(startData.consoleUrl));
          } else {
            setError(extractErrorMessage(startData));
          }
        } else if (machineId) {
          // Hub mode (non-proxy): use hub API with machineId
          const hubPath = `${baseUrl}/api/tier-agent/machines/${machineId}/console/${effectiveSessionId}/start`;
          const startRes = await fetch(hubPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectPath,
              force: true,
              ...(newSession ? { resume: false } : {}),
              ...(isFork ? { forkSession: true } : {}),
              existingTmuxSession: existingTmuxSession || undefined,
              connectPid: pidNum,
            }),
          });
          const startData = await startRes.json();

          if (startData.success && startData.consoleUrl) {
            setTtydUrl(normalizeConsoleUrl(startData.consoleUrl));
          } else {
            setError(extractErrorMessage(startData));
          }
        } else {
          // Local mode: call machine's ttyd endpoint directly
          const localBase = baseUrl || `http://localhost:${process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100'}`;

          // First check if ttyd is already running (only if we have a real sessionId, not for new/fork sessions)
          if (sessionId && !newSession && !isFork) {
            const statusRes = await fetch(
              `${localBase}/ttyd/session/${sessionId}/status?projectPath=${encodeURIComponent(projectPath)}`
            );
            const statusData = await statusRes.json();

            if (statusData.success && statusData.data?.ttydUrl) {
              setTtydUrl(resolveConsoleUrl(statusData.data.ttydUrl));
              setLoading(false);
              return;
            }
          }

          // Start ttyd in shared mode (tmux) or attach to existing session
          const startRes = await fetch(`${localBase}/ttyd/session/${effectiveSessionId}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectPath,
              resume: !connectPid && !newSession, // Don't resume for pid connect or new sessions
              directMode: false,
              existingTmuxSession: existingTmuxSession || undefined,
              connectPid: pidNum,
              forkSession: isFork || undefined,
            }),
          });
          const startData = await startRes.json();

          if (startData.success && startData.data?.url) {
            setTtydUrl(resolveConsoleUrl(startData.data.url));
          } else {
            setError(extractErrorMessage(startData));
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to connect to server');
      } finally {
        setLoading(false);
      }
    }

    initializeTtyd();
  }, [sessionId, projectPath, machineId, existingTmuxSession, connectPid, newSession, isShell, isFork]);

  // Set page title from session (skip for new/shell sessions — no real sessionId yet)
  useEffect(() => {
    if (isShell) {
      document.title = `Shell — ${projectPath?.split('/').pop() || 'Terminal'}`;
      return;
    }
    if (!sessionId || newSession) return;

    async function fetchSessionTitle() {
      try {
        const proxy = detectProxyInfo();
        const { baseUrl } = detectAppMode();

        let url: string;
        if (proxy.isProxied && proxy.machineId) {
          // Proxy mode: relay through hub
          url = `/api/tier-agent/machines/${proxy.machineId}/sessions/${sessionId}/conversation`;
        } else if (machineId) {
          // Hub mode
          url = `${baseUrl}/api/tier-agent/machines/${machineId}/sessions/${sessionId}/conversation`;
        } else {
          // Local mode
          const localBase = baseUrl || `http://localhost:${process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100'}`;
          url = `${localBase}/sessions/${sessionId}/conversation`;
        }

        const res = await fetch(url);
        if (!res.ok) return;

        const data = await res.json();
        const messages = data.messages || data.data?.messages || [];

        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.type === 'human' || msg.type === 'user') {
            const text = typeof msg.content === 'string'
              ? msg.content
              : msg.content?.text || msg.message?.content?.[0]?.text || '';
            if (text) {
              document.title = text.slice(0, 60) + (text.length > 60 ? '...' : '');
              return;
            }
          }
        }

        document.title = `Session ${sessionId?.slice(0, 8) || 'Unknown'}`;
      } catch {
        document.title = `Session ${sessionId?.slice(0, 8) || 'Unknown'}`;
      }
    }

    fetchSessionTitle();
  }, [sessionId, machineId]);

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', color: '#fff' }}>
        <div style={{ animation: 'pulse 2s infinite' }}>Starting terminal...</div>
      </div>
    );
  }

  if ((!sessionId && !connectPid && !newSession && !isShell) || !projectPath) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', color: '#fff' }}>
        <p>Missing sessionId/connectPid or projectPath parameter</p>
      </div>
    );
  }

  if (sessionId?.startsWith('agent-')) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', color: '#fff' }}>
        <div style={{ maxWidth: 400, textAlign: 'center' }}>
          <p style={{ fontSize: 18, marginBottom: 8 }}>Console Not Available</p>
          <p style={{ fontSize: 13, color: '#9ca3af' }}>
            Subagent sessions cannot be resumed or run via the web console.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', color: '#fff' }}>
        <div style={{ maxWidth: 400, textAlign: 'center' }}>
          <p style={{ fontSize: 18, marginBottom: 8 }}>Failed to Start Console</p>
          <p style={{ fontSize: 13, color: '#f87171' }}>{error}</p>
        </div>
      </div>
    );
  }

  if (!ttydUrl) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', color: '#fff' }}>
        <p>Console not available</p>
      </div>
    );
  }

  return (
    <div style={{ height: '100vh', width: '100vw', background: '#000' }}>
      <iframe
        src={ttydUrl}
        style={{ width: '100%', height: '100%', border: 'none' }}
        title={isShell ? 'Shell Terminal' : 'Claude Code Terminal'}
        allow="clipboard-read; clipboard-write"
        onLoad={(e) => {
          const iframe = e.target as HTMLIFrameElement;
          const scrollToBottom = () => {
            try {
              const iframeWindow = iframe.contentWindow;
              if (iframeWindow && (iframeWindow as any).term) {
                (iframeWindow as any).term.scrollToBottom();
              }
            } catch { /* cross-origin */ }
          };
          setTimeout(scrollToBottom, 1000);
          setTimeout(scrollToBottom, 2000);
          setTimeout(() => iframe.focus(), 500);
        }}
      />
    </div>
  );
}

export default function ConsolePage() {
  return (
    <Suspense fallback={
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', color: '#fff' }}>
        <div style={{ animation: 'pulse 2s infinite' }}>Loading terminal...</div>
      </div>
    }>
      <FullScreenConsole />
    </Suspense>
  );
}

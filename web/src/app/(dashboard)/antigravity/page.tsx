'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Rocket,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Copy,
  Terminal,
  Plug,
  Unplug,
  X,
} from 'lucide-react';
import { detectAppMode, workerFetch } from '@/lib/api-client';

interface AntigravityMcpStatus {
  installed: boolean;
  configPath: string;
  configExists: boolean;
  cliInstalled?: boolean;
  cliPath?: string | null;
  appInstalled?: boolean;
  appPath?: string | null;
  mode?: string;
  hubUrl?: string | null;
  command?: string;
  args?: string[];
}

export default function AntigravityPage() {
  const apiBase =
    typeof window !== 'undefined'
      ? detectAppMode().baseUrl || `http://${window.location.hostname}:3100`
      : 'http://localhost:3100';

  const [status, setStatus] = useState<AntigravityMcpStatus | null>(null);
  const [mode, setMode] = useState<'both' | 'stdio' | 'hub'>('both');
  const [profile, setProfile] = useState('basic');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await workerFetch(`${apiBase}/claude-code/ide-mcp/antigravity`);
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || 'Failed to query Antigravity MCP status');
      } else {
        setStatus(json.data as AntigravityMcpStatus);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleAction = async (op: 'activate' | 'deactivate') => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await workerFetch(`${apiBase}/claude-code/ide-mcp/antigravity/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          ...(profile.trim() ? { profile: profile.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || `Failed to ${op} Antigravity MCP`);
      } else {
        setStatus(json.data as AntigravityMcpStatus);
        setNotice(`Antigravity MCP ${op}d.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyCmd = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setNotice(`Copied: ${cmd}`);
    } catch {
      setError('Failed to copy command to clipboard.');
    }
  };

  const cliCommands = [
    'lm-assist mcp antigravity status',
    `lm-assist mcp antigravity add --mode ${mode}${profile.trim() ? ` --profile ${profile.trim()}` : ''}`,
    'lm-assist mcp antigravity remove',
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--color-bg-root)' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Rocket size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>Antigravity IDE &amp; CLI</div>
        {status?.mode && <span className="badge" style={{ fontSize: 11 }}>mode: {status.mode}</span>}
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={loadStatus} disabled={loading || busy}>
          <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} /> Refresh
        </button>
      </div>

      {error && (
        <div style={{ margin: '12px 20px 0', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-red)', color: 'var(--color-status-red)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <XCircle size={14} />
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {notice && (
        <div style={{ margin: '12px 20px 0', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-green)', color: 'var(--color-status-green)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <CheckCircle2 size={14} />
          <span style={{ flex: 1 }}>{notice}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setNotice(null)}><X size={12} /></button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* MCP Integration Card */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <strong style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>Antigravity (`agy`) MCP Integration</strong>
            {status?.installed ? (
              <span style={{ fontSize: 12, color: 'var(--color-status-green)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <CheckCircle2 size={14} /> Active
              </span>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Not configured</span>
            )}
          </div>

          {status ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div>CLI (`agy`): {status.cliInstalled ? <code>{status.cliPath}</code> : 'not detected on PATH'}</div>
              <div>Config file: <code style={{ wordBreak: 'break-all' }}>{status.configPath}</code> ({status.configExists ? 'exists' : 'missing'})</div>
              {status.hubUrl && <div>Hub URL: <code>{status.hubUrl}</code></div>}
              {status.command && (
                <div>
                  Stdio server: <code>{status.command} {(status.args || []).join(' ')}</code>
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Checking Antigravity status...</div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingTop: 6, borderTop: '1px solid var(--color-border-default)' }}>
            <select className="input" style={{ width: 'auto', fontSize: 12 }} value={mode} onChange={(e) => setMode(e.target.value as 'both' | 'stdio' | 'hub')}>
              <option value="both">Mode: both (stdio + hub)</option>
              <option value="stdio">Mode: stdio only</option>
              <option value="hub">Mode: hub only</option>
            </select>
            <input
              className="input"
              style={{ width: 150, fontSize: 12 }}
              placeholder="MCP profile"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            />
            <button className="btn btn-primary btn-sm" onClick={() => handleAction('activate')} disabled={busy}>
              <Plug size={13} /> Activate
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => handleAction('deactivate')} disabled={busy}>
              <Unplug size={13} /> Deactivate
            </button>
          </div>
        </div>

        {/* Quick CLI Commands Card */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Terminal size={16} style={{ color: 'var(--color-accent)' }} />
            <strong style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>Quick CLI Commands</strong>
          </div>
          {cliCommands.map((cmd) => (
            <div
              key={cmd}
              style={{
                padding: '8px 12px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border-default)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
              }}
            >
              <code style={{ fontSize: 12 }}>{cmd}</code>
              <button className="btn btn-ghost btn-sm" onClick={() => copyCmd(cmd)}>
                <Copy size={12} /> Copy
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

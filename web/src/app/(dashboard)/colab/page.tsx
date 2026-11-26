'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Cloud,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ExternalLink,
  Copy,
  LogIn,
  LogOut,
  Play,
  Square,
  RotateCcw,
  Cpu,
  Coins,
  X,
} from 'lucide-react';
import { detectAppMode, workerFetch } from '@/lib/api-client';

interface ColabDoctorData {
  platform: string;
  supportedPlatform: boolean;
  binary: string;
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  authRequired: boolean;
  email: string | null;
  authProvider: string | null;
  expiresIn: string | null;
  keyringWarning: string | null;
  installHint: string;
  loginGuide: string;
}

interface ColabUsageInfo {
  computeUnitsBalance: number | null;
  usageRatePerHour: number | null;
  activeAssignments: number | null;
}

interface ColabSessionInfo {
  name: string;
  endpoint: string;
  hardware: string;
  shape: string;
  variant: string;
  status: string | null;
  busy: boolean;
  lastExecution: string | null;
}

interface ColabOverviewData {
  doctor: ColabDoctorData | null;
  usage: ColabUsageInfo | null;
  sessions: ColabSessionInfo[];
  activeCount: number;
}

interface PendingLoginState {
  status: string;
  loginId?: string;
  authUrl?: string;
  command?: string;
  keyringWarning?: string | null;
  instructions?: string;
}

const ACCELERATORS = [
  { value: 'CPU', label: 'CPU (Standard)' },
  { value: 'T4', label: 'GPU — NVIDIA T4' },
  { value: 'L4', label: 'GPU — NVIDIA L4' },
  { value: 'G4', label: 'GPU — NVIDIA G4' },
  { value: 'A100', label: 'GPU — NVIDIA A100' },
  { value: 'H100', label: 'GPU — NVIDIA H100' },
  { value: 'v5e1', label: 'TPU — v5e1' },
  { value: 'v6e1', label: 'TPU — v6e1' },
] as const;

export default function ColabPage() {
  const apiBase =
    typeof window !== 'undefined'
      ? detectAppMode().baseUrl || `http://${window.location.hostname}:3100`
      : 'http://localhost:3100';

  const [overview, setOverview] = useState<ColabOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [authMode, setAuthMode] = useState<'oauth2' | 'adc'>('oauth2');
  const [pendingLogin, setPendingLogin] = useState<PendingLoginState | null>(null);
  const [authCode, setAuthCode] = useState('');

  const [newSessionName, setNewSessionName] = useState('');
  const [accel, setAccel] = useState('CPU');
  const [highMem, setHighMem] = useState(false);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = authMode === 'adc' ? '?auth=adc' : '';
      const res = await workerFetch(`${apiBase}/colab/overview${qs}`);
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || 'Failed to load Colab status');
      } else {
        setOverview(json.data as ColabOverviewData);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase, authMode]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${label} to clipboard.`);
    } catch {
      setError(`Could not copy ${label} automatically.`);
    }
  };

  const handleLoginStart = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await workerFetch(`${apiBase}/colab/login/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth: authMode }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || 'Failed to start Colab login');
        return;
      }
      const d = json.data || {};
      if (d.status === 'already_logged_in') {
        setPendingLogin(null);
        setNotice(`Signed in as ${d.email || 'Google account'}.`);
        await fetchOverview();
      } else {
        setPendingLogin({
          status: d.status,
          loginId: d.loginId,
          authUrl: d.authUrl,
          command: d.command,
          keyringWarning: d.keyringWarning,
          instructions: d.instructions,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleLoginComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingLogin?.loginId || !authCode.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await workerFetch(`${apiBase}/colab/login/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: pendingLogin.loginId, code: authCode.trim() }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || 'Failed to complete sign-in');
        return;
      }
      const d = json.data || {};
      setPendingLogin(null);
      setAuthCode('');
      setNotice(
        `Signed in as ${d.email || 'Google user'}` +
          (d.persisted === false ? ' (warning: token was not persisted to OS keyring)' : '.'),
      );
      await fetchOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await workerFetch(`${apiBase}/colab/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth: authMode }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || 'Sign-out failed');
        return;
      }
      setPendingLogin(null);
      setNotice((json.data?.stdout || 'Signed out of Colab CLI.').trim());
      await fetchOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleNewSession = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = { auth: authMode };
      if (newSessionName.trim()) payload.session = newSessionName.trim();
      if (accel === 'v5e1' || accel === 'v6e1') payload.tpu = accel;
      else if (accel !== 'CPU') payload.gpu = accel;
      if (highMem) payload.highMem = true;

      const res = await workerFetch(`${apiBase}/colab/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || 'Failed to launch Colab runtime');
        return;
      }
      setNewSessionName('');
      setNotice('Provisioned Colab runtime.');
      await fetchOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runSessionAction = async (action: 'stop' | 'restart-kernel', body: Record<string, unknown>, label: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await workerFetch(`${apiBase}/colab/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth: authMode, ...body }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || `Failed to ${label}`);
        return;
      }
      setNotice(`Completed: ${label}.`);
      await fetchOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doc = overview?.doctor;
  const usage = overview?.usage;
  const sessions = overview?.sessions || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--color-bg-root)' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Cloud size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>Google Colab</div>
        {doc?.version && (
          <span className="badge" style={{ fontSize: 11 }}>{doc.version}</span>
        )}
        <div style={{ flex: 1 }} />
        <select
          className="input"
          style={{ width: 'auto', fontSize: 12 }}
          value={authMode}
          onChange={(e) => setAuthMode(e.target.value as 'oauth2' | 'adc')}
          aria-label="Colab auth strategy"
        >
          <option value="oauth2">Auth: OAuth2</option>
          <option value="adc">Auth: ADC (gcloud)</option>
        </select>
        <button className="btn btn-ghost btn-sm" onClick={fetchOverview} disabled={loading || busy} title="Refresh">
          <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} /> Refresh
        </button>
      </div>

      {error && (
        <div style={{ margin: '12px 20px 0', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-red)', color: 'var(--color-status-red)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <XCircle size={14} />
          <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{error}</span>
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
        {/* Top grid: Auth + Credits */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
          {/* Auth & Login Card */}
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <strong style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>CLI &amp; Account Authentication</strong>
              {doc?.installed ? (
                doc.loggedIn ? (
                  <span style={{ fontSize: 12, color: 'var(--color-status-green)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <CheckCircle2 size={14} /> Signed in
                  </span>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--color-status-amber, #f59e0b)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <AlertTriangle size={14} /> Auth required
                  </span>
                )
              ) : (
                <span style={{ fontSize: 12, color: 'var(--color-status-red)' }}>Not installed</span>
              )}
            </div>

            {doc ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div>Platform: <code>{doc.platform}</code> · Binary: <code>{doc.binary}</code></div>
                {doc.loggedIn ? (
                  <>
                    <div>Account: <strong style={{ color: 'var(--color-text-primary)' }}>{doc.email || '(unknown)'}</strong></div>
                    <div>Provider: <code>{doc.authProvider || authMode}</code>{doc.expiresIn ? ` · Token TTL: ${doc.expiresIn}` : ''}</div>
                  </>
                ) : (
                  <div>{doc.installed ? doc.loginGuide : doc.installHint}</div>
                )}
                {doc.keyringWarning && (
                  <div style={{ color: 'var(--color-status-amber, #f59e0b)' }}>{doc.keyringWarning}</div>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Loading Colab status...</div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
              {doc?.installed && !doc.loggedIn && (
                <button className="btn btn-primary btn-sm" onClick={handleLoginStart} disabled={busy}>
                  <LogIn size={14} /> Sign in with Google
                </button>
              )}
              {doc?.installed && doc.loggedIn && (
                <>
                  <button className="btn btn-ghost btn-sm" onClick={handleLoginStart} disabled={busy}>
                    <RefreshCw size={14} /> Verify Token
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={handleLogout} disabled={busy}>
                    <LogOut size={14} /> Sign Out
                  </button>
                </>
              )}
            </div>

            {pendingLogin && pendingLogin.status === 'awaiting_code' && pendingLogin.authUrl && (
              <form
                onSubmit={handleLoginComplete}
                style={{
                  marginTop: 8,
                  padding: 12,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-bg-elevated)',
                  border: '1px solid var(--color-border-default)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--color-text-primary)', fontWeight: 500 }}>
                  1. Open Google sign-in and copy the authorization code:
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <a
                    className="btn btn-primary btn-sm"
                    href={pendingLogin.authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={13} /> Open Google Sign-In
                  </a>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => copyText(pendingLogin.authUrl!, 'sign-in URL')}
                  >
                    <Copy size={13} /> Copy URL
                  </button>
                </div>
                {pendingLogin.keyringWarning && (
                  <div style={{ fontSize: 11, color: 'var(--color-status-amber, #f59e0b)' }}>
                    {pendingLogin.keyringWarning}
                  </div>
                )}
                <div style={{ fontSize: 12, color: 'var(--color-text-primary)', fontWeight: 500, marginTop: 4 }}>
                  2. Paste authorization code:
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                    placeholder="4/0A..."
                    value={authCode}
                    onChange={(e) => setAuthCode(e.target.value)}
                    autoFocus
                  />
                  <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !authCode.trim()}>
                    Complete Sign-In
                  </button>
                </div>
              </form>
            )}

            {pendingLogin && pendingLogin.status === 'adc_setup_required' && pendingLogin.command && (
              <div
                style={{
                  marginTop: 8,
                  padding: 12,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-bg-elevated)',
                  border: '1px solid var(--color-border-default)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  fontSize: 12,
                }}
              >
                <div>Run on the Linux/macOS node:</div>
                <code style={{ wordBreak: 'break-all' }}>{pendingLogin.command}</code>
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => copyText(pendingLogin.command!, 'gcloud command')}
                  >
                    <Copy size={13} /> Copy Command
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Credits / Compute Units Card */}
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Coins size={16} style={{ color: 'var(--color-accent)' }} />
              <strong style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>Compute Units &amp; Usage Rate</strong>
            </div>
            {doc?.loggedIn && usage ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 4 }}>
                <div style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)' }}>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>Credits Available</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                    {usage.computeUnitsBalance !== null ? usage.computeUnitsBalance.toFixed(2) : '—'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>compute units</div>
                </div>
                <div style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)' }}>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>Burn Rate</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                    {usage.usageRatePerHour !== null ? usage.usageRatePerHour.toFixed(2) : '—'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>units / hr</div>
                </div>
                <div style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)' }}>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>Active Runtimes</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                    {usage.activeAssignments !== null ? usage.activeAssignments : sessions.length}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>assignments</div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                {doc?.loggedIn ? 'Loading compute-unit balance...' : 'Sign in to query available Colab compute units and burn rate.'}
              </div>
            )}
          </div>
        </div>

        {/* Running Instances Card */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Cpu size={16} style={{ color: 'var(--color-accent)' }} />
              <strong style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>
                Running Instances ({overview?.activeCount ?? sessions.length})
              </strong>
            </div>
            {doc?.loggedIn && sessions.length > 0 && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ color: 'var(--color-status-red)' }}
                disabled={busy}
                onClick={() => runSessionAction('stop', { all: true }, 'stop all sessions')}
              >
                <Square size={13} /> Stop All
              </button>
            )}
          </div>

          {sessions.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', padding: '8px 0' }}>
              {doc?.loggedIn ? 'No active Colab VM runtimes running.' : 'Sign in to inspect and manage active Colab runtimes.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sessions.map((s) => (
                <div
                  key={s.endpoint || s.name}
                  style={{
                    padding: 12,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-border-default)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>{s.name}</strong>
                      <span className="badge" style={{ fontSize: 11 }}>{s.hardware}</span>
                      <span className="badge" style={{ fontSize: 11 }}>{s.shape}</span>
                      {s.status && (
                        <span
                          className="badge"
                          style={{
                            fontSize: 11,
                            color: s.busy ? 'var(--color-status-amber, #f59e0b)' : 'var(--color-status-green)',
                          }}
                        >
                          {s.status}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                      Variant: {s.variant} · Endpoint: <code>{s.endpoint}</code>
                    </div>
                    {s.lastExecution && (
                      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        Last execution: {s.lastExecution}
                      </div>
                    )}
                  </div>
                  {s.name !== '?' && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => runSessionAction('restart-kernel', { session: s.name }, `restart kernel ${s.name}`)}
                      >
                        <RotateCcw size={13} /> Restart Kernel
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ color: 'var(--color-status-red)' }}
                        disabled={busy}
                        onClick={() => runSessionAction('stop', { session: s.name }, `stop ${s.name}`)}
                      >
                        <Square size={13} /> Stop
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {doc?.loggedIn && (
            <form
              onSubmit={handleNewSession}
              style={{
                marginTop: 6,
                paddingTop: 12,
                borderTop: '1px solid var(--color-border-default)',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 10,
                alignItems: 'center',
              }}
            >
              <input
                className="input"
                style={{ width: 160, fontSize: 12 }}
                placeholder="Session name (optional)"
                value={newSessionName}
                onChange={(e) => setNewSessionName(e.target.value)}
              />
              <select
                className="input"
                style={{ width: 180, fontSize: 12 }}
                value={accel}
                onChange={(e) => setAccel(e.target.value)}
              >
                {ACCELERATORS.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                <input type="checkbox" checked={highMem} onChange={(e) => setHighMem(e.target.checked)} />
                High-RAM
              </label>
              <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
                <Play size={13} /> Launch Runtime
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

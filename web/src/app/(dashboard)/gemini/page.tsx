'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Sparkles,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Globe,
  Send,
  Trash2,
  ExternalLink,
  Terminal,
  MessageSquare,
  X,
} from 'lucide-react';
import { detectAppMode, workerFetch } from '@/lib/api-client';

interface GeminiLoginStatus {
  ok: boolean;
  port: number;
  loggedIn: boolean;
  email: string | null;
  policyName: string | null;
  modelCount: number | null;
  reason: string;
  hint: string;
  pageUrl: string | null;
}

interface GeminiModelItem {
  id?: string | null;
  name?: string | null;
  description?: string | null;
}

interface GeminiConvItem {
  id: string;
  bareId: string;
  title?: string | null;
}

interface GeminiOverviewData {
  status: GeminiLoginStatus;
  models: GeminiModelItem[];
  conversations: GeminiConvItem[];
  usage: { features?: Array<{ featureId?: unknown; enabled?: boolean; limit?: unknown; used?: unknown }> } | null;
}

interface IdeMcpStatus {
  installed: boolean;
  configPath: string;
  configExists: boolean;
  desktopConfigPath?: string | null;
  desktopConfigExists?: boolean;
  command?: string;
  args?: string[];
  cliInstalled?: boolean;
  cliPath?: string | null;
  appInstalled?: boolean;
  appPath?: string | null;
  mode?: string;
  hubUrl?: string | null;
}

interface SendResult {
  conversationId?: string | null;
  responseId?: string | null;
  text?: string;
  url?: string;
  domMedia?: {
    imgs?: Array<{ src: string; alt: string; w: number; h: number }>;
    videos?: Array<{ tag: string; src: string; poster: string }>;
  };
  attachments?: Array<{ url: string; kind?: string }>;
}

const TOOL_OPTIONS = ['', 'Create image', 'Create video', 'Create music', 'Canvas'] as const;
const THINKING_OPTIONS = [
  { value: '', label: 'Thinking: default' },
  { value: 'low', label: 'Thinking: low' },
  { value: 'standard', label: 'Thinking: standard' },
  { value: 'medium', label: 'Thinking: medium' },
  { value: 'high', label: 'Thinking: high' },
] as const;

export default function GeminiPage() {
  const apiBase =
    typeof window !== 'undefined'
      ? detectAppMode().baseUrl || `http://${window.location.hostname}:3100`
      : 'http://localhost:3100';

  const [cdpPort, setCdpPort] = useState(9225);
  const [profileName, setProfileName] = useState('default');
  const [overview, setOverview] = useState<GeminiOverviewData | null>(null);
  const [mcpStatus, setMcpStatus] = useState<IdeMcpStatus | null>(null);
  const [mcpMode, setMcpMode] = useState<'both' | 'stdio' | 'hub'>('both');
  const [mcpProfile, setMcpProfile] = useState('');

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedModel, setSelectedModel] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [selectedTool, setSelectedTool] = useState('');
  const [targetConvId, setTargetConvId] = useState('');
  const [createNew, setCreateNew] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [sendResult, setSendResult] = useState<SendResult | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ovRes, mcpRes] = await Promise.all([
        workerFetch(`${apiBase}/gemini-web/browser/overview?port=${encodeURIComponent(String(cdpPort))}&limit=20`).catch(() => null),
        workerFetch(`${apiBase}/claude-code/ide-mcp/gemini-cli`).catch(() => null),
      ]);
      if (ovRes) {
        const j = await ovRes.json();
        if (j.success && j.data) setOverview(j.data as GeminiOverviewData);
      }
      if (mcpRes) {
        const m = await mcpRes.json();
        if (m.success && m.data) setMcpStatus(m.data as IdeMcpStatus);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase, cdpPort]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleOpenLogin = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await workerFetch(`${apiBase}/gemini-web/browser/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: profileName.trim() || 'default', port: cdpPort, headless: false }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || 'Failed to launch Gemini login browser');
      } else {
        setNotice(json.data?.hint || 'Gemini browser ready.');
        await loadAll();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleMcpAction = async (op: 'activate' | 'deactivate') => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await workerFetch(`${apiBase}/claude-code/ide-mcp/gemini-cli/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: mcpMode,
          ...(mcpProfile.trim() ? { profile: mcpProfile.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || `Failed to ${op} Gemini MCP`);
      } else {
        setMcpStatus(json.data as IdeMcpStatus);
        setNotice(`Gemini CLI/App MCP ${op}d.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> = {
        port: cdpPort,
        prompt: prompt.trim(),
        createNew: targetConvId.trim() ? false : createNew,
      };
      if (targetConvId.trim()) body.convId = targetConvId.trim();
      if (selectedModel) body.model = selectedModel;
      if (thinkingLevel) body.thinkingLevel = thinkingLevel;
      if (selectedTool) body.tool = selectedTool;

      const res = await workerFetch(`${apiBase}/gemini-web/browser/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || 'Gemini send failed');
        return;
      }
      setSendResult(json.data as SendResult);
      if (json.data?.conversationId) setTargetConvId(json.data.conversationId);
      setCreateNew(false);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteConv = async (convId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await workerFetch(`${apiBase}/gemini-web/browser/conversations/${encodeURIComponent(convId)}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: cdpPort }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || `Failed to delete ${convId}`);
      } else {
        setNotice(`Deleted ${convId}`);
        if (targetConvId === convId) setTargetConvId('');
        await loadAll();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const st = overview?.status;
  const models = overview?.models || [];
  const convs = overview?.conversations || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--color-bg-root)' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Sparkles size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>Google Gemini</div>
        {st?.policyName && <span className="badge" style={{ fontSize: 11 }}>{st.policyName}</span>}
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          CDP Port
          <input
            className="input"
            type="number"
            style={{ width: 82, fontSize: 12 }}
            value={cdpPort}
            onChange={(e) => setCdpPort(Number(e.target.value) || 9225)}
          />
        </label>
        <button className="btn btn-ghost btn-sm" onClick={loadAll} disabled={loading || busy}>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
          {/* Gemini Web Browser Card */}
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Globe size={16} style={{ color: 'var(--color-accent)' }} />
                <strong style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>Gemini Web Browser</strong>
              </div>
              {st?.loggedIn ? (
                <span style={{ fontSize: 12, color: 'var(--color-status-green)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CheckCircle2 size={14} /> Signed in
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--color-status-amber, #f59e0b)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <AlertTriangle size={14} /> {st?.reason || 'Not connected'}
                </span>
              )}
            </div>

            {st ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {st.loggedIn && (
                  <div>Account: <strong style={{ color: 'var(--color-text-primary)' }}>{st.email || '(signed in)'}</strong></div>
                )}
                <div>Port: <code>{st.port}</code>{st.modelCount !== null ? ` · Models: ${st.modelCount}` : ''}</div>
                {st.pageUrl && <div>Tab: <code style={{ wordBreak: 'break-all' }}>{st.pageUrl}</code></div>}
                <div>{st.hint}</div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Checking browser status...</div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
              <input
                className="input"
                style={{ width: 140, fontSize: 12 }}
                placeholder="Profile name"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
              />
              <button className="btn btn-primary btn-sm" onClick={handleOpenLogin} disabled={busy}>
                Open Login Browser
              </button>
            </div>
          </div>

          {/* Gemini CLI & Desktop App MCP Card */}
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Terminal size={16} style={{ color: 'var(--color-accent)' }} />
                <strong style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>Gemini CLI &amp; Desktop MCP</strong>
              </div>
              {mcpStatus?.installed ? (
                <span style={{ fontSize: 12, color: 'var(--color-status-green)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CheckCircle2 size={14} /> Configured ({mcpStatus.mode})
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Not configured</span>
              )}
            </div>

            {mcpStatus && (
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div>CLI: {mcpStatus.cliInstalled ? <code>{mcpStatus.cliPath}</code> : 'not detected'}</div>
                {mcpStatus.appPath && <div>Desktop App: <code>{mcpStatus.appPath}</code></div>}
                <div>Config: <code style={{ wordBreak: 'break-all' }}>{mcpStatus.configPath}</code></div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
              <select className="input" style={{ width: 'auto', fontSize: 12 }} value={mcpMode} onChange={(e) => setMcpMode(e.target.value as 'both' | 'stdio' | 'hub')}>
                <option value="both">Mode: both (stdio + hub)</option>
                <option value="stdio">Mode: stdio only</option>
                <option value="hub">Mode: hub only</option>
              </select>
              <input
                className="input"
                style={{ width: 120, fontSize: 12 }}
                placeholder="profile (opt)"
                value={mcpProfile}
                onChange={(e) => setMcpProfile(e.target.value)}
              />
              <button className="btn btn-primary btn-sm" onClick={() => handleMcpAction('activate')} disabled={busy}>
                Activate
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => handleMcpAction('deactivate')} disabled={busy}>
                Deactivate
              </button>
            </div>
          </div>
        </div>

        {/* Prompt & Media Composer */}
        {st?.loggedIn && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <strong style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>Prompt &amp; Media Composer</strong>
            <form onSubmit={handleSend} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <select className="input" style={{ width: 190, fontSize: 12 }} value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>
                  <option value="">Model: current</option>
                  {models.map((m, idx) => (
                    <option key={m.id || m.name || idx} value={String(m.name || m.id || '')}>
                      {m.name || m.id}
                    </option>
                  ))}
                </select>
                <select className="input" style={{ width: 170, fontSize: 12 }} value={thinkingLevel} onChange={(e) => setThinkingLevel(e.target.value)}>
                  {THINKING_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                <select className="input" style={{ width: 170, fontSize: 12 }} value={selectedTool} onChange={(e) => setSelectedTool(e.target.value)}>
                  {TOOL_OPTIONS.map((t) => (
                    <option key={t} value={t}>{t ? `Tool: ${t}` : 'Tool: none'}</option>
                  ))}
                </select>
                <input
                  className="input"
                  style={{ width: 180, fontSize: 12, fontFamily: 'monospace' }}
                  placeholder="convId (blank = new)"
                  value={targetConvId}
                  onChange={(e) => setTargetConvId(e.target.value)}
                />
                {!targetConvId.trim() && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    <input type="checkbox" checked={createNew} onChange={(e) => setCreateNew(e.target.checked)} />
                    New chat
                  </label>
                )}
              </div>
              <textarea
                className="input"
                rows={3}
                style={{ width: '100%', fontSize: 13 }}
                placeholder="Ask Gemini or describe an image/video..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div>
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !prompt.trim()}>
                  <Send size={13} /> Send via CDP
                </button>
              </div>
            </form>

            {sendResult && (
              <div style={{ marginTop: 6, padding: 12, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  Conversation: <code>{sendResult.conversationId || 'unknown'}</code>
                  {sendResult.responseId ? <> · Response: <code>{sendResult.responseId}</code></> : null}
                </div>
                <div style={{ fontSize: 13, color: 'var(--color-text-primary)', whiteSpace: 'pre-wrap' }}>
                  {sendResult.text || '(no text)'}
                </div>
                {(sendResult.attachments?.length || 0) > 0 && (
                  <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <strong>Media / Attachments:</strong>
                    {sendResult.attachments!.map((a, i) => (
                      <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)' }}>
                        {a.url}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Recent Conversations */}
        {st?.loggedIn && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <MessageSquare size={16} style={{ color: 'var(--color-accent)' }} />
              <strong style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>
                Recent Gemini Conversations ({convs.length})
              </strong>
            </div>
            {convs.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>No conversations found.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {convs.map((c) => (
                  <div
                    key={c.id}
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
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                        {c.title || c.id}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        <code>{c.id}</code>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setTargetConvId(c.id);
                          setCreateNew(false);
                        }}
                      >
                        Reply here
                      </button>
                      <a
                        className="btn btn-ghost btn-sm"
                        href={`https://gemini.google.com/app/${c.bareId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink size={12} />
                      </a>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ color: 'var(--color-status-red)' }}
                        disabled={busy}
                        onClick={() => handleDeleteConv(c.id)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

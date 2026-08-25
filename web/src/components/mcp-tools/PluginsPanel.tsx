'use client';

import { useCallback, useEffect, useState } from 'react';
import { Puzzle, ShieldAlert, RefreshCw } from 'lucide-react';
import { ConfirmButton, errText, timeAgo } from '@/components/memory/format';
import {
  capabilitySummary, enableAction, needsReapproval, phaseBadge, shortChecksum, summarizePluginCounts,
  trustSource,
  type PluginAuditEntry, type PluginListResponse, type PluginView,
} from '@/lib/mcp-plugins';

const TONE: Record<string, { color: string; border: string; background: string }> = {
  green: { color: 'rgba(52,211,153,0.95)', border: '1px solid rgba(52,211,153,0.4)', background: 'rgba(52,211,153,0.08)' },
  amber: { color: 'rgba(251,191,36,0.95)', border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.08)' },
  red: { color: 'rgba(248,113,113,0.95)', border: '1px solid rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.08)' },
  grey: { color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border-default)', background: 'transparent' },
};

const PANEL: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border-default)',
  background: 'var(--color-bg-elevated)',
};

const MONO: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  color: 'var(--color-text-secondary)', margin: 0,
};

interface Props {
  apiFetch: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
}

/**
 * Third-party MCP plugins on this node: what is installed, what it asked for, and the
 * enable decision. Enabling authorises third-party code execution, so the write
 * endpoints are loopback-only server-side — over the LAN or the hub relay the buttons
 * come back FORBIDDEN by design, and we say so rather than hiding them.
 */
export function PluginsPanel({ apiFetch }: Props) {
  const [data, setData] = useState<PluginListResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [audit, setAudit] = useState<PluginAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const body = await apiFetch<PluginListResponse | { data?: PluginListResponse }>('/mcp-plugins');
      setData(((body as { data?: PluginListResponse }).data ?? body) as PluginListResponse);
    } catch (e) {
      setError(errText(e));
    }
  }, [apiFetch]);

  useEffect(() => { void load(); }, [load]);

  const loadAudit = useCallback(async (name: string) => {
    try {
      const body = await apiFetch<{ entries?: PluginAuditEntry[] } | { data?: { entries?: PluginAuditEntry[] } }>(
        `/mcp-plugins/${encodeURIComponent(name)}/audit?limit=25`,
      );
      const unwrapped = (body as { data?: { entries?: PluginAuditEntry[] } }).data ?? body;
      setAudit((unwrapped as { entries?: PluginAuditEntry[] }).entries ?? []);
    } catch {
      setAudit([]);
    }
  }, [apiFetch]);

  const act = async (name: string, action: 'enable' | 'disable', body?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/mcp-plugins/${encodeURIComponent(name)}/${action}`, { method: 'POST', body: body ?? {} });
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const plugins = data?.plugins ?? [];
  const counts = summarizePluginCounts(plugins);
  const current = plugins.find((p) => p.name === selected) ?? null;

  if (!data) {
    return (
      <div style={{ padding: 20, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
        {error ?? 'Loading plugins…'}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Puzzle size={15} style={{ color: 'var(--color-accent)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>Third-party plugins</span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          {counts.total} installed · {counts.enabled} enabled · {counts.needsReview} awaiting review
        </span>
        <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => void load()}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {!data.subsystemEnabled && (
        <div style={{ ...PANEL, ...TONE.amber, fontSize: 12 }}>
          The plugin subsystem is switched off on this node (<code>LM_MCP_PLUGINS=0</code>). No plugin tool is advertised
          and no plugin can run, whatever its individual state says.
        </div>
      )}

      {error && <div style={{ ...PANEL, ...TONE.red, fontSize: 12 }}>{error}</div>}

      {plugins.length === 0 ? (
        <div style={{ ...PANEL, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          No plugins installed. Drop a plugin directory into the node&apos;s <code>mcp-plugins</code> folder; it is parsed
          and listed here <b>disabled</b> — nothing runs until you enable it. Plugins marked <b>bundled</b> are the
          exception: they ship inside lm-assist and are installed and enabled on boot, as long as their files are
          exactly the ones this build shipped.
        </div>
      ) : (
        plugins.map((p) => {
          const badge = phaseBadge(p);
          const action = enableAction(p);
          const isOpen = selected === p.name;
          return (
            <div key={p.name} style={{ ...PANEL }}>
              <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-text-primary)' }}>{p.name}</span>
                <span className="badge" style={{ fontSize: 9, ...TONE[badge.tone] }} title={badge.hint}>{badge.label}</span>
                {p.version && <span className="badge badge-outline" style={{ fontSize: 9 }}>v{p.version}</span>}
                {needsReapproval(p) && (
                  <span className="badge" style={{ fontSize: 9, ...TONE.amber }} title="The payload changed after approval, so it was auto-reverted to disabled.">
                    payload changed
                  </span>
                )}
                {p.bundled && (
                  <span
                    className="badge badge-outline"
                    style={{ fontSize: 9 }}
                    title={
                      'Ships inside the lm-assist package and is installed on every boot. It auto-enables only while the files on disk are exactly the ones this build shipped.'
                      + (p.bundledMirror ? ' It is a mirror of a payload maintained in its own repository — change it there, not here.' : '')
                    }
                  >
                    {p.bundledMirror ? 'bundled mirror' : 'bundled'}
                  </span>
                )}
                {p.bundledModified && (
                  <span className="badge" style={{ fontSize: 9, ...TONE.amber }} title="The package ships this plugin, but the files here are not the ones it seeded. Upgrades will leave this tree alone, and it does not inherit package trust.">
                    locally modified
                  </span>
                )}
                {trustSource(p) === 'package' && (
                  <span
                    className="badge badge-outline"
                    style={{ fontSize: 9 }}
                    title={`Trusted because it arrived in this package (${p.enabledBy}), not because someone reviewed it here.`}
                  >
                    trusted by package
                  </span>
                )}
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ marginLeft: 'auto', fontSize: 11 }}
                  onClick={() => { setSelected(isOpen ? null : p.name); if (!isOpen) void loadAudit(p.name); }}
                >
                  {isOpen ? 'Hide' : 'Review'}
                </button>
              </div>

              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                {p.description || '(no description)'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
                {p.tools.length} tool{p.tools.length === 1 ? '' : 's'} · {capabilitySummary(p.capabilities)} ·
                {' '}payload {shortChecksum(p.payloadChecksum)}
              </div>
              {badge.tone !== 'green' && (
                <div style={{ fontSize: 11, color: TONE[badge.tone].color, marginTop: 4 }}>{badge.hint}</div>
              )}

              {isOpen && current && current.name === p.name && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                      TOOLS IT WOULD ADVERTISE (namespaced — no built-in can be shadowed)
                    </div>
                    <div style={{ ...PANEL, background: 'var(--color-bg-root)' }}>
                      {p.tools.map((t) => (
                        <div key={t.name} style={{ marginBottom: 4 }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-primary)' }}>
                            ext__{p.name}__{t.name}
                          </span>
                          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{t.description}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                      DECLARED CAPABILITIES — what it says it needs
                    </div>
                    <div style={{ ...PANEL, background: 'var(--color-bg-root)' }}>
                      <pre style={MONO}>{[
                        `network : ${p.capabilities.network.length ? p.capabilities.network.join(', ') : '(none)'}`,
                        `fs      : ${p.capabilities.fs.length ? p.capabilities.fs.join(', ') : '(none)'}`,
                        `env     : ${p.capabilities.env.length ? p.capabilities.env.join(', ') : '(none)'}`,
                        `granted : ${p.grantedEnv.length ? p.grantedEnv.join(', ') : '(none)'}`,
                        `entry   : ${p.entry ? `${p.entry.command} ${p.entry.args.join(' ')}` : '(unknown)'}`,
                      ].join('\n')}</pre>
                      <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
                        Network and fs entries are declarations reviewed and pinned at approval — this build does not
                        sandbox the subprocess at the OS level. Environment is enforced: the child inherits nothing, and
                        only granted names are passed.
                      </div>
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                      PIN
                    </div>
                    <div style={{ ...PANEL, background: 'var(--color-bg-root)' }}>
                      <pre style={MONO}>{[
                        `on disk  : ${p.payloadChecksum ?? '(unhashable)'}`,
                        `approved : ${p.approvedChecksum ?? '(never approved)'}`,
                        `matches  : ${p.pinMatches ? 'yes' : 'no'}`,
                        p.enabledAt ? `enabled  : ${timeAgo(p.enabledAt)}${p.enabledBy ? ` by ${p.enabledBy}` : ''}` : '',
                        p.bundledMirror ? 'mirror   : maintained in its own repo — edit it there, not here' : '',
                        p.bundledOptOut ? 'bundled  : you turned this off — upgrades will leave it off' : '',
                      ].filter(Boolean).join('\n')}</pre>
                    </div>
                  </div>

                  {p.manifestErrors.length > 0 && (
                    <div style={{ ...PANEL, ...TONE.red }}>
                      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>MANIFEST ERRORS</div>
                      <pre style={{ ...MONO, color: TONE.red.color }}>{p.manifestErrors.join('\n')}</pre>
                    </div>
                  )}

                  <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {action.canEnable && (
                      <ConfirmButton
                        label={action.label}
                        confirmLabel={`Run third-party code from "${p.name}"?`}
                        onConfirm={() => void act(p.name, 'enable', { expectedChecksum: p.payloadChecksum })}
                        className="btn btn-sm btn-primary"
                      />
                    )}
                    {p.phase === 'enabled' && (
                      <ConfirmButton
                        label="Disable plugin"
                        confirmLabel={`Really disable ${p.name}?`}
                        onConfirm={() => void act(p.name, 'disable')}
                        className="btn btn-sm btn-ghost"
                      />
                    )}
                    {!action.canEnable && action.note && (
                      <span style={{ fontSize: 11, color: TONE.red.color }}>{action.note}</span>
                    )}
                    <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <ShieldAlert size={11} /> enable/disable are owner actions — only accepted from this machine
                    </span>
                    {busy && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>working…</span>}
                  </div>

                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                      AUDIT TAIL (arguments are digested, never recorded verbatim)
                    </div>
                    {audit.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>No calls recorded.</div>
                    ) : (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                        <thead>
                          <tr style={{ textAlign: 'left', color: 'var(--color-text-tertiary)' }}>
                            <th style={{ padding: '3px 6px' }}>when</th>
                            <th style={{ padding: '3px 6px' }}>tool</th>
                            <th style={{ padding: '3px 6px' }}>args</th>
                            <th style={{ padding: '3px 6px' }}>ms</th>
                            <th style={{ padding: '3px 6px' }}>outcome</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...audit].reverse().map((e, i) => (
                            <tr key={`${e.ts}-${i}`} style={{ borderTop: '1px solid var(--color-border-default)' }}>
                              <td style={{ padding: '3px 6px', color: 'var(--color-text-secondary)' }}>{timeAgo(Date.parse(e.ts))}</td>
                              <td style={{ padding: '3px 6px', fontFamily: 'var(--font-mono)' }}>{e.tool}</td>
                              <td style={{ padding: '3px 6px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{e.argDigest}</td>
                              <td style={{ padding: '3px 6px' }}>{e.durationMs}</td>
                              <td style={{ padding: '3px 6px', color: e.outcome === 'ok' ? TONE.green.color : TONE.amber.color }}>{e.outcome}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

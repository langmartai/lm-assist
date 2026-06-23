'use client';

/**
 * Memory settings tab — cross-project signpost + cross-node memory sync toggles, plus a read-only
 * sync-status block. All local to this node. Talks to the worker's /project-settings (GET/PUT) and
 * /memory/sync/status via workerFetch (carries the api-token; raw fetch would 401 in hub mode).
 */

import { useCallback, useEffect, useState } from 'react';
import { workerFetch } from '@/lib/api-client';

interface Settings { memorySyncEnabled: boolean; crossProjectSignpostEnabled: boolean }
interface SyncStatus {
  config: { nodeMode: string; homeNode: string | null; project: string | null; homeProject: string | null };
  daemon: { mode: string; running: boolean; counts: Record<string, number> };
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${on ? 'bg-emerald-600' : 'bg-gray-600'} ${disabled ? 'opacity-50' : ''}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

function ToggleRow({ label, desc, on, onClick, disabled }: { label: string; desc: string; on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="text-gray-100 font-medium">{label}</div>
        <div className="text-gray-400 text-xs mt-0.5 max-w-md">{desc}</div>
      </div>
      <Toggle on={on} onClick={onClick} disabled={disabled} />
    </div>
  );
}

export default function MemoryTab({ baseUrl }: { baseUrl: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [s, st] = await Promise.all([
        workerFetch(`${baseUrl}/project-settings`).then((r) => r.json()),
        workerFetch(`${baseUrl}/memory/sync/status`).then((r) => r.json()).catch(() => null),
      ]);
      if (s?.success) {
        setSettings({ memorySyncEnabled: !!s.data.memorySyncEnabled, crossProjectSignpostEnabled: !!s.data.crossProjectSignpostEnabled });
      }
      if (st?.success) setStatus(st.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load');
    }
  }, [baseUrl]);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (key: keyof Settings) => {
    if (!settings || saving) return;
    setSaving(true);
    setErr(null);
    const prev = settings;
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next); // optimistic
    try {
      const r = await workerFetch(`${baseUrl}/project-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next[key] }),
      }).then((x) => x.json());
      if (!r?.success) throw new Error(r?.error?.message || 'save failed');
      setSettings({ memorySyncEnabled: !!r.data.memorySyncEnabled, crossProjectSignpostEnabled: !!r.data.crossProjectSignpostEnabled });
      void load(); // daemon mode / status may have changed
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save failed');
      setSettings(prev); // revert
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return <div className="text-sm text-gray-400">{err ? `Error: ${err}` : 'Loading…'}</div>;

  return (
    <div className="space-y-5 text-sm">
      <div>
        <h3 className="text-base font-semibold text-gray-100 mb-1">Memory</h3>
        <p className="text-gray-400">Cross-project and cross-node memory. These run locally on this node.</p>
      </div>

      <ToggleRow
        label="Cross-project signpost"
        desc="Write a managed _cross-project.md into every project's memory so a session knows it can reach other projects' memory via the langmart MCP."
        on={settings.crossProjectSignpostEnabled}
        onClick={() => toggle('crossProjectSignpostEnabled')}
        disabled={saving}
      />

      <ToggleRow
        label="Cross-node memory sync"
        desc="Sync curated project memory between your nodes that share a git remote — persistent peers converge via auto-merge; cloud workers push back to home. Safe no-op until peers exist."
        on={settings.memorySyncEnabled}
        onClick={() => toggle('memorySyncEnabled')}
        disabled={saving}
      />

      {status && (
        <div className="rounded border border-gray-700 bg-gray-900/40 p-3 space-y-1">
          <div className="text-gray-300 font-medium">Sync status (this node)</div>
          <div className="text-gray-400">Node mode: <span className="text-gray-200">{status.config.nodeMode}</span> · Daemon: <span className="text-gray-200">{status.daemon.mode}{status.daemon.running ? '' : ' (stopped)'}</span></div>
          <div className="text-gray-400">Home: <span className="text-gray-200">{status.config.homeNode || '—'}</span> · Project: <span className="text-gray-200">{status.config.project || '—'}</span></div>
          <div className="text-gray-400">Pushed {status.daemon.counts?.pushed ?? 0} · Refreshed {status.daemon.counts?.fetched ?? 0} · Errors {status.daemon.counts?.errors ?? 0}</div>
        </div>
      )}

      {err && <div className="text-rose-400 text-xs">{err}</div>}
      <button onClick={() => void load()} className="text-xs text-gray-400 hover:text-gray-200">Refresh</button>
    </div>
  );
}

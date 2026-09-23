'use client';

/**
 * Backup › Export — choose sections (datasets + config on by default; replicas, knowledge and
 * Claude memory/rules opt-in), add a note, create a bundle on the selected node. The result
 * shows what went in, what was left out and why, and how to move the bundle. Below it, the
 * built-in `data-snapshot` job (ships disabled) can be switched on for this node.
 */

import { useEffect, useState } from 'react';
import { Archive, CalendarClock, FileSearch } from 'lucide-react';
import {
  DEFAULT_EXPORT_SELECTION, NOTE_MAX, canExport, exportBody, formatBytes, formatInterval, toBundleApiError,
  type BundleApiError, type BundlesApi, type ExportResult, type ExportSelection, type Inventory, type SnapshotJob,
} from '@/lib/data-bundles';
import { formatTimeAgo } from '@/lib/utils';
import { ErrorBanner, Notice, Panel, Spinner, attempt, dim, labelStyle, mono, muted } from './shared';

export function ExportPanel({ api, inventory, nodeLabel, onCreated, onPlan }: {
  api: BundlesApi;
  inventory: Inventory | null;
  nodeLabel: string;
  onCreated: () => void;
  onPlan: (bundleId: string) => void;
}) {
  const [sel, setSel] = useState<ExportSelection>(DEFAULT_EXPORT_SELECTION);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BundleApiError | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);

  // undefined = loading · null = this node's build has no data-snapshot job
  const [job, setJob] = useState<SnapshotJob | null | undefined>(undefined);
  const [jobBusy, setJobBusy] = useState(false);
  const [jobError, setJobError] = useState<BundleApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.snapshotJob()
      .then((j) => { if (!cancelled) setJob(j); })
      .catch((e) => { if (!cancelled) { setJob(null); setJobError(toBundleApiError(e)); } });
    return () => { cancelled = true; };
  }, [api]);

  const toggleJob = async () => {
    if (!job) return;
    setJobBusy(true);
    setJobError(null);
    const r = await attempt(() => api.setSnapshotEnabled(!job.enabled), setJobError);
    setJobBusy(false);
    if (r) setJob(r);
  };

  const set = (patch: Partial<ExportSelection>) => setSel((s) => ({ ...s, ...patch }));
  const ds = inventory?.datasets ?? [];
  const nDefault = ds.filter((d) => d.export === 'default').length;
  const nReplica = ds.filter((d) => d.export === 'opt-in').length;
  const configTitles = inventory?.sections.config.map((c) => c.title).join(', ');
  const ok = canExport(sel) && !busy;

  const create = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const r = await attempt(() => api.create(exportBody(sel)), setError);
    setBusy(false);
    if (r) {
      setResult(r);
      onCreated();
    }
  };

  const box = (checked: boolean, onChange: (v: boolean) => void, title: string, hint: string, disabled = false) => (
    <label style={{ ...labelStyle, display: 'flex', gap: 8, alignItems: 'flex-start', opacity: disabled ? 0.5 : 1 }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2 }} />
      <span><span style={{ color: 'var(--color-text-primary)' }}>{title}</span><br /><span style={muted}>{hint}</span></span>
    </label>
  );

  return (
    <div>
      <Panel title={`Create a bundle on ${nodeLabel}`} icon={<Archive size={14} style={{ color: 'var(--color-accent)' }} />}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, marginBottom: 12 }}>
          {box(sel.datasets, (v) => set({ datasets: v }), 'Datasets',
            inventory ? `${nDefault} owned dataset${nDefault === 1 ? '' : 's'}, raw with tombstones` : 'every owned non-system dataset, raw with tombstones')}
          {box(sel.config, (v) => set({ config: v }), 'Config',
            configTitles ? `sanitized: ${configTitles}` : 'sanitized host-local config (secret-named keys dropped and listed)')}
          {box(sel.includeReplicas, (v) => set({ includeReplicas: v }), 'Include replicas',
            inventory ? `${nReplica} read-only replica${nReplica === 1 ? '' : 's'} of other nodes' datasets` : 'read-only copies of other nodes\' datasets', !sel.datasets)}
          {box(sel.includeKnowledge, (v) => set({ includeKnowledge: v }), 'Knowledge base', 'knowledge files (*.md, index, comments)')}
          {box(sel.includeClaudeMemory, (v) => set({ includeClaudeMemory: v }), 'Claude memory + rules', 'project memory and own rules under ~/.claude (synced.* mirrors excluded)')}
        </div>
        <label style={{ ...labelStyle, display: 'block', marginBottom: 12 }}>
          Note <span style={muted}>(optional, ≤ {NOTE_MAX} chars)</span>
          <input className="input" style={{ marginTop: 4 }} value={sel.note} maxLength={NOTE_MAX} placeholder="e.g. before upgrade"
            onChange={(e) => set({ note: e.target.value })} />
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-primary btn-sm" disabled={!ok} style={dim(!ok)} onClick={create}>
            {busy ? <Spinner size={12} /> : <Archive size={12} />} Create bundle
          </button>
          <span style={muted}>Secrets and node identity never go into a bundle. The file is written 0600 on the node and holds private data.</span>
        </div>
      </Panel>

      <ErrorBanner error={error} onClose={() => setError(null)} />

      {result && (
        <Panel title={<>Created <span style={mono}>{result.bundleId}</span></>} icon={<Archive size={14} style={{ color: 'var(--color-status-green)' }} />}
          actions={<button className="btn btn-secondary btn-sm" onClick={() => onPlan(result.bundleId)}><FileSearch size={12} /> Plan import</button>}>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 8 }}>
            <span>{formatBytes(result.sizeBytes)} compressed</span>
            {result.totals && <span>{result.totals.entries.toLocaleString()} entries · {formatBytes(result.totals.uncompressedBytes)} raw</span>}
            {result.sha256 && <span style={{ ...mono, ...muted }} title={`sha256 ${result.sha256}`}>{result.sha256.slice(0, 16)}…</span>}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 8 }}>
            <tbody>
              {(result.sections ?? []).map((s) => (
                <tr key={`${s.kind}:${s.id}`} style={{ borderTop: '1px solid var(--color-border-default)' }}>
                  <td style={{ padding: '4px 6px' }}><span className="badge badge-default">{s.kind}</span></td>
                  <td style={{ padding: '4px 6px', ...mono }}>{s.id}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', ...mono }}>{s.count}{s.tombstones ? <span style={muted}> ({s.tombstones} tomb.)</span> : null}</td>
                  <td style={{ padding: '4px 6px', ...muted }}>
                    {s.redactedKeys?.length ? `redacted: ${s.redactedKeys.join(', ')}` : ''}
                    {s.warnings?.length ? ` ${s.warnings.join(' · ')}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.excluded?.length > 0 && (
            <div style={{ ...muted, marginBottom: 4 }}>Left out: {result.excluded.map((x) => `${x.id} (${x.reason})`).join(' · ')}</div>
          )}
          {(result.warnings ?? []).map((w, i) => <div key={i} style={{ fontSize: 11, color: 'var(--color-status-orange)' }}>{w}</div>)}
          {result.pruned?.length > 0 && <div style={muted}>Retention pruned: {result.pruned.join(', ')}</div>}
          <Notice tone="info">To move it, use Bundles › Copy to node, or Download it.{result.next && <> From an agent: <span style={mono}>{result.next}</span></>}</Notice>
        </Panel>
      )}

      <Panel title="Scheduled snapshot" icon={<CalendarClock size={14} style={{ color: 'var(--color-accent)' }} />}
        actions={job ? (
          <button className={`btn btn-sm ${job.enabled ? 'btn-ghost' : 'btn-secondary'}`} disabled={jobBusy} style={dim(jobBusy)} onClick={toggleJob}>
            {jobBusy && <Spinner size={12} />} {job.enabled ? 'Disable' : 'Enable'}
          </button>
        ) : null}>
        {job === undefined && !jobError && <span style={muted}>Loading…</span>}
        {job === null && !jobError && <span style={muted}>This node&apos;s lm-assist build has no data-snapshot job.</span>}
        {job && (
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className={`badge ${job.enabled ? 'badge-green' : 'badge-default'}`}>{job.enabled ? 'enabled' : 'disabled'}</span>
              <span>every {formatInterval(job.intervalMinutes)}</span>
              <span>last run {job.lastRunAt ? `${formatTimeAgo(job.lastRunAt)}${job.lastStatus ? ` · ${job.lastStatus}` : ''}` : 'never'}</span>
            </div>
            {job.lastResult && <div style={{ ...muted, ...mono, wordBreak: 'break-word' }}>{job.lastResult}</div>}
            <div style={muted}>
              Writes the default export (note &quot;scheduled&quot;) on {nodeLabel}; retention keeps the newest bundles (bundleRetention, default 20).
              {' '}Off by default because it writes to disk on every node — enable it per node. Extras are set in the Scheduler.
            </div>
          </div>
        )}
        {jobError && <div style={{ marginTop: 8 }}><ErrorBanner error={jobError} onClose={() => setJobError(null)} /></div>}
      </Panel>
    </div>
  );
}

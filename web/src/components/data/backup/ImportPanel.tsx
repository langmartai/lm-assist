'use client';

/**
 * Backup › Import — pick a bundle (stored here, uploaded from this browser in chunks, or
 * fetched from another node), choose a policy, sections and datasets, then Plan: a dry run
 * with per-section counts, refusals and next steps. Apply is offered only while the options
 * still match the plan on screen, and only through a confirm dialog that restates the policy
 * and counts. Nothing is written before that confirm.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { CloudDownload, FileSearch, PackageOpen, Play, Upload } from 'lucide-react';
import {
  GROUP_LABEL, IMPORT_POLICIES, POLICY_HELP, bundleContents, confirmLines, defaultImportSelection, formatBytes,
  importBody, planKey, sectionsSummary, sha256Hex, toBundleApiError, uploadBundleFile, writeCount,
  type BundleApiError, type BundlesApi, type ImportResult, type ImportSelection, type InspectResult, type StoredBundleInfo,
} from '@/lib/data-bundles';
import type { Machine } from '@/lib/types';
import { formatTimeAgo } from '@/lib/utils';
import { PlanTable } from './PlanTable';
import { ConfirmDialog, ErrorBanner, Notice, Panel, ProgressBar, Spinner, attempt, dim, labelStyle, mono, muted } from './shared';

type Source = 'stored' | 'upload' | 'fetch';

/** Hash the whole file for the upload's end-to-end check only up to this size (it is read into memory). */
const SHA_MAX_BYTES = 256 * 1024 * 1024;

function bundleOption(b: StoredBundleInfo): string {
  const when = b.createdAt ?? b.mtime;
  const from = b.source?.hostname ? ` · from ${b.source.hostname}` : '';
  const note = b.note ? ` · ${b.note}` : '';
  return `${b.bundleId} · ${formatTimeAgo(when)}${from}${note}`;
}

export function ImportPanel({
  api, apiFor, bundles, bundleId, onSelectBundle, onBundlesChanged, onApplied, nodeLabel, peers, crossNode,
}: {
  api: BundlesApi;
  apiFor: (machineId: string) => BundlesApi;
  bundles: StoredBundleInfo[];
  bundleId: string | null;
  onSelectBundle: (bundleId: string | null) => void;
  onBundlesChanged: () => void;
  onApplied: () => void;
  nodeLabel: string;
  peers: Machine[];
  crossNode: boolean;
}) {
  const [source, setSource] = useState<Source>('stored');
  // Pre-select the newest stored bundle ONCE, so the panel opens on something plannable; a
  // later explicit "Choose a bundle…" stays empty instead of snapping back.
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || bundleId || source !== 'stored') return;
    const newest = bundles.find((b) => !b.error);
    if (!newest) return;
    autoPicked.current = true;
    onSelectBundle(newest.bundleId);
  }, [bundles, bundleId, source, onSelectBundle]);
  const [notice, setNotice] = useState<string | null>(null);

  // ── the selected bundle ──
  const [info, setInfo] = useState<InspectResult | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<BundleApiError | null>(null);
  const [sel, setSel] = useState<ImportSelection | null>(null);

  // ── plan / apply ──
  const [plan, setPlan] = useState<ImportResult | null>(null);
  const [planFor, setPlanFor] = useState('');
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<BundleApiError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<BundleApiError | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  // ── upload ──
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [up, setUp] = useState<{ sent: number; total: number; phase: 'hashing' | 'uploading' } | null>(null);
  const [upError, setUpError] = useState<BundleApiError | null>(null);

  // ── fetch from node ──
  const [fromNode, setFromNode] = useState('');
  const [remote, setRemote] = useState<StoredBundleInfo[] | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remotePick, setRemotePick] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<BundleApiError | null>(null);

  // A new bundle resets everything downstream of it.
  useEffect(() => {
    setInfo(null); setSel(null); setPlan(null); setPlanFor(''); setResult(null);
    setPlanError(null); setInfoError(null);
    if (!bundleId) return;
    setSource('stored'); // picked from Bundles/Export: show it as the selected stored bundle
    let cancelled = false;
    setInfoLoading(true);
    api.inspect(bundleId)
      .then((r) => {
        if (cancelled) return;
        setInfo(r);
        setSel(defaultImportSelection(bundleContents(r.manifest.sections ?? [])));
      })
      .catch((e) => { if (!cancelled) setInfoError(toBundleApiError(e)); })
      .finally(() => { if (!cancelled) setInfoLoading(false); });
    return () => { cancelled = true; };
  }, [api, bundleId]);

  // The other node's stored bundles, for "fetch from node".
  useEffect(() => {
    setRemote(null); setRemotePick(''); setFetchError(null);
    if (!fromNode) return;
    let cancelled = false;
    setRemoteLoading(true);
    apiFor(fromNode).list()
      .then((r) => { if (!cancelled) setRemote(r); })
      .catch((e) => { if (!cancelled) setFetchError(toBundleApiError(e)); })
      .finally(() => { if (!cancelled) setRemoteLoading(false); });
    return () => { cancelled = true; };
  }, [apiFor, fromNode]);

  const contents = useMemo(() => (info ? bundleContents(info.manifest.sections ?? []) : null), [info]);
  const body = useMemo(() => (sel && contents ? importBody(sel, contents) : null), [sel, contents]);
  const key = bundleId && body ? planKey(bundleId, body) : '';
  const planCurrent = !!plan && planFor === key;
  const canPlan = !!body && (body.sections?.length ?? 0) > 0 && !planning && !applying;
  const canApply = planCurrent && !applying && !planning;
  const rosterRefused = !!plan?.sections.some((s) => s.refused?.code === 'ROSTER_UNAVAILABLE');

  const patchSel = (p: Partial<ImportSelection>) => setSel((s) => (s ? { ...s, ...p } : s));

  const runPlan = async () => {
    if (!bundleId || !body) return;
    setPlanning(true);
    setPlanError(null);
    setResult(null);
    const k = planKey(bundleId, body);
    const r = await attempt(() => api.plan(bundleId, body), setPlanError);
    setPlanning(false);
    if (r) { setPlan(r); setPlanFor(k); }
  };

  const runApply = async () => {
    if (!bundleId || !body || !planCurrent) return;
    setApplying(true);
    setApplyError(null);
    const r = await attempt(() => api.apply(bundleId, body), setApplyError);
    setApplying(false);
    if (r) {
      setConfirming(false);
      setResult(r);
      // The node changed: the old plan no longer describes it. Plan again before another apply.
      setPlan(null);
      setPlanFor('');
      onApplied();
    }
  };

  const runUpload = async () => {
    if (!file) return;
    setUpError(null);
    setNotice(null);
    let sha: string | null = null;
    if (file.size <= SHA_MAX_BYTES) {
      setUp({ sent: 0, total: file.size, phase: 'hashing' });
      sha = await file.arrayBuffer().then((b) => sha256Hex(b)).catch(() => null);
    }
    setUp({ sent: 0, total: file.size, phase: 'uploading' });
    const r = await attempt(() => uploadBundleFile(api, file, {
      name: file.name.slice(0, 256),
      sha256: sha,
      onProgress: (sent, total) => setUp({ sent, total, phase: 'uploading' }),
    }), setUpError);
    setUp(null);
    if (r?.bundleId) {
      setNotice(`Uploaded ${file.name}: verified and stored as ${r.bundleId}${sha ? ' (sha256 matched)' : ''}.`);
      setFile(null);
      setFileKey((n) => n + 1);
      onBundlesChanged();
      onSelectBundle(r.bundleId);
      setSource('stored');
    }
  };

  const runFetch = async () => {
    if (!fromNode || !remotePick) return;
    setFetching(true);
    setFetchError(null);
    setNotice(null);
    const host = peers.find((m) => m.id === fromNode)?.hostname ?? fromNode;
    const r = await attempt(() => api.fetchFrom(fromNode, remotePick), setFetchError);
    setFetching(false);
    if (r) {
      setNotice(`Fetched ${remotePick} from ${host}: verified and stored here as ${r.bundleId} (${formatBytes(r.sizeBytes)}, ${r.chunks} chunk${r.chunks === 1 ? '' : 's'}).`);
      onBundlesChanged();
      onSelectBundle(r.bundleId);
      setSource('stored');
    }
  };

  const sourceBtn = (s: Source, label: string, icon: React.ReactNode, disabled = false, title?: string) => (
    <button className={`btn btn-sm ${source === s ? 'btn-secondary' : 'btn-ghost'}`} disabled={disabled} style={{ ...dim(disabled), ...(source === s ? { color: 'var(--color-accent)' } : {}) }}
      title={title} onClick={() => setSource(s)}>
      {icon} {label}
    </button>
  );

  const fetchBlocked = !crossNode ? 'Reaching another node needs the hub connection' : peers.length === 0 ? 'No other node is online' : undefined;
  // A just-uploaded/fetched bundle can be selected before the list refresh lands.
  const unlisted = !!bundleId && !bundles.some((b) => b.bundleId === bundleId);
  const m = info?.manifest;

  return (
    <div>
      {notice && <Notice tone="ok" onClose={() => setNotice(null)}>{notice}</Notice>}

      <Panel title={`Import into ${nodeLabel}`} icon={<PackageOpen size={14} style={{ color: 'var(--color-accent)' }} />}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
          {sourceBtn('stored', 'Stored bundle', <PackageOpen size={12} />)}
          {sourceBtn('upload', 'Upload file', <Upload size={12} />)}
          {sourceBtn('fetch', 'Fetch from node', <CloudDownload size={12} />, !!fetchBlocked, fetchBlocked)}
        </div>

        {source === 'stored' && (
          <label style={{ ...labelStyle, display: 'block' }}>Bundle
            <select className="input" style={{ marginTop: 4, ...mono }} value={bundleId ?? ''} onChange={(e) => onSelectBundle(e.target.value || null)}>
              <option value="">{bundles.length ? 'Choose a bundle…' : 'No bundles on this node yet'}</option>
              {unlisted && <option value={bundleId!}>{bundleId}</option>}
              {bundles.filter((b) => !b.error).map((b) => <option key={b.bundleId} value={b.bundleId}>{bundleOption(b)}</option>)}
            </select>
          </label>
        )}

        {source === 'upload' && (
          <div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input key={fileKey} type="file" accept=".gz,application/gzip" disabled={!!up}
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setUpError(null); }} style={{ fontSize: 12, color: 'var(--color-text-secondary)' }} />
              <button className="btn btn-primary btn-sm" disabled={!file || !!up} style={dim(!file || !!up)} onClick={runUpload}>
                {up ? <Spinner size={12} /> : <Upload size={12} />} Upload
              </button>
              {file && !up && <span style={muted}>{file.name} · {formatBytes(file.size)}</span>}
            </div>
            {up && (
              <div style={{ marginTop: 8 }}>
                <ProgressBar value={up.sent} total={up.total}
                  label={up.phase === 'hashing' ? 'hashing…' : `${formatBytes(up.sent)} / ${formatBytes(up.total)}`} />
              </div>
            )}
            <div style={{ ...muted, marginTop: 6 }}>
              A <span style={mono}>.lmbundle.gz</span> goes up in ≤ 512 KiB chunks (resumable per chunk). The node verifies the whole bundle before storing it.
            </div>
            <div style={{ marginTop: 8 }}><ErrorBanner error={upError} onClose={() => setUpError(null)} /></div>
          </div>
        )}

        {source === 'fetch' && (
          <div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ ...labelStyle, flex: '1 1 200px' }}>From node
                <select className="input" style={{ marginTop: 4 }} value={fromNode} onChange={(e) => setFromNode(e.target.value)}>
                  <option value="">Choose a node…</option>
                  {peers.map((p) => <option key={p.id} value={p.id}>{p.hostname} ({p.id})</option>)}
                </select>
              </label>
              <label style={{ ...labelStyle, flex: '2 1 320px' }}>Bundle on that node
                <select className="input" style={{ marginTop: 4, ...mono }} value={remotePick} disabled={!remote || remoteLoading} onChange={(e) => setRemotePick(e.target.value)}>
                  <option value="">{remoteLoading ? 'Loading…' : remote && remote.length === 0 ? 'No bundles there' : 'Choose a bundle…'}</option>
                  {(remote ?? []).filter((b) => !b.error).map((b) => <option key={b.bundleId} value={b.bundleId}>{bundleOption(b)}</option>)}
                </select>
              </label>
              <button className="btn btn-primary btn-sm" disabled={!remotePick || fetching} style={dim(!remotePick || fetching)} onClick={runFetch}>
                {fetching ? <Spinner size={12} /> : <CloudDownload size={12} />} Fetch to this node
              </button>
            </div>
            <div style={{ ...muted, marginTop: 6 }}>This node pulls the bundle through the hub in chunks, verifies it and stores a copy. Nothing is imported yet.</div>
            <div style={{ marginTop: 8 }}><ErrorBanner error={fetchError} onClose={() => setFetchError(null)} /></div>
          </div>
        )}
      </Panel>

      <ErrorBanner error={infoError} onClose={() => setInfoError(null)} />
      {infoLoading && <div className="empty-state"><Spinner size={20} /><span style={{ fontSize: 12 }}>Reading the manifest…</span></div>}

      {m && sel && contents && (
        <Panel title={<>Bundle <span style={mono}>{info!.bundleId}</span></>} icon={<FileSearch size={14} style={{ color: 'var(--color-accent)' }} />}>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 12 }}>
            <span>from <b>{m.source?.hostname || m.source?.nodeId || 'unknown'}</b>{m.source ? ` (${m.source.mode} · ${m.source.platform}${m.source.cluster ? ` · cluster ${m.source.cluster}` : ''})` : ''}</span>
            <span title={m.createdAt}>created {formatTimeAgo(m.createdAt)}</span>
            <span>{sectionsSummary(m.sections)}</span>
            {info!.sizeBytes !== null && <span>{formatBytes(info!.sizeBytes)}</span>}
            {info!.imported && <span className="badge badge-purple">{info!.imported.via}{info!.imported.fromNode ? ` from ${info!.imported.fromNode}` : ''}</span>}
            {m.note && <span>“{m.note}”</span>}
          </div>

          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>Policy</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {IMPORT_POLICIES.map((p) => (
              <label key={p} style={{ ...labelStyle, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input type="radio" name="bundle-import-policy" checked={sel.policy === p} onChange={() => patchSel({ policy: p })} style={{ marginTop: 2 }} />
                <span><span style={{ ...mono, color: 'var(--color-text-primary)' }}>{p}</span>{p === 'merge' ? <span style={muted}> (default)</span> : null} — {POLICY_HELP[p]}</span>
              </label>
            ))}
          </div>

          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>Sections</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 10 }}>
            {contents.groups.map((g) => {
              const n = m.sections.filter((s) => (g === 'datasets' ? s.kind === 'dataset' : g === 'config' ? s.kind === 'config' : s.id === g));
              const count = g === 'datasets' || g === 'config' ? `${n.length}` : `${n.reduce((x, s) => x + s.count, 0)} files`;
              return (
                <label key={g} style={{ ...labelStyle, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={sel.groups[g] !== false} onChange={(e) => patchSel({ groups: { ...sel.groups, [g]: e.target.checked } })} />
                  {GROUP_LABEL[g]} <span style={muted}>({count})</span>
                </label>
              );
            })}
          </div>

          {contents.datasets.length > 0 && sel.groups.datasets !== false && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={muted}>Datasets</span>
                <button className="btn btn-ghost btn-sm" onClick={() => patchSel({ datasets: Object.fromEntries(contents.datasets.map((d) => [d.id, true])) })}>all</button>
                <button className="btn btn-ghost btn-sm" onClick={() => patchSel({ datasets: Object.fromEntries(contents.datasets.map((d) => [d.id, false])) })}>none</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 4 }}>
                {contents.datasets.map((d) => (
                  <label key={d.id} style={{ ...labelStyle, display: 'flex', gap: 6, alignItems: 'center' }} title={d.owned === false ? `replica of ${d.origin?.hostname ?? d.origin?.machineId ?? '?'} in the bundle` : 'owned by the source'}>
                    <input type="checkbox" checked={sel.datasets[d.id] !== false} onChange={(e) => patchSel({ datasets: { ...sel.datasets, [d.id]: e.target.checked } })} />
                    <span style={mono}>{d.id}</span>
                    <span style={muted}>{d.count}{d.owned === false ? ' · replica' : ''}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <label style={{ ...labelStyle, display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
            <input type="checkbox" checked={sel.takeOwnership} onChange={(e) => patchSel({ takeOwnership: e.target.checked })} style={{ marginTop: 2 }} />
            <span>Take ownership <span style={muted}>— where this node holds a read-only replica of a bundled dataset, take it over first (refused while its origin is online), then import into it.</span></span>
          </label>
          {(sel.takeOwnership || rosterRefused || sel.force) && (
            <label style={{ ...labelStyle, display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
              <input type="checkbox" checked={sel.force} onChange={(e) => patchSel({ force: e.target.checked })} style={{ marginTop: 2 }} />
              <span>Force <span style={muted}>— proceed when the hub roster is unavailable. Only if you know the owner is gone; it never overrides an owner that is online.</span></span>
            </label>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" disabled={!canPlan} style={dim(!canPlan)} onClick={runPlan}>
              {planning ? <Spinner size={12} /> : <FileSearch size={12} />} Plan
            </button>
            <button className="btn btn-destructive btn-sm" disabled={!canApply} style={dim(!canApply)} onClick={() => { setApplyError(null); setConfirming(true); }}
              title={canApply ? 'Write this plan to the node' : 'Run Plan with the current options first'}>
              <Play size={12} /> Apply…
            </button>
            {plan && !planCurrent && <span style={{ fontSize: 11, color: 'var(--color-status-orange)' }}>Options changed since this plan — run Plan again before Apply.</span>}
            {!plan && <span style={muted}>Plan is a dry run: it reads the bundle in full (integrity checked) and writes nothing.</span>}
          </div>
        </Panel>
      )}

      <ErrorBanner error={planError} onClose={() => setPlanError(null)} />

      {plan && (
        <Panel title={<>Plan · <span style={mono}>{plan.policy}</span>{planCurrent ? '' : ' (stale)'}</>} icon={<FileSearch size={14} style={{ color: 'var(--color-accent)' }} />}
          style={planCurrent ? undefined : { opacity: 0.6 }}>
          <PlanTable result={plan} />
        </Panel>
      )}

      {result && (
        <Panel title={<>Applied · <span style={mono}>{result.policy}</span></>} icon={<Play size={14} style={{ color: 'var(--color-status-green)' }} />}>
          <Notice tone={result.refused ? 'warn' : 'ok'}>
            Wrote {writeCount(result.applied)} record/item{writeCount(result.applied) === 1 ? '' : 's'} to {nodeLabel}
            {result.refused ? `; ${result.refused} section${result.refused === 1 ? '' : 's'} refused (nothing written there)` : ''}.
            {' '}Synced datasets reach their replicas on the next pull.
          </Notice>
          <PlanTable result={result} />
        </Panel>
      )}

      {confirming && plan && (
        <ConfirmDialog title="Apply this import?" confirmLabel="Apply" destructive busy={applying} error={applyError}
          onConfirm={runApply} onCancel={() => { if (!applying) setConfirming(false); }}>
          {confirmLines(plan, nodeLabel).map((l, i) => <div key={i}>{l}</div>)}
          <div style={muted}>Import never deletes: records here that the bundle lacks are left alone.</div>
        </ConfirmDialog>
      )}
    </div>
  );
}

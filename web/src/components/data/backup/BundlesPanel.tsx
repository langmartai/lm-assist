'use client';

/**
 * Backup › Bundles — the bundles stored on the selected node. Download reads the chunk route
 * (≤ 512 KiB JSON per call, so it works through the hub relay) and saves a Blob; Plan import
 * hands the bundle to the Import view; Copy to node… runs POST /data/bundles/fetch ON THE
 * TARGET with fromNode = this node, so the target pulls and verifies it; Delete asks first.
 */

import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Download, FileSearch, Package, RefreshCw, Trash2 } from 'lucide-react';
import {
  bundleFileName, downloadBundleBytes, formatBytes, sectionsSummary,
  type BundleApiError, type BundlesApi, type FetchResult, type StoredBundleInfo,
} from '@/lib/data-bundles';
import type { Machine } from '@/lib/types';
import { formatTimeAgo } from '@/lib/utils';
import { ConfirmDialog, ErrorBanner, Notice, Panel, ProgressBar, Spinner, attempt, dim, labelStyle, mono, muted, td, th } from './shared';

function saveBlob(parts: BlobPart[], name: string): void {
  const url = URL.createObjectURL(new Blob(parts, { type: 'application/gzip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later: some browsers read the blob URL after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function importedLabel(b: StoredBundleInfo): string | null {
  const m = b.imported;
  if (!m) return null;
  const from = m.via === 'fetch' ? (m.fromNode ? ` from ${m.fromNode}` : '') : m.name ? ` · ${m.name}` : '';
  return `${m.via}${from}`;
}

export function BundlesPanel({
  api, apiFor, bundles, loading, error, onRefresh, nodeLabel, selfNodeId, peers, crossNode, onPlan, onOpenNode,
}: {
  api: BundlesApi;
  apiFor: (machineId: string) => BundlesApi;
  bundles: StoredBundleInfo[];
  loading: boolean;
  error: BundleApiError | null;
  onRefresh: () => void;
  nodeLabel: string;
  selfNodeId: string | null;
  peers: Machine[];
  crossNode: boolean;
  onPlan: (bundleId: string) => void;
  /** Switch the page to another node and plan a bundle there (absent when the page cannot switch). */
  onOpenNode?: (machineId: string, bundleId: string) => void;
}) {
  const [actionError, setActionError] = useState<BundleApiError | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dl, setDl] = useState<{ id: string; got: number; total: number } | null>(null);

  const [toDelete, setToDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<BundleApiError | null>(null);

  const [toCopy, setToCopy] = useState<string | null>(null);
  const [copyTarget, setCopyTarget] = useState('');
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<BundleApiError | null>(null);
  const [copied, setCopied] = useState<{ machine: Machine; r: FetchResult } | null>(null);

  const download = async (id: string) => {
    setActionError(null);
    setDl({ id, got: 0, total: 0 });
    const r = await attempt(() => downloadBundleBytes(api, id, { onProgress: (got, total) => setDl({ id, got, total }) }), setActionError);
    setDl(null);
    if (r) saveBlob(r.parts, bundleFileName(id));
  };

  const doDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    const r = await attempt(() => api.remove(toDelete), setDeleteError);
    setDeleting(false);
    if (r) {
      setToDelete(null);
      onRefresh();
    }
  };

  const openCopy = (id: string) => {
    setToCopy(id);
    setCopyTarget(peers.length === 1 ? peers[0].id : '');
    setCopyError(null);
  };

  const doCopy = async () => {
    const machine = peers.find((m) => m.id === copyTarget);
    if (!toCopy || !machine || !selfNodeId) return;
    setCopying(true);
    setCopyError(null);
    // The TARGET pulls from this node through the hub, verifies, and stores it under a new id.
    const r = await attempt(() => apiFor(machine.id).fetchFrom(selfNodeId, toCopy), setCopyError);
    setCopying(false);
    if (r) {
      setToCopy(null);
      setCopied({ machine, r });
    }
  };

  const copyBlocked = !crossNode
    ? 'Reaching another node needs the hub connection'
    : peers.length === 0 ? 'No other node is online'
      : !selfNodeId ? 'This node\'s id is not known yet (inventory still loading)' : null;

  return (
    <div>
      <ErrorBanner error={error} />
      <ErrorBanner error={actionError} onClose={() => setActionError(null)} />
      {copied && (
        <Notice tone="ok" onClose={() => setCopied(null)}>
          Copied to <b>{copied.machine.hostname}</b> as <span style={mono}>{copied.r.bundleId}</span>
          {' '}({formatBytes(copied.r.sizeBytes)}, {copied.r.chunks} chunk{copied.r.chunks === 1 ? '' : 's'}, verified).{' '}
          {onOpenNode ? (
            <button className="btn btn-secondary btn-sm" onClick={() => onOpenNode(copied.machine.id, copied.r.bundleId)}>
              Open {copied.machine.hostname} and plan import
            </button>
          ) : <>Plan and apply it from {copied.machine.hostname}&apos;s own page.</>}
        </Notice>
      )}

      <Panel title={`Bundles on ${nodeLabel}`} icon={<Package size={14} style={{ color: 'var(--color-accent)' }} />}
        actions={<button className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={loading}>{loading ? <Spinner size={12} /> : <RefreshCw size={12} />} Refresh</button>}>
        {loading && bundles.length === 0 ? (
          <div className="empty-state"><Spinner size={24} /><span style={{ fontSize: 12 }}>Loading…</span></div>
        ) : bundles.length === 0 ? (
          <div className="empty-state"><Package size={32} className="empty-state-icon" /><div>No bundles stored on this node</div>
            <div style={muted}>Create one in Export, upload one in Import, or copy one here from another node.</div></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--color-text-tertiary)' }}>
                  <th style={{ ...th, width: 24 }} /><th style={th}>bundle</th><th style={th}>created</th><th style={th}>source</th>
                  <th style={th}>contents</th><th style={{ ...th, textAlign: 'right' }}>size</th><th style={th} />
                </tr>
              </thead>
              <tbody>
                {bundles.map((b) => {
                  const imp = importedLabel(b);
                  const open = expanded === b.bundleId;
                  const downloading = dl?.id === b.bundleId;
                  return (
                    <Fragment key={b.bundleId}>
                      <tr style={{ borderTop: '1px solid var(--color-border-default)' }}>
                        <td style={td}>
                          <button className="btn btn-ghost btn-sm" style={{ padding: 2, visibility: b.sections?.length ? 'visible' : 'hidden' }}
                            onClick={() => setExpanded(open ? null : b.bundleId)} title="Sections">
                            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </button>
                        </td>
                        <td style={td}>
                          <div style={{ ...mono, color: 'var(--color-text-primary)' }}>{b.bundleId}</div>
                          {b.note && <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{b.note}</div>}
                          {imp && <span className="badge badge-purple" style={{ marginTop: 2 }}>{imp}</span>}
                          {b.error && <div style={{ fontSize: 11, color: 'var(--color-status-red)' }}><span style={mono}>{b.error.code}</span> {b.error.message}</div>}
                        </td>
                        <td style={td} title={b.createdAt ?? b.mtime}>{formatTimeAgo(b.createdAt ?? b.mtime)}</td>
                        <td style={td}>
                          {b.source ? (
                            <>
                              <div>{b.source.hostname || b.source.nodeId}</div>
                              <div style={muted}>{b.source.mode} · {b.source.platform}{b.source.cluster ? ` · ${b.source.cluster}` : ''} · v{b.source.lmAssistVersion}</div>
                            </>
                          ) : <span style={muted}>—</span>}
                        </td>
                        <td style={td}>
                          <div>{sectionsSummary(b.sections)}</div>
                          {b.totals && <div style={muted}>{b.totals.entries.toLocaleString()} entries · {formatBytes(b.totals.uncompressedBytes)} raw</div>}
                        </td>
                        <td style={{ ...td, textAlign: 'right', ...mono }}>{formatBytes(b.sizeBytes)}</td>
                        <td style={{ ...td, textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            {downloading ? (
                              <ProgressBar value={dl.got} total={dl.total} label={dl.total ? `${formatBytes(dl.got)} / ${formatBytes(dl.total)}` : 'starting…'} />
                            ) : (
                              <button className="btn btn-ghost btn-sm" disabled={!!dl} onClick={() => download(b.bundleId)} title={`Download ${bundleFileName(b.bundleId)}`}>
                                <Download size={12} />
                              </button>
                            )}
                            <button className="btn btn-secondary btn-sm" disabled={!!b.error} style={dim(!!b.error)} onClick={() => onPlan(b.bundleId)} title="Dry-run an import of this bundle on this node">
                              <FileSearch size={12} /> Plan import
                            </button>
                            <button className="btn btn-ghost btn-sm" disabled={!!copyBlocked || !!b.error} style={dim(!!copyBlocked || !!b.error)}
                              onClick={() => openCopy(b.bundleId)} title={copyBlocked ?? 'Copy to another node (the target pulls and verifies it)'}>
                              <Copy size={12} /> Copy to node…
                            </button>
                            <button className="btn btn-ghost btn-sm" onClick={() => { setToDelete(b.bundleId); setDeleteError(null); }} title="Delete">
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {open && b.sections && (
                        <tr>
                          <td />
                          <td colSpan={6} style={{ ...td, paddingTop: 0 }}>
                            {b.sections.map((s) => (
                              <div key={`${s.kind}:${s.id}`} style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--color-text-secondary)', padding: '1px 0', flexWrap: 'wrap' }}>
                                <span className="badge badge-default">{s.kind}</span>
                                <span style={{ ...mono, minWidth: 160 }}>{s.id}</span>
                                <span style={mono}>{s.count}{s.tombstones ? ` (${s.tombstones} tomb.)` : ''}</span>
                                {s.kind === 'dataset' && <span style={muted}>{s.owned === false ? `replica of ${s.origin?.hostname ?? s.origin?.machineId ?? '?'}` : 'owned'} · {s.scope} · {s.syncMode}</span>}
                                {s.redactedKeys?.length ? <span style={muted}>redacted: {s.redactedKeys.join(', ')}</span> : null}
                                {s.warnings?.length ? <span style={{ color: 'var(--color-status-orange)' }}>{s.warnings.join(' · ')}</span> : null}
                              </div>
                            ))}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {toDelete && (
        <ConfirmDialog title="Delete bundle" confirmLabel="Delete" destructive busy={deleting} error={deleteError}
          onConfirm={doDelete} onCancel={() => { if (!deleting) setToDelete(null); }}>
          <div>Delete <span style={mono}>{toDelete}</span> from <b>{nodeLabel}</b>? The file is removed; copies on other nodes are not touched.</div>
        </ConfirmDialog>
      )}

      {toCopy && (
        <ConfirmDialog title="Copy bundle to another node" confirmLabel="Copy" gate={!!copyTarget} busy={copying} error={copyError}
          onConfirm={doCopy} onCancel={() => { if (!copying) setToCopy(null); }}>
          <div>
            The target node pulls <span style={mono}>{toCopy}</span> from <b>{nodeLabel}</b> through the hub, chunk by chunk,
            verifies it, and stores it under a new bundle id. Nothing is imported until you plan and apply it there.
          </div>
          <label style={labelStyle}>Target node
            <select className="input" style={{ marginTop: 4 }} value={copyTarget} onChange={(e) => setCopyTarget(e.target.value)}>
              <option value="">Choose a node…</option>
              {peers.map((m) => <option key={m.id} value={m.id}>{m.hostname} ({m.id})</option>)}
            </select>
          </label>
        </ConfirmDialog>
      )}
    </div>
  );
}

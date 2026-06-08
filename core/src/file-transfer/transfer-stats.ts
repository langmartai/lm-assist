/**
 * Live + persisted data-plane transfer statistics.
 *
 * Every send (sendPath/sendFirehose) and inbound receive registers here; bytes
 * are updated as the data plane moves them, so an open connection can be queried
 * for live total / elapsed / speed. On completion the final record is appended
 * to <data-dir>/transfer-stats.jsonl as metadata.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type TransferDirection = 'send' | 'recv';
export type TransferKind = 'firehose' | 'reliable';
export type TransferState = 'active' | 'done' | 'failed';

interface Stat {
  id: string;
  peerGatewayId: string;
  direction: TransferDirection;
  kind: TransferKind;
  remotePath: string;
  totalBytes: number;
  bytes: number;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  state: TransferState;
  mode?: string;
  via?: string | null;
  rttMs?: number | null;
  error?: string;
  instantBps: number;
  sBytes: number;
  sAt: number;
  live?: () => { mode?: string; via?: string | null; rttMs?: number | null };
}

export interface TransferStatView {
  id: string;
  peerGatewayId: string;
  direction: TransferDirection;
  kind: TransferKind;
  remotePath: string;
  totalBytes: number;
  bytes: number;
  pct: number;
  elapsedMs: number;
  avgBps: number;
  avgMBps: number;
  instantBps: number;
  instantMBps: number;
  mode?: string;
  via?: string | null;
  rttMs?: number | null;
  state: TransferState;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

const active = new Map<string, Stat>();
const recent: Stat[] = [];
const RECENT_MAX = 100;
const SAMPLE_MS = 500;

function statsFile(): string {
  const dir = process.env.LM_ASSIST_DATA_DIR || path.join(os.homedir(), '.lm-assist');
  return path.join(dir, 'transfer-stats.jsonl');
}

export function beginTransfer(p: {
  id: string; peerGatewayId: string; direction: TransferDirection;
  remotePath: string; totalBytes: number; kind?: TransferKind;
  live?: () => { mode?: string; via?: string | null; rttMs?: number | null };
}): void {
  const now = Date.now();
  active.set(p.id, {
    id: p.id, peerGatewayId: p.peerGatewayId, direction: p.direction,
    kind: p.kind ?? 'reliable', remotePath: p.remotePath, totalBytes: p.totalBytes,
    bytes: 0, startedAt: now, updatedAt: now, state: 'active',
    instantBps: 0, sBytes: 0, sAt: now, live: p.live,
  });
}

export function updateTransfer(id: string, bytes: number): void {
  const st = active.get(id);
  if (!st) return;
  st.bytes = bytes;
  st.updatedAt = Date.now();
  const dt = st.updatedAt - st.sAt;
  if (dt >= SAMPLE_MS) {
    st.instantBps = Math.max(0, Math.round(((bytes - st.sBytes) * 1000) / dt));
    st.sBytes = bytes;
    st.sAt = st.updatedAt;
    // Snapshot the live channel metrics so the final/persisted record keeps the
    // last-known mode/via/rtt even after the channel closes at completion.
    if (st.live) {
      const l = st.live();
      if (l.mode) st.mode = l.mode;
      if (l.via != null) st.via = l.via;
      if (l.rttMs != null) st.rttMs = l.rttMs;
    }
  }
}

export function setTransferMeta(id: string, m: { mode?: string; via?: string | null; kind?: TransferKind }): void {
  const st = active.get(id);
  if (!st) return;
  if (m.mode !== undefined) st.mode = m.mode;
  if (m.via !== undefined) st.via = m.via;
  if (m.kind !== undefined) st.kind = m.kind;
}

export function endTransfer(id: string, state: 'done' | 'failed', error?: string): void {
  const st = active.get(id);
  if (!st) return;
  st.state = state;
  st.endedAt = Date.now();
  st.instantBps = 0;
  if (error) st.error = error;
  if (state === 'done' && st.totalBytes > 0) st.bytes = st.totalBytes;
  if (st.live) { const l = st.live(); if (l.mode !== undefined) st.mode = l.mode; if (l.via !== undefined) st.via = l.via; if (l.rttMs !== undefined) st.rttMs = l.rttMs; }
  st.live = undefined;
  active.delete(id);
  recent.unshift(st);
  if (recent.length > RECENT_MAX) recent.pop();
  try { fs.appendFileSync(statsFile(), JSON.stringify(toView(st)) + '\n'); } catch { /* best-effort */ }
}

function toView(st: Stat): TransferStatView {
  const end = st.endedAt ?? Date.now();
  const elapsedMs = Math.max(0, end - st.startedAt);
  const avgBps = elapsedMs > 0 ? Math.round((st.bytes * 1000) / elapsedMs) : 0;
  const instantBps = st.state === 'active' ? st.instantBps : avgBps;
  let mode = st.mode, via = st.via, rttMs = st.rttMs;
  if (st.state === 'active' && st.live) {
    const l = st.live();
    if (l.mode !== undefined) mode = l.mode;
    if (l.via !== undefined) via = l.via;
    if (l.rttMs !== undefined) rttMs = l.rttMs;
  }
  return {
    id: st.id, peerGatewayId: st.peerGatewayId, direction: st.direction, kind: st.kind,
    remotePath: st.remotePath, totalBytes: st.totalBytes, bytes: st.bytes,
    pct: st.totalBytes > 0 ? Math.round((st.bytes / st.totalBytes) * 1000) / 10 : 0,
    elapsedMs, avgBps, avgMBps: Math.round((avgBps / 1048576) * 100) / 100,
    instantBps, instantMBps: Math.round((instantBps / 1048576) * 100) / 100,
    mode, via, rttMs, state: st.state,
    startedAt: st.startedAt, endedAt: st.endedAt, error: st.error,
  };
}

export function snapshotTransfers(): { active: TransferStatView[]; recent: TransferStatView[] } {
  return {
    active: Array.from(active.values()).map(toView),
    recent: recent.map(toView),
  };
}

export function getTransfer(id: string): TransferStatView | null {
  const st = active.get(id);
  if (st) return toView(st);
  const r = recent.find((x) => x.id === id);
  return r ? toView(r) : null;
}

// core/src/mcp-server/bootstrap-persist.ts
// Durable "this session has BOOTSTRAPPED" markers (bl_5169a15c). The resolver's
// REGISTRY was module-level memory only, so every Core restart forgot every
// bootstrap and the first playbook-governed call from a long-lived session (e.g.
// the Mission Controller) was refused with BOOTSTRAP_REQUIRED — a pointless
// ~55KB re-pull per restart.
//
// Only the bootstrapped marker is persisted, not the whole SessionState: losing
// gateRefusedAt costs at most one extra soft-refusal for a session that never
// bootstrapped anyway, while losing bootstrappedAt is the defect above.
//
// Hot-path contract (docs/mcp-surfaces.md — the resolver runs on EVERY connector
// call): the load is ONE small sync read per process, lazily on first registry
// access; writes are debounced + async (write-behind, never per call, never sync
// on the call path); the file is pruned by age AND count so it cannot grow
// forever; and a corrupt/missing file loads as empty so the gate fails open
// exactly like a fresh process does today.
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, isDevRepo } from '../utils/path-utils';

export interface PersistedMarker { bootstrappedAt: number; lastSeen: number }

/** Count cap on the file. Bootstraps are one-per-conversation, so even a busy
 *  fleet node sees a handful per day — 500 is weeks of headroom, a few tens of
 *  KB at most. */
export const MAX_PERSISTED_MARKERS = 500;
/** Age cap. A session idle this long re-bootstraps once, which is the correct
 *  outcome anyway: its playbooks are a month stale. */
export const MAX_MARKER_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 1000;

/** Same dev/prod separation rule as getCacheDir(): prod keeps the bare name,
 *  dev gets `-dev`, so the :3200 and :3100 cores never share (or clobber) it. */
export function bootstrapMarkerFile(): string {
  return path.join(getDataDir(), `mcp-bootstrapped${isDevRepo() ? '-dev' : ''}.json`);
}

/** Pure: apply the age cap, then the count cap (keeping the most recent). */
export function pruneMarkers(markers: Record<string, PersistedMarker>, now = Date.now()): Record<string, PersistedMarker> {
  const recency = (m: PersistedMarker) => Math.max(m.lastSeen || 0, m.bootstrappedAt || 0);
  const kept = Object.entries(markers)
    .filter(([, m]) => now - recency(m) <= MAX_MARKER_AGE_MS)
    .sort(([, a], [, b]) => recency(b) - recency(a))
    .slice(0, MAX_PERSISTED_MARKERS);
  return Object.fromEntries(kept);
}

/** ONE sync read of the (small, pruned) marker file. Called once per process,
 *  lazily, by the resolver's first registry access — never per call. Anything
 *  wrong with the file (missing, corrupt, drifted shape) yields an empty map,
 *  never a throw: the gate must fail open exactly like a fresh process. */
export function loadPersistedMarkers(now = Date.now()): Map<string, PersistedMarker> {
  const out = new Map<string, PersistedMarker>();
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(bootstrapMarkerFile(), 'utf-8')); }
  catch { return out; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  const valid: Record<string, PersistedMarker> = {};
  for (const [id, m] of Object.entries(parsed as Record<string, unknown>)) {
    const cand = m as PersistedMarker | null;
    if (cand && typeof cand === 'object' && typeof cand.bootstrappedAt === 'number' && typeof cand.lastSeen === 'number') {
      valid[id] = { bootstrappedAt: cand.bootstrappedAt, lastSeen: cand.lastSeen };
    }
  }
  for (const [id, m] of Object.entries(pruneMarkers(valid, now))) out.set(id, m);
  return out;
}

let timer: NodeJS.Timeout | null = null;
let snapshotFn: (() => Record<string, PersistedMarker>) | null = null;
/** Serializes writes so a debounce firing during a slow flush cannot interleave
 *  two tmp-file replaces. */
let writeChain: Promise<void> = Promise.resolve();

async function writeNow(): Promise<void> {
  const snap = snapshotFn?.();
  if (!snap) return;
  try {
    const f = bootstrapMarkerFile();
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(pruneMarkers(snap)), { mode: 0o600 });
    await fs.promises.rename(tmp, f);    // atomic replace, same as worker-store
  } catch { /* persistence is best-effort — worst case is one re-bootstrap */ }
}

/** Write-behind: coalesce every change inside a debounce window into ONE async
 *  write of the LATEST snapshot (taken when the timer fires, not when scheduled).
 *  The timer is unref'd so a pending write never holds the process open. */
export function schedulePersistMarkers(snapshot: () => Record<string, PersistedMarker>): void {
  snapshotFn = snapshot;
  if (timer) return;
  timer = setTimeout(() => { timer = null; writeChain = writeChain.then(writeNow); }, PERSIST_DEBOUNCE_MS);
  timer.unref?.();
}

/** Tests only: skip the debounce and complete the pending write now. */
export async function __flushPersistForTest(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  writeChain = writeChain.then(writeNow);
  await writeChain;
}

/** Tests only: drop any pending write and the captured snapshot. */
export function __resetPersistForTest(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  snapshotFn = null;
  writeChain = Promise.resolve();
}

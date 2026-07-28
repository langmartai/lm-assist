/** Core-side (in-process) overlay provider: reads the registry store with a small
 *  TTL cache so tools/list bursts don't hammer LMDB, fails OPEN (null overlay) on
 *  any store error, and exposes an invalidation hook the /mcp-tools write routes
 *  call so an edit taken on this node is visible on the very next list/call. */
import type { ToolRegistryDoc } from './model';
import { overlayFromDocs, type OverlayProvider, type ToolOverlay } from './overlay';
import { listToolDocs } from './store';
import { peekDataService } from '../../data/data-service';
import { bumpToolsRev } from './tools-rev';

export interface LiveOverlayProvider extends OverlayProvider {
  invalidate(): void;
}

/** Default doc source: read the registry ONLY when the data service is already up
 *  (peek — never construct). tools/list is a hot path in every transport including
 *  bare test processes; constructing the data stack from it leaks lifecycle handles
 *  (watchers/sync) that keep short-lived processes alive. On an enabled node the
 *  service is built at boot (sync-boot), so overrides serve normally; a node without
 *  it gets pure code defaults — the same fail-open answer as a disabled service. */
function listDocsIfServiceUp(): Promise<ToolRegistryDoc[]> {
  const svc = peekDataService();
  if (!svc || !svc.isEnabled()) return Promise.resolve([]);
  return listToolDocs();
}

/**
 * A stable fingerprint of an overlay, for "did this actually change?".
 *
 * Key-sorted so map iteration order can never manufacture a change — a false
 * positive here means every poll tells clients to re-fetch.
 */
export function overlayDigest(overlay: ToolOverlay | null): string {
  if (!overlay) return 'null';
  const byName = (overlay as { byName?: Record<string, unknown> }).byName ?? overlay;
  const entries = Object.entries(byName as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

export function createLiveOverlayProvider(opts?: {
  ttlMs?: number;
  list?: () => Promise<ToolRegistryDoc[]>;
}): LiveOverlayProvider {
  const ttl = opts?.ttlMs ?? 1500;
  const list = opts?.list ?? listDocsIfServiceUp;
  let cached: { at: number; overlay: ToolOverlay | null } | null = null;
  return {
    async get(): Promise<ToolOverlay | null> {
      const now = Date.now();
      if (cached && now - cached.at < ttl && ttl > 0) return cached.overlay;
      let overlay: ToolOverlay | null;
      try {
        overlay = overlayFromDocs(await list());
      } catch {
        overlay = null; // fail-open; cached below so a broken store isn't hammered
      }
      cached = { at: now, overlay };
      return overlay;
    },
    invalidate(): void {
      cached = null;
    },
  };
}

let shared: LiveOverlayProvider = createLiveOverlayProvider();

/** The provider instance the transports + shim guards share (one cache). */
export function sharedLiveOverlay(): LiveOverlayProvider {
  return shared;
}

/** Called by the /mcp-tools write routes after a local write lands. */
export function invalidateOverlayCache(): void {
  shared.invalidate();
  // The MCP server is a separate process and cannot see this. Move the rev so its
  // poller can tell connected clients their tool list is stale.
  bumpToolsRev();
}

/** Test-only seam: swap the shared instance (restore it in a finally). */
export function _replaceSharedLiveOverlayForTests(p: LiveOverlayProvider): void {
  shared = p;
}

/** Core-side (in-process) overlay provider: reads the registry store with a small
 *  TTL cache so tools/list bursts don't hammer LMDB, fails OPEN (null overlay) on
 *  any store error, and exposes an invalidation hook the /mcp-tools write routes
 *  call so an edit taken on this node is visible on the very next list/call. */
import type { ToolRegistryDoc } from './model';
import { overlayFromDocs, type OverlayProvider, type ToolOverlay } from './overlay';
import { listToolDocs } from './store';

export interface LiveOverlayProvider extends OverlayProvider {
  invalidate(): void;
}

export function createLiveOverlayProvider(opts?: {
  ttlMs?: number;
  list?: () => Promise<ToolRegistryDoc[]>;
}): LiveOverlayProvider {
  const ttl = opts?.ttlMs ?? 1500;
  const list = opts?.list ?? (() => listToolDocs());
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
}

/** Test-only seam: swap the shared instance (restore it in a finally). */
export function _replaceSharedLiveOverlayForTests(p: LiveOverlayProvider): void {
  shared = p;
}

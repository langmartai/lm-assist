/** Core-side (in-process) content-overlay provider: bootstrap/guide only ever EXECUTE
 *  in the Core process (the stdio plugin forwards them over /mcp-call), so — unlike the
 *  tool overlay — content needs no stdio HTTP provider. Small TTL cache over the store,
 *  fail-OPEN (null ⇒ pure code defaults; content is a management layer, not a security
 *  boundary), invalidation hook for the /assist-content write routes so a local edit is
 *  visible on the very next bootstrap/guide call. */
import type { ContentState } from './content-model';
import type { ContentDoc } from './content-model';
import { listContentDocs } from './content-store';
import { peekDataService } from '../../data/data-service';

/** Default doc source: read the registry ONLY when the data service is already up
 *  (peek — never construct); see overlay-live.ts for the full rationale. guide/
 *  bootstrap fire this on every call, including in bare unit-test processes. */
function listDocsIfServiceUp(): Promise<ContentDoc[]> {
  const svc = peekDataService();
  if (!svc || !svc.isEnabled()) return Promise.resolve([]);
  return listContentDocs();
}

export interface ContentOverlayProvider {
  /** id → delta state for every stored doc; null on store failure (fail-open). */
  get(): Promise<ReadonlyMap<string, ContentState> | null>;
  invalidate(): void;
}

export function createLiveContentOverlayProvider(opts?: {
  ttlMs?: number;
  list?: typeof listContentDocs;
}): ContentOverlayProvider {
  const ttl = opts?.ttlMs ?? 1500;
  const list = opts?.list ?? listDocsIfServiceUp;
  let cached: { at: number; map: ReadonlyMap<string, ContentState> | null } | null = null;
  return {
    async get() {
      const now = Date.now();
      if (cached && now - cached.at < ttl && ttl > 0) return cached.map;
      let map: ReadonlyMap<string, ContentState> | null;
      try {
        const docs = await list();
        map = new Map(docs.map((d) => [d.name, {
          contentOverride: d.contentOverride ?? null,
          blurbOverride: d.blurbOverride ?? null,
        }]));
      } catch {
        map = null; // fail-open; cached below so a broken store isn't hammered
      }
      cached = { at: now, map };
      return map;
    },
    invalidate() {
      cached = null;
    },
  };
}

let shared: ContentOverlayProvider = createLiveContentOverlayProvider();

/** The provider instance the guide/bootstrap handlers + routes share (one cache). */
export function sharedContentOverlay(): ContentOverlayProvider {
  return shared;
}

/** Called by the /assist-content write routes after a local write lands. */
export function invalidateContentOverlayCache(): void {
  shared.invalidate();
}

/** Test-only seam: swap the shared instance (restore it in a finally). */
export function _replaceSharedContentOverlayForTests(p: ContentOverlayProvider): void {
  shared = p;
}

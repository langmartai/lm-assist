/** stdio-side overlay provider: the stdio MCP server is a thin HTTP client to the
 *  running core, so it learns the overlay the same way — `GET /mcp-tools/overlay`.
 *  Slightly longer TTL than the in-process provider (it costs a local HTTP hop) and
 *  fail-open like everything overlay: core unreachable ⇒ defaults served (every
 *  actual tool CALL fails without core anyway, and core-side shim guards still
 *  reject disabled calls). */
import { coreBaseUrl } from '../api-client';
import { lmAuthHeaders } from '../../auth/api-token';
import type { OverlayProvider, ToolOverlay } from './overlay';

export function createHttpOverlayProvider(opts?: { ttlMs?: number; baseUrl?: string }): OverlayProvider {
  const ttl = opts?.ttlMs ?? 5000;
  let cached: { at: number; overlay: ToolOverlay | null } | null = null;
  return {
    async get(): Promise<ToolOverlay | null> {
      const now = Date.now();
      if (cached && now - cached.at < ttl && ttl > 0) return cached.overlay;
      let overlay: ToolOverlay | null = null;
      try {
        const res = await fetch(`${opts?.baseUrl ?? coreBaseUrl()}/mcp-tools/overlay`, {
          headers: { ...lmAuthHeaders() },
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) {
          const body = (await res.json()) as { success?: boolean; data?: { byName?: ToolOverlay['byName'] } };
          if (body?.success && body.data?.byName && typeof body.data.byName === 'object') {
            overlay = { byName: body.data.byName };
          }
        }
      } catch {
        overlay = null; // fail-open
      }
      cached = { at: now, overlay };
      return overlay;
    },
  };
}

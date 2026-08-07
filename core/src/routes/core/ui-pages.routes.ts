/** Pluggable-UI page routes — the REST surface behind the ui_* MCP tools.
 *
 *  Local half (this host): serving status + lifecycle of the lmui dev servers the
 *  /ui-* hub route relays to (state contract: ~/.lmui/dev-<uiId>.json, lmui is the
 *  only writer — see ui-pages/manager.ts).
 *
 *  Gateway half: thin authenticated wrappers over the ui-gateway management surface
 *  (/registry/uis, /access/*) using THIS node's stored platform API key, so an agent
 *  completes the whole register → serve → grants lifecycle without a browser.
 */
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { uiPagesReport, controlPage, respawnDeadPages, defaultUiAppsDir } from '../../ui-pages/manager';
import { gatewayCall, publicUiUrl, resolvedGatewayUrl } from '../../ui-pages/gateway-client';
import { loadServicePorts, getHubConfig } from '../../hub-client/hub-config';

function uiAppsDirOverride(): string | undefined {
  return loadServicePorts().uiAppsDir;
}

export function createUiPagesRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/ui-pages$/,
      handler: async () => {
        try {
          const ports = loadServicePorts();
          const uiWebPort = ports.uiWebPort ?? null;
          const report = await uiPagesReport(uiWebPort, !!uiWebPort, defaultUiAppsDir(uiAppsDirOverride()));
          return { success: true, data: report };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/ui-pages\/control$/,
      handler: async (req: ParsedRequest) => {
        const b = req.body || {};
        const uiId = String(b.uiId || '');
        const action = String(b.action || '');
        if (!uiId || (action !== 'start' && action !== 'stop' && action !== 'respawn-dead')) {
          return { success: false, error: 'uiId and action (start|stop|respawn-dead) required' };
        }
        try {
          if (action === 'respawn-dead') {
            return { success: true, data: { results: respawnDeadPages((m) => console.log(m)) } };
          }
          const r = await controlPage(uiId, action as 'start' | 'stop');
          return r.ok ? { success: true, data: { detail: r.detail } } : { success: false, error: r.detail };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/ui-pages\/register$/,
      handler: async (req: ParsedRequest) => {
        const b = req.body || {};
        const uiId = String(b.uiId || '');
        if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(uiId)) return { success: false, error: 'uiId required: lowercase letters, digits, hyphens' };
        try {
          const hub = getHubConfig();
          if (!hub.gatewayId) return { success: false, error: 'this node has no gateway id yet — is it registered to a hub?' };
          const entry: Record<string, unknown> = {
            uiId,
            name: String(b.name || uiId),
            source: 'worker',
            workerId: hub.gatewayId,      // auto-wired: the agent never has to look this up
            service: `ui-${uiId}`,
            scope: String(b.scope || 'lm-assist'),
            access: 'owner',
            artifactDir: uiId,            // registration validation wants a name; worker source reads from the host
          };
          if (b.grant !== undefined) entry.grant = b.grant;
          const r = await gatewayCall('POST', '/registry/uis', entry);
          const url = publicUiUrl(uiId);
          return { success: true, data: { gatewayStatus: r.status, response: r.data, url } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/ui-pages\/registry$/,
      handler: async () => {
        try {
          const r = await gatewayCall('GET', '/registry/uis');
          const uis = ((r.data as { uis?: Array<{ uiId: string }> })?.uis) || [];
          // Merge local serving state so one call answers "registered AND alive?"
          const ports = loadServicePorts();
          const local = await uiPagesReport(ports.uiWebPort ?? null, !!ports.uiWebPort, defaultUiAppsDir(uiAppsDirOverride()));
          const byId = new Map(local.pages.map((p) => [p.uiId, p]));
          const merged = uis.map((u) => ({ ...u, url: publicUiUrl(u.uiId), local: byId.get(u.uiId) || null }));
          return { success: true, data: { gatewayStatus: r.status, uis: merged, localOnly: local.pages.filter((p) => !uis.some((u) => u.uiId === p.uiId)) } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/ui-pages\/registry\/(?<uiId>[a-z0-9-]+)$/,
      handler: async (req: ParsedRequest) => {
        try {
          const r = await gatewayCall('DELETE', `/registry/uis/${encodeURIComponent(req.params.uiId)}`);
          return { success: true, data: { gatewayStatus: r.status, response: r.data } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/ui-pages\/grants\/(?<uiId>[a-z0-9-]+)$/,
      handler: async (req: ParsedRequest) => {
        try {
          const scopes = await gatewayCall('GET', `/access/scopes?uiId=${encodeURIComponent(req.params.uiId)}`);
          const grants = await gatewayCall('GET', `/access/grants/${encodeURIComponent(req.params.uiId)}`);
          return { success: true, data: { scopes: scopes.data, grants: grants.data } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/ui-pages\/grants\/release$/,
      handler: async (req: ParsedRequest) => {
        const b = req.body || {};
        if (!b.uiId) return { success: false, error: 'uiId required' };
        try {
          const body: Record<string, unknown> = { uiId: String(b.uiId) };
          if (b.service) body.service = String(b.service);
          if (b.pathPrefix) body.pathPrefix = String(b.pathPrefix);
          const r = await gatewayCall('POST', '/access/revoke', body);
          return { success: true, data: { gatewayStatus: r.status, response: r.data } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/ui-pages\/gateway$/,
      handler: async () => {
        const hub = getHubConfig();
        return {
          success: true,
          data: {
            gatewayUrl: resolvedGatewayUrl(),
            workerId: hub.gatewayId,
            hubUrl: hub.hubUrl,
            hasApiKey: !!hub.apiKey,
          },
        };
      },
    },
  ];
}

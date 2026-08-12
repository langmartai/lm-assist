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
import * as os from 'os';
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { uiPagesReport, controlPage, respawnDeadPages, defaultUiAppsDir, setAutoStart, rememberAddressing, gatewayUiRef, addressingFor, listReportableUis } from '../../ui-pages/manager';
import { gatewayCall, resolvedGatewayUrl, uiIdError, readUiAddress } from '../../ui-pages/gateway-client';
import { reportStatusesOnce, uploadScreenshot } from '../../ui-pages/reporter';
import { loadServicePorts, getHubConfig } from '../../hub-client/hub-config';
import { isLocalTierRunning } from '../../ui-pages/local-tier/server';
import { mintEntryToken } from '../../ui-pages/local-tier/token';

function uiAppsDirOverride(): string | undefined {
  return loadServicePorts().uiAppsDir;
}

/** The local serving tier's port: explicit override, else uiWebPort+1 (null when no uiWebPort). */
function localUiPortOf(ports: ReturnType<typeof loadServicePorts>): number | null {
  if (ports.localUiPort) return ports.localUiPort;
  return ports.uiWebPort ? ports.uiWebPort + 1 : null;
}

/** First non-internal IPv4 — the address a browser off this box reaches the tier at. */
function firstLanIp(): string | null {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
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
          // Opportunistic heartbeat: a status read is the freshest data we'll ever have —
          // push it platform-side too (fire-and-forget; the interval reporter still runs).
          reportStatusesOnce().catch(() => {});
          // Local serving tier: its port (configured or derived) and whether its listener is up.
          return { success: true, data: { ...report, localUiPort: localUiPortOf(ports), localTierActive: isLocalTierRunning() } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/ui-pages\/local-url$/,
      handler: async (req: ParsedRequest) => {
        const uiId = String((req.body || {}).uiId || '');
        if (!uiId) return { success: false, error: 'uiId required' };
        try {
          // Only a UI this node actually serves can be handed a local URL — the entry token
          // is worthless without the lmui app behind it.
          if (!listReportableUis().some((u) => u.uiId === uiId)) {
            return { success: false, error: `no local UI '${uiId}' on this node (see ui_pages for what is served here)` };
          }
          const ports = loadServicePorts();
          if (!ports.uiWebPort) {
            return { success: false, error: 'uiWebPort is unset on this node — the local serving tier has no lmui host to front' };
          }
          const localUiPort = localUiPortOf(ports)!;
          const ip = firstLanIp();
          if (!ip) return { success: false, error: 'no non-internal IPv4 address found on this node' };
          const token = mintEntryToken(uiId);
          return { success: true, data: { url: `http://${ip}:${localUiPort}/ui/${uiId}/?lt=${token}`, expiresInSec: 600 } };
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
        const ACTIONS = ['start', 'stop', 'respawn-dead', 'autostart-on', 'autostart-off'];
        if (!uiId || !ACTIONS.includes(action)) {
          return { success: false, error: `uiId and action (${ACTIONS.join('|')}) required` };
        }
        try {
          if (action === 'respawn-dead') {
            return { success: true, data: { results: respawnDeadPages((m) => console.log(m)) } };
          }
          if (action === 'autostart-on' || action === 'autostart-off') {
            const on = action === 'autostart-on';
            setAutoStart(uiId, on);
            return { success: true, data: { detail: `${uiId}: autostart ${on ? 'enabled — boot respawn will bring it back' : 'disabled — stays down across Core restarts (running instance untouched)'}` } };
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
        const bad = uiIdError(uiId);
        if (bad) return { success: false, error: bad };
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
          // The response carries the uiKey the UI is addressed by and the origin it is
          // served at; keep both so later reads do not have to re-derive either.
          const addr = r.status < 300 ? readUiAddress(r.data) : {};
          if (r.status < 300) rememberAddressing(uiId, addr);
          return { success: true, data: { gatewayStatus: r.status, response: r.data, uiId, uiKey: addr.uiKey ?? null, url: addr.origin ?? null } };
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
          const uis = ((r.data as { uis?: Array<{ uiId: string; uiKey?: string; origin?: string }> })?.uis) || [];
          // Registry rows name the UI (uiId + uiKey) but the public URL only comes with the
          // overview rows, and it is not ours to construct — so ask for it once and index it
          // by uiKey, the field that is unique across owners.
          const originByKey = new Map<string, string>();
          if (uis.some((u) => !u.origin)) {
            try {
              const ov = await gatewayCall('GET', '/registry/uis/overview');
              for (const row of ((ov.data as { uis?: Array<{ uiKey?: string; origin?: string }> })?.uis) || []) {
                if (row.uiKey && row.origin) originByKey.set(row.uiKey, row.origin);
              }
            } catch { /* url stays unknown; the registration itself is still listed */ }
          }
          // Merge local serving state so one call answers "registered AND alive?"
          const ports = loadServicePorts();
          const local = await uiPagesReport(ports.uiWebPort ?? null, !!ports.uiWebPort, defaultUiAppsDir(uiAppsDirOverride()));
          const byId = new Map(local.pages.map((p) => [p.uiId, p]));
          const merged = uis.map((u) => {
            const origin = u.origin || (u.uiKey ? originByKey.get(u.uiKey) : undefined) || addressingFor(u.uiId).origin || null;
            rememberAddressing(u.uiId, { uiKey: u.uiKey, origin: origin ?? undefined });
            return { ...u, url: origin, local: byId.get(u.uiId) || null };
          });
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
          const r = await gatewayCall('DELETE', `/registry/uis/${encodeURIComponent(gatewayUiRef(req.params.uiId))}`);
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
      method: 'POST',
      pattern: /^\/ui-pages\/enable$/,
      handler: async (req: ParsedRequest) => {
        const b = req.body || {};
        const uiId = String(b.uiId || '');
        if (!uiId || typeof b.enabled !== 'boolean') return { success: false, error: 'uiId and enabled (boolean) required' };
        try {
          const r = await gatewayCall('PATCH', `/registry/uis/${encodeURIComponent(gatewayUiRef(uiId))}`, { enabled: b.enabled });
          if (r.status >= 300) return { success: false, error: `gateway refused (${r.status}): ${JSON.stringify(r.data)}` };
          return { success: true, data: { enabled: b.enabled } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/ui-pages\/screenshot$/,
      handler: async (req: ParsedRequest) => {
        const b = req.body || {};
        const uiId = String(b.uiId || '');
        const filePath = String(b.path || '');
        if (!uiId || !filePath) return { success: false, error: 'uiId and path (local image file) required' };
        try {
          const r = await uploadScreenshot(uiId, filePath);
          if (r.status >= 300) return { success: false, error: `gateway refused (${r.status}): ${JSON.stringify(r.data)}` };
          return { success: true, data: r.data };
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

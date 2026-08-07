/**
 * Pluggable-UI MCP tools — the full UI-page lifecycle over MCP, no browser, no CLI:
 * register a uiId (worker id auto-wired) → serve from this host → check serving status →
 * manage grants → unregister. Thin wrappers over the /ui-pages/* loopback routes
 * (routes/core/ui-pages.routes.ts); the state contract and respawn logic live in
 * ui-pages/manager.ts.
 *
 * Wiring: EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts), TOOL_SCOPES (configure.ts),
 * use-case in bootstrap + guide("ui-pages").
 */
import { ok, err, workerGet, workerPost, workerDelete, type McpToolResult } from './_passthrough';

export const uiPagesToolDef = {
  name: 'ui_pages',
  description:
    'Serving status of every pluggable UI page hosted on this node (the local lmui dev servers ' +
    'the hub /ui-* route relays to). Reports uiWebPort + whether the route is configured, the ' +
    'preferred app directory for new UIs, and per page: alive (pid), serving (HTTP probe), ' +
    'reachableViaHub (port matches uiWebPort), stale (dead + not respawnable) with the reason. ' +
    'Dead-but-respawnable pages auto-respawn when the Core boots. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const uiPagesControlToolDef = {
  name: 'ui_pages_control',
  description:
    'Start or stop one pluggable UI page\'s local server on this node. `stop` SIGTERMs the ' +
    'recorded pid (after verifying it is an lmui process) and parks the page so a Core restart ' +
    'does NOT respawn it; `start` resurrects a parked or dead page from its recorded state. ' +
    '`respawn-dead` re-runs the boot respawn sweep. WRITE — manages a local process.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      uiId: { type: 'string', description: 'The UI id (from ui_pages / ui_list).' },
      action: { type: 'string', enum: ['start', 'stop', 'respawn-dead'], description: 'What to do.' },
    },
    required: ['uiId', 'action'],
  },
};

export const uiRegisterToolDef = {
  name: 'ui_register',
  description:
    'Register a pluggable UI page on the platform UI gateway, served FROM THIS NODE: claims the ' +
    'uiId (which IS the subdomain — ui-<uiId>.<domain>, no DNS step exists), binds it to your ' +
    'account (owner-only serving), and auto-wires this node\'s worker id so the gateway relays ' +
    'file requests here. Returns the public URL. Serve the files with the lmui SDK ' +
    '(agentic-ui-spec) on this host\'s uiWebPort, then check ui_pages. Optional grant = the ' +
    'declared data-plane access rules. Re-registering your own uiId updates it. WRITE.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      uiId: { type: 'string', description: 'Lowercase letters/digits/hyphens. Becomes ui-<uiId>.<domain>.' },
      name: { type: 'string', description: 'Display name (defaults to uiId).' },
      scope: { type: 'string', description: 'Data-plane scope: "lm-assist" (default, this node\'s API) or "langmart" (platform API).' },
      grant: {
        type: 'array',
        description: 'Declared grant RULES (bare array, at least one — the gateway requires it), e.g. [{"service":"platform","pathPrefix":"/api/models","verbs":["GET"]}]. Services must belong to the scope (langmart→platform, lm-assist→node). More access can be requested at runtime.',
      },
    },
    required: ['uiId', 'grant'],
  },
};

export const uiListToolDef = {
  name: 'ui_list',
  description:
    'List YOUR registered pluggable UI pages from the platform UI gateway, merged with this ' +
    'node\'s local serving state — one call answers "registered, and is its server alive here?". ' +
    'Also returns pages serving locally but not registered (localOnly). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const uiGrantsToolDef = {
  name: 'ui_grants',
  description:
    'Access state of one of your pluggable UIs: the scope catalog, the declared (registration) ' +
    'grant, and every runtime-approved grant, as the UI gateway sees them. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: { uiId: { type: 'string', description: 'The UI id.' } },
    required: ['uiId'],
  },
};

export const uiGrantReleaseToolDef = {
  name: 'ui_grant_release',
  description:
    'Release runtime-approved access from one of your pluggable UIs — one rule when service + ' +
    'pathPrefix are given, or ALL runtime grants when omitted. The declared (registration) grant ' +
    'is not affected. WRITE.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      uiId: { type: 'string', description: 'The UI id.' },
      service: { type: 'string', description: 'Rule service (omit with pathPrefix to release everything).' },
      pathPrefix: { type: 'string', description: 'Rule path prefix.' },
    },
    required: ['uiId'],
  },
};

export const uiUnregisterToolDef = {
  name: 'ui_unregister',
  description:
    'Delete one of your pluggable UI registrations from the platform UI gateway. The subdomain ' +
    'stops resolving to a UI; local files on this node are untouched (stop the server with ' +
    'ui_pages_control). WRITE — removes the registration.',
  inputSchema: {
    type: 'object' as const,
    properties: { uiId: { type: 'string', description: 'The UI id to unregister.' } },
    required: ['uiId'],
  },
};

export const uiScreenshotToolDef = {
  name: 'ui_screenshot',
  description:
    'Upload a screenshot for one of your pluggable UIs to the platform (stored per UI, shown ' +
    'on the management pages). Pass a LOCAL image file path (png/jpg/webp, ≤12MB) — the ' +
    'gateway auto-resizes oversized captures (≤1280px wide, webp). WRITE.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      uiId: { type: 'string', description: 'The UI id the screenshot belongs to.' },
      path: { type: 'string', description: 'Absolute path of the image file on this node.' },
    },
    required: ['uiId', 'path'],
  },
};

export const UI_PAGES_TOOL_DEFS = [
  uiPagesToolDef, uiPagesControlToolDef, uiRegisterToolDef, uiListToolDef,
  uiGrantsToolDef, uiGrantReleaseToolDef, uiUnregisterToolDef, uiScreenshotToolDef,
] as const;

interface PageStatus {
  uiId: string; service: string; pid: number; port: number; dir: string; log: string;
  startedAt: string; alive: boolean; serving: boolean; reachableViaHub: boolean;
  stale: boolean; issue?: string;
}

function pageLine(p: PageStatus): string {
  const state = p.stale ? 'STALE' : !p.alive ? 'dead' : !p.serving ? 'not-serving' : p.reachableViaHub ? 'serving' : 'serving (port mismatch)';
  return `  ${p.uiId}  [${state}]  pid ${p.pid}  port ${p.port}  dir ${p.dir}${p.issue ? `\n    ⚠ ${p.issue}` : ''}`;
}

async function handleUiPages(): Promise<McpToolResult> {
  try {
    const d = await workerGet<{ uiWebPort: number | null; routeActive: boolean; uiAppsDir: string; pages: PageStatus[] }>('/ui-pages');
    const head = `uiWebPort: ${d.uiWebPort ?? 'NOT SET (no /ui-* route — set uiWebPort in hub.json and restart the Core)'} · route ${d.routeActive ? 'active' : 'inactive'}\npreferred app dir for new UIs: ${d.uiAppsDir}`;
    if (!d.pages.length) return ok(`${head}\n\nNo UI pages on this node (no ~/.lmui/dev-*.json state files). Scaffold one with the agentic-ui-spec lmui SDK, then ui_register it.`);
    return ok(`${head}\n\nPages (${d.pages.length}):\n${d.pages.map(pageLine).join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleUiPagesControl(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const d = await workerPost<{ detail?: string; results?: Array<{ uiId: string; action: string; reason?: string }> }>(
      '/ui-pages/control', { uiId: String(args.uiId || ''), action: String(args.action || '') });
    if (d.results) return ok('Respawn sweep:\n' + d.results.map((r) => `  ${r.uiId}: ${r.action}${r.reason ? ` (${r.reason})` : ''}`).join('\n'));
    return ok(d.detail || 'done');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleUiRegister(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const body: Record<string, unknown> = { uiId: String(args.uiId || '') };
    if (args.name) body.name = String(args.name);
    if (args.scope) body.scope = String(args.scope);
    if (args.grant !== undefined) body.grant = args.grant;
    const d = await workerPost<{ gatewayStatus: number; response: unknown; url: string | null }>('/ui-pages/register', body);
    if (d.gatewayStatus >= 300) return err(`gateway refused (${d.gatewayStatus}): ${JSON.stringify(d.response)}`);
    return ok(`Registered ${body.uiId} → ${d.url || '(url unknown)'}\nNext: serve the files on this node (lmui start on uiWebPort), then verify with ui_pages. Owner-only: only YOUR signed-in browser can open it.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleUiList(): Promise<McpToolResult> {
  try {
    const d = await workerGet<{
      gatewayStatus: number;
      uis: Array<{ uiId: string; name?: string; enabled?: boolean; scope?: string; url: string | null; local: PageStatus | null }>;
      localOnly: PageStatus[];
    }>('/ui-pages/registry');
    if (d.gatewayStatus >= 300) return err(`gateway refused (${d.gatewayStatus}) — is this node's API key valid?`);
    const lines = d.uis.map((u) => {
      const local = u.local ? (u.local.serving ? `serving locally (pid ${u.local.pid}, port ${u.local.port})` : u.local.stale ? 'local state STALE' : 'local server dead') : 'no local server on this node';
      return `  ${u.uiId}${u.enabled === false ? ' [disabled]' : ''}  scope=${u.scope || '?'}  ${u.url || ''}\n    ${local}`;
    });
    const localOnly = d.localOnly.length
      ? `\n\nServing locally but NOT registered (register with ui_register):\n${d.localOnly.map((p) => `  ${p.uiId} (port ${p.port})`).join('\n')}`
      : '';
    return ok(`Registered UIs (${d.uis.length}):\n${lines.join('\n') || '  (none)'}${localOnly}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleUiGrants(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const d = await workerGet<{ scopes: unknown; grants: unknown }>(`/ui-pages/grants/${encodeURIComponent(String(args.uiId || ''))}`);
    return ok(JSON.stringify(d, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleUiGrantRelease(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const body: Record<string, unknown> = { uiId: String(args.uiId || '') };
    if (args.service) body.service = String(args.service);
    if (args.pathPrefix) body.pathPrefix = String(args.pathPrefix);
    const d = await workerPost<{ gatewayStatus: number; response: unknown }>('/ui-pages/grants/release', body);
    if (d.gatewayStatus >= 300) return err(`gateway refused (${d.gatewayStatus}): ${JSON.stringify(d.response)}`);
    return ok(`Released: ${JSON.stringify(d.response)}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleUiUnregister(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const d = await workerDelete<{ gatewayStatus: number; response: unknown }>(`/ui-pages/registry/${encodeURIComponent(String(args.uiId || ''))}`);
    if (d.gatewayStatus >= 300) return err(`gateway refused (${d.gatewayStatus}): ${JSON.stringify(d.response)}`);
    return ok(`Unregistered ${args.uiId}. Local files + server on this node untouched (ui_pages_control to stop it).`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleUiScreenshot(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const d = await workerPost<{ ok?: boolean; width?: number; height?: number; bytes?: number }>(
      '/ui-pages/screenshot', { uiId: String(args.uiId || ''), path: String(args.path || '') });
    return ok(`Screenshot stored for ${args.uiId}: ${d.width}×${d.height}, ${d.bytes} bytes (auto-resized server-side). Visible on the /manage page and assist UI Pages.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const UI_PAGES_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  ui_pages: handleUiPages,
  ui_pages_control: handleUiPagesControl,
  ui_register: handleUiRegister,
  ui_list: handleUiList,
  ui_grants: handleUiGrants,
  ui_grant_release: handleUiGrantRelease,
  ui_unregister: handleUiUnregister,
  ui_screenshot: handleUiScreenshot,
};

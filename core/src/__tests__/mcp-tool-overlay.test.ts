/**
 * Overlay application (spec §4.4): the registry's {descriptionOverride, enabled}
 * deltas applied LIVE to tools/list + tools/call on BOTH transports via
 * configureMcpServer's optional provider. Mission gate coverage: override applied,
 * disabled filtered, unknown-name ignored, protected handled at store (not here),
 * fail-open on provider errors, live change without restart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  overlayFromDocs,
  applyOverlayToToolDefs,
  isToolDisabled,
  disabledResult,
  type ToolOverlay,
  type OverlayProvider,
} from '../mcp-server/registry/overlay';
import { configureMcpServer, type McpToolDispatcher, LM_ASSIST_TOOL_DEFS } from '../mcp-server/configure';
import type { ToolRegistryDoc } from '../mcp-server/registry/model';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

function regDoc(name: string, over: string | null, enabled: boolean): ToolRegistryDoc {
  return {
    name, descriptionOverride: over, enabled, rev: 1, history: [],
    createdBy: actor, lastUpdatedBy: actor, createdAt: 1, updatedAt: 1,
  };
}

const DEFS = [
  { name: 'alpha', description: 'default alpha', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
  { name: 'beta', description: 'default beta', inputSchema: { type: 'object', properties: {} } },
  { name: 'gamma', description: 'default gamma', inputSchema: { type: 'object', properties: {} } },
];

test('overlayFromDocs keys deltas by name', () => {
  const ov = overlayFromDocs([regDoc('alpha', 'better alpha', true), regDoc('beta', null, false)]);
  assert.deepEqual(ov.byName.alpha, { enabled: true, descriptionOverride: 'better alpha' });
  assert.deepEqual(ov.byName.beta, { enabled: false, descriptionOverride: null });
});

test('override swaps ONLY the description; schema/name untouched; other defs untouched', () => {
  const ov: ToolOverlay = { byName: { alpha: { enabled: true, descriptionOverride: 'better alpha' } } };
  const out = applyOverlayToToolDefs(DEFS, ov);
  assert.equal(out.length, 3);
  const alpha = out.find((d) => d.name === 'alpha')!;
  assert.equal(alpha.description, 'better alpha');
  assert.deepEqual(alpha.inputSchema, DEFS[0].inputSchema, 'schema untouched');
  assert.equal(out.find((d) => d.name === 'beta')!.description, 'default beta');
  assert.notEqual(alpha, DEFS[0], 'pure — new object, source not mutated');
  assert.equal(DEFS[0].description, 'default alpha');
});

test('disabled tools are filtered from the list', () => {
  const ov: ToolOverlay = { byName: { beta: { enabled: false, descriptionOverride: null } } };
  const out = applyOverlayToToolDefs(DEFS, ov);
  assert.deepEqual(out.map((d) => d.name), ['alpha', 'gamma']);
});

test('unknown overlay names are ignored; null overlay is identity', () => {
  const ov: ToolOverlay = { byName: { 'zz-e2e-probe': { enabled: false, descriptionOverride: 'x' } } };
  assert.deepEqual(applyOverlayToToolDefs(DEFS, ov), DEFS.map((d) => ({ ...d })));
  assert.deepEqual(applyOverlayToToolDefs(DEFS, null), DEFS.map((d) => ({ ...d })));
});

test('an enabled doc with null override changes nothing for that tool', () => {
  const ov: ToolOverlay = { byName: { alpha: { enabled: true, descriptionOverride: null } } };
  const out = applyOverlayToToolDefs(DEFS, ov);
  assert.equal(out.find((d) => d.name === 'alpha')!.description, 'default alpha');
});

test('isToolDisabled + disabledResult shape', () => {
  const ov: ToolOverlay = { byName: { beta: { enabled: false, descriptionOverride: null } } };
  assert.equal(isToolDisabled(ov, 'beta'), true);
  assert.equal(isToolDisabled(ov, 'alpha'), false);
  assert.equal(isToolDisabled(null, 'beta'), false);
  const r = disabledResult('beta');
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /TOOL_DISABLED/);
  assert.match(r.content[0].text, /"beta"/);
  assert.match(r.content[0].text, /mcp-tools/i);
});

// --- configureMcpServer wiring (both transports share this) ---

type Handler = (req?: unknown) => Promise<any>;
function fakeServer(): { server: any; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    setRequestHandler(schema: any, fn: Handler) {
      // The SDK schema objects carry the method literal at shape.method.value
      const method = schema?.shape?.method?.value ?? String(handlers.size);
      handlers.set(method, fn);
    },
  };
  return { server, handlers };
}

function providerOf(ref: { overlay: ToolOverlay | null; throwErr?: boolean; calls: number }): OverlayProvider {
  return {
    get: async () => {
      ref.calls++;
      if (ref.throwErr) throw new Error('store down');
      return ref.overlay;
    },
  };
}

test('ListTools applies the overlay LIVE — provider consulted per request, changes visible without reconfigure', async () => {
  const { server, handlers } = fakeServer();
  const ref = { overlay: null as ToolOverlay | null, calls: 0 };
  const dispatch: McpToolDispatcher = async () => ({ content: [{ type: 'text', text: 'ok' }] });
  configureMcpServer(server, dispatch, providerOf(ref));
  const list = handlers.get('tools/list')!;

  const before = await list();
  assert.equal(before.tools.length, LM_ASSIST_TOOL_DEFS.length);

  const victim = LM_ASSIST_TOOL_DEFS.find((d) => d.name === 'detail')!;
  ref.overlay = { byName: { detail: { enabled: true, descriptionOverride: 'OVERRIDDEN detail' } } };
  const after = await list();
  assert.equal(after.tools.find((t: any) => t.name === 'detail').description, 'OVERRIDDEN detail');
  assert.notEqual(victim.description, 'OVERRIDDEN detail', 'canonical defs never mutated');

  ref.overlay = { byName: { detail: { enabled: false, descriptionOverride: null } } };
  const gone = await list();
  assert.equal(gone.tools.find((t: any) => t.name === 'detail'), undefined);
  assert.equal(gone.tools.length, LM_ASSIST_TOOL_DEFS.length - 1);
  assert.ok(ref.calls >= 3, 'provider consulted per request');
});

test('CallTool rejects a disabled tool with TOOL_DISABLED and never dispatches', async () => {
  const { server, handlers } = fakeServer();
  const ref = { overlay: { byName: { detail: { enabled: false, descriptionOverride: null } } } as ToolOverlay | null, calls: 0 };
  let dispatched = 0;
  const dispatch: McpToolDispatcher = async () => { dispatched++; return { content: [{ type: 'text', text: 'ran' }] }; };
  configureMcpServer(server, dispatch, providerOf(ref));
  const call = handlers.get('tools/call')!;

  const r = await call({ params: { name: 'detail', arguments: {} } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /TOOL_DISABLED/);
  assert.equal(dispatched, 0, 'dispatch must not run for a disabled tool');

  const ok = await call({ params: { name: 'search', arguments: {} } });
  assert.notEqual(ok.isError, true);
  assert.equal(dispatched, 1, 'enabled tools dispatch normally');
});

test('no provider → behavior identical to today (all defs, dispatch runs)', async () => {
  const { server, handlers } = fakeServer();
  let dispatched = 0;
  const dispatch: McpToolDispatcher = async () => { dispatched++; return { content: [{ type: 'text', text: 'ran' }] }; };
  configureMcpServer(server, dispatch);
  const list = await handlers.get('tools/list')!();
  assert.equal(list.tools.length, LM_ASSIST_TOOL_DEFS.length);
  const r = await handlers.get('tools/call')!({ params: { name: 'detail', arguments: {} } });
  assert.notEqual(r.isError, true);
  assert.equal(dispatched, 1);
});

test('provider failure is fail-open: defaults served, calls dispatch', async () => {
  const { server, handlers } = fakeServer();
  const ref = { overlay: null, throwErr: true, calls: 0 };
  let dispatched = 0;
  const dispatch: McpToolDispatcher = async () => { dispatched++; return { content: [{ type: 'text', text: 'ran' }] }; };
  configureMcpServer(server, dispatch, providerOf(ref));
  const list = await handlers.get('tools/list')!();
  assert.equal(list.tools.length, LM_ASSIST_TOOL_DEFS.length, 'defaults on provider error');
  const r = await handlers.get('tools/call')!({ params: { name: 'detail', arguments: {} } });
  assert.notEqual(r.isError, true);
  assert.equal(dispatched, 1);
});

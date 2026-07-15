/**
 * Runtime integration (spec §4.4 + mission req 4): a registry edit made through the
 * REST handler is visible on the very next tools/list + tools/call — no restart —
 * through the same wiring the transports use (store → live provider →
 * configureMcpServer). Uses an in-memory port + a real createLiveOverlayProvider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleToolSet } from '../routes/core/mcp-tools.routes';
import { createLiveOverlayProvider } from '../mcp-server/registry/overlay-live';
import { configureMcpServer, LM_ASSIST_TOOL_DEFS, type McpToolDispatcher } from '../mcp-server/configure';
import type { ToolRegistryPort } from '../mcp-server/registry/store';
import type { ToolRegistryDoc } from '../mcp-server/registry/model';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

function memPort(): ToolRegistryPort {
  const docs = new Map<string, ToolRegistryDoc>();
  return {
    isEnabled: () => true,
    get: async (name) => docs.get(name) ?? null,
    list: async () => [...docs.values()],
    put: async (d) => { docs.set(d.name, d); },
  };
}

function fakeServer(): { server: any; handlers: Map<string, (req?: unknown) => Promise<any>> } {
  const handlers = new Map<string, (req?: unknown) => Promise<any>>();
  return {
    handlers,
    server: {
      setRequestHandler(schema: any, fn: (req?: unknown) => Promise<any>) {
        handlers.set(schema?.shape?.method?.value ?? String(handlers.size), fn);
      },
    },
  };
}

test('edit → list → call → re-enable, live through the real provider (no restart, no reconfigure)', async () => {
  const port = memPort();
  // ttlMs 0 stands in for "TTL expired / cache invalidated" — the write route calls
  // invalidateOverlayCache() on the shared provider in production wiring.
  const provider = createLiveOverlayProvider({ ttlMs: 0, list: () => port.list() });
  const { server, handlers } = fakeServer();
  let dispatched: string[] = [];
  const dispatch: McpToolDispatcher = async (name) => { dispatched.push(name); return { content: [{ type: 'text', text: 'ran' }] }; };
  configureMcpServer(server, dispatch, provider);
  const list = handlers.get('tools/list')!;
  const call = handlers.get('tools/call')!;

  // 1. pristine: full list, default description
  const l1 = await list();
  assert.equal(l1.tools.length, LM_ASSIST_TOOL_DEFS.length);
  const defaultDetail = l1.tools.find((t: any) => t.name === 'detail').description;

  // 2. override the description via the REST handler → next list reflects it
  const set1 = await handleToolSet('detail', { descriptionOverride: 'E2E OVERRIDE (runtime test)' }, port, actor);
  assert.equal(set1.success, true);
  const l2 = await list();
  assert.equal(l2.tools.find((t: any) => t.name === 'detail').description, 'E2E OVERRIDE (runtime test)');

  // 3. disable → omitted from list, call rejected before dispatch
  const set2 = await handleToolSet('detail', { enabled: false }, port, actor);
  assert.equal(set2.success, true);
  const l3 = await list();
  assert.equal(l3.tools.find((t: any) => t.name === 'detail'), undefined);
  dispatched = [];
  const r = await call({ params: { name: 'detail', arguments: { id: 'K001' } } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /TOOL_DISABLED/);
  assert.deepEqual(dispatched, [], 'disabled call never dispatched');

  // 4. restore default: re-enable + clear override → pristine again
  const set3 = await handleToolSet('detail', { enabled: true, descriptionOverride: null }, port, actor);
  assert.equal(set3.success, true);
  const l4 = await list();
  const restored = l4.tools.find((t: any) => t.name === 'detail');
  assert.equal(restored.description, defaultDetail);
  const ok = await call({ params: { name: 'detail', arguments: { id: 'K001' } } });
  assert.notEqual(ok.isError, true);
  assert.deepEqual(dispatched, ['detail']);
});

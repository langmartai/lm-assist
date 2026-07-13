/** Workflow-registry MCP tools (proxy the /mission/workflows routes). */
import type { McpToolResult } from '../configure';
import { ok, err, workerGet, workerPost } from './_passthrough';
import { currentMcpContext } from '../principal-context';
import { withActorHint } from './mission-query';

const S = { type: 'string' as const };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required });
const pretty = (v: unknown): McpToolResult => ok(JSON.stringify(v, null, 2));

export const MISSION_WORKFLOW_TOOL_DEFS = [
  { name: 'mission_workflow_list', description: 'List mission-control workflow/playbook docs (stored + un-seeded TS defaults). These agent-interpreted docs define how the controller onboards, drives, and wraps up work.', inputSchema: obj({}) },
  { name: 'mission_workflow_get', description: 'Get one workflow doc by id (e.g. controller.pass, onboard.analyze, drive.bugfix): {doc (stored or null), defaultBody, rendered (invariant preamble + body — the text to FOLLOW)}.', inputSchema: obj({ id: S }, ['id']) },
  { name: 'mission_workflow_set', description: 'Create/update a workflow doc: {id, body, title?, editPolicy?:open|human-only}. Versioned + attributed; human-only docs and editPolicy changes reject controller callers. Self-edits must be announced in chat.', inputSchema: obj({ id: S, body: S, title: S, editPolicy: { ...S, enum: ['open', 'human-only'] } }, ['id', 'body']) },
  { name: 'mission_workflow_history', description: 'Snapshot history of a workflow doc, newest-first: {id, limit?, beforeRev?} → rev/at/actor/title/bodyBytes per revision.', inputSchema: obj({ id: S, limit: { type: 'number' as const }, beforeRev: { type: 'number' as const } }, ['id']) },
  { name: 'mission_workflow_rollback', description: 'Roll a workflow doc back to an earlier revision (writes that revision as a NEW attributed rev): {id, toRev}.', inputSchema: obj({ id: S, toRev: { type: 'number' as const } }, ['id', 'toRev']) },
] as const;

export const MISSION_WORKFLOW_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  mission_workflow_list: async () => { try { return pretty(await workerGet('/mission/workflows')); } catch (e) { return err((e as Error).message); } },
  mission_workflow_get: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerGet(`/mission/workflows/${encodeURIComponent(id)}`)); } catch (e) { return err((e as Error).message); } },
  mission_workflow_set: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerPost(`/mission/workflows/${encodeURIComponent(id)}`, withActorHint(a, currentMcpContext()?.toolUseId))); } catch (e) { return err((e as Error).message); } },
  mission_workflow_history: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); const qs = new URLSearchParams(); if (a.limit != null) qs.set('limit', String(a.limit)); if (a.beforeRev != null) qs.set('beforeRev', String(a.beforeRev)); return pretty(await workerGet(`/mission/workflows/${encodeURIComponent(id)}/history${qs.toString() ? `?${qs}` : ''}`)); } catch (e) { return err((e as Error).message); } },
  mission_workflow_rollback: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerPost(`/mission/workflows/${encodeURIComponent(id)}/rollback`, withActorHint(a, currentMcpContext()?.toolUseId))); } catch (e) { return err((e as Error).message); } },
};

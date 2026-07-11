# Cowork Chat UI — Spec 1 Cowork Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a claude.ai-look-alike **Cowork** surface in the lm-assist web UI — a `/cowork` page (composer with `Chat|Cowork` toggle + unified task list + task-detail with a Progress/Outputs/Context right rail), backed by a new `/cowork/*` Core API family that drives `api.anthropic.com/v1/code/sessions` over the Claude Code OAuth token, with SSE live updates (polling fallback).

**Architecture:** Core reuses the existing OAuth primitives (`anthropicOAuth{Get,Post,Delete}` in `core/src/utils/claude-oauth.ts`) and `cloudAnswer` (from `core/src/terminal/ccr-cloud.ts`) for approvals; adds one new pure parser (`parseCoworkEvents`) and thin task-ops. The web page reuses transcript/approval rendering extracted from `web/src/components/ccr/CcrCloudView.tsx`. SSE is a special-cased path in `rest-server.ts`; the browser consumes it with a fetch-`ReadableStream` reader (not `EventSource`, which can't send `x-api-key`) and falls back to 5s polling when relayed/remote.

**Tech Stack:** TypeScript (CommonJS core, `node --test`), Next.js 16 / React 19 web (vitest for pure logic; components verified by `next build` + manual browser), Tailwind v4 + the repo's CSS-variable design tokens.

**Spec:** `docs/superpowers/specs/2026-07-12-cowork-chat-ui-foundation-design.md`

## Global Constraints

- **chokidar stays `^3.6.0`** — never bump (ESM-only v4/v5 crash the CJS core). Do not touch it.
- **Core is CommonJS** (`core/tsconfig.json` → `module: commonjs`). Any `await import('esm-pkg')` must be indirected through `new Function('m','return import(m)')`. (Not needed for this plan — all deps are CJS.)
- **Never hardcode ports** `3100`/`3848`/`3200`/`3948`. Core uses `__dirname.includes('node_modules')` detection; web uses `NEXT_PUBLIC_LOCAL_API_PORT`. This plan adds no port literals.
- **All Core route handlers** return `wrapResponse`/`wrapError` (or the `envelope()` helper) and attach `httpStatus` for non-2xx — the pattern already in `cowork.routes.ts` and `ccr.routes.ts`.
- **Cowork runtime endpoints are `/v1/code/sessions/{cse}`** (NOT `/v1/sessions/*`, which is BYOC/CCR). Verified: create/send/read/drive/answer/delete all on `/v1/code/sessions`. Delete `DELETE /v1/code/sessions/{cse}` → 200 then GET → 404.
- **OAuth headers (cowork):** every `anthropicOAuth*` call passes `ccOpts()` = `{ betaHeader:'ccr-byoc-2025-07-29', extraHeaders:{ 'anthropic-version':'2023-06-01', 'x-organization-uuid': <org> } }` (the helper already in `cowork-tasks.ts`).
- **Models:** `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`; effort `low|medium|high|max` → `config.effort_level`. Default `claude-sonnet-5` / `medium`.
- **Work location:** worktree `/home/ubuntu/lm-assist/.claude/worktrees/feat+cowork-task-creation`, branch `worktree-feat+cowork-task-creation`. Run all `git`/`npm`/`./core.sh` from there. Build core with `./core.sh build`; run core tests with `npm test` (→ `build:test` → `node --test dist-test/`). Do NOT touch prod (`:3100`) or the running dev service unless a task says to.
- **Every created test cowork session MUST be deleted** at the end of its test (`DELETE /v1/code/sessions/{cse}`; assert GET → 404). Never orphan a session.

---

## File Structure

**Core (backend):**
- `core/src/cowork/cowork-read.ts` — **new.** Pure `parseCoworkEvents(eventsBody, sessionBody?)`. No I/O.
- `core/src/cowork/cowork-tasks.ts` — **extend.** Add `listCoworkTasks`, `getCoworkTask`, `driveCoworkTask`, `renameCoworkTask`, `archiveCoworkTask`, `deleteCoworkTask`, `pinCoworkTask`. Re-export `cloudAnswer` usage for the answer route.
- `core/src/utils/claude-oauth.ts` — **extend.** Add `anthropicOAuthPut` (mirrors `anthropicOAuthPost`).
- `core/src/routes/core/cowork.routes.ts` — **extend.** Add the `/cowork/tasks*` GET/POST/DELETE handlers.
- `core/src/rest-server.ts` — **extend.** Special-cased SSE path `GET /cowork/tasks/:cse/stream`.
- `core/src/cowork/__tests__/cowork-read.test.ts` — **new.** Parser unit tests + inline fixtures.
- `core/src/cowork/__tests__/cowork-ops.test.ts` — **new.** Task-ops unit tests (mock `claude-oauth`).

**Web (frontend):**
- `web/src/lib/cowork-stream.ts` — **new.** Pure: SSE frame parse, event-merge reducer, SSE-vs-poll decision.
- `web/src/lib/__tests__/cowork-stream.test.ts` — **new.** vitest.
- `web/src/components/shared/TranscriptMessage.tsx` — **new** (extracted from CcrCloudView).
- `web/src/components/shared/ApprovalWidget.tsx` — **new** (extracted from CcrCloudView).
- `web/src/hooks/useLiveTranscript.ts` — **new.** SSE-first + poll fallback.
- `web/src/components/ccr/CcrCloudView.tsx` — **refactor** to consume the two shared components (no behavior change).
- `web/src/components/cowork/ModelEffortSelector.tsx` — **new.**
- `web/src/components/cowork/CoworkComposer.tsx` — **new.**
- `web/src/components/cowork/CoworkList.tsx` — **new.**
- `web/src/components/cowork/CoworkRightRail.tsx` — **new.**
- `web/src/components/cowork/CoworkTaskView.tsx` — **new.**
- `web/src/components/cowork/CoworkPage.tsx` — **new.** Shell.
- `web/src/app/(dashboard)/cowork/page.tsx` — **new.** Route → `<CoworkPage/>`.
- `web/src/components/layout/Sidebar.tsx` — **extend.** Add the `/cowork` nav entry.

---

## Task 1: `parseCoworkEvents` — the event-stream parser (keystone)

**Files:**
- Create: `core/src/cowork/cowork-read.ts`
- Test: `core/src/cowork/__tests__/cowork-read.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  ```ts
  export interface CoworkMsg { role: 'user' | 'assistant'; type: string; text: string; tools?: string[] }
  export interface CoworkGoalStep { label: string; status: 'done' | 'active' | 'pending' }
  export interface CoworkContext { tools: string[]; files: string[] }
  export interface CoworkPending { toolUseId: string; requestId?: string; questions: Array<{ header?: string; question?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }> }
  export interface CoworkDetail {
    messages: CoworkMsg[];
    activeGoal: CoworkGoalStep[];
    outputs: string[];
    context: CoworkContext;
    pendingQuestion: CoworkPending | null;
    statusCategory: string | null;
  }
  export function parseCoworkEvents(eventsBody: unknown, sessionBody?: unknown): CoworkDetail
  ```

The July events read shape is `{ data: [event…], resume_cursor }`; each event is `{ event_id, event_type, sequence_num, source, payload, created_at }`. Cowork specifics (verified in 123 captures): the assistant's reply arrives as a `SendUserMessage` **tool_use** (`payload.message.content[].type==='tool_use' && name==='SendUserMessage'`, text under `input.message`/`input.text`); progress is an `active_goal` payload; output files appear in `system` events `subtype:'task_notification'` with `output_file`, and in tool_use inputs writing under `/mnt/user-data/outputs`; `statusCategory` is `sessionBody.post_turn_summary.status_category`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/cowork/__tests__/cowork-read.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoworkEvents } from '../cowork-read';

const EVENTS = {
  data: [
    { event_type: 'user', sequence_num: '1', source: 'client',
      payload: { type: 'user', message: { role: 'user', content: 'write a file then reply DONE' } } },
    { event_type: 'assistant', sequence_num: '2', source: 'worker',
      payload: { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'echo hi > /mnt/user-data/outputs/capture.md' } },
      ] } } },
    { event_type: 'system', sequence_num: '3', source: 'worker',
      payload: { type: 'system', subtype: 'task_notification', status: 'completed', output_file: 'capture.md' } },
    { event_type: 'assistant', sequence_num: '4', source: 'worker',
      payload: { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'SendUserMessage', input: { message: 'DONE' } },
      ] } } },
    { event_type: 'active_goal', sequence_num: '5', source: 'worker',
      payload: { type: 'active_goal', steps: [
        { title: 'write file', state: 'completed' }, { title: 'reply', state: 'in_progress' },
      ] } },
  ],
  resume_cursor: 'c5',
};
const SESSION = { post_turn_summary: { status_category: 'review_ready' } };

test('extracts user + assistant(SendUserMessage) messages', () => {
  const d = parseCoworkEvents(EVENTS, SESSION);
  assert.equal(d.messages[0].role, 'user');
  assert.match(d.messages[0].text, /write a file/);
  const reply = d.messages.find((m) => m.role === 'assistant' && m.text === 'DONE');
  assert.ok(reply, 'SendUserMessage reply becomes an assistant text message');
});

test('collects outputs, context, activeGoal, statusCategory', () => {
  const d = parseCoworkEvents(EVENTS, SESSION);
  assert.deepEqual(d.outputs, ['capture.md']);
  assert.ok(d.context.tools.includes('Bash'));
  assert.equal(d.activeGoal.length, 2);
  assert.equal(d.activeGoal[0].status, 'done');
  assert.equal(d.activeGoal[1].status, 'active');
  assert.equal(d.statusCategory, 'review_ready');
});

test('tolerates empty / malformed input', () => {
  assert.deepEqual(parseCoworkEvents(null).messages, []);
  assert.deepEqual(parseCoworkEvents({ data: 'nope' }).outputs, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd .claude/worktrees/feat+cowork-task-creation && npm test 2>&1 | grep -A3 cowork-read`
Expected: FAIL — `Cannot find module '../cowork-read'`.

- [ ] **Step 3: Write the implementation**

```ts
// core/src/cowork/cowork-read.ts
/**
 * Pure parser for a cowork task's event stream (GET /v1/code/sessions/{cse}/events
 * → { data:[event…], resume_cursor }). Produces the transcript + right-rail data.
 * Cowork specifics: the assistant reply is a `SendUserMessage` tool_use; progress
 * is an `active_goal` payload; outputs come from `task_notification.output_file`
 * and tool_uses writing under /mnt/user-data/outputs. See docs/cowork-web-endpoints.md §5.
 */
export interface CoworkMsg { role: 'user' | 'assistant'; type: string; text: string; tools?: string[] }
export interface CoworkGoalStep { label: string; status: 'done' | 'active' | 'pending' }
export interface CoworkContext { tools: string[]; files: string[] }
export interface CoworkPending { toolUseId: string; requestId?: string; questions: Array<{ header?: string; question?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }> }
export interface CoworkDetail {
  messages: CoworkMsg[];
  activeGoal: CoworkGoalStep[];
  outputs: string[];
  context: CoworkContext;
  pendingQuestion: CoworkPending | null;
  statusCategory: string | null;
}

const OUTPUTS_DIR = '/mnt/user-data/outputs';

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
}

function goalState(s: unknown): CoworkGoalStep['status'] {
  const v = String(s || '').toLowerCase();
  if (/complete|done|success/.test(v)) return 'done';
  if (/progress|active|running|current/.test(v)) return 'active';
  return 'pending';
}

export function parseCoworkEvents(eventsBody: unknown, sessionBody?: unknown): CoworkDetail {
  const empty: CoworkDetail = { messages: [], activeGoal: [], outputs: [], context: { tools: [], files: [] }, pendingQuestion: null, statusCategory: null };
  const data = (eventsBody as any)?.data;
  const session: any = sessionBody || {};
  const statusCategory: string | null = session?.post_turn_summary?.status_category
    ?? session?.response_shape?.post_turn_summary?.status_category ?? null;
  if (!Array.isArray(data)) return { ...empty, statusCategory };

  const messages: CoworkMsg[] = [];
  const outputs = new Set<string>();
  const toolNames = new Set<string>();
  const files = new Set<string>();
  let activeGoal: CoworkGoalStep[] = [];
  let pendingQuestion: CoworkPending | null = null;

  for (const ev of data) {
    const p: any = ev?.payload || {};
    const etype = ev?.event_type || p?.type;

    if (etype === 'active_goal' || p?.type === 'active_goal') {
      const steps: any[] = p?.steps || p?.goal?.steps || [];
      activeGoal = steps.map((s) => ({ label: String(s?.title || s?.label || s?.text || ''), status: goalState(s?.state || s?.status) }));
      continue;
    }
    if (etype === 'system' || p?.type === 'system') {
      if (p?.output_file) outputs.add(String(p.output_file).split('/').pop() as string);
      continue;
    }
    const msg = p?.message;
    const role: string = msg?.role || (etype === 'user' ? 'user' : etype === 'assistant' ? 'assistant' : '');
    if (role !== 'user' && role !== 'assistant') continue;

    const content = msg?.content;
    let text = textFromContent(content);
    const tools: string[] = [];
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use') {
          const name = String(b?.name || 'tool');
          if (name === 'SendUserMessage') {
            const reply = b?.input?.message ?? b?.input?.text ?? b?.input?.content;
            if (typeof reply === 'string' && reply.trim()) text = (text ? text + '\n' : '') + reply;
            continue; // the reply IS the assistant text, not a tool card
          }
          if (name === 'AskUserQuestion' && !pendingQuestion) {
            const qs = b?.input?.questions;
            if (Array.isArray(qs)) pendingQuestion = { toolUseId: String(b?.id || ''), questions: qs };
          }
          toolNames.add(name);
          tools.push(name);
          const path = b?.input?.file_path || b?.input?.path;
          if (typeof path === 'string') { files.add(path); if (path.includes(OUTPUTS_DIR)) outputs.add(path.split('/').pop() as string); }
          const cmd = String(b?.input?.command || '');
          const m = cmd.match(/\/mnt\/user-data\/outputs\/([^\s'"]+)/);
          if (m) outputs.add(m[1]);
        }
      }
    }
    messages.push({ role: role as 'user' | 'assistant', type: role, text, ...(tools.length ? { tools } : {}) });
  }

  return { messages, activeGoal, outputs: [...outputs], context: { tools: [...toolNames], files: [...files] }, pendingQuestion, statusCategory };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -E "cowork-read|pass|fail" | head`
Expected: the three `cowork-read` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/cowork/cowork-read.ts core/src/cowork/__tests__/cowork-read.test.ts
git commit -m "feat(cowork): parseCoworkEvents — transcript + right-rail parser"
```

---

## Task 2: OAuth PUT helper + cowork task-ops

**Files:**
- Modify: `core/src/utils/claude-oauth.ts` (add `anthropicOAuthPut` after `anthropicOAuthPost` ~line 424)
- Modify: `core/src/cowork/cowork-tasks.ts` (add ops after `createCoworkTask`)
- Test: `core/src/cowork/__tests__/cowork-ops.test.ts`

**Interfaces:**
- Consumes: `anthropicOAuthGet/Post/Put/Delete`, `getOrganizationUuid` (claude-oauth); `parseCoworkEvents` (Task 1); `cloudAnswer` (ccr-cloud); the existing `ccOpts()` helper in cowork-tasks.ts (rename the private `ccrOpts` there to exported `ccOpts` if not already exported — it currently exists as a local `ccrOpts`; export it).
- Produces:
  ```ts
  export interface CoworkListItem { sid: string; title?: string; status?: string; model?: string; lastEventAt?: string; statusCategory?: string | null; archived?: boolean }
  export async function listCoworkTasks(opts?: { filter?: 'all'|'cowork'|'archived'; limit?: number }): Promise<{ tasks: CoworkListItem[]; nextCursor?: string }>
  export async function getCoworkTask(cse: string): Promise<import('./cowork-read').CoworkDetail & { sid: string; title?: string; status?: string; model?: string }>
  export async function driveCoworkTask(opts: { cse: string; text: string }): Promise<{ delivered: boolean; eventId?: string }>
  export async function renameCoworkTask(cse: string, title: string): Promise<{ ok: true; title: string }>
  export async function archiveCoworkTask(cse: string, archived: boolean): Promise<{ ok: true; archived: boolean }>
  export async function pinCoworkTask(cse: string, pinned: boolean): Promise<{ ok: true; pinned: boolean }>
  export async function deleteCoworkTask(cse: string): Promise<{ ok: true }>
  ```
  (Answers reuse `cloudAnswer({ sid: cse, answer, toolUseId, requestId })` directly from the route — no wrapper.)

- [ ] **Step 1: Write the failing test**

```ts
// core/src/cowork/__tests__/cowork-ops.test.ts
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as oauth from '../../utils/claude-oauth';
import { listCoworkTasks, getCoworkTask, driveCoworkTask, renameCoworkTask, deleteCoworkTask } from '../cowork-tasks';

afterEach(() => mock.restoreAll());
function stubOrg() { mock.method(oauth, 'getOrganizationUuid', async () => 'org-x'); }
function ok(body: any, status = 200) { return { status, statusText: 'OK', headers: {}, body }; }

test('listCoworkTasks maps + filters cowork-tagged sessions', async () => {
  stubOrg();
  mock.method(oauth, 'anthropicOAuthGet', async (path: string) => {
    assert.match(path, /^\/v1\/code\/sessions/);
    return ok({ data: [
      { id: 'cse_a', title: 'A', status: 'active', tags: ['cowork', 'product:cowork-remote'], config: { model: 'claude-sonnet-5' }, last_event_at: 't1', post_turn_summary: { status_category: 'review_ready' } },
      { id: 'sess_b', title: 'not cowork', tags: ['code'] },
    ] });
  });
  const { tasks } = await listCoworkTasks({ filter: 'cowork' });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].sid, 'cse_a');
  assert.equal(tasks[0].statusCategory, 'review_ready');
});

test('getCoworkTask reads /events + session and parses', async () => {
  stubOrg();
  mock.method(oauth, 'anthropicOAuthGet', async (path: string) => {
    if (path.endsWith('/events')) return ok({ data: [
      { event_type: 'user', payload: { type: 'user', message: { role: 'user', content: 'hi' } } },
    ] });
    return ok({ id: 'cse_a', title: 'A', config: { model: 'claude-sonnet-5' }, post_turn_summary: { status_category: 'idle' } });
  });
  const d = await getCoworkTask('cse_a');
  assert.equal(d.sid, 'cse_a');
  assert.equal(d.messages[0].text, 'hi');
  assert.equal(d.statusCategory, 'idle');
});

test('driveCoworkTask posts a user event to /v1/code/sessions/{cse}/events', async () => {
  stubOrg();
  let posted: any;
  mock.method(oauth, 'anthropicOAuthPost', async (path: string, body: any) => { posted = { path, body }; return ok({ results: [{ event_id: 'e1' }] }); });
  const r = await driveCoworkTask({ cse: 'cse_a', text: 'go' });
  assert.equal(r.delivered, true);
  assert.match(posted.path, /\/v1\/code\/sessions\/cse_a\/events$/);
  assert.equal(posted.body.events[0].payload.message.content, 'go');
});

test('renameCoworkTask PUTs the title; delete DELETEs', async () => {
  stubOrg();
  let put: any, del: any;
  mock.method(oauth, 'anthropicOAuthPut', async (path: string, body: any) => { put = { path, body }; return ok({}); });
  mock.method(oauth, 'anthropicOAuthDelete', async (path: string) => { del = path; return ok({}); });
  await renameCoworkTask('cse_a', 'New');
  await deleteCoworkTask('cse_a');
  assert.match(put.path, /\/v1\/code\/sessions\/cse_a$/);
  assert.equal(put.body.title, 'New');
  assert.match(del, /\/v1\/code\/sessions\/cse_a$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 cowork-ops`
Expected: FAIL — `listCoworkTasks` (and siblings) not exported.

- [ ] **Step 3a: Add `anthropicOAuthPut`**

In `core/src/utils/claude-oauth.ts`, immediately after `anthropicOAuthPost` (~line 424):

```ts
export async function anthropicOAuthPut(pathname: string, body?: any, opts: AnthropicOAuthRequestOpts = {}) {
  return anthropicOAuthRequest('PUT', pathname, { ...opts, body });
}
```

(Match the exact shape of `anthropicOAuthPost` above it — if `anthropicOAuthPost` passes `body` positionally to `anthropicOAuthRequest`, mirror that. Read lines 419–424 first and copy the call convention verbatim.)

- [ ] **Step 3b: Export `ccOpts` + add the ops in `cowork-tasks.ts`**

In `core/src/cowork/cowork-tasks.ts`: rename the local `ccrOpts` to `export async function ccOpts()` (update its call sites in `createCoworkTask`). Then add:

```ts
import { anthropicOAuthGet, anthropicOAuthPut, anthropicOAuthDelete } from '../utils/claude-oauth';
import { parseCoworkEvents, type CoworkDetail } from './cowork-read';

const COWORK_TAGS = ['cowork', 'product:cowork-remote', 'config:cowork-remote'];

export interface CoworkListItem { sid: string; title?: string; status?: string; model?: string; lastEventAt?: string; statusCategory?: string | null; archived?: boolean }

function isCowork(s: any): boolean {
  const tags: string[] = s?.tags || s?.config_tags || [];
  return Array.isArray(tags) && tags.some((t) => COWORK_TAGS.includes(t)) ;
}

export async function listCoworkTasks(opts: { filter?: 'all' | 'cowork' | 'archived'; limit?: number } = {}): Promise<{ tasks: CoworkListItem[]; nextCursor?: string }> {
  const cc = await ccOpts();
  const res = await anthropicOAuthGet('/v1/code/sessions', { ...cc, query: `limit=${opts.limit || 50}` });
  if (res.status < 200 || res.status >= 300) throw new CoworkTaskError('COWORK_LIST_FAILED', `list failed (${res.status})`, 502);
  const arr: any[] = res.body?.sessions ?? res.body?.data ?? (Array.isArray(res.body) ? res.body : []);
  const tasks: CoworkListItem[] = arr.filter(isCowork).map((s) => ({
    sid: (s.id || s.session_id) as string,
    title: s.title,
    status: s.status || s.session_status,
    model: s.config?.model,
    lastEventAt: s.last_event_at || s.updated_at,
    statusCategory: s.post_turn_summary?.status_category ?? null,
    archived: !!s.archived,
  })).filter((t) => t.sid);
  const filtered = opts.filter === 'archived' ? tasks.filter((t) => t.archived)
    : opts.filter === 'all' ? tasks
    : tasks.filter((t) => !t.archived);
  return { tasks: filtered, nextCursor: res.body?.next_cursor };
}

export async function getCoworkTask(cse: string): Promise<CoworkDetail & { sid: string; title?: string; status?: string; model?: string }> {
  if (!cse.startsWith('cse_')) throw new CoworkTaskError('COWORK_BAD_REQUEST', 'cse id required', 400);
  const cc = await ccOpts();
  const [ev, se] = await Promise.all([
    anthropicOAuthGet(`/v1/code/sessions/${cse}/events?limit=500`, cc).catch(() => null),
    anthropicOAuthGet(`/v1/code/sessions/${cse}`, cc).catch(() => null),
  ]);
  if (ev && ev.status === 404) throw new CoworkTaskError('COWORK_NOT_FOUND', 'task not found', 404);
  const sessionBody = se?.body?.response_shape || se?.body;
  const detail = parseCoworkEvents(ev?.body, sessionBody);
  return { ...detail, sid: cse, title: sessionBody?.title, status: sessionBody?.status || sessionBody?.session_status, model: sessionBody?.config?.model };
}

export async function driveCoworkTask(opts: { cse: string; text: string }): Promise<{ delivered: boolean; eventId?: string }> {
  const text = (opts.text || '').trim();
  if (!text) throw new CoworkTaskError('COWORK_BAD_REQUEST', 'text is required', 400);
  const sid = 'session_' + opts.cse.slice(4);
  const sent = await anthropicOAuthPost(`/v1/code/sessions/${opts.cse}/events`, { events: [{ payload: {
    type: 'user', uuid: randomUUID(), session_id: sid, parent_tool_use_id: null,
    message: { role: 'user', content: text },
  } }] }, await ccOpts());
  if (sent.status < 200 || sent.status >= 300) throw new CoworkTaskError('COWORK_DRIVE_FAILED', `drive failed (${sent.status})`, 502);
  const r = Array.isArray(sent.body?.results) ? sent.body.results[0] : undefined;
  return { delivered: true, eventId: r?.event_id };
}

export async function renameCoworkTask(cse: string, title: string): Promise<{ ok: true; title: string }> {
  const res = await anthropicOAuthPut(`/v1/code/sessions/${cse}`, { title }, await ccOpts());
  if (res.status < 200 || res.status >= 300) throw new CoworkTaskError('COWORK_RENAME_FAILED', `rename failed (${res.status})`, 502);
  return { ok: true, title };
}

export async function archiveCoworkTask(cse: string, archived: boolean): Promise<{ ok: true; archived: boolean }> {
  const res = await anthropicOAuthPost(`/v1/code/sessions/${cse}/${archived ? 'archive' : 'unarchive'}`, {}, await ccOpts());
  if (res.status < 200 || res.status >= 300) throw new CoworkTaskError('COWORK_ARCHIVE_FAILED', `archive failed (${res.status})`, 502);
  return { ok: true, archived };
}

export async function pinCoworkTask(cse: string, pinned: boolean): Promise<{ ok: true; pinned: boolean }> {
  const res = await anthropicOAuthPut(`/v1/code/sessions/${cse}`, { pinned }, await ccOpts());
  if (res.status < 200 || res.status >= 300) throw new CoworkTaskError('COWORK_PIN_FAILED', `pin failed (${res.status})`, 502);
  return { ok: true, pinned };
}

export async function deleteCoworkTask(cse: string): Promise<{ ok: true }> {
  const res = await anthropicOAuthDelete(`/v1/code/sessions/${cse}`, await ccOpts());
  if (res.status !== 404 && (res.status < 200 || res.status >= 300)) throw new CoworkTaskError('COWORK_DELETE_FAILED', `delete failed (${res.status})`, 502);
  return { ok: true };
}
```

(`randomUUID` is already imported at the top of `cowork-tasks.ts`; `anthropicOAuthPost` too. Add only the new imports shown.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E "cowork-ops|cowork-tasks|pass|fail" | head`
Expected: `cowork-ops` tests PASS; the pre-existing `cowork-tasks` tests still PASS (the `ccrOpts`→`ccOpts` rename didn't break them).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit -p core/tsconfig.json`
Expected: no errors.

```bash
git add core/src/utils/claude-oauth.ts core/src/cowork/cowork-tasks.ts core/src/cowork/__tests__/cowork-ops.test.ts
git commit -m "feat(cowork): list/get/drive/rename/archive/pin/delete task-ops + anthropicOAuthPut"
```

---

## Task 3: `/cowork/*` routes

**Files:**
- Modify: `core/src/routes/core/cowork.routes.ts`
- Test: extend `core/src/cowork/__tests__/cowork-ops.test.ts` is NOT enough — add `core/src/routes/core/__tests__/cowork.routes.test.ts` if a routes-test convention exists; otherwise assert via the ops tests + a live E2E in Task 12. (Check `core/src/routes/core/__tests__/` — if peers exist, mirror them; if not, skip a routes unit test and rely on Task 12 E2E. Do NOT invent a harness.)

**Interfaces:**
- Consumes: the Task 2 ops + `cloudAnswer` (from `../../terminal/ccr-cloud`).
- Produces: HTTP routes (below). Reuses the `wrapResponse`/`wrapError` + `httpStatus` pattern already in the file.

- [ ] **Step 1: Add the routes**

In `core/src/routes/core/cowork.routes.ts`, inside the array returned by `createCoworkRoutes`, after the existing `POST /cowork/tasks`, add (import the new ops + `cloudAnswer` at top):

```ts
import { createCoworkTask, CoworkTaskError, listCoworkTasks, getCoworkTask, driveCoworkTask, renameCoworkTask, archiveCoworkTask, pinCoworkTask, deleteCoworkTask } from '../../cowork/cowork-tasks';
import { cloudAnswer } from '../../terminal/ccr-cloud';

// helper local to this file — maps a thrown error to the wrapError+httpStatus envelope
function fail(e: unknown, start: number) {
  if (e instanceof CoworkTaskError) return { ...wrapError(e.code, e.message, start), httpStatus: e.httpStatus };
  return { ...wrapError('COWORK_ERROR', (e as Error).message, start), httpStatus: 500 };
}
const CSE = '(?<cse>cse_[^/]+)';
```

Routes (each `handler: async (req) => { const start = Date.now(); try { … return wrapResponse(data, start); } catch (e) { return fail(e, start); } }`):

| method | pattern | body → call |
|---|---|---|
| GET | `/^\/cowork\/tasks$/` | `listCoworkTasks({ filter: req.query?.filter, limit: Number(req.query?.limit) || undefined })` |
| GET | `` new RegExp(`^/cowork/tasks/${CSE}$`) `` | `getCoworkTask(req.params.cse)` |
| POST | `` new RegExp(`^/cowork/tasks/${CSE}/events$`) `` | `driveCoworkTask({ cse: req.params.cse, text: String(req.body?.text||'') })` |
| POST | `` new RegExp(`^/cowork/tasks/${CSE}/answer$`) `` | `cloudAnswer({ sid: req.params.cse, answer: String(req.body?.answer||''), toolUseId: req.body?.toolUseId, requestId: req.body?.requestId })` |
| POST | `` new RegExp(`^/cowork/tasks/${CSE}/rename$`) `` | `renameCoworkTask(req.params.cse, String(req.body?.title||''))` |
| POST | `` new RegExp(`^/cowork/tasks/${CSE}/archive$`) `` | `archiveCoworkTask(req.params.cse, req.body?.archived !== false)` |
| POST | `` new RegExp(`^/cowork/tasks/${CSE}/pin$`) `` | `pinCoworkTask(req.params.cse, req.body?.pinned !== false)` |
| DELETE | `` new RegExp(`^/cowork/tasks/${CSE}$`) `` | `deleteCoworkTask(req.params.cse)` |

(Outputs download `GET /cowork/tasks/:cse/outputs/:file` is deferred: in Spec 1 the Outputs panel lists filenames from the parser; wiring the wiggle-cookie download is a small follow-up. Add a stub route returning `501 COWORK_OUTPUTS_TODO` so the UI can show "download coming soon" rather than 404.)

Confirm the route file is already registered in `core/src/routes/core/index.ts` (it is — `createCoworkRoutes` exists there from the prior merge). If the regex `req.params.cse` named-group capture isn't supported by the matcher, use a positional capture and read `req.params[0]` — verify against how `ccr.routes.ts` reads `req.params.sid` (named groups ARE supported there).

- [ ] **Step 2: Build**

Run: `./core.sh build`
Expected: TypeScript compiles clean.

- [ ] **Step 3: Smoke the list route on the worktree build**

Start a throwaway core from the worktree on an unused port, or rely on Task 12's dev restart. Minimal check now:
Run: `node -e "require('./core/dist/routes/core/cowork.routes.js')"` 
Expected: module loads without throwing (no missing imports).

- [ ] **Step 4: Commit**

```bash
git add core/src/routes/core/cowork.routes.ts
git commit -m "feat(cowork): /cowork/tasks list/get/events/answer/rename/archive/pin/delete routes"
```

---

## Task 4: SSE live-stream proxy

**Files:**
- Modify: `core/src/rest-server.ts` (add a special-cased path next to the existing `/stream` and `/tasks/events` checks, ~lines 529–546)

**Interfaces:**
- Consumes: `anthropicOAuthRequest` (for a streaming GET), `ccOpts()` — but note `anthropicOAuth*` buffer the body; for SSE we need the raw response stream. Use the underlying `ensureFreshAccessToken()` + a direct `fetch` to `https://api.anthropic.com/v1/code/sessions/{cse}/events/stream` with the ccr headers, then pipe `response.body` to the client `res`.
- Produces: `GET /cowork/tasks/:cse/stream` → `text/event-stream`.

- [ ] **Step 1: Add the special-cased handler**

In `core/src/rest-server.ts`, alongside `if (req.method === 'GET' && req.url === '/tasks/events') {…}`, add:

```ts
// Cowork live SSE — proxy Anthropic's /v1/code/sessions/{cse}/events/stream (OAuth) to the browser.
// Special-cased (not a normal route) because SSE needs the raw socket, not the buffered ApiResponse.
{
  const m = req.method === 'GET' && req.url?.match(/^\/cowork\/tasks\/(cse_[^/?]+)\/stream/);
  if (m) {
    void this.handleCoworkStream(req, res, m[1]);
    return;
  }
}
```

And add the method on the server class:

```ts
private async handleCoworkStream(req: http.IncomingMessage, res: http.ServerResponse, cse: string): Promise<void> {
  try {
    const { ensureFreshAccessToken, getOrganizationUuid } = await import('./utils/claude-oauth');
    const token = await ensureFreshAccessToken();
    const org = await getOrganizationUuid();
    const lastId = req.headers['last-event-id'];
    const url = `https://api.anthropic.com/v1/code/sessions/${cse}/events/stream`;
    const upstream = await fetch(url, { headers: {
      'authorization': `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'anthropic-client-feature': 'ccr',
      'x-organization-uuid': org,
      'accept': 'text/event-stream',
      ...(lastId ? { 'last-event-id': String(lastId) } : {}),
    } });
    if (!upstream.ok || !upstream.body) { res.writeHead(upstream.status || 502).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const reader = upstream.body.getReader();
    req.on('close', () => reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end();
  }
}
```

(Note: `ensureFreshAccessToken()`'s exact signature — read lines 218+ of `claude-oauth.ts` and pass whatever args it needs; it may take an options object. If it returns `{ accessToken }` rather than a bare string, adjust. This import is dynamic to avoid load-order issues; `import()` of a CJS module is fine.)

- [ ] **Step 2: Build**

Run: `./core.sh build`
Expected: compiles clean.

- [ ] **Step 3: Verify the path is matched before route dispatch**

Read the dispatch order in `rest-server.ts` — confirm the new block sits BEFORE the generic route-matching loop (same region as `/stream`, `/tasks/events`). A normal route would try to buffer + JSON-wrap, breaking SSE.

- [ ] **Step 4: Commit**

```bash
git add core/src/rest-server.ts
git commit -m "feat(cowork): SSE proxy GET /cowork/tasks/:cse/stream (Anthropic events/stream → browser)"
```

*(Live SSE verification happens in Task 12 against a real task.)*

---

## Task 5: `cowork-stream.ts` — pure SSE-frame + merge + transport-decision logic (web)

**Files:**
- Create: `web/src/lib/cowork-stream.ts`
- Test: `web/src/lib/__tests__/cowork-stream.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SseFrame { id?: string; event?: string; data: string }
  export function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string } // splits on \n\n, returns leftover
  export function shouldUseSse(opts: { isRemoteNode: boolean }): boolean // false when relayed/remote
  // merge new events (from SSE data JSON) into an existing CoworkDetail-ish message list by sequence_num
  export function mergeEvents(prev: CoworkMsgLite[], incoming: unknown[]): CoworkMsgLite[]
  export interface CoworkMsgLite { seq: number; role: 'user'|'assistant'; text: string; tools?: string[] }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/__tests__/cowork-stream.test.ts
import { describe, it, expect } from 'vitest';
import { parseSseChunk, shouldUseSse, mergeEvents } from '../cowork-stream';

describe('parseSseChunk', () => {
  it('splits complete frames and keeps the remainder', () => {
    const { frames, rest } = parseSseChunk('id: 1\ndata: {"a":1}\n\nid: 2\ndata: partial');
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe('1');
    expect(frames[0].data).toBe('{"a":1}');
    expect(rest).toBe('id: 2\ndata: partial');
  });
});

describe('shouldUseSse', () => {
  it('polls (no SSE) for a relayed remote node', () => {
    expect(shouldUseSse({ isRemoteNode: true })).toBe(false);
    expect(shouldUseSse({ isRemoteNode: false })).toBe(true);
  });
});

describe('mergeEvents', () => {
  it('appends by sequence_num, dedups, keeps order', () => {
    const prev = [{ seq: 1, role: 'user' as const, text: 'hi' }];
    const next = mergeEvents(prev, [
      { sequence_num: '1', payload: { message: { role: 'user', content: 'hi' } } }, // dup
      { sequence_num: '2', payload: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendUserMessage', input: { message: 'DONE' } }] } } },
    ]);
    expect(next).toHaveLength(2);
    expect(next[1].text).toBe('DONE');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd .claude/worktrees/feat+cowork-task-creation/web && npx vitest run src/lib/__tests__/cowork-stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (reuse the `SendUserMessage`/text extraction rules from Task 1 — keep them consistent).

```ts
// web/src/lib/cowork-stream.ts
export interface SseFrame { id?: string; event?: string; data: string }
export interface CoworkMsgLite { seq: number; role: 'user' | 'assistant'; text: string; tools?: string[] }

export function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: SseFrame[] = [];
  for (const block of parts) {
    if (!block.trim() || block.startsWith(':')) continue; // skip keepalives
    const f: SseFrame = { data: '' };
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) f.id = line.slice(3).trim();
      else if (line.startsWith('event:')) f.event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    f.data = dataLines.join('\n');
    if (f.data) frames.push(f);
  }
  return { frames, rest };
}

export function shouldUseSse(opts: { isRemoteNode: boolean }): boolean {
  return !opts.isRemoteNode; // the _coreapi hub relay buffers responses → SSE can't stream to a remote node
}

function msgFromEvent(ev: any): CoworkMsgLite | null {
  const seq = Number(ev?.sequence_num ?? ev?.seq ?? 0);
  const p = ev?.payload || {};
  const msg = p?.message; const role = msg?.role || (p?.type === 'user' ? 'user' : p?.type === 'assistant' ? 'assistant' : '');
  if (role !== 'user' && role !== 'assistant') return null;
  const content = msg?.content; let text = typeof content === 'string' ? content : ''; const tools: string[] = [];
  if (Array.isArray(content)) for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
    if (b?.type === 'tool_use') {
      if (b.name === 'SendUserMessage') { const r = b?.input?.message ?? b?.input?.text; if (typeof r === 'string') text += (text ? '\n' : '') + r; }
      else tools.push(String(b?.name || 'tool'));
    }
  }
  return { seq, role, text, ...(tools.length ? { tools } : {}) };
}

export function mergeEvents(prev: CoworkMsgLite[], incoming: unknown[]): CoworkMsgLite[] {
  const bySeq = new Map(prev.map((m) => [m.seq, m]));
  for (const ev of incoming) { const m = msgFromEvent(ev); if (m && !bySeq.has(m.seq)) bySeq.set(m.seq, m); }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/__tests__/cowork-stream.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/cowork-stream.ts web/src/lib/__tests__/cowork-stream.test.ts
git commit -m "feat(cowork/web): pure SSE-frame parser + event merge + transport decision"
```

---

## Task 6: Extract shared `TranscriptMessage` + `ApprovalWidget` from `CcrCloudView`

**Files:**
- Create: `web/src/components/shared/TranscriptMessage.tsx`, `web/src/components/shared/ApprovalWidget.tsx`
- Modify: `web/src/components/ccr/CcrCloudView.tsx` (import + use them; delete the inlined `CloudMessage` + inline approval block)

**Interfaces:**
- `TranscriptMessage` props: `{ role: string; type: string; text: string; tools?: string[] }` (the exact `CloudMsg` shape). Render identical to the current `CloudMessage` (markdown via `ReactMarkdown`+`remarkGfm`, user bubble vs assistant, tool badges).
- `ApprovalWidget` props: `{ pending: PendingQuestion; answering: boolean; onAnswer: (text: string) => void }`. Render identical to CcrCloudView's current pending-question block (option buttons + free-text input + Send).

- [ ] **Step 1: Copy `CloudMessage` (CcrCloudView.tsx lines 182–210) verbatim into `TranscriptMessage.tsx`** as `export function TranscriptMessage({ m }: { m: { role: string; type: string; text: string; tools?: string[] } })`. Keep imports (`ReactMarkdown`, `remarkGfm`, lucide icons `User`, `Cloud`, `Wrench`).

- [ ] **Step 2: Copy the pending-question JSX (CcrCloudView.tsx lines 140–165) into `ApprovalWidget.tsx`** as a component taking the props above; move `customAnswer` local state into it.

- [ ] **Step 3: Refactor `CcrCloudView.tsx`** — replace `<CloudMessage m={m}/>` with `<TranscriptMessage m={m}/>`, and the inline pending block with `<ApprovalWidget pending={pendingQ} answering={answering} onAnswer={answer}/>`; delete the now-dead inlined code and the `customAnswer` state it owned.

- [ ] **Step 4: Verify no behavior change — build**

Run: `cd web && npx next build 2>&1 | tail -20`
Expected: build succeeds (307 on `/` is fine). No TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/shared/TranscriptMessage.tsx web/src/components/shared/ApprovalWidget.tsx web/src/components/ccr/CcrCloudView.tsx
git commit -m "refactor(web): extract TranscriptMessage + ApprovalWidget shared components from CcrCloudView"
```

---

## Task 7: `useLiveTranscript` hook (SSE-first, poll fallback)

**Files:**
- Create: `web/src/hooks/useLiveTranscript.ts`

**Interfaces:**
- Consumes: `parseSseChunk`, `mergeEvents`, `shouldUseSse` (Task 5); an `apiFetch` (for the poll fallback + initial load) and a `streamUrl` builder.
- Produces:
  ```ts
  export function useLiveTranscript(opts: {
    sid: string;
    apiFetch: <T>(path: string, o?: { method?: string; body?: unknown }) => Promise<T>;
    streamPath: string;          // e.g. `/cowork/tasks/${sid}/stream`
    detailPath: string;          // e.g. `/cowork/tasks/${sid}`
    isRemoteNode: boolean;
    live: boolean;
  }): { detail: CoworkDetailView | null; err: string | null; gone: boolean; refresh: () => void }
  ```
  where `CoworkDetailView` mirrors the `GET /cowork/tasks/:cse` body (messages/activeGoal/outputs/context/pendingQuestion/statusCategory/title/status/model).

- [ ] **Step 1: Implement the hook.**

Behavior:
1. Always do an initial `apiFetch<CoworkDetailView>(detailPath)` (full parse from Core). Guard stale responses with a `seqRef` (copy the exact `seqRef` pattern from `CcrCloudView`).
2. If `!live` → stop. Else if `shouldUseSse({ isRemoteNode })` → open an SSE reader:
   ```ts
   const res = await fetch(`${apiBase}${streamPath}`, { headers: { 'x-api-key': apiKey }, signal });
   const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
   // on each read: buf += dec.decode(value,{stream:true}); const {frames,rest}=parseSseChunk(buf); buf=rest;
   // for each frame: JSON.parse(frame.data) → an event or {data:[event…]}; mergeEvents into messages
   ```
   Use the SAME `apiBase`/`x-api-key` resolution the shared `apiClient.fetchPath` uses (read `web/src/lib/api-client.ts` and reuse its base-URL + key logic; do NOT hardcode). If SSE `fetch` rejects, or no frame arrives within 4s, `clearTimeout` guard → fall through to polling.
3. Poll fallback: `setInterval(refresh, 5000)` where `refresh = () => apiFetch(detailPath)` — the exact `loadRef` stable-interval pattern from `CcrCloudView` (interval keyed on `[sid, live]`, calls latest `load` via a ref).
4. 404 / `not found` on load → `setGone(true)`, stop.

Keep the hook under ~120 lines; it is the only new streaming code. Model the polling/stale-guard/`gone` logic byte-for-byte on `CcrCloudView`'s proven implementation.

- [ ] **Step 2: Build**

Run: `cd web && npx next build 2>&1 | tail -5`
Expected: compiles (the hook is imported by Task 10; a build now just typechecks it — if unused-import errors, wait to fully wire in Task 10 and instead run `npx tsc --noEmit`).

Run: `npx tsc --noEmit 2>&1 | grep useLiveTranscript || echo OK`
Expected: `OK` (no type errors in the hook).

- [ ] **Step 3: Commit**

```bash
git add web/src/hooks/useLiveTranscript.ts
git commit -m "feat(cowork/web): useLiveTranscript — SSE-first with 5s poll fallback"
```

---

## Task 8: `ModelEffortSelector` + `CoworkComposer`

**Files:**
- Create: `web/src/components/cowork/ModelEffortSelector.tsx`, `web/src/components/cowork/CoworkComposer.tsx`

**Interfaces:**
- `ModelEffortSelector` props: `{ model: string; effort: string; onChange: (m: string, e: string) => void }`. Options: `[{id:'claude-opus-4-8',label:'Opus 4.8'},{id:'claude-sonnet-5',label:'Sonnet 5'},{id:'claude-haiku-4-5-20251001',label:'Haiku 4.5'}]` × effort `['low','medium','high','max']`. Render as the claude.ai-style inline "`Sonnet 5` `Medium ▾`" text button opening a small menu (model list + effort list). Match the visual idiom of CcrCloudView (CSS vars, `.btn.btn-ghost.btn-sm`).
- `CoworkComposer` props: `{ onCreate: (opts: { prompt: string; model: string; effort: string }) => Promise<void>; busy: boolean }`. Layout (match the captured claude.ai composer):
  - headline "How can I help you today?"
  - a rounded input card: `textarea` "How can I help you today?"; a bottom row with left `+` (disabled, title "Attachments — coming soon"), a **`Chat | Cowork`** segmented toggle (Chat disabled, Cowork active), and right `<ModelEffortSelector/>` + a send button.
  - a row below the card: a disabled `Project ▾` button (title "Projects — coming soon") + a `Manual ▾` menu (options "Manually approve" / "Skip all approvals" — Spec 1 stores the choice in local state only; not sent) + a `Beta` badge.
  - `⌘/Ctrl+Enter` or the send button → `onCreate({ prompt, model, effort })`.

- [ ] **Step 1: Implement both components** using the CSS-variable + lucide idiom from `CcrCloudView.tsx` (import `Send`, `Plus`, `ChevronDown`, `Sparkles` from `lucide-react`). No data fetching here — pure controlled components.

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -E "CoworkComposer|ModelEffort" || echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/cowork/ModelEffortSelector.tsx web/src/components/cowork/CoworkComposer.tsx
git commit -m "feat(cowork/web): CoworkComposer (Chat|Cowork toggle) + ModelEffortSelector"
```

---

## Task 9: `CoworkList`

**Files:**
- Create: `web/src/components/cowork/CoworkList.tsx`

**Interfaces:**
- Props: `{ tasks: CoworkListItem[]; filter: string; onFilter: (f: string) => void; onOpen: (sid: string) => void; onNew: () => void; loading: boolean }` where `CoworkListItem` = `{ sid; title?; status?; model?; lastEventAt?; statusCategory?; archived? }`.
- Render the "Chats and tasks" list: header title + a `Filter by ▾` menu (**All / Chat(disabled) / Shared(disabled) / Cowork / Archived**) + a `New` button; a search input (client-side filter on title); rows = title (left) + a small status badge (`review_ready`→"Review ready", `needs_action`→"Needs you", amber) + relative date (right). Empty state "No activity yet." Match claude.ai spacing; reuse `.card`, badge classes.

- [ ] **Step 1: Implement** (pure presentational; the page supplies `tasks`).
- [ ] **Step 2: Typecheck** — `npx tsc --noEmit 2>&1 | grep CoworkList || echo OK` → `OK`.
- [ ] **Step 3: Commit**

```bash
git add web/src/components/cowork/CoworkList.tsx
git commit -m "feat(cowork/web): CoworkList — Chats-and-tasks list with filter + status badges"
```

---

## Task 10: `CoworkRightRail` + `CoworkTaskView`

**Files:**
- Create: `web/src/components/cowork/CoworkRightRail.tsx`, `web/src/components/cowork/CoworkTaskView.tsx`

**Interfaces:**
- `CoworkRightRail` props: `{ activeGoal: CoworkGoalStep[]; outputs: string[]; context: { tools: string[]; files: string[] }; onDownload: (file: string) => void }`. Three collapsible sections (`Progress` = step circles from `activeGoal` (done=check, active=filled, pending=hollow); `Outputs {n}` = file rows (icon + name, click→`onDownload`); `Context` = tool chips + file paths, empty text "Track tools and referenced files used in this task."). Collapsible via local `useState` per section; default Progress collapsed, Outputs+Context open (matches capture).
- `CoworkTaskView` props: `{ sid: string; apiFetch; isRemoteNode: boolean; onClose: () => void; onDeleted: () => void }`. Composition:
  - `useLiveTranscript({ sid, apiFetch, streamPath:`/cowork/tasks/${sid}/stream`, detailPath:`/cowork/tasks/${sid}`, isRemoteNode, live })`.
  - Header: cloud icon + title + a title▾ menu (`Rename`→prompt+`POST …/rename`; `Archive`→`POST …/archive`; `Pin`→`POST …/pin`; `Delete`→confirm inline (NOT window.confirm) then `DELETE /cowork/tasks/:sid`→`onDeleted()`; Schedule/Turn-into-skill/Add-to-project rendered disabled) + a rail-toggle button.
  - Center: map `detail.messages` → `<TranscriptMessage/>` (shared, Task 6); when `detail.pendingQuestion` → `<ApprovalWidget pending onAnswer={a=>apiFetch(`/cowork/tasks/${sid}/answer`,{method:'POST',body:{answer:a, toolUseId:detail.pendingQuestion.toolUseId}})}/>`. Reuse the scroll-stick + live/pause header toggle from CcrCloudView.
  - Right: `<CoworkRightRail … onDownload={f=>apiFetch(`/cowork/tasks/${sid}/outputs/${encodeURIComponent(f)}`)/* 501 for now → toast "coming soon" */}/>`.
  - Bottom in-task composer: textarea "Write a message…" + `+`(disabled) + `Manual ▾` + `<ModelEffortSelector/>` (display; drive uses the task's model) + Send → `POST /cowork/tasks/:sid/events {text}` then `refresh()`.

- [ ] **Step 1: Implement `CoworkRightRail`** (presentational).
- [ ] **Step 2: Implement `CoworkTaskView`** composing the hook + shared components + rail. Keep the drive/answer/manage handlers thin (each is one `apiFetch` + `refresh`). Reuse CcrCloudView's `gone`/error/empty states.
- [ ] **Step 3: Typecheck** — `npx tsc --noEmit 2>&1 | grep -E "CoworkTaskView|RightRail" || echo OK` → `OK`.
- [ ] **Step 4: Commit**

```bash
git add web/src/components/cowork/CoworkRightRail.tsx web/src/components/cowork/CoworkTaskView.tsx
git commit -m "feat(cowork/web): CoworkTaskView (transcript+drive+approve+manage) + right rail"
```

---

## Task 11: `CoworkPage` shell + route + Sidebar entry

**Files:**
- Create: `web/src/components/cowork/CoworkPage.tsx`, `web/src/app/(dashboard)/cowork/page.tsx`
- Modify: `web/src/components/layout/Sidebar.tsx`

**Interfaces:**
- `CoworkPage` (no props). Owns: `apiFetch` (create it exactly like `CcrPage.tsx:117` — `apiClient.fetchPath` + `proxy.machineId`; read CcrPage's imports for `apiClient`/`proxy` sources and mirror them), `isRemoteNode` (= `!!proxy.machineId`), the task list state, and an `openSid | null` state.
  - openSid null → render `<CoworkComposer onCreate={createTask}/>` + `<CoworkList tasks … onOpen={setOpenSid} onNew={()=>setOpenSid(null)}/>`.
  - openSid set → render `<CoworkTaskView sid={openSid} apiFetch isRemoteNode onClose={()=>setOpenSid(null)} onDeleted={()=>{ setOpenSid(null); reloadList(); }}/>`.
  - `createTask = async ({prompt,model,effort}) => { const r = await apiFetch<{sessionId:string}>('/cowork/tasks',{method:'POST',body:{prompt,model,effort,target:'cloud'}}); setOpenSid(r.sessionId); reloadList(); }`.
  - `reloadList = () => apiFetch<{tasks:CoworkListItem[]}>(`/cowork/tasks?filter=${filter}`).then(r=>setTasks(r.tasks))`.

- [ ] **Step 1: Implement `CoworkPage`** wiring composer + list + task view.

- [ ] **Step 2: Add the route:**

```tsx
// web/src/app/(dashboard)/cowork/page.tsx
import { CoworkPage } from '@/components/cowork/CoworkPage';
export default function Page() { return <CoworkPage />; }
```

- [ ] **Step 3: Add the Sidebar entry.** In `web/src/components/layout/Sidebar.tsx`, add to the nav list (near `/ccr`), importing an icon (e.g. `Sparkles` or `Bot` from lucide-react):

```ts
{ href: '/cowork', icon: Sparkles, label: 'Cowork' },
```

- [ ] **Step 4: Build the web app**

Run: `cd web && npx next build 2>&1 | tail -20`
Expected: build succeeds; `/cowork` appears as a route in the output.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/cowork/CoworkPage.tsx "web/src/app/(dashboard)/cowork/page.tsx" web/src/components/layout/Sidebar.tsx
git commit -m "feat(cowork/web): CoworkPage shell + /cowork route + sidebar entry"
```

---

## Task 12: End-to-end on dev + visual parity + cleanup

**Files:** none (verification only).

- [ ] **Step 1: Build + restart dev from the worktree.**

Run: `cd .claude/worktrees/feat+cowork-task-creation && ./core.sh build && ./core.sh restart`
Expected: dev Core `:3200` + Web `:3948` up. `curl -s localhost:3200/health` → `"runningFrom":"dev-repo"`. **Prod `:3100` untouched.**

- [ ] **Step 2: Backend E2E (create→list→get→drive→answer-if-any→rename→delete).**

```bash
BASE=http://localhost:3200; TOK=$(cat ~/.lm-assist/api-token)
CSE=$(curl -s -X POST -H "x-api-key: $TOK" -H 'content-type: application/json' $BASE/cowork/tasks \
  -d '{"prompt":"Reply with exactly COWORK-E2E-OK. No tools.","target":"cloud"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['sessionId'])")
echo "cse=$CSE"; sleep 6
curl -s -H "x-api-key: $TOK" "$BASE/cowork/tasks?filter=cowork" | python3 -c "import sys,json;print('list has cse:', any(t['sid']=='$CSE' for t in json.load(sys.stdin)['data']['tasks']))"
curl -s -H "x-api-key: $TOK" "$BASE/cowork/tasks/$CSE" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print('reply seen:', any('COWORK-E2E-OK' in m['text'] for m in d['messages']))"
curl -s -X POST -H "x-api-key: $TOK" -H 'content-type: application/json' "$BASE/cowork/tasks/$CSE/rename" -d '{"title":"e2e-renamed"}' >/dev/null
curl -s -X DELETE -H "x-api-key: $TOK" "$BASE/cowork/tasks/$CSE" >/dev/null
curl -s -o /dev/null -w 'GET-after-delete: %{http_code}\n' -H "x-api-key: $TOK" "$BASE/cowork/tasks/$CSE"
```

Expected: `list has cse: True`, `reply seen: True`, `GET-after-delete: 404`. **The test session is deleted.**

- [ ] **Step 3: SSE check** (local, direct core): open the stream for a fresh throwaway task and confirm frames flow, then delete it.

```bash
CSE=$(curl -s -X POST -H "x-api-key: $TOK" -H 'content-type: application/json' $BASE/cowork/tasks -d '{"prompt":"count slowly 1 to 5","target":"cloud"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['sessionId'])")
timeout 8 curl -s -N -H "x-api-key: $TOK" "$BASE/cowork/tasks/$CSE/stream" | head -c 400; echo
curl -s -X DELETE -H "x-api-key: $TOK" "$BASE/cowork/tasks/$CSE" >/dev/null
```

Expected: at least one `data:` SSE frame prints. Session deleted.

- [ ] **Step 4: Visual parity (browser).** Open `http://<lan-ip>:3948/cowork` (inject `assist_access_key` per `dev_web_browser_testing`). Verify against the captured claude.ai screenshots: composer (Chat|Cowork toggle, model/effort, Project/Manual, Beta), list + filter, and — after creating one throwaway task from the UI — the task-detail transcript + Progress/Outputs/Context right rail + drive box. **Delete that task** (title▾ → Delete) at the end.

- [ ] **Step 5: Full test suite + typecheck green.**

Run: `cd .claude/worktrees/feat+cowork-task-creation && npm test 2>&1 | tail -5 && npx tsc --noEmit -p core/tsconfig.json && cd web && npx vitest run 2>&1 | tail -3`
Expected: core tests pass, no type errors, web vitest passes.

- [ ] **Step 6: Commit any fixups, then summary commit.**

```bash
git add -A && git commit -m "test(cowork): e2e dev verification (create/list/get/drive/rename/delete + SSE)" --allow-empty
```

---

## Self-Review (completed while writing)

**Spec coverage:** composer+toggle (T8), list+filter (T9), task detail+transcript+drive+approve+manage (T10), right rail Progress/Outputs/Context (T10), `/cowork/*` API (T2/T3), `parseCoworkEvents` (T1), SSE-first-poll-fallback (T4 proxy + T5 logic + T7 hook), shared-component DRY refactor (T6), page+route+nav (T11), E2E+cleanup+visual (T12). Deferred-by-design (Chat, Scheduled/Projects, attach/connectors/settings, outputs-download) are explicitly stubbed/disabled, not silently dropped.

**Placeholder scan:** every code step carries real code; the two knowingly-partial spots (routes-test harness in T3, outputs-download in T3/T10) are called out with an explicit fallback (501 stub + Task-12 E2E), not left as "TODO".

**Type consistency:** `CoworkListItem`, `CoworkDetail`, `CoworkMsg`/`CoworkMsgLite`, `CoworkGoalStep` names are used consistently across tasks; `parseCoworkEvents(eventsBody, sessionBody?)` signature matches its callers in T2; `cloudAnswer({ sid, answer, toolUseId, requestId })` matches the ccr-cloud export read in Task 1's grounding.

**Known verification-time checks (flagged in-task, not blockers):** `ensureFreshAccessToken()` exact return shape (T4), named-group `req.params.cse` matcher support (T3), `anthropicOAuthPost` call convention to mirror for PUT (T2) — each task says to read the neighboring code and match it.

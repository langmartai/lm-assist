# Chat Surface (Spec 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the composer's `Chat | Cowork` toggle functional so one unified home drives both claude.ai chat conversations and cowork tasks, matching claude.ai.

**Architecture:** The Chat backend (`/claude-ai/conversations/*`: list/read/create/completion/title/delete) already exists. Add a core `parseChatMessages` parser + a parsed-read route (parity with Cowork's core-parses-then-web-renders), a web `useChatConversation` hook (blocking completion, no SSE), a `ChatView` detail component, text-file attachments via the completion `attachments` channel, a combined "Chats and tasks" list, and a mode-aware refactor of `CoworkPage` + a functional composer toggle.

**Tech Stack:** TypeScript. Core = Node HTTP (CommonJS, `node:test`). Web = Next.js 16 / React 19 (Turbopack), reusing the existing `web/src/components/cowork/` components + `web/src/components/shared/TranscriptMessage.tsx`.

## Global Constraints

- **North star: consistent with claude.ai**, and reuse the Cowork components/visual language verbatim where they apply (same `TranscriptMessage`, same composer chrome, same list rows). Where claude.ai and Cowork conflict, match claude.ai.
- **No new conversation endpoints** — build on the existing `/claude-ai/conversations/*`; the only core additions are `parseChatMessages` + the parsed-read route.
- **Chat is blocking-completion in v1** (no token streaming): a "Thinking…" indicator, then the full reply (exactly how Cowork behaves today).
- **Chat model list = the Cowork list verbatim** (`claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5`, `claude-haiku-4-5-20251001`) — all four VERIFIED to accept chat completion (create=201, send=200) on 2026-07-14. Chat has **no effort** parameter.
- **Attachments (v1): text files only**, sent inline via the completion `attachments` channel (`{ file_name, file_type, file_size, extracted_content, origin:'user_upload', kind:'file' }`) — no upload round-trip. Non-text files → a clear chip error (image/binary deferred).
- **Chat is cookie-based** (same claude.ai session as Cowork's connector-attach). No/expired cookie → a single clear "Connect your claude.ai account to use Chat" state, not raw errors.
- Web changes must keep `next build` green under Node ≥20.9 (`nvm use 20`); the repo's `typescript.ignoreBuildErrors:true` baseline stands — gate = build + per-touched-file `tsc --noEmit -p tsconfig.json 2>&1 | grep <file>` clean. Core changes: `./core.sh build` clean + `cd core && npm run build:test && node --test dist-test/claude-ai/__tests__/`.
- Deferred (NOT this plan): token streaming, projects, artifacts, message edit/branch/regenerate, image/binary attachments, starred/search.

---

### Task 1: core `parseChatMessages` parser + unit tests

**Files:**
- Create: `core/src/claude-ai/chat-read.ts`
- Test: `core/src/claude-ai/__tests__/chat-read.test.ts`

**Interfaces:**
- Consumes: the `GET /claude-ai/conversations/:uuid` response body — `{ uuid, name, chat_messages: Array<{ uuid, sender:'user'|'assistant', content: Array<ContentBlock> }> }` where a `ContentBlock` is one of `{type:'text', text}`, `{type:'thinking', thinking}`, `{type:'tool_use', id, name, input, result?, is_error?}`, `{type:'tool_result', tool_use_id, content, is_error?}`. (When the read is fetched with `render_all_tools=true`, a `tool_use` block may already carry an inline `result`/`is_error`; a separate `tool_result` block may also appear in a later message — handle both.)
- Produces: `export function parseChatMessages(conversationBody: unknown): ChatMsg[]` and `export interface ChatMsg { role: 'user'|'assistant'; type: 'user'|'assistant'; text: string; thinking?: string; toolCalls?: ChatToolCall[] }` and `export interface ChatToolCall { name: string; input?: unknown; result?: string; isError?: boolean }`. Later tasks (route in Task 2) call `parseChatMessages`.

- [ ] **Step 1: Write the failing tests**

Create `core/src/claude-ai/__tests__/chat-read.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatMessages } from '../chat-read';

test('extracts user + assistant text turns in order', () => {
  const d = parseChatMessages({ chat_messages: [
    { sender: 'user', content: [{ type: 'text', text: 'hello' }] },
    { sender: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
  ] });
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((m) => m.role), ['user', 'assistant']);
  assert.equal(d[0].text, 'hello');
  assert.equal(d[1].text, 'hi there');
});

test('captures a thinking block into the assistant turn', () => {
  const d = parseChatMessages({ chat_messages: [
    { sender: 'assistant', content: [
      { type: 'thinking', thinking: 'let me reason' },
      { type: 'text', text: 'the answer is 4' },
    ] },
  ] });
  assert.equal(d.length, 1);
  assert.equal(d[0].text, 'the answer is 4');
  assert.match(d[0].thinking as string, /let me reason/);
});

test('pairs an inline tool_use result (render_all_tools) into a toolCall', () => {
  const d = parseChatMessages({ chat_messages: [
    { sender: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' }, result: 'file1\nfile2', is_error: false },
      { type: 'text', text: 'done' },
    ] },
  ] });
  assert.equal(d[0].toolCalls?.length, 1);
  assert.equal(d[0].toolCalls![0].name, 'Bash');
  assert.deepEqual(d[0].toolCalls![0].input, { command: 'ls' });
  assert.equal(d[0].toolCalls![0].result, 'file1\nfile2');
  assert.equal(d[0].toolCalls![0].isError, false);
  assert.equal(d[0].text, 'done');
});

test('pairs a separate tool_result block (later message) by tool_use_id', () => {
  const d = parseChatMessages({ chat_messages: [
    { sender: 'assistant', content: [{ type: 'tool_use', id: 'tu9', name: 'Search', input: { q: 'x' } }] },
    { sender: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu9', content: 'result text', is_error: false }] },
    { sender: 'assistant', content: [{ type: 'text', text: 'final' }] },
  ] });
  // the tool_result-only message is dropped; its result attaches to the tool_use turn
  const withTool = d.find((m) => m.toolCalls && m.toolCalls.length);
  assert.ok(withTool);
  assert.equal(withTool!.toolCalls![0].result, 'result text');
  assert.ok(!d.some((m) => m.role === 'user' && !m.text.trim() && !m.toolCalls));
  assert.equal(d[d.length - 1].text, 'final');
});

test('tolerates empty / malformed input', () => {
  assert.deepEqual(parseChatMessages(null), []);
  assert.deepEqual(parseChatMessages({}), []);
  assert.deepEqual(parseChatMessages({ chat_messages: 'nope' }), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/claude-ai/__tests__/chat-read.test.js`
Expected: FAIL — `parseChatMessages` is not defined / module not found.

- [ ] **Step 3: Write the parser**

Create `core/src/claude-ai/chat-read.ts`:

```ts
/**
 * Pure parser for a claude.ai chat conversation's message tree
 * (GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&render_all_tools=true
 *  -> { chat_messages: [...] }). Produces the display shape the web's shared
 * TranscriptMessage renders — the chat analogue of cowork-read.ts's parseCoworkEvents.
 *
 * Chat is simpler than cowork events: each chat_message IS one turn (user or
 * assistant), so there is no cross-event grouping. We flatten each message's
 * content[] blocks and pair tool_use with its result (inline when the read used
 * render_all_tools=true, else a separate tool_result block matched by tool_use_id).
 */
export interface ChatToolCall { name: string; input?: unknown; result?: string; isError?: boolean }
export interface ChatMsg { role: 'user' | 'assistant'; type: 'user' | 'assistant'; text: string; thinking?: string; toolCalls?: ChatToolCall[] }

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b))).join('\n');
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

export function parseChatMessages(conversationBody: unknown): ChatMsg[] {
  const msgsRaw = (conversationBody as any)?.chat_messages;
  if (!Array.isArray(msgsRaw)) return [];

  const out: ChatMsg[] = [];
  // tool_use id -> the toolCall object, so a later tool_result block can attach its output.
  const toolIndex = new Map<string, ChatToolCall>();

  for (const m of msgsRaw) {
    const sender = m?.sender === 'assistant' ? 'assistant' : m?.sender === 'user' ? 'user' : null;
    if (!sender) continue;
    const content = m?.content;

    const texts: string[] = [];
    const thinking: string[] = [];
    const toolCalls: ChatToolCall[] = [];
    let attachedAResult = false;

    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text) texts.push(b.text);
        else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) thinking.push(b.thinking);
        else if (b?.type === 'tool_use') {
          const call: ChatToolCall = { name: String(b?.name || 'tool'), input: b?.input };
          if (typeof b?.result === 'string') call.result = b.result;
          if (typeof b?.is_error === 'boolean') call.isError = b.is_error;
          toolCalls.push(call);
          if (b?.id) toolIndex.set(String(b.id), call);
        } else if (b?.type === 'tool_result') {
          const call = toolIndex.get(String(b?.tool_use_id || ''));
          if (call) { call.result = stringifyResult(b?.content); call.isError = !!b?.is_error; attachedAResult = true; }
        }
      }
    } else if (typeof content === 'string') {
      texts.push(content);
    }

    const text = texts.join('\n').trim();
    const think = thinking.join('\n\n').trim();
    // Drop a message that was ONLY a tool_result carrier (no text/tools of its own).
    if (!text && !think && !toolCalls.length) {
      if (attachedAResult) continue;
      continue;
    }
    out.push({ role: sender, type: sender, text, ...(think ? { thinking: think } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/claude-ai/__tests__/chat-read.test.js`
Expected: PASS — 5/5.

- [ ] **Step 5: Commit**

```bash
git add core/src/claude-ai/chat-read.ts core/src/claude-ai/__tests__/chat-read.test.ts
git commit -m "feat(chat): core parseChatMessages parser + tests"
```

---

### Task 2: core parsed-read route `GET /claude-ai/conversations/:uuid/messages`

**Files:**
- Modify: `core/src/routes/core/claude-ai.routes.ts` (add one route; register alongside the existing conversation read at ~line 354-389)

**Interfaces:**
- Consumes: `parseChatMessages` from `../../claude-ai/chat-read` (Task 1); the existing `readConversation(convUuid, opts)` helper from `../../utils/claudeai-session` (returns `{ status, body }`).
- Produces: `GET /claude-ai/conversations/:uuid/messages` → `{ success, data: { uuid, name, messages: ChatMsg[] } }`. The web hook (Task 3) calls this.

- [ ] **Step 1: Read the existing read route for the exact pattern + imports**

Run: `sed -n '1,60p;340,415p' core/src/routes/core/claude-ai.routes.ts`
Note the UUID regex, how `readConversation` is called, `wrapResponse`/`wrapError` usage, and how routes are pushed into the returned array. Confirm the file already imports `readConversation` (it does — the existing `GET /claude-ai/conversations/:uuid` uses it).

- [ ] **Step 2: Add the import**

At the top of `core/src/routes/core/claude-ai.routes.ts`, add:

```ts
import { parseChatMessages } from '../../claude-ai/chat-read';
```

- [ ] **Step 3: Add the route (register it BEFORE the generic `/:uuid` read so `messages` is not captured as a uuid)**

Insert this route object in the returned array, immediately before the existing `GET /claude-ai/conversations/:uuid` handler (use the SAME UUID pattern the file already uses for `:uuid`; the literal `/messages` suffix disambiguates it):

```ts
{
  method: 'GET',
  // NOTE: keep the same UUID sub-pattern this file already uses for :uuid.
  pattern: /^\/claude-ai\/conversations\/(?<uuid>[0-9a-fA-F-]{36})\/messages$/,
  handler: async (req) => {
    const start = Date.now();
    try {
      const r = await readConversation(req.params.uuid, { tree: true, renderingMode: 'messages', renderAllTools: true });
      if (r.status === 404) return { ...wrapError('CONVERSATION_NOT_FOUND', 'conversation not found', start), httpStatus: 404 };
      if (r.status < 200 || r.status >= 300) return { ...wrapError('CONVERSATION_READ_FAILED', `read failed (${r.status})`, start), httpStatus: 502 };
      const body: any = r.body || {};
      return wrapResponse({ uuid: body.uuid || req.params.uuid, name: body.name, messages: parseChatMessages(body) }, start);
    } catch (e) {
      return { ...wrapError('CONVERSATION_READ_FAILED', (e as Error).message, start), httpStatus: 500 };
    }
  },
},
```

(If `readConversation`'s option names differ from `{ tree, renderingMode, renderAllTools }`, match the actual signature verified in Step 1.)

- [ ] **Step 4: Build core and verify it compiles**

Run: `./core.sh build 2>&1 | tail -3`
Expected: `Build successful`.

- [ ] **Step 5: Verify the route live (dev :3200)**

Run:
```bash
./core.sh restart >/dev/null 2>&1; sleep 3
TOKEN=$(cat ~/.lm-assist/api-token | tr -d '\n')
# list a conversation uuid, then read its parsed messages:
UUID=$(curl -s -H "x-api-key: $TOKEN" "http://localhost:3200/claude-ai/conversations?limit=1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log((j.data&&j.data[0]&&(j.data[0].uuid))||'')})")
curl -s -H "x-api-key: $TOKEN" "http://localhost:3200/claude-ai/conversations/$UUID/messages" | head -c 400; echo
```
Expected: `{"success":true,"data":{"uuid":"...","name":"...","messages":[{"role":...}]}}` (a non-empty messages array for a real conversation).

- [ ] **Step 6: Commit**

```bash
git add core/src/routes/core/claude-ai.routes.ts
git commit -m "feat(chat): GET /claude-ai/conversations/:uuid/messages parsed-read route"
```

---

### Task 3: web `useChatConversation` hook

**Files:**
- Create: `web/src/hooks/useChatConversation.ts`

**Interfaces:**
- Consumes: an `apiFetch<T>(path, {method?, body?}) => Promise<T>` (same shape `CoworkPage` builds and passes to `CoworkTaskView`); the parsed-read route from Task 2; the completion route `POST /claude-ai/conversations/:uuid/completion { prompt, model, attachments? }`.
- Produces: `export interface ChatDetailView { uuid: string; name?: string; messages: Array<{ role: string; type: string; text: string; thinking?: string; toolCalls?: Array<{ name: string; input?: unknown; result?: string; isError?: boolean }> }> }` and `export function useChatConversation(opts: { uuid: string; apiFetch: ApiFetch; model: string }): { detail: ChatDetailView | null; err: string | null; gone: boolean; sending: boolean; send: (prompt: string, attachments?: ChatAttachment[]) => Promise<void>; refresh: () => void }` with `export interface ChatAttachment { file_name: string; file_type: string; file_size: number; extracted_content: string; origin: 'user_upload'; kind: 'file' }`.

- [ ] **Step 1: Read the hook this parallels**

Run: `sed -n '1,70p' web/src/hooks/useLiveTranscript.ts`
Reuse its `apiFetch` typing, the seq-guarded `load`, and the `gone`-on-404 idiom. The chat hook is simpler: no SSE, no polling — `send` awaits the blocking completion then reloads.

- [ ] **Step 2: Write the hook**

Create `web/src/hooks/useChatConversation.ts`:

```ts
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type ApiFetch = <T>(path: string, o?: { method?: string; body?: unknown }) => Promise<T>;

export interface ChatAttachment { file_name: string; file_type: string; file_size: number; extracted_content: string; origin: 'user_upload'; kind: 'file' }

export interface ChatDetailView {
  uuid: string;
  name?: string;
  messages: Array<{ role: string; type: string; text: string; thinking?: string; toolCalls?: Array<{ name: string; input?: unknown; result?: string; isError?: boolean }> }>;
}

/** Chat conversation detail: loads core-parsed messages, sends via the blocking
 *  completion endpoint (no SSE — the reply returns whole), then reloads. */
export function useChatConversation(opts: { uuid: string; apiFetch: ApiFetch; model: string }): {
  detail: ChatDetailView | null; err: string | null; gone: boolean; sending: boolean;
  send: (prompt: string, attachments?: ChatAttachment[]) => Promise<void>; refresh: () => void;
} {
  const { uuid, apiFetch, model } = opts;
  const [detail, setDetail] = useState<ChatDetailView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [sending, setSending] = useState(false);

  const seqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const r = await apiFetch<ChatDetailView>(`/claude-ai/conversations/${uuid}/messages`);
      if (seq !== seqRef.current) return;
      setDetail(r); setErr(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (/not.?found|HTTP 404|CONVERSATION_NOT_FOUND/i.test(msg)) setGone(true);
      else setErr(msg);
    }
  }, [apiFetch, uuid]);

  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => { loadRef.current(); }, [uuid]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async (prompt: string, attachments?: ChatAttachment[]) => {
    setSending(true);
    try {
      await apiFetch(`/claude-ai/conversations/${uuid}/completion`, {
        method: 'POST',
        body: { prompt, model, ...(attachments && attachments.length ? { attachments } : {}) },
      });
      await loadRef.current();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [apiFetch, uuid, model]);

  const refresh = useCallback(() => { loadRef.current(); }, []);
  return { detail, err, gone, sending, send, refresh };
}
```

- [ ] **Step 3: Typecheck the file**

Run: `cd web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep useChatConversation || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useChatConversation.ts
git commit -m "feat(chat): useChatConversation hook (blocking completion + reload)"
```

---

### Task 4: web `ChatView` detail component (+ model-only picker prop)

**Files:**
- Modify: `web/src/components/cowork/ModelEffortSelector.tsx` (add an optional `hideEffort` prop; default false → unchanged for Cowork)
- Create: `web/src/components/cowork/ChatView.tsx`

**Interfaces:**
- Consumes: `useChatConversation` (Task 3); `TranscriptMessage` from `@/components/shared/TranscriptMessage`; `ModelEffortSelector`; the `apiFetch` prop.
- Produces: `export function ChatView({ uuid, apiFetch, onClose, onDeleted }: { uuid: string; apiFetch: ApiFetch; onClose: () => void; onDeleted: () => void })`. Task 7 renders `<ChatView>` when an opened row's `kind === 'chat'`.

- [ ] **Step 1: Add `hideEffort` to ModelEffortSelector**

In `web/src/components/cowork/ModelEffortSelector.tsx`, change the signature and guard the effort UI. Replace the props destructure line:

```ts
export function ModelEffortSelector({ model, effort, onChange, hideEffort = false }: {
  model: string; effort: string; onChange: (model: string, effort: string) => void; hideEffort?: boolean;
}) {
```

Then wrap the trailing `·` + effort label in the button and the whole Effort `<div>`-block-and-list in `{!hideEffort && ( ... )}`. When `hideEffort`, the button shows only `{modelLabel}` + the chevron.

- [ ] **Step 2: Write ChatView (based on CoworkTaskView's shell, minus rail/approvals/effort)**

Read `sed -n '1,60p;300,400p' web/src/components/cowork/CoworkTaskView.tsx` for the header title▾ menu + bottom-stick scroll + inline composer idioms, then create `web/src/components/cowork/ChatView.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Send, X } from 'lucide-react';
import { TranscriptMessage } from '@/components/shared/TranscriptMessage';
import { ModelEffortSelector } from '@/components/cowork/ModelEffortSelector';
import { useChatConversation } from '@/hooks/useChatConversation';

type ApiFetch = <T>(path: string, o?: { method?: string; body?: unknown }) => Promise<T>;

/** claude.ai-look-alike Chat conversation view: transcript (center) + a bottom
 *  composer (model + send). Rename/delete via the header. No right rail / approvals
 *  / effort (chat has none). Mirrors CoworkTaskView's shell. */
export function ChatView({ uuid, apiFetch, onClose, onDeleted }: {
  uuid: string; apiFetch: ApiFetch; onClose: () => void; onDeleted: () => void;
}) {
  const [model, setModel] = useState('claude-sonnet-5');
  const { detail, err, gone, sending, send } = useChatConversation({ uuid, apiFetch, model });
  const [prompt, setPrompt] = useState('');
  const [manageErr, setManageErr] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  useEffect(() => { const el = scrollRef.current; if (el && atBottomRef.current) el.scrollTop = el.scrollHeight; });

  const canSend = prompt.trim().length > 0 && !sending;
  const handleSend = async () => {
    const t = prompt.trim();
    if (!t) return;
    setPrompt('');
    await send(t);
  };
  const handleDelete = async () => {
    try { await apiFetch(`/claude-ai/conversations/${uuid}`, { method: 'DELETE' }); onDeleted(); }
    catch (e) { setManageErr(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <MessageSquare size={15} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 13, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail?.name || 'New chat'}</div>
        <button className="btn btn-ghost btn-sm" onClick={handleDelete} title="Delete conversation">Delete</button>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} title="Close"><X size={13} /></button>
      </div>

      <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {gone ? <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12.5 }}>This conversation was deleted.</div>
          : err ? <div style={{ color: 'var(--color-status-red)', fontSize: 12.5 }}>{err}</div>
          : (detail?.messages || []).map((m, i) => <TranscriptMessage key={i} m={m} />)}
        {sending && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Thinking…</div>}
      </div>

      {!gone && (
        <div style={{ borderTop: '1px solid var(--color-border-default)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {manageErr && <div style={{ fontSize: 11, color: 'var(--color-status-red)' }}>{manageErr}</div>}
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
            <textarea className="input" value={prompt} rows={2} placeholder="Reply to Claude…" disabled={sending}
              style={{ flex: 1, resize: 'none', fontSize: 12.5 }}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleSend(); } }} />
            <button className="btn btn-primary btn-sm btn-icon" disabled={!canSend} onClick={() => void handleSend()} title="Send (⌘/Ctrl+Enter)"><Send size={13} /></button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1 }} />
            <ModelEffortSelector model={model} effort="" onChange={(m) => setModel(m)} hideEffort />
          </div>
        </div>
      )}
    </div>
  );
}
```

(The `+` attach button is added in Task 5 — leave it out here so this task's deliverable is a working send-only chat view.)

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "ChatView|ModelEffortSelector" || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/cowork/ChatView.tsx web/src/components/cowork/ModelEffortSelector.tsx
git commit -m "feat(chat): ChatView detail component + model-only picker prop"
```

---

### Task 5: chat text-file attachments (inline `attachments` channel)

**Files:**
- Create: `web/src/lib/chat-attachments.ts` (pure helper: File → ChatAttachment)
- Modify: `web/src/components/cowork/ChatView.tsx` (add `+` tray + include attachments on send)

**Interfaces:**
- Consumes: `AttachmentTray` from `@/components/cowork/AttachmentTray`; `ChatAttachment` from `@/hooks/useChatConversation`.
- Produces: `export async function fileToChatAttachment(file: File): Promise<ChatAttachment>` (rejects non-text files) in `web/src/lib/chat-attachments.ts`. ChatView gains a `+` that stages text files as chips and passes their `ChatAttachment[]` to `send`.

- [ ] **Step 1: Write the pure helper**

Create `web/src/lib/chat-attachments.ts`:

```ts
import type { ChatAttachment } from '@/hooks/useChatConversation';

const TEXT_RE = /^text\/|application\/(json|xml|javascript|typescript|x-yaml|x-sh)|\+(json|xml)$/i;
const TEXT_EXT = /\.(txt|md|markdown|json|ya?ml|csv|tsv|log|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|cc|cs|php|sh|bash|sql|html?|css|xml|toml|ini|env|conf)$/i;

/** True when a file is safe to send inline as extracted text. */
export function isTextFile(file: File): boolean {
  if (file.type && TEXT_RE.test(file.type)) return true;
  if (!file.type && TEXT_EXT.test(file.name)) return true;
  return TEXT_EXT.test(file.name);
}

/** Read a text file's content and build a completion `attachments` entry. Throws
 *  for non-text files (image/binary are deferred — the caller shows a chip error). */
export async function fileToChatAttachment(file: File): Promise<ChatAttachment> {
  if (!isTextFile(file)) throw new Error('Only text files can be attached to chat right now');
  const extracted_content = await file.text();
  return {
    file_name: file.name,
    file_type: file.type || 'text/plain',
    file_size: file.size,
    extracted_content,
    origin: 'user_upload',
    kind: 'file',
  };
}
```

- [ ] **Step 2: Wire the tray + attachments into ChatView**

In `web/src/components/cowork/ChatView.tsx`: import `AttachmentTray` + `useAttachments` + `fileToChatAttachment`, add a hidden file input + `+` button (reuse the CoworkComposer idiom), and pass ready attachments on send. Concretely:

- Add imports:
```ts
import { Plus } from 'lucide-react';
import { AttachmentTray } from '@/components/cowork/AttachmentTray';
import { useAttachments } from '@/components/cowork/useAttachments';
import { fileToChatAttachment } from '@/lib/chat-attachments';
```
- The `useAttachments` hook expects an `onUpload: (file) => Promise<CoworkAttachmentRef>`. For chat we adapt: build the `ChatAttachment` and stash it while returning a synthetic ref so the tray shows a chip. Add above the component return:
```ts
const chatRefs = useRef(new Map<string, import('@/hooks/useChatConversation').ChatAttachment>());
const att = useAttachments(async (file) => {
  const a = await fileToChatAttachment(file);
  const key = `${file.name}:${file.size}`;
  chatRefs.current.set(key, a);
  return { file_uuid: key, file_name: a.file_name }; // synthetic ref: file_uuid = our map key
});
const fileInputRef = useRef<HTMLInputElement>(null);
```
- In `handleSend`, gather the chat attachments from the ready refs and clear:
```ts
const handleSend = async () => {
  const t = prompt.trim();
  const ready = att.refs().map((r) => chatRefs.current.get(r.file_uuid)).filter(Boolean) as import('@/hooks/useChatConversation').ChatAttachment[];
  if (!t && !ready.length) return;
  setPrompt('');
  att.reset(); chatRefs.current.clear();
  await send(t, ready.length ? ready : undefined);
};
const canSend = (prompt.trim().length > 0 || att.hasReady) && !sending && !att.uploading;
```
- In the composer JSX, add the tray + input above the textarea row and a `+` button before the textarea:
```tsx
<AttachmentTray items={att.items} onRemove={att.remove} />
<input ref={fileInputRef} type="file" multiple hidden onChange={(e) => { att.addFiles(e.target.files); e.target.value = ''; }} />
```
```tsx
<button type="button" className="btn btn-ghost btn-sm btn-icon" disabled={sending} title="Add text files" onClick={() => fileInputRef.current?.click()}><Plus size={14} /></button>
```

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "ChatView|chat-attachments" || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/chat-attachments.ts web/src/components/cowork/ChatView.tsx
git commit -m "feat(chat): text-file attachments via the completion attachments channel"
```

---

### Task 6: combined "Chats and tasks" list (`normalizeRows` + CoworkList)

**Files:**
- Create: `web/src/lib/chat-rows.ts` (pure merge/normalize)
- Modify: `web/src/components/cowork/CoworkList.tsx` (accept a `kind` per row, render a type icon, and the `All | Chat | Cowork` filter)

**Interfaces:**
- Consumes: the list shapes `CoworkListItem` (from `CoworkList`/`cowork-tasks`) and a chat conversation `{ uuid, name, updated_at }` (from `/claude-ai/conversations`).
- Produces: `export interface HomeRow { id: string; kind: 'chat' | 'cowork'; title: string; updatedAt: string; subtitle?: string }` and `export function normalizeRows(chats: any[], tasks: any[]): HomeRow[]` (merged, sorted by `updatedAt` desc) in `web/src/lib/chat-rows.ts`. Task 7 feeds these rows to the list.

- [ ] **Step 1: Write `normalizeRows` (pure)**

Create `web/src/lib/chat-rows.ts`:

```ts
export interface HomeRow { id: string; kind: 'chat' | 'cowork'; title: string; updatedAt: string; subtitle?: string }

/** Merge claude.ai chat conversations and cowork tasks into one recency-sorted list. */
export function normalizeRows(chats: any[], tasks: any[]): HomeRow[] {
  const rows: HomeRow[] = [];
  for (const c of Array.isArray(chats) ? chats : []) {
    if (!c?.uuid) continue;
    rows.push({ id: String(c.uuid), kind: 'chat', title: String(c.name || 'New chat'), updatedAt: String(c.updated_at || c.created_at || '') });
  }
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const id = t?.sid || t?.sessionId;
    if (!id) continue;
    rows.push({ id: String(id), kind: 'cowork', title: String(t.title || 'Untitled task'), updatedAt: String(t.lastEventAt || t.updatedAt || ''), subtitle: t.statusCategory || undefined });
  }
  return rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
```

- [ ] **Step 2: Make CoworkList render both kinds + the All|Chat|Cowork filter**

Read `web/src/components/cowork/CoworkList.tsx` fully. Generalize it to accept `rows: HomeRow[]` (from Task 6 Step 1) plus `filter: 'all'|'chat'|'cowork'` and `onFilter`, and render each row with a 💬 (`MessageSquare`) icon for `kind:'chat'` and ✨ (`Sparkles`) for `kind:'cowork'`, calling `onOpen({ id, kind })`. Keep the existing search box. Replace the cowork-only `Filter by Cowork` control with a segmented `All | Chat | Cowork`. (Preserve the existing row styling/spacing verbatim — only the icon + the filter options change.)

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "chat-rows|CoworkList" || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/chat-rows.ts web/src/components/cowork/CoworkList.tsx
git commit -m "feat(chat): combined Chats-and-tasks list (normalizeRows + All|Chat|Cowork filter)"
```

---

### Task 7: mode-aware home (CoworkPage refactor + functional composer toggle) — capstone

**Files:**
- Modify: `web/src/components/cowork/CoworkPage.tsx` (mode state, merged list fetch, `openItem: {id,kind}` routing to ChatView/CoworkTaskView, chat create)
- Modify: `web/src/components/cowork/CoworkComposer.tsx` (functional `Chat | Cowork` toggle + `mode`/`onModeChange` + chat-create path)

**Interfaces:**
- Consumes: `ChatView` (Task 4), `useChatConversation` types, `normalizeRows`/`HomeRow` (Task 6), the generalized `CoworkList` (Task 6), the existing `CoworkTaskView`, `createTask`/`uploadAttachment` already in `CoworkPage`.
- Produces: the working unified home. Terminal deliverable.

- [ ] **Step 1: Make the composer toggle functional**

In `web/src/components/cowork/CoworkComposer.tsx`: add props `mode: 'chat' | 'cowork'` and `onModeChange: (m: 'chat'|'cowork') => void`. Make the `Chat` segment enabled and clickable (`onClick={() => onModeChange('chat')}`), the `Cowork` segment `onClick={() => onModeChange('cowork')}`, and style the active one with the accent-glow (as `Cowork` is today). In Chat mode, the attach `+`, model picker, and send stay; `onCreate` is called the same way (the page decides chat-vs-cowork by `mode`). Update the composer's `onCreate` prop doc to note the page branches on mode. (Attachments in Chat mode from the HOME composer are out of v1 scope — the home composer's tray may stay Cowork-only; chat attachments live in ChatView. If simpler, hide the `+` when `mode==='chat'` on the home composer.)

- [ ] **Step 2: Refactor CoworkPage into the mode-aware home**

In `web/src/components/cowork/CoworkPage.tsx`:
- Add `const [mode, setMode] = useState<'chat' | 'cowork'>('cowork');` and `const [filter, setFilter] = useState<'all'|'chat'|'cowork'>('all');`
- Replace `openSid: string | null` with `const [openItem, setOpenItem] = useState<{ id: string; kind: 'chat' | 'cowork' } | null>(null);`
- `reloadList` fetches BOTH sources in parallel and merges via `normalizeRows`:
```ts
const [chatsR, tasksR] = await Promise.all([
  apiFetch<{ data?: any[] }>(`/claude-ai/conversations?limit=40`).catch(() => ({ data: [] as any[] })),
  apiFetch<{ tasks: any[] }>(`/cowork/tasks?filter=all&limit=40`).catch(() => ({ tasks: [] })),
]);
const rows = normalizeRows((chatsR as any).data || (chatsR as any) || [], (tasksR as any).tasks || []);
setRows(filter === 'all' ? rows : rows.filter((r) => r.kind === filter));
```
  (Store `rows: HomeRow[]` in state; import `normalizeRows`, `HomeRow` from `@/lib/chat-rows`.)
- Add a chat-create path used when `mode==='chat'`:
```ts
const createChat = useCallback(async (o: { prompt: string; model: string }) => {
  setCreating(true);
  try {
    const c = await apiFetch<{ uuid?: string; data?: { uuid?: string } }>(`/claude-ai/conversations`, { method: 'POST', body: { model: o.model } });
    const uuid = (c as any).uuid || (c as any).data?.uuid;
    if (uuid) {
      setOpenItem({ id: uuid, kind: 'chat' });
      await apiFetch(`/claude-ai/conversations/${uuid}/completion`, { method: 'POST', body: { prompt: o.prompt, model: o.model } });
      reloadList();
    }
  } finally { setCreating(false); }
}, [apiFetch, reloadList]);
```
- The composer `onCreate` branches on mode: `onCreate={(o) => mode === 'chat' ? createChat(o) : createTask(o)}`; pass `mode` + `onModeChange={setMode}` to `<CoworkComposer>`.
- Render the detail by kind:
```tsx
{openItem ? (
  openItem.kind === 'chat'
    ? <ChatView key={openItem.id} uuid={openItem.id} apiFetch={apiFetch} onClose={() => setOpenItem(null)} onDeleted={() => { setOpenItem(null); reloadList(); }} />
    : <CoworkTaskView key={openItem.id} sid={openItem.id} apiFetch={apiFetch} onUpload={uploadAttachment} streamUrl={buildStreamUrl(openItem.id)} isRemoteNode={isRemoteNode} onClose={() => setOpenItem(null)} onDeleted={() => { setOpenItem(null); reloadList(); }} />
) : (
  /* composer + <CoworkList rows={rows} filter={filter} onFilter={setFilter} onOpen={setOpenItem} loading={loading} /> */
)}
```
  Import `ChatView` from `@/components/cowork/ChatView`.

- [ ] **Step 3: Build the web (Node 20) and verify it compiles**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 >/dev/null 2>&1 && cd web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "CoworkPage|CoworkComposer" || echo "clean"; timeout 320 npx next build 2>&1 | tail -6`
Expected: `clean` for the touched files, and a successful `next build` (route list printed, no fatal error).

- [ ] **Step 4: Live e2e on dev (:3948 web / :3200 core)**

Restart dev (`nvm use 20 && ./core.sh restart`), open `http://<lan-ip>:3948/cowork`, toggle to **Chat**, send "reply with PONG", confirm the reply renders; open an existing chat from the merged list; toggle back to **Cowork** and confirm a task still creates. (If the dev web won't start under the active Node, use the same standalone smoke-test path documented for prod.)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/cowork/CoworkPage.tsx web/src/components/cowork/CoworkComposer.tsx
git commit -m "feat(chat): mode-aware unified home — functional Chat|Cowork toggle + merged list"
```

---

## Notes for the executor

- **Reuse, don't reinvent:** `TranscriptMessage`, `AttachmentTray`, `useAttachments`, `ModelEffortSelector` are used as-is (ModelEffortSelector gains one optional prop). Match the existing cowork component styling verbatim.
- **Cookie dependency:** Chat needs a valid `~/.claude/claudeai-session.json` (like Cowork's connector-attach) — only node 117 has one, so live-verify on dev here (117) and deploy to 117.
- **Auth for curl checks:** dev/prod share `~/.lm-assist/api-token`; send it as `x-api-key`.
- **Cookie empty-state (Minor, v1-acceptable):** when the claude.ai cookie is absent/expired the chat list simply comes back empty and `ChatView` shows the inline `err`. A dedicated "Connect your claude.ai account to use Chat" empty state (spec §Error handling) is polish — add it in the capstone if cheap, else leave as a follow-up.
- **Final whole-branch review** (subagent-driven-development's last step) should confirm: the toggle switches all three of composer/list/detail; the merged list sorts by recency; chat send is blocking with a Thinking indicator; text attachments reach the model; nothing regressed in Cowork.

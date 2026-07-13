# Chat Surface (Spec 2) — Design

**Status:** approved 2026-07-14. Part of the 4-spec cowork/chat UI program (Spec 1 foundation + Spec 4 attachments shipped; this is Spec 2).

**North star:** consistent with **claude.ai** regular Chat, and consistent with the existing lm-assist **Cowork** UI (reuse its components/patterns). Where the two ever conflict, match claude.ai.

## Goal

Make the composer's `Chat | Cowork` toggle functional so **one unified home** drives both claude.ai **chat conversations** and **cowork tasks** — exactly like claude.ai's single home (`claude.ai/new`) with its Chat|Cowork toggle and combined "Chats and tasks" list. The Chat backend already exists in lm-assist (`/claude-ai/conversations/*`); this is almost entirely a web-layer build plus one pure parser.

## Non-goals (explicitly deferred)

- **Token streaming** (reply appears whole, like Cowork today — a "Thinking…" indicator then the full reply). A live SSE token stream is a fast-follow.
- **Projects** (Spec 3), **artifacts** rendering, message **edit/branch/regenerate**, **image/binary** attachments, **starred**/search. Chat conversations that already belong to a project still render; we just don't add the project selector here.

## Architecture

Refactor `CoworkPage` into a **mode-aware home** (keep the `/cowork` route; the page becomes the shared home; a `/chat` route may alias the same page defaulting to Chat mode — decided in the plan). A single `mode: 'chat' | 'cowork'` state, set by the composer toggle, selects:

1. **Composer create action** — Chat mode creates a claude.ai conversation and sends; Cowork mode creates a cloud task (unchanged).
2. **The combined list** — one "Chats and tasks" list merging `/claude-ai/conversations` (chats) and `/cowork/tasks` (tasks), filterable **All | Chat | Cowork**.
3. **The detail view** — opening a row routes by `kind` to the new `ChatView` (chat) or the existing `CoworkTaskView` (cowork).

Chat uses **blocking completion**: `POST …/completion` drains the SSE server-side and returns the aggregated reply. This matches Cowork's existing refresh-based behavior (neither streams tokens to the browser in v1).

The backend conversation surface already exists (list, read message-tree, create, completion, title, delete) — **no new conversation endpoints**. The one small core addition, for parity with Cowork's architecture (core parses → web renders display-ready messages), is a **parsed view** of the read: the chat message-tree parser lives in **core** and is surfaced either as a `?view=parsed` param on `GET /claude-ai/conversations/:uuid` or a thin sibling `GET /claude-ai/conversations/:uuid/messages` (decided in the plan). This keeps the high-value parsing logic in core where it is unit-tested, exactly as `parseCoworkEvents` is.

## Components

### New

**`parseChatMessages(conversationBody): ChatMsg[]`** — pure parser in **core** (`core/src/claude-ai/chat-read.ts`, mirroring `core/src/cowork/cowork-read.ts`'s `parseCoworkEvents`). Input: the `GET /claude-ai/conversations/:uuid` body (`{ chat_messages: [...], current_leaf_message_uuid }`). Output: the existing `TranscriptMessage` display shape:

```ts
interface ChatMsg { role: 'user' | 'assistant'; type: 'user' | 'assistant'; text: string; thinking?: string; toolCalls?: Array<{ name: string; input?: unknown; result?: string; isError?: boolean }> }
```

Rules: iterate `chat_messages` in order (linear thread; branch/leaf handling deferred); for each message flatten `content[]` blocks — `text`→text, `thinking`→thinking, `tool_use`{id,name,input}→a toolCall, pair a following `tool_result`{tool_use_id,content,is_error} into the matching toolCall by id (the same pairing lm-assist already does for cowork). Tolerate empty/malformed input (return `[]`). Surfaced to the web via the parsed read view (§Architecture).

**`useChatConversation` hook** (`web/src/hooks/`) — parallels `useLiveTranscript` but simpler (blocking, no SSE):
- Loads the parsed read (core-parsed messages) → `messages` (display-ready, no web-side parsing).
- `send(prompt, attachments)` → `POST /claude-ai/conversations/:uuid/completion { prompt, model, attachments }` → on resolve, reload the parsed read (the reply is now in the tree). A `sending` flag drives the "Thinking…" line.
- Surfaces a clean `gone` state on 404 (deleted conversation) and an `err` state otherwise.

**`ChatView`** (`web/src/components/cowork/` alongside its siblings) — detail view mirroring `CoworkTaskView`'s shell: header with title▾ menu (rename / delete — reusing the idiom), a bottom-stick scrollable transcript of `TranscriptMessage`, and a bottom composer (`+` attach tray + model picker + send). **Omits** the right rail, approval widgets, and effort selector (chat has none).

### Reused directly (no change, or minimal prop)

`TranscriptMessage` (message schema is compatible — text/thinking/toolCalls), `AttachmentTray`, `useAttachments`, `ModelEffortSelector` (model-only mode for chat — see §Model picker), the composer shell, and the list shell.

### Refactored

`CoworkPage` → mode-aware home: holds `mode`, merges the two lists, and `openItem: { id, kind } | null` (replacing the cowork-only `openSid`) so it can route open→detail by type. `CoworkComposer` gains a functional toggle + a `mode`/`onModeChange` prop and, in Chat mode, an `onChatCreate` path.

## Data flow

**Chat send (new conversation):**
1. `POST /claude-ai/conversations { model }` → `{ uuid }`.
2. Open `ChatView(uuid)`.
3. `POST /claude-ai/conversations/:uuid/completion { prompt, model, attachments }` (blocking) → `{ text, humanMessageUuid, assistantMessageUuid, … }`.
4. Reload the conversation → `parseChatMessages` → render (user turn + assistant reply).

**Chat send (existing conversation):** steps 3–4 only, against the open uuid.

**Attachments (text files, v1):** read the file text client-side (`FileReader.readAsText`) and send it in the completion's **`attachments`** (text) channel as `{ file_name, file_type, file_size, extracted_content, origin: 'user_upload', kind: 'file' }`. No upload round-trip (distinct from Cowork's `/cowork/attachments` file_uuid flow). The `useAttachments` tray is reused for the chip UX; a chat variant of the "upload" step just reads text instead of POSTing. Non-text files are rejected in v1 with a clear chip error (image/binary = fast-follow via the `files`/upload channel).

**Combined list:** fetch `/claude-ai/conversations` and `/cowork/tasks` in parallel; normalize each to `{ id, kind: 'chat' | 'cowork', title, updatedAt, subtitle? }`; sort by `updatedAt` desc; render rows with a 💬 (chat) / ✨ (cowork) icon and the **All | Chat | Cowork** filter. Opening routes by `kind`.

## Model picker

Reuse `ModelEffortSelector` in a **model-only** mode for Chat (chat completion has no `effort_level`). **Verify (plan task 1):** which model ids chat completion accepts — the documented default is `claude-opus-4-7`, while the current picker uses `claude-opus-4-8` / `claude-sonnet-5` / `claude-fable-5` / `claude-haiku-4-5-…`. Confirm against `/claude-ai/org/model-config/:model` or the claude.ai chat model list and align the Chat picker so it can never offer a model chat rejects. Cowork's picker is unchanged.

## Error handling

Chat is **cookie-based** (same claude.ai session as Cowork's connector-attach). If the cookie is absent/expired/blocked, list/create/send fail — surface a single clear empty state ("Connect your claude.ai account to use Chat") rather than raw errors, mirroring how Cowork degrades. Blocking completion can take many seconds for long replies — the "Thinking…" indicator covers it; use a generous client timeout.

## Testing

- **`parseChatMessages`** (core) — `node:test` unit tests, the highest-value pure unit: text-only turn, tool_use paired with its tool_result, thinking block captured, multi-message chronological order, empty/malformed input → `[]`. Follows `core/src/cowork/__tests__/cowork-read.test.ts` verbatim in style, and runs in the existing core suite.
- **`normalizeRows()`** (web, pure) — merges the two list sources into the sorted common shape; a small pure function verified by the live e2e (and a standalone `node:test` if trivial to wire).
- The hook + views get light smoke coverage; full behavior is verified live e2e on dev, then on 117 (the cookie-bearing node — Chat, like attachments, needs a claude.ai cookie).

## File map

```
core/src/claude-ai/
  chat-read.ts                        NEW — parseChatMessages() + ChatMsg type
  __tests__/chat-read.test.ts         NEW — parser unit tests (node:test)
core/src/routes/core/claude-ai.routes.ts   EDIT — parsed read view (?view=parsed or /:uuid/messages)
web/src/
  lib/chat-rows.ts                    NEW — normalizeRows() merge/sort
  hooks/useChatConversation.ts        NEW — load parsed read + blocking send + reload
  components/cowork/
    CoworkPage.tsx                    REFACTOR — mode-aware home, merged list, openItem{id,kind}
    CoworkComposer.tsx                EDIT — functional toggle + mode + onChatCreate
    CoworkList.tsx                    EDIT — render both kinds + All|Chat|Cowork filter
    ChatView.tsx                      NEW — chat detail (transcript + inline bottom composer, no rail)
  components/shared/TranscriptMessage.tsx   REUSED as-is
```

`ChatView` contains its own inline bottom composer (as `CoworkTaskView` does) — no separate `ChatComposer` file. New-chat creation is driven by the home `CoworkComposer` toggle.

## Global constraints

- Match claude.ai's Chat look/feel; reuse Cowork's components and visual language verbatim where they apply (same `TranscriptMessage`, same composer chrome, same list rows).
- No new conversation endpoints — build on the existing `/claude-ai/conversations/*` surface; the only core addition is the parsed-read view + the `parseChatMessages` parser (core, unit-tested).
- Web changes must keep `next build` green (the repo's `typescript.ignoreBuildErrors:true` baseline stands; gate = build + per-file `tsc` grep clean for touched files).
- The Chat picker must never offer a model chat completion rejects (verify first).

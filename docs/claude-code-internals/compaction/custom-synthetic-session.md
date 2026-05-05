# Custom Synthetic Session — Selective History Curation

**Goal:** Bypass Claude Code's default compact by constructing a synthetic JSONL session file with a hand-curated message history (e.g. filtered by topic relevance or cache-TTL window), then use `claude --resume <sessionId>` (or SDK `resume: sessionId`) to pick up from it.

**Motivation:** CC's default compact summarizes *all* prior messages into a single blob regardless of the next prompt's topic, and doesn't account for prompt-cache TTL — messages that have fallen outside the 5-min (or 1h extended) cache window still get re-sent, just in summarized form. Selective curation lets you keep context relevant to the next prompt while preserving a stable cache prefix.

---

## How CC's resume selects the leaf

From `utils/sessionStorage.ts:3718-3786` and `:2988`:

```text
1. Parse every JSONL line into a Map<uuid, message>
2. Collect parentUuids of all messages
3. Terminal messages = those whose uuid appears in NO other's parentUuid
4. Walk back from each terminal to find a user/assistant ancestor → leaf candidates
5. findLatestMessage(candidates, by timestamp) → the resume point
6. Build conversation chain from root → leaf, then normalize for API send
```

Then `conversationRecovery.ts:164-252` runs these filters BEFORE leaf computation:

- `filterUnresolvedToolUses` — drops assistant messages with tool_use blocks that have no matching tool_result
- `filterOrphanedThinkingOnlyMessages` — drops thinking-only assistants with no follow-up
- `filterWhitespaceOnlyAssistantMessages` — drops assistants whose text is only whitespace or the `NO_RESPONSE_REQUESTED` sentinel

**Key implication:** any synthetic message that fails these filters gets silently removed, which can break the chain and cause CC to fork at an earlier point.

---

## File location

```text
~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
```

Where `<encoded-cwd>` = `/` replaced with `-`, leading `-` kept. Example: `/home/ubuntu/lm-assist` → `-home-ubuntu-lm-assist`.

**Important:** the cwd must match when launching CC — the encoded directory is resolved from `process.cwd()` at spawn time.

---

## Required fields per line type

### Common (every line)

```json
{
  "uuid": "<v4-uuid>",
  "parentUuid": "<uuid-of-previous-line-or-null>",
  "type": "user | assistant | system | attachment | ...",
  "timestamp": "<ISO-8601>",
  "sessionId": "<uuid>",
  "cwd": "/absolute/path",
  "version": "2.1.104",
  "gitBranch": "main",
  "userType": "external",
  "isSidechain": false,
  "isMeta": false
}
```

### User message

```json
{
  "...common": "...",
  "type": "user",
  "promptId": "<v4-uuid>",
  "message": { "role": "user", "content": "<text or content-block array>" }
}
```

### Assistant message (critical fields)

```json
{
  "...common": "...",
  "type": "assistant",
  "requestId": "req_<hex>",
  "message": {
    "id": "msg_<hex>",
    "role": "assistant",
    "model": "claude-sonnet-4-5-20250929",
    "type": "message",
    "stop_reason": "end_turn" | "tool_use",
    "stop_sequence": null,
    "content": [ { "type": "text", "text": "..." } ],
    "usage": {
      "input_tokens": 0,
      "output_tokens": 0,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0
    }
  }
}
```

**All four fields are required in practice:**
- `requestId` (top-level) — present on every real assistant message
- `message.id` with `msg_` prefix — used by CC for dedup and UI linking
- `stop_reason` — missing value can trigger "incomplete" filtering
- `usage` block with all four token counters — even zeros are fine, but the shape must match

### Tool use / tool result pair

Assistant line with `tool_use`:

```json
{
  "type": "assistant",
  "message": {
    "stop_reason": "tool_use",
    "content": [
      { "type": "text", "text": "I'll check..." },
      { "type": "tool_use", "id": "toolu_<hex>", "name": "Bash", "input": { "command": "ls" } }
    ],
    "...": "..."
  }
}
```

Next user line with matching `tool_result`:

```json
{
  "type": "user",
  "toolUseResult": { "stdout": "file1\nfile2", "stderr": "", "interrupted": false, "isImage": false },
  "message": {
    "role": "user",
    "content": [
      { "type": "tool_result", "tool_use_id": "toolu_<hex>", "content": "file1\nfile2", "is_error": false }
    ]
  }
}
```

**Hard requirements:**
- `tool_use.id` ↔ `tool_result.tool_use_id` must match exactly
- Tool_use must be followed by tool_result in the very next user message (API rejects otherwise)
- `toolUseResult` top-level object is CC-specific (not API-required, but UI uses it)

### Compact boundary (optional — for retaining original file + marking a curated slice)

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "uuid": "<new-uuid>",
  "parentUuid": null,
  "compactMetadata": { "trigger": "manual", "preTokens": 0 },
  "content": "Conversation compacted",
  "level": "info",
  "timestamp": "<ISO>",
  "sessionId": "<same>",
  "version": "2.1.104",
  "gitBranch": "main",
  "cwd": "/...",
  "userType": "external",
  "isSidechain": false,
  "isMeta": false
}
```

Followed by a user-role summary message flagged with `isCompactSummary: true, isVisibleInTranscriptOnly: true`. Resume picks up from the **last** `compact_boundary` in the file forward.

---

## Empirical findings

### Failure case (test 1): silent fork at msg 0

Four messages with `timestamp: new Date().toISOString()` called 4× in the same synchronous block. All four timestamps identical to the millisecond. `findLatestMessage` with tied timestamps picked the first-iterated entry (msg 0), and CC forked the chain there — discarding msgs 1-3. Only content from msg 0 reached the API.

Additional fields missing from the synthetic lines: `requestId`, `msg_` prefix on `message.id`. Either or both may have contributed to filter disqualification.

### Success case (test 2): all context preserved

Same 4 messages plus a tool_use/tool_result pair (6 lines total), fixed with:
- Explicit monotonic timestamps 1 second apart: `new Date(base + i * 1000).toISOString()`
- `requestId: "req_<hex>"` on every assistant line
- `message.id: "msg_<hex>"`
- `stop_reason` explicitly `"end_turn"` or `"tool_use"`
- `toolUseResult` top-level on tool_result user messages
- Matching `tool_use.id` ↔ `tool_result.tool_use_id`

Result: model recited all 5 fabricated facts (including content from the tool_result blocks), `input_tokens: 285` confirming the full chain was sent to the API.

---

## Minimal working recipe

```js
import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync } from "fs";

const cwd = process.cwd();
const encoded = "-" + cwd.replace(/\//g, "-").replace(/^-/, "");
const projectsDir = `${process.env.HOME}/.claude/projects/${encoded}`;
mkdirSync(projectsDir, { recursive: true });

const sessionId = randomUUID();
const base = Date.now() - 10 * 60 * 1000;  // place session 10min ago
const ts = i => new Date(base + i * 1000).toISOString();
const hex = () => randomUUID().replace(/-/g, "").slice(0, 24);
const msgId = () => "msg_" + hex();
const reqId = () => "req_" + hex();

const common = {
  sessionId, cwd, version: "2.1.104", gitBranch: "main",
  userType: "external", isSidechain: false, isMeta: false,
};

function userLine({ uuid, parentUuid, text, timestamp }) {
  return {
    ...common, type: "user", uuid, parentUuid, timestamp,
    promptId: randomUUID(),
    message: { role: "user", content: text },
  };
}

function assistantLine({ uuid, parentUuid, text, timestamp, model = "claude-sonnet-4-5-20250929" }) {
  return {
    ...common, type: "assistant", uuid, parentUuid, timestamp,
    requestId: reqId(),
    message: {
      id: msgId(), role: "assistant", model, type: "message",
      stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text }],
      usage: { input_tokens: 0, output_tokens: 0,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

// ... build chain with each line's parentUuid = previous line's uuid ...

writeFileSync(
  `${projectsDir}/${sessionId}.jsonl`,
  lines.map(JSON.stringify).join("\n") + "\n"
);

// Then:
//   claude --resume <sessionId>
// Or via SDK:
//   query({ prompt, options: { resume: sessionId, ... } })
```

---

## Curation strategies

### Cache-aware: drop messages outside the TTL window

```js
const TTL_MS = 5 * 60 * 1000;  // default ephemeral
const now = Date.now();
const kept = original.filter(m => now - Date.parse(m.timestamp) < TTL_MS);
```

Keeping only messages inside the cache window maximizes the chance the rebuilt prefix matches the server's existing cache entry — but only if the messages are byte-identical to what was originally sent. In practice, you'll still form a new cache entry because rechaining introduces new UUIDs. The TTL filter is still useful to *bound* context size.

### Topic-aware: filter by embedding or keyword

```js
const topic = nextPromptText;
const kept = original.filter(m => {
  const content = extractText(m);
  return cosineSim(embed(content), embed(topic)) > 0.5
      || keywords(topic).some(k => content.includes(k));
});
```

Then re-chain with monotonic timestamps and fresh UUIDs.

### Tool-pair preservation

When filtering, you must keep tool_use/tool_result pairs together. Drop orphans:

```js
function dropOrphanPairs(msgs) {
  const toolUseIds = new Set();
  for (const m of msgs) {
    if (m.message?.content?.some?.(b => b.type === "tool_use")) {
      for (const b of m.message.content) {
        if (b.type === "tool_use") toolUseIds.add(b.id);
      }
    }
  }
  const resultIds = new Set();
  for (const m of msgs) {
    if (m.message?.content?.some?.(b => b.type === "tool_result")) {
      for (const b of m.message.content) {
        if (b.type === "tool_result") resultIds.add(b.tool_use_id);
      }
    }
  }
  const complete = [...toolUseIds].filter(id => resultIds.has(id));
  // Keep only messages whose tool_use/tool_result IDs are in `complete`
  return msgs.filter(m => /* ... keeps pairs together ... */);
}
```

---

## Gotchas

| Issue | Cause | Fix |
|---|---|---|
| CC forks at msg 0 | Tied timestamps, iterator picks first on tie | Explicit monotonic timestamps ≥1ms apart (use seconds) |
| Synthetic assistant messages dropped | Missing `requestId` or non-standard `message.id` | Include `requestId: req_<hex>` and `message.id: msg_<hex>` |
| API rejects with "tool_use without tool_result" | Orphaned tool_use blocks | Keep pairs together or drop both |
| API rejects with mismatched tool IDs | `tool_use.id ≠ tool_result.tool_use_id` | Ensure both sides share the exact same ID string |
| Resume picks wrong leaf | Chain has multiple terminals (branching) | Ensure single terminal; each message's child has the right parentUuid |
| Chain stops early | Dangling `parentUuid` referencing a non-existent uuid | Verify chain continuity before writing |
| Cache never warms | Rechained messages have new UUIDs | Expected — new session = new cache prefix; accept the first-turn write cost |
| Model ignores part of history | `isSidechain: true` accidentally set | Ensure `isSidechain: false` on all main-chain messages |

---

## Runtime Pivoting: Hook + tmux Pattern

The previous sections covered building synthetic sessions. **This section covers how to make a *running* CC process load a freshly-built synthetic session without restarting it**, so you can pivot context per-prompt based on runtime analysis.

### The problem

A running CC process has its `sessionId` baked in at spawn time. Verified dead-ends:

| Attempted mechanism | Result |
|---|---|
| SDK control protocol `switchSession` verb | Does not exist |
| Hook directly calls `context.resume()` | Not exposed to hook runtime |
| `/resume <id>` streamed via SDK `streamInput` | **"Unknown slash command: resume"** — headless mode rejects it |
| Hook returns replacement prompt starting with `/` | Slash commands parsed *before* hooks; replacement not re-parsed |
| Hook rewrites JSONL on disk | CC only reads JSONL at startup; mid-session writes ignored |

Only one path works empirically: **CLI TUI `/resume <id>` pivots in-place, mid-session**. Combined with tmux as the injection vector, and a UserPromptSubmit hook as the trigger, this yields a complete runtime-pivoting pattern.

### Architecture

```text
┌─ User types "[PIVOT:topic] actual question" in tmux pane
│
├─▶ UserPromptSubmit hook fires (inside CC)
│   ├─ Detects [PIVOT:topic] trigger
│   ├─ Builds curated JSONL at <new-session-id>.jsonl
│   ├─ Spawns detached background script (inherits CC_TMUX_PANE env)
│   └─ Returns {"continue": false} → CC discards original prompt
│
├─▶ Background script (after small delay):
│   ├─ tmux send-keys '/resume <new-session-id>' Enter
│   ├─ Waits for CC to finish pivot (polls capture-pane)
│   ├─ tmux send-keys -l "<clean prompt without [PIVOT] tag>"
│   └─ tmux send-keys Enter
│
└─▶ CC in pivoted session processes the re-injected prompt with curated context
```

### Verified test result

End-to-end test ran 2026-04-14. A single user keystroke of `[PIVOT:dandelion] Who is the Phase 1 lead and when does Phase 2 start?` produced:

```text
T+0.0s  User keystroke
T+0.001s Hook fires, builds synthetic session, spawns bg, returns continue:false
T+1.0s  Bg sends '/resume <targetId>' Enter
T+1.2s  CC pivoted — pane shows target session's curated history
T+1.6s  Bg sends clean prompt (without [PIVOT:...] tag)
T+1.9s  Hook fires again (pass-through, now in pivoted session)
T+9.5s  Model responds:
        "- Phase 1 lead: Dr. Vasquez
         - Phase 2 start: In 45 days from today (2026-04-14), ≈ 2026-05-29"
```

Key evidence: model cited "Dr. Vasquez" (name exists *only* in synthetic JSONL) and computed the Phase 2 date from the synthetic "45 days" fact.

### Working sample project

Complete reproducible sample. Drop these four files into any directory and you have the full pattern.

#### 1. `build-target.mjs` — topic-keyed synthetic session builder

```js
import { randomUUID } from "crypto";
import { writeFileSync } from "fs";

const cwd = process.argv[2];
const topic = process.argv[3] || "generic";
const encoded = "-" + cwd.replace(/\//g, "-").replace(/^-/, "");
const pdir = `${process.env.HOME}/.claude/projects/${encoded}`;
const sid = randomUUID();
const base = Date.now() - 600_000;  // place session 10 min ago
const ts = i => new Date(base + i * 1000).toISOString();
const hex = () => randomUUID().replace(/-/g, '').slice(0, 24);
const common = {
  sessionId: sid, cwd, version: "2.1.104", gitBranch: "main",
  userType: "external", isSidechain: false, isMeta: false
};

// Your curation logic: look up context by topic from your knowledge base,
// past sessions, embeddings, etc.
const contexts = {
  dandelion: "Project OPERATION DANDELION involves 3 phases: Reconnaissance, Germination, Bloom. Phase 1 lead is Dr. Vasquez. Phase 2 starts in 45 days.",
  bluefish:  "Our codename BLUEFISH launched March 2026. The BLUEFISH squad has 7 members. The mascot file is /tmp/bluefish-logo.svg.",
};
const ctx = contexts[topic] || contexts.dandelion;

const u = randomUUID(), a = randomUUID();
const lines = [
  { ...common, parentUuid: null, type: "user", uuid: u, promptId: randomUUID(),
    timestamp: ts(0),
    message: { role: "user", content: `Context brief: ${ctx}` } },
  { ...common, parentUuid: u, type: "assistant", uuid: a, timestamp: ts(1),
    requestId: "req_" + hex(),
    message: {
      id: "msg_" + hex(), role: "assistant", model: "claude-sonnet-4-5-20250929",
      type: "message", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: `Acknowledged. I've noted: ${ctx}` }],
      usage: { input_tokens: 40, output_tokens: 20,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } },
];
writeFileSync(`${pdir}/${sid}.jsonl`, lines.map(JSON.stringify).join("\n") + "\n");
console.log(sid);
```

Replace the `contexts` object with your real curation logic — file lookups, embedding search, past-session filtering by TTL window, etc.

#### 2. `.claude/hooks/pivot-hook.sh` — the UserPromptSubmit hook

```bash
#!/usr/bin/env bash
set -uo pipefail
LOG=/tmp/pivot-hook-test-2/hook.log
exec 2>>$LOG
echo "[$(date +%H:%M:%S.%N)] === HOOK FIRED ===" >> $LOG

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Guard: only pivot when [PIVOT:topic] present AND we have a tmux pane AND we're in the right cwd
if [[ "$PROMPT" =~ \[PIVOT:([a-z]+)\] ]] \
   && [[ -n "${CC_TMUX_PANE:-}" ]] \
   && [[ "$CWD" == /tmp/pivot-hook-test-2* ]]; then
  TOPIC="${BASH_REMATCH[1]}"
  CLEAN_PROMPT=$(echo "$PROMPT" | sed -E 's/\[PIVOT:[a-z]+\]\s*//')

  TARGET_ID=$(node /tmp/pivot-hook-test-2/build-target.mjs "$CWD" "$TOPIC")

  # Detached background injector — runs AFTER hook returns
  nohup bash -c "
    sleep 1.0                     # let CC process continue:false + redraw prompt
    tmux send-keys -t '$CC_TMUX_PANE' '/resume $TARGET_ID' Enter

    # Poll for post-pivot prompt glyph
    for i in \$(seq 1 40); do
      if tmux capture-pane -t '$CC_TMUX_PANE' -p | tail -6 | grep -qE '^❯ *\$'; then
        break
      fi
      sleep 0.2
    done

    sleep 0.5
    tmux send-keys -t '$CC_TMUX_PANE' -l '$CLEAN_PROMPT'
    sleep 0.3
    tmux send-keys -t '$CC_TMUX_PANE' Enter
  " </dev/null >>$LOG 2>&1 &
  disown

  echo '{"continue": false, "stopReason": "Pivoting to curated context..."}'
else
  echo '{"continue": true}'
fi
```

#### 3. Settings registration

For initial testing, register at **user level** (`~/.claude/settings.json`) to skip the project-trust prompt:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "/tmp/pivot-hook-test-2/.claude/hooks/pivot-hook.sh"
      }]
    }]
  }
}
```

For production, use `.claude/settings.json` inside the project cwd and approve trust once.

#### 4. Launch script

```bash
#!/usr/bin/env bash
PANE="cc:0.0"
tmux kill-session -t cc 2>/dev/null
tmux new-session -d -s cc -x 220 -y 60

# Pipe pane to a log for debugging
tmux pipe-pane -t cc -O "cat >> /tmp/pivot-hook-test-2/session.log"

# Launch CC with CC_TMUX_PANE set so the hook can inject back into this pane
tmux send-keys -t cc "cd /tmp/pivot-hook-test-2" Enter
tmux send-keys -t cc "export CC_TMUX_PANE=$PANE" Enter
tmux send-keys -t cc 'claude --dangerously-skip-permissions --model haiku' Enter

# Boot detection: wait for statusline marker
for i in {1..45}; do
  tmux capture-pane -t cc -p | grep -qE 'ctx:0%' && break
  sleep 1
done
sleep 2  # settle

tmux attach -t cc   # drops you into CC — type `[PIVOT:dandelion] your question`
```

### Boot detection signal

`grep 'ctx:0%'` against `capture-pane -p` output is the most reliable "CC is ready for input" signal. The `❯` glyph appears multiple times during boot and is ambiguous. The `ctx:0%` statusline marker only appears once CC has finished initial rendering and is accepting input.

### Gotchas discovered during testing

| Issue | Cause | Fix |
|---|---|---|
| Hook never fires | Project-local `.claude/settings.json` needs trust approval | Register at user level for testing, or manually approve trust |
| Keystrokes eaten pre-boot | Send happens before CC is ready | Poll for `ctx:0%` in capture-pane before sending |
| Background pivot races with CC rejection | No delay between hook return and tmux injection | `sleep 1.0` in bg before first send-keys |
| Last char of prompt dropped | Enter sent in same `send-keys` call as text | Send text (`-l`) and Enter as two separate calls |
| Pivot never completes | Polling for `❯` matches transient mid-boot prompts | Tighten regex to `'^❯ *$'` (line start, optional trailing space only) |
| Bg process dies with hook | Missing `nohup` / `disown` | Use `nohup bash -c "..." &` + `disown` |
| Special chars in prompt break bash-quoting | Unescaped `$`, backticks in user text | Pass prompt via temp file or escape single-quote properly |

### Cosmetic behaviors to be aware of

1. **Pane briefly shows curated turns before the answer.** `/resume` makes CC render the target session's history. Users see a "Context brief:..." rewind before their response appears. Hide by wrapping CC in a custom UI that only shows model output.
2. **Clean prompt visually retyped.** After pivot, the bg re-types the prompt; it appears as if the user typed it twice. Same mitigation — custom UI.
3. **Hook fires twice per trigger.** Once for the original trigger prompt (rejected), once for the re-injected clean prompt (pass-through). Account for this in any token/logging accounting.

### Production considerations

- **Concurrency lock**: a bg process in flight shouldn't be interrupted by a new pivot. Use a lock file in `/tmp/pivot-<pane>.lock` to serialize.
- **Confirmation prompts**: if a future CC version makes `/resume` ask for confirmation mid-session, the bg needs to send `y`/Enter after the `/resume`. Test on each CC upgrade.
- **Trigger source**: the `[PIVOT:topic]` literal is fine for testing. For real use, you probably want implicit triggers — analyze every prompt, decide if a pivot would help (topic shift, cache expired), pivot silently. The hook can run all of this analysis before deciding whether to return `continue:false` (pivot) vs `continue:true` (stay in current session).
- **Failure mode**: if target session build fails or `/resume` errors, you've already rejected the original prompt — the user sees nothing happen. Add a fallback: on bg failure, send an error message via `tmux send-keys` or fall through to re-typing the original (untagged) prompt.
- **Cache behavior**: each pivot creates a fresh cache prefix (new UUIDs, new system prompt hash if settings changed). Pivoting every turn busts cache every turn. Use sparingly — pivot only when the payoff (reduced prompt size, better context) exceeds the cache-miss cost.

### Alternative architecture: external controller

If you own the user-facing UI (web, custom CLI), skip the hook dance:

```text
User → Your UI → Your controller → tmux → CC
                     │
                     ├─ analyze prompt
                     ├─ build curated JSONL
                     ├─ send-keys /resume
                     └─ send-keys prompt
```

Cleaner, no hook rejection gymnastics, full structured logging. Downside: users must use your UI, not CC's native TUI. For most productization this is the right trade.

Use the hook pattern when users **must** keep using the CC CLI directly (e.g. integrating into an existing developer workflow without disruption).

---

---

## Dual-Model Annotation Architecture

The previous section answered **how** to pivot; this answers **what to include** in the curated session. Summary-based summarize-everything approaches waste tokens on irrelevant history. Per-prompt relevance scoring with hand-tuned weights generalizes poorly. The right architecture: **amortize LLM-produced annotations offline, use a fast router at prompt time**.

### Architecture at a glance

```text
Main session ──► new turns appended to session.jsonl
                              │
                              ├─ Stop hook fires
                              ▼
                 ┌────────────────────────────────────┐
                 │ 1. ANNOTATOR (background, slow)    │
                 │    SAME model as main session      │  ← cache reuse
                 │    via forked SDK session          │
                 │    Writes session.annotations.jsonl│
                 └─────────────────┬──────────────────┘
                                   ▼
                 ┌────────────────────────────────────┐
                 │ 2. INDEX BUILDER                   │
                 │    Consolidates annotations →      │
                 │    session.index.json (compact)    │
                 └─────────────────┬──────────────────┘
                                   ▼
User prompt ──► UserPromptSubmit hook
                              │
                              ▼
                 ┌────────────────────────────────────┐
                 │ 3. MATCHER (hot path, fast)        │
                 │    Haiku 4.5                       │  ← different model
                 │    Input: prompt + index (~5KB)    │     for speed
                 │    Output: relevant_topics + uuids │
                 └─────────────────┬──────────────────┘
                                   ▼
                 ┌────────────────────────────────────┐
                 │ 4. BUILD (sync, file I/O)          │
                 │    Filter JSONL by matched uuids + │
                 │    sticky + tool-pairs, rechain    │
                 └─────────────────┬──────────────────┘
                                   ▼
                 ┌────────────────────────────────────┐
                 │ 5. PIVOT (tmux /resume)            │
                 │    From earlier Runtime Pivoting   │
                 │    section                         │
                 └────────────────────────────────────┘
```

### Why the dual-model split

| Role | Model | Reason |
|---|---|---|
| **Annotator** (once per turn, background) | Same as main session (Opus/Sonnet) | Forked session cache reuse requires model match; accuracy matches main conversation |
| **Matcher** (every prompt, hot path) | Haiku 4.5 | Sub-second latency (pre-warmed: ~800ms); classification task — Haiku is sufficient; cheap |

Annotator pays for accuracy where it's amortized (per turn, with cache discount). Matcher pays for speed where latency is user-visible.

### Schemas

#### Annotation record (one JSONL line per turn)

```json
{
  "uuid": "turn uuid from session.jsonl",
  "topics": ["auth", "architecture-decision"],
  "entities": ["Redis", "JWT", "session.ts"],
  "role": "user-brief | decision | state-change | reference | reasoning | tool-output | imperative",
  "summary": "<=120 char one-line summary",
  "referenced_uuids": ["earlier turn uuid this builds on"],
  "state_impact": "short description of file/system change, or 'none'",
  "stickyness": "low | medium | high"
}
```

#### Index structure (consolidated, passed to matcher)

```json
{
  "sessionId": "...",
  "lastIndexed": "ISO-8601",
  "turn_count": 18,
  "topic_clusters": {
    "auth": { "uuids": [...], "turns_summary": ["...", "..."], "turn_count": 6 }
  },
  "sticky_high": ["uuid-of-first-user-msg", "uuid-of-imperatives"],
  "imperatives": [{"uuid": "...", "summary": "..."}],
  "recent_3": ["uuid1", "uuid2", "uuid3"],
  "entity_map": { "Redis": ["uuid-a", "uuid-d"] },
  "referenced_by": { "parent-uuid": ["child-uuid"] }
}
```

**Sticky definition:** intentionally narrow — only the first user message (session goal) + imperative-role turns (user-set rules). Topic-specific decisions are NOT sticky; they come via topic matching. Over-inclusive sticky lists defeat the curation.

### Forked-session cache reuse for the annotator

The annotator should run as a forked SDK session to share cache with the main session:

```ts
const annotator = unstable_v2_resumeSession(originalSessionId, {
  model: mainSessionModel,                    // MUST match — cache key
  forkSession: true,
  systemPrompt: { type: 'preset', preset: 'claude_code' },
  tools: mainSessionTools,
  betas: mainSessionBetas,
});
await annotator.send(annotationInstructions);
```

Prefix (model + system + tools + messages up to last `cache_control`) matches the main session byte-for-byte → cache hits on ~90% of input. Only the annotation request + response cost new money. Valid within TTL (5m default, 1h with `extended-cache-ttl-2025-04-11` beta).

**Requirements for cache hit:** same model, same system, same tools, same betas, within TTL, prior inference placed a `cache_control` marker at or past the prefix. CC does this by default.

### End-to-end verified results

Full pipeline tested 2026-04-14 on a synthetic 18-turn session spanning auth, deployment, and database topics. Three test prompts:

| Prompt | Matched Topics | Curated Lines | Model Answer Cites |
|---|---|---|---|
| "Should I add an index on the orgs.name column?" | `database, schema-design` | 8 | `WHERE deleted_at IS NULL` (curated soft-delete pattern) |
| "How many Redis replicas do I need for my AWS production?" | `infrastructure, aws, implementation` | 10 | "1000 DAU" threshold (curated scaling fact) |
| "I want to add MFA — where store the TOTP secret?" | `auth, data-model, database` | 12 | `mfaVerified` field (curated SessionData interface) |

All three answers were contextually correct, drawing from the curated slice without hallucinating. Input tokens per curated resume: 592 / 634 / 834 — well under the full session's ~2500 token equivalent.

#### Observed costs

| Stage | Cost | Frequency |
|---|---|---|
| Annotation (18 turns, Haiku) | $0.13 | Once; ~3-4× cheaper with primary-model fork + cache hit |
| Matcher call | $0.0012 | Every prompt |
| Curated resume inference | ~$0.002 | Every prompt |

### Working sample project

All five scripts from `/tmp/annotation-pivot/`. Self-contained — drop in and run.

#### `01-build-fixture.mjs` — synthetic multi-topic session (testing)

Creates a 3-topic session (auth/deployment/database) with tool pairs. See repo for full source.

#### `02-annotate.mjs` — annotator

```js
// Reads session JSONL, emits annotations JSONL
// Production: use forked SDK session with same model as main for cache reuse.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";

const sessionId = process.argv[2];
const pdir = `${process.env.HOME}/.claude/projects/<encoded-cwd>`;
const lines = readFileSync(`${pdir}/${sessionId}.jsonl`, "utf8")
  .split("\n").filter(Boolean).map(JSON.parse);

// Extract compact turn representations (user/assistant only)
function extractText(d) { /* ... handle text, tool_use, tool_result blocks ... */ }
const turns = lines
  .filter(d => d.type === "user" || d.type === "assistant")
  .map(d => ({ uuid: d.uuid, role: d.type, text: extractText(d).slice(0, 1500),
               timestamp: d.timestamp }));

// Skip already-annotated turns
const annFile = `${pdir}/${sessionId}.annotations.jsonl`;
const existing = new Set(existsSync(annFile)
  ? readFileSync(annFile, "utf8").split("\n").filter(Boolean)
      .map(l => JSON.parse(l).uuid)
  : []);
const unannotated = turns.filter(t => !existing.has(t.uuid));
if (unannotated.length === 0) process.exit(0);

const instructions = `Emit ONE annotation JSON object per line (JSONL) for each turn.
Schema: {uuid, topics, entities, role, summary, referenced_uuids, state_impact, stickyness}

Turns to annotate:
${JSON.stringify(unannotated.map(t => ({uuid: t.uuid, role: t.role, text: t.text})), null, 2)}

Emit only JSONL output, one annotation per line.`;

// SDK call with same-model-as-main for fork cache reuse
const q = query({
  prompt: (async function*() { yield { type: 'user',
    message: { role: 'user', content: instructions },
    session_id: 'annotator', parent_tool_use_id: null }; })(),
  options: {
    model: "claude-haiku-4-5-20251001",  // testing; prod: same as main session
    tools: [], settingSources: [],
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    systemPrompt: "You are a precise JSONL emitter. Output ONLY JSONL, one JSON per line.",
  },
});

let text = "";
for await (const msg of q) {
  if (msg.type === 'assistant' && msg.message?.content) {
    for (const b of msg.message.content) if (b.type === 'text') text += b.text;
  }
  if (msg.type === 'result') break;
}

// Parse + append
const annotations = text.replace(/^```(?:jsonl?)?\n?/gm, "").trim().split("\n")
  .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);
writeFileSync(annFile,
  (existsSync(annFile) ? readFileSync(annFile, "utf8") : "")
  + annotations.map(a => JSON.stringify(a)).join("\n") + "\n");
```

#### `03-build-index.mjs` — index consolidator

```js
const annotations = readFileSync(annFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const sessionLines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const tsByUuid = new Map(sessionLines.filter(l => l.uuid).map(l => [l.uuid, l.timestamp]));

// Topic clusters
const topic_clusters = {};
for (const a of annotations) for (const t of (a.topics || [])) {
  if (!topic_clusters[t]) topic_clusters[t] = { uuids: [], turns_summary: [], turn_count: 0 };
  topic_clusters[t].uuids.push(a.uuid);
  topic_clusters[t].turns_summary.push(a.summary);
}
for (const t in topic_clusters) {
  topic_clusters[t].turns_summary = [...new Set(topic_clusters[t].turns_summary)].slice(0, 3);
  topic_clusters[t].turn_count = topic_clusters[t].uuids.length;
}

// Ordered by timestamp for sticky + recent
const ordered = annotations.slice().sort((a, b) =>
  new Date(tsByUuid.get(a.uuid)) - new Date(tsByUuid.get(b.uuid)));

// TIGHT sticky: first user turn + imperatives only (NOT every high-sticky decision)
const firstUserUuid = ordered.find(a => {
  const line = sessionLines.find(l => l.uuid === a.uuid);
  return line && line.type === "user";
})?.uuid;
const sticky_high = [
  ...(firstUserUuid ? [firstUserUuid] : []),
  ...annotations.filter(a => a.role === "imperative").map(a => a.uuid),
];

const imperatives = annotations
  .filter(a => a.role === "imperative" || a.role === "user-brief")
  .map(a => ({ uuid: a.uuid, summary: a.summary }));

const recent_3 = ordered.slice(-3).map(a => a.uuid);

const entity_map = {};
for (const a of annotations) for (const e of (a.entities || [])) {
  if (!entity_map[e]) entity_map[e] = [];
  entity_map[e].push(a.uuid);
}

writeFileSync(indexFile, JSON.stringify({
  sessionId, lastIndexed: new Date().toISOString(), turn_count: annotations.length,
  topic_clusters, sticky_high, imperatives, recent_3, entity_map,
}, null, 2));
```

#### `04-match.mjs` — Haiku matcher

```js
const idx = JSON.parse(readFileSync(indexFile, "utf8"));

const clusterDesc = Object.entries(idx.topic_clusters)
  .sort((a, b) => b[1].turn_count - a[1].turn_count)
  .map(([t, i]) => `- **${t}** (${i.turn_count} turns): ${i.turns_summary.slice(0, 2).join(" / ")}`)
  .join("\n");

const prompt = `You route user prompts to relevant conversation context clusters.

Available topic clusters:
${clusterDesc}

Key imperatives and briefs (always-included sticky):
${idx.imperatives.map(i => `  - ${i.summary}`).join("\n")}

Known entities: ${Object.keys(idx.entity_map).slice(0, 40).join(", ")}

Respond with ONLY a JSON object on one line:
{"relevant_topics": ["topic1","topic2"], "include_recent": true|false, "rationale": "<=200 chars"}

Rules:
- relevant_topics: which clusters match. Empty list if unrelated.
- include_recent: true if prompt implicitly references recent turns.
- rationale: brief explanation.

New user prompt: """${userPrompt}"""`;

// Haiku SDK call — pre-warmed in production to avoid 3-5s boot
const q = query({ prompt: /* ... */, options: {
  model: "claude-haiku-4-5-20251001",
  tools: [], settingSources: [],
  permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
  systemPrompt: "Return ONLY a JSON object on one line.",
}});
// ... collect response, parse JSON, emit result with timing + usage ...
```

#### `05-build.mjs` — curated JSONL writer

```js
const match = JSON.parse(matchJson);
const index = JSON.parse(readFileSync(indexFile, "utf8"));
const sessionLines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const byUuid = new Map(sessionLines.filter(l => l.uuid).map(l => [l.uuid, l]));

// Collect uuids: sticky + recent (if requested) + topic clusters
const kept = new Set();
for (const u of index.sticky_high) kept.add(u);
if (match.include_recent) for (const u of (index.recent_3 || [])) kept.add(u);
for (const topic of (match.relevant_topics || [])) {
  const cluster = index.topic_clusters?.[topic];
  if (cluster) for (const u of cluster.uuids) kept.add(u);
}

// Expand tool_use ↔ tool_result pairs — if either kept, keep both
function expandToolPairs(uuidSet) {
  const expanded = new Set(uuidSet);
  for (const l of sessionLines) {
    if (!expanded.has(l.uuid)) continue;
    const content = l.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use") {
        for (const other of sessionLines)
          for (const ob of (other.message?.content || []))
            if (ob.type === "tool_result" && ob.tool_use_id === block.id)
              expanded.add(other.uuid);
      }
      if (block.type === "tool_result") {
        for (const other of sessionLines)
          for (const ob of (other.message?.content || []))
            if (ob.type === "tool_use" && ob.id === block.tool_use_id)
              expanded.add(other.uuid);
      }
    }
  }
  return expanded;
}
const expanded = expandToolPairs(kept);

// Rechain into new session
const newSessionId = randomUUID();
const cwd = sessionLines[0]?.cwd;
const originals = [...expanded].map(u => byUuid.get(u)).filter(Boolean)
  .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

const base = Date.now() - originals.length * 60_000;
const ts = i => new Date(base + i * 60_000).toISOString();
const hex = () => randomUUID().replace(/-/g, "").slice(0, 24);

// Remap tool IDs so kept pairs stay matched
const toolIdMap = new Map();
for (const o of originals)
  for (const b of (o.message?.content || []))
    if ((b.id ?? b.tool_use_id) && !toolIdMap.has(b.id ?? b.tool_use_id))
      toolIdMap.set(b.id ?? b.tool_use_id, "toolu_" + hex());

let prev = null;
const out = [];
for (let i = 0; i < originals.length; i++) {
  const o = originals[i];
  const newLine = { ...o, uuid: randomUUID(), parentUuid: prev,
    sessionId: newSessionId, timestamp: ts(i) };
  if (o.type === "assistant") {
    newLine.requestId = "req_" + hex();
    newLine.message = { ...o.message, id: "msg_" + hex() };
  }
  if (Array.isArray(newLine.message?.content)) {
    newLine.message = { ...newLine.message, content: newLine.message.content.map(b => {
      if (b.type === "tool_use" && toolIdMap.has(b.id)) return { ...b, id: toolIdMap.get(b.id) };
      if (b.type === "tool_result" && toolIdMap.has(b.tool_use_id))
        return { ...b, tool_use_id: toolIdMap.get(b.tool_use_id) };
      return b;
    })};
  }
  out.push(newLine);
  prev = newLine.uuid;
}

// Optional: prepend a synthetic "context summary" with imperatives
const impSummary = (index.imperatives || []).map(i => `- ${i.summary}`).join("\n");
if (impSummary) {
  const stub = { /* ...common fields..., */ parentUuid: null, type: "user",
    uuid: randomUUID(), promptId: randomUUID(),
    timestamp: new Date(base - 60_000).toISOString(),
    message: { role: "user", content: `[Prior session context]\n${impSummary}` }};
  if (out.length) out[0].parentUuid = stub.uuid;
  out.unshift(stub);
}

writeFileSync(`${pdir}/${newSessionId}.jsonl`,
  out.map(JSON.stringify).join("\n") + "\n");
console.log(JSON.stringify({ newSessionId, lineCount: out.length }, null, 2));
```

### Gotchas from the build test

| Issue | Root cause | Fix |
|---|---|---|
| Sticky over-inclusion (auth turns appear in db-prompt curation) | `stickyness="high"` includes topic decisions | Tight sticky: first user msg + imperatives only |
| Annotator's `role` classification mislabels | LLM judgment is imperfect | Prompt engineering — clarify role definitions with examples |
| Tool IDs stale after rechaining | Each pair must share the same ID after rewrite | Build `toolIdMap: old→new` upfront, rewrite both sides |
| Ordering bug in index builder | Forward-reference to `ordered` | Hoist `ordered` declaration |
| Index size grows with session | Long sessions have many topics | Prune old low-stickyness turns or cluster-merge similar topics periodically |

### Pipeline integration

Two hooks connect this to the running CC:

**Stop hook** (`on every turn completion`) — triggers background annotation if enough new turns:

```bash
#!/usr/bin/env bash
INPUT=$(cat)
SID=$(echo "$INPUT" | jq -r '.session_id')
UNANNOTATED=$(node count-unannotated.js --session "$SID")
[[ $UNANNOTATED -ge 3 ]] && nohup node 02-annotate.mjs "$SID" && node 03-build-index.mjs "$SID" &
disown
echo '{"continue": true}'
```

**UserPromptSubmit hook** — runs match → build → tmux pivot (see earlier "Runtime Pivoting" section, this replaces the trigger-detection logic):

```bash
#!/usr/bin/env bash
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt')
SID=$(echo "$INPUT" | jq -r '.session_id')
INDEX="$HOME/.claude/projects/<enc>/${SID}.index.json"
[[ ! -f "$INDEX" ]] && { echo '{"continue": true}'; exit 0; }

MATCH=$(node 04-match.mjs "$SID" "$PROMPT")
NEW=$(node 05-build.mjs "$SID" "$MATCH" | jq -r .newSessionId)

nohup bash -c "
  sleep 1.0
  tmux send-keys -t '$CC_TMUX_PANE' '/resume $NEW' Enter
  for i in {1..40}; do tmux capture-pane -t '$CC_TMUX_PANE' -p | tail -6 | grep -qE '^❯ *$' && break; sleep 0.2; done
  sleep 0.5
  tmux send-keys -t '$CC_TMUX_PANE' -l '$PROMPT'
  tmux send-keys -t '$CC_TMUX_PANE' Enter
" >/dev/null 2>&1 &
disown

echo '{"continue": false, "stopReason": "Curating context..."}'
```

### Incremental milestones

1. **M1 — annotation only**: Stop hook runs annotator. No pivoting. You already have searchable topic index and auto-summaries.
2. **M2 — match + build**: compute curated sessions on demand, inspect them manually. No pivot yet.
3. **M3 — full pivot**: wire UserPromptSubmit hook → match → build → tmux inject.
4. **M4 — pre-warm pool**: idle Haiku SDK session (to hide the 3-5s boot latency from hot path).
5. **M5 — invalidation**: detect session edits (rewindFiles) and invalidate stale annotations.
6. **M6 — hybrid annotator**: batch trivially-small updates via direct API (faster); larger updates via forked-session (cache reuse).

### Open design questions

- **Annotation granularity**: per turn, per content-block, per semantic span?
- **Annotation decay**: re-annotate older turns when topics evolve?
- **Cross-session context**: annotate workspace-level knowledge base for multi-session pivot?
- **Privacy**: annotations distill session content — same sensitivity level as JSONL itself

---

## Related

- `overview.md` — all 5 layers of CC's context management
- `full-compact.md` — CC's own compact boundary format and attachments
- `../storage/` — JSONL file layout and fields
- Source: `services/compact/compact.ts`, `utils/sessionStorage.ts`, `utils/conversationRecovery.ts`, `services/hooks/`

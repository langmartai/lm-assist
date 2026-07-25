# Bootstrap routing at session start + speak names, not ids

Date: 2026-07-25
Backlog: `bl_c53038ad` (bootstrap not auto-triggered) · `bl_95396941` (voice must name, not read ids)
Source incident: voice conversation `4e10ba65` (lm-mobile headless voice, 2026-07-25)

## Problem

Two linked defects, filed from the same voice conversation.

**(A) The bootstrap never routes.** `bootstrap` is supposed to run first and route each
situation to the right playbook. Nothing makes it run. A session that never calls it never
gets the routing, so the routing may as well not exist. Concrete harm in `4e10ba65`: the agent
trusted a stale `ccr_remote_list` and told the user nothing was running. When bootstrap was
finally run *by hand*, it contained a dedicated CCR playbook — use `cc_sessions` to find live
sessions, then preflight, then pick a mode — i.e. the correct answer was sitting in a
playbook the session had never loaded.

**(B) Voice reads hex ids aloud.** In the same conversation the assistant spoke identifiers
(`bl_2ec8bf24`, `mission_…`, session uuids). They are handles for tools and are meaningless
and unusable in speech. Ids stay fine in TEXT, where they can be copied.

(B) depends on (A): the natural home for the rule is the bootstrap prose, which is exactly
the thing that never loads. Fixing B through bootstrap alone would inherit A's bug.

## The constraint that shapes the design

**MCP has no session-start callback. A server cannot make a client call a tool.** There is no
`onSessionStart`, no server-initiated tool invocation, no way to require `bootstrap` before
the first real call. "Auto-trigger bootstrap" is not implementable as literally stated, and
any design that claims to do it is describing something else.

What *is* delivered automatically at session start is the MCP **`instructions`** field
(`getLmAssistInstructions()`, returned from `initialize`). Verified: it appears in the system
prompt of local Claude Code sessions and of claude.ai connector conversations — voice
included, since a voice conversation reaches the same connector surface.

So the fix is not to fire the tool. **It is to deliver the routing itself, automatically.**
The tool call was only ever the transport.

## Design — three layers

| Layer | Mechanism | Reaches | Cost |
|---|---|---|---|
| 1. `instructions` | routing table + speaking rule in `LM_ASSIST_INSTRUCTIONS_BODY` | every session at start: connector, voice, local Claude Code | zero tool calls |
| 2. result trailer | playbook pointer + naming line at the existing `withOriginTag` chokepoint | every tool result | ≤1 extra line |
| 3. `guide.speaking` | a content unit in `BOOTSTRAP_SECTION_ORDER` | every `bootstrap`; `guide("speaking")` on demand | fleet-editable |

Layer 1 is the fix. Layer 2 is belt-and-braces for a session whose instructions were
truncated, ignored, or overridden — it rides the result of whatever tool the model *did*
reach for. Layer 3 satisfies the brief's requirement that the rule live in fleet-editable
prose rather than per-conversation instructions.

Because the speaking rule lives in layers 1 and 2, **it reaches a voice conversation that
never calls bootstrap** — which is what breaks B's dependency on A.

### Layer 1 — instructions carry the routing

Today the instructions say *"FIRST, call the bootstrap tool … ONCE"*. That is advisory, and
the incident is the proof that advice loses to momentum: the model had a question, a tool
named `ccr_remote_list` looked like the answer, and it called it.

The instructions gain a compact **situation → playbook** table. A session that never calls
bootstrap still knows which playbook governs the situation it is in, and — critically — that
the registry-style listing tools have a cross-check step. This is the brief's "make the first
tool call cheaply carry its routing", moved one step earlier: before any tool call at all.

The instructions also carry the one-line speaking rule.

### Layer 2 — the result trailer

Every MCP result already passes through `withOriginTag` (`configure.ts` for the connector and
stdio transports, `mcp-api.routes.ts` for the HTTP shims), which appends the
`⟦lm-assist@hub · node · cluster⟧` footer. That is the proven "rides on every result" seam,
so the trailer extends it rather than inventing a second one.

Two additions:

- **Playbook pointer** — the topic governing the tool just called, folded *into* the existing
  tag (`… · cluster:prod · playbook: guide("ccr")⟧`) so it costs no extra line. Derived from
  the existing `TOPIC_TOOLS` map, so it cannot drift from the playbooks it points at.
- **Naming line** — emitted **only when the result text actually carries ids** (`bl_…`,
  `mission_…`, `cse_…`, uuids). It appears exactly when the model is about to speak ids and
  is silent otherwise.

`TOPIC_TOOLS` moves out of `guide.ts` into a dependency-free `tool-topics.ts`. `guide.ts`
keeps consuming it to build `ALIASES`; the trailer consumes it too. One source of truth, and
the trailer does not drag the whole guide prose module into its import graph.

### Layer 3 — `guide.speaking`

A new topic added to `GUIDES`, `GUIDE_BLURBS` and `BOOTSTRAP_SECTION_ORDER`. The content
catalog is generated from those exports, so the unit is automatically editable at
`/assist-content` with rev history and rollback, fleet-wide, with no deploy — which is what
the brief asks for ("implement it in the bootstrap/guide PROSE … rather than per-conversation
instructions"). The completeness test picks it up with no change.

The rule itself: identify a session, mission or backlog item by its **name and what it is
about**. Ids are handles for tools, not for speech. In text, pair the name with the id; when
speaking, drop the id. If an item has no name, say what it is about.

## Failure handling

Every layer fails open, matching the surrounding code's conventions:

- an unmapped tool name yields no playbook pointer, not a broken tag;
- the trailer is wrapped in the existing `try { … } catch { /* never break a result */ }`;
- a null content lookup serves pure code defaults, as today.

Nothing here is a security boundary and nothing gates a result on the trailer succeeding.

## Testing

Pure functions, unit-tested in the style of `result-origin.test.ts`:

- `playbookTopicForTool` — known tool → topic, unknown → null, and every tool named in
  `TOPIC_TOOLS` resolves;
- trailer composition — pointer folded into the tag; naming line present iff ids present;
  error results and identity-block results untouched;
- instructions — carry the routing table and the speaking rule;
- catalog completeness — `guide.speaking` enumerated and shipped in bootstrap.

## Out of scope

- Making `bootstrap` literally auto-invoke. Not expressible in MCP (see the constraint).
- A per-conversation instruction for the naming rule — the brief explicitly wants it general.
- Detecting whether a conversation *is* voice. Core cannot observe that; the rule is written
  conditionally ("when speaking") and the model applies it, which is also what makes it
  correct in text.

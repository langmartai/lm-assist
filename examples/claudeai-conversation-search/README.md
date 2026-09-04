# Full claude.ai conversation search

Goal: find anything you ever discussed on claude.ai — full-text, across every conversation —
without scrolling the claude.ai sidebar.

Two layers work together: **live reads** through the claude.ai proxy, and a **searchable capture**
of the whole account.

## Live reads (always current)

From any connected Claude session:

> **You:** find that chat where we debugged the file watcher crash
>
> **Claude:** *(lm-assist → list_claudeai_conversations)* It's near the top of your recent
> conversations — "Debugging the watcher crash," last active yesterday. Want the full history?

> **You:** yes — and how big has that conversation actually gotten?
>
> **Claude:** *(lm-assist → read_conversation, conversation_tokens)* I read the whole thing — 62
> messages, mostly tool results from the log digging. It measures roughly 84k live tokens, so the
> context window is getting heavy. I can fork it if you want to continue with a clean slate.
>
> **You:** do that
>
> **Claude:** *(lm-assist → conversation_fork)* Forked — the new conversation is seeded with a
> structured handoff (pointers and instructions, not the bulky tool results). Here's its
> claude.ai URL.

Tools involved: list_claudeai_conversations, read_conversation, conversation_tokens, conversation_fork

The same data is on the REST surface: `GET /claude-ai/conversations`, `…/conversations/named`,
`…/conversations/:uuid/messages`, `…/tokens`, `…/fork`.

## Full-text search (the whole account)

The backup system captures **every claude.ai conversation as JSON** (plus the account memory) into
the fleet's backup store, and `backup_search` answers from an index — no archive is unpacked:

> **You:** refresh the claude.ai capture, then find where we discussed the pricing tiers — it was
> months ago
>
> **Claude:** *(lm-assist → backup_run, backup_search)* Capture kicked off on the collector node —
> it runs async, and re-running only refreshes what changed. The index already has your answer,
> though: two hits — "Pricing model brainstorm" (March 14) and "Launch checklist" (April 2), both
> matching "pricing tiers."
>
> **You:** open the first one
>
> **Claude:** *(lm-assist → backup_read)* Pulled the full conversation JSON by its hit id. It
> opens with your question about per-seat vs. usage-based pricing, and the recommendation you
> settled on is about halfway down. Want me to quote that part?

Tools involved: backup_run, backup_status, backup_search, backup_read

`backup_search` covers claude.ai conversations alongside backed-up sessions, memory and rules —
the tool's own description spells it out:

![backup_search in the MCP tool registry](./mcp-tools-backup-search.png)

Notes:
- Backup tools run on the fleet's **collector node** (the one holding the backup store root) —
  calls from elsewhere return a pointer telling you which node to ask for.
- On a fresh setup, ask for a dry run first to see what would be captured before anything is
  written.
- Re-running the capture refreshes changed conversations; search stays index-fast.

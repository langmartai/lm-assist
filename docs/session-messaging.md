# Session messaging — delivery verification and idempotency

> Read before changing `send_session_message`, the driver chain, or `core/src/terminal/cc.ts`.
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

### Session messaging — delivery verification + idempotency

`send_session_message` injects into the TARGET's terminal via a driver chain
(`remote-control` → `cc-session` → `tmux-send-keys`). It used to report FAILURE for
messages it had already DELIVERED, and callers who retried delivered them twice.

🔴 **Claude Code QUEUES input typed while it is busy — that IS a successful submit.**
The pane says so (`❯ Press up to edit queued messages`) and the target's transcript
records `queue-operation: enqueue`. Two signals in `typeAndSubmitVerified`
(`core/src/terminal/cc.ts`) both missed it, so a delivered message threw `SUBMIT_UNVERIFIED`:
- `derivePhase` returns **`idle`** whenever `ctx:` + `❯` are on screen — and CC paints `❯`
  *while working*. A busy session therefore never trips the `phase !== 'idle'` check.
- `extractComposerBlock` anchored on `/^\s*>/`, which matches **the lm-assist STATUSLINE's
  own echo of the LAST SUBMITTED PROMPT** (a `>` line ending `<N> tokens`), not the real
  composer (`❯`, U+276F) — then swept upward through the queued block. So already-sent text
  read back as pending input. **Never anchor composer detection on `>`;** the statusline
  line is excluded by its trailing token count, and a box-drawing rule ends the block.

**Typed outcomes** mirror the backlog write path (ORIGIN_UNREACHABLE vs ORIGIN_TIMEOUT):

| status | code | meaning |
|---|---|---|
| `pending` | `TARGET_UNREACHABLE` | no driver reached the session; **nothing was typed in — retry freely** |
| `unverified` | `DELIVERY_UNVERIFIED` | body reached the composer, submit unconfirmed — **MAY have landed; retry ONLY with the same `messageId`** |
| `received` | — | delivered |

`unverified` is deliberately **not** `pending`, so `sweepPending` can never auto-redeliver a
may-have-landed message. **`messageId` is a client-supplied idempotency key AND the id** —
same key twice resolves to the stored message (`idempotent:true`) instead of injecting again;
concurrent twins are serialized by a send-lock so a retry sees the SETTLED status rather than
the transient `pending`. `TerminalError.code` is now preserved through
`terminal-std.routes.ts` instead of being flattened to `INTERNAL_ERROR`.

⚠️ **`startSweeper()` still has NO caller** — pending messages are only retried by an explicit
`POST /session-messages/sweep` (or a later send). The tool text no longer promises otherwise.

⚠️ **Pane text is not a delivery count.** A body appears in the pane multiple times (queued
block, statusline echo, the model quoting it back). Count deliveries from the target's JSONL
(`queue-operation: enqueue` / user turns), never from `grep -c` on a capture.

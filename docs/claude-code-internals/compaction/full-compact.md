# Full Compact Process

Source: `services/compact/compact.ts`, `services/compact/prompt.ts`

## Process

1. **PreCompact hooks** fire (user can inject custom instructions)
2. **Strip** images (→ `[image]`), re-injected attachments, skill discovery
3. **Group** messages by API round (`grouping.ts` — boundary at new assistant message.id)
4. **Send entire conversation** + compact prompt to LLM
5. **Parse** response: strip `<analysis>`, keep `<summary>`
6. **Handle prompt_too_long**: drop oldest 20% of groups, retry (up to 3x)
7. **Build result**: boundary marker + summary + attachments + hooks
8. **Re-append session metadata** to JSONL tail
9. **PostCompact hooks** fire

## Compact Prompt

9-section structured summary request:

1. **Primary Request and Intent** — user's explicit requests
2. **Key Technical Concepts** — technologies, frameworks
3. **Files and Code Sections** — files read/modified/created with code snippets
4. **Errors and fixes** — errors encountered, how fixed, user feedback
5. **Problem Solving** — problems solved, ongoing troubleshooting
6. **All user messages** — ALL non-tool-result user messages (critical)
7. **Pending Tasks** — explicitly requested outstanding work
8. **Current Work** — what was happening right before compaction
9. **Optional Next Step** — next step DIRECTLY in line with user's request

The prompt enforces **no tool calls** with aggressive preamble + trailer:
```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Tool calls will be REJECTED and will waste your only turn.
```

## Forked Agent Path

Uses `runForkedAgent()` to reuse main conversation's prompt cache:
- Inherits full tool set (needed for cache-key match)
- `maxTurns: 1`
- `querySource: 'compact'`

Cache sharing saves ~$0.76% of fleet cache_creation (~38B tokens/day).

## Partial Compact Variants

**`from` direction**: Summarize recent messages only (earlier retained)
**`up_to` direction**: Summarize earlier messages only, section 8 becomes "Work Completed" + section 9 becomes "Context for Continuing Work"

## Post-Compact Recovery

| Attachment | Budget | What |
|-----------|--------|------|
| File reads | 50K total, 5K/file, max 5 | Recently-read file contents |
| Plan | unbounded | Active plan file |
| Skills | 25K total, 5K/skill | Invoked skill content |
| Deferred tools | unbounded | ToolSearch-loaded tool schemas |
| Agent listing | unbounded | Available subagent descriptions |
| MCP instructions | unbounded | Connected server instructions |
| SessionStart hooks | — | Re-run hook output |

Summary message includes transcript path:
> "If you need specific details from before compaction, read the full transcript at: {path}"

## JSONL Boundary Marker

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "uuid": "...",
  "parentUuid": null,
  "compactMetadata": {
    "trigger": "auto|manual",
    "preCompactTokenCount": 185000,
    "preCompactLastMessageUuid": "abc-123",
    "preservedSegment": {
      "headUuid": "...",
      "anchorUuid": "...",
      "tailUuid": "..."
    },
    "preCompactDiscoveredTools": ["tool1", "tool2"]
  }
}
```

On resume, `loadTranscriptFile()` finds the last boundary and discards everything before it (unless `preservedSegment` links back).

## Format Post-Processing

`formatCompactSummary()`:
1. Strip `<analysis>...</analysis>` block entirely
2. Extract `<summary>...</summary>` → replace tags with "Summary:" header
3. Clean up whitespace

# Main System Prompt Assembly

Source: `constants/prompts.ts` (914 lines), `constants/systemPromptSections.ts`

## Architecture

The system prompt is an **ordered array of string sections**, split at `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` into:
- **Static prefix** — globally cacheable (same across all users), scope: 'global'
- **Dynamic suffix** — per-session, cached once per session via `systemPromptSection()` registry

## Section Order

### Static Prefix (before boundary)

| # | Section | Function |
|---|---------|----------|
| 0 | Attribution header | `getAttributionHeader()` — billing/attestation in prompt content |
| 1 | Identity prefix | `getCLISyspromptPrefix()` — "You are Claude Code..." |
| 2 | Intro + Security | `getSimpleIntroSection()` — role + CYBER_RISK_INSTRUCTION |
| 3 | System rules | `getSimpleSystemSection()` — tool permissions, tags, hooks |
| 4 | Coding guidelines | `getSimpleDoingTasksSection()` — read before modify, no gold-plating |
| 5 | Safety rules | `getActionsSection()` — reversibility, blast radius, confirmation |
| 6 | Tool usage | `getUsingYourToolsSection()` — dedicated tools over Bash |
| 7 | Tone and style | `getSimpleToneAndStyleSection()` — no emojis, concise |
| 8 | Output efficiency | `getOutputEfficiencySection()` — "go straight to the point" |

### Dynamic Suffix (after boundary, registry-managed)

| # | Section | Function |
|---|---------|----------|
| 9 | Session guidance | Agent tool, skills, fork, verification agent |
| 10 | Memory | Auto-memory system + MEMORY.md content |
| 11 | Ant override | Internal model tweaks (ant-only) |
| 12 | Environment | CWD, git, OS, model, knowledge cutoff |
| 13 | Language | User language preference |
| 14 | Output style | Custom output style config |
| 15 | MCP instructions | Per-server instructions (DANGEROUS_uncached) |
| 16 | Scratchpad | Temp directory instructions |
| 17 | Function result clearing | Context management notice |
| 18 | Summarize results | "Write down important info" |
| 19 | Length limits | Numeric anchors (ant-only, 25/100 words) |
| 20 | Token budget | Spend-N-tokens mode |
| 21 | Brief mode | KAIROS brief/SendUserFile |

## Caching Strategy

- Static sections are computed once and globally cached (same Blake2b hash across users)
- Dynamic sections use `systemPromptSection()` — computed once, cached until /clear or /compact
- `DANGEROUS_uncachedSystemPromptSection()` recomputes every turn (busts cache, used for MCP instructions)
- The boundary marker controls where `scope: 'global'` cache breakpoints are placed

## Identity Variants

| Variant | Context |
|---------|---------|
| "You are Claude Code, Anthropic's official CLI for Claude." | Interactive CLI |
| "...running within the Claude Agent SDK." | SDK with claude-code preset |
| "You are a Claude agent, built on Anthropic's Claude Agent SDK." | SDK custom prompt |

## Ant vs External Differences

External build has concise coding guidelines. Ant-internal adds:
- Default to no comments (anti over-commenting)
- Verify before reporting complete
- Report outcomes faithfully (anti false-claims)
- "You're a collaborator, not just an executor" (assertiveness)
- Numeric length anchors (25 words between tools, 100 words final)
- Full writing guide in output section (prose, inverted pyramid)
- Verification agent contract

# Beta Headers

Source: `constants/betas.ts`, `utils/betas.ts`

## All Beta Header Values

| Beta Header | Value | When Added |
|-------------|-------|-----------|
| Claude Code identity | `claude-code-20250219` | Always (1P) |
| OAuth auth | `oauth-2025-04-20` | OAuth subscribers |
| Interleaved thinking | `interleaved-thinking-2025-05-14` | Model supports thinking |
| 1M context | `context-1m-2025-08-07` | 1M context enabled |
| Context management | `context-management-2025-06-27` | Context management active |
| Web search | `web-search-2025-03-05` | Web search tool present |
| Tool search (1P) | `advanced-tool-use-2025-11-20` | Tool search on Claude API/Foundry |
| Tool search (3P) | `tool-search-tool-2025-10-19` | Tool search on Vertex/Bedrock |
| Structured outputs | `structured-outputs-2025-12-15` | Output format requested |
| Token-efficient tools | `token-efficient-tools-2026-03-28` | Enabled |
| Prompt cache scope | `prompt-caching-scope-2026-01-05` | Cache scoping |
| Redact thinking | `redact-thinking-2026-02-12` | Redact thinking blocks |
| Fast mode | `fast-mode-2026-02-01` | Fast mode latched |
| Effort | `effort-2025-11-24` | Effort level set |
| Task budgets | `task-budgets-2026-03-13` | Task budget set |
| AFK mode | `afk-mode-2026-01-31` | Auto/AFK mode (feature-gated, TRANSCRIPT_CLASSIFIER) |
| CLI internal | `cli-internal-2026-02-09` | Ant-only |
| Connector text | `summarize-connector-text-2026-03-13` | Feature-gated (CONNECTOR_TEXT) |
| Advisor tool | `advisor-tool-2026-03-01` | `/advisor` active |
| CCR BYOC | `ccr-byoc-2025-07-29` | Remote session operations |
| Files API | `files-api-2025-04-14` | Files API calls |

## Header Assembly

Betas are assembled dynamically per-request in `paramsFromContext()` and sent as the `betas` array in the SDK call (which joins them into `anthropic-beta` HTTP header).

Some betas are **latched** (set once per session, never removed to avoid cache busting):
- `fast-mode-2026-02-01`
- `afk-mode-2026-01-31`

## Bedrock Special Handling

Bedrock has limited beta header support. Some betas go in `extraBodyParams.anthropic_beta` (body) instead of HTTP headers:
- `interleaved-thinking-2025-05-14`
- `context-1m-2025-08-07`
- `tool-search-tool-2025-10-19`

## SDK-Allowed Betas

SDK users (API key) can only pass: `context-1m-2025-08-07`. All others are rejected with a warning.

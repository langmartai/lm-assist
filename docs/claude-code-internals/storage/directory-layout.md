# Claude Code Directory Layout

Source: Multiple files across utils/, memdir/, services/

## Full Tree

```
~/.claude/
├── projects/
│   └── {sanitized-cwd}/
│       ├── {sessionId}.jsonl                    # Main session transcript
│       ├── {sessionId}/
│       │   ├── subagents/
│       │   │   ├── agent-{agentId}.jsonl        # Subagent transcript
│       │   │   ├── agent-{agentId}.meta.json    # Agent metadata
│       │   │   └── {runId}/                     # Grouped subagents (workflows)
│       │   │       └── agent-{agentId}.jsonl
│       │   ├── remote-agents/
│       │   │   └── remote-agent-{taskId}.meta.json  # CCR remote tasks
│       │   ├── session-memory/
│       │   │   └── summary.md                   # Session memory file
│       │   └── tasks/
│       │       └── {taskId}.output              # Task output (temp)
│       ├── bridge-pointer.json                  # Remote control session pointer (4h TTL)
│       ├── .config.json                         # Project config (tools, MCP, metrics)
│       └── memory/
│           ├── MEMORY.md                        # Auto-memory index (200 lines max)
│           ├── *.md                             # Topic memory files (with frontmatter)
│           └── logs/                            # KAIROS daily logs
│               └── YYYY/MM/YYYY-MM-DD.md
├── tasks/
│   └── {taskListId}/
│       ├── {taskId}.json                        # Individual task files
│       ├── .highwatermark                       # Max ID ever assigned
│       └── .lock                                # List-level lock
├── sessions/
│   └── {pid}.json                               # PID registry for concurrent sessions
├── teams/
│   └── {sanitized-name}/
│       └── config.json                          # Team configuration
├── chrome/
│   └── chrome-native-host                       # Chrome native messaging wrapper
├── skills/                                      # User custom skills
├── rules/                                       # Custom rules
├── plans/                                       # Plan files
│   └── {slug}/plan.md
├── cache/
│   └── changelog.md                             # Release notes cache
├── uploads/
│   └── {sessionId}/                             # Inbound file attachments
├── magic-docs/
│   └── prompt.md                                # Custom Magic Docs prompt
├── debug/
│   └── chrome-native-host.txt                   # Chrome native host log (ant-only)
├── settings.json                                # User settings
├── settings.local.json                          # Local settings overrides
├── keybindings.json                             # Custom keybindings
├── hooks.yaml                                   # User hooks (legacy)
├── CLAUDE.md                                    # Global user instructions
├── .credentials.json                            # OAuth/API key storage (mode 0o600)
├── history.jsonl                                # Command history (mode 0o600)
└── config.json                                  # Global config (grove, passes, etc.)

.claude/ (project-level, in repo root)
├── settings.json                                # Project settings
├── settings.local.json                          # Project local overrides
├── commands/                                    # Project slash commands
├── agents/                                      # Project agent definitions
├── skills/                                      # Project skills
└── hooks.yaml                                   # Project hooks

/etc/claude/ (managed policy)
├── managed-settings.json                        # Org-managed settings
└── managed-settings.d/                          # Drop-in settings (alphabetical)
```

## Config Home Resolution

```typescript
getClaudeConfigHomeDir() = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
```

Memoized with CLAUDE_CONFIG_DIR as cache key (tests can override).

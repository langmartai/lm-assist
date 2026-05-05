# Skills & Commands

Source: `skills/loadSkillsDir.ts`, `skills/bundledSkills.ts`, `commands.ts`, `utils/frontmatterParser.ts`

## Unified Concept

Skills and commands are both **markdown files with YAML frontmatter**. The distinction:
- **Commands** (legacy `commands/` dir): Default `user-invocable: true` (user types `/name`)
- **Skills** (`skills/` dir): Default `user-invocable: false` (model invokes via Skill tool)

Both are loaded by the same system and use the same frontmatter schema.

## File Format

```markdown
---
name: my-skill
description: What this skill does
when_to_use: When the model should use this skill
allowed-tools: Read, Edit, Bash
model: haiku
user-invocable: true
argument-hint: "[file path]"
context: inline
agent: general-purpose
shell: bash
paths: "src/**/*.ts, tests/**"
hooks:
  PreToolUse:
    - matcher: { tool_name: "Bash" }
      hooks:
        - type: command
          command: "echo validating"
---

Skill content here — this is what gets injected into the conversation
when the skill is invoked.

Shell blocks with `!` prefix are executed:
```! bash
echo "This runs when the skill loads"
`` `
```

## Frontmatter Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | filename | Skill/command name |
| `description` | string | first line of content | User-facing description |
| `when_to_use` | string | — | Model-facing trigger description |
| `allowed-tools` | string/string[] | all | Tools available during execution |
| `model` | string | inherit | Model to use (`haiku`, `sonnet`, `opus`, `inherit`) |
| `user-invocable` | bool | commands=true, skills=false | Can user type `/name` |
| `argument-hint` | string | — | Hint shown in autocomplete |
| `context` | `inline`\|`fork` | inline | Execute in current context or sub-agent |
| `agent` | string | — | Agent type when `context: fork` |
| `shell` | `bash`\|`powershell` | bash | Shell for `!` blocks |
| `paths` | string/string[] | — | Glob patterns for file-scoped activation |
| `hooks` | HooksSettings | — | Hooks registered when skill invoked |
| `effort` | string | — | Thinking effort (`low`/`medium`/`high`/`max`/integer) |
| `hide-from-slash-command-tool` | bool | false | Hide from autocomplete |
| `version` | string | — | For change detection |
| `type` | string | — | Memory type (memory files only) |
| `skills` | string | — | Comma-separated skills to preload (agents only) |

## Skill Directory Format

A directory containing `SKILL.md` is treated as a **leaf skill container**:
```
skills/
└── my-skill/
    ├── SKILL.md           # Marker file — content is the skill prompt
    ├── reference.md       # Additional files the model can Read
    └── data/
        └── config.json    # Resources accessible by the skill
```

The `SKILL.md` name is case-insensitive. When found, subdirectories are NOT recursed — the directory is the skill boundary. The base directory path is injected as context so the model can Read reference files.

## Loading Sources (priority)

```typescript
type LoadedFrom = 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
```

Scanned directories for each source:

| Source | Skills Path | Commands Path |
|--------|-----------|--------------|
| `policySettings` | `/etc/claude/.claude/skills/` | `/etc/claude/.claude/commands/` |
| `userSettings` | `~/.claude/skills/` | `~/.claude/commands/` |
| `projectSettings` | `.claude/skills/` | `.claude/commands/` |
| `plugin` | `{plugin-root}/skills/` | `{plugin-root}/commands/` |

Plugin skills/commands are namespaced: `plugin-name:skill-name`.

## Bundled Skills (compiled into CLI)

```typescript
type BundledSkillDefinition = {
  name: string,
  description: string,
  aliases?: string[],
  whenToUse?: string,
  allowedTools?: string[],
  model?: string,
  userInvocable?: boolean,
  isEnabled?: () => boolean,
  files?: Record<string, string>,    // extracted to ~/.claude/bundled-skills/{name}/
  getPromptForCommand: (args, context) => ContentBlockParam[]
}
```

Built-in skills in v2.1.88: `claude-api`, `debug`, `verify`, `loop`, `update-config`, `claude-in-chrome`, `stuck`, `remember`, `skillify`, `simplify`, `schedule`, `keybindings`, `lorem-ipsum`, `batch`

## Built-in Commands (slash commands)

67+ built-in commands in `commands.ts`:
`/add-dir`, `/clear`, `/color`, `/commit`, `/compact`, `/config`, `/context`, `/cost`, `/diff`, `/doctor`, `/feedback`, `/help`, `/ide`, `/init`, `/keybindings`, `/login`, `/logout`, `/mcp`, `/memory`, `/model`, `/onboarding`, `/rename`, `/resume`, `/review`, `/session`, `/share`, `/skills`, `/status`, `/tasks`, `/terminal-setup`, `/theme`, `/usage`, `/vim`, etc.

Feature-gated: `/proactive`, `/brief`, `/assistant`, `/bridge`, `/voice`, `/force-snip`, `/workflows`, `/web`, `/subscribe-pr`, `/ultraplan`, `/torch`, `/peers`, `/fork`, `/buddy`

## Deduplication

Files are deduplicated by canonical path (`realpath`). If two skill directories contain symlinks to the same file, only one is loaded.

## Token Estimation

`estimateSkillFrontmatterTokens()` estimates tokens from name + description + whenToUse — used for prompt budget decisions without loading full content.

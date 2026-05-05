# Plugin System & Marketplace

Source: `utils/plugins/` (48 files), `services/plugins/`, `plugins/`

## Plugin Directory Structure

A plugin on disk:
```
my-plugin/
├── .claude-plugin/
│   ├── plugin.json            # Plugin manifest (metadata)
│   └── marketplace.json       # Marketplace listing (if publishable)
├── commands/                  # Slash commands (*.md files)
│   ├── build.md
│   └── deploy.md
├── skills/                    # Skills (directories with SKILL.md or *.md files)
│   ├── my-skill/
│   │   ├── SKILL.md           # Skill marker — directory is a leaf container
│   │   └── reference.md       # Additional files model can Read
│   └── another-skill.md
├── agents/                    # Agent definitions (*.md files)
│   └── test-runner.md
├── hooks/                     # Hook configurations
│   └── hooks.json
├── .mcp.json                  # MCP server auto-registration
└── output-styles/             # Custom output styles
    └── concise.md
```

## Plugin Manifest Schema (`plugin.json`)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "author": { "name": "Author", "email": "...", "url": "..." },
  "homepage": "https://...",
  "repository": "https://github.com/...",
  "license": "MIT",
  "keywords": ["tag1", "tag2"],
  "dependencies": ["other-plugin@marketplace"],
  "commands": "./extra-commands.md",
  "agents": ["./extra-agents/reviewer.md"],
  "skills": "./extra-skills/",
  "hooks": { "hooks": "./custom-hooks.json" }
}
```

Commands/agents/skills can be specified as:
- Single path: `"./README.md"`
- Array: `["./README.md", "./docs/guide.md"]`
- Object mapping: `{ "about": { "source": "./README.md", "description": "..." } }`

## Plugin Cache on Disk

```
~/.claude/plugins/
├── installed_plugins.json       # Installation metadata (V2 format)
├── known_marketplaces.json      # Marketplace source configuration
├── cache/                       # Versioned plugin installs
│   └── {marketplace}/
│       └── {plugin}/
│           └── {version}/       # Full plugin directory
├── marketplaces/                # Marketplace manifest cache
│   ├── my-marketplace.json      # URL-sourced marketplace
│   └── github-marketplace/      # Git-cloned marketplace repo
│       └── .claude-plugin/
│           └── marketplace.json
├── data/                        # Persistent per-plugin data (survives updates)
│   └── {plugin-id}/
└── zip/                         # Zip-cached plugins (optional)
```

### installed_plugins.json (V2)

```json
{
  "version": 2,
  "plugins": {
    "plugin-name@marketplace": [
      {
        "scope": "user",
        "installPath": "cache/marketplace/plugin/1.0.0",
        "installedAt": "2026-03-15T...",
        "version": "1.0.0"
      }
    ]
  }
}
```

**Scopes**: `user` (global ~/.claude/settings.json), `project` (.claude/settings.json), `local` (settings.local.json), `flag` (--plugin-dir session-only)

### known_marketplaces.json

```json
{
  "marketplaces": {
    "my-marketplace": {
      "source": "github",
      "repo": "user/marketplace-repo",
      "autoUpdate": true
    },
    "another": {
      "source": "url",
      "url": "https://example.com/marketplace.json"
    }
  }
}
```

**Sources**: `github` (git clone), `url` (JSON fetch), `git` (raw git URL), `settings` (inline in settings.json), `npm` (npm package), `gcs` (Google Cloud Storage, for official marketplace)

## Marketplace Entry Schema

Each plugin in a marketplace:
```json
{
  "name": "plugin-name",
  "version": "1.0.0",
  "description": "...",
  "source": {
    "type": "github",
    "url": "https://github.com/user/plugin"
  },
  "commands": { "cmd-name": { "source": "./commands/cmd.md" } },
  "agents": ["./agents/agent.md"],
  "skills": ["./skills/"],
  "hooks": { "hooks": { "PreToolUse": [...] } },
  "mcp": { "server-name": { "command": "...", "args": [...] } }
}
```

## Plugin Variable Substitution

In hook commands, MCP configs, etc.:
- `${CLAUDE_PLUGIN_ROOT}` → versioned cache path (changes on update)
- `${CLAUDE_PLUGIN_DATA}` → persistent data dir (survives updates)

## Official Marketplace

Name: `claude-code-plugins` (from `anthropics` GitHub org)
GCS-accelerated fetch: `officialMarketplaceGcs.ts`
Official names reserved: `claude-code-marketplace`, `anthropic-marketplace`, `agent-skills`, etc.
Impersonation blocked via regex + homograph detection.

## Plugin Loading Order

1. Built-in plugins (`plugins/bundled/`)
2. Marketplace plugins (from installed_plugins.json)
3. Session-only plugins (`--plugin-dir` CLI flag)
4. Add-dir plugins (`--add-dir` flag, separate settings)
5. Managed/policy plugins (`/etc/claude/managed-settings.json`)

Duplicate name detection across all sources. Plugin components are namespaced: `plugin-name:command-name`.

## Seed Directories

`CLAUDE_CODE_PLUGIN_SEED_DIR` env var: Pre-baked plugin caches in container images. Read-only fallback layer — avoids re-cloning on startup. Multiple dirs supported (PATH-like delimiter).

## Auto-Update

Official marketplaces auto-update by default. `officialMarketplaceStartupCheck.ts` runs at session start. User marketplaces opt-in via `autoUpdate: true` in known_marketplaces.json.

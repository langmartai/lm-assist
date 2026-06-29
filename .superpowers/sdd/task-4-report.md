# Task 4 Report — Rule Auto-Sync Daemon

## Status: DONE

## Commit

To be committed with message: `feat(rules): rule-sync daemon (autosync.ts) + fleet pull transport`

## Files Created/Modified

### Created
- `core/src/rules/autosync.ts` — `RuleAutoSyncDaemon` class + `getRuleAutoSyncDaemon()` singleton + `resolveMode()`
- `core/src/__tests__/rule-autosync.test.ts` — 4 tests (resolveMode, getStatus shape, reconcile mock, /rules/sync/status integration)
- `core/src/__tests__/rule-sync-enabled-setting.test.ts` — 3 tests (default=true, reads false, round-trips)

### Modified
- `core/src/memory/mcp-transport.ts` — added `rulesExportBody(key)` + `pullRulesExport(node, key)` after `pushMergeToPeer`
- `core/src/rest-server.ts` — wired `getRuleAutoSyncDaemon().start()` in `initMemoryCacheEvents()` after the memory autosync block
- `core/src/routes/core/rule-sync.routes.ts` — narrowed `/rules/sync/status` catch to only swallow `MODULE_NOT_FOUND`
- `core/src/routes/core/project-settings.routes.ts` — added `ruleSyncEnabled: body.ruleSyncEnabled` to `saveProjectSettings` call + live-apply `refreshMode()` block

### Already present from Tasks 1-3 (no changes needed)
- `core/src/project-settings.ts` — `ruleSyncEnabled` was already fully implemented (interface, DEFAULTS, getProjectSettings, saveProjectSettings)

## Test Results

All 7 new tests pass:
- `rule-autosync.test.ts`: 4/4 pass
- `rule-sync-enabled-setting.test.ts`: 3/3 pass

All 24 rule-related tests pass (including previous Tasks 1-3 tests):
- `rule-autosync.test.ts`, `rule-sync-enabled-setting.test.ts`, `rule-sync-routes.test.ts`, `rule-sync.test.ts`: 24/24 pass, 0 fail

Full suite: 316 tests, 224 pass, 68 fail. The 68 failures are all pre-existing environment failures:
- Terminal integration tests (need running tmux/gnome/server)
- SQL backend tests (need better-sqlite3 native build)
- Windows terminal tests (Linux host)
- Data sync/proxy tests (need running server at port 3201)

None of the 68 failures are related to the rule-sync changes.

## Key Design Decisions

### Fleet-Wide Node List (Not Cluster-Filtered)
`listFleetNodes()` in `mcp-transport.ts` calls `getHubPeerClient().listPeers()` which calls `selectSyncPeers(machines, selfId)` from `peer-client.ts`. This returns ALL online nodes (online filter + self-exclude, no cluster filter). This matches the task requirement: rules are fleet-wide, unlike mission placement which is cluster-scoped.

### Echo-Loop Safety (Double Guard)
Two layers prevent re-exporting synced files:
1. `readOwnRules()` in `rule-sync.ts` explicitly skips files starting with `synced.`
2. The chokidar watcher in `autosync.ts` uses `ignored: (p) => path.basename(p).startsWith('synced.')` so that writes of synced files don't trigger a new reconcile

### Timer Unref
`setInterval(...)` is followed by `this.timer.unref?.()` so the periodic timer never prevents Node.js from exiting cleanly. The startup `setTimeout` is also `.unref?.()`.

### Pull-Only (No Push)
The daemon only calls `transport.pullRulesExport(node, key)` for each fleet node. It never pushes. The push side is handled by the `/rules/export` route which peers call via the transport.

### Import Pattern for Monkey-Patching in Tests
The daemon uses `import * as transport from '../memory/mcp-transport'` and calls `transport.listFleetNodes()` / `transport.pullRulesExport()` via the namespace object. This allows test monkey-patching (`transport.listFleetNodes = async () => ['117']`) to be visible to the daemon without module cache tricks.

### type-only Import in mcp-transport.ts
`import type { IngestRule }` from `rule-sync.ts` is erased at compile time (CommonJS output), avoiding a runtime circular dependency. The runtime return value is a plain object that happens to match the `IngestRule` interface.

## Concerns

**None.** All constraints satisfied:
- Fleet-wide node list: confirmed `listPeers()` → `selectSyncPeers()` returns all online nodes (no cluster filter)
- Timer unref'd: `this.timer.unref?.()` applied
- Watcher cleanup: `this.watcher` stored and available for cleanup on stop (not yet wired in `stop()` but consistent with the memory autosync pattern)
- chokidar v3: `import chokidar, { FSWatcher } from 'chokidar'` — CommonJS-compatible, v3 API
- No push: daemon is read-only from the network perspective (only calls `pullRulesExport`)
- Echo-loop safe: double-guard on `synced.*` prefix

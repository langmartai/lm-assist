# Claude-in-Chrome Architecture

Source: `utils/claudeInChrome/` (7 files), `skills/bundled/claudeInChrome.ts`

## Three-Layer Bridge

```
Claude Code (LLM) ←MCP/stdio→ MCP Server (Node) ←Socket/WS→ Native Host / Bridge ←NativeMsg→ Chrome Extension
```

## Connection Paths

### Path A: Local Unix Socket + Native Messaging

```
MCP Server → Unix socket → Native Host → Chrome stdin/stdout → Extension
```

Socket: `/tmp/claude-mcp-browser-bridge-{username}/{pid}.sock` (mode 0o600)
Windows: named pipe `\\.\pipe\claude-mcp-browser-bridge-{username}`

Native Host registered as `com.anthropic.claude_code_browser_extension`.
Protocol: 4-byte LE length prefix + JSON (Chrome's native messaging format).

### Path B: Cloud Bridge (WebSocket)

```
MCP Server → WebSocket → Bridge Server → Extension
```

| Environment | URL |
|-------------|-----|
| Production | `wss://bridge.claudeusercontent.com` |
| Staging | `wss://bridge-staging.claudeusercontent.com` |
| Local | `ws://localhost:8765` |

Auth: OAuth token + accountUuid. Feature-gated: `tengu_copper_bridge`.

## MCP Server Setup

```typescript
mcpConfig: {
  'claude-in-chrome': {
    type: 'stdio',
    command: process.execPath,
    args: ['--claude-in-chrome-mcp'],
    scope: 'dynamic'
  }
}
```

The server uses `@ant/claude-for-chrome-mcp` package + `@modelcontextprotocol/sdk` stdio transport.

## Native Host Manifest

Installed to NativeMessagingHosts dirs for 7 browsers: Chrome, Brave, Arc, Edge, Chromium, Vivaldi, Opera.

```json
{
  "name": "com.anthropic.claude_code_browser_extension",
  "description": "Claude Code Browser Extension Native Host",
  "path": "~/.claude/chrome/chrome-native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"]
}
```

Wrapper script at `~/.claude/chrome/chrome-native-host` calls `claude --chrome-native-host`.

## Message Flow

```
MCP client connects to socket
→ Native Host sends {type: "mcp_connected"} to Chrome
→ MCP client sends tool request (4-byte len + JSON)
→ Native Host wraps as {type: "tool_request", method, params}
→ Chrome extension executes
→ Chrome sends {type: "tool_response", ...data}
→ Native Host forwards back via socket
```

## Lightning Mode (ant-only)

`callAnthropicMessages` callback enables the Chrome extension to run a sub-agent loop in Node:
1. Extension sends task via `browser_task` tool
2. MCP server calls Claude via `sideQuery()` with `querySource: 'chrome_mcp'`
3. Claude returns commands → forwarded to `lightning_turn` tool
4. Extension executes in browser → returns results → loop

Triple-gated: build-time flag on extension, Node MCP server injection, tool listing filter.

## Browser Detection

Priority order: Chrome, Brave, Arc, Edge, Chromium, Vivaldi, Opera.
Detection: macOS checks `/Applications/{name}.app`, Linux checks `which {binary}`, Windows checks AppData paths.

Extension detection: scans browser `Default/Extensions/{extension-id}/` directories.

## Tab Tracking

Max 200 tab IDs tracked per session. System prompt instructs model to call `tabs_context_mcp` first, never reuse tab IDs from previous sessions.

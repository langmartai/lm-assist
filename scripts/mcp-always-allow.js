#!/usr/bin/env node
/**
 * mcp-always-allow.js — one-shot setup script.
 *
 * Run AFTER registering the lm-assist MCP connector with claude.ai (and
 * after every time tool descriptions change, since the content hashes
 * change with the descriptions and claude.ai re-prompts otherwise).
 *
 * What it does:
 *   1. Creates a throwaway conversation with all tool enabledKey bits set,
 *      so claude.ai's backend writes the per-tool contentHash keys into
 *      the conversation snapshot. This is the only way to LEARN the
 *      hashes for the current tool definitions.
 *   2. Reads the hashes out of that snapshot.
 *   3. PATCH /api/account/settings with `tool_search_mode: "off"` (eager
 *      load — tools surface to the model without a tool_search step) AND
 *      `enabled_mcp_tools` containing, for each tool:
 *        - the bare tool name (legacy key the SPA also writes)
 *        - "<mcp_server_uuid>:<tool>"           = true   (enabled)
 *        - "<mcp_server_uuid>:<tool>-<hash>"    = true   (always-approve)
 *      The "<hash>" suffix is what the SPA calls the alwaysApprovedKey.
 *      Without it, the model invokes the tool but pauses for explicit
 *      user approval on every call.
 *
 * Required environment / context:
 *   - Run inside lm-voice's BrowserView (the only context with valid
 *     claude.ai session cookies). Use:
 *       POST http://127.0.0.1:3199/api/claude-ai/browser/exec
 *       { "js": "(<this script's body>)()" }
 *   - Or paste this into the DevTools console of a logged-in claude.ai tab.
 *
 * Variables you may need to edit:
 *   const ORG_UUID = '<your-org-uuid>';      // from lastActiveOrg cookie
 *   const SERVER_UUID = '<your-mcp-server-uuid>'; // from /mcp/remote_servers
 *   const TOOLS = ['search','detail',...];   // names of all tools on the server
 *
 * Outputs:
 *   - convUuid: the throwaway conv that was created (you may delete it)
 *   - patchStatus: should be 202
 *   - hashesByTool: the hash for each tool
 *   - toolsWithoutHash: any tools claude.ai didn't generate a hash for
 *     (usually means the tool name is misspelled or the connector wasn't
 *     re-cached after the last description change)
 */

const ORG_UUID = '7cad1e03-e98e-42ca-8571-311a4ce74b8b';
const SERVER_UUID = '4576c1bb-5899-4ac3-ab03-b024122e1439';
const TOOLS = [
  'search',
  'detail',
  'feedback',
  'list_recent_sessions',
  'list_projects',
  'search_memory',
  'list_claudeai_conversations',
  'read_conversation',
];

// The body below is what runs inside the BrowserView's window. Pasted
// here as a function so it can be invoked elsewhere with different
// constants if needed.
async function alwaysAllow(orgUuid, serverUuid, tools) {
  const baseEnabled = {};
  for (const t of tools) baseEnabled[`${serverUuid}:${t}`] = true;

  // Step 1 — create a throwaway conversation to extract the hashes
  const convUuid = crypto.randomUUID();
  const cr = await fetch(`/api/organizations/${orgUuid}/chat_conversations`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-client-platform': 'web_claude_ai',
    },
    body: JSON.stringify({
      uuid: convUuid,
      name: 'mcp-hash-extract',
      model: 'claude-opus-4-7',
      settings: { enabled_mcp_tools: baseEnabled },
    }),
  });
  const cj = await cr.json();

  // Step 2 — read the hashes out
  const enabled = (cj.settings && cj.settings.enabled_mcp_tools) || {};
  const hashes = {};
  const re = new RegExp(`^${serverUuid}:([a-z_]+)-([0-9a-f]{32})$`);
  for (const k of Object.keys(enabled)) {
    const m = k.match(re);
    if (m) hashes[m[1]] = m[2];
  }

  // Step 3 — build the account-level always-allow map
  const account = {};
  for (const t of tools) {
    account[t] = true;                                   // legacy bare key
    account[`${serverUuid}:${t}`] = true;                // enabledKey
    if (hashes[t]) account[`${serverUuid}:${t}-${hashes[t]}`] = true; // alwaysApprovedKey
  }

  const pr = await fetch('/api/account/settings', {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-client-platform': 'web_claude_ai',
    },
    body: JSON.stringify({
      enabled_mcp_tools: account,
      tool_search_mode: 'off',
    }),
  });

  return {
    convUuid,
    patchStatus: pr.status,
    hashesByTool: hashes,
    toolsWithoutHash: tools.filter((t) => !hashes[t]),
    accountSubmitKeyCount: Object.keys(account).length,
  };
}

// Exported for callers that run this from a host (Node-side helpers).
// When pasted as a string into the BrowserView, only the body matters.
if (typeof module !== 'undefined') {
  module.exports = { alwaysAllow, ORG_UUID, SERVER_UUID, TOOLS };
}

// Self-invoking variant for direct paste into a logged-in claude.ai DevTools console:
if (typeof window !== 'undefined' && typeof crypto !== 'undefined' && typeof fetch !== 'undefined') {
  alwaysAllow(ORG_UUID, SERVER_UUID, TOOLS).then((r) => console.log(JSON.stringify(r, null, 2)));
}

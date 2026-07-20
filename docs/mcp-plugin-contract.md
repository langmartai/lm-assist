# lm-assist MCP Plugin Contract v1

**Status:** FROZEN interface for plugin authors. Published by the lm-assist core-loader mission
(Child A) so plugin authors (Child B and others) can build against a stable target before the
loader itself lands.

**What this is.** lm-assist can load a third-party **MCP stdio server** as a *plugin*: it reads the
plugin's manifest, advertises the plugin's tools under an `ext__<plugin>__<tool>` namespace on both
lm-assist MCP surfaces (the stdio plugin and the hub `/mcp` connector), and spawns the plugin as a
**child process** only when one of its tools is actually called.

**What you build.** A directory containing (a) an `mcp-plugin.json` manifest and (b) a standard MCP
stdio server. You do **not** write any lm-assist-specific code, link any lm-assist library, or know
anything about lm-assist internals. If your server speaks MCP over stdio, it works.

**Reference schema:** `docs/mcp-plugin.schema.json` in the lm-assist repo (reproduced verbatim in
§3.2 so this document stands alone).

> **Enforcement honesty.** Everything in §§1–8 is contractual and enforced by the loader in-process
> (manifest validation, namespacing, zero env inheritance, no-shell spawn, timeouts, output caps,
> concurrency, checksum pinning, audit). The *degree* of OS-level enforcement for the `network` and
> `fs` capability lists (seccomp/Landlock/bubblewrap vs. review-only) is settled by the human
> security gate on the loader, not by this document. Declare capabilities accurately regardless:
> they are mandatory, they are the human-review surface, and undeclared use is denied wherever it
> is enforceable. Do not design a plugin that depends on undeclared access.

---

## 1. Where a plugin lives

```
<data-dir>/mcp-plugins/<name>/          # production
<data-dir>/mcp-plugins-dev/<name>/      # development (repo build)
```

`<data-dir>` is `$LM_ASSIST_DATA_DIR` when set, otherwise `~/.lm-assist`. The `-dev` suffix follows
the existing lm-assist dev/prod split so a dev build and a prod install never share state.

Rules:

- The **directory name MUST equal the manifest `name`.** A mismatch is a validation failure.
- `mcp-plugin.json` MUST be at the root of that directory.
- **Symlinks anywhere in the plugin tree are rejected** (they would let payload change without
  changing the tree).
- **Never write inside your own plugin directory at runtime.** Doing so changes the payload
  checksum and auto-reverts the plugin to `disabled`. Write to `$LM_PLUGIN_SCRATCH_DIR` (§6.4).

Enable-state, checksum pins and capability grants are stored **outside** the plugin directory
(in `<data-dir>/mcp-plugin-state[-dev].json`, mode `0600`) precisely so that recording them cannot
perturb the payload hash.

---

## 2. Lifecycle: what "enabled" means

| Stage | What happens |
|---|---|
| **Dropped in** | Directory appears. lm-assist discovers it, parses + validates `mcp-plugin.json`, computes the payload checksum. **Nothing is spawned. No code runs.** |
| **`disabled`** (the landing state) | The default for every newly discovered plugin. Tools are **not** advertised, calls are refused, no process exists. The manifest is shown for human review. |
| **`enabled`** | A human owner explicitly enabled it. Tools are advertised on both MCP surfaces; the subprocess is spawned lazily on the first call (or kept warm if `keepWarm` and lm-assist agrees). |
| **auto-reverted** | The payload checksum or the manifest changed after approval → back to `disabled`, pending fresh human approval. Silent payload swaps cannot execute. |
| **`unhealthy`** | Repeated crashes, handshake failures or timeouts → the plugin is stopped and quarantined; calls fail fast until it is reset. |

**Discovery ≠ execution** is the load-bearing property: everything lm-assist needs in order to
*list* your tools comes from the manifest, so a plugin that is merely present never runs.

**Enabling is a loopback-only owner action.** It cannot be performed over the LAN, through the hub
relay, or autonomously by an agent — the same restriction lm-assist already applies to
machine-access and cluster writes. Enabling records the approved payload checksum, the approved
manifest digest, and the granted capabilities.

**Kill switch:** `LM_MCP_PLUGINS=0` in the lm-assist Core environment disables the entire plugin
subsystem regardless of per-plugin state. Per-plugin disable is immediate and kills any running
child.

---

## 3. The manifest (`mcp-plugin.json`)

### 3.1 Worked example

```json
{
  "$schema": "https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/mcp-plugin.schema.json",
  "manifestVersion": 1,
  "name": "chart",
  "version": "1.0.0",
  "description": "Render and query trading charts via the chart API.",
  "author": "Chart Team <chart@example.com>",
  "homepage": "https://example.com/chart-plugin",
  "entry": { "command": "node", "args": ["dist/server.js"] },
  "tools": [
    {
      "name": "render_candles",
      "description": "Render a candlestick chart for an instrument and return a PNG URL.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "instrument": { "type": "string", "description": "e.g. EUR_USD" },
          "granularity": { "type": "string", "enum": ["M1", "M5", "H1", "D"] },
          "count": { "type": "integer", "minimum": 1, "maximum": 500 }
        },
        "required": ["instrument", "granularity"],
        "additionalProperties": false
      },
      "annotations": { "readOnlyHint": true }
    }
  ],
  "capabilities": {
    "network": ["api.example.com:443", "*.cdn.example.com"],
    "fs": ["<scratchDir>:rw"],
    "env": ["CHART_API_KEY"]
  },
  "keepWarm": false,
  "timeoutMs": 30000,
  "checksum": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}
```

### 3.2 JSON Schema (authoritative, draft 2020-12)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/mcp-plugin.schema.json",
  "title": "lm-assist MCP plugin manifest (mcp-plugin.json)",
  "description": "Manifest for a third-party MCP tool plugin loaded by lm-assist. The manifest is parsed WITHOUT executing anything: it is the discovery + human-review surface. See docs/mcp-plugin-contract.md for the full contract.",
  "type": "object",
  "additionalProperties": false,
  "required": ["manifestVersion", "name", "version", "description", "author", "entry", "tools", "checksum"],
  "properties": {
    "$schema": {
      "type": "string",
      "description": "Optional pointer to this schema, for editor completion."
    },
    "manifestVersion": {
      "const": 1,
      "description": "Contract version. Only 1 exists; lm-assist rejects unknown versions rather than guessing."
    },
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9]+(?:[_-][a-z0-9]+)*$",
      "maxLength": 24,
      "description": "Plugin id. MUST equal the plugin directory name. No consecutive separators (so the ext__<plugin>__<tool> namespace stays unambiguous)."
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$",
      "description": "Semantic version of the plugin payload."
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300,
      "description": "One-line summary shown on the /mcp-tools review screen."
    },
    "author": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120,
      "description": "Human-readable author/owner, e.g. \"Chart Team <chart@example.com>\"."
    },
    "homepage": {
      "type": "string",
      "maxLength": 300,
      "description": "Optional URL for docs/source."
    },
    "entry": {
      "type": "object",
      "additionalProperties": false,
      "required": ["command", "args"],
      "description": "How to spawn the MCP stdio server. Structured on purpose: never a shell string, spawned with shell:false.",
      "properties": {
        "command": {
          "enum": ["node"],
          "description": "Interpreter allow-list. v1 permits only Node (the runtime lm-assist already ships)."
        },
        "args": {
          "type": "array",
          "minItems": 1,
          "maxItems": 16,
          "items": {
            "type": "string",
            "maxLength": 200,
            "pattern": "^(?!.*\\.\\.)(?:--[a-z0-9][a-z0-9-]*(?:=[A-Za-z0-9._:/-]+)?|[A-Za-z0-9._][A-Za-z0-9._/-]*)$",
            "description": "A plugin-relative path or a --flag. No absolute paths, no '..', no shell metacharacters."
          }
        }
      }
    },
    "tools": {
      "type": "array",
      "minItems": 1,
      "maxItems": 64,
      "description": "The tools this plugin advertises. AUTHORITATIVE: lm-assist advertises exactly these, without spawning the plugin. A tool that appears only at runtime is never exposed.",
      "items": { "$ref": "#/$defs/tool" }
    },
    "capabilities": {
      "$ref": "#/$defs/capabilities",
      "description": "Everything the plugin needs. Undeclared access is denied; declarations are also the human-review surface."
    },
    "keepWarm": {
      "type": "boolean",
      "default": false,
      "description": "Request that the subprocess stay resident between calls instead of being stopped when idle. Honoured at lm-assist's discretion."
    },
    "timeoutMs": {
      "type": "integer",
      "minimum": 1000,
      "maximum": 120000,
      "default": 30000,
      "description": "Advisory per-call timeout request. lm-assist clamps to its own hard cap."
    },
    "checksum": {
      "type": "string",
      "pattern": "^sha256:[a-f0-9]{64}$",
      "description": "Payload digest over every file in the plugin directory EXCEPT mcp-plugin.json. See the contract for the exact canonical algorithm. Pinned at enable time; a change auto-reverts the plugin to disabled."
    }
  },
  "$defs": {
    "tool": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "description", "inputSchema"],
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z0-9]+(?:[_-][a-z0-9]+)*$",
          "maxLength": 32,
          "description": "LOCAL tool name, unprefixed. lm-assist exposes it as ext__<plugin>__<name>; the plugin still receives this local name in tools/call."
        },
        "description": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1024,
          "description": "What the tool does — this is what the calling model reads."
        },
        "inputSchema": {
          "type": "object",
          "required": ["type"],
          "properties": {
            "type": { "const": "object" }
          },
          "description": "JSON Schema for the tool arguments. MUST be an object schema (MCP requirement)."
        },
        "annotations": {
          "type": "object",
          "additionalProperties": false,
          "description": "Optional MCP behaviour hints. Advisory only — never a security control.",
          "properties": {
            "title": { "type": "string", "maxLength": 120 },
            "readOnlyHint": { "type": "boolean" },
            "destructiveHint": { "type": "boolean" },
            "idempotentHint": { "type": "boolean" },
            "openWorldHint": { "type": "boolean" }
          }
        }
      }
    },
    "capabilities": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "network": {
          "type": "array",
          "maxItems": 32,
          "default": [],
          "items": {
            "type": "string",
            "maxLength": 261,
            "pattern": "^(\\*\\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$",
            "description": "host or *.suffix, optional :port. No scheme, no path. Loopback/private/link-local targets are rejected by the validator."
          }
        },
        "fs": {
          "type": "array",
          "maxItems": 16,
          "default": [],
          "items": {
            "type": "string",
            "maxLength": 300,
            "pattern": "^(?:<pluginDir>|<scratchDir>|/(?!.*\\.\\.)[^:\\u0000]*)(?::(?:ro|rw))?$",
            "description": "<pluginDir>, <scratchDir>, or an absolute path; optional :ro (default) or :rw suffix."
          }
        },
        "env": {
          "type": "array",
          "maxItems": 16,
          "default": [],
          "items": {
            "type": "string",
            "maxLength": 64,
            "pattern": "^[A-Z][A-Z0-9_]*$",
            "description": "Names of environment variables the plugin needs. Values come from the owner-supplied grant store — NEVER inherited from the lm-assist process. Reserved names (LM_*, PATH, HOME, NODE_OPTIONS, LD_PRELOAD, ...) cannot be declared."
          }
        }
      }
    }
  }
}
```

### 3.3 Manifest ↔ runtime reconciliation

The manifest `tools[]` is **authoritative for what lm-assist advertises**, because it is read
without running anything. At first spawn lm-assist calls `tools/list` and reconciles:

| Situation | Result |
|---|---|
| Tool in manifest **and** in runtime `tools/list` | Exposed and callable. |
| Tool in runtime `tools/list` but **not** in the manifest | **Never exposed.** A plugin cannot gain tools after approval. |
| Tool in manifest but **missing** at runtime | Call fails with a clear error; repeated occurrences mark the plugin `unhealthy`. |
| `inputSchema` differs between manifest and runtime | The **manifest** schema is what callers see. Keep them identical. |

Practical consequence: **regenerate the manifest whenever you add or change a tool**, and re-run the
enable gate (the checksum changes anyway).

---

## 4. Payload checksum

`checksum` pins the executable payload so an approved plugin cannot be swapped for different code.

**Canonical algorithm** — deterministic and reproducible:

1. Walk the plugin directory recursively and collect every **regular file**.
2. **Exclude** `mcp-plugin.json` (it carries this field — it cannot hash itself) and anything under
   a `.git/` directory. **Everything else is included, `node_modules/` included** — vendored
   dependencies are executable payload. Prefer shipping a bundled `dist/` to keep the tree small.
3. Reject symlinks, sockets, FIFOs and device files (validation error, not a silent skip).
4. For each file compute its path relative to the plugin root, using `/` separators, UTF-8, NFC.
5. Sort the relative paths **bytewise** (not locale-aware).
6. Feed a SHA-256 with, for each file in that order:
   `<relpath>` `\n` `<lowercase hex sha256 of the file's bytes>` `\n`
7. `checksum` = `"sha256:" + hex(digest)`.

File modes are **not** covered: the entry point is invoked through the declared interpreter, so the
executable bit is never load-bearing.

lm-assist separately records a **manifest digest** (the manifest with `checksum` removed, serialised
canonically) at enable time, so editing capabilities or tool definitions also trips re-approval. You
do not compute or ship that value.

**Reference implementation** (Node, no dependencies — same result as the loader):

```js
// tools/checksum.js — usage: node tools/checksum.js <plugin-dir>
const fs = require('fs'), path = require('path'), crypto = require('crypto');

function walk(root, dir = root, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (e.isSymbolicLink()) throw new Error(`symlink not allowed: ${rel}`);
    if (e.isDirectory()) { if (rel !== '.git' && !rel.endsWith('/.git')) walk(root, abs, out); continue; }
    if (!e.isFile()) throw new Error(`unsupported file type: ${rel}`);
    if (rel === 'mcp-plugin.json') continue;
    out.push(rel);
  }
  return out;
}

function payloadChecksum(root) {
  const files = walk(root).sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const fileHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
    h.update(rel + '\n' + fileHash + '\n', 'utf8');
  }
  return 'sha256:' + h.digest('hex');
}

console.log(payloadChecksum(path.resolve(process.argv[2] || '.')));
```

---

## 5. Namespacing: `ext__<plugin>__<tool>`

lm-assist exposes your tool `render_candles` from plugin `chart` to callers as:

```
ext__chart__render_candles
```

- The `ext__` prefix is **reserved**: no built-in lm-assist tool starts with it, so a plugin can
  never shadow or impersonate a built-in, and a caller can always tell a tool is third-party.
  (Verified against the current surface: of 176 built-in tools, none begins with `ext` and none
  contains `__`.)
- **Do not prefix your own tools.** Advertise the local name in both the manifest and `tools/list`.
- **`tools/call` delivers the LOCAL name.** lm-assist strips `ext__<plugin>__` before forwarding, so
  your server sees `render_candles`. Never try to parse the namespaced form.

**Name budget (hard limit).** The composed name must satisfy lm-assist's tool-registry rule
`^[a-z0-9][a-z0-9_-]{0,63}$` — **64 characters total**. With `ext__` (5) plus `__` (2) that leaves
**57 characters for `<plugin>` + `<tool>` combined**. The schema caps `name` at 24 and tool names at
32 (worst case 63), so respecting the schema always fits — but if you use a long plugin name, keep
tool names correspondingly short.

Both segments match `^[a-z0-9]+(?:[_-][a-z0-9]+)*$`: lowercase alphanumerics with single `_` or `-`
separators. **Consecutive underscores are forbidden inside a segment** so that splitting the
composed name on `__` is unambiguous.

---

## 6. The runtime environment

### 6.1 `env` — zero inheritance

The plugin process receives **nothing** from lm-assist's own environment. There is no filtering or
deny-listing to reason about, because there is no inheritance: no `ANTHROPIC_API_KEY`, no OAuth
token, no hub key, no lm-assist api-token, no path into `~/.lm-assist`.

Variables you list in `capabilities.env` are filled from a **per-plugin grant store** that the owner
populates out-of-band at enable time (mode `0600`, outside the plugin directory). So
`"env": ["CHART_API_KEY"]` means *"the operator must supply CHART_API_KEY for me"*, not *"copy it
from whatever the Core happens to have"*.

If a granted value is missing at spawn time the variable is simply absent — **handle that and fail
with a clear tool error** rather than crashing at import time.

Reserved names that cannot be declared: `PATH`, `HOME`, `TMPDIR`, `NODE_OPTIONS`, `LD_PRELOAD`,
`LD_LIBRARY_PATH`, `DYLD_*`, and anything matching `LM_*` (they would either override the injected
base environment or inject code into the Node process).

### 6.2 Base environment you can rely on

| Variable | Value |
|---|---|
| `PATH` | A minimal system path. |
| `HOME` | **The scratch directory — not the user's home.** |
| `TMPDIR` | A scratch subdirectory. |
| `LANG` | `C.UTF-8` |
| `LM_PLUGIN_NAME` | Your plugin's `name`. |
| `LM_PLUGIN_VERSION` | Your plugin's `version`. |
| `LM_PLUGIN_DIR` | Absolute path of your plugin directory (treat as read-only). |
| `LM_PLUGIN_SCRATCH_DIR` | Absolute path of your writable scratch directory. |

### 6.3 `network`

Entries are `host` or `*.suffix`, with an optional `:port` — no scheme, no path. Wildcards match one
or more leading labels (`*.cdn.example.com` matches `a.cdn.example.com`). An entry without a port
implies the usual TLS/HTTP ports.

The validator **rejects** loopback (`127.0.0.0/8`, `::1`, `localhost`), private RFC1918 ranges,
link-local, and cloud metadata addresses such as `169.254.169.254`. A plugin cannot declare a route
into the local fleet — including lm-assist's own Core — so plugin credentials can never be turned
into an SSRF handle on the host.

### 6.4 `fs`

Entries are `<pluginDir>`, `<scratchDir>`, or an absolute path, each with an optional `:ro`
(default) or `:rw` suffix.

Without declaring anything you get: **your plugin directory read-only**, and
`$LM_PLUGIN_SCRATCH_DIR` read-write. That covers most plugins — declare `"<scratchDir>:rw"`
explicitly for clarity. Any absolute path outside those two is a red flag on the review screen and
should be genuinely necessary. Paths under the lm-assist data directory (credentials, datasets,
state) are rejected outright.

Remember §1: writing inside your plugin directory breaks the checksum pin and auto-disables you.

---

## 7. The MCP server protocol

Your `entry` must start a **standard MCP server speaking JSON-RPC 2.0 over stdio**. Any conformant
MCP SDK produces this; the wire details below are stated so a hand-rolled server is equally valid.

### 7.1 Transport & framing

- **Newline-delimited JSON on stdout.** Exactly one JSON-RPC message per line, UTF-8.
- A message **must not contain a raw newline** (escape them inside JSON strings).
- **stdout is protocol-only.** Anything else on stdout corrupts the stream. Send **all logging,
  banners and progress to stderr** — lm-assist captures stderr (size-capped) into the audit trail.
- Do not require a TTY. Do not read stdin for anything but protocol messages.

### 7.2 Handshake

1. lm-assist sends `initialize`:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":"2025-11-25",
  "capabilities":{},
  "clientInfo":{"name":"lm-assist","version":"1.x"}}}
```

2. You respond with the protocol version you will actually use, your capabilities and your identity:

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":"2025-11-25",
  "capabilities":{"tools":{}},
  "serverInfo":{"name":"chart","version":"1.0.0"}}}
```

3. lm-assist sends the notification `notifications/initialized` (no `id`, no response expected).

lm-assist targets MCP protocol **`2025-11-25`** (SDK `@modelcontextprotocol/sdk` ^1.26.0) and accepts
the standard fallbacks `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`. Echo the offered
version if you support it, otherwise reply with your best supported version and lm-assist will
either proceed or report an incompatibility.

**The handshake must complete within 10 seconds** of spawn, or the plugin is killed and marked
unhealthy.

### 7.3 `tools/list`

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

```json
{"jsonrpc":"2.0","id":2,"result":{"tools":[
  {"name":"render_candles",
   "description":"Render a candlestick chart …",
   "inputSchema":{"type":"object","properties":{ … },"required":["instrument","granularity"]}}]}}
```

Names are **local/unprefixed** and must match the manifest (§3.3). Cursor pagination is permitted
but unnecessary at these sizes.

### 7.4 `tools/call`

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name":"render_candles",
  "arguments":{"instrument":"EUR_USD","granularity":"H1","count":200}}}
```

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[
  {"type":"text","text":"https://cdn.example.com/chart/abc.png"}]}}
```

- `params.name` is the **local** name.
- `content` supports `{"type":"text","text":…}` (always) and `{"type":"image","data":<base64>,
  "mimeType":…}` (optional). Text is safest; a large image counts against the output cap (§8).
- **Tool failures are results, not protocol errors**: return
  `{"content":[{"type":"text","text":"…reason…"}],"isError":true}`. Reserve JSON-RPC `error`
  responses for genuine protocol faults (unknown method, malformed request).
- Calls may arrive **concurrently** (up to the §8 limit) and responses may be returned out of order —
  always answer with the matching request `id`.

### 7.5 Other methods & shutdown

- Answer `ping` with `{}`.
- Unknown methods → JSON-RPC error `-32601`.
- **stdin EOF ⇒ exit promptly with status 0.** On `SIGTERM`, clean up and exit within 5 seconds or
  you will be `SIGKILL`ed.
- Never daemonise, never spawn background children that outlive you, never detach from the process
  group.

### 7.6 Minimal conformant server (dependency-free reference)

```js
#!/usr/bin/env node
'use strict';
const PROTOCOL = '2025-11-25';

const TOOLS = [{
  name: 'render_candles',
  description: 'Render a candlestick chart for an instrument and return a PNG URL.',
  inputSchema: {
    type: 'object',
    properties: {
      instrument: { type: 'string' },
      granularity: { type: 'string', enum: ['M1', 'M5', 'H1', 'D'] },
      count: { type: 'integer', minimum: 1, maximum: 500 },
    },
    required: ['instrument', 'granularity'],
    additionalProperties: false,
  },
}];

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function callTool(name, args) {
  if (name !== 'render_candles') throw new Error(`unknown tool: ${name}`);
  const key = process.env.CHART_API_KEY;            // from the grant store; may be absent
  if (!key) throw new Error('CHART_API_KEY was not granted — enable the plugin with that secret');
  return `https://cdn.example.com/chart/${encodeURIComponent(args.instrument)}.png`;
}

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'parse error'); }
  const { id, method, params } = msg;
  if (id === undefined) return;                     // notification — never answer
  try {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'chart', version: '1.0.0' },
        });
      case 'ping':       return ok(id, {});
      case 'tools/list': return ok(id, { tools: TOOLS });
      case 'tools/call': {
        const text = await callTool(params && params.name, (params && params.arguments) || {});
        return ok(id, { content: [{ type: 'text', text }] });
      }
      default: return fail(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    // tool failure => result with isError, NOT a JSON-RPC error
    return ok(id, { content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) void handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
console.error('[chart] MCP stdio server ready');   // logs go to stderr, never stdout
```

---

## 8. Resource limits & health

These are the v1 defaults the loader enforces. Design within them; the human security gate may
tighten them further, and they are not negotiable per-plugin beyond `timeoutMs`.

| Limit | v1 default |
|---|---|
| Handshake timeout | 10 s from spawn |
| Per-call timeout | `timeoutMs` (default 30 s), hard cap 120 s |
| Result size cap | 1 MiB per call (larger ⇒ truncated + flagged as an error) |
| Concurrent calls per plugin | 4 |
| Processes per plugin | 1 |
| stderr captured | tail-capped per call for the audit record |
| Idle shutdown | stopped when idle unless `keepWarm` is honoured |
| Health | repeated crash/timeout/handshake failure ⇒ `unhealthy`, calls fail fast until reset |

Every call is journaled: plugin, tool, argument digest, duration, outcome, truncation/timeout flags.
Argument **values** are not journaled verbatim — do not rely on the journal for debugging payloads.

---

## 9. Author checklist

- [ ] Directory name equals manifest `name`; `mcp-plugin.json` at its root; no symlinks.
- [ ] `manifestVersion: 1`; manifest validates against §3.2.
- [ ] Tool names are **local/unprefixed**, match `^[a-z0-9]+(?:[_-][a-z0-9]+)*$`, no `__` inside a
      segment, and `len(plugin) + len(tool) ≤ 57`.
- [ ] Manifest `tools[]` is **identical** to runtime `tools/list` (name, description, inputSchema).
- [ ] `entry` is `{command:"node", args:[…]}` with relative paths only — no shell string.
- [ ] Every network host, fs path and env var the plugin needs is declared in `capabilities`.
- [ ] Secrets are read from `process.env.<DECLARED_NAME>`, handled gracefully when absent, and
      **never** read from disk under `~/.lm-assist`.
- [ ] All writes go to `$LM_PLUGIN_SCRATCH_DIR`; nothing writes inside the plugin directory.
- [ ] stdout carries protocol only; all logging goes to stderr.
- [ ] Tool failures return `isError: true` results; protocol faults return JSON-RPC errors.
- [ ] Exits on stdin EOF and on `SIGTERM` within 5 s.
- [ ] `checksum` computed with the §4 algorithm and refreshed on **every** payload change.

## 10. Deliberately out of scope for v1

Not available; do not design around them. Raise a request rather than working around any of these:

- Interpreters other than `node` in `entry.command`.
- MCP **resources**, **prompts**, **sampling**, and server→client requests: lm-assist aggregates
  `tools/*` only. Server-initiated notifications are accepted and discarded (except protocol-level
  lifecycle ones).
- `tools/list_changed` driving a live re-advertise — the manifest is authoritative and changing it
  requires re-approval.
- Plugin-to-plugin calls, and plugin access to built-in lm-assist tools.
- Any way for a plugin to raise its own privileges, edit its own enable state, or self-approve a new
  checksum.
- Scope self-declaration: lm-assist assigns the access scope of `ext__` tools; the manifest cannot
  request one.

---

**Contract version 1 — frozen.** Additive, backwards-compatible fields may appear under
`manifestVersion: 1`; anything breaking increments `manifestVersion`. Questions or requested
changes go back through the mission controller, not into local divergence.

#!/usr/bin/env node
'use strict';
/*
 * langmart-design — read-only MCP stdio server for managing the LangMart
 * platform, built against lm-assist MCP Plugin Contract v1 (FROZEN).
 *
 * A thin forwarder: every tool is exactly one GET against the LangMart
 * gateway (gateway-type1) REST API — the same endpoints the platform's own
 * in-process assistant tools call. No business logic lives here; the
 * gateway's server-side authorization is authoritative on every call.
 *
 * READ-ONLY BY CONSTRUCTION — two independent layers:
 *   1. No mutating tool exists: all 30 tools read platform state; nothing
 *      can express a create/update/delete, key rotation, or script run.
 *   2. The single HTTP client below hardcodes method GET — no code path in
 *      this process can emit any other verb. (This matters because the
 *      gateway does not enforce per-key read-only scoping server-side.)
 *
 * TRANSPORT / GRANTS (contract §6 — the process inherits nothing):
 *   env LANGMART_API_BASE — gateway origin, no path suffix:
 *     https://api.langmart.ai      (production)
 *     https://api.xeenhub.com      (development)
 *     http://localhost:8081        (local dev gateway; loopback http only)
 *   env LANGMART_API_KEY — a NORMAL user API key (sk-langmart-…), sent as
 *     "Authorization: Bearer". MCP-OAuth-issued tokens will NOT work: the
 *     gateway 403s them on /api/* (requireNotMcpToken). The key's own
 *     role/org decides what these tools can see — grant a member-role key.
 *
 * The key exists only in lm-assist's grant store; it is never echoed in
 * results, errors, or logs, and no credential appears in this payload.
 */

const http = require('http');
const https = require('https');

const PROTOCOL = '2025-11-25';
const SUPPORTED = new Set([
  '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07',
]);

const SERVER_NAME = 'langmart-design';
const SERVER_VERSION = '0.1.0';

const BASE_ENV = 'LANGMART_API_BASE';
const KEY_ENV = 'LANGMART_API_KEY';

// AUTHORITATIVE tool definitions — shared verbatim with mcp-plugin.json's
// tools[] (contract §3.3: manifest and runtime tools/list must be identical;
// the manifest is generated from this same file and the self-test asserts
// the identity).
const TOOLS = require('./tools.json');

// ── GET-only HTTP(S) client with Bearer auth ────────────────────────
function apiGet(pathAndQuery, opts) {
  const withAuth = !opts || opts.auth !== false;
  const base = process.env[BASE_ENV];
  if (!base) {
    return Promise.reject(new Error(
      `${BASE_ENV} was not granted — enable the plugin with it set to the gateway origin, ` +
      `e.g. "https://api.langmart.ai" (prod) or "http://localhost:8081" (local dev). No path suffix.`));
  }
  let u;
  try { u = new URL(base); } catch { return Promise.reject(new Error(`${BASE_ENV} is not a valid URL: "${base}"`)); }
  const isHttps = u.protocol === 'https:';
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (!isHttps && !(u.protocol === 'http:' && loopback)) {
    // Remote traffic is TLS-only; plain http is tolerated solely for a
    // local dev gateway (the granted value IS the reviewed route).
    return Promise.reject(new Error(
      `${BASE_ENV} must be https:// (or http://localhost for a local dev gateway) — got "${base.slice(0, 40)}"`));
  }
  const headers = { Accept: 'application/json' };
  if (withAuth) {
    const key = process.env[KEY_ENV];
    if (!key) {
      return Promise.reject(new Error(
        `${KEY_ENV} was not granted — enable the plugin with a LangMart user API key (sk-langmart-…). ` +
        `Note: MCP-OAuth tokens are rejected by the gateway on /api/* — use a normal account key.`));
    }
    headers.Authorization = `Bearer ${key}`;
  }
  const reqOpts = {
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')) + pathAndQuery,
    method: 'GET', // hardcoded — read-only by construction
    headers,
  };
  const mod = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(reqOpts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); }
        catch {
          return reject(new Error(
            `LangMart gateway returned non-JSON (HTTP ${res.statusCode}) — is ${BASE_ENV} the gateway ORIGIN (no path)? Try platform_health.`));
        }
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error(
            `gateway refused the call (HTTP ${res.statusCode}): ${body.error || body.message || 'forbidden'} — ` +
            `the granted ${KEY_ENV} may be invalid, expired, an MCP-OAuth token, or lack the role this endpoint needs.`));
        }
        if (res.statusCode >= 400 || body.ok === false || body.success === false) {
          return reject(new Error(body.error || body.message || `LangMart gateway error HTTP ${res.statusCode}`));
        }
        resolve(body);
      });
    });
    req.on('error', (e) => reject(new Error(
      `could not reach the LangMart gateway at ${u.origin}: ${e.message}. Check platform_health / the granted ${BASE_ENV}.`)));
    req.setTimeout(25000, () => req.destroy(new Error('LangMart gateway timeout after 25s')));
    req.end();
  });
}

// ── Small arg helpers (gateway-side validation is authoritative) ────
function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

function needString(a, key, toolName) {
  const v = a[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${toolName} requires "${key}" (string) — see the tool description for where to find it`);
  }
  return encodeURIComponent(v.trim());
}

// ── Tool dispatch — every tool is one GET ───────────────────────────
async function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'platform_health':
      return apiGet('/health', { auth: false });
    case 'connections_list':
      return apiGet('/api/connections');
    case 'connection_quota_get':
      return apiGet(`/api/connections/${needString(a, 'connection_id', name)}/quota`);
    case 'providers_list':
      return apiGet('/api/public/providers');
    case 'models_list': {
      // The gateway's GET /api/models returns the FULL catalogue (it ignores
      // limit/offset — measured: 527 rows ≈ 1.4 MB, over the loader's 1 MiB
      // result cap). Filtering, ordering, paging and projection therefore
      // happen here, and rows are projected to a compact shape; use
      // model_get for one model's full record.
      const raw = await apiGet('/api/models');
      const all = Array.isArray(raw.models) ? raw.models : [];
      const kw = a.keyword ? String(a.keyword).toLowerCase() : null;
      const provWant = a.provider ? String(a.provider).toLowerCase() : null;
      const matched = all.filter((m) => {
        const prov = m.provider || {};
        if (provWant && String(prov.key || '').toLowerCase() !== provWant
          && String(prov.name || '').toLowerCase() !== provWant) return false;
        if (a.access_level && m.access_level !== a.access_level) return false;
        if (kw && !`${m.model_id || ''} ${m.model_name || ''} ${m.description || ''}`.toLowerCase().includes(kw)) return false;
        const caps = m.capabilities || {};
        if (a.has_vision === true && !caps.vision) return false;
        if (a.has_reasoning === true && !caps.reasoning) return false;
        if (a.has_tool_use === true && !caps.tool_use) return false;
        const pr = m.pricing || {};
        if (a.max_input_price !== undefined && !(Number(pr.input_per_1k) <= Number(a.max_input_price))) return false;
        if (a.max_output_price !== undefined && !(Number(pr.output_per_1k) <= Number(a.max_output_price))) return false;
        if (a.min_context_window !== undefined && !(Number(m.context_window) >= Number(a.min_context_window))) return false;
        return true;
      });
      if (a.order_by === 'popularity') matched.sort((x, y) => (y.popularity || 0) - (x.popularity || 0));
      else if (a.order_by === 'context_window') matched.sort((x, y) => (y.context_window || 0) - (x.context_window || 0));
      else if (a.order_by === 'input_price') matched.sort((x, y) => ((x.pricing || {}).input_per_1k || 0) - ((y.pricing || {}).input_per_1k || 0));
      const offset = Number.isInteger(a.offset) && a.offset > 0 ? a.offset : 0;
      const limit = Number.isInteger(a.limit) && a.limit > 0 ? Math.min(a.limit, 200) : 25;
      const models = matched.slice(offset, offset + limit).map((m) => ({
        model_id: m.model_id,
        model_name: m.model_name,
        provider: (m.provider || {}).key || (m.provider || {}).name || null,
        access_level: m.access_level,
        context_window: m.context_window,
        pricing_per_1k: m.pricing ? { input: m.pricing.input_per_1k, output: m.pricing.output_per_1k } : null,
        capabilities: m.capabilities
          ? Object.keys(m.capabilities).filter((k) => m.capabilities[k] === true)
          : [],
        is_available: m.is_available,
        health_status: m.health_status,
      }));
      return {
        total: all.length, matched: matched.length, offset, limit, models,
        note: models.length < matched.length
          ? `showing ${models.length} of ${matched.length} matched — page with offset/limit; full detail via model_get`
          : 'compact rows — full detail via model_get',
      };
    }
    case 'model_get':
      return apiGet(`/api/models/${needString(a, 'model_id', name)}`);
    case 'request_logs_list':
      return apiGet('/api/account/request-logs' + qs({
        limit: a.limit, offset: a.offset, status: a.status, endpoint: a.endpoint, model: a.model,
      }));
    case 'request_log_get':
      return apiGet(`/api/account/request-logs/${needString(a, 'log_id', name)}` + qs({ show_full_body: a.show_full_body }));
    case 'request_logs_stats':
      return apiGet('/api/account/request-logs/stats' + qs({ start_date: a.start_date, end_date: a.end_date }));
    case 'usage_breakdown':
      return apiGet('/api/billing/usage/breakdown' + qs({ period: a.period, group_by: a.group_by }));
    case 'cost_insights':
      return apiGet('/api/account/cost-insights' + qs({ period: a.period }));
    case 'errors_list':
      return apiGet('/api/account/errors' + qs({ period: a.period }));
    case 'quota_status':
      return apiGet('/api/user/quota/status');
    case 'alerts_list':
      return apiGet('/api/account/alerts');
    case 'organizations_list':
      return apiGet('/api/organizations');
    case 'organization_get':
      return apiGet(`/api/organizations/${needString(a, 'org_id', name)}`);
    case 'organization_members':
      return apiGet(`/api/organizations/${needString(a, 'org_id', name)}/members`);
    case 'invitations_pending':
      return apiGet('/api/invitations');
    case 'invitations_sent':
      return apiGet('/api/invitations/sent');
    case 'memberships_list':
      return apiGet('/api/invitations/memberships');
    case 'support_tickets_list':
      return apiGet('/api/support/tickets' + qs({ status: a.status, limit: a.limit, offset: a.offset }));
    case 'support_ticket_get':
      return apiGet(`/api/support/tickets/${needString(a, 'ticket_id', name)}`);
    case 'automation_servers_list':
      return apiGet('/api/automation/servers');
    case 'automation_server_get':
      return apiGet(`/api/automation/servers/${needString(a, 'server_id', name)}`);
    case 'automation_scripts_list':
      return apiGet('/api/automation/scripts');
    case 'automation_script_get':
      return apiGet(`/api/automation/scripts/${needString(a, 'slug', name)}`);
    case 'automation_executions_list':
      return apiGet('/api/automation/scripts/executions');
    case 'automation_sessions_list':
      return apiGet('/api/automation/sessions');
    case 'automation_session_get':
      return apiGet(`/api/automation/sessions/${needString(a, 'session_id', name)}`);
    case 'automation_templates_list':
      return apiGet('/api/automation/templates');
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── JSON-RPC over stdio (contract §7) ───────────────────────────────
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return rpcError(null, -32700, 'parse error'); }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification — never answer
  try {
    switch (method) {
      case 'initialize': {
        const offered = params && params.protocolVersion;
        const version = (typeof offered === 'string' && SUPPORTED.has(offered)) ? offered : PROTOCOL;
        return ok(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: TOOLS });
      case 'tools/call': {
        const result = await callTool(params && params.name, params && params.arguments);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      }
      default:
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    // Tool failure => RESULT with isError:true (contract §7.4); JSON-RPC
    // errors stay reserved for protocol faults.
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
process.stdin.on('end', () => process.exit(0)); // stdin EOF => prompt exit 0
process.on('SIGTERM', () => process.exit(0));   // well within the 5s budget

// All logging to stderr — stdout is protocol-only (contract §7.1).
process.stderr.write(`[${SERVER_NAME}] MCP stdio server ready (protocol ${PROTOCOL})\n`);

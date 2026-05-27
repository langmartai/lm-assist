#!/usr/bin/env node
// Pure-script end-to-end demo: claude.ai web → MCP tool → approval → result
// No JavaScript in browser. No UI interaction. All via direct HTTPS from this node process.
// Run on the host whose egress IP issued the cookie (cf_clearance is IP-bound).

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const COOKIE_PATH = process.env.COOKIE_PATH || `${os.homedir()}/.claude/claudeai-session.json`;
const TOOLS_PATH = process.env.TOOLS_PATH || '/tmp/lm-assist-tools.json';
const ORG = '7cad1e03-e98e-42ca-8571-311a4ce74b8b';
const SRV = '4576c1bb-5899-4ac3-ab03-b024122e1439';
const TOOL = 'list_recent_sessions';
const MARKER = 'PURE-SCRIPT-' + crypto.randomBytes(2).toString('hex').toUpperCase();

const cookie = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8')).cookie;
const lmAssistTools = JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf-8'));

const baseHeaders = {
  'Cookie': cookie,
  'Content-Type': 'application/json',
  'anthropic-client-platform': 'web_claude_ai',
  'anthropic-client-version': '1.0.0',
  'anthropic-client-sha': '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
};

async function postJSON(path, body) {
  const r = await fetch('https://claude.ai' + path, {
    method: 'POST', headers: {...baseHeaders, 'Accept': 'application/json'},
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

async function getJSON(path) {
  const r = await fetch('https://claude.ai' + path, {
    method: 'GET', headers: {...baseHeaders, 'Accept': 'application/json'},
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

async function postSSE(path, body) {
  const r = await fetch('https://claude.ai' + path, {
    method: 'POST', headers: {...baseHeaders, 'Accept': 'text/event-stream'},
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST(SSE) ${path} → ${r.status} ${await r.text()}`);
  return r.body;
}

async function* parseSSE(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += decoder.decode(value, {stream: true});
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data: ')) {
        try { yield JSON.parse(line.slice(6)); } catch {}
      }
    }
  }
}

(async () => {
  const log = (k, v) => console.log(`[${new Date().toISOString().slice(11,19)}] ${k}: ${v}`);

  log('marker', MARKER);

  // Step 1: probe-conv to discover the tool's current content-hash from account.settings inheritance
  log('step1', 'creating probe conv to read inherited tool hash...');
  const probeUuid = crypto.randomUUID();
  const probe = await postJSON(`/api/organizations/${ORG}/chat_conversations`, {
    uuid: probeUuid, name: 'hash-probe-' + MARKER, model: 'claude-opus-4-7',
  });
  const probeSettings = probe.settings?.enabled_mcp_tools || {};
  const hashKey = Object.keys(probeSettings).find(k =>
    k.startsWith(`${SRV}:${TOOL}-`) && /-[0-9a-f]{32}$/.test(k));
  if (!hashKey) throw new Error('no hash key found in probe conv for ' + TOOL);
  const approvalKey = hashKey;
  log('step1', `hash discovered (key suffix ...${approvalKey.slice(-8)})`);

  // Step 2: real conv with minimal settings — forces approval gate (no alwaysApprovedKey)
  log('step2', 'creating gated conv (minimal enabled_mcp_tools)...');
  const convUuid = crypto.randomUUID();
  await postJSON(`/api/organizations/${ORG}/chat_conversations`, {
    uuid: convUuid, name: 'pure-script-' + MARKER, model: 'claude-opus-4-7',
    settings: {
      enabled_mcp_tools: { [`${SRV}:${TOOL}`]: true },
      tool_search_mode: 'off',
    },
  });
  log('step2', `conv created ${convUuid.slice(0,8)}`);

  // Step 3: POST /completion — returns SSE
  log('step3', 'POST /completion (SSE)...');
  const stream = await postSSE(
    `/api/organizations/${ORG}/chat_conversations/${convUuid}/completion`,
    {
      prompt: `Call the lm-assist list_recent_sessions tool with scope=24h limit=1. Include the marker ${MARKER} in your final answer.`,
      parent_message_uuid: '00000000-0000-4000-8000-000000000000',
      timezone: 'Asia/Singapore',
      personalized_styles: [{
        type: 'default', key: 'Default', name: 'Normal',
        nameKey: 'normal_style_name', prompt: 'Normal\n',
        summary: 'Default responses from Claude',
        summaryKey: 'normal_style_summary', isDefault: true,
      }],
      locale: 'en-US',
      tools: lmAssistTools,
      attachments: [], files: [], sync_sources: [],
      rendering_mode: 'messages',
      model: 'claude-opus-4-7',
    }
  );

  // Step 4: parse SSE for tool_use_id
  let toolUseId = null, toolNameSeen = null, stopReason = null;
  for await (const evt of parseSSE(stream)) {
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      toolUseId = evt.content_block.id;
      toolNameSeen = evt.content_block.name;
      log('step4', `tool_use detected: ${toolNameSeen} (id ...${toolUseId.slice(-10)})`);
    }
    if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
      stopReason = evt.delta.stop_reason;
      if (stopReason === 'tool_use' || stopReason === 'stop_sequence') break;
    }
    if (evt.type === 'message_stop') break;
  }
  if (!toolUseId) throw new Error(`no tool_use in stream (stop_reason=${stopReason})`);

  // Step 5: POST /tool_approval
  log('step5', 'POST /tool_approval...');
  const approvalReq = {
    tool_use_id: toolUseId,
    is_approved: true,
    approval_key: approvalKey,
    approval_option: 'always',
  };
  let approvalStatus = '?';
  try {
    const r = await fetch(`https://claude.ai/api/organizations/${ORG}/chat_conversations/${convUuid}/tool_approval`, {
      method: 'POST', headers: {...baseHeaders, 'Accept': 'application/json'},
      body: JSON.stringify(approvalReq),
    });
    approvalStatus = r.status;
    log('step5', `approval HTTP ${approvalStatus}`);
  } catch (e) { log('step5-error', e.message); }

  // Step 6: poll the conv until an assistant message with tool_result + final text appears
  log('step6', 'polling conv for tool_result + final assistant text...');
  let resultText = null, msgCount = null, hadToolResult = false;
  const start = Date.now();
  while (Date.now() - start < 45000) {
    await new Promise(r => setTimeout(r, 1500));
    const c = await getJSON(`/api/organizations/${ORG}/chat_conversations/${convUuid}?tree=True&rendering_mode=messages&render_all_tools=true`);
    const msgs = c.chat_messages || [];
    msgCount = msgs.length;
    const last = msgs[msgs.length - 1];
    if (!last || last.sender !== 'assistant') continue;
    const blocks = last.content || [];
    const txt = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    hadToolResult = blocks.some(b => b.type === 'tool_result') ||
      msgs.some(m => (m.content || []).some(b => b.type === 'tool_result'));
    if (hadToolResult && txt.length > 80) { resultText = txt; break; }
    if (txt.length > 200) { resultText = txt; break; }
  }

  // Final report
  console.log('\n=========== RESULT ===========');
  console.log(JSON.stringify({
    marker: MARKER,
    conv_id_prefix: convUuid.slice(0, 8),
    tool_use_id_suffix: toolUseId?.slice(-12),
    approval_http_status: approvalStatus,
    stop_reason: stopReason,
    poll_message_count: msgCount,
    saw_tool_result_block: hadToolResult,
    final_assistant_text: resultText ? resultText.slice(0, 600) : '(timed out)',
  }, null, 2));
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * context-inject-hook.js - Cross-platform context injection hook for Claude Code
 *
 * Called by Claude Code's UserPromptSubmit hook. Reads the prompt from stdin,
 * optionally calls the lm-assist API for context suggestions, and returns
 * additionalContext that Claude sees before processing the prompt.
 *
 * Supports: Windows, macOS, Linux — no external dependencies (jq, curl, flock).
 *
 * Modes (from ~/.claude-code-config.json "contextInjectMode"):
 *   "mcp"     - Output MCP tool instruction (default)
 *   "suggest" - Call API for pre-fetched context
 *   "both"    - Suggest + MCP instruction
 *   "off"     - Skip all injection
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.lm-assist', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'context-inject-hook.log');
const CONFIG_FILE = path.join(HOME, '.claude-code-config.json');
const MILESTONE_SETTINGS_FILE = path.join(HOME, '.lm-assist', 'milestone', 'settings.json');
const API_PORT = process.env.TIER_AGENT_PORT || '3100';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function log(msg) {
  try {
    ensureDir(LOG_DIR);
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  } catch {}
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read stdin (hook input)
// ---------------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    // Timeout safety — if stdin never closes, resolve with what we have
    setTimeout(() => resolve(chunks.join('')), 5000);
  });
}

// ---------------------------------------------------------------------------
// HTTP POST helper (no external deps)
// ---------------------------------------------------------------------------

function httpPost(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port: parseInt(port, 10),
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(chunks.join('')) });
          } catch {
            resolve({ status: res.statusCode, body: null });
          }
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let input;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const prompt = input.prompt || input.user_prompt || '';
  const sessionId = input.session_id || '';

  // Skip empty prompts
  if (!prompt) {
    log(`SKIP session=${sessionId || 'unknown'} reason=empty_prompt`);
    process.exit(0);
  }

  // Skip system/internal prompts
  if (/^<task-notification>|^<subagent-|^<system-/.test(prompt)) {
    log(`SKIP session=${sessionId || 'unknown'} reason=system_prompt`);
    process.exit(0);
  }

  log(`START session=${sessionId || 'unknown'} port=${API_PORT} prompt="${prompt}"`);

  // --- Determine injection mode ---
  let injectMode = 'mcp';
  const config = readJson(CONFIG_FILE);
  if (config && config.contextInjectMode) {
    injectMode = config.contextInjectMode;
  }
  // Env override
  if (process.env.CONTEXT_INJECT_MODE) {
    injectMode = process.env.CONTEXT_INJECT_MODE;
  }

  if (injectMode === 'off') {
    log(`SKIP session=${sessionId || 'unknown'} reason=mode_off`);
    process.exit(0);
  }

  // --- Determine which sources to include ---
  let includeKnowledge = true;
  let includeMilestones = false;
  let experimentEnabled = false;

  const milestoneSettings = readJson(MILESTONE_SETTINGS_FILE);
  if (milestoneSettings && milestoneSettings.enabled === true) {
    experimentEnabled = true;
  }

  if (config) {
    if (config.contextInjectKnowledge === false) includeKnowledge = false;
    if (config.contextInjectMilestones === true && experimentEnabled) includeMilestones = true;
  }

  // Build MCP type filter
  const types = [];
  if (includeKnowledge) types.push('knowledge');
  if (includeMilestones) types.push('milestones');
  if (experimentEnabled) types.push('architecture');
  const mcpTypes = types.length > 0 ? types.join(', ') : 'knowledge';

  const promptPreview = prompt.length > 100 ? prompt.slice(0, 100) : prompt;
  const mcpInstruction =
    `Before responding, use MCP tools to retrieve relevant context:\n` +
    `1. search("${promptPreview}") — find top 5 matching ${mcpTypes} entries\n` +
    `2. For any highly relevant results, use detail(id) to expand the full content\n` +
    `3. Use this retrieved context to inform your response\n` +
    `4. If any retrieved context is outdated or wrong, use feedback(id, type, content) to flag it`;

  // --- MCP mode ---
  if (injectMode === 'mcp') {
    log(`INJECT-MCP session=${sessionId || 'unknown'}`);
    log(mcpInstruction);
    process.stdout.write(mcpInstruction + '\n');
    process.exit(0);
  }

  // --- Suggest / Both mode: call API ---
  let context = null;
  let sources = '';
  let tokens = 0;

  try {
    const resp = await httpPost(API_PORT, '/context/suggest', {
      prompt,
      sessionId,
    });

    if (resp.status === 200 && resp.body) {
      context = resp.body.context || null;
      sources = (resp.body.sources || []).join(', ');
      tokens = resp.body.tokens || 0;
    } else {
      log(`FAIL session=${sessionId || 'unknown'} reason=http_${resp.status}`);
    }
  } catch (err) {
    log(`FAIL session=${sessionId || 'unknown'} reason=connection_error (${err.message})`);
  }

  // --- Display mode ---
  let displayMode = 'stdout';
  if (config && config.contextInjectDisplay === false) {
    displayMode = 'quiet';
  }

  if (context) {
    log(`INJECT session=${sessionId || 'unknown'} tokens=${tokens} sources=[${sources}] mode=${displayMode}`);
    log(context);

    let output = context;
    if (injectMode === 'both') {
      output = context + '\n' + mcpInstruction;
      log(`INJECT-BOTH session=${sessionId || 'unknown'} tokens=${tokens} sources=[${sources}]`);
    }

    if (displayMode === 'stdout') {
      process.stdout.write(`[context-inject] sources=[${sources}] tokens=${tokens}\n`);
      process.stdout.write(output + '\n');
    } else {
      // Quiet mode — inject via additionalContext (invisible to user, visible to model)
      const hookOutput = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: output,
        },
      });
      process.stdout.write(hookOutput + '\n');
    }
  } else if (injectMode === 'both') {
    // No suggest context, but still inject MCP instruction
    log(`INJECT-MCP session=${sessionId || 'unknown'} (no suggest context)`);
    process.stdout.write(mcpInstruction + '\n');
  } else {
    log(`EMPTY session=${sessionId || 'unknown'} reason=no_matching_context`);
  }
}

main().catch(() => process.exit(0));

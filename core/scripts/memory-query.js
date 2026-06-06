#!/usr/bin/env node
/**
 * memory-query.js — Stream B: front "get memory by search" -> Haiku orchestrator.
 *
 * Spawns a Haiku agent via the lm-assist agent endpoint. The agent is an
 * ORCHESTRATOR ONLY: it maps the NL query to memory-map.js flags, runs the CLI
 * to pull the ACTUAL records, and returns that output verbatim — it never writes
 * memory content itself (token-cheap, no hallucinated memory). See design §7/§10.
 *
 *   node core/scripts/memory-query.js "what do we know about the broker boundary?"
 */
const http = require('http');
const PORT = process.env.API_PORT || (__dirname.includes('node_modules') ? '3100' : '3200');
const SCRIPT = require('path').join(__dirname, 'memory-map.js');
const query = process.argv.slice(2).join(' ').trim();
if (!query) { console.error('usage: memory-query.js "<question>"'); process.exit(1); }

const PROMPT = [
  'You are a MEMORY RETRIEVAL ORCHESTRATOR. Do NOT write memory content yourself —',
  'only run the deterministic CLI and return its output verbatim.',
  '',
  `Memory CLI: node ${SCRIPT} [--q terms] [--category c] [--types t] [--level brief|complete] [--limit N] [--record <id>] --format md`,
  'Categories: architecture deployment component endpoint feature config lesson knowledge.',
  '',
  `Question: ${query}`,
  '',
  'Steps: (1) pick the best --q keywords (+ optional --category/--types) for this question;',
  '(2) run the CLI at --level brief --limit 20 to see candidates;',
  '(3) for the few most relevant, run --record <id> (complete); mix brief + complete by relevance;',
  '(4) return ONLY the assembled CLI output (the actual records). No preamble, no paraphrase.',
].join('\n');

const body = JSON.stringify({
  prompt: PROMPT, cwd: '/home/ubuntu/lm-assist', model: 'haiku', background: false,
  permissionMode: 'bypassPermissions', settingSources: ['project', 'user'],
  outputConfig: { effort: 'low' },
});
const req = http.request({ host: 'localhost', port: PORT, path: '/agent/execute', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
  (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => process.stdout.write(d)); });
req.on('error', e => { console.error('agent endpoint error:', e.message); process.exit(2); });
req.write(body); req.end();

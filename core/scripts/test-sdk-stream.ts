#!/usr/bin/env npx ts-node
/**
 * Test script: What does the Claude Agent SDK stream during execution?
 *
 * Runs a simple prompt and logs every message the SDK yields,
 * showing the exact type, structure, and timing of each event.
 *
 * Usage:
 *   cd /home/ubuntu/lm-assist/core
 *   npx ts-node scripts/test-sdk-stream.ts [prompt]
 *
 * Default prompt: "What is 2+2? Answer in one word."
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKSystemMessage, SDKAssistantMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

const prompt = process.argv[2] || 'What is 2+2? Answer in one word.';
const cwd = process.argv[3] || process.cwd();

console.log('='.repeat(80));
console.log('SDK Stream Test');
console.log('='.repeat(80));
console.log(`Prompt: ${prompt}`);
console.log(`CWD:    ${cwd}`);
console.log(`Time:   ${new Date().toISOString()}`);
console.log('='.repeat(80));
console.log('');

async function main() {
  const startTime = Date.now();
  let messageIndex = 0;

  const queryInstance = query({
    prompt,
    options: {
      cwd,
      permissionMode: 'bypassPermissions' as any,
      maxTurns: 3,
    },
  });

  console.log(`[${elapsed(startTime)}] Query started, iterating messages...\n`);

  for await (const message of queryInstance) {
    messageIndex++;
    const ts = elapsed(startTime);
    const type = message.type;

    console.log(`${'─'.repeat(60)}`);
    console.log(`[${ts}] Message #${messageIndex} — type: "${type}"`);

    // ─── System init ───
    if (type === 'system') {
      const sys = message as SDKSystemMessage;
      console.log(`  subtype:    ${sys.subtype}`);
      if (sys.subtype === 'init') {
        console.log(`  session_id: ${sys.session_id}`);
        console.log(`  model:      ${sys.model}`);
        console.log(`  tools:      [${sys.tools?.length || 0} tools]`);
        console.log(`  mcp:        [${sys.mcp_servers?.length || 0} servers]`);
        console.log(`  agents:     [${(sys as any).agents?.length || 0}]`);
        console.log(`  plugins:    [${(sys as any).plugins?.length || 0}]`);
        console.log(`  permission: ${sys.permissionMode}`);
        console.log(`  version:    ${sys.claude_code_version}`);
      }
    }

    // ─── Assistant message ───
    else if (type === 'assistant') {
      const asst = message as SDKAssistantMessage;
      const content = asst.message?.content || [];
      console.log(`  content blocks: ${content.length}`);
      for (const block of content) {
        if (block.type === 'text') {
          const text = block.text.length > 200 ? block.text.slice(0, 200) + '...' : block.text;
          console.log(`    [text] ${text}`);
        } else if (block.type === 'tool_use') {
          console.log(`    [tool_use] name="${(block as any).name}" id="${(block as any).id}"`);
          const input = JSON.stringify((block as any).input || {}).slice(0, 150);
          console.log(`      input: ${input}`);
        } else if (block.type === 'thinking') {
          const thinking = (block as any).thinking || '';
          const preview = thinking.length > 200 ? thinking.slice(0, 200) + '...' : thinking;
          console.log(`    [thinking] ${preview}`);
        } else {
          console.log(`    [${block.type}] ${JSON.stringify(block).slice(0, 150)}`);
        }
      }
      console.log(`  stop_reason: ${asst.message?.stop_reason || '?'}`);
    }

    // ─── Result ───
    else if (type === 'result') {
      const res = message as SDKResultMessage;
      console.log(`  subtype:     ${res.subtype}`);
      if (res.subtype === 'success') {
        const result = res.result.length > 300 ? res.result.slice(0, 300) + '...' : res.result;
        console.log(`  result:      ${result}`);
        console.log(`  cost:        $${res.total_cost_usd?.toFixed(4)}`);
        console.log(`  turns:       ${res.num_turns}`);
        console.log(`  api_ms:      ${res.duration_api_ms}ms`);
        console.log(`  usage:       in=${res.usage?.input_tokens} out=${res.usage?.output_tokens} cache_read=${res.usage?.cache_read_input_tokens} cache_create=${res.usage?.cache_creation_input_tokens}`);
      } else {
        console.log(`  errors:      ${(res as any).errors?.join('; ') || 'unknown'}`);
        console.log(`  cost:        $${(res as any).total_cost_usd?.toFixed(4)}`);
      }
    }

    // ─── Unknown / other types ───
    else {
      console.log(`  UNKNOWN TYPE: ${type}`);
      console.log(`  keys: ${Object.keys(message).join(', ')}`);
      const preview = JSON.stringify(message).slice(0, 500);
      console.log(`  raw: ${preview}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${elapsed(startTime)}] Stream ended. Total messages: ${messageIndex}`);
  console.log(`${'='.repeat(60)}`);
}

function elapsed(start: number): string {
  const ms = Date.now() - start;
  return `${(ms / 1000).toFixed(2)}s`;
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

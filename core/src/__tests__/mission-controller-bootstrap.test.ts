import { test } from 'node:test';
import assert from 'node:assert';
import { CONTROLLER_SYSTEM_PROMPT, buildControllerLaunchExtras } from '../mission/mission-controller';

test('CONTROLLER_SYSTEM_PROMPT names the role + heartbeat marker + scope', () => {
  assert.match(CONTROLLER_SYSTEM_PROMPT, /Mission Controller/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /⟦HEARTBEAT⟧/);
  // guarded scope: only mission_* tools, never edit code itself
  assert.match(CONTROLLER_SYSTEM_PROMPT, /mission_/);
});

test('buildControllerLaunchExtras: writes prompt file always, mcp file only with apiKey', () => {
  const written: Record<string, string> = {};
  const wf = (n: string, b: string): string => { const p = '/tmp/' + n; written[p] = b; return p; };

  const withKey = buildControllerLaunchExtras({ hubUrl: 'wss://assist-api.langmart.ai', apiKey: 'sk-x', writeFile: wf });
  assert.ok(withKey.appendSystemPromptFile, 'always returns a prompt file');
  assert.ok(written[withKey.appendSystemPromptFile].includes('Mission Controller'), 'prompt file has role text');
  assert.ok(withKey.mcpConfigPath, 'mcp file present when apiKey given');
  const mcp = JSON.parse(written[withKey.mcpConfigPath!]);
  assert.ok(mcp.mcpServers['lm-assist-hub'], 'mcp config has lm-assist-hub server');
  assert.equal(mcp.mcpServers['lm-assist-hub'].url, 'https://mcp.langmart.ai/mcp');
  assert.equal(mcp.mcpServers['lm-assist-hub'].headers.Authorization, 'Bearer sk-x');
});

test('buildControllerLaunchExtras: no apiKey → no mcp config', () => {
  const written: Record<string, string> = {};
  const wf = (n: string, b: string): string => { const p = '/tmp/' + n; written[p] = b; return p; };
  const noKey = buildControllerLaunchExtras({ hubUrl: 'wss://assist-api.langmart.ai', apiKey: null, writeFile: wf });
  assert.ok(noKey.appendSystemPromptFile, 'still writes prompt file');
  assert.equal(noKey.mcpConfigPath, undefined, 'no mcp file without a key');
});

test('buildControllerLaunchExtras: garbage hubUrl + key → no mcp config (cannot derive url)', () => {
  const written: Record<string, string> = {};
  const wf = (n: string, b: string): string => { const p = '/tmp/' + n; written[p] = b; return p; };
  const bad = buildControllerLaunchExtras({ hubUrl: 'not-a-url', apiKey: 'sk-x', writeFile: wf });
  assert.equal(bad.mcpConfigPath, undefined, 'no mcp file when url cannot be derived');
});

test('buildControllerLaunchExtras: localMcp PREFERRED over hub keystone, same server name, x-api-key header', () => {
  const written: Record<string, string> = {};
  const wf = (n: string, b: string): string => { const p = '/tmp/' + n; written[p] = b; return p; };
  const r = buildControllerLaunchExtras({
    hubUrl: 'wss://assist-api.langmart.ai', apiKey: 'sk-x', writeFile: wf,
    localMcp: { url: 'http://127.0.0.1:3100/mcp', token: 'tok-1' },
  });
  assert.ok(r.mcpConfigPath);
  const mcp = JSON.parse(written[r.mcpConfigPath!]);
  const entry = mcp.mcpServers['lm-assist-hub'];
  assert.ok(entry, 'same server name so tool prefix mcp__lm-assist-hub__* is unchanged');
  assert.equal(entry.url, 'http://127.0.0.1:3100/mcp');
  assert.equal(entry.headers['x-api-key'], 'tok-1');
  assert.equal(entry.headers.Authorization, undefined, 'no hub bearer on the local shape');
});

test('buildControllerLaunchExtras: localMcp without token falls back to hub keystone', () => {
  const written: Record<string, string> = {};
  const wf = (n: string, b: string): string => { const p = '/tmp/' + n; written[p] = b; return p; };
  const r = buildControllerLaunchExtras({
    hubUrl: 'wss://assist-api.langmart.ai', apiKey: 'sk-x', writeFile: wf,
    localMcp: { url: 'http://127.0.0.1:3100/mcp', token: '' },
  });
  const mcp = JSON.parse(written[r.mcpConfigPath!]);
  assert.equal(mcp.mcpServers['lm-assist-hub'].url, 'https://mcp.langmart.ai/mcp');
  assert.equal(mcp.mcpServers['lm-assist-hub'].headers.Authorization, 'Bearer sk-x');
});

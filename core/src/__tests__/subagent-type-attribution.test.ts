import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A subagent reports the agent type it actually ran as.
 *
 * The transcript carries no `subagent_type` — that argument lives only on the parent's
 * Task call. Claude Code instead stamps `attributionAgent` (e.g. `my-plugin:oracle`) on
 * the transcript's assistant lines, and readSubagentSession() resolves the type from
 * there. A transcript with no attribution resolves to 'general-purpose'.
 *
 * HERMETIC HOME: the fixtures live under a stubbed os.homedir(), never the real one —
 * on a dev machine a running Core watches ~/.claude/projects and would cache the
 * transient files. The stub is installed on the RAW os module before the modules under
 * test load (they resolve ~/.claude/projects at call time, but tsc's __importStar
 * copies module properties at load time, so patch-then-require is the safe order).
 */

const rawOs = require('node:os');

function writeAgentTranscript(dir: string, agentId: string, sessionId: string, cwd: string, attributionAgent?: string) {
  const lines: any[] = [
    // First line is a `user` line — it never carries attribution.
    { parentUuid: null, isSidechain: true, agentId, type: 'user', sessionId, cwd, version: '2.1.241',
      message: { role: 'user', content: 'do the thing' }, uuid: `${agentId}-u1`, timestamp: '2026-08-24T21:30:00.000Z' },
    // Assistant lines carry it.
    { parentUuid: `${agentId}-u1`, isSidechain: true, agentId, type: 'assistant', sessionId, cwd, version: '2.1.241',
      ...(attributionAgent ? { attributionAgent, attributionPlugin: attributionAgent.split(':')[0] } : {}),
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'on it' }] },
      uuid: `${agentId}-a1`, timestamp: '2026-08-24T21:30:05.000Z' },
  ];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

test('readSubagentSession reports the attributed agent type, not general-purpose', async () => {
  const realHomedir = rawOs.homedir;
  const fakeHome = fs.mkdtempSync(path.join(rawOs.tmpdir(), 'sat-home-'));
  rawOs.homedir = () => fakeHome;

  const dataDir = fs.mkdtempSync(path.join(rawOs.tmpdir(), 'sat-data-'));
  process.env.LM_ASSIST_DATA_DIR = dataDir;

  const projectCwd = fs.mkdtempSync(path.join(rawOs.tmpdir(), 'sat-proj-'));
  const sessionId = 'ffffffff-1111-2222-3333-444444444444';
  let store: any;

  try {
    // Everything under test loads AFTER the homedir stub (see header comment).
    const { legacyEncodeProjectPath } = require('../utils/path-utils');
    const projectDir = path.join(fakeHome, '.claude', 'projects', legacyEncodeProjectPath(projectCwd));
    const subagentsDir = path.join(projectDir, sessionId, 'subagents');

    writeAgentTranscript(subagentsDir, 'a1111111111111111', sessionId, projectCwd, 'my-plugin:oracle');
    // An agent with no attribution at all must still degrade to the old default.
    writeAgentTranscript(subagentsDir, 'a2222222222222222', sessionId, projectCwd, undefined);
    // A hostile value must not ride through into the rendered type.
    writeAgentTranscript(subagentsDir, 'a3333333333333333', sessionId, projectCwd, 'x'.repeat(4096));

    const { AgentSessionStore } = require('../agent-session-store');
    store = new AgentSessionStore({ projectPath: projectCwd });

    const attributed = await store.readSubagentSession('a1111111111111111', projectCwd);
    assert.ok(attributed, 'expected the attributed agent transcript to load');
    assert.equal(attributed.type, 'my-plugin:oracle');

    const bare = await store.readSubagentSession('a2222222222222222', projectCwd);
    assert.ok(bare, 'expected the unattributed agent transcript to load');
    assert.equal(bare.type, 'general-purpose', 'no attribution → unchanged default');

    const hostile = await store.readSubagentSession('a3333333333333333', projectCwd);
    assert.ok(hostile, 'expected the hostile-attribution transcript to load');
    assert.equal(hostile.type, 'general-purpose', 'oversized attribution is refused, not rendered');
  } finally {
    // SessionCache opens LMDB and a file watcher; both must go or the suite never exits.
    const { getSessionCache } = require('../session-cache');
    const cache = getSessionCache();
    cache.stopWatching();
    cache.close();
    store?.stop?.();
    rawOs.homedir = realHomedir;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.LM_ASSIST_DATA_DIR;
  }
});

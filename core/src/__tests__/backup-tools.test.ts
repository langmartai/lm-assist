import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { execFileSync } from 'child_process';

import { assertScopesCoverTools, TOOL_SCOPES, LM_ASSIST_TOOL_DEFS } from '../mcp-server/configure';
import { MEASURED_BUDGETS, NOT_MEASURED } from '../mcp-server/tool-output-budget';
import { BACKUP_TOOL_DEFS, BACKUP_HANDLERS } from '../mcp-server/tools/backup';
import { excludeReason } from '../backup/secrets';
import { classify, carriesText, sessionText, conversationText } from '../backup/capture';
import { ftsQuery } from '../backup/search-index';
import { filterTar, readTar, chunks } from '../backup/tar-reader';
import { staleness, isUserExcluded } from '../backup/store';

const BACKUP_TOOLS = ['backup_run', 'backup_status', 'backup_list', 'backup_search', 'backup_read', 'backup_remove'];

// ------------------------------------------------------------- registration

test('every backup tool is advertised, handled and scoped', () => {
  const advertised = new Set(LM_ASSIST_TOOL_DEFS.map((d) => d.name));
  for (const name of BACKUP_TOOLS) {
    assert.ok(advertised.has(name), `${name} is not in LM_ASSIST_TOOL_DEFS`);
    assert.ok(BACKUP_HANDLERS[name], `${name} has no handler`);
    assert.ok(name in TOOL_SCOPES, `${name} has no TOOL_SCOPES entry — this crashes Core at boot`);
  }
  assert.strictEqual(BACKUP_TOOL_DEFS.length, BACKUP_TOOLS.length);
});

test('assertScopesCoverTools still passes with the backup tools added', () => {
  assert.doesNotThrow(() => assertScopesCoverTools());
});

test('destructive backup tools are not readable-scope', () => {
  assert.strictEqual(TOOL_SCOPES.backup_remove, 'admin');
  assert.strictEqual(TOOL_SCOPES.backup_run, 'write');
  for (const n of ['backup_status', 'backup_list', 'backup_search', 'backup_read']) {
    assert.strictEqual(TOOL_SCOPES[n], 'read');
  }
});

test('every backup tool is classified in the output-size guard', () => {
  for (const name of BACKUP_TOOLS) {
    assert.ok(name in MEASURED_BUDGETS || name in NOT_MEASURED,
      `${name} is unclassified — the output-size guard fails the suite`);
  }
});

test('backup_remove requires confirm and a reason in its schema', () => {
  const def = BACKUP_TOOL_DEFS.find((d) => d.name === 'backup_remove')!;
  const required = (def.inputSchema as { required?: string[] }).required ?? [];
  for (const k of ['id', 'reason', 'confirm']) assert.ok(required.includes(k), `${k} must be required`);
});

test('backup_search does not shadow the injected routing parameter', () => {
  // `node` is auto-injected on every lm-assist tool to choose WHICH host runs
  // the call. A tool that also used `node` for its own filter would make the
  // two meanings indistinguishable at the call site.
  for (const name of ['backup_search', 'backup_list']) {
    const def = BACKUP_TOOL_DEFS.find((d) => d.name === name)!;
    const props = Object.keys((def.inputSchema as { properties: Record<string, unknown> }).properties);
    assert.ok(!props.includes('node'), `${name} must use \`source\`, not \`node\``);
    assert.ok(props.includes('source'));
  }
});

// ------------------------------------------------------------------ secrets

test('the deny-list refuses every credential file found in the existing store', () => {
  // Verified present in E:\claude-backup on 2026-07-29. Each of these was a
  // LIVE secret sitting in plaintext in the backup; the port must never
  // capture them again.
  const mustRefuse = [
    '.credentials.json',
    'claudeai-session.json',
    'claudeai-session.isolated.json',
    'claudeai-session.Profile_1.json',
    'claudeai-browser-profile/Default/Cookies',
    'chrome/profile/Login Data',
    'ide/lock.json',
    'mcp-needs-auth-cache.json',
  ];
  for (const p of mustRefuse) {
    assert.ok(excludeReason(p), `deny-list MISSED ${p} — a live secret would be captured`);
  }
});

test('the deny-list also refuses generic key material', () => {
  for (const p of ['projects/x/.env', 'projects/x/server.pem', 'projects/x/id_rsa', 'foo/private.key']) {
    assert.ok(excludeReason(p), `deny-list missed ${p}`);
  }
});

test('the deny-list does NOT refuse the content the backup exists to protect', () => {
  // The failure mode on the other side: an over-broad rule that quietly stops
  // backing up sessions or memory would be far worse than a captured token.
  const mustKeep = [
    'projects/C--home-lm-assist/abc-123.jsonl',
    'projects/C--home-lm-assist/memory/MEMORY.md',
    'rules/panic-mode.md',
    'settings.json',
    'history.jsonl',
    'CLAUDE.md',
    'tasks/task-1.json',
    'plugins/marketplace.json',
    '.env.example',
  ];
  for (const p of mustKeep) {
    assert.strictEqual(excludeReason(p), null, `deny-list wrongly refuses ${p}`);
  }
});

// ----------------------------------------------------------- classification

test('paths classify into the kinds search filters on', () => {
  assert.strictEqual(classify('projects/P/abc.jsonl').kind, 'session');
  assert.strictEqual(classify('projects/P/memory/MEMORY.md').kind, 'memory');
  assert.strictEqual(classify('rules/panic-mode.md').kind, 'rule');
  assert.strictEqual(classify('settings.json').kind, 'file');
  assert.strictEqual(classify('projects/P/memory/x.md').project, 'P');
  assert.ok(carriesText('rules/a.md'));
  assert.ok(!carriesText('settings.json'));
});

test('session text keeps prompts and prose and drops tool payloads', () => {
  const jsonl = [
    JSON.stringify({ message: { role: 'user', content: 'find the flaky test' } }),
    JSON.stringify({ message: { role: 'assistant', content: [
      { type: 'text', text: 'looking now' },
      { type: 'tool_use', name: 'Bash', input: { command: 'SECRETPAYLOAD' } },
    ] } }),
    JSON.stringify({ type: 'tool_result', content: 'ANOTHERPAYLOAD' }),
    'not json at all',
  ].join('\n');
  const text = sessionText(jsonl);
  assert.match(text, /find the flaky test/);
  assert.match(text, /looking now/);
  assert.ok(!text.includes('SECRETPAYLOAD'), 'tool inputs must not be indexed');
  assert.ok(!text.includes('ANOTHERPAYLOAD'), 'tool results must not be indexed');
});

test('conversation text includes attached markdown, which is why the .md files are searchable', () => {
  const conv = JSON.stringify({
    chat_messages: [
      { text: 'here is the doc', attachments: [{ extracted_content: '# Trading framework\nrule one' }] },
      { content: [{ text: 'thanks' }] },
    ],
  });
  const text = conversationText(conv);
  assert.match(text, /Trading framework/);
  assert.match(text, /rule one/);
  assert.match(text, /thanks/);
});

test('malformed input never throws — a corrupt file must not fail a whole capture', () => {
  assert.strictEqual(sessionText('{{{not json'), '');
  assert.strictEqual(conversationText('nope'), '');
});

// ----------------------------------------------------------------- querying

test('punctuation is quoted so an ordinary search is not an FTS syntax error', () => {
  assert.strictEqual(ftsQuery('claude backup'), 'claude backup');
  assert.strictEqual(ftsQuery('claude-backup'), '"claude-backup"');
  assert.strictEqual(ftsQuery('error:'), '"error:"');
  assert.strictEqual(ftsQuery('say "hi"'), '"say ""hi"""');
});

test('staleness turns a timestamp into a verdict', () => {
  const now = Date.parse('2026-07-29T12:00:00');
  assert.strictEqual(staleness('2026-07-29 09:00:00', now).verdict, 'fresh');
  assert.strictEqual(staleness('2026-07-25 09:00:00', now).verdict, 'aging');
  assert.strictEqual(staleness('2026-07-01 09:00:00', now).verdict, 'stale');
  assert.strictEqual(staleness(undefined, now).verdict, 'never');
});

test('an exclusion covers a directory prefix, not a substring', () => {
  assert.ok(isUserExcluded(['chrome'], 'chrome/Default/Cookies'));
  assert.ok(isUserExcluded(['a/b.md'], 'a/b.md'));
  assert.ok(!isUserExcluded(['chrome'], 'chrome-notes.md'));
});

// ------------------------------------------------------- tar repack (remove)

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-backup-test-'));
}

async function membersOf(file: string): Promise<string[]> {
  const names: string[] = [];
  const src = fs.createReadStream(file).pipe(zlib.createGunzip());
  for await (const { entry } of readTar(chunks(src as never))) {
    if (entry.type === '0') names.push(entry.name);
  }
  return names;
}

test('filterTar removes exactly one member and leaves a valid archive', async () => {
  const dir = tmpdir();
  try {
    const src = path.join(dir, 'src');
    // A long path on purpose: real session files exceed tar's 100-byte name
    // field, so GNU emits an `L` record. Dropping one without its owner would
    // corrupt the archive — this is the case a naive repack gets wrong.
    const longRel = 'projects/C--home-lm-unified-trade-with-a-very-long-project-slug-for-testing/54aa4d40-b84a-4942-8915-7ded1b169151.jsonl';
    fs.mkdirSync(path.join(src, path.dirname(longRel)), { recursive: true });
    fs.writeFileSync(path.join(src, longRel), 'keep me\n');
    fs.mkdirSync(path.join(src, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(src, 'rules', 'a.md'), 'rule a\n');
    fs.writeFileSync(path.join(src, 'secret.txt'), 'DELETE THIS\n');

    const archive = path.join(dir, 'snap.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', src, '.']);

    const before = await membersOf(archive);
    assert.ok(before.some((n) => n.endsWith('secret.txt')));
    const victim = before.find((n) => n.endsWith('secret.txt'))!;

    const out = path.join(dir, 'snap2.tar.gz');
    const ws = fs.createWriteStream(out);
    const gz = zlib.createGzip();
    gz.pipe(ws);
    const write = (b: Buffer): Promise<void> =>
      new Promise((res) => { if (gz.write(b)) res(); else gz.once('drain', res); });
    const gunzip = fs.createReadStream(archive).pipe(zlib.createGunzip());
    const { dropped } = await filterTar(chunks(gunzip as never), (e) => e.name === victim, write);
    await new Promise<void>((res) => { ws.once('finish', res); gz.end(); });

    assert.strictEqual(dropped, 1);
    const after = await membersOf(out);
    assert.ok(!after.includes(victim), 'the removed member is still present');
    assert.strictEqual(after.length, before.length - 1);
    assert.ok(after.some((n) => n.endsWith('54aa4d40-b84a-4942-8915-7ded1b169151.jsonl')),
      'the long-named member was lost — its GNU longname record was mishandled');

    // The retained content must be byte-identical and readable by real tar.
    const back = path.join(dir, 'back');
    fs.mkdirSync(back);
    execFileSync('tar', ['xzf', out, '-C', back]);
    assert.strictEqual(fs.readFileSync(path.join(back, longRel), 'utf-8'), 'keep me\n');
    assert.strictEqual(fs.readFileSync(path.join(back, 'rules', 'a.md'), 'utf-8'), 'rule a\n');
    assert.ok(!fs.existsSync(path.join(back, 'secret.txt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readTar surfaces long member names rather than truncating them', async () => {
  const dir = tmpdir();
  try {
    const src = path.join(dir, 'src');
    const deep = 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/file.jsonl';
    fs.mkdirSync(path.join(src, path.dirname(deep)), { recursive: true });
    fs.writeFileSync(path.join(src, deep), 'x');
    const archive = path.join(dir, 'deep.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', src, '.']);
    const names = await membersOf(archive);
    assert.ok(names.some((n) => n.endsWith(deep)), `long name lost: ${names.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

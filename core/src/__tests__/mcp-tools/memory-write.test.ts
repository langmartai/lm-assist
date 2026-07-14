import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryWriteRequest, EXPANDED_TOOL_DEFS, EXPANDED_HANDLERS } from '../../mcp-server/tools/expanded';
import { TOOL_SCOPES, assertScopesCoverTools } from '../../mcp-server/configure';

// Unit tests for the pure action/args -> {method, path, body} mapping behind
// the memory_write MCP tool. No I/O — buildMemoryWriteRequest is exported
// specifically so this construction (query/body/URI-encoding/bool-coercion)
// is testable without stubbing fetch. Full live round-trip (create -> read ->
// update w/ hash -> delete) happens in the integration e2e step against a
// running Core, per the task-7 brief.

describe('buildMemoryWriteRequest — action validation', () => {
  it('rejects a missing action', () => {
    const r = buildMemoryWriteRequest({ project_id: 'p', filename: 'a.md' });
    assert.ok('error' in r);
    assert.match((r as { error: string }).error, /action must be one of: create, update, delete/);
  });

  it('rejects an unknown action, listing the valid ones', () => {
    const r = buildMemoryWriteRequest({ action: 'rename', project_id: 'p', filename: 'a.md' });
    assert.ok('error' in r);
    assert.match((r as { error: string }).error, /create, update, delete/);
  });

  it('rejects a missing project_id or filename', () => {
    const noProject = buildMemoryWriteRequest({ action: 'create', filename: 'a.md', content: 'x' });
    assert.ok('error' in noProject);
    const noFilename = buildMemoryWriteRequest({ action: 'create', project_id: 'p', content: 'x' });
    assert.ok('error' in noFilename);
  });
});

describe('buildMemoryWriteRequest — action="create"', () => {
  it('maps to POST on the collection route with filename+content in body', () => {
    const r = buildMemoryWriteRequest({ action: 'create', project_id: 'my-proj', filename: 'notes.md', content: '# hi' });
    assert.ok(!('error' in r));
    const req = r as { method: string; path: string; body?: Record<string, unknown> };
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/memory/by-project/my-proj/file');
    assert.deepEqual(req.body, { filename: 'notes.md', content: '# hi' });
  });

  it('requires content', () => {
    const r = buildMemoryWriteRequest({ action: 'create', project_id: 'p', filename: 'a.md' });
    assert.ok('error' in r);
    assert.match((r as { error: string }).error, /content is required/);
  });

  it('passes index_line through when provided (create only)', () => {
    const r = buildMemoryWriteRequest({
      action: 'create',
      project_id: 'p',
      filename: 'a.md',
      content: 'body',
      index_line: '- [a](a.md) — new topic',
    });
    assert.ok(!('error' in r));
    const req = r as { body?: Record<string, unknown> };
    assert.equal(req.body?.indexLine, '- [a](a.md) — new topic');
  });

  it('omits indexLine when index_line is blank/whitespace-only', () => {
    const r = buildMemoryWriteRequest({ action: 'create', project_id: 'p', filename: 'a.md', content: 'body', index_line: '   ' });
    assert.ok(!('error' in r));
    const req = r as { body?: Record<string, unknown> };
    assert.equal('indexLine' in (req.body || {}), false);
  });

  it('ignores expected_hash on create (route has no use for it)', () => {
    const r = buildMemoryWriteRequest({ action: 'create', project_id: 'p', filename: 'a.md', content: 'body', expected_hash: 'deadbeef' });
    assert.ok(!('error' in r));
    const req = r as { body?: Record<string, unknown> };
    assert.equal('expectedHash' in (req.body || {}), false);
  });
});

describe('buildMemoryWriteRequest — action="update"', () => {
  it('maps to PUT on the file route with content (+ expectedHash) in body', () => {
    const r = buildMemoryWriteRequest({ action: 'update', project_id: 'my-proj', filename: 'notes.md', content: 'updated', expected_hash: 'abc123' });
    assert.ok(!('error' in r));
    const req = r as { method: string; path: string; body?: Record<string, unknown> };
    assert.equal(req.method, 'PUT');
    assert.equal(req.path, '/memory/by-project/my-proj/file/notes.md');
    assert.deepEqual(req.body, { content: 'updated', expectedHash: 'abc123' });
  });

  it('omits expectedHash from body when not supplied (blind overwrite allowed, but not fabricated)', () => {
    const r = buildMemoryWriteRequest({ action: 'update', project_id: 'p', filename: 'a.md', content: 'x' });
    assert.ok(!('error' in r));
    const req = r as { body?: Record<string, unknown> };
    assert.equal('expectedHash' in (req.body || {}), false);
  });

  it('requires content', () => {
    const r = buildMemoryWriteRequest({ action: 'update', project_id: 'p', filename: 'a.md' });
    assert.ok('error' in r);
    assert.match((r as { error: string }).error, /content is required/);
  });

  it('trims a whitespace-padded expected_hash and ignores an empty one', () => {
    const padded = buildMemoryWriteRequest({ action: 'update', project_id: 'p', filename: 'a.md', content: 'x', expected_hash: '  abc  ' });
    assert.ok(!('error' in padded));
    assert.equal((padded as { body?: Record<string, unknown> }).body?.expectedHash, 'abc');

    const empty = buildMemoryWriteRequest({ action: 'update', project_id: 'p', filename: 'a.md', content: 'x', expected_hash: '   ' });
    assert.ok(!('error' in empty));
    assert.equal('expectedHash' in ((empty as { body?: Record<string, unknown> }).body || {}), false);
  });
});

describe('buildMemoryWriteRequest — action="delete"', () => {
  it('maps to DELETE on the file route with removeIndexLine defaulting true', () => {
    const r = buildMemoryWriteRequest({ action: 'delete', project_id: 'my-proj', filename: 'notes.md' });
    assert.ok(!('error' in r));
    const req = r as { method: string; path: string };
    assert.equal(req.method, 'DELETE');
    assert.equal(req.path, '/memory/by-project/my-proj/file/notes.md?removeIndexLine=true');
  });

  it('includes expectedHash in the query string when supplied', () => {
    const r = buildMemoryWriteRequest({ action: 'delete', project_id: 'p', filename: 'a.md', expected_hash: 'deadbeef' });
    assert.ok(!('error' in r));
    const req = r as { path: string };
    assert.match(req.path, /removeIndexLine=true/);
    assert.match(req.path, /expectedHash=deadbeef/);
  });

  it('does not require content (delete has none)', () => {
    const r = buildMemoryWriteRequest({ action: 'delete', project_id: 'p', filename: 'a.md' });
    assert.ok(!('error' in r));
  });

  describe('remove_index_line string coercion (MCP connector args arrive as strings)', () => {
    const cases: Array<[unknown, string]> = [
      [undefined, 'true'], // default
      [true, 'true'],
      [false, 'false'],
      ['true', 'true'],
      ['false', 'false'],
      ['1', 'true'],
      ['0', 'false'],
      ['TRUE', 'true'],
      ['False', 'false'],
      [' true ', 'true'],
      ['not-a-bool', 'true'], // unrecognized -> falls back to default (true)
    ];
    for (const [input, expected] of cases) {
      it(`remove_index_line=${JSON.stringify(input)} -> removeIndexLine=${expected}`, () => {
        const r = buildMemoryWriteRequest({ action: 'delete', project_id: 'p', filename: 'a.md', remove_index_line: input });
        assert.ok(!('error' in r));
        const req = r as { path: string };
        assert.match(req.path, new RegExp(`removeIndexLine=${expected}(&|$)`));
      });
    }
  });
});

describe('buildMemoryWriteRequest — URI encoding', () => {
  it('encodeURIComponents project_id and filename (special chars, nested path, spaces)', () => {
    const r = buildMemoryWriteRequest({ action: 'update', project_id: 'C--home-my project', filename: 'sub dir/a b.md', content: 'x' });
    assert.ok(!('error' in r));
    const req = r as { path: string };
    assert.equal(req.path, `/memory/by-project/${encodeURIComponent('C--home-my project')}/file/${encodeURIComponent('sub dir/a b.md')}`);
    // encodeURIComponent escapes the path separator too — matches the web
    // client's own contract (server decodeURIComponents both segments).
    assert.ok(req.path.includes('%2F') || !req.path.includes('sub dir/a b.md'));
  });

  it('encodes filename in the delete query path too', () => {
    const r = buildMemoryWriteRequest({ action: 'delete', project_id: 'p', filename: 'weird name?.md' });
    assert.ok(!('error' in r));
    const req = r as { path: string };
    assert.ok(req.path.startsWith(`/memory/by-project/p/file/${encodeURIComponent('weird name?.md')}?`));
  });

  it('a slash-bearing expected_hash is query-encoded, not left raw', () => {
    const r = buildMemoryWriteRequest({ action: 'delete', project_id: 'p', filename: 'a.md', expected_hash: 'ab/cd+ef' });
    assert.ok(!('error' in r));
    const req = r as { path: string };
    assert.ok(!req.path.includes('ab/cd+ef'), 'raw slash must not appear unescaped in the query string');
  });
});

describe('memory_file / memory_write — registration, scope, dispatch', () => {
  it('memory_file is advertised read-only, dispatchable, and read-scoped', () => {
    const def = EXPANDED_TOOL_DEFS.find((d: any) => d.name === 'memory_file') as any;
    assert.ok(def, 'in EXPANDED_TOOL_DEFS');
    assert.equal(def.annotations.readOnlyHint, true);
    assert.deepEqual(def.inputSchema.required, ['project_id', 'filename']);
    assert.equal(typeof EXPANDED_HANDLERS['memory_file'], 'function', 'in EXPANDED_HANDLERS');
    assert.equal(TOOL_SCOPES['memory_file'], 'read');
  });

  it('memory_write is advertised as a write tool, dispatchable, and write-scoped', () => {
    const def = EXPANDED_TOOL_DEFS.find((d: any) => d.name === 'memory_write') as any;
    assert.ok(def, 'in EXPANDED_TOOL_DEFS');
    assert.equal(def.annotations.readOnlyHint, false);
    assert.deepEqual(def.inputSchema.required, ['action', 'project_id', 'filename']);
    assert.equal(def.inputSchema.properties.action.enum.join(','), 'create,update,delete');
    assert.equal(typeof EXPANDED_HANDLERS['memory_write'], 'function', 'in EXPANDED_HANDLERS');
    assert.equal(TOOL_SCOPES['memory_write'], 'write');
  });

  it('does not introduce a rule_write tool (non-goal: rules stay read-only over MCP)', () => {
    const def = EXPANDED_TOOL_DEFS.find((d: any) => d.name === 'rule_write');
    assert.equal(def, undefined);
    assert.equal(EXPANDED_HANDLERS['rule_write'], undefined);
  });

  it('assertScopesCoverTools does not throw (every advertised tool, incl. the two new ones, has a scope)', () => {
    assert.doesNotThrow(() => assertScopesCoverTools());
  });
});

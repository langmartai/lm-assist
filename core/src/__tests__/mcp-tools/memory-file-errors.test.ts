import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classifyMemoryReadFailure } from '../../mcp-server/tools/expanded';

/**
 * memory_file MCP surface: every failure names its class.
 *
 * The reported symptom was a bare "MCP tool call failed" with no structured
 * error, which was read as a payload-size / relay-timeout cutoff. It was
 * actually a 0ms PROJECT_NOT_FOUND — but the CALLER could not tell, because
 * workerGet's unwrapEnvelope keeps only error.message and drops error.code,
 * and a transport failure produced prose indistinguishable from a bad argument.
 *
 * So the contract under test is: a caller can always tell (a) what class of
 * failure this was, and (b) whether retrying — or changing an argument — is
 * what helps. Same discipline as ORIGIN_TIMEOUT vs ORIGIN_UNREACHABLE on the
 * backlog write path.
 */

const ROUTE = '/memory/by-project/lm-assist/file/MEMORY.md?source=live';

describe('classifyMemoryReadFailure', () => {
  test('a timeout is named READ_TIMEOUT and says a retry is safe', () => {
    const e = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const msg = classifyMemoryReadFailure(e, ROUTE);
    assert.match(msg, /^\[READ_TIMEOUT\]/);
    assert.match(msg, /retry is safe/i, 'a read is idempotent — say so');
    assert.match(msg, /project_id will not help/i, 'steer away from the wrong fix');
  });

  test('an AbortError is a timeout too (fetch surfaces both names)', () => {
    const e = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    assert.match(classifyMemoryReadFailure(e, ROUTE), /^\[READ_TIMEOUT\]/);
  });

  test('a refused connection is CORE_UNREACHABLE and states nothing was read', () => {
    const e = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:3100');
    const msg = classifyMemoryReadFailure(e, ROUTE);
    assert.match(msg, /^\[CORE_UNREACHABLE\]/);
    assert.match(msg, /NOTHING was read/, 'unreachable must be unambiguous about the outcome');
    assert.match(msg, /lm-assist start/, 'name the actual remedy');
  });

  test('timeout and unreachable are never conflated', () => {
    const timeout = classifyMemoryReadFailure(
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }), ROUTE);
    const unreachable = classifyMemoryReadFailure(new Error('connect ECONNREFUSED'), ROUTE);
    assert.notEqual(timeout.slice(0, 20), unreachable.slice(0, 20));
  });

  test('an unrecognized failure still carries its message, never an empty error', () => {
    const msg = classifyMemoryReadFailure(new Error('something exotic'), ROUTE);
    assert.match(msg, /^\[MEMORY_FILE_ERROR\]/);
    assert.match(msg, /something exotic/);
  });

  test('a non-Error throw does not produce "[object Object]" or a crash', () => {
    const msg = classifyMemoryReadFailure({ weird: true }, ROUTE);
    assert.match(msg, /^\[MEMORY_FILE_ERROR\]/);
    assert.ok(msg.length > '[MEMORY_FILE_ERROR] '.length, 'must say something');
  });
});

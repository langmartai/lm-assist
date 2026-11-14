/**
 * elevated_exec command-line assembly — the guard for the 2026-09 operator
 * finding: args were `join(' ')`-ed raw for cmd.exe, so an arg containing a
 * space split into two words and an arg of `|` became a live pipe; the only
 * workaround was pre-quoting the whole remote command into `cmd`.
 *
 * Contract: `cmd` verbatim (it IS the shell line), each arg quoted per-arg.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { quoteCmdArg, quoteArgvArg, quotePwshArg, buildShellCommandLine, shellSpawn, type ElevatedShell } from '../elevated/common';

/** Run `cmd` + `args` exactly the way the worker does (build the line, then shellSpawn). */
function runLikeWorker(cmd: string, args: string[], shell: ElevatedShell, cwd?: string): { status: number | null; out: string } {
  const how = shellSpawn(buildShellCommandLine(cmd, args, shell), shell);
  const r = spawnSync(how.file, how.args, { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: how.windowsVerbatimArguments, cwd });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
// What each shell hands its arguments to. cmd.exe: a native program, so the argv layer is exercised
// too. PowerShell: a script block — PowerShell 5.1's own native-argument passing mangles embedded
// quotes whatever we do, so the part WE own (quotePwshArg → a PowerShell literal) is checked there.
const PRINT_ARGV: Record<ElevatedShell, string> = {
  cmd: `"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))"`,
  powershell: '& { ConvertTo-Json -Compress -InputObject @($args) }',
};

test('END TO END through the real shell: args arrive intact, cmd syntax still works', { skip: process.platform !== 'win32' }, () => {
  // `q"uote` BEFORE `a>b` is the case that broke plain quoting: the embedded quote flipped cmd's
  // quote state and `>` became a redirect. `%OS%` must arrive literally.
  const tricky = ['a b', 'x|y', 'q"uote', 'a>b', 'plain', '%OS%', '(p)', 'car^et', 'b!ng', 'C:\\dir with space\\'];
  for (const shell of ['cmd', 'powershell'] as const) {
    const r = runLikeWorker(PRINT_ARGV[shell], tricky, shell);
    assert.equal(r.status, 0, `${shell}: ${r.out}`);
    assert.deepEqual(JSON.parse(r.out.split(/\r?\n/).pop()!), tricky, `${shell} argv round-trip`);
  }
  // cmd.exe: a quoted wildcard arg and shell syntax written into `cmd` both work (the old /c spawn
  // re-escaped every quote — `dir /b "*.json"` failed with "syntax is incorrect").
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elev-'));
  fs.writeFileSync(path.join(dir, 'one.json'), '{}');
  assert.equal(runLikeWorker('dir /b', ['*.json'], 'cmd', dir).out, 'one.json');
  assert.equal(runLikeWorker('echo left| findstr left', [], 'cmd').out, 'left');
});

test('cmd.exe: plain tokens pass through; cmd itself is never touched', () => {
  assert.equal(buildShellCommandLine('sc', ['query', 'LmAssistCore'], 'cmd'), 'sc query LmAssistCore');
  // shell syntax the caller wrote INTO cmd keeps working (pipes, redirects, &&)
  assert.equal(buildShellCommandLine('dir C:\\ | findstr Users > out.txt && echo ok', [], 'cmd'), 'dir C:\\ | findstr Users > out.txt && echo ok');
  const pre = 'ssh host "bash -c \\"ls -la | head\\""';
  assert.equal(buildShellCommandLine(pre, [], 'cmd'), pre);
});

test('cmd.exe: an arg with a space is ONE argument, an arg of | > & is data not syntax', () => {
  // layer 1 (the program's argv) is quoted; layer 2 caret-escapes every cmd metacharacter of it
  assert.equal(quoteCmdArg('hello world'), '^"hello world^"');
  assert.equal(quoteCmdArg('|'), '^"^|^"');
  assert.equal(quoteCmdArg('a>b'), '^"a^>b^"');
  assert.equal(quoteCmdArg('x&y'), '^"x^&y^"');
  assert.equal(quoteCmdArg('%OS%'), '^"^%OS^%^"', '%VAR% in an arg is literal data');
  assert.equal(quoteCmdArg(''), '^"^"');
  assert.equal(
    buildShellCommandLine('ssh', ['host', 'bash -c "ls -la | head"'], 'cmd'),
    'ssh host ^"bash -c \\^"ls -la ^| head\\^"^"',
  );
});

test('argv layer: embedded quotes and backslash runs follow CommandLineToArgvW', () => {
  assert.equal(quoteArgvArg('say "hi"'), '"say \\"hi\\""');
  // a backslash run before a quote is doubled, then the quote escaped
  assert.equal(quoteArgvArg('C:\\dir\\"q'), '"C:\\dir\\\\\\"q"');
  // trailing backslashes before the closing quote are doubled so they do not escape it
  assert.equal(quoteArgvArg('C:\\Program Files\\'), '"C:\\Program Files\\\\"');
  // a plain path with backslashes needs no quoting at all
  assert.equal(quoteArgvArg('C:\\Users\\admin'), 'C:\\Users\\admin');
  assert.equal(quoteCmdArg('C:\\Users\\admin'), 'C:\\Users\\admin');
});

test('powershell: single-quoted literals with doubled quotes', () => {
  assert.equal(quotePwshArg('hello world'), "'hello world'");
  assert.equal(quotePwshArg("it's"), "'it''s'");
  assert.equal(quotePwshArg('|'), "'|'");
  assert.equal(quotePwshArg(''), "''");
  assert.equal(buildShellCommandLine('Get-Service', ['-Name', 'lm assist'], 'powershell'), "Get-Service -Name 'lm assist'");
});

test('no args → cmd unchanged, no trailing space', () => {
  assert.equal(buildShellCommandLine('whoami', [], 'cmd'), 'whoami');
  assert.equal(buildShellCommandLine('whoami', [], 'powershell'), 'whoami');
});

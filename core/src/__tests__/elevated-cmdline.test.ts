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
import { quoteCmdArg, quotePwshArg, buildShellCommandLine } from '../elevated/common';

test('cmd.exe: plain tokens pass through; cmd itself is never touched', () => {
  assert.equal(buildShellCommandLine('sc', ['query', 'LmAssistCore'], 'cmd'), 'sc query LmAssistCore');
  // shell syntax the caller wrote INTO cmd keeps working (pipes, redirects, &&)
  assert.equal(buildShellCommandLine('dir C:\\ | findstr Users > out.txt && echo ok', [], 'cmd'), 'dir C:\\ | findstr Users > out.txt && echo ok');
  const pre = 'ssh host "bash -c \\"ls -la | head\\""';
  assert.equal(buildShellCommandLine(pre, [], 'cmd'), pre);
});

test('cmd.exe: an arg with a space is ONE argument, an arg of | > & is data not syntax', () => {
  assert.equal(quoteCmdArg('hello world'), '"hello world"');
  assert.equal(quoteCmdArg('|'), '"|"');
  assert.equal(quoteCmdArg('a>b'), '"a>b"');
  assert.equal(quoteCmdArg('x&y'), '"x&y"');
  assert.equal(quoteCmdArg(''), '""');
  assert.equal(
    buildShellCommandLine('ssh', ['host', 'bash -c "ls -la | head"'], 'cmd'),
    'ssh host "bash -c \\"ls -la | head\\""',
  );
});

test('cmd.exe: embedded quotes and backslash runs follow CommandLineToArgvW', () => {
  assert.equal(quoteCmdArg('say "hi"'), '"say \\"hi\\""');
  // a backslash run before a quote is doubled, then the quote escaped
  assert.equal(quoteCmdArg('C:\\dir\\"q'), '"C:\\dir\\\\\\"q"');
  // trailing backslashes before the closing quote are doubled so they do not escape it
  assert.equal(quoteCmdArg('C:\\Program Files\\'), '"C:\\Program Files\\\\"');
  // a plain path with backslashes needs no quoting at all
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

/**
 * VM service validation — the layer between caller args and PRIVILEGED
 * hypervisor commands. Names/snapshots/paths validated here are embedded in
 * elevated PowerShell / virsh invocations, so the charset rules are a security
 * boundary: these tests pin them.
 *
 * No hypervisor is touched — validation is pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVmName, validateCreateArgs, validatePathArg } from '../vm/service';
import { isUnderRoot } from '../vm/hyperv-backend';
import { isUnderRootPosix } from '../vm/kvm-backend';
import { VmError } from '../vm/types';

const IS_WIN = process.platform === 'win32';

test('validateVmName accepts the managed charset', () => {
  assert.equal(validateVmName('lmvm-e2e-test'), 'lmvm-e2e-test');
  assert.equal(validateVmName('a'), 'a');
  assert.equal(validateVmName('A.b_c-9'), 'A.b_c-9');
  assert.equal(validateVmName('  trimmed  '), 'trimmed');
});

test('validateVmName rejects quoting/expansion and traversal shapes', () => {
  const bad = [
    "x'; Stop-VM -Name '*",
    'a b', // space
    'a$(rm)',
    'a`whoami`',
    'a"b',
    "a'b",
    '..',
    '.',
    '',
    'x'.repeat(65),
    'a/b',
    'a\\b',
    null,
    undefined,
  ];
  for (const v of bad) {
    assert.throws(() => validateVmName(v as unknown), (e: unknown) => e instanceof VmError && e.code === 'BAD_ARGS', `should reject ${String(v)}`);
  }
});

test('validateCreateArgs applies defaults and range checks', () => {
  const spec = validateCreateArgs({ name: 'vmx' });
  assert.equal(spec.cpus, 1);
  assert.equal(spec.memoryMB, 1024);
  assert.equal(spec.diskGB, 10);
  assert.equal(spec.generation, 2);
  assert.ok(spec.storageRoot.length > 0);
  assert.equal(spec.isoPath, undefined);

  assert.throws(() => validateCreateArgs({ name: 'vmx', cpus: 0 }), /cpus/);
  assert.throws(() => validateCreateArgs({ name: 'vmx', memoryMB: 8 }), /memoryMB/);
  assert.throws(() => validateCreateArgs({ name: 'vmx', diskGB: 1.5 }), /diskGB/);
  assert.throws(() => validateCreateArgs({ name: 'vmx', generation: 3 }), /generation/);
});

test('validateCreateArgs network: null means none; charset is enforced', () => {
  assert.equal(validateCreateArgs({ name: 'vmx', network: null }).network, null);
  assert.equal(validateCreateArgs({ name: 'vmx', network: 'Default Switch' }).network, 'Default Switch');
  assert.equal(validateCreateArgs({ name: 'vmx' }).network, undefined);
  assert.throws(() => validateCreateArgs({ name: 'vmx', network: "x' -Bad" }), /network/);
});

test('validateCreateArgs sanitizes notes for privileged embedding', () => {
  const spec = validateCreateArgs({ name: 'vmx', notes: "line1\nline2 'quoted' \"dq\" `tick` $var" });
  assert.ok(spec.notes);
  assert.ok(!spec.notes!.includes("'"), 'straight single quotes must not survive');
  assert.ok(!spec.notes!.includes('"'), 'double quotes must not survive');
  assert.ok(!spec.notes!.includes('`'));
  assert.ok(!spec.notes!.includes('$'));
  assert.ok(!spec.notes!.includes('\n'));
});

test('validatePathArg enforces absolute + safe charset per platform', () => {
  if (IS_WIN) {
    assert.equal(validatePathArg('C:\\lm-vms', 'p'), 'C:\\lm-vms');
    assert.throws(() => validatePathArg('relative\\path', 'p'), (e: unknown) => e instanceof VmError && e.code === 'UNSAFE_PATH');
    assert.throws(() => validatePathArg("C:\\x'y", 'p'), (e: unknown) => e instanceof VmError && e.code === 'UNSAFE_PATH');
    assert.throws(() => validatePathArg('C:\\a\\..\\b', 'p'), (e: unknown) => e instanceof VmError && e.code === 'UNSAFE_PATH');
  } else {
    assert.equal(validatePathArg('/var/lib/lm-vms', 'p'), '/var/lib/lm-vms');
    assert.throws(() => validatePathArg('relative/path', 'p'), (e: unknown) => e instanceof VmError && e.code === 'UNSAFE_PATH');
    assert.throws(() => validatePathArg("/x'y", 'p'), (e: unknown) => e instanceof VmError && e.code === 'UNSAFE_PATH');
  }
});

test('disk-deletion containment: only paths under the root qualify', () => {
  if (IS_WIN) {
    assert.equal(isUnderRoot('C:\\lm-vms', 'C:\\lm-vms\\vmx\\vmx.vhdx'), true);
    assert.equal(isUnderRoot('C:\\lm-vms', 'c:\\LM-VMS\\vmx\\vmx.vhdx'), true, 'case-insensitive on Windows');
    assert.equal(isUnderRoot('C:\\lm-vms', 'C:\\Windows\\system32\\config'), false);
    assert.equal(isUnderRoot('C:\\lm-vms', 'C:\\lm-vms'), false, 'the root itself is not deletable');
    assert.equal(isUnderRoot('C:\\lm-vms', 'C:\\lm-vms-evil\\x.vhdx'), false, 'sibling prefix must not match');
    assert.equal(isUnderRoot('C:\\lm-vms', 'D:\\lm-vms\\x.vhdx'), false);
  }
  assert.equal(isUnderRootPosix('/var/lib/lm-vms', '/var/lib/lm-vms/vmx/vmx.qcow2'), true);
  assert.equal(isUnderRootPosix('/var/lib/lm-vms', '/etc/passwd'), false);
  assert.equal(isUnderRootPosix('/var/lib/lm-vms', '/var/lib/lm-vms'), false);
  assert.equal(isUnderRootPosix('/var/lib/lm-vms', '/var/lib/lm-vms-evil/x'), false);
});

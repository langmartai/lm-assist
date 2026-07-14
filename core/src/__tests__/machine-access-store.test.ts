import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  validateProfile,
  loadMachineAccess,
  listMachines,
  getMachine,
  upsertMachine,
  removeMachine,
  buildSshCommand,
  toReportedMachine,
  setLastCheck,
  type MachineProfile,
  type SshAccess,
} from '../machine-access/store';

const ssh = (over: Partial<SshAccess> = {}): SshAccess => ({
  type: 'ssh',
  host: '10.0.1.123',
  user: 'yi',
  ...over,
});

const profile = (over: Partial<MachineProfile> = {}): MachineProfile => ({
  id: 'yitest',
  name: 'yitest VM',
  access: [ssh()],
  ...over,
});

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-store-'));
  return path.join(dir, 'machine-access.json');
}

describe('validateProfile', () => {
  it('accepts a minimal ssh profile', () => {
    assert.equal(validateProfile(profile()), null);
  });
  it('accepts full real-world shape (tags, notes, port, identityFile)', () => {
    assert.equal(
      validateProfile(profile({
        description: 'capture VM',
        os: 'linux',
        tags: ['lan', 'lm-assist-node'],
        notes: 'passwordless sudo',
        access: [ssh({ port: 22, identityFile: '~/.ssh/ssh-keys/id_rsa', notes: 'key' })],
      })),
      null,
    );
  });
  it('rejects non-objects and missing fields', () => {
    assert.match(validateProfile(null) ?? '', /object/);
    assert.match(validateProfile(profile({ id: 'Bad ID!' })) ?? '', /id/);
    assert.match(validateProfile(profile({ name: '' })) ?? '', /name/);
    assert.match(validateProfile(profile({ access: [] })) ?? '', /access/);
  });
  it('rejects bad ssh entries', () => {
    assert.match(validateProfile(profile({ access: [ssh({ host: '' })] })) ?? '', /host/);
    assert.match(validateProfile(profile({ access: [ssh({ user: '' })] })) ?? '', /user/);
    assert.match(validateProfile(profile({ access: [ssh({ port: 70000 })] })) ?? '', /port/);
    assert.match(validateProfile(profile({ access: [ssh({ port: 2.5 })] })) ?? '', /port/);
  });
  it('rejects identityFile that looks like key material (path only, never keys)', () => {
    assert.match(
      validateProfile(profile({ access: [ssh({ identityFile: '-----BEGIN PRIVATE KEY-----' })] })) ?? '',
      /identityFile/,
    );
    assert.match(
      validateProfile(profile({ access: [ssh({ identityFile: 'a\nb' })] })) ?? '',
      /identityFile/,
    );
  });
  it('accepts unknown access types (forward compat) but requires a type string', () => {
    assert.equal(validateProfile(profile({ access: [{ type: 'windows-account', host: 'h' }] })), null);
    assert.match(validateProfile(profile({ access: [{ host: 'h' } as never] })) ?? '', /type/);
  });

  it('rejects host/user with whitespace, shell metachars, or a leading dash (injection guard)', () => {
    assert.match(validateProfile(profile({ access: [ssh({ host: '-oProxyCommand=x' })] })) ?? '', /host/);
    assert.match(validateProfile(profile({ access: [ssh({ host: 'a b' })] })) ?? '', /host/);
    assert.match(validateProfile(profile({ access: [ssh({ host: 'a;rm -rf' })] })) ?? '', /host/);
    assert.match(validateProfile(profile({ access: [ssh({ user: '-x' })] })) ?? '', /user/);
    assert.match(validateProfile(profile({ access: [ssh({ user: 'a b' })] })) ?? '', /user/);
    assert.match(validateProfile(profile({ access: [ssh({ identityFile: '-i/bad' })] })) ?? '', /identityFile/);
  });

  it('accepts real hostnames, IPv4, IPv6, and dotted users', () => {
    assert.equal(validateProfile(profile({ access: [ssh({ host: 'sg.example.com' })] })), null);
    assert.equal(validateProfile(profile({ access: [ssh({ host: '213.35.107.246' })] })), null);
    assert.equal(validateProfile(profile({ access: [ssh({ host: 'fe80::1' })] })), null);
    assert.equal(validateProfile(profile({ access: [ssh({ user: 'opc.admin_1' })] })), null);
  });

  it('rejects tags with metachars', () => {
    assert.match(validateProfile(profile({ tags: ['ok', 'bad tag'] })) ?? '', /tag/);
  });
});

describe('store CRUD round-trip', () => {
  let file: string;
  beforeEach(() => { file = tmpFile(); });

  it('missing file → empty store', () => {
    assert.deepEqual(loadMachineAccess(file), { version: 1, machines: [] });
  });
  it('corrupt file → empty store (no throw)', () => {
    fs.writeFileSync(file, '{nope', 'utf-8');
    assert.deepEqual(loadMachineAccess(file).machines, []);
  });
  it('upsert → list → get → update → remove', () => {
    const created = upsertMachine(profile(), file);
    assert.ok(created.createdAt);
    assert.ok(created.updatedAt);
    assert.equal(listMachines(file).length, 1);
    assert.equal(getMachine('yitest', file)?.name, 'yitest VM');

    const updated = upsertMachine(profile({ name: 'yitest (123)' }), file);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(listMachines(file).length, 1);
    assert.equal(getMachine('yitest', file)?.name, 'yitest (123)');

    assert.equal(removeMachine('yitest', file), true);
    assert.equal(removeMachine('yitest', file), false);
    assert.equal(listMachines(file).length, 0);
  });
  it('upsert of invalid profile throws and writes nothing', () => {
    assert.throws(() => upsertMachine(profile({ access: [] }), file), /access/);
    assert.equal(fs.existsSync(file), false);
  });
  it('unknown access types and unknown top-level keys survive save', () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      customTopLevel: { keep: true },
      machines: [profile({ id: 'win', access: [{ type: 'windows-account', host: 'h' }] })],
    }), 'utf-8');
    upsertMachine(profile(), file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.deepEqual(raw.customTopLevel, { keep: true });
    assert.equal(raw.machines.find((m: { id: string }) => m.id === 'win').access[0].type, 'windows-account');
  });
});

describe('buildSshCommand', () => {
  it('minimal', () => {
    assert.equal(buildSshCommand(ssh()), 'ssh yi@10.0.1.123');
  });
  it('with identityFile and non-default port', () => {
    assert.equal(
      buildSshCommand(ssh({ identityFile: '~/.ssh/k', port: 2222 })),
      'ssh -i ~/.ssh/k -p 2222 yi@10.0.1.123',
    );
  });
  it('default port 22 omitted', () => {
    assert.equal(buildSshCommand(ssh({ port: 22 })), 'ssh yi@10.0.1.123');
  });
});

describe('toReportedMachine', () => {
  it('derives command for ssh, flags unknown types unsupported', () => {
    const r = toReportedMachine(profile({
      access: [ssh({ identityFile: '~/.ssh/k' }), { type: 'windows-account', host: 'h' }],
    }));
    assert.equal(r.enabled, true);
    assert.equal((r.access[0] as { command?: string }).command, 'ssh -i ~/.ssh/k yi@10.0.1.123');
    assert.equal((r.access[0] as { supported?: boolean }).supported, true);
    assert.equal((r.access[1] as { supported?: boolean }).supported, false);
    assert.equal((r.access[1] as { command?: string }).command, undefined);
  });
  it('enabled:false is preserved', () => {
    assert.equal(toReportedMachine(profile({ enabled: false })).enabled, false);
  });

  it('never throws on a malformed profile — flags it instead', () => {
    // access missing entirely (hand-edited file)
    const noAccess = toReportedMachine({ id: 'x', name: 'X' } as unknown as MachineProfile);
    assert.deepEqual(noAccess.access, []);
    assert.match(noAccess.reportError ?? '', /access/);
    // an ssh entry that fails validation → supported:false + invalid reason, NEVER a command
    const bad = toReportedMachine(profile({ access: [ssh({ host: '-oProxyCommand=x' })] }));
    assert.equal((bad.access[0] as { supported?: boolean }).supported, false);
    assert.equal((bad.access[0] as { command?: string }).command, undefined);
    assert.match((bad.access[0] as { invalid?: string }).invalid ?? '', /host/);
  });

  it('passes lastCheck through to the report', () => {
    const r = toReportedMachine(profile({ lastCheck: { status: 'ok', at: '2026-07-14T00:00:00Z' } } as Partial<MachineProfile>));
    assert.equal((r as { lastCheck?: { status: string } }).lastCheck?.status, 'ok');
  });
});

describe('file hygiene', () => {
  let file: string;
  beforeEach(() => { file = tmpFile(); });

  it('writes the store file with 0600 perms', () => {
    upsertMachine(profile(), file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
  it('keeps a one-deep .bak on overwrite', () => {
    upsertMachine(profile({ name: 'first' }), file);
    assert.equal(fs.existsSync(`${file}.bak`), false); // no prior version on first write
    upsertMachine(profile({ name: 'second' }), file);
    assert.ok(fs.existsSync(`${file}.bak`));
    assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf-8')).machines[0].name, 'first');
  });
});

describe('setLastCheck', () => {
  let file: string;
  beforeEach(() => { file = tmpFile(); });

  it('records a probe result without bumping updatedAt', () => {
    const created = upsertMachine(profile(), file);
    const ok = setLastCheck('yitest', { status: 'ok', at: '2026-07-14T12:00:00Z' }, file);
    assert.equal(ok, true);
    const after = getMachine('yitest', file)!;
    assert.equal(after.updatedAt, created.updatedAt); // a probe is NOT an edit
    assert.equal((after as { lastCheck?: { status: string } }).lastCheck?.status, 'ok');
  });
  it('returns false for an unknown id', () => {
    assert.equal(setLastCheck('nope', { status: 'ok', at: 'x' }, file), false);
  });
});

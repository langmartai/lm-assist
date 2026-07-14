import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSshConfig, buildImportCandidates } from '../machine-access/ssh-config';

const CONFIG = `
# a comment
Host github.com
  IdentityFile ~/.ssh/gh_key
  User git

Host sg jp
  HostName 213.35.107.246
  User opc
  Port 22
  IdentityFile ~/.ssh/ssh-keys/id_rsa

Host build-*
  User deploy

Host weirdName_1
  HostName 10.0.1.50
`;

describe('parseSshConfig', () => {
  it('parses concrete hosts, expands multi-alias, skips wildcard blocks', () => {
    const hosts = parseSshConfig(CONFIG);
    const aliases = hosts.map((h) => h.alias);
    assert.deepEqual(aliases.sort(), ['github.com', 'jp', 'sg', 'weirdName_1']);
    const sg = hosts.find((h) => h.alias === 'sg')!;
    assert.equal(sg.hostName, '213.35.107.246');
    assert.equal(sg.user, 'opc');
    assert.equal(sg.port, 22);
    assert.equal(sg.identityFile, '~/.ssh/ssh-keys/id_rsa');
    // jp shares the sg block's settings
    assert.equal(hosts.find((h) => h.alias === 'jp')!.hostName, '213.35.107.246');
    // wildcard block excluded
    assert.equal(hosts.some((h) => h.alias.includes('build')), false);
  });

  it('is case-insensitive on keys and tolerates = and extra whitespace', () => {
    const hosts = parseSshConfig('Host x\n  hostname=example.com\n  PORT   2222\n');
    assert.equal(hosts[0].hostName, 'example.com');
    assert.equal(hosts[0].port, 2222);
  });

  it('empty / no-host config → []', () => {
    assert.deepEqual(parseSshConfig(''), []);
    assert.deepEqual(parseSshConfig('# only comments\n'), []);
  });
});

describe('buildImportCandidates', () => {
  it('builds enabled:false imported drafts; falls back to defaultUser; drops invalid', () => {
    const hosts = parseSshConfig(CONFIG);
    const { candidates, skippedInvalid } = buildImportCandidates(hosts, { defaultUser: 'ubuntu' });
    const sg = candidates.find((c) => c.id === 'sg')!;
    assert.equal(sg.enabled, false);
    assert.deepEqual(sg.tags, ['imported']);
    assert.equal(sg.access[0].type, 'ssh');
    assert.equal((sg.access[0] as { host: string }).host, '213.35.107.246');
    assert.equal((sg.access[0] as { user: string }).user, 'opc');
    // github.com has no HostName → falls back to alias as host; no User in... actually it has User git
    const gh = candidates.find((c) => c.id === 'github.com');
    assert.ok(gh, 'github.com should be a candidate (host falls back to alias)');
    assert.equal((gh!.access[0] as { user: string }).user, 'git');
    // weirdName_1 has no User → defaultUser
    const w = candidates.find((c) => c.id === 'weirdname_1');
    assert.ok(w, 'weirdName_1 slugified to weirdname_1');
    assert.equal((w!.access[0] as { user: string }).user, 'ubuntu');
    assert.ok(Array.isArray(skippedInvalid));
  });

  it('drops a host whose derived fields fail validation', () => {
    const { candidates, skippedInvalid } = buildImportCandidates(
      [{ alias: 'bad', hostName: '-oProxyCommand=x', user: 'ok' }],
      { defaultUser: 'ubuntu' },
    );
    assert.equal(candidates.length, 0);
    assert.equal(skippedInvalid.length, 1);
    assert.match(skippedInvalid[0].reason, /host/);
  });
});

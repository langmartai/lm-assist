import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProcMounts, formatStorage, collectNics, formatNetwork, type VolumeInfo } from '../status/host-resources';
import type { NetworkInterfaceInfo } from 'os';

/**
 * Host storage/network status providers — pure formatting + parsing. The live
 * fs.statfs / os.networkInterfaces paths are exercised by e2e (node_status).
 */

test('parseProcMounts keeps real mounts, drops pseudo filesystems + dupes', () => {
  const txt = [
    '/dev/sda1 / ext4 rw,relatime 0 0',
    'proc /proc proc rw 0 0',
    'tmpfs /run tmpfs rw 0 0',
    'sysfs /sys sysfs rw 0 0',
    '/dev/sda2 /home ext4 rw 0 0',
    '/dev/sdb1 /mnt/data\\040disk ext4 rw 0 0', // space-escaped mount
    'cgroup2 /sys/fs/cgroup cgroup2 rw 0 0',
    '/dev/sda1 /var/snap/firefox/common/host-hunspell ext4 rw 0 0', // snap bind-mount noise
    '/dev/sda1 / ext4 rw 0 0', // dup of /
  ].join('\n');
  assert.deepStrictEqual(parseProcMounts(txt), ['/', '/home', '/mnt/data disk']);
});

test('formatStorage summarizes usage and escalates verdict on a full disk', () => {
  const vols: VolumeInfo[] = [
    { mount: '/', totalGb: 100, usedGb: 40, freeGb: 60, usedPct: 40 },
    { mount: '/data', totalGb: 200, usedGb: 20, freeGb: 180, usedPct: 10 },
  ];
  const ok = formatStorage(vols);
  assert.strictEqual(ok.verdict, 'ok');
  assert.match(ok.summary, /2 volume\(s\)/);
  assert.match(ok.summary, /busiest \/ at 40%/);
  assert.strictEqual(formatStorage([{ mount: '/', totalGb: 100, usedGb: 92, freeGb: 8, usedPct: 92 }]).verdict, 'warn');
  assert.strictEqual(formatStorage([{ mount: '/', totalGb: 100, usedGb: 97, freeGb: 3, usedPct: 97 }]).verdict, 'error');
  assert.strictEqual(formatStorage([]).verdict, 'warn');
});

test('collectNics skips loopback and normalizes family', () => {
  const ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
    eth0: [
      { address: '10.0.1.117', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '10.0.1.117/24' },
      { address: 'fe80::1', netmask: 'ffff::', family: 'IPv6', mac: 'aa:bb:cc:dd:ee:ff', internal: false, scopeid: 2, cidr: 'fe80::1/64' },
    ],
  };
  const nics = collectNics(ifaces);
  assert.strictEqual(nics.length, 2); // loopback dropped
  assert.deepStrictEqual(nics[0], { name: 'eth0', address: '10.0.1.117', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff' });
  assert.strictEqual(nics[1].family, 'IPv6');
});

test('formatNetwork surfaces the host + IPv4 addresses', () => {
  const r = formatNetwork('ubuntu-Virtual-Machine', [
    { name: 'eth0', address: '10.0.1.117', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff' },
  ]);
  assert.strictEqual(r.verdict, 'ok');
  assert.match(r.summary, /ubuntu-Virtual-Machine — eth0 10\.0\.1\.117/);
  assert.strictEqual(formatNetwork('h', []).verdict, 'warn'); // no external IPv4
});

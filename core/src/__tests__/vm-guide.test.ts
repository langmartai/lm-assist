import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE_HANDLERS, GUIDES_TEST_EXPORT, BOOTSTRAP_SECTION_ORDER } from '../mcp-server/tools/guide';
import { playbookTopicForTool } from '../mcp-server/tool-topics';

const guide = (args: Record<string, unknown>) => GUIDE_HANDLERS.guide(args);
const text = async (args: Record<string, unknown>) => (await guide(args)).content[0].text as string;

const VM_TOOLS = ['vm_status', 'vm_create', 'vm_power', 'vm_snapshot', 'vm_delete'];

test('GUIDES_TEST_EXPORT contains a "vm" entry', () => {
  assert.ok('vm' in GUIDES_TEST_EXPORT, 'GUIDES map must have a vm key');
});

test('guide("vm") names all five tools, both hypervisors, and the privilege paths', async () => {
  const t = await text({ topic: 'vm' });
  for (const tool of VM_TOOLS) assert.match(t, new RegExp(tool), `must mention ${tool}`);
  assert.match(t, /Hyper-V/, 'must name Hyper-V (Windows)');
  assert.match(t, /KVM|libvirt/, 'must name KVM/libvirt (Linux)');
  assert.match(t, /direct/, 'must describe the direct privilege path');
  assert.match(t, /worker/, 'must describe the Windows elevated-worker path');
  assert.match(t, /sudo/, 'must describe the Linux sudo path');
});

test('guide("vm") carries the single-node vs cross-node rule and the storage/nested-VM caveat', async () => {
  const t = await text({ topic: 'vm' });
  assert.match(t, /node=/, 'must explain node targeting');
  assert.match(t, /list_nodes/, 'must point at list_nodes before concluding a VM is absent');
  assert.match(t, /storageRoot|storage root/i, 'must explain the explicit storage root');
  assert.match(t, /512 MB|TINY/i, 'must carry the nested-VM sizing rule');
});

test('guide("vm") explains the security boundary and the managed-VM gate', async () => {
  const t = await text({ topic: 'vm' });
  assert.match(t, /\[A-Za-z0-9._-\]\{1,64\}/, 'must state the name charset');
  assert.match(t, /UNSAFE_PATH|BAD_ARGS/, 'must name the refusal codes');
  assert.match(t, /managed/, 'must explain the managed tag');
  assert.match(t, /force:true/, 'must explain force on non-managed VMs');
});

test('vm aliases + every vm_* tool name resolve to the vm topic', async () => {
  for (const alias of ['vm', 'hyper-v', 'kvm', 'libvirt', 'hypervisor', 'virtual-machine']) {
    const t = await text({ topic: alias });
    assert.match(t, /Guide: vm/, `alias "${alias}" must resolve to the vm guide`);
  }
  for (const tool of VM_TOOLS) {
    assert.equal(playbookTopicForTool(tool), 'vm', `${tool} must map to the vm playbook`);
    const t = await text({ topic: tool });
    assert.match(t, /Guide: vm/, `guide(topic="${tool}") must return the vm guide`);
  }
});

test('vm topic is listed in the index and is a bootstrap section', async () => {
  const t = await text({});
  assert.match(t, /`vm`/, 'index must list the vm topic');
  assert.ok(BOOTSTRAP_SECTION_ORDER.includes('vm'), 'vm must be part of bootstrap');
});

test('bootstrap surfaces the vm guide across its pages (discoverability requirement)', async () => {
  const first = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  assert.match(first, /`vm`[^\n]*\(p\d+\)/, 'manifest lists vm with a page number');
  const m = first.match(/page 1 of (\d+)/i);
  const n = m ? parseInt(m[1], 10) : 1;
  let all = first;
  for (let p = 2; p <= n; p++) all += (await GUIDE_HANDLERS.bootstrap({ page: p })).content[0].text as string;
  assert.match(all, /Guide: vm/, 'some bootstrap page carries the vm guide body');
  assert.match(all, /vm_create/, 'bootstrap surfaces the vm_create capability');
});

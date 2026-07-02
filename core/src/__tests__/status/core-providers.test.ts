// core/src/__tests__/status/core-providers.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { registerCoreStatusProviders, getStatusSnapshot } from '../../status/status-registry';

test('registerCoreStatusProviders is idempotent and registers services/hub/fabric with valid shapes', async () => {
  registerCoreStatusProviders();
  registerCoreStatusProviders(); // second call must not throw (idempotent — guarded by a module-level flag)

  const snap = await getStatusSnapshot();
  for (const name of ['services', 'hub', 'fabric']) {
    const section = snap[name];
    assert.ok(section, `missing section: ${name}`);
    assert.ok(['ok', 'warn', 'error'].includes(section.verdict), `unexpected verdict for ${name}: ${section.verdict}`);
    assert.equal(typeof section.summary, 'string');
    assert.ok(section.summary.length > 0, `${name} summary should be non-empty`);
  }
});

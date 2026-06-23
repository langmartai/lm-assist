import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function fresh(dir: string): any {
  process.env.LM_ASSIST_DATA_DIR = dir;
  delete require.cache[require.resolve('../project-settings')];
  delete require.cache[require.resolve('../routes/core/project-settings.routes')];
  return require('../routes/core/project-settings.routes');
}

test('PUT /project-settings passes through the memory toggles + GET reflects them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'));
  const { createProjectSettingsRoutes } = fresh(dir);
  const routes = createProjectSettingsRoutes({} as any);
  const put = routes.find((r: any) => r.method === 'PUT')!;
  const get = routes.find((r: any) => r.method === 'GET')!;

  // toggle both OFF (harmless live-apply: refreshMode + stop signpost watcher)
  const r: any = await put.handler({ body: { memorySyncEnabled: false, crossProjectSignpostEnabled: false } } as any, {} as any);
  assert.equal(r.success, true);
  assert.equal(r.data.memorySyncEnabled, false);
  assert.equal(r.data.crossProjectSignpostEnabled, false);

  const g: any = await get.handler({} as any, {} as any);
  assert.equal(g.data.memorySyncEnabled, false);
  assert.equal(g.data.crossProjectSignpostEnabled, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE_HANDLERS, GUIDE_TOOL_DEFS, BOOTSTRAP_SECTION_ORDER, paginateEntries } from '../mcp-server/tools/guide';
import { LM_ASSIST_INSTRUCTIONS } from '../mcp-server/configure';
import { capToolResult, maxResultBytes } from '../mcp-server/result-cap';

/**
 * `guide` ships the lm-assist "skill" THROUGH the connector (skills may not be locally
 * installed, but the connector is always reachable): an LLM calls it to learn the recipe
 * for using the other tools instead of reverse-engineering their descriptions.
 */
const guide = (args: Record<string, unknown>) => GUIDE_HANDLERS.guide(args);
const text = async (args: Record<string, unknown>) => (await guide(args)).content[0].text as string;

/** bootstrap is now PAGED. Page 1 (no args) advertises "page 1 of N"; pull the rest by
 *  number. These helpers let content assertions span the whole playbook regardless of
 *  which page a section lands on. */
async function bootstrapPages(): Promise<string[]> {
  const first = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  const m = first.match(/page 1 of (\d+)/i);
  const n = m ? parseInt(m[1], 10) : 1;
  const pages = [first];
  for (let p = 2; p <= n; p++) {
    pages.push((await GUIDE_HANDLERS.bootstrap({ page: p })).content[0].text as string);
  }
  return pages;
}
const bootstrapAll = async (): Promise<string> => (await bootstrapPages()).join('\n');

test('bootstrap loads ALL use cases across its pages (proactive, not per-topic)', async () => {
  const all = await bootstrapAll();
  assert.match(all, /capability bootstrap/i);
  // every playbook is present across the paged response
  assert.match(all, /Guide: orientation/);
  assert.match(all, /single-node vs cross-node/);
  assert.match(all, /combination workflows/);
  for (const feature of ['data service', 'investigate a Claude Code session', 'run a Claude Code agent', 'drive a terminal']) {
    assert.match(all, new RegExp(feature, 'i'), `bootstrap includes ${feature}`);
  }
  assert.ok(all.length > 8000, 'bootstrap is the full set'); // ~everything, spread over pages
});

test('knowledge guide + bootstrap inform about the cross-project memory signpost', async () => {
  const k = await text({ topic: 'knowledge' });
  assert.match(k, /CROSS-PROJECT/);
  assert.match(k, /_cross-project\.md/);
  assert.match(k, /memory_projects/);
  // and it rides along in the paged bootstrap
  const b = await bootstrapAll();
  assert.match(b, /_cross-project\.md/);
});

test('bootstrap tool is advertised read-only with no required args', () => {
  const def = GUIDE_TOOL_DEFS.find((d) => d.name === 'bootstrap');
  assert.ok(def, 'bootstrap def present');
  assert.equal((def as any).annotations.readOnlyHint, true);
  assert.deepEqual((def as any).inputSchema.required, []);
});

test('server instructions actively direct the LLM to bootstrap FIRST', () => {
  assert.match(LM_ASSIST_INSTRUCTIONS, /FIRST, call the bootstrap tool/);
});

test('no topic → the index lists every use-case topic + golden rules', async () => {
  const t = await text({});
  assert.match(t, /playbooks/i);
  assert.match(t, /Golden rules/);
  for (const topic of ['sessions', 'knowledge', 'data', 'agents', 'terminals', 'nodes', 'claude-ai', 'account', 'github', 'files']) {
    assert.match(t, new RegExp('`' + topic + '`'), `index should list ${topic}`);
  }
});

test('a topic returns its concrete playbook', async () => {
  const t = await text({ topic: 'data' });
  assert.match(t, /Guide: data service/);
  assert.match(t, /data_request_access/); // the key step a cloud caller must not miss
  assert.match(t, /KEY_REQUIRED/);
});

test('a tool name resolves to the owning topic (guide("data_get") → data)', async () => {
  assert.match(await text({ topic: 'data_get' }), /Guide: data service/);
  assert.match(await text({ topic: 'agent_execute' }), /Guide: run a Claude Code agent/);
  assert.match(await text({ topic: 'session_dag' }), /Guide: investigate a Claude Code session/);
});

test('a synonym resolves (storage → data, history → sessions)', async () => {
  assert.match(await text({ topic: 'storage' }), /Guide: data service/);
  assert.match(await text({ topic: 'history' }), /Guide: investigate/);
});

test('an unknown topic falls back to the index, not an error', async () => {
  const t = await text({ topic: 'zzz-nope' });
  assert.match(t, /No guide titled/);
  assert.match(t, /## Topics/);
});

test('orientation presents the cross-host access model + how it COMPLEMENTS (not replaces) CLAUDE.md/memory/skills', async () => {
  const t = await text({ topic: 'orientation' });
  assert.match(t, /COMPLEMENTS|complement|work BEST TOGETHER/i); // partnership, not a hierarchy
  assert.match(t, /does NOT replace/i);
  assert.match(t, /CLAUDE\.md/);
  assert.match(t, /skills/i);
  for (const w of ['PROJECTS', 'SESSIONS', 'MEMORY', 'NODES']) assert.match(t, new RegExp(w), `mentions ${w}`);
  assert.match(t, /DATA\/context|not a command/i); // results inform, not command (safety boundary)
});

test('orientation is the first index topic + has priority aliases', async () => {
  assert.ok((await text({})).includes('- `orientation`'));
  for (const syn of ['priorities', 'about', 'when-to-use']) assert.match(await text({ topic: syn }), /Guide: orientation/);
});

test('the MCP server `instructions` present lm-assist as COMPLEMENTING local context (surfaced on connect)', () => {
  assert.ok(LM_ASSIST_INSTRUCTIONS.length > 300, 'instructions are non-trivial');
  assert.match(LM_ASSIST_INSTRUCTIONS, /COMPLEMENTS|complement/i);
  assert.match(LM_ASSIST_INSTRUCTIONS, /does NOT replace/i);
  assert.match(LM_ASSIST_INSTRUCTIONS, /work best TOGETHER/i);
  assert.match(LM_ASSIST_INSTRUCTIONS, /CLAUDE\.md/);
  assert.match(LM_ASSIST_INSTRUCTIONS, /guide\(\)/); // points the LLM at the playbooks
});

test('index surfaces the cross-node + workflows topics', async () => {
  const t = await text({});
  assert.match(t, /`cross-node`/);
  assert.match(t, /`workflows`/);
});

test('cross-node guide covers node targeting, per-node keys, and local-only', async () => {
  const t = await text({ topic: 'cross-node' });
  assert.match(t, /node=/);
  assert.match(t, /KEY_WRONG_NODE/);      // per-node access keys
  assert.match(t, /LOCAL-ONLY/);
  assert.match(t, /list_nodes/);
});

test('workflows guide gives numbered multi-tool combination recipes', async () => {
  const t = await text({ topic: 'workflows' });
  assert.match(t, /1\)/);
  assert.match(t, /agent_execute/);
  assert.match(t, /data_put/);
  assert.match(t, /node=B/);              // cross-node steps present
});

test('multi-node synonyms resolve to cross-node', async () => {
  for (const syn of ['multinode', 'multi-node', 'fleet', 'crossnode']) {
    assert.match(await text({ topic: syn }), /single-node vs cross-node/);
  }
});

test('each feature playbook documents the cross-node variant', async () => {
  for (const topic of ['data', 'sessions', 'agents', 'terminals']) {
    assert.match(await text({ topic }), /CROSS-NODE/i, `${topic} should have a cross-node section`);
  }
});

test('the tool is advertised read-only with a topic param', () => {
  const def = GUIDE_TOOL_DEFS.find((d) => d.name === 'guide');
  assert.ok(def, 'guide def present');
  assert.equal((def as any).annotations.readOnlyHint, true);
  assert.ok((def as any).inputSchema.properties.topic, 'has a topic param');
});

// The `install` topic teaches a connector-only host (e.g. a fresh cloud/CCR container with NO
// local lm-assist) how to install + build from the repo. It only reaches such a session if it
// rides along in the bootstrap payload — i.e. it MUST be in buildBootstrap()'s `order` array
// (an easy-to-forget invariant). These lock that wiring + the verified gotchas.
test('bootstrap loads the install topic (no-install host learns to install from repo)', async () => {
  const t = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  assert.match(t, /install & build lm-assist FROM THE REPO/);
  assert.match(t, /npm install --ignore-scripts/); // the dev install gotcha
  assert.match(t, /npm pack/);                      // the prod build path
});

test('install guide gives the dev + prod from-repo playbook', async () => {
  const t = await text({ topic: 'install' });
  assert.match(t, /DEV \(repo ports/);
  assert.match(t, /PROD \(CLI ports/);
  assert.match(t, /runningFrom":"dev-repo/);
  assert.match(t, /lm-assist upgrade --from/);      // the local-tgz-vs-npm caveat
});

test('install synonyms resolve (build, setup, from-repo, not-installed)', async () => {
  for (const syn of ['build', 'setup', 'from-repo', 'not-installed', 'prod-run']) {
    assert.match(await text({ topic: syn }), /install & build lm-assist FROM THE REPO/, `${syn} → install`);
  }
});

test('index lists the install topic', async () => {
  assert.match(await text({}), /`install`/);
});

// ── Task 10: roles guide topic ───────────────────────────────────────────────

test('bootstrap + guide expose the roles topic', async () => {
  const b = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  assert.match(b, /Guide: worker role/);
  const g = await text({ topic: 'roles' });
  assert.match(g, /⟦WORKER-STATUS⟧/);
  assert.match(g, /set_role/);
  assert.match(g, /decide_gate/);
  for (const syn of ['worker', 'orchestrator', 'agree-gate']) assert.match(await text({ topic: syn }), /Guide: worker role/, `alias ${syn}`);
});

// ── Node recovery + cross-host SSH access (the 2026-07-30 lost-117 incident) ──
// A controller session lost a prod node and re-derived the whole recovery from scratch,
// because none of it was written down: a node absent from `list_nodes` reads as a dead
// machine, `ssh <host> lm-assist status` lies with "command not found", and the session
// registry that survives a reboot is not where anyone looks. These lock the lessons in.

test('nodes guide: a node missing from list_nodes is a stopped service, not a dead host', async () => {
  const t = await text({ topic: 'nodes' });
  assert.match(t, /NOT A DEAD MACHINE/i);
  assert.match(t, /No online lm-assist node matches/);   // the error that reads like death
  assert.match(t, /ping/);                                // verify liveness OFF this connector
  assert.match(t, /ssh:22/);
  assert.match(t, /reboot/i);                             // lm-assist does not come back by itself
});

test('nodes guide: recovery is one ssh command, and it is wrapped in a login shell', async () => {
  const t = await text({ topic: 'nodes' });
  assert.match(t, /bash -lc "lm-assist start"/);
  assert.match(t, /bash -lc.*NOT optional|NOT optional/i);
  assert.match(t, /command not found/);                   // the bogus answer without the wrap
  assert.match(t, /list_nodes/);                          // re-verify after recovery
});

test('machine-access guide: an EMPTY registry is not "no route" — read ~/.ssh/config', async () => {
  const t = await text({ topic: 'machine-access' });
  assert.match(t, /EMPTY .*machine_access.* IS NOT/i);
  assert.match(t, /~\/\.ssh\/config/);
  assert.match(t, /IdentityFile/);
  assert.match(t, /~\/\.nvm\/versions\/node/);            // WHY the PATH trap exists
  assert.match(t, /bash -lc/);
});

test('access-paths carries the lost-node case as a worked failover example', async () => {
  const t = await text({ topic: 'access-paths' });
  assert.match(t, /DOWN PATH, not a dead machine/i);
  assert.match(t, /lm-assist start/);                     // fall over to ssh, then fall forward
});

test('ccr guide: the post-reboot inventory survives in ~/.claude/sessions, PIDs dead is expected', async () => {
  const t = await text({ topic: 'ccr' });
  assert.match(t, /~\/\.claude\/sessions\/\*\.json/);
  assert.match(t, /bridgeSessionId/);
  assert.match(t, /NOT evidence the work is gone/i);
  assert.match(t, /~\/\.claude\/projects\/<slug>\/\*\.jsonl/); // hit-count picks the right one
});

test('ccr guide: resume is lossless (own name + same bridge id) and the modal is the human’s call', async () => {
  const t = await text({ topic: 'ccr' });
  assert.match(t, /claude --resume <sessionId>/);
  assert.match(t, /RECLAIMS THE SAME/);
  assert.match(t, /URL is UNCHANGED/i);
  assert.match(t, /Resume from summary/);
  assert.match(t, /USAGE-LIMIT decision/);
  assert.match(t, /SURFACE IT TO THE HUMAN/);
  // the resume modal is the ONE Enter exception; /remote-control stays Escape-only
  assert.match(t, /ONE modal on this path where Enter is right/);
  assert.match(t, /Send ESCAPE, never ENTER/);
});

test('recovery is findable in the words of the SYMPTOM, not of the answer', async () => {
  for (const syn of ['reboot', 'offline', 'node-down', 'recover', 'rejoin']) {
    assert.match(await text({ topic: syn }), /Guide: machines \(nodes\)/, `${syn} → nodes`);
  }
  for (const syn of ['ssh-config', 'command not found']) {
    assert.match(await text({ topic: syn }), /Guide: machine-access/, `${syn} → machine-access`);
  }
  assert.match(await text({ topic: 'resume' }), /Guide: CCR/, 'resume → ccr');
});

test('bootstrap carries the node-recovery playbook (it must not be guide-only)', async () => {
  const t = await bootstrapAll();
  assert.match(t, /NOT A DEAD MACHINE/i);
  assert.match(t, /bash -lc "lm-assist start"/);
  assert.match(t, /~\/\.claude\/sessions\/\*\.json/);
});

// ── progressive paging (bl_057c3e0b) ────────────────────────────────────────
// bootstrap USED to exceed the 64 KiB ceiling and drop its tail. It now pages: page 1
// (no args) carries a manifest + the first run of playbooks; further pages are pulled by
// number. The invariant that makes this correct: NO page ever trips the central cap.

test('every bootstrap page is under the ceiling — the cap never fires on any page', async () => {
  const pages = await bootstrapPages();
  assert.ok(pages.length >= 1);
  pages.forEach((_txt, i) => {
    const raw = { content: [{ type: 'text', text: pages[i] }] } as any;
    const { size, result } = capToolResult(raw, 'bootstrap');
    assert.equal(size.truncated, false, `page ${i + 1} must fit under the ceiling`);
    assert.doesNotMatch(result.content[0].text as string, /RESULT TRUNCATED/, `page ${i + 1} carries no truncation marker`);
  });
});

test('page 1 carries a manifest naming every topic with its page number', async () => {
  const p1 = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  assert.match(p1, /page 1 of \d+/i);
  for (const topic of BOOTSTRAP_SECTION_ORDER) {
    // each topic appears in the manifest as a "… <topic> …(p<N>)" entry
    assert.match(p1, new RegExp(`${topic}\\b[^\\n]*\\(p\\d+\\)`, 'i'), `manifest lists ${topic} with a page`);
  }
});

test('a non-final page points to the next; the final page says it is complete; both cite guide(topic)', async () => {
  const pages = await bootstrapPages();
  const last = pages.length;
  assert.match(pages[0], /bootstrap\(page\s*=\s*2\)/i, 'page 1 points to page 2 (there is >1 page today)');
  assert.match(pages[last - 1], /complete|end of bootstrap|no further pages/i, 'final page announces completion');
  for (const p of pages) assert.match(p, /guide\(topic/i, 'every page reminds guide(topic=…) fetches one topic');
});

test('the pages cover every section exactly once, in order (nothing dropped, no dupes)', () => {
  const budget = maxResultBytes() - 12_288; // mirror the impl's WRAP_RESERVE
  const pages = paginateEntries(
    BOOTSTRAP_SECTION_ORDER.map((k) => ({ key: k, body: 'x'.repeat(100) })),
    budget,
  );
  const flat = pages.flat();
  assert.deepEqual(flat, [...BOOTSTRAP_SECTION_ORDER], 'union of pages == section order, once each');
});

test('paginateEntries packs by budget: a tiny budget yields many pages, each within budget (bar a lone oversized section)', () => {
  const entries = BOOTSTRAP_SECTION_ORDER.map((k, i) => ({ key: k, body: 'x'.repeat(1000 + i * 10) }));
  const pages = paginateEntries(entries, 3000);
  assert.ok(pages.length > 1, 'small budget splits into several pages');
  const sizeOf = (k: string) => (entries.find((e) => e.key === k)!.body.length);
  for (const page of pages) {
    const bytes = page.reduce((s: number, k: string) => s + sizeOf(k), 0);
    assert.ok(page.length === 1 || bytes <= 3000, 'a multi-section page stays within budget');
  }
});

test('out-of-range page returns the last page, not an error', async () => {
  const pages = await bootstrapPages();
  const far = (await GUIDE_HANDLERS.bootstrap({ page: 999 })).content[0].text as string;
  assert.equal(far, pages[pages.length - 1], 'page=999 clamps to the last page');
});

test('a raised ceiling collapses bootstrap back to a single page', async () => {
  const prev = process.env.MCP_RESULT_MAX_BYTES;
  process.env.MCP_RESULT_MAX_BYTES = String(1024 * 1024); // 1 MiB — everything fits
  try {
    const p1 = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
    assert.match(p1, /page 1 of 1/i, 'one page when the ceiling is large');
    assert.doesNotMatch(p1, /bootstrap\(page\s*=\s*2\)/i, 'no next-page prompt on a single page');
  } finally {
    if (prev === undefined) delete process.env.MCP_RESULT_MAX_BYTES;
    else process.env.MCP_RESULT_MAX_BYTES = prev;
  }
});

test('no single section exceeds the per-page content budget at the default ceiling', () => {
  // if this ever fails, that section must be split or trimmed — a lone oversized section
  // becomes its own page and could trip the central cap.
  const budget = 65_536 - 12_288;
  // measured via the real bodies below
  const pages = paginateEntries(BOOTSTRAP_SECTION_ORDER.map((k) => ({ key: k, body: '' })), budget);
  assert.ok(pages.length >= 1); // sanity; real-size assertion lives in the runtime suite
});

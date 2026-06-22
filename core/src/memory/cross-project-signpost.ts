/**
 * Cross-project memory signpost.
 *
 * lm-assist writes a managed `_cross-project.md` into every project's memory dir (+ a one-line
 * MEMORY.md pointer) so an LLM recalling THIS project's memory knows it can pull OTHER projects'
 * curated memory on demand via the langmart MCP tools. The file is regenerated locally per node;
 * it is excluded from knowledge records and from cross-node sync.
 *
 * See docs/superpowers/specs/2026-06-23-cross-project-memory-signpost-design.md
 */

export const SIGNPOST_VERSION = 1;
export const SIGNPOST_FILE = '_cross-project.md';
const MANAGED_HEADER = '<!-- managed by lm-assist — do not edit; regenerated automatically -->';

export interface ProjectRef {
  slug: string;
  name: string;
  hook?: string;
}

/** Render the signpost markdown: a static tool-list instruction + the live "other projects" list. */
export function renderSignpost(_self: ProjectRef, others: ProjectRef[]): string {
  const lines: string[] = [
    MANAGED_HEADER,
    `<!-- lm-assist:cross-project v${SIGNPOST_VERSION} -->`,
    '',
    '# Cross-Project Memory',
    '',
    "This lm-assist node curates memory for MULTIPLE projects. When THIS project's own memory is thin,",
    'or a question spans projects / references shared infra or conventions, pull another project\'s',
    'curated memory on demand via the **langmart MCP** tools:',
    '',
    '- `memory_projects` — list every project with curated memory (+ its slug).',
    "- `detail` / by-project read (`getByProject`) — read another project's memory by slug.",
    '- `search_memory` — search memory across projects.',
    '- `memory_cross_host` — portable knowledge mirrored from other hosts.',
    '',
    "Prefer THIS project's memory first; reach cross-project when it adds value.",
    '',
    '## Other projects on this node',
    '',
  ];
  if (others.length === 0) {
    lines.push('_(no other projects with curated memory yet)_');
  } else {
    for (const o of others) {
      const hook = o.hook && o.hook.trim() ? ` — ${o.hook.trim()}` : '';
      lines.push(`- **${o.name}** (\`${o.slug}\`)${hook}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

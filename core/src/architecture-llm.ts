/**
 * LLM-Driven Architecture Discovery
 *
 * Gives an LLM agent Read/Glob/Grep tools and lets it explore the project source
 * code itself to discover the architecture. The LLM knows every framework — we
 * just need to let it look.
 *
 * Session-derived context (components, resources, external projects from milestone
 * data) is provided as the user prompt since it can't be discovered from source files.
 *
 * Cache: ~/.lm-assist/architecture/{project}_model.json
 * Staleness: inputHash based on CLAUDE.md mtime + resource count + package.json mtime
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDataDir } from './utils/path-utils';
import { getProjectArchitectureData } from './mcp-server/tools/project-architecture';
import type { CachedArchitecture } from './mcp-server/tools/project-architecture';
import { getMilestoneSettings, type Phase2Model } from './milestone/settings';
import { getMilestoneStore } from './milestone/store';
import { getSessionCache } from './session-cache';
import { getProjectPathForSession } from './search/text-scorer';

// ─── Types ──────────────────────────────────────────────────

export interface ServiceNode {
  id: string;
  name: string;
  type: 'api-server' | 'web-app' | 'worker' | 'proxy' | 'database' | 'cache' | 'queue' | 'external';
  port?: number;
  description: string;
  technologies: string[];
  responsibilities: string[];
}

export interface ServiceConnection {
  from: string;
  to: string;
  type: 'http' | 'websocket' | 'tcp' | 'proxy' | 'docker' | 'ssh' | 'database';
  label: string;
  description?: string;
  port?: number;
}

export interface DatabaseNode {
  id: string;
  name: string;
  system: string;
  tables: string[];
  usedBy: string[];
}

export interface DataFlow {
  name: string;
  description: string;
  steps: string[];
}

export interface ArchitectureModel {
  summary: string;
  mermaidDiagram: string;
  services: ServiceNode[];
  connections: ServiceConnection[];
  databases: DatabaseNode[];
  dataFlows: DataFlow[];
}

export interface CachedArchitectureModel {
  generatedAt: number;       // when model was actually generated/updated by LLM
  lastCheckedAt: number;     // when we last evaluated delta (even if we skipped regen)
  model: ArchitectureModel;
  cacheVersion: number;
  inputHash: string;
  sessionId?: string;
  numTurns?: number;
  totalCostUsd?: number;
  durationMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────

const CACHE_DIR = path.join(getDataDir(), 'architecture');
const MODEL_CACHE_VERSION = 3;
const DEFAULT_API_BASE_URL = 'http://localhost:3100';
const DEFAULT_TIMEOUT = 180_000; // 3 min — multi-turn agent takes longer

// ─── Session Context Collection ──────────────────────────────────────────

interface SessionContext {
  resources: CachedArchitecture['resources'];
  components: CachedArchitecture['components'];
  externalProjects: CachedArchitecture['externalProjects'];
}

/**
 * Gathers session-derived context that the LLM can't discover from source files.
 * Components, resources, and external projects come from milestone/session data.
 */
async function collectSessionContext(project: string): Promise<SessionContext> {
  const archData = await getProjectArchitectureData(project);
  return {
    resources: archData?.resources || [],
    components: archData?.components || [],
    externalProjects: archData?.externalProjects || [],
  };
}

// ─── Input Hash ──────────────────────────────────────────────────

export function computeInputHash(project: string, resourceCount: number): string {
  const hash = crypto.createHash('md5');

  // CLAUDE.md mtime
  const claudeMdPath = path.join(project, 'CLAUDE.md');
  try {
    if (fs.existsSync(claudeMdPath)) {
      const stat = fs.statSync(claudeMdPath);
      hash.update(`claude:${stat.mtimeMs}`);
    }
  } catch { /* ignore */ }

  // Resource count
  hash.update(`resources:${resourceCount}`);

  // package.json mtime
  const pkgPath = path.join(project, 'package.json');
  try {
    if (fs.existsSync(pkgPath)) {
      const stat = fs.statSync(pkgPath);
      hash.update(`pkg:${stat.mtimeMs}`);
    }
  } catch { /* ignore */ }

  return hash.digest('hex');
}

// ─── Delta Detection ──────────────────────────────────────────────────

export interface DeltaAnalysis {
  totalDelta: number;                    // milestones since generatedAt
  structuralDelta: number;               // milestones that touched structural files
  architectureRelevantDelta: number;     // milestones with architectureRelevant: true
  relevantMilestones: import('./milestone/types').Milestone[];  // actual milestone objects for delta update
  newFileCount: number;                  // unique files modified in delta
  deltaTypes: Record<string, number>;    // feature:5, bugfix:3, etc.
  shouldRegenerate: boolean;
  reason: string;
}

/** File patterns that indicate architectural changes */
const STRUCTURAL_PATTERNS = [
  /\broutes?\b/i, /\bcontrollers?\b/i, /\bhandlers?\b/i,
  /\bmigrations?\b/i, /\bschema\b/i,
  /docker-compose/i, /Dockerfile/i, /compose\./i,
  /package\.json$/, /CLAUDE\.md$/, /\.env/,
  /\bmcp-server\b/i,
];

function isStructuralFile(filePath: string): boolean {
  return STRUCTURAL_PATTERNS.some(p => p.test(filePath));
}

/**
 * Analyze milestones created since `sinceTimestamp` for a project.
 * Uses the milestone index for fast pre-filtering, then loads only
 * sessions with activity after the cutoff.
 */
export function collectDeltaMilestones(project: string, sinceTimestamp: number): DeltaAnalysis {
  const sessionCache = getSessionCache();
  const milestoneStore = getMilestoneStore();
  const index = milestoneStore.getIndex();
  const sessions = sessionCache.getAllSessionsFromCache();

  // Build set of session IDs belonging to this project
  const projectSessionIds = new Set<string>();
  for (const { sessionId, filePath, cacheData } of sessions) {
    const sessionProject = cacheData.cwd || getProjectPathForSession(cacheData, filePath);
    if (sessionProject === project) {
      projectSessionIds.add(sessionId);
    }
  }

  let totalDelta = 0;
  let structuralDelta = 0;
  let architectureRelevantDelta = 0;
  const relevantMilestones: import('./milestone/types').Milestone[] = [];
  const modifiedFiles = new Set<string>();
  const deltaTypes: Record<string, number> = {};

  // Use index for fast pre-filter: skip sessions with no activity after sinceTimestamp
  for (const sessionId of projectSessionIds) {
    const indexEntry = index.sessions[sessionId];
    if (!indexEntry) continue;
    // sessionTimestamp is the latest milestone endTimestamp (epoch ms)
    if (indexEntry.sessionTimestamp && indexEntry.sessionTimestamp <= sinceTimestamp) continue;

    // Load milestones and filter to those after sinceTimestamp
    const milestones = milestoneStore.getMilestones(sessionId);
    for (const m of milestones) {
      const mTime = Date.parse(m.endTimestamp);
      if (isNaN(mTime) || mTime <= sinceTimestamp) continue;

      totalDelta++;

      // Check structural files (heuristic fallback)
      let isStructural = false;
      for (const f of m.filesModified) {
        modifiedFiles.add(f);
        if (!isStructural && isStructuralFile(f)) {
          isStructural = true;
        }
      }
      if (isStructural) structuralDelta++;

      // Track LLM-classified architecture-relevant milestones
      if (m.architectureRelevant === true) {
        architectureRelevantDelta++;
        relevantMilestones.push(m);
      }

      // Aggregate types
      if (m.type) {
        deltaTypes[m.type] = (deltaTypes[m.type] || 0) + 1;
      }
    }
  }

  // Decision heuristic
  let shouldRegenerate = false;
  let reason = '';

  if (totalDelta === 0) {
    reason = 'no new milestones since generation';
  } else if (architectureRelevantDelta >= 1) {
    // LLM-classified architecture relevance is the strongest signal
    shouldRegenerate = true;
    reason = `${architectureRelevantDelta} architecture-relevant milestone(s) detected`;
  } else if (structuralDelta >= 3) {
    shouldRegenerate = true;
    reason = `${structuralDelta} structural changes detected`;
  } else if (totalDelta >= 20) {
    shouldRegenerate = true;
    reason = `${totalDelta} milestones since last generation`;
  } else if (totalDelta < 5 && structuralDelta === 0) {
    reason = `only ${totalDelta} milestones, no structural changes`;
  } else {
    reason = `${totalDelta} milestones (${structuralDelta} structural) — below threshold`;
  }

  return {
    totalDelta,
    structuralDelta,
    architectureRelevantDelta,
    relevantMilestones,
    newFileCount: modifiedFiles.size,
    deltaTypes,
    shouldRegenerate,
    reason,
  };
}

// ─── Cache I/O ──────────────────────────────────────────────────

function cacheKey(project: string): string {
  return project.replace(/\//g, '_').replace(/^_/, '') + '_model';
}

export function loadModelCache(project: string): CachedArchitectureModel | null {
  const file = path.join(CACHE_DIR, `${cacheKey(project)}.json`);
  try {
    if (fs.existsSync(file)) {
      const cached = JSON.parse(fs.readFileSync(file, 'utf-8')) as CachedArchitectureModel;
      if (cached.cacheVersion !== MODEL_CACHE_VERSION) return null;
      return cached;
    }
  } catch { /* ignore */ }
  return null;
}

function saveModelCache(project: string, cache: CachedArchitectureModel): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const file = path.join(CACHE_DIR, `${cacheKey(project)}.json`);
    fs.writeFileSync(file, JSON.stringify(cache, null, 2));
  } catch { /* ignore */ }
}

// ─── Discovery Agent Prompts ──────────────────────────────────────────────────

const DISCOVERY_SYSTEM_PROMPT = `You are a software architecture analyst with access to Read, Glob, and Grep tools.
Your job: explore a project's source code and produce a structured architecture model as JSON.

## How to Work

Start with the highest-value files — these contain the most architectural information:

1. **CLAUDE.md** — Read this first. It's the project's own documentation of its architecture, services, ports, and relationships. If external projects are listed (with paths), read their CLAUDE.md files too — they describe the full system topology.
2. **.env** — Read all .env files (.env, .env.local, .env.production). These reveal ports, hosts, database URLs, service connections, and deployment configuration. Ignore secret values (API keys, tokens, passwords) but note what services they connect to.
3. **Build/config files** — Read package.json / Cargo.toml / go.mod / pyproject.toml / requirements.txt to identify the tech stack. Read docker-compose.yml / compose.yaml / Dockerfile / Makefile / Procfile — these reveal service topology, ports, and infrastructure.
4. **README.md** — Additional project documentation if CLAUDE.md is sparse.

Then discover the implementation details:

5. Use Glob to find route/handler/controller files based on the framework you identified from the config files.
6. Read those files to extract API endpoints (method, path, source file).
7. Look for database migrations, schema definitions, or ORM model files.
8. Check for configuration that reveals external services, caches, queues, workers.

Use your knowledge of the project's framework to find things. For Express, look for app.get/router.post. For Django, look for urls.py. For Go+Chi, look for r.Get/r.Post. For NestJS, look for @Get/@Post decorators. For Rails, look for routes.rb. Etc.

## Output

When you have enough information, output ONLY valid JSON (no markdown fences, no explanation before or after) conforming to this schema:
{
  "summary": "2-3 paragraph markdown overview of the architecture",
  "mermaidDiagram": "Mermaid flowchart TD/LR syntax showing service topology",
  "services": [
    {
      "id": "unique-kebab-case-id",
      "name": "Display Name",
      "type": "api-server|web-app|worker|proxy|database|cache|queue|external",
      "port": 3100,
      "description": "One sentence description",
      "technologies": ["TypeScript", "Express"],
      "responsibilities": ["Handles API requests", "Manages sessions"]
    }
  ],
  "connections": [
    {
      "from": "service-id",
      "to": "service-id",
      "type": "http|websocket|tcp|proxy|docker|ssh|database",
      "label": "REST API",
      "description": "Optional details",
      "port": 3100
    }
  ],
  "databases": [
    {
      "id": "unique-id",
      "name": "Display Name",
      "system": "postgresql|mysql|sqlite|mongodb|redis",
      "tables": ["users", "sessions"],
      "usedBy": ["service-id"]
    }
  ],
  "dataFlows": [
    {
      "name": "User request flow",
      "description": "How a user request travels through the system",
      "steps": ["User → Frontend (auth)", "→ Backend (API)", "→ Database (query)"]
    }
  ]
}

## Rules
- Use REAL data you discovered — actual ports, service names, technologies from files you read
- Every service ID must be unique kebab-case
- Do not invent services you didn't find evidence for
- Include ALL services you can identify: web apps, API servers, databases, caches, proxies, workers, external
- The Mermaid diagram should be a clear flowchart showing service relationships with color styling — assign each major service or group a distinct fill color using Mermaid style directives (e.g. \`style API fill:#4CAF50\`, \`style DB fill:#F44336\`). Use professional color palettes to visually distinguish service types (servers, databases, external, caches, etc.)
- Accurately represent proxy/relay patterns: if service A connects to service B via WebSocket and B proxies requests back to A's local API, show B as the initiator with A as the relay, not as a direct connection. Pay attention to connection direction — who initiates, who listens.
- For the summary, write in markdown format, focusing on the system's purpose and how components interact
- Database tables should come from actual schema/migration files or resource data when available
- Connections must reference valid service IDs`;

function buildDiscoveryPrompt(project: string, ctx: SessionContext): string {
  const sections: string[] = [];

  sections.push(`# Project: ${project}`);
  sections.push('');
  sections.push('Explore this project\'s source code using Read, Glob, and Grep tools to discover its architecture.');
  sections.push('');

  // Session activity context — data the LLM can't read from source files
  if (ctx.components.length > 0 || ctx.resources.length > 0 || ctx.externalProjects.length > 0) {
    sections.push('## Session Activity Context');
    sections.push('The following data comes from development session history — it shows which parts of the project have been actively worked on recently.');
    sections.push('');
  }

  if (ctx.components.length > 0) {
    sections.push(`### Active Components (${ctx.components.length} directories with recent activity)`);
    for (const comp of ctx.components.slice(0, 20)) {
      const typeStr = Object.entries(comp.types)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t, n]) => `${t}:${n}`)
        .join(' ');
      sections.push(`- ${comp.directory}/ — ${comp.fileCount} files, ${comp.milestoneCount} milestones | ${typeStr}`);
    }
    sections.push('');
  }

  if (ctx.resources.length > 0) {
    sections.push(`### Active Resources (${ctx.resources.length})`);
    for (const r of ctx.resources.slice(0, 20)) {
      let detail = `- ${r.name} [${r.category}] — ${r.accessCount}x via ${r.commands.join(', ')}`;
      if (r.dbTables && r.dbTables.length > 0) {
        detail += ` | tables: ${r.dbTables.join(', ')}`;
      }
      if (r.dbOperations && r.dbOperations.length > 0) {
        detail += ` | ops: ${r.dbOperations.join(', ')}`;
      }
      sections.push(detail);
    }
    sections.push('');
  }

  if (ctx.externalProjects.length > 0) {
    sections.push(`### External Projects (read their CLAUDE.md for cross-system architecture)`);
    for (const ext of ctx.externalProjects) {
      sections.push(`- ${ext.displayName} (${ext.projectRoot}) — ${ext.totalFiles} files, ${ext.totalMilestones} milestones → read ${ext.projectRoot}/CLAUDE.md`);
      for (const comp of ext.components.slice(0, 5)) {
        sections.push(`  - ${comp.directory}/ — ${comp.fileCount} files`);
      }
    }
    sections.push('');
  }

  sections.push('After exploring the codebase, output the architecture model JSON.');

  return sections.join('\n');
}

// ─── Discovery Agent Call ──────────────────────────────────────────────────

interface DiscoveryAgentResult {
  result: string;
  sessionId?: string;
  numTurns?: number;
  totalCostUsd?: number;
  durationMs?: number;
}

/**
 * Call the agent execution API with Read/Glob/Grep tools enabled.
 * The agent explores the project source code across multiple turns,
 * then outputs the architecture model JSON as its final response.
 */
async function callDiscoveryAgent(
  project: string,
  prompt: string,
  model: Phase2Model = 'sonnet'
): Promise<DiscoveryAgentResult | null> {
  const apiBaseUrl = process.env.TIER_AGENT_API_URL || DEFAULT_API_BASE_URL;

  try {
    const response = await fetch(`${apiBaseUrl}/agent/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        systemPrompt: DISCOVERY_SYSTEM_PROMPT,
        model,
        cwd: project,
        permissionMode: 'bypassPermissions',
        allowedTools: ['Read', 'Glob', 'Grep'],
        settingSources: [],
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    });

    if (!response.ok) {
      console.error(`[ArchLLM] Agent API error: ${response.status}`);
      return null;
    }

    const data = await response.json() as any;
    const result = data.data || data;

    // The agent may hit maxTurns and return success:false but still have
    // useful result text (e.g. the JSON output in the last turn).
    // Only fail if there's no result text at all.
    if (!result.result) {
      console.error(`[ArchLLM] Agent execution failed: ${result.error || 'no result'}`);
      return null;
    }

    if (!result.success) {
      console.log(`[ArchLLM] Agent finished with success=false (likely maxTurns reached), using result text`);
    }

    if (result.sessionId) {
      console.log(`[ArchLLM] Discovery agent session: ${result.sessionId} (${result.numTurns || '?'} turns, $${(result.totalCostUsd || 0).toFixed(4)}, ${result.durationMs || '?'}ms)`);
    }

    return {
      result: result.result,
      sessionId: result.sessionId,
      numTurns: result.numTurns,
      totalCostUsd: result.totalCostUsd,
      durationMs: result.durationMs,
    };
  } catch (error: any) {
    console.error('[ArchLLM] Agent API call failed:', error.message || error);
    return null;
  }
}

// ─── Response Parsing ──────────────────────────────────────────

function parseArchitectureResponse(text: string): ArchitectureModel | null {
  try {
    // The multi-turn agent may output text before/after the JSON.
    // Try to extract a JSON object from the response.
    let jsonStr = text;

    // Strip markdown code fences if present
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

    // Try to find JSON object boundaries if there's surrounding text
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(jsonStr);

    // Validate required fields
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.summary || !Array.isArray(parsed.services)) return null;

    const model: ArchitectureModel = {
      summary: String(parsed.summary || ''),
      mermaidDiagram: String(parsed.mermaidDiagram || ''),
      services: Array.isArray(parsed.services) ? parsed.services.map(validateService).filter(Boolean) as ServiceNode[] : [],
      connections: Array.isArray(parsed.connections) ? parsed.connections.map(validateConnection).filter(Boolean) as ServiceConnection[] : [],
      databases: Array.isArray(parsed.databases) ? parsed.databases.map(validateDatabase).filter(Boolean) as DatabaseNode[] : [],
      dataFlows: Array.isArray(parsed.dataFlows) ? parsed.dataFlows.map(validateDataFlow).filter(Boolean) as DataFlow[] : [],
    };

    return model;
  } catch (err: any) {
    console.error(`[ArchLLM] Parse error: ${err.message}`);
    console.error(`[ArchLLM] Raw response (first 500 chars): ${text.slice(0, 500)}`);
    return null;
  }
}

function validateService(obj: any): ServiceNode | null {
  if (!obj || !obj.id || !obj.name) return null;
  const validTypes = ['api-server', 'web-app', 'worker', 'proxy', 'database', 'cache', 'queue', 'external'];
  return {
    id: String(obj.id),
    name: String(obj.name),
    type: validTypes.includes(obj.type) ? obj.type : 'external',
    port: typeof obj.port === 'number' ? obj.port : undefined,
    description: String(obj.description || ''),
    technologies: Array.isArray(obj.technologies) ? obj.technologies.map(String) : [],
    responsibilities: Array.isArray(obj.responsibilities) ? obj.responsibilities.map(String) : [],
  };
}

function validateConnection(obj: any): ServiceConnection | null {
  if (!obj || !obj.from || !obj.to) return null;
  const validTypes = ['http', 'websocket', 'tcp', 'proxy', 'docker', 'ssh', 'database'];
  return {
    from: String(obj.from),
    to: String(obj.to),
    type: validTypes.includes(obj.type) ? obj.type : 'http',
    label: String(obj.label || ''),
    description: obj.description ? String(obj.description) : undefined,
    port: typeof obj.port === 'number' ? obj.port : undefined,
  };
}

function validateDatabase(obj: any): DatabaseNode | null {
  if (!obj || !obj.id || !obj.name) return null;
  return {
    id: String(obj.id),
    name: String(obj.name),
    system: String(obj.system || 'unknown'),
    tables: Array.isArray(obj.tables) ? obj.tables.map(String) : [],
    usedBy: Array.isArray(obj.usedBy) ? obj.usedBy.map(String) : [],
  };
}

function validateDataFlow(obj: any): DataFlow | null {
  if (!obj || !obj.name) return null;
  return {
    name: String(obj.name),
    description: String(obj.description || ''),
    steps: Array.isArray(obj.steps) ? obj.steps.map(String) : [],
  };
}

// ─── Delta Update Agent ──────────────────────────────────────────────────

const DELTA_UPDATE_SYSTEM_PROMPT = `You are an architecture model updater. You receive an existing architecture model JSON and recent development milestones that changed the system's architecture.

Your job: update the model to reflect the changes while preserving accurate existing information.

## What to Update
- Add new services if milestones created them (new API server, worker, proxy, etc.)
- Update existing service descriptions, technologies, and responsibilities
- Add new connections between services
- Add or update database tables from schema changes/migrations
- Update data flows if request patterns changed
- Update the Mermaid diagram to match the updated services and connections — preserve or add color styling with Mermaid style directives (e.g. \`style API fill:#4CAF50\`)
- Update the summary to reflect the current state

## Rules
- Preserve existing information that wasn't contradicted by milestones
- Use specifics from milestone facts (file names, port numbers, technology names)
- Every service ID must remain unique kebab-case
- Connections must reference valid service IDs
- If the changes are too fundamental to patch (completely new framework, full service removal/replacement, major restructure that invalidates >50% of the model), output ONLY: {"fullRegenRequired": true, "reason": "explanation"}
- Otherwise, output the complete updated architecture model JSON (same schema as input)

Output ONLY valid JSON, no markdown fences, no explanation.`;

function buildDeltaUpdatePrompt(
  existingModel: ArchitectureModel,
  generatedAt: number,
  milestones: import('./milestone/types').Milestone[],
): string {
  const sections: string[] = [];

  sections.push(`## Current Architecture Model (generated ${new Date(generatedAt).toISOString()})`);
  sections.push(JSON.stringify(existingModel, null, 2));
  sections.push('');

  sections.push(`## Architecture-Relevant Milestones Since Last Generation`);
  for (const m of milestones) {
    sections.push(`### ${m.title || 'Untitled'} [${m.type || 'unknown'}]`);
    if (m.description) sections.push(m.description);
    if (m.outcome) sections.push(`Outcome: ${m.outcome}`);
    if (m.facts && m.facts.length > 0) {
      sections.push('Facts:');
      for (const f of m.facts) {
        sections.push(`- ${f}`);
      }
    }
    if (m.filesModified.length > 0) {
      sections.push(`Files Modified: ${m.filesModified.join(', ')}`);
    }
    sections.push('');
  }

  sections.push(`## Instructions`);
  sections.push(`Update the architecture model to reflect these ${milestones.length} milestone(s). Output the complete updated JSON.`);

  return sections.join('\n');
}

/**
 * Cheap single-turn delta update: patches the existing architecture model
 * using architecture-relevant milestone context instead of re-exploring the codebase.
 * Returns null on failure, or { fullRegenRequired: true } if the model needs full regen.
 */
export async function deltaUpdateArchitectureModel(
  project: string,
  model?: Phase2Model,
): Promise<{
  model: ArchitectureModel;
  generatedAt: number;
  deltaUpdate: true;
  milestonesApplied: number;
  fullRegenRequired?: boolean;
} | null> {
  const existingCache = loadModelCache(project);
  if (!existingCache) {
    console.log(`[ArchLLM] Delta update: no existing cache for ${project}`);
    return null;
  }

  const delta = collectDeltaMilestones(project, existingCache.generatedAt);
  if (delta.relevantMilestones.length === 0) {
    console.log(`[ArchLLM] Delta update: no architecture-relevant milestones for ${project}`);
    return null;
  }

  const prompt = buildDeltaUpdatePrompt(
    existingCache.model,
    existingCache.generatedAt,
    delta.relevantMilestones,
  );

  const settings = getMilestoneSettings();
  const llmModel = model || settings.architectureModel || 'sonnet';
  const apiBaseUrl = process.env.TIER_AGENT_API_URL || DEFAULT_API_BASE_URL;

  console.log(`[ArchLLM] Delta update for ${project}: ${delta.relevantMilestones.length} milestones, prompt ~${Math.ceil(prompt.length / 4)} tokens`);

  try {
    const response = await fetch(`${apiBaseUrl}/agent/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        systemPrompt: DELTA_UPDATE_SYSTEM_PROMPT,
        model: llmModel,
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        cwd: getDataDir(),
        env: { CLAUDE_CODE_REMOTE: 'true' },
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
        settingSources: [],
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    });

    if (!response.ok) {
      console.error(`[ArchLLM] Delta update API error: ${response.status}`);
      return null;
    }

    const data = await response.json() as any;
    const result = data.data || data;
    if (!result.result) {
      console.error(`[ArchLLM] Delta update execution failed: ${result.error || 'no result'}`);
      return null;
    }

    // Check for fullRegenRequired signal
    try {
      const text = result.result.trim();
      const jsonStr = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
      const firstBrace = jsonStr.indexOf('{');
      const lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const parsed = JSON.parse(jsonStr.slice(firstBrace, lastBrace + 1));
        if (parsed.fullRegenRequired === true) {
          console.log(`[ArchLLM] Delta update says full regen required: ${parsed.reason || 'unspecified'}`);
          return {
            model: existingCache.model,
            generatedAt: existingCache.generatedAt,
            deltaUpdate: true,
            milestonesApplied: 0,
            fullRegenRequired: true,
          };
        }
      }
    } catch { /* parse error checking fullRegenRequired — continue to normal parse */ }

    const updatedModel = parseArchitectureResponse(result.result);
    if (!updatedModel) {
      console.error(`[ArchLLM] Delta update: failed to parse response`);
      return null;
    }

    console.log(`[ArchLLM] Delta update succeeded: ${updatedModel.services.length} services, ${updatedModel.connections.length} connections`);

    // Save updated cache — preserve inputHash, update generatedAt
    const now = Date.now();
    const cache: CachedArchitectureModel = {
      generatedAt: now,
      lastCheckedAt: now,
      model: updatedModel,
      cacheVersion: MODEL_CACHE_VERSION,
      inputHash: existingCache.inputHash,
      sessionId: existingCache.sessionId,
    };
    saveModelCache(project, cache);

    return {
      model: updatedModel,
      generatedAt: now,
      deltaUpdate: true,
      milestonesApplied: delta.relevantMilestones.length,
    };
  } catch (error: any) {
    console.error('[ArchLLM] Delta update API call failed:', error.message || error);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Get cached architecture model with accurate staleness check.
 * Returns { model, stale, generatedAt } or null if no cached model exists.
 */
export async function getArchitectureModelAsync(project: string): Promise<{
  model: ArchitectureModel;
  stale: boolean;
  generatedAt: number;
  lastCheckedAt: number;
  sessionId?: string;
} | null> {
  const cached = loadModelCache(project);
  if (!cached) return null;

  const archData = await getProjectArchitectureData(project);
  const resourceCount = archData?.resources?.length || 0;
  const currentHash = computeInputHash(project, resourceCount);
  const stale = cached.inputHash !== currentHash;

  return {
    model: cached.model,
    stale,
    generatedAt: cached.generatedAt,
    lastCheckedAt: cached.lastCheckedAt,
    sessionId: cached.sessionId,
  };
}

/**
 * Generate architecture model using a multi-turn discovery agent.
 * The agent explores the project with Read/Glob/Grep tools, then outputs
 * the architecture model as JSON. Session-derived context is provided
 * as the user prompt.
 */
export async function generateArchitectureModel(
  project: string,
  model?: Phase2Model,
  options?: { force?: boolean; mode?: 'auto' | 'delta' | 'full' }
): Promise<{
  model: ArchitectureModel;
  generatedAt: number;
  sessionId?: string;
  skipped?: boolean;
  reason?: string;
  deltaUpdate?: boolean;
  milestonesApplied?: number;
} | null> {
  const mode = options?.mode || 'auto';

  // ─── Force delta mode: attempt delta update only ───
  if (mode === 'delta') {
    const result = await deltaUpdateArchitectureModel(project, model);
    if (!result) {
      return null; // No cache or no delta milestones
    }
    if (result.fullRegenRequired) {
      // In delta-only mode, don't fall back to full regen
      return null;
    }
    return {
      model: result.model,
      generatedAt: result.generatedAt,
      deltaUpdate: true,
      milestonesApplied: result.milestonesApplied,
    };
  }

  // ─── Delta check: skip regeneration when changes are minimal ───
  const existingCache = loadModelCache(project);
  if (existingCache && !options?.force && mode !== 'full') {
    const delta = collectDeltaMilestones(project, existingCache.generatedAt);

    // Also check inputHash
    const archData = await getProjectArchitectureData(project);
    const resourceCount = archData?.resources?.length || 0;
    const currentHash = computeInputHash(project, resourceCount);
    const hashChanged = existingCache.inputHash !== currentHash;

    // Merge hash check into decision
    let shouldRegenerate = delta.shouldRegenerate;
    let reason = delta.reason;

    if (hashChanged) {
      shouldRegenerate = true;
      reason = 'project config changed (CLAUDE.md, package.json, or resources)';
    } else if (!shouldRegenerate && delta.totalDelta < 10) {
      // inputHash unchanged AND small delta → skip
      if (delta.totalDelta > 0 && reason.startsWith('only ')) {
        reason = `small delta (${delta.totalDelta} milestones), no config changes`;
      }
    }

    if (!shouldRegenerate) {
      // Update lastCheckedAt and save
      existingCache.lastCheckedAt = Date.now();
      saveModelCache(project, existingCache);
      console.log(`[ArchLLM] Skipping regeneration for ${project}: ${reason}`);
      return {
        model: existingCache.model,
        generatedAt: existingCache.generatedAt,
        sessionId: existingCache.sessionId,
        skipped: true,
        reason,
      };
    }

    console.log(`[ArchLLM] Delta warrants regeneration for ${project}: ${reason}`);

    // ─── Try delta update first (cheap single-turn) when architecture-relevant milestones exist ───
    if (delta.architectureRelevantDelta > 0 && !hashChanged) {
      console.log(`[ArchLLM] Attempting delta update (${delta.architectureRelevantDelta} architecture-relevant milestones)`);
      const deltaResult = await deltaUpdateArchitectureModel(project, model);
      if (deltaResult && !deltaResult.fullRegenRequired) {
        return {
          model: deltaResult.model,
          generatedAt: deltaResult.generatedAt,
          deltaUpdate: true,
          milestonesApplied: deltaResult.milestonesApplied,
        };
      }
      if (deltaResult?.fullRegenRequired) {
        console.log(`[ArchLLM] Delta update requested full regen — falling back to discovery agent`);
      }
      // Delta update failed or requested full regen — fall through to full discovery agent
    }
  }

  console.log(`[ArchLLM] Generating architecture model for ${project} (discovery agent)`);

  // Collect session-derived context (can't be discovered from source files)
  const ctx = await collectSessionContext(project);

  // Build discovery prompt
  const prompt = buildDiscoveryPrompt(project, ctx);
  console.log(`[ArchLLM] Discovery prompt length: ${prompt.length} chars (~${Math.ceil(prompt.length / 4)} tokens)`);

  // Determine model — use dedicated architectureModel setting (defaults to sonnet)
  const settings = getMilestoneSettings();
  const llmModel = model || settings.architectureModel || 'sonnet';

  // Call discovery agent with Read/Glob/Grep tools
  const agentResult = await callDiscoveryAgent(project, prompt, llmModel);
  if (!agentResult) {
    console.error('[ArchLLM] Discovery agent returned null');
    return null;
  }

  // Parse response
  const archModel = parseArchitectureResponse(agentResult.result);
  if (!archModel) {
    console.error('[ArchLLM] Failed to parse discovery agent response');
    return null;
  }

  console.log(`[ArchLLM] Discovered: ${archModel.services.length} services, ${archModel.connections.length} connections, ${archModel.databases.length} databases, ${archModel.dataFlows.length} flows`);

  // Compute input hash using resource count from already-collected context
  const resourceCount = ctx.resources.length;
  const inputHash = computeInputHash(project, resourceCount);

  const now = Date.now();
  const cache: CachedArchitectureModel = {
    generatedAt: now,
    lastCheckedAt: now,
    model: archModel,
    cacheVersion: MODEL_CACHE_VERSION,
    inputHash,
    sessionId: agentResult.sessionId,
    numTurns: agentResult.numTurns,
    totalCostUsd: agentResult.totalCostUsd,
    durationMs: agentResult.durationMs,
  };
  saveModelCache(project, cache);

  return { model: archModel, generatedAt: now, sessionId: agentResult.sessionId };
}

// ─── MCP Formatting ──────────────────────────────────────────────────

/**
 * Format architecture model as markdown for MCP tool output.
 * Used by handleProjectArchitecture() to add ## System Architecture section.
 */
export function formatArchitectureModelForMcp(model: ArchitectureModel): string {
  const lines: string[] = [];

  lines.push('## System Architecture');
  lines.push('');
  lines.push(model.summary);
  lines.push('');

  // Services
  if (model.services.length > 0) {
    lines.push('### Services');
    lines.push('');
    for (const svc of model.services) {
      const portStr = svc.port ? `:${svc.port}` : '';
      const techStr = svc.technologies.length > 0 ? ` [${svc.technologies.join(', ')}]` : '';
      lines.push(`- **${svc.name}** (${svc.type}${portStr})${techStr}`);
      lines.push(`  ${svc.description}`);
      if (svc.responsibilities.length > 0) {
        for (const r of svc.responsibilities) {
          lines.push(`  - ${r}`);
        }
      }
    }
    lines.push('');
  }

  // Connections
  if (model.connections.length > 0) {
    lines.push('### Connections');
    lines.push('');
    for (const conn of model.connections) {
      const portStr = conn.port ? ` :${conn.port}` : '';
      lines.push(`- ${conn.from} → ${conn.to} (${conn.type}${portStr}) — ${conn.label}`);
    }
    lines.push('');
  }

  // Databases
  if (model.databases.length > 0) {
    lines.push('### Databases');
    lines.push('');
    for (const db of model.databases) {
      lines.push(`- **${db.name}** (${db.system})`);
      if (db.tables.length > 0) {
        lines.push(`  Tables: ${db.tables.join(', ')}`);
      }
      if (db.usedBy.length > 0) {
        lines.push(`  Used by: ${db.usedBy.join(', ')}`);
      }
    }
    lines.push('');
  }

  // Data Flows
  if (model.dataFlows.length > 0) {
    lines.push('### Data Flows');
    lines.push('');
    for (const flow of model.dataFlows) {
      lines.push(`**${flow.name}**: ${flow.description}`);
      for (const step of flow.steps) {
        lines.push(`  ${step}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

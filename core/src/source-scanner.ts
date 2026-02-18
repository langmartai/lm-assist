/**
 * Source Code Scanner — Discovers endpoints, database tables, and resources from source code
 *
 * Uses regex-based scanning (no AST) to extract:
 * - API endpoints from route files (tier-agent pattern, Express/Hono/Fastify, Next.js)
 * - Database tables from SQL migrations and code references
 *
 * Results are cached at ~/.lm-assist/architecture/{project}_source_scan.json
 * with invalidation based on route dir mtime + package.json mtime + migration file count.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDataDir } from './utils/path-utils';

// ─── Types ──────────────────────────────────────────────────

export interface ScannedEndpoint {
  method: string;          // GET, POST, PUT, DELETE
  path: string;            // /health, /architecture/model
  sourceFile: string;      // relative path
  lineNumber?: number;
  framework: string;       // 'tier-agent-routes' | 'express' | 'nextjs-app' | 'nextjs-pages'
}

export interface ScannedTable {
  name: string;
  source: 'migration' | 'code-reference';
  sourceFile?: string;
  columns?: string[];
}

export interface SourceScanResult {
  endpoints: ScannedEndpoint[];
  tables: ScannedTable[];
  scannedAt: number;
  scanDurationMs: number;
}

// ─── Constants ──────────────────────────────────────────────────

const CACHE_DIR = path.join(getDataDir(), 'architecture');

// ─── Cache ──────────────────────────────────────────────────

interface ScanCacheEntry {
  invalidationKey: string;
  result: SourceScanResult;
}

function computeInvalidationKey(projectPath: string): string {
  const hash = crypto.createHash('md5');

  // src/routes/ directory mtime (if it exists)
  const routesDir = path.join(projectPath, 'src', 'routes');
  try {
    if (fs.existsSync(routesDir)) {
      const stat = fs.statSync(routesDir);
      hash.update(`routes:${stat.mtimeMs}`);
      // Also check immediate children mtimes for deeper invalidation
      const children = fs.readdirSync(routesDir);
      for (const child of children) {
        try {
          const childStat = fs.statSync(path.join(routesDir, child));
          hash.update(`${child}:${childStat.mtimeMs}`);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // package.json mtime
  const pkgPath = path.join(projectPath, 'package.json');
  try {
    if (fs.existsSync(pkgPath)) {
      const stat = fs.statSync(pkgPath);
      hash.update(`pkg:${stat.mtimeMs}`);
    }
  } catch { /* ignore */ }

  // Migration file count
  let migrationCount = 0;
  for (const dir of ['migrations', 'database', 'db', 'supabase/migrations']) {
    const migDir = path.join(projectPath, dir);
    try {
      if (fs.existsSync(migDir)) {
        const files = fs.readdirSync(migDir).filter(f => f.endsWith('.sql'));
        migrationCount += files.length;
      }
    } catch { /* ignore */ }
  }
  hash.update(`migrations:${migrationCount}`);

  return hash.digest('hex');
}

function scanCacheKey(project: string): string {
  return project.replace(/\//g, '_').replace(/^_/, '') + '_source_scan';
}

function loadScanCache(project: string): ScanCacheEntry | null {
  const file = path.join(CACHE_DIR, `${scanCacheKey(project)}.json`);
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as ScanCacheEntry;
    }
  } catch { /* ignore */ }
  return null;
}

function saveScanCache(project: string, entry: ScanCacheEntry): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const file = path.join(CACHE_DIR, `${scanCacheKey(project)}.json`);
    fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  } catch { /* ignore */ }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Scan project source code for endpoints, tables, and resources.
 * Results are cached and invalidated when route/migration files change.
 */
export async function scanProjectSource(projectPath: string): Promise<SourceScanResult> {
  const currentKey = computeInvalidationKey(projectPath);

  // Check cache
  const cached = loadScanCache(projectPath);
  if (cached && cached.invalidationKey === currentKey) {
    return cached.result;
  }

  // Perform scan
  const start = Date.now();
  const endpoints = scanEndpoints(projectPath);
  const tables = scanTables(projectPath);
  const scanDurationMs = Date.now() - start;

  const result: SourceScanResult = {
    endpoints,
    tables,
    scannedAt: Date.now(),
    scanDurationMs,
  };

  // Cache
  saveScanCache(projectPath, { invalidationKey: currentKey, result });

  console.log(`[SourceScanner] Scanned ${projectPath}: ${endpoints.length} endpoints, ${tables.length} tables in ${scanDurationMs}ms`);
  return result;
}

// ─── Endpoint Scanning ──────────────────────────────────────────────────

function scanEndpoints(projectPath: string): ScannedEndpoint[] {
  const endpoints: ScannedEndpoint[] = [];

  // 1. Tier-agent route pattern: *.routes.ts files
  endpoints.push(...scanTierAgentRoutes(projectPath));

  // 2. Express/Hono/Fastify patterns
  endpoints.push(...scanExpressRoutes(projectPath));

  // 3. Next.js App Router
  endpoints.push(...scanNextjsAppRoutes(projectPath));

  // 4. Next.js Pages API
  endpoints.push(...scanNextjsPagesApi(projectPath));

  // Deduplicate by method+path
  const seen = new Set<string>();
  return endpoints.filter(ep => {
    const key = `${ep.method}:${ep.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Scan tier-agent route files for { method: 'GET', pattern: /^\/path$/ } objects.
 */
function scanTierAgentRoutes(projectPath: string): ScannedEndpoint[] {
  const endpoints: ScannedEndpoint[] = [];
  const routesDirs = [
    path.join(projectPath, 'src', 'routes'),
    path.join(projectPath, 'tier-agent-core', 'src', 'routes'),
  ];

  for (const routesDir of routesDirs) {
    const files = simpleGlob(routesDir, '**/*.routes.ts');
    for (const file of files) {
      const relPath = path.relative(projectPath, file);
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          // Match: method: 'GET',
          const methodMatch = line.match(/method:\s*'(GET|POST|PUT|DELETE|PATCH)'/);
          if (!methodMatch) continue;
          const method = methodMatch[1];

          // Look for pattern in same line or next few lines
          for (let j = i; j < Math.min(i + 3, lines.length); j++) {
            const patternMatch = lines[j].match(/pattern:\s*\/\^(.*?)\$\//);
            if (patternMatch) {
              const rawPattern = patternMatch[1];
              // Convert regex to path: \/ → /, strip named groups, etc.
              const routePath = rawPattern
                .replace(/\\\//g, '/')
                .replace(/\(\?<\w+>[^)]+\)/g, ':param')  // named groups → :param
                .replace(/\([^)]+\)/g, ':param')           // capture groups → :param
                .replace(/\[\^\/\]\+/g, ':param');          // [^/]+ → :param
              endpoints.push({
                method,
                path: routePath,
                sourceFile: relPath,
                lineNumber: i + 1,
                framework: 'tier-agent-routes',
              });
              break;
            }
          }
        }
      } catch { /* ignore unreadable files */ }
    }
  }

  return endpoints;
}

/**
 * Scan for Express/Hono/Fastify patterns: app.get('/path', ...), router.post('/path', ...)
 */
function scanExpressRoutes(projectPath: string): ScannedEndpoint[] {
  const endpoints: ScannedEndpoint[] = [];
  const srcDir = path.join(projectPath, 'src');
  if (!fs.existsSync(srcDir)) return endpoints;

  const files = [
    ...simpleGlob(srcDir, '**/*.ts'),
    ...simpleGlob(srcDir, '**/*.js'),
  ].filter(f => !f.includes('.routes.ts')); // Skip tier-agent routes (handled separately)

  const routeRe = /(?:app|router|server)\.(get|post|put|delete|patch|use)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

  for (const file of files) {
    const relPath = path.relative(projectPath, file);
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match;
        routeRe.lastIndex = 0;
        while ((match = routeRe.exec(line)) !== null) {
          const method = match[1].toUpperCase();
          const routePath = match[2];
          // Skip middleware-like paths
          if (method === 'USE' && !routePath.startsWith('/')) continue;
          endpoints.push({
            method: method === 'USE' ? 'ALL' : method,
            path: routePath,
            sourceFile: relPath,
            lineNumber: i + 1,
            framework: 'express',
          });
        }
      }
    } catch { /* ignore */ }
  }

  return endpoints;
}

/**
 * Scan Next.js App Router: app/.../route.ts files, HTTP methods from exported function names.
 */
function scanNextjsAppRoutes(projectPath: string): ScannedEndpoint[] {
  const endpoints: ScannedEndpoint[] = [];
  const appDir = path.join(projectPath, 'app');
  const srcAppDir = path.join(projectPath, 'src', 'app');

  for (const dir of [appDir, srcAppDir]) {
    const routeFiles = simpleGlob(dir, '**/route.ts').concat(simpleGlob(dir, '**/route.js'));
    for (const file of routeFiles) {
      const relPath = path.relative(projectPath, file);
      // Derive API path from directory structure
      const routeDir = path.dirname(file);
      const baseDir = dir;
      const apiPath = '/' + path.relative(baseDir, routeDir)
        .replace(/\\/g, '/')
        .replace(/\[([^\]]+)\]/g, ':$1'); // [param] → :param

      try {
        const content = fs.readFileSync(file, 'utf-8');
        const methodRe = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)/g;
        let match;
        while ((match = methodRe.exec(content)) !== null) {
          endpoints.push({
            method: match[1],
            path: apiPath,
            sourceFile: relPath,
            framework: 'nextjs-app',
          });
        }
      } catch { /* ignore */ }
    }
  }

  return endpoints;
}

/**
 * Scan Next.js Pages API: pages/api/.../[name].ts files. Path from file path.
 */
function scanNextjsPagesApi(projectPath: string): ScannedEndpoint[] {
  const endpoints: ScannedEndpoint[] = [];
  const pagesApiDir = path.join(projectPath, 'pages', 'api');
  const srcPagesApiDir = path.join(projectPath, 'src', 'pages', 'api');

  for (const dir of [pagesApiDir, srcPagesApiDir]) {
    const files = [
      ...simpleGlob(dir, '**/*.ts'),
      ...simpleGlob(dir, '**/*.js'),
    ].filter(f => !f.endsWith('.d.ts'));

    for (const file of files) {
      const relPath = path.relative(projectPath, file);
      // Derive API path from file path
      const relToApi = path.relative(dir, file);
      const apiPath = '/api/' + relToApi
        .replace(/\\/g, '/')
        .replace(/\.(ts|js)$/, '')
        .replace(/\/index$/, '')
        .replace(/\[([^\]]+)\]/g, ':$1');

      endpoints.push({
        method: 'ALL',
        path: apiPath,
        sourceFile: relPath,
        framework: 'nextjs-pages',
      });
    }
  }

  return endpoints;
}

// ─── Table Scanning ──────────────────────────────────────────────────

function scanTables(projectPath: string): ScannedTable[] {
  const tables: ScannedTable[] = [];
  const seen = new Set<string>();

  // 1. SQL migrations
  const migrationTables = scanSqlMigrations(projectPath);
  for (const t of migrationTables) {
    if (!seen.has(t.name)) {
      seen.add(t.name);
      tables.push(t);
    }
  }

  // 2. Code references
  const codeTables = scanCodeTableReferences(projectPath);
  for (const t of codeTables) {
    if (!seen.has(t.name)) {
      seen.add(t.name);
      tables.push(t);
    }
  }

  return tables;
}

/**
 * Scan SQL migration files for CREATE TABLE statements.
 */
function scanSqlMigrations(projectPath: string): ScannedTable[] {
  const tables: ScannedTable[] = [];
  const migrationDirs = ['migrations', 'database', 'db', 'supabase/migrations'];

  for (const dir of migrationDirs) {
    const fullDir = path.join(projectPath, dir);
    const sqlFiles = simpleGlob(fullDir, '**/*.sql');

    for (const file of sqlFiles) {
      const relPath = path.relative(projectPath, file);
      try {
        const content = fs.readFileSync(file, 'utf-8');

        // CREATE TABLE [IF NOT EXISTS] [schema.]tablename
        const createTableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?\s*\(/gi;
        let match;
        while ((match = createTableRe.exec(content)) !== null) {
          const tableName = match[1];
          // Skip system/reserved names
          if (/^(pg_|sql_|information_schema)/.test(tableName)) continue;

          // Extract columns from the CREATE TABLE body
          const columns = extractColumnsFromCreateTable(content, match.index);

          tables.push({
            name: tableName,
            source: 'migration',
            sourceFile: relPath,
            columns: columns.length > 0 ? columns : undefined,
          });
        }
      } catch { /* ignore */ }
    }
  }

  return tables;
}

/**
 * Extract column names from a CREATE TABLE statement body.
 */
function extractColumnsFromCreateTable(sql: string, startIndex: number): string[] {
  const columns: string[] = [];

  // Find the opening paren after the table name
  const parenStart = sql.indexOf('(', startIndex);
  if (parenStart === -1) return columns;

  // Find matching closing paren
  let depth = 1;
  let pos = parenStart + 1;
  let body = '';
  while (pos < sql.length && depth > 0) {
    if (sql[pos] === '(') depth++;
    else if (sql[pos] === ')') depth--;
    if (depth > 0) body += sql[pos];
    pos++;
  }

  // Parse column definitions — each line before CONSTRAINT/PRIMARY/UNIQUE/FOREIGN/CHECK
  const lines = body.split(',');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip constraints, indexes, etc.
    if (/^\s*(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|INDEX|EXCLUDE)\b/i.test(trimmed)) continue;
    // Extract column name (first word, possibly quoted)
    const colMatch = trimmed.match(/^"?(\w+)"?\s+/);
    if (colMatch) {
      const colName = colMatch[1];
      // Skip SQL keywords that might appear as first word
      if (!/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|INDEX|EXCLUDE|KEY|REFERENCES)$/i.test(colName)) {
        columns.push(colName);
      }
    }
  }

  return columns;
}

/**
 * Scan source code for table name references (ORM patterns, raw SQL in code).
 */
function scanCodeTableReferences(projectPath: string): ScannedTable[] {
  const tables: ScannedTable[] = [];
  const seen = new Set<string>();

  const srcDir = path.join(projectPath, 'src');
  if (!fs.existsSync(srcDir)) return tables;

  const files = [
    ...simpleGlob(srcDir, '**/*.ts'),
    ...simpleGlob(srcDir, '**/*.js'),
  ];

  // Patterns that reference table names
  const patterns = [
    /\.from\(\s*['"`](\w+)['"`]\s*\)/g,           // .from('tablename')
    /\.table\(\s*['"`](\w+)['"`]\s*\)/g,           // .table('tablename')
    /\.into\(\s*['"`](\w+)['"`]\s*\)/g,            // .into('tablename')
    /INSERT\s+INTO\s+["']?(\w+)["']?/gi,           // INSERT INTO tablename
    /UPDATE\s+["']?(\w+)["']?\s+SET/gi,            // UPDATE tablename SET
    /DELETE\s+FROM\s+["']?(\w+)["']?/gi,           // DELETE FROM tablename
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi, // CREATE TABLE
  ];

  for (const file of files) {
    const relPath = path.relative(projectPath, file);
    try {
      const content = fs.readFileSync(file, 'utf-8');

      for (const re of patterns) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(content)) !== null) {
          const tableName = match[1];
          // Filter out obvious non-table names
          if (tableName.length < 2) continue;
          if (/^(select|insert|update|delete|create|alter|drop|from|where|and|or|set|values|into)$/i.test(tableName)) continue;
          if (/^(pg_|sql_|information_schema)/.test(tableName)) continue;

          if (!seen.has(tableName)) {
            seen.add(tableName);
            tables.push({
              name: tableName,
              source: 'code-reference',
              sourceFile: relPath,
            });
          }
        }
      }
    } catch { /* ignore */ }
  }

  return tables;
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Simple synchronous glob that recursively finds files matching a pattern.
 * Returns empty array if directory doesn't exist.
 */
function simpleGlob(dir: string, pattern: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const results: string[] = [];
  const parts = pattern.split('/');

  function walk(currentDir: string, patternIndex: number): void {
    if (patternIndex >= parts.length) return;

    const part = parts[patternIndex];
    const isLast = patternIndex === parts.length - 1;

    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      if (part === '**') {
        // Match zero or more directories
        // Try matching remaining pattern at this level
        walk(currentDir, patternIndex + 1);
        // Recurse into subdirectories
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            walk(path.join(currentDir, entry.name), patternIndex);
          }
        }
        return;
      }

      // Convert glob pattern to regex
      const regexStr = '^' + part
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') + '$';
      const re = new RegExp(regexStr);

      for (const entry of entries) {
        if (!re.test(entry.name)) continue;

        const fullPath = path.join(currentDir, entry.name);

        if (isLast) {
          if (entry.isFile()) {
            results.push(fullPath);
          }
        } else if (entry.isDirectory()) {
          walk(fullPath, patternIndex + 1);
        }
      }
    } catch { /* ignore permission errors */ }
  }

  walk(dir, 0);
  return results;
}

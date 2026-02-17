/**
 * Resource Extractor — Extracts non-file resources from Bash tool use commands
 *
 * Identifies database operations (direct, via docker exec, via SSH), API calls,
 * Docker operations, SSH connections, and service management from command strings.
 *
 * For database operations, extracts:
 * - The database system (postgresql, mysql, sqlite, mongodb, redis)
 * - Connection details (host, port, database, user)
 * - SQL operation types (SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE)
 * - Table names touched by the operations
 * - Execution context (direct, docker, ssh)
 */

// ─── Types ──────────────────────────────────────────────────

export type ResourceCategory = 'database' | 'ssh' | 'api' | 'docker' | 'service';
export type ResourceScope = 'internal' | 'external';
export type SqlOperationType = 'select' | 'insert' | 'update' | 'delete' | 'create' | 'alter' | 'drop' | 'truncate';
export type DbSystem = 'postgresql' | 'mysql' | 'sqlite' | 'mongodb' | 'redis';

export interface ExtractedResource {
  key: string;
  category: ResourceCategory;
  name: string;               // display name: "postgres:langmart", "opc@213.35.107.246"
  target: string;             // connection target
  scope: ResourceScope;
  command: string;            // the CLI tool used (psql, docker exec, curl, etc.)
  executionContext?: 'direct' | 'docker' | 'ssh';
  // Database specifics
  dbSystem?: DbSystem;
  dbHost?: string;
  dbPort?: number;
  dbName?: string;
  dbUser?: string;
  dbTables?: string[];
  dbOperations?: SqlOperationType[];
}

export interface CachedResource {
  key: string;
  category: ResourceCategory;
  name: string;
  target: string;
  scope: ResourceScope;
  accessCount: number;
  commands: string[];           // distinct CLI tools used
  firstSeen: string | null;
  lastSeen: string | null;
  executionContext?: string;    // 'direct' | 'docker' | 'ssh'
  // Database specifics
  dbSystem?: string;
  dbTables?: string[];         // accumulated distinct tables
  dbOperations?: string[];     // accumulated distinct operations
}

// ─── Constants ──────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '']);
const SQL_KEYWORDS = new Set(['select', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'truncate']);

// ─── Main Extraction ──────────────────────────────────────────────────

/**
 * Extract resources from a Bash command string.
 * A single command can yield multiple resources (e.g., ssh wrapping curl).
 */
export function extractResourcesFromCommand(command: string): ExtractedResource[] {
  const resources: ExtractedResource[] = [];
  if (!command || command.length < 3) return resources;

  // Split compound commands (&&, ;, |) and process each segment
  // But only split on top-level separators, not inside quotes
  const segments = splitCommandSegments(command);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed || trimmed.length < 3) continue;

    // Try to extract resources from this segment
    const extracted = extractFromSegment(trimmed);
    resources.push(...extracted);
  }

  return resources;
}

/**
 * Map-based resource merger for O(1) lookups during incremental parsing.
 * Build from existing array, merge extracted resources, then flush back to array.
 */
export class ResourceMerger {
  private map: Map<string, CachedResource>;

  constructor(existing: CachedResource[]) {
    this.map = new Map();
    for (const r of existing) {
      this.map.set(r.key, r);
    }
  }

  merge(extracted: ExtractedResource, timestamp: string | null): void {
    const existing = this.map.get(extracted.key);
    if (existing) {
      existing.accessCount++;
      if (timestamp) existing.lastSeen = timestamp;
      if (!existing.commands.includes(extracted.command)) {
        existing.commands.push(extracted.command);
      }
      if (extracted.dbTables && extracted.dbTables.length > 0) {
        if (!existing.dbTables) existing.dbTables = [];
        for (const t of extracted.dbTables) {
          if (!existing.dbTables.includes(t)) existing.dbTables.push(t);
        }
      }
      if (extracted.dbOperations && extracted.dbOperations.length > 0) {
        if (!existing.dbOperations) existing.dbOperations = [];
        for (const op of extracted.dbOperations) {
          if (!existing.dbOperations.includes(op)) existing.dbOperations.push(op);
        }
      }
    } else {
      this.map.set(extracted.key, {
        key: extracted.key,
        category: extracted.category,
        name: extracted.name,
        target: extracted.target,
        scope: extracted.scope,
        accessCount: 1,
        commands: [extracted.command],
        firstSeen: timestamp,
        lastSeen: timestamp,
        executionContext: extracted.executionContext,
        dbSystem: extracted.dbSystem,
        dbTables: extracted.dbTables ? [...extracted.dbTables] : undefined,
        dbOperations: extracted.dbOperations ? [...extracted.dbOperations] : undefined,
      });
    }
  }

  toArray(): CachedResource[] {
    return Array.from(this.map.values());
  }
}

// ─── Segment Extraction ──────────────────────────────────────────────────

function extractFromSegment(cmd: string): ExtractedResource[] {
  const resources: ExtractedResource[] = [];

  // 1. Check for docker exec wrapping a database command
  const dockerExec = parseDockerExec(cmd);
  if (dockerExec) {
    const dbRes = parseDatabaseCommand(dockerExec.innerCommand, 'docker', dockerExec.container);
    if (dbRes) {
      resources.push(dbRes);
      return resources;
    }
    // docker exec with non-db command — could still be interesting (e.g., curl inside container)
    const innerResources = extractFromSegment(dockerExec.innerCommand);
    if (innerResources.length > 0) {
      for (const r of innerResources) {
        r.executionContext = 'docker';
      }
      resources.push(...innerResources);
      return resources;
    }
    // Fallback: just a docker exec command
    return resources;
  }

  // 2. Check for SSH wrapping another command
  const sshParsed = parseSshCommand(cmd);
  if (sshParsed) {
    // SSH itself is a resource
    resources.push({
      key: `ssh:${sshParsed.userHost}`,
      category: 'ssh',
      name: sshParsed.userHost,
      target: `ssh://${sshParsed.userHost}`,
      scope: 'external',
      command: 'ssh',
      executionContext: 'direct',
    });

    // Parse the remote command for nested resources
    if (sshParsed.remoteCommand) {
      const remoteResources = extractFromSegment(sshParsed.remoteCommand);
      for (const r of remoteResources) {
        r.executionContext = 'ssh';
        // Remote resources accessed via SSH are external
        r.scope = 'external';
      }
      resources.push(...remoteResources);
    }
    return resources;
  }

  // 3. Check for SCP/rsync (SSH file transfer)
  const scpTarget = parseScpRsync(cmd);
  if (scpTarget) {
    resources.push({
      key: `ssh:${scpTarget}`,
      category: 'ssh',
      name: scpTarget,
      target: `ssh://${scpTarget}`,
      scope: 'external',
      command: cmd.startsWith('rsync') ? 'rsync' : 'scp',
      executionContext: 'direct',
    });
    return resources;
  }

  // 4. Check for database commands (direct)
  const dbRes = parseDatabaseCommand(cmd, 'direct');
  if (dbRes) {
    resources.push(dbRes);
    return resources;
  }

  // 5. Check for API calls (curl, wget)
  const apiRes = parseApiCall(cmd);
  if (apiRes) {
    resources.push(apiRes);
    return resources;
  }

  // 6. Check for Docker operations (build, run, stop, etc.)
  const dockerRes = parseDockerOperation(cmd);
  if (dockerRes) {
    resources.push(dockerRes);
    return resources;
  }

  // 7. Check for service management (pm2, systemctl)
  const serviceRes = parseServiceCommand(cmd);
  if (serviceRes) {
    resources.push(serviceRes);
    return resources;
  }

  return resources;
}

// ─── Docker Exec Parser ──────────────────────────────────────────────────

interface DockerExecResult {
  container: string;
  innerCommand: string;
}

function parseDockerExec(cmd: string): DockerExecResult | null {
  // Match: docker exec [-it] [-e VAR=val] [--user X] <container> <command...>
  // Handle: cat ... | docker exec -i <container> <command>
  const patterns = [
    // Standard: docker exec [flags] container command
    /docker\s+exec\s+(?:(?:-[a-zA-Z]+\s+)*?)(\S+)\s+((?:psql|mysql|mongosh|mongo|redis-cli|bash|sh|curl|wget)\s.*)/s,
    // With explicit flags before container
    /docker\s+exec\s+(?:(?:-[a-zA-Z]+\s+|--\w[\w-]*(?:=\S+|\s+\S+)\s+)*)(\S+)\s+(.+)/s,
  ];

  for (const re of patterns) {
    const match = cmd.match(re);
    if (match) {
      let container = match[1].replace(/^["']+|["']+$/g, '');
      const innerCommand = match[2].trim();
      // Skip if container looks like a flag or shell variable
      if (container.startsWith('-') || container.startsWith('$')) continue;
      return { container, innerCommand };
    }
  }
  return null;
}

// ─── SSH Parser ──────────────────────────────────────────────────

interface SshResult {
  userHost: string;
  remoteCommand: string | null;
}

function parseSshCommand(cmd: string): SshResult | null {
  // Match: ssh [flags] [user@]host [command]
  // Common flags: -i key, -p port, -o option, -J jumphost
  const sshRe = /^ssh\s+(?:(?:-[a-zA-Z]\s+\S+\s+|--?\S+\s+)*)(\S+@\S+|\S+)\s*(.*)/s;
  const match = cmd.match(sshRe);
  if (!match) return null;

  const userHost = match[1];
  // Skip if it looks like a flag, redirect, or non-host value
  if (userHost.startsWith('-') || userHost.startsWith('2>') || userHost.startsWith('>') || userHost.startsWith('|')) return null;
  // Must look like a hostname or user@host (contain alphanumeric, dots, or @)
  if (!/[@.]/.test(userHost) && !/^\w[\w.-]+$/.test(userHost)) return null;

  let remoteCommand = match[2]?.trim() || null;
  // Strip surrounding quotes from remote command
  if (remoteCommand) {
    if ((remoteCommand.startsWith('"') && remoteCommand.endsWith('"')) ||
        (remoteCommand.startsWith("'") && remoteCommand.endsWith("'"))) {
      remoteCommand = remoteCommand.slice(1, -1);
    }
  }

  return { userHost, remoteCommand: remoteCommand || null };
}

// ─── SCP/Rsync Parser ──────────────────────────────────────────────────

function parseScpRsync(cmd: string): string | null {
  // scp [-flags] source user@host:path (or vice versa)
  const scpRe = /(?:scp|rsync)\s+(?:(?:-\S+\s+)*)(?:\S+\s+)*?(\S+@\S+):/;
  const match = cmd.match(scpRe);
  if (match) {
    return match[1]; // user@host
  }
  return null;
}

// ─── Database Command Parser ──────────────────────────────────────────────────

function parseDatabaseCommand(
  cmd: string,
  context: 'direct' | 'docker' | 'ssh',
  dockerContainer?: string
): ExtractedResource | null {
  // Try each database system
  return parsePsql(cmd, context, dockerContainer)
    || parseMysql(cmd, context, dockerContainer)
    || parseSqlite(cmd, context)
    || parseMongo(cmd, context, dockerContainer)
    || parseRedis(cmd, context, dockerContainer)
    || parsePgDumpRestore(cmd, context, dockerContainer);
}

function parsePsql(cmd: string, context: 'direct' | 'docker' | 'ssh', dockerContainer?: string): ExtractedResource | null {
  // Match psql with various flag patterns
  if (!/(?:^|\s)psql(?:\s|$)/.test(cmd)) return null;

  let host = '';
  let port: number | undefined;
  let dbName = '';
  let user = '';
  let sql = '';

  // Extract PGPASSWORD=... prefix (env var)
  // const pgPassMatch = cmd.match(/PGPASSWORD=\S+/);

  // Extract -h/--host
  const hostMatch = cmd.match(/-h\s+(\S+)|--host[= ](\S+)/);
  if (hostMatch) host = hostMatch[1] || hostMatch[2];

  // Extract -p/--port
  const portMatch = cmd.match(/-p\s+(\d+)|--port[= ](\d+)/);
  if (portMatch) port = parseInt(portMatch[1] || portMatch[2]);

  // Extract -d/--dbname (strip quotes)
  const dbMatch = cmd.match(/-d\s+["']?([^"'\s]+)["']?|--dbname[= ]["']?([^"'\s]+)["']?/);
  if (dbMatch) dbName = dbMatch[1] || dbMatch[2];

  // Extract -U/--username
  const userMatch = cmd.match(/-U\s+(\S+)|--username[= ](\S+)/);
  if (userMatch) user = userMatch[1] || userMatch[2];

  // Extract SQL from -c "..." or -c '...'
  const sqlMatch = cmd.match(/-c\s+"([^"]+)"|-c\s+'([^']+)'|-c\s+(\S+)/s);
  if (sqlMatch) sql = sqlMatch[1] || sqlMatch[2] || sqlMatch[3] || '';

  // Extract SQL from heredoc: psql ... << 'EOF'\nSQL\nEOF or <<EOF
  if (!sql) {
    const heredocMatch = cmd.match(/<<\s*'?(\w+)'?\s*\n([\s\S]*?)\n\1/);
    if (heredocMatch) sql = heredocMatch[2];
  }

  // Extract SQL from piped input: cat file.sql | docker exec -i ... psql ...
  // We can't read the file, but note the -f flag if present
  const fileMatch = cmd.match(/-f\s+(\S+)/);

  // Parse SQL for tables and operations
  const sqlDetails = sql ? extractSqlDetails(sql) : { tables: [], operations: [] };

  // Build resource
  const effectiveHost = host || (context === 'docker' ? 'docker' : 'localhost');
  const displayDb = dbName || 'unknown';
  const isLocal = context === 'docker' || LOCAL_HOSTS.has(host);

  const key = context === 'docker'
    ? `database:postgresql:docker:${dockerContainer || 'unknown'}:${displayDb}`
    : `database:postgresql:${effectiveHost}:${port || 5432}:${displayDb}`;

  const name = context === 'docker'
    ? `postgres:${displayDb} (${dockerContainer})`
    : `postgres:${displayDb}${host ? `@${host}` : ''}`;

  const target = context === 'docker'
    ? `docker://${dockerContainer}/postgresql/${displayDb}`
    : `postgresql://${user ? user + '@' : ''}${effectiveHost}:${port || 5432}/${displayDb}`;

  return {
    key,
    category: 'database',
    name,
    target,
    scope: isLocal ? 'internal' : 'external',
    command: fileMatch ? 'psql -f' : 'psql',
    executionContext: context,
    dbSystem: 'postgresql',
    dbHost: effectiveHost,
    dbPort: port || 5432,
    dbName: displayDb,
    dbUser: user || undefined,
    dbTables: sqlDetails.tables.length > 0 ? sqlDetails.tables : undefined,
    dbOperations: sqlDetails.operations.length > 0 ? sqlDetails.operations : undefined,
  };
}

function parseMysql(cmd: string, context: 'direct' | 'docker' | 'ssh', dockerContainer?: string): ExtractedResource | null {
  if (!/(?:^|\s)mysql(?:\s|$)/.test(cmd)) return null;
  // Skip mysqldump — handled separately if needed
  if (/mysqldump/.test(cmd)) return null;

  let host = '';
  let port: number | undefined;
  let dbName = '';
  let user = '';
  let sql = '';

  const hostMatch = cmd.match(/-h\s+(\S+)|--host[= ](\S+)/);
  if (hostMatch) host = hostMatch[1] || hostMatch[2];

  const portMatch = cmd.match(/-P\s+(\d+)|--port[= ](\d+)/);
  if (portMatch) port = parseInt(portMatch[1] || portMatch[2]);

  const userMatch = cmd.match(/-u\s+(\S+)|--user[= ](\S+)/);
  if (userMatch) user = userMatch[1] || userMatch[2];

  // Database name is usually the last positional argument
  // mysql -u root mydb -e "SQL"
  const dbFromArgs = cmd.match(/mysql\s+(?:(?:-\S+\s+\S+\s+|-\S+\s+)*)(\w[\w-]+)(?:\s+-e|\s+--execute|\s*$)/);
  if (dbFromArgs && !dbFromArgs[1].startsWith('-')) dbName = dbFromArgs[1];

  // Extract -e "SQL"
  const sqlMatch = cmd.match(/-e\s+"([^"]+)"|-e\s+'([^']+)'/s);
  if (sqlMatch) sql = sqlMatch[1] || sqlMatch[2] || '';

  const sqlDetails = sql ? extractSqlDetails(sql) : { tables: [], operations: [] };

  const effectiveHost = host || (context === 'docker' ? 'docker' : 'localhost');
  const displayDb = dbName || 'unknown';
  const isLocal = context === 'docker' || LOCAL_HOSTS.has(host);

  const key = context === 'docker'
    ? `database:mysql:docker:${dockerContainer || 'unknown'}:${displayDb}`
    : `database:mysql:${effectiveHost}:${port || 3306}:${displayDb}`;

  return {
    key,
    category: 'database',
    name: context === 'docker'
      ? `mysql:${displayDb} (${dockerContainer})`
      : `mysql:${displayDb}${host ? `@${host}` : ''}`,
    target: `mysql://${user ? user + '@' : ''}${effectiveHost}:${port || 3306}/${displayDb}`,
    scope: isLocal ? 'internal' : 'external',
    command: 'mysql',
    executionContext: context,
    dbSystem: 'mysql',
    dbHost: effectiveHost,
    dbPort: port || 3306,
    dbName: displayDb,
    dbUser: user || undefined,
    dbTables: sqlDetails.tables.length > 0 ? sqlDetails.tables : undefined,
    dbOperations: sqlDetails.operations.length > 0 ? sqlDetails.operations : undefined,
  };
}

function parseSqlite(cmd: string, context: 'direct' | 'docker' | 'ssh'): ExtractedResource | null {
  const match = cmd.match(/(?:^|\s)sqlite3\s+(\S+)/);
  if (!match) return null;

  const dbPath = match[1];
  const dbName = dbPath.split('/').pop() || dbPath;

  // Extract SQL from command args
  let sql = '';
  const sqlMatch = cmd.match(/sqlite3\s+\S+\s+"([^"]+)"|sqlite3\s+\S+\s+'([^']+)'/s);
  if (sqlMatch) sql = sqlMatch[1] || sqlMatch[2] || '';

  const sqlDetails = sql ? extractSqlDetails(sql) : { tables: [], operations: [] };

  return {
    key: `database:sqlite:${dbPath}`,
    category: 'database',
    name: `sqlite:${dbName}`,
    target: `sqlite://${dbPath}`,
    scope: 'internal',
    command: 'sqlite3',
    executionContext: context,
    dbSystem: 'sqlite',
    dbName: dbName,
    dbTables: sqlDetails.tables.length > 0 ? sqlDetails.tables : undefined,
    dbOperations: sqlDetails.operations.length > 0 ? sqlDetails.operations : undefined,
  };
}

function parseMongo(cmd: string, context: 'direct' | 'docker' | 'ssh', dockerContainer?: string): ExtractedResource | null {
  if (!/(?:^|\s)(?:mongosh|mongo)(?:\s|$)/.test(cmd)) return null;

  let host = 'localhost';
  let port = 27017;
  let dbName = '';

  // mongodb://host:port/db connection string
  const connMatch = cmd.match(/mongodb:\/\/([^/\s]+?)(?::(\d+))?\/(\w+)/);
  if (connMatch) {
    host = connMatch[1];
    if (connMatch[2]) port = parseInt(connMatch[2]);
    dbName = connMatch[3];
  }

  // --eval "js expression"
  let evalExpr = '';
  const evalMatch = cmd.match(/--eval\s+"([^"]+)"|--eval\s+'([^']+)'/);
  if (evalMatch) evalExpr = evalMatch[1] || evalMatch[2] || '';

  // Extract collection names from eval: db.users.find(), db.orders.insertOne()
  const collections: string[] = [];
  const operations: SqlOperationType[] = [];
  if (evalExpr) {
    const collMatch = evalExpr.matchAll(/db\.(\w+)\.(find|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|drop|createIndex|aggregate)/g);
    for (const m of collMatch) {
      if (!collections.includes(m[1])) collections.push(m[1]);
      const op = m[2];
      if (op.startsWith('find') || op === 'aggregate') {
        if (!operations.includes('select')) operations.push('select');
      } else if (op.startsWith('insert')) {
        if (!operations.includes('insert')) operations.push('insert');
      } else if (op.startsWith('update')) {
        if (!operations.includes('update')) operations.push('update');
      } else if (op.startsWith('delete')) {
        if (!operations.includes('delete')) operations.push('delete');
      } else if (op === 'drop') {
        if (!operations.includes('drop')) operations.push('drop');
      }
    }
  }

  const effectiveHost = host || (context === 'docker' ? 'docker' : 'localhost');
  const isLocal = context === 'docker' || LOCAL_HOSTS.has(host);

  return {
    key: `database:mongodb:${effectiveHost}:${port}:${dbName || 'unknown'}`,
    category: 'database',
    name: `mongo:${dbName || 'unknown'}${!isLocal ? `@${host}` : ''}`,
    target: `mongodb://${effectiveHost}:${port}/${dbName || ''}`,
    scope: isLocal ? 'internal' : 'external',
    command: cmd.includes('mongosh') ? 'mongosh' : 'mongo',
    executionContext: context,
    dbSystem: 'mongodb',
    dbHost: effectiveHost,
    dbPort: port,
    dbName: dbName || undefined,
    dbTables: collections.length > 0 ? collections : undefined,
    dbOperations: operations.length > 0 ? operations : undefined,
  };
}

function parseRedis(cmd: string, context: 'direct' | 'docker' | 'ssh', dockerContainer?: string): ExtractedResource | null {
  if (!/(?:^|\s)redis-cli(?:\s|$)/.test(cmd)) return null;

  let host = '';
  let port: number | undefined;

  const hostMatch = cmd.match(/-h\s+(\S+)/);
  if (hostMatch) host = hostMatch[1];

  const portMatch = cmd.match(/-p\s+(\d+)/);
  if (portMatch) port = parseInt(portMatch[1]);

  const effectiveHost = host || (context === 'docker' ? 'docker' : 'localhost');
  const isLocal = context === 'docker' || LOCAL_HOSTS.has(host);

  return {
    key: `database:redis:${effectiveHost}:${port || 6379}`,
    category: 'database',
    name: `redis${!isLocal ? `@${host}` : ''}`,
    target: `redis://${effectiveHost}:${port || 6379}`,
    scope: isLocal ? 'internal' : 'external',
    command: 'redis-cli',
    executionContext: context,
    dbSystem: 'redis',
    dbHost: effectiveHost,
    dbPort: port || 6379,
  };
}

function parsePgDumpRestore(cmd: string, context: 'direct' | 'docker' | 'ssh', dockerContainer?: string): ExtractedResource | null {
  const match = cmd.match(/(?:^|\s)(pg_dump|pg_restore)(?:\s|$)/);
  if (!match) return null;

  const tool = match[1];
  let host = '';
  let port: number | undefined;
  let dbName = '';
  let user = '';

  const hostMatch = cmd.match(/-h\s+(\S+)|--host[= ](\S+)/);
  if (hostMatch) host = hostMatch[1] || hostMatch[2];

  const portMatch = cmd.match(/-p\s+(\d+)|--port[= ](\d+)/);
  if (portMatch) port = parseInt(portMatch[1] || portMatch[2]);

  const dbMatch = cmd.match(/-d\s+(\S+)|--dbname[= ](\S+)/);
  if (dbMatch) dbName = dbMatch[1] || dbMatch[2];

  const userMatch = cmd.match(/-U\s+(\S+)|--username[= ](\S+)/);
  if (userMatch) user = userMatch[1] || userMatch[2];

  const effectiveHost = host || (context === 'docker' ? 'docker' : 'localhost');
  const displayDb = dbName || 'unknown';
  const isLocal = context === 'docker' || LOCAL_HOSTS.has(host);

  const key = context === 'docker'
    ? `database:postgresql:docker:${dockerContainer || 'unknown'}:${displayDb}`
    : `database:postgresql:${effectiveHost}:${port || 5432}:${displayDb}`;

  return {
    key,
    category: 'database',
    name: context === 'docker'
      ? `postgres:${displayDb} (${dockerContainer})`
      : `postgres:${displayDb}${host ? `@${host}` : ''}`,
    target: `postgresql://${user ? user + '@' : ''}${effectiveHost}:${port || 5432}/${displayDb}`,
    scope: isLocal ? 'internal' : 'external',
    command: tool,
    executionContext: context,
    dbSystem: 'postgresql',
    dbHost: effectiveHost,
    dbPort: port || 5432,
    dbName: displayDb,
    dbUser: user || undefined,
    dbOperations: tool === 'pg_dump' ? ['select'] : ['create'],
  };
}

// ─── API Call Parser ──────────────────────────────────────────────────

function parseApiCall(cmd: string): ExtractedResource | null {
  // curl or wget
  const isCurl = /(?:^|\s)curl\s/.test(cmd);
  const isWget = /(?:^|\s)wget\s/.test(cmd);
  if (!isCurl && !isWget) return null;

  // Extract URL from the command
  let url = '';
  if (isCurl) {
    // curl URL or curl [flags] URL — URL can be anywhere
    // Try to find a URL pattern (http:// or https://)
    const urlMatch = cmd.match(/(https?:\/\/[^\s'"]+)/);
    if (urlMatch) url = urlMatch[1];
  } else {
    const urlMatch = cmd.match(/wget\s+(?:(?:-\S+\s+)*)(\S+)/);
    if (urlMatch) url = urlMatch[1];
  }

  if (!url) return null;

  // Parse URL
  let hostname = '';
  let port: number | undefined;
  let pathname = '';
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    port = parsed.port ? parseInt(parsed.port) : undefined;
    pathname = parsed.pathname;
  } catch {
    // Try simple extraction
    const simpleMatch = url.match(/https?:\/\/([^/:]+)(?::(\d+))?([^?\s]*)/);
    if (simpleMatch) {
      hostname = simpleMatch[1];
      if (simpleMatch[2]) port = parseInt(simpleMatch[2]);
      pathname = simpleMatch[3] || '/';
    }
  }

  if (!hostname) return null;
  // Skip shell variables in hostnames (e.g., ${gateway_ip})
  if (/\$\{|\$[A-Z]/.test(hostname)) return null;

  // Extract HTTP method from -X flag
  const methodMatch = cmd.match(/-X\s+(\w+)/);
  const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';

  const isLocal = LOCAL_HOSTS.has(hostname);

  // Build a meaningful display name
  const portStr = port ? `:${port}` : '';
  const pathSummary = pathname.length > 30 ? pathname.slice(0, 30) + '...' : pathname;

  return {
    key: `api:${hostname}${portStr}`,
    category: 'api',
    name: isLocal ? `localhost${portStr}` : hostname,
    target: `${hostname}${portStr}${pathSummary}`,
    scope: isLocal ? 'internal' : 'external',
    command: isCurl ? 'curl' : 'wget',
  };
}

// ─── Docker Operation Parser ──────────────────────────────────────────────────

function parseDockerOperation(cmd: string): ExtractedResource | null {
  // docker build, run, stop, start, logs, ps, inspect, images, etc.
  // Skip docker exec (handled separately)
  if (/docker\s+exec/.test(cmd)) return null;

  // docker-compose / docker compose
  const composeMatch = cmd.match(/(?:docker[- ]compose|docker\s+compose)\s+(\w+)/);
  if (composeMatch) {
    return {
      key: `docker:compose`,
      category: 'docker',
      name: 'docker-compose',
      target: `docker-compose ${composeMatch[1]}`,
      scope: 'internal',
      command: 'docker-compose',
    };
  }

  // docker <subcommand> [flags] <target>
  const dockerMatch = cmd.match(/docker\s+(build|run|start|stop|restart|rm|kill|logs|inspect|pull|push|images|ps|network|volume)\s+(.*)/s);
  if (!dockerMatch) return null;

  const subcommand = dockerMatch[1];
  const args = dockerMatch[2].trim();

  // Extract container/image name
  let target = '';
  if (subcommand === 'build') {
    // docker build -t image:tag .
    const tagMatch = args.match(/-t\s+(\S+)/);
    target = tagMatch ? tagMatch[1] : 'unknown';
  } else if (subcommand === 'run') {
    // docker run [flags] image [cmd]
    // Image is usually after all flags
    const imageMatch = args.match(/(?:(?:-\S+\s+\S+\s+|-\S+\s+|--\S+\s+)*)(\S+)/);
    target = imageMatch ? imageMatch[1] : 'unknown';
  } else if (['stop', 'start', 'restart', 'rm', 'kill', 'logs', 'inspect'].includes(subcommand)) {
    // docker stop container — extract container name, strip quotes
    const containerMatch = args.match(/(?:(?:-\S+\s+\S+\s+|-\S+\s+|--\S+\s+)*)["']?([a-zA-Z0-9][\w.*-]*)["']?/);
    target = containerMatch ? containerMatch[1] : 'unknown';
  } else if (subcommand === 'ps' || subcommand === 'images') {
    // docker ps — no specific target, list command
    const filterMatch = args.match(/--filter\s+["']?name=([^"'\s]+)["']?/);
    target = filterMatch ? filterMatch[1] : 'all';
  } else if (subcommand === 'network' || subcommand === 'volume') {
    target = `${subcommand}`;
  }

  // Clean target: strip quotes, shell variables, redirects
  target = target.replace(/^["']+|["']+$/g, '');  // strip surrounding quotes
  // Skip if target looks like a flag, redirect, shell variable, or noise
  if (!target || target.startsWith('-') || target.startsWith('2>') || target.startsWith('>') || target.startsWith('|')) return null;
  if (/^\$|^[<>|&;]|^\d+[<>]|^2>|^\\/.test(target)) return null;
  // Must be at least 2 chars, contain a letter, and look like a container/image name
  if (target.length < 2 || !/[a-z]/.test(target)) return null;
  // Skip obvious non-container tokens
  if (/^(echo|id|true|false|test|docker|CONTAINER|vol|cid|c)$/i.test(target)) return null;

  return {
    key: `docker:${target}`,
    category: 'docker',
    name: `docker:${target}`,
    target: `docker://${target}`,
    scope: 'internal',
    command: `docker ${subcommand}`,
  };
}

// ─── Service Command Parser ──────────────────────────────────────────────────

function parseServiceCommand(cmd: string): ExtractedResource | null {
  // pm2
  const pm2Match = cmd.match(/pm2\s+(start|stop|restart|reload|delete|list|show|logs|status)\s*(\S*)/);
  if (pm2Match) {
    const action = pm2Match[1];
    let target = pm2Match[2] || 'all';
    // Skip noise targets
    if (target.startsWith('2>') || target.startsWith('>') || target.startsWith('|') || target.startsWith('$')) target = 'all';
    return {
      key: `service:pm2:${target}`,
      category: 'service',
      name: `pm2:${target}`,
      target: `pm2://${target}`,
      scope: 'internal',
      command: `pm2 ${action}`,
    };
  }

  // systemctl
  const systemctlMatch = cmd.match(/systemctl\s+(start|stop|restart|enable|disable|status|reload)\s+(\S+)/);
  if (systemctlMatch) {
    const action = systemctlMatch[1];
    const service = systemctlMatch[2];
    return {
      key: `service:systemctl:${service}`,
      category: 'service',
      name: service,
      target: `systemctl://${service}`,
      scope: 'internal',
      command: `systemctl ${action}`,
    };
  }

  return null;
}

// ─── SQL Detail Extractor ──────────────────────────────────────────────────

export function extractSqlDetails(sql: string): { tables: string[]; operations: SqlOperationType[] } {
  const tables = new Set<string>();
  const operations = new Set<SqlOperationType>();

  // Normalize: collapse whitespace, handle multiline
  const normalized = sql.replace(/\s+/g, ' ').trim();

  // Skip psql meta-commands (\d, \dt, \l, etc.)
  if (/^\\[a-z]/.test(normalized)) return { tables: [], operations: [] };

  // CREATE TABLE [IF NOT EXISTS] [schema.]table
  for (const m of normalized.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) {
    operations.add('create');
    tables.add(m[2]);
  }

  // ALTER TABLE [IF EXISTS] [schema.]table
  for (const m of normalized.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) {
    operations.add('alter');
    tables.add(m[2]);
  }

  // DROP TABLE [IF EXISTS] [schema.]table
  for (const m of normalized.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) {
    operations.add('drop');
    tables.add(m[2]);
  }

  // TRUNCATE [TABLE] [schema.]table
  for (const m of normalized.matchAll(/TRUNCATE\s+(?:TABLE\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) {
    operations.add('truncate');
    tables.add(m[2]);
  }

  // INSERT INTO [schema.]table
  for (const m of normalized.matchAll(/INSERT\s+INTO\s+(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) {
    operations.add('insert');
    tables.add(m[2]);
  }

  // UPDATE [schema.]table SET
  for (const m of normalized.matchAll(/UPDATE\s+(?:"?(\w+)"?\.)?"?(\w+)"?\s+SET/gi)) {
    operations.add('update');
    tables.add(m[2]);
  }

  // DELETE FROM [schema.]table
  for (const m of normalized.matchAll(/DELETE\s+FROM\s+(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) {
    operations.add('delete');
    tables.add(m[2]);
  }

  // SELECT ... FROM [schema.]table (also catches JOIN tables)
  for (const m of normalized.matchAll(/(?:FROM|JOIN)\s+(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) {
    const tableName = m[2];
    // Filter out SQL keywords that might be caught
    if (!SQL_KEYWORDS.has(tableName.toLowerCase()) && !/^(where|on|as|and|or|set|values|into|group|order|having|limit|offset|union|except|intersect|with|returning)$/i.test(tableName)) {
      if (!operations.has('insert') && !operations.has('update') && !operations.has('delete')) {
        operations.add('select');
      }
      tables.add(tableName);
    }
  }

  // If we have tables from DML but no explicit SELECT, check if there's a bare SELECT
  if (operations.size === 0 && /\bSELECT\b/i.test(normalized)) {
    operations.add('select');
  }

  return {
    tables: [...tables],
    operations: [...operations],
  };
}

// ─── Command Splitting ──────────────────────────────────────────────────

/**
 * Split a compound command into segments on && and ; and |,
 * but only at the top level (not inside quotes or subshells).
 * Only keeps segments that might contain resource-relevant commands.
 */
function splitCommandSegments(cmd: string): string[] {
  const segments: string[] = [];
  let current = '';
  let depth = 0;         // Parenthesis/subshell depth
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      current += ch;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (inSingle || inDouble) {
      current += ch;
      continue;
    }

    if (ch === '(' || ch === '{') {
      depth++;
      current += ch;
      continue;
    }

    if (ch === ')' || ch === '}') {
      depth--;
      current += ch;
      continue;
    }

    if (depth > 0) {
      current += ch;
      continue;
    }

    // Top-level separators
    if (ch === '&' && i + 1 < cmd.length && cmd[i + 1] === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      i++; // skip second &
      continue;
    }

    if (ch === ';') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }

    // Pipe — we care about the left side (e.g., `curl ... | jq`)
    // but the right side is usually just formatting (head, tail, jq, grep)
    if (ch === '|' && i + 1 < cmd.length && cmd[i + 1] !== '|') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

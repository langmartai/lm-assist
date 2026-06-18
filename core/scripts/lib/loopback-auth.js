'use strict';
/**
 * Loopback API-token helper for standalone scripts that call the local Core API.
 *
 * The Core gates every endpoint except /health behind the rotating worker token
 * (x-api-key). Out-of-process callers (these scripts, spawned by the daemons /
 * routes / MCP tools) must read that token and send it. Dev and prod share the
 * same file (getDataDir() === ~/.lm-assist for both unless LM_ASSIST_DATA_DIR is
 * set), so reading <dataDir>/api-token yields a token both accept.
 *
 * Mirrors core/src/auth/api-token.ts localApiToken()/lmAuthHeaders().
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function loopbackApiToken() {
  try {
    const dir = process.env.LM_ASSIST_DATA_DIR || path.join(os.homedir(), '.lm-assist');
    const t = fs.readFileSync(path.join(dir, 'api-token'), 'utf8').trim();
    return t || '';
  } catch {
    return '';
  }
}

/** Header object to spread into an outbound loopback request. Empty if no token. */
function loopbackAuthHeader() {
  const t = loopbackApiToken();
  return t ? { 'x-api-key': t } : {};
}

module.exports = { loopbackApiToken, loopbackAuthHeader };

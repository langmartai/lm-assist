#!/usr/bin/env bash
#
# deploy-prod.sh — Safe, repeatable redeploy of the lm-assist PROD (npm-global) Core
# ============================================================================
#
# WHAT IT DOES
#   Mirrors a freshly-built `core/dist` from this repo into the prod npm-global
#   install's `core/dist`, then does a CORE-ONLY restart (the prod Web on :3848
#   keeps running). This is the scripted form of the manual prod redeploy:
#
#     1. Rebuild core/dist from the target git ref     (./core.sh build)
#     2. rsync core/dist -> <prod>/core/dist  WITH --delete
#        (so prod mirrors the build EXACTLY; --delete removes stale artifacts
#         left over from versions before a module was deleted from main —
#         e.g. milestone/, architecture-llm, terminal-manager, source-scanner,
#         hook-event-store. A plain rsync without --delete orphans them.)
#     3. Core-only restart: kill the prod core pid (~/.cache/lm-assist/core-prod.pid)
#        then `lm-assist start` (web stays up, so only core comes back).
#     4. Verify /health (healthy + version + runningFrom=npm + fresh uptime +
#        new pid) and /hub/status (connected + authenticated).
#     5. (optional) Remind to refresh the claude.ai connector tool cache when
#        MCP tool schemas changed.
#
# SAFETY (enforced BEFORE anything touches prod)
#   * git working tree must be CLEAN and on the intended ref (--ref).
#   * BUILD FIRST; abort if the build fails.
#   * DRY-RUN the rsync (rsync -ni --delete) and SHOW what would change/delete;
#     refuse to proceed on UNEXPECTED deletions unless --force.
#   * VERSION CHECK: refuse a downgrade (built vs deployed package.json) unless --force.
#   * After deploy, grep the deployed dist for dangling requires to removed
#     modules (sanity).
#   * Prod install path is resolved DYNAMICALLY (never hardcodes the node version);
#     `lm-assist` is invoked with the node PATH it actually lives under.
#
# USAGE
#   core/scripts/deploy-prod.sh [options]
#
#   Options:
#     --ref <git-ref>     Deploy from this git ref. If HEAD is not already there,
#                         the tree must be clean and it is checked out first.
#                         (default: current HEAD)
#     --force             Override the safety refusals: unexpected rsync
#                         deletions AND version downgrade. Use deliberately.
#     --allow-dirty       Skip the clean-working-tree check (implies you accept
#                         deploying uncommitted changes). Still builds from disk.
#     --skip-build        Do not run `./core.sh build`; deploy the existing
#                         core/dist as-is (must already be built).
#     --no-restart        Sync only; do NOT kill/restart prod core (no verify).
#     --refresh-tools     After a successful deploy, print the connector
#                         tool-cache refresh reminder (MCP schemas changed).
#     --yes, -y           Non-interactive: do not prompt for the final go-ahead.
#     --dry-run           Show everything (build optional, rsync dry-run, plan)
#                         but make NO changes to prod and do NOT restart.
#     -h, --help          This help.
#
#   Examples:
#     # Standard redeploy from current HEAD, interactive confirm:
#     core/scripts/deploy-prod.sh
#
#     # Deploy a specific tag, no prompt:
#     core/scripts/deploy-prod.sh --ref v0.1.73 --yes
#
#     # See exactly what would happen, change nothing:
#     core/scripts/deploy-prod.sh --dry-run
#
# EXIT CODES
#   0 success · 1 usage/precondition · 2 build failed · 3 unexpected deletions
#   4 version downgrade · 5 verify failed
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Prod Core API port (npm-global install). Dev is 3200; this script is PROD only.
readonly PROD_API_PORT=3100

# Known-stale top-level paths that legitimately disappear from core/dist when a
# module is removed from main. Deletions limited to these are EXPECTED; any
# other deletion is "unexpected" and aborts unless --force. Keep in sync with
# modules removed in main (see CLAUDE.md / commit history).
readonly EXPECTED_STALE=(
  "milestone"
  "architecture-llm"
  "terminal-manager"
  "source-scanner"
  "hook-event-store"
)

# Colors (no-op when not a tty)
if [ -t 1 ]; then
  C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[1;33m'
  C_BLU=$'\033[0;34m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_DIM=''; C_RST=''
fi

log()  { echo "${C_BLU}==>${C_RST} $*"; }
ok()   { echo "${C_GRN} ✓ ${C_RST} $*"; }
warn() { echo "${C_YEL} ! ${C_RST} $*" >&2; }
die()  { echo "${C_RED}ERROR:${C_RST} $*" >&2; exit "${2:-1}"; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

REF=""
FORCE=0
ALLOW_DIRTY=0
SKIP_BUILD=0
NO_RESTART=0
REFRESH_TOOLS=0
ASSUME_YES=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)          REF="${2:-}"; shift 2 ;;
    --ref=*)        REF="${1#*=}"; shift ;;
    --force)        FORCE=1; shift ;;
    --allow-dirty)  ALLOW_DIRTY=1; shift ;;
    --skip-build)   SKIP_BUILD=1; shift ;;
    --no-restart)   NO_RESTART=1; shift ;;
    --refresh-tools) REFRESH_TOOLS=1; shift ;;
    --yes|-y)       ASSUME_YES=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      sed -n '2,/^# ===/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "Unknown option: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------

# Repo root = two levels up from this script (core/scripts/ -> repo).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly SRC_DIST="$REPO_ROOT/core/dist"

# Resolve the prod (npm-global) install path DYNAMICALLY — never hardcode the
# node version. Prefer the lm-assist binary's real location (a symlink into the
# global node_modules); fall back to `npm root -g`.
resolve_prod_root() {
  local bin pkg_root
  if bin="$(command -v lm-assist 2>/dev/null)"; then
    # bin -> .../node_modules/lm-assist/bin/lm-assist.js ; pkg root is 2 dirs up.
    local real; real="$(readlink -f "$bin")"
    pkg_root="$(cd "$(dirname "$real")/.." && pwd)"
    if [ -d "$pkg_root/core" ]; then echo "$pkg_root"; return 0; fi
  fi
  # Fallback: ask npm (use the lm-assist node's PATH if we found its bin dir).
  local root
  if root="$(npm root -g 2>/dev/null)" && [ -d "$root/lm-assist/core" ]; then
    echo "$root/lm-assist"; return 0
  fi
  return 1
}

PROD_ROOT="$(resolve_prod_root)" || die "Could not resolve the prod lm-assist install (is it installed globally?)"
readonly PROD_ROOT
readonly PROD_DIST="$PROD_ROOT/core/dist"

# The node PATH that `lm-assist` lives under (so we invoke the right node).
LMA_BIN="$(command -v lm-assist || true)"
[ -n "$LMA_BIN" ] || die "lm-assist CLI not found on PATH (prod not installed?)"
readonly LMA_BIN
# Run lm-assist with its own bin dir first on PATH, so it uses the node version
# it was installed under (the dir holding the lm-assist symlink also holds node):
lma() { PATH="$(dirname "$LMA_BIN"):$PATH" lm-assist "$@"; }

readonly CORE_PID_FILE="${HOME}/.cache/lm-assist/core-prod.pid"
readonly API_TOKEN_FILE="${HOME}/.lm-assist/api-token"

log "Repo:        $REPO_ROOT"
log "Built dist:  $SRC_DIST"
log "Prod root:   $PROD_ROOT"
log "Prod dist:   $PROD_DIST"
[ "$DRY_RUN" -eq 1 ] && warn "DRY-RUN: no changes will be made to prod."
echo

# ---------------------------------------------------------------------------
# Pre-flight: tooling
# ---------------------------------------------------------------------------
command -v rsync >/dev/null || die "rsync is required"
command -v git   >/dev/null || die "git is required"
[ -d "$PROD_DIST" ] || die "Prod dist not found at $PROD_DIST"

# ---------------------------------------------------------------------------
# 1) Git: clean tree + intended ref
# ---------------------------------------------------------------------------
cd "$REPO_ROOT"

if [ "$ALLOW_DIRTY" -eq 0 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    git status --short >&2
    die "Working tree is not clean. Commit/stash, or pass --allow-dirty."
  fi
  ok "Working tree clean."
else
  warn "--allow-dirty: skipping clean-tree check."
fi

if [ -n "$REF" ]; then
  git rev-parse --verify "$REF^{commit}" >/dev/null 2>&1 || die "Unknown git ref: $REF"
  CUR="$(git rev-parse HEAD)"
  WANT="$(git rev-parse "$REF^{commit}")"
  if [ "$CUR" != "$WANT" ]; then
    [ "$ALLOW_DIRTY" -eq 0 ] || die "Refusing to checkout '$REF' with a dirty tree (drop --allow-dirty or checkout manually)."
    log "Checking out $REF ..."
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "DRY-RUN: would 'git checkout $REF'"
    else
      git checkout --quiet "$REF"
    fi
  fi
  ok "On intended ref: $REF ($(git rev-parse --short "$WANT"))"
else
  ok "On HEAD: $(git rev-parse --short HEAD) ($(git describe --tags --always 2>/dev/null || true))"
fi
echo

# ---------------------------------------------------------------------------
# 2) Build (first, abort on failure)
# ---------------------------------------------------------------------------
if [ "$SKIP_BUILD" -eq 1 ]; then
  warn "--skip-build: using existing $SRC_DIST as-is."
  [ -f "$SRC_DIST/cli.js" ] || die "core/dist not built (no cli.js) and --skip-build was given."
else
  log "Building core (./core.sh build) ..."
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "DRY-RUN: would run ./core.sh build"
  else
    if ! "$REPO_ROOT/core.sh" build; then
      die "Build failed — aborting before touching prod." 2
    fi
  fi
  [ -f "$SRC_DIST/cli.js" ] || [ "$DRY_RUN" -eq 1 ] || die "Build reported success but $SRC_DIST/cli.js is missing." 2
  ok "Build complete."
fi
echo

# ---------------------------------------------------------------------------
# 3) Version check — refuse a downgrade unless --force
# ---------------------------------------------------------------------------
read_version() { node -e "process.stdout.write(require('$1').version||'')" 2>/dev/null || true; }
# semver compare: prints -1 / 0 / 1 for ($1 vs $2)
semver_cmp() {
  node -e '
    const a=(process.argv[1]||"0").split(".").map(Number);
    const b=(process.argv[2]||"0").split(".").map(Number);
    for(let i=0;i<3;i++){const x=a[i]||0,y=b[i]||0; if(x>y){console.log(1);process.exit(0)} if(x<y){console.log(-1);process.exit(0)}}
    console.log(0);
  ' "$1" "$2"
}

BUILT_VER="$(read_version "$REPO_ROOT/package.json")"
PROD_VER="$(read_version "$PROD_ROOT/package.json")"
log "Version: built=${BUILT_VER:-?}  prod=${PROD_VER:-?}"
if [ -n "$BUILT_VER" ] && [ -n "$PROD_VER" ]; then
  CMP="$(semver_cmp "$BUILT_VER" "$PROD_VER")"
  if [ "$CMP" = "-1" ]; then
    if [ "$FORCE" -eq 1 ]; then
      warn "DOWNGRADE $PROD_VER -> $BUILT_VER allowed by --force."
    else
      die "Refusing DOWNGRADE: prod $PROD_VER > built $BUILT_VER. Use --force to override." 4
    fi
  elif [ "$CMP" = "0" ]; then
    warn "Built version == prod version ($BUILT_VER) — redeploying same version."
  else
    ok "Upgrade $PROD_VER -> $BUILT_VER."
  fi
fi
echo

# ---------------------------------------------------------------------------
# 4) rsync DRY-RUN with --delete — show changes, gate on unexpected deletions
# ---------------------------------------------------------------------------
# Itemized, dry-run, with deletions. -a archive, -i itemize, -n dry-run.
log "rsync dry-run (rsync -ani --delete) ..."
RSYNC_OPTS=(-a --delete --human-readable)
DRY_OUT="$(rsync -ani --delete "$SRC_DIST/" "$PROD_DIST/")"

CHANGED="$(printf '%s\n' "$DRY_OUT" | grep -v '^\*deleting' || true)"
DELETIONS="$(printf '%s\n' "$DRY_OUT" | sed -n 's/^\*deleting   //p' || true)"

if [ -n "$CHANGED" ]; then
  echo "${C_DIM}--- files added/updated ---${C_RST}"
  printf '%s\n' "$CHANGED" | sed 's/^/   /'
else
  echo "${C_DIM}(no file additions/updates)${C_RST}"
fi

UNEXPECTED=()
if [ -n "$DELETIONS" ]; then
  echo "${C_YEL}--- files that would be DELETED (--delete) ---${C_RST}"
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    top="${d%%/*}"            # top-level path component
    base="${top%/}"
    is_expected=0
    for e in "${EXPECTED_STALE[@]}"; do
      if [ "$base" = "$e" ] || [ "$base" = "${e}.js" ] || [ "$base" = "${e}.d.ts" ]; then is_expected=1; break; fi
    done
    if [ "$is_expected" -eq 1 ]; then
      echo "   ${C_DIM}[expected stale]${C_RST} $d"
    else
      echo "   ${C_RED}[UNEXPECTED]${C_RST}    $d"
      UNEXPECTED+=("$d")
    fi
  done <<< "$DELETIONS"
else
  echo "${C_DIM}(no deletions)${C_RST}"
fi
echo

if [ "${#UNEXPECTED[@]}" -gt 0 ]; then
  if [ "$FORCE" -eq 1 ]; then
    warn "${#UNEXPECTED[@]} UNEXPECTED deletion(s) allowed by --force."
  else
    die "${#UNEXPECTED[@]} UNEXPECTED deletion(s) — refusing. Review above; re-run with --force if intended." 3
  fi
fi

# ---------------------------------------------------------------------------
# Final go-ahead gate
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  warn "DRY-RUN complete — no changes made. (rsync/build/restart all skipped where they'd mutate.)"
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  printf '%s' "${C_YEL}Proceed with deploy to PROD ($PROD_DIST) and core restart? [y/N] ${C_RST}"
  read -r ans
  case "$ans" in y|Y|yes|YES) ;; *) die "Aborted by user." ;; esac
fi
echo

# ---------------------------------------------------------------------------
# 5) Real rsync with --delete
# ---------------------------------------------------------------------------
log "rsync (real, --delete) $SRC_DIST/ -> $PROD_DIST/ ..."
rsync "${RSYNC_OPTS[@]}" "$SRC_DIST/" "$PROD_DIST/"
ok "Mirror complete."

# ---------------------------------------------------------------------------
# 6) Post-deploy sanity: no dangling requires to removed modules
# ---------------------------------------------------------------------------
log "Sanity: scanning deployed dist for dangling requires to removed modules ..."
DANGLING=""
for e in "${EXPECTED_STALE[@]}"; do
  hits="$(grep -rl --include='*.js' -E "require\(['\"][^'\"]*${e}['\"]\)" "$PROD_DIST" 2>/dev/null || true)"
  [ -n "$hits" ] && DANGLING+="$e:"$'\n'"$hits"$'\n'
done
if [ -n "$DANGLING" ]; then
  warn "Dangling requires to removed modules found in deployed dist:"
  printf '%s\n' "$DANGLING" | sed 's/^/   /'
  warn "Core may fail to boot. Investigate before relying on this deploy."
else
  ok "No dangling requires to removed modules."
fi
echo

# ---------------------------------------------------------------------------
# 7) Core-only restart (web on :3848 stays up)
# ---------------------------------------------------------------------------
if [ "$NO_RESTART" -eq 1 ]; then
  warn "--no-restart: skipping core restart + verify. Prod still runs the OLD core."
  exit 0
fi

OLD_PID=""
if [ -f "$CORE_PID_FILE" ]; then OLD_PID="$(cat "$CORE_PID_FILE" 2>/dev/null || true)"; fi
log "Restarting prod core (old pid: ${OLD_PID:-none}; web stays up) ..."
if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  kill "$OLD_PID" 2>/dev/null || true
  for _ in 1 2 3 4 5; do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 1; done
  kill -0 "$OLD_PID" 2>/dev/null && { kill -9 "$OLD_PID" 2>/dev/null || true; }
fi
# `lm-assist start` brings core back from the on-disk build; web is already up.
lma start >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 8) Verify
# ---------------------------------------------------------------------------
log "Verifying http://localhost:${PROD_API_PORT}/health ..."
HEALTH=""
for _ in $(seq 1 20); do
  HEALTH="$(curl -fsS "http://localhost:${PROD_API_PORT}/health" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 1
done
[ -n "$HEALTH" ] || die "Core did not come healthy on :${PROD_API_PORT}." 5

H_STATUS="$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).data.status||"")}catch{console.log("")}})' <<<"$HEALTH")"
H_VER="$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).data.version||"")}catch{console.log("")}})' <<<"$HEALTH")"
H_FROM="$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).data.runningFrom||"")}catch{console.log("")}})' <<<"$HEALTH")"
H_UP="$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).data.uptime||"")}catch{console.log("")}})' <<<"$HEALTH")"
NEW_PID="$(cat "$CORE_PID_FILE" 2>/dev/null || true)"

[ "$H_STATUS" = "healthy" ] || die "Health status='$H_STATUS' (expected healthy)." 5
[ "$H_FROM" = "npm" ]       || die "runningFrom='$H_FROM' (expected npm — wrong install?)." 5
ok "Health: status=$H_STATUS version=$H_VER runningFrom=$H_FROM uptime=${H_UP}ms pid=${NEW_PID:-?}"
if [ -n "$BUILT_VER" ] && [ -n "$H_VER" ] && [ "$H_VER" != "$BUILT_VER" ]; then
  warn "Deployed version ($H_VER) != built ($BUILT_VER) — stale process?"
fi
if [ -n "$OLD_PID" ] && [ "$NEW_PID" = "$OLD_PID" ]; then
  warn "PID unchanged ($NEW_PID) — core may not have actually restarted."
fi

# Hub status (needs api token)
if [ -f "$API_TOKEN_FILE" ]; then
  HUB="$(curl -fsS -H "x-api-key: $(cat "$API_TOKEN_FILE")" "http://localhost:${PROD_API_PORT}/hub/status" 2>/dev/null || true)"
  HUB_CONN="$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const x=JSON.parse(d).data;console.log((x.connected?"1":"0")+(x.authenticated?"1":"0"))}catch{console.log("")}})' <<<"$HUB")"
  case "$HUB_CONN" in
    11) ok "Hub: connected + authenticated." ;;
    "") warn "Hub: status unreadable." ;;
    *)  warn "Hub: connected=$([ "${HUB_CONN:0:1}" = 1 ] && echo yes || echo no) authenticated=$([ "${HUB_CONN:1:1}" = 1 ] && echo yes || echo no)." ;;
  esac
else
  warn "Hub: no api-token at $API_TOKEN_FILE — skipping hub check."
fi
echo

# ---------------------------------------------------------------------------
# 9) Optional: connector tool-cache refresh reminder
# ---------------------------------------------------------------------------
if [ "$REFRESH_TOOLS" -eq 1 ]; then
  warn "MCP tool schemas may have changed. Refresh the claude.ai connector tool cache:"
  echo "   • via lm-assist MCP:  refresh_connector_tools(connector=\"langmart\")"
  echo "   • or the claude.ai connector settings 'refresh tools' button."
  echo "   New/changed tools surface only in a FRESH session after the refresh."
fi

ok "Prod redeploy complete: ${PROD_VER:-?} -> ${H_VER:-$BUILT_VER}."

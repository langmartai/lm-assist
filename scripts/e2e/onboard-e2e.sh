#!/usr/bin/env bash
# E2E: workflow registry + session onboarding rails against an ISOLATED core.
# No cloud, no LLM, no prod impact. Requires: node, curl, jq; run from repo root
# (needs a prior `./core.sh build` so core/dist/cli.js exists).
#
# NOTE: seeds dataServiceEnabled:true (production default is FALSE) — this e2e
# proves the rails UNDER the data-service feature flag, not the box-default config.
#
# Isolation: LM_ASSIST_DATA_DIR (core/src/utils/path-utils.ts getDataDir()) points
# every data-owned path — project-settings.json, api-token, hub*.json, the LMDB
# data-service backends — at a fresh mktemp dir. A brand-new dir means no hub.json
# => hub calls fail fast (bad-URL fetch reject, not a network hang) => the leader
# election / anchoring code degrades to "run locally", which is what we want.
#
# Two things LM_ASSIST_DATA_DIR does NOT cover (both hardcoded to os.homedir()):
#   1. dataServiceEnabled defaults OFF (core/src/project-settings.ts DEFAULTS) —
#      with it off, mission-store.ts / workflow-store.ts silently no-op every
#      put()/list() ("dataServiceEnabled off => isEnabled() false => no-op/empty").
#      So we seed the isolated dir's project-settings.json with it ON *before*
#      first boot (settings are mtime-cached, so this must happen pre-start).
#   2. sessionVerdict's transcript lookup (core/src/terminal/cc-sessions.ts
#      findJsonl()) reads ~/.claude/projects/**/<sid>.jsonl unconditionally — NOT
#      gated by LM_ASSIST_DATA_DIR or CLAUDE_CONFIG_DIR. For the onboard existence
#      check (mission.routes.ts handleOnboard step 4: connectStrategy!=='none')
#      to pass on our synthetic sid, we drop a minimal real transcript file at that
#      real (host) location — same fixture-on-the-real-host spirit as
#      scripts/e2e/live-rc-e2e.sh's pid-file fixture — and remove it in the trap.
set -euo pipefail
PORT="${PORT:-3211}"
DATA_DIR="$(mktemp -d)"
export LM_ASSIST_DATA_DIR="$DATA_DIR"      # isolated ~/.lm-assist substitute (see core/src/utils/path-utils)
API="http://127.0.0.1:${PORT}"
TOKEN_ARGS=()

# --- synthetic native-session transcript fixture (see point 2 above) ---
# Suffixed with $$ (this script's PID) so concurrent runs (e.g. two CI jobs, or a
# dev + a CI run) never collide on the same SID/dir. Last UUID segment is $$
# zero-padded to 12 digits — keeps a valid UUID shape (sessionVerdict/findJsonl
# just need the string to look like one) while being unique per-run.
SID="e2e00000-0000-4000-8000-$(printf '%012d' "$$")"
FIXTURE_PROJ_DIR="$HOME/.claude/projects/-tmp-onboard-e2e-fixture-$$"
FIXTURE_JSONL="$FIXTURE_PROJ_DIR/$SID.jsonl"

cleanup() {
  kill "$CORE_PID" 2>/dev/null || true
  wait "$CORE_PID" 2>/dev/null || true
  rm -rf "$DATA_DIR"
  rm -f "$FIXTURE_JSONL"
  rmdir "$FIXTURE_PROJ_DIR" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$FIXTURE_PROJ_DIR"
printf '%s\n' '{"type":"user","message":{"role":"user","content":"e2e onboarding fixture — not a real session"},"sessionId":"'"$SID"'","timestamp":"1970-01-01T00:00:00.000Z"}' > "$FIXTURE_JSONL"

# --- seed project-settings.json with dataServiceEnabled=true BEFORE first boot ---
# (mission-store.ts / workflow-store.ts no-op all reads/writes while it's off, the
# DEFAULT; settings are read once and mtime-cached, so this can't be done after boot)
mkdir -p "$DATA_DIR"
cat > "$DATA_DIR/project-settings.json" <<'EOF'
{ "dataServiceEnabled": true }
EOF

node core/dist/cli.js serve --port "$PORT" --host 127.0.0.1 & CORE_PID=$!
for i in $(seq 1 30); do curl -sf "$API/health" >/dev/null && break; sleep 1; done
curl -sf "$API/health" >/dev/null || { echo "FAIL core did not start on :$PORT"; exit 1; }
# Resolve worker token if the isolated core minted one (path-utils getDataDir()/api-token)
[ -f "$DATA_DIR/api-token" ] && TOKEN_ARGS=(-H "x-api-key: $(cat "$DATA_DIR/api-token")")
req() { curl -s "${TOKEN_ARGS[@]}" -H 'content-type: application/json' "$@"; }
pass=0; fail=0
check() { local name="$1" cond="$2"; if [ "$cond" = "true" ]; then pass=$((pass+1)); echo "PASS $name"; else fail=$((fail+1)); echo "FAIL $name"; fi }

# 1. workflow list shows the 9 defaults (stored or default) — this isolated core
#    never ran the leader-seeding supervisor (no hub => no election), so they
#    surface via `defaults`, not `workflows`. workflows+defaults >= 9 covers both.
WL=$(req "$API/mission/workflows")
check "workflows listed" "$(echo "$WL" | jq '[(.data.workflows|length) + (.data.defaults|length)] | .[0] >= 9')"

# 2. set + get + rendered preamble
req -X POST "$API/mission/workflows/e2e.doc" -d '{"title":"E2E","body":"E2E-BODY","editPolicy":"open"}' >/dev/null
WG=$(req "$API/mission/workflows/e2e.doc")
check "workflow get rendered+preamble" "$(echo "$WG" | jq '.data.rendered | (contains("INVARIANTS") and contains("E2E-BODY"))')"

# 3. edit → history → rollback
req -X POST "$API/mission/workflows/e2e.doc" -d '{"body":"E2E-BODY-2"}' >/dev/null
RB=$(req -X POST "$API/mission/workflows/e2e.doc/rollback" -d '{"toRev":1}')
check "rollback to rev1 body" "$(echo "$RB" | jq '.data.doc.body == "E2E-BODY" and .data.doc.rev == 3')"

# 4. onboard a synthetic native session (transcript-only fixture, see above)
OB=$(req -X POST "$API/mission/onboard" -d "{\"sessionId\":\"$SID\",\"mode\":\"standby\"}")
MID=$(echo "$OB" | jq -r '.data.mission.id // empty')
check "onboard creates mission" "$( [ -n "$MID" ] && echo true || echo false )"
check "standby + analyzing tag" "$(echo "$OB" | jq '.data.mission.manageMode == "standby" and (.data.mission.tags["onboard:state"][0] == "analyzing")')"

# 5. idempotent
OB2=$(req -X POST "$API/mission/onboard" -d "{\"sessionId\":\"$SID\"}")
check "idempotent onboard" "$(echo "$OB2" | jq --arg mid "$MID" '.data.existing == true and .data.mission.id == $mid')"

# 6. standby drive rejected
DR=$(req -X POST "$API/mission/session/$SID/drive" -d '{"text":"hi"}')
check "standby drive rejected" "$(echo "$DR" | jq '.success == false and .error.code == "STANDBY_MODE"')"

# 7. schedule exclusion is origin-based, not manageMode-based (mission-scheduler.ts:75
#    excludes by `origin === 'onboarded'` alone — the manageMode flip below is NOT what
#    this assertion is testing; it's set up here only to feed check 8). Fail-closed jq:
#    require .data.ready to actually be an array (not null/absent) before trusting index().
req -X POST "$API/mission/$MID" -d '{"manageMode":"handoff"}' >/dev/null
SC=$(req -X POST "$API/mission/schedule" -d '{}')
check "onboarded never spawn-ready (origin-based)" "$(echo "$SC" | jq --arg mid "$MID" '(.data.ready | type == "array") and ((.data.ready | index($mid)) == null)')"

# 8. manageMode-load-bearing: the human PATCH above flipped this mission to handoff,
#    so the drive rail (mission.routes.ts handleSessionDrive) must NOT reject with
#    STANDBY_MODE anymore (paired with check 6's standby-mode rejection — proves the
#    rail flips OFF, not just that it's on while standby). The synthetic session has
#    no live process, so a non-STANDBY_MODE failure (e.g. DRIVE_ERROR) is expected and
#    still a pass — only STANDBY_MODE would mean the rail didn't lift.
DR2=$(req -X POST "$API/mission/session/$SID/drive" -d '{"text":"hi"}')
check "handoff lifts STANDBY_MODE rail" "$(echo "$DR2" | jq '.success == true or .error.code != "STANDBY_MODE"')"

echo "== $pass passed, $fail failed"; [ "$fail" -eq 0 ]

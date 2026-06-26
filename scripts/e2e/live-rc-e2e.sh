#!/usr/bin/env bash
# E2E for the live-rc-connect feature (POSIX/Linux node).
#
# Builds a DETERMINISTIC "live + unreachable" session fixture — a real long-lived
# process plus a synthetic ~/.claude/sessions/<pid>.json (sessionId + alive pid,
# no tmux pane => sessionVerdict 'refuse' => unreachable). This isolates the
# orchestrator's safety gate WITHOUT launching claude (no onboarding, no auto-RC,
# no cloud/quota) for the safety tests.
#
#   TEST 1 (safety, cloud-free): live+unreachable+busy, NO force => CONFLICT(needs-force)
#                                AND the owner process is NEVER killed.
#   TEST 2 (opt-in, cloud):      DO_FORCE=1 => force:true kills the owner (kill-gated path).
#
# Cross-platform sibling: live-rc-e2e.ps1 (Windows). Cross-node: run with
#   API=http://<node-ip>:3100 TOKEN=<that node's api-token>  (or via the hub relay).
set -uo pipefail
API="${API:-http://localhost:3100}"
TOKEN="${TOKEN:-$(cat "$HOME/.lm-assist/api-token" 2>/dev/null | tr -d '[:space:]')}"
DO_FORCE="${DO_FORCE:-0}"
SESS_DIR="$HOME/.claude/sessions"
LABEL="${LABEL:-$(hostname)}"
PASS=0; FAIL=0
ok(){  PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

[ -n "$TOKEN" ] || { echo "no API token"; exit 2; }
mkdir -p "$SESS_DIR"
UUID=$(cat /proc/sys/kernel/random/uuid)
# Spawn the "live owner" reparented OUT of any tmux ancestry: setsid makes a new
# session leader whose parent (setsid) exits, so it reparents to init/systemd —
# NOT the tmux pane this script runs in. Else findPaneForPid would walk the ppid
# chain back to the pane and mis-classify the fixture as attach-existing.
PIDOUT=$(mktemp)
# --fork forces setsid to fork (then the setsid parent exits) so the owner
# reparents to init/systemd, breaking the ppid chain back to this tmux pane.
setsid --fork sh -c 'echo $$ > "'"$PIDOUT"'"; exec sleep 99999' </dev/null >/dev/null 2>&1 &
for _ in $(seq 1 30); do [ -s "$PIDOUT" ] && break; sleep 0.1; done
OWNER=$(cat "$PIDOUT"); rm -f "$PIDOUT"
[ -n "$OWNER" ] && kill -0 "$OWNER" 2>/dev/null || { echo "owner spawn failed"; exit 2; }
PIDFILE="$SESS_DIR/$OWNER.json"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"sessionId":"%s","pid":%s,"cwd":"/tmp","kind":"e2e","entrypoint":"e2e","status":"running","updatedAt":"%s","version":"e2e"}\n' \
  "$UUID" "$OWNER" "$NOW" > "$PIDFILE"

cleanup(){ kill "$OWNER" 2>/dev/null; rm -f "$PIDFILE"; tmux kill-session -t "ccr-${UUID:0:8}" 2>/dev/null; }
trap cleanup EXIT

post(){ curl -s --max-time 20 -X POST "$API/ccr/connect" -H "x-api-key: $TOKEN" -H 'content-type: application/json' -d "{\"sessionId\":\"$UUID\",\"force\":$1}"; }

echo "=== live-rc E2E on [$LABEL] via $API  (owner pid $OWNER, sid ${UUID:0:8}) ==="
PRE=$(curl -s --max-time 8 "$API/ccr/preflight/$UUID" -H "x-api-key: $TOKEN")
echo "$PRE" | grep -qE '"live": *true' && ok "fixture reports live" || bad "fixture not live: $PRE"
echo "$PRE" | grep -qE '"connectStrategy": *"refuse"' && ok "verdict=refuse (live, unreachable)" || bad "verdict not refuse: $(echo "$PRE" | grep -o '"connectStrategy":"[^"]*"')"

echo "-- TEST 1 (safety): no force => CONFLICT(needs-force), owner NEVER killed --"
R1=$(post false)
echo "$R1" | grep -qE '"code": *"CONFLICT"' && ok "CONFLICT returned" || bad "expected CONFLICT: $R1"
echo "$R1" | grep -qi 'force' && ok "needs-force hint present" || bad "no force hint: $R1"
sleep 0.5
if kill -0 "$OWNER" 2>/dev/null; then ok "owner STILL ALIVE — never resumed over a live process"; else bad "owner KILLED without force — SAFETY VIOLATION"; fi

if [ "$DO_FORCE" = "1" ]; then
  echo "-- TEST 2 (cloud): force:true => owner KILLED (kill-gated path) --"
  R2=$(post true)
  sleep 2
  if kill -0 "$OWNER" 2>/dev/null; then bad "owner still alive after force — kill did not happen: $R2"; else ok "owner KILLED under force:true"; fi
  echo "     (force result: $(echo "$R2" | grep -o '"code":"[^"]*"\|"webUrl":"[^"]*"' | head -1))"
fi

echo "=== [$LABEL] RESULT: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]

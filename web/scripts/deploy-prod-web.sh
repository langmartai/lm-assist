#!/usr/bin/env bash
# Build this checkout's web UI and deploy it to the local PROD npm install
# (:3848 http / :3849 https). Run from the repo root or from web/.
#
# Why this script exists — the worktree standalone trap:
#   next.config.ts sets outputFileTracingRoot to the nearest ancestor holding a
#   REAL node_modules. In a git worktree under .claude/worktrees/<name>/ that is
#   the MAIN checkout, so `next build` emits
#       .next/standalone/.claude/worktrees/<name>/web/server.js
#   instead of the .next/standalone/web/server.js that service-manager.ts looks
#   for. Missing that file, prod silently falls back to `npx next start`, which
#   DOWNLOADS a different next from the registry and then crashes the web UI.
#   So: always relocate the nested standalone dir before shipping.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."      # -> web/
WEB_DIR="$PWD"
PROD_WEB="$(npm root -g)/lm-assist/web"
[ -d "$PROD_WEB" ] || { echo "prod install not found at $PROD_WEB" >&2; exit 1; }

echo "==> build (NEXT_PUBLIC_LOCAL_API_PORT=3100)"
NEXT_PUBLIC_LOCAL_API_PORT=3100 LM_LOCAL_API_PORT=3100 npx next build

echo "==> normalise standalone layout"
SA="$WEB_DIR/.next/standalone"
if [ ! -f "$SA/web/server.js" ]; then
  NESTED="$(find "$SA" -mindepth 2 -maxdepth 6 -name server.js -path '*/web/server.js' | head -1)"
  [ -n "$NESTED" ] || { echo "no standalone server.js produced" >&2; exit 1; }
  NESTED_WEB="$(dirname "$NESTED")"
  echo "    relocating ${NESTED_WEB#$SA/} -> web"
  mv "$NESTED_WEB" "$SA/web.tmp"
  # drop the now-empty nesting (.claude/worktrees/<name>)
  find "$SA" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name web.tmp -exec rm -rf {} +
  mv "$SA/web.tmp" "$SA/web"
fi
[ -f "$SA/web/server.js" ] || { echo "standalone/web/server.js still missing" >&2; exit 1; }

# service-manager copies these on start too, but do it here so the artifact is
# self-contained and testable before it ships.
rm -rf "$SA/web/.next/static" "$SA/web/public"
cp -a "$WEB_DIR/.next/static" "$SA/web/.next/static"
cp -a "$WEB_DIR/public" "$SA/web/public"

echo "==> back up prod .next"
BACKUP="$HOME/.lm-assist/web-next-backup-$(date +%s)"
cp -a "$PROD_WEB/.next" "$BACKUP"
echo "    $BACKUP  (restore: rm -rf $PROD_WEB/.next && cp -a $BACKUP $PROD_WEB/.next && lm-assist restart)"

echo "==> ship"
rsync -a --delete "$WEB_DIR/.next/" "$PROD_WEB/.next/"

echo "==> restart prod"
lm-assist restart 2>&1 | grep -E "API:|Web:" || true
sleep 8

echo "==> verify"
fail=0
for u in "http://localhost:3848/sessions" "https://localhost:3849/sessions"; do
  code=$(curl -sk --max-time 15 -o /dev/null -w '%{http_code}' "$u")
  echo "    $u -> $code"; [ "$code" = "200" ] || fail=1
done
# A 200 on the page is NOT proof the build shipped correctly — check a real chunk.
CHUNK=$(curl -sk --max-time 15 https://localhost:3849/sessions \
        | grep -o '/_next/static/chunks/[a-zA-Z0-9._-]*\.js' | head -1)
code=$(curl -sk --max-time 15 -o /dev/null -w '%{http_code}' "https://localhost:3849$CHUNK")
echo "    chunk $CHUNK -> $code"; [ "$code" = "200" ] || fail=1
# The bundled next must serve it, not an npx-downloaded one.
echo "    next: $(grep -E 'Next\.js' "$HOME/.cache/lm-assist/web-prod.log" | tail -1)"
if grep -q "will be installed: next@" "$HOME/.cache/lm-assist/web-prod.log"; then
  echo "    WARNING: npx fell back and downloaded next — standalone was not used" >&2
fi

[ "$fail" = 0 ] && echo "==> OK  BUILD_ID=$(cat "$PROD_WEB/.next/BUILD_ID")" || { echo "==> FAILED" >&2; exit 1; }

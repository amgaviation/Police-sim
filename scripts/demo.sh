#!/usr/bin/env bash
# Builds and serves the latest completed phase (the newest "Phase N: ..." commit)
# from a separate worktree, so work-in-progress commits never reach the demo.
# Usage: bash scripts/demo.sh [commit]
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin "$BRANCH" 2>/dev/null || true
SRC="origin/$BRANCH"
git rev-parse -q --verify "$SRC" >/dev/null || SRC=HEAD
REF="${1:-$(git log "$SRC" -E --grep='^Phase [0-9]+: ' -1 --format=%H)}"
DIR="${PATROL_DEMO_DIR:-/tmp/patrol-demo}"
echo "Patrol demo: $(git log -1 --format='%h %s' "$REF")"
git worktree remove --force "$DIR" 2>/dev/null || rm -rf "$DIR"
git worktree prune
git worktree add -q --detach "$DIR" "$REF"
cd "$DIR"
npm ci --no-audit --no-fund
npx vite build
exec npx vite preview --host 0.0.0.0 --port "${PORT:-4173}" --strictPort

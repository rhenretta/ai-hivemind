#!/bin/bash
# start.sh — AI Hivemind dev server
# Usage: ./start.sh
# Logs go to /tmp/turbo-dev.log

set -e

REPO="$(cd "$(dirname "$0")" && pwd)"
LOG="/tmp/turbo-dev.log"

echo "Stopping any existing processes..."
pkill -f "turbo run dev" 2>/dev/null || true
pkill -f "tsx.*index" 2>/dev/null || true
pkill -f "next.*dev" 2>/dev/null || true
sleep 2

# Clear stale Next.js cache — prevents MODULE_NOT_FOUND errors on restart
# (webpack chunks reference old module IDs that no longer exist after code changes)
if [ -d "$REPO/apps/web/.next" ]; then
    echo "Clearing stale .next cache..."
    rm -rf "$REPO/apps/web/.next"
fi

echo "Starting AI Hivemind dev server..."
echo "Logs → $LOG"
echo ""

cd "$REPO"
exec pnpm turbo run dev 2>&1 | tee "$LOG"

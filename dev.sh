#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3000}"
URL="http://localhost:$PORT"

cyan()  { printf "\033[36m── %s\033[0m\n" "$*"; }
green() { printf "\033[32m✓ %s\033[0m\n" "$*"; }

# ── Args ──────────────────────────────────────────────────────────────────────
# Browser dev only. The native app is Tauri now — run it with `npm run dev:tauri`.
OPEN=true
for arg in "$@"; do
  case $arg in
    --no-open) OPEN=false ;;
    --help|-h)
      echo "Usage: ./dev.sh [--no-open]"
      echo ""
      echo "  Runs the TaskHub web server in watch mode (live reload on) and opens the"
      echo "  dashboard in your browser. For the native app (GitHub/Jira split view), use"
      echo "  \`npm run dev:tauri\`."
      echo ""
      echo "  --no-open            don't open the browser"
      echo "  PORT=4000 ./dev.sh   override port (default 3000)"
      exit 0
      ;;
  esac
done

cd "$ROOT"

# ── Data dir ──────────────────────────────────────────────────────────────────────
# Dev uses the SAME store as the packaged app — Electron's userData dir — so you work
# against your real projects/config, not a separate repo-local copy. db.js honors
# TASKHUB_DATA_DIR first; export your own (e.g. TASKHUB_DATA_DIR=/tmp/taskhub-test) for
# an isolated store when you don't want to touch prod data.
PROD_DATA="$HOME/Library/Application Support/TaskHub"
if [ -n "$TASKHUB_DATA_DIR" ]; then
  green "Using data dir (override): $TASKHUB_DATA_DIR"
else
  export TASKHUB_DATA_DIR="$PROD_DATA"
  mkdir -p "$PROD_DATA"
  green "Using prod data: $PROD_DATA"
fi

# ── Runtime ─────────────────────────────────────────────────────────────────────
# Must be Node: the server uses node:sqlite (taskhub.db), which bun doesn't implement.
# Node's built-in --watch gives the same hot-reload bun used to provide here.
RUNTIME=(node --watch src/server/app.js)
green "Using node $(node --version)"

# ── Free the port ────────────────────────────────────────────────────────────────
# A stale dev server or the packaged TaskHub.app may already hold it (the server
# exits on EADDRINUSE otherwise).
cyan "Freeing port $PORT"
lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true

# ── Open the browser once the server answers (background) ─────────────────────────
if $OPEN; then
  (
    for _ in $(seq 1 40); do
      if curl -s -o /dev/null "$URL"; then open "$URL"; break; fi
      sleep 0.25
    done
  ) &
fi

# ── Run (foreground; Ctrl+C stops it, --watch restarts on file changes) ───────────
cyan "Starting TaskHub at $URL  (edit src/renderer/ → page auto-reloads)"
PORT="$PORT" exec "${RUNTIME[@]}"

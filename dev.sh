#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3000}"
URL="http://localhost:$PORT"

cyan()  { printf "\033[36m── %s\033[0m\n" "$*"; }
green() { printf "\033[32m✓ %s\033[0m\n" "$*"; }

# ── Args ──────────────────────────────────────────────────────────────────────
OPEN=true
APP=false
for arg in "$@"; do
  case $arg in
    --no-open) OPEN=false ;;
    --app)     APP=true ;;
    --help|-h)
      echo "Usage: ./dev.sh [--no-open] [--app]"
      echo ""
      echo "  Runs the TaskHub web server in watch mode (live reload on)."
      echo ""
      echo "  (default)            serve + open the dashboard in your browser"
      echo "  --app                serve + launch the Electron app (needed for the"
      echo "                       GitHub/Jira split view; renderer hot-reloads)"
      echo "  --no-open            don't open the browser"
      echo "  PORT=4000 ./dev.sh   override port (default 3000)"
      exit 0
      ;;
  esac
done

cd "$ROOT"

# ── Data dir ──────────────────────────────────────────────────────────────────────
# The packaged tray app stores its data in Electron's userData dir; plain Node/bun
# would otherwise default to the repo root and show an empty store. Point dev at the
# same "prod" data so you see your real projects/config. db.js honors TASKHUB_DATA_DIR
# first. Export your own TASKHUB_DATA_DIR to override, or set it to "." for an
# isolated repo-local store.
PROD_DATA="$HOME/Library/Application Support/TaskHub"
if [ -z "$TASKHUB_DATA_DIR" ] && [ -f "$PROD_DATA/taskhub.json" ]; then
  export TASKHUB_DATA_DIR="$PROD_DATA"
  green "Using prod data: $PROD_DATA"
elif [ -n "$TASKHUB_DATA_DIR" ]; then
  green "Using data dir: $TASKHUB_DATA_DIR"
else
  green "Using repo-local data: $ROOT (no prod store found)"
fi

# ── Runtime ─────────────────────────────────────────────────────────────────────
# Must be Node: the server uses node:sqlite (config.db), which bun doesn't implement.
# Node's built-in --watch gives the same hot-reload bun used to provide here.
RUNTIME=(node --watch server.js)
green "Using node $(node --version)"

# ── Free the port ────────────────────────────────────────────────────────────────
# A stale dev server or the packaged TaskHub.app may already hold it (the server
# exits on EADDRINUSE otherwise).
cyan "Freeing port $PORT"
lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true

# ── App mode: watched server in the background + Electron in the foreground ───────
# The split view needs Electron's <webview>, so launch the app instead of a browser.
# The renderer still hot-reloads (SSE); restart this command for tray.js changes.
if $APP; then
  cyan "Starting watched server at $URL"
  PORT="$PORT" "${RUNTIME[@]}" >/tmp/taskhub-dev-server.log 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 40); do curl -s -o /dev/null "$URL" && break; sleep 0.25; done
  cyan "Launching Electron app (connecting to the dev server)"
  TASKHUB_EXTERNAL_SERVER=1 PORT="$PORT" ./node_modules/.bin/electron . || true
  exit 0
fi

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
cyan "Starting TaskHub at $URL  (edit public/ → page auto-reloads)"
PORT="$PORT" exec "${RUNTIME[@]}"

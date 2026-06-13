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

# ── App mode: watched server in the background + Electron in the foreground ───────
# The split view needs Electron's <webview>, so launch the app instead of a browser.
# The renderer still hot-reloads (SSE); restart this command for tray.js changes.
if $APP; then
  cyan "Starting watched server at $URL"
  PORT="$PORT" "${RUNTIME[@]}" >/tmp/taskhub-dev-server.log 2>&1 &
  SERVER_PID=$!
  # `node --watch` is a supervisor that forks a worker holding the port — killing
  # SERVER_PID alone orphans the worker. Tear down the whole tree, then free the
  # port as a backstop (catches workers respawned by --watch after a file change).
  cleanup() {
    # Tear down the Electron we launched too. The app intercepts quit to stay in the tray
    # (tray.js), so Ctrl+C / window-close would otherwise orphan it — and those leftovers
    # pile up across dev runs until the machine bogs down. Kill the tracked PID, then sweep
    # this project's Electron tree as a backstop (catches orphaned helpers whose parent died).
    kill "$ELECTRON_PID" 2>/dev/null || true
    pkill -9 -f "$ROOT/node_modules/electron" 2>/dev/null || true
    pkill -P "$SERVER_PID" 2>/dev/null || true
    kill "$SERVER_PID" 2>/dev/null || true
    lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM
  for _ in $(seq 1 40); do curl -s -o /dev/null "$URL" && break; sleep 0.25; done

  # Brand the dev Electron.app as "TaskHub" so the menu bar AND Dock match the packaged
  # build. The name lives in the bundle's Info.plist (ships as "Electron"); app.setName()
  # can't change it in dev. Editing the plist breaks the bundle's code signature, so the
  # Dock keeps the old signed name until we ad-hoc re-sign, then refresh Launch Services.
  # Guarded on the current name so the (slow) codesign runs once after a fresh npm install,
  # not on every launch.
  EL_APP="$ROOT/node_modules/electron/dist/Electron.app"
  EL_PLIST="$EL_APP/Contents/Info.plist"
  if [ -f "$EL_PLIST" ] && [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$EL_PLIST" 2>/dev/null)" != "TaskHub" ]; then
    cyan "Branding dev Electron bundle as TaskHub (one-time after install)"
    /usr/libexec/PlistBuddy -c "Set :CFBundleName TaskHub"        "$EL_PLIST" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName TaskHub" "$EL_PLIST" 2>/dev/null || true
    codesign --force --deep --sign - "$EL_APP" 2>/dev/null || true
    LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
    [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$EL_APP" 2>/dev/null || true
  fi

  cyan "Launching Electron app (connecting to the dev server)"
  TASKHUB_EXTERNAL_SERVER=1 PORT="$PORT" ./node_modules/.bin/electron . &
  ELECTRON_PID=$!
  wait "$ELECTRON_PID" || true   # block here; the EXIT/INT trap (cleanup) kills server + Electron
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
cyan "Starting TaskHub at $URL  (edit src/renderer/ → page auto-reloads)"
PORT="$PORT" exec "${RUNTIME[@]}"

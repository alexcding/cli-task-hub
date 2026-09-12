#!/usr/bin/env bash
# The XCUITest runner cannot bind a server socket. Own the fixture here and pass
# only its origin/data directory to the test; no daily database is used.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
QA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/taskhub-browser-ui.XXXXXX")"
QA_TEST="${1:-TaskHubUITests}"
BACKEND_PID=""
cleanup() {
  if [[ -n "$BACKEND_PID" ]]; then kill "$BACKEND_PID" 2>/dev/null || true; wait "$BACKEND_PID" 2>/dev/null || true; fi
  # Keep failure diagnostics and fixture data available for inspection.
  echo "Browser fixture diagnostics: $QA_DIR"
}
trap cleanup EXIT
TASKHUB_DATA_DIR="$QA_DIR" TASKHUB_READY_FILE="$QA_DIR/ready" TASKHUB_SIDEBAR_FIXTURE=1 TASKHUB_BROWSER_FIXTURE=1 TASKHUB_TRAY_FIXTURE=1 PORT=0 \
  node "$ROOT/macos/scripts/backend-fixture.cjs" >"$QA_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
for _ in {1..100}; do
  [[ -f "$QA_DIR/ready" ]] && break
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then cat "$QA_DIR/backend.log"; exit 1; fi
  sleep 0.05
done
test -f "$QA_DIR/ready"
QA_SOCKET="${TMPDIR:-/tmp/}taskhub-bui-$$.sock"
ARGS="$(node -e 'const fs=require("fs"); const dir=process.argv[1]; console.log(JSON.stringify({testRunnerEnv:{TASKHUB_UI_BACKEND_URL:fs.readFileSync(dir+"/ready","utf8"),TASKHUB_UI_DATA_DIR:dir,TASKHUB_UI_PTY_SOCKET:process.argv[2]}}))' "$QA_DIR" "$QA_SOCKET")"
xcodebuildmcp macos test --workspace-path "$ROOT/macos/TaskHub.xcworkspace" --scheme TaskHub \
  --configuration Debug --derived-data-path "$ROOT/macos/.build/ui-tests" --json "$ARGS" \
  --extra-args "-only-testing:$QA_TEST"

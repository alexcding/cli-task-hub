#!/usr/bin/env bash
# The XCUITest runner cannot bind a server socket. Own the fixture here and pass
# only its origin/data directory to the test; no daily database is used.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
QA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/taskhub-browser-ui.XXXXXX")"
QA_TEST="${1:-TaskHubUITests}"
if [[ "$QA_TEST" == *testNativeRealBuild* ]]; then
  : "${TASKHUB_REAL_BUILD_SIMULATOR:?Choose an available simulator UDID}"
  : "${TASKHUB_BUILD_PROBE_TEMPLATE:?Scaffold TaskHubBuildProbe with XcodeBuildMCP first}"
elif [[ -n "${TASKHUB_REAL_BUILD_SIMULATOR:-}" ]]; then
  echo "Real build configuration requires the explicit real build UI test" >&2
  exit 1
fi
QA_BUILD_FIXTURE=0
if [[ "$QA_TEST" == "TaskHubUITests" || "$QA_TEST" == "TaskHubUITests/TaskHubUITests" || "$QA_TEST" == *testNativeBuildDestination* ]]; then QA_BUILD_FIXTURE=1; fi
QA_PROJECT_ACTION_FIXTURE=0
if [[ "$QA_TEST" == "TaskHubUITests" || "$QA_TEST" == "TaskHubUITests/TaskHubUITests" || "$QA_TEST" == *testNativeProjectPullRequest* || "$QA_TEST" == *testNativeProjectTicket* || "$QA_TEST" == *testNativeDashboardPendingOpen* ]]; then QA_PROJECT_ACTION_FIXTURE=1; fi
# XCTest runs a copied app outside the checkout. Supply its PTY helper explicitly
# instead of relying on source-tree discovery from that copied bundle.
. "$ROOT/macos/scripts/cargo-env.sh"
cargo_build build --locked --manifest-path "$ROOT/crates/taskhub-ptyd/Cargo.toml" --features terminal-snapshots
QA_HELPER="$ROOT/crates/taskhub-ptyd/target/debug/taskhub-ptyd"
test -x "$QA_HELPER"
BACKEND_PID=""
QA_SOCKET=""
cleanup() {
  local status=$?
  if [[ -f "$QA_DIR/build-probe.json" ]]; then
    python3 "$ROOT/macos/scripts/stop-build-probe.py" "$QA_DIR" "$TASKHUB_REAL_BUILD_SIMULATOR" || status=1
  fi
  if [[ -n "$QA_SOCKET" ]]; then
    python3 "$ROOT/macos/scripts/stop-fixture-pty.py" "$QA_SOCKET" "$QA_DIR" || status=1
  fi
  if [[ -n "$BACKEND_PID" ]]; then kill "$BACKEND_PID" 2>/dev/null || true; wait "$BACKEND_PID" 2>/dev/null || true; fi
  # Keep failure diagnostics and fixture data available for inspection.
  echo "Browser fixture diagnostics: $QA_DIR"
  exit "$status"
}
trap cleanup EXIT
TASKHUB_DATA_DIR="$QA_DIR" TASKHUB_READY_FILE="$QA_DIR/ready" TASKHUB_SIDEBAR_FIXTURE=1 TASKHUB_BROWSER_FIXTURE=1 TASKHUB_TRAY_FIXTURE=1 TASKHUB_LOGS_FIXTURE=1 TASKHUB_NOTIFICATION_FIXTURE=1 TASKHUB_BOARD_FIXTURE=1 TASKHUB_CLI_FIXTURE=1 TASKHUB_DIFF_FIXTURE=1 TASKHUB_EDITOR_FIXTURE=1 TASKHUB_HISTORY_FIXTURE=1 TASKHUB_BUILD_FIXTURE="$QA_BUILD_FIXTURE" TASKHUB_PROJECT_ACTION_FIXTURE="$QA_PROJECT_ACTION_FIXTURE" PORT=0 \
  node "$ROOT/macos/scripts/backend-fixture.cjs" >"$QA_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
for _ in {1..100}; do
  [[ -f "$QA_DIR/ready" ]] && break
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then cat "$QA_DIR/backend.log"; exit 1; fi
  sleep 0.05
done
test -f "$QA_DIR/ready"
if [[ -n "${TASKHUB_REAL_BUILD_SIMULATOR:-}" ]]; then
  python3 "$ROOT/macos/scripts/prepare-real-build-probe.py" "$QA_DIR" "$TASKHUB_BUILD_PROBE_TEMPLATE"
fi
QA_SOCKET="${TMPDIR:-/tmp/}taskhub-bui-$$.sock"
ARGS="$(node -e 'const fs=require("fs"); const dir=process.argv[1]; console.log(JSON.stringify({testRunnerEnv:{TASKHUB_UI_BACKEND_URL:fs.readFileSync(dir+"/ready","utf8"),TASKHUB_UI_DATA_DIR:dir,TASKHUB_UI_PTY_SOCKET:process.argv[2],TASKHUB_UI_PTYD_PATH:process.argv[3],TASKHUB_UI_REAL_BUILD:process.env.TASKHUB_REAL_BUILD_SIMULATOR ? "1" : "0"}}))' "$QA_DIR" "$QA_SOCKET" "$QA_HELPER")"
xcodebuildmcp macos test --project-path "$ROOT/macos/TaskHub.xcodeproj" --scheme TaskHub \
  --configuration Debug --derived-data-path "$ROOT/macos/.build/ui-tests" --json "$ARGS" \
  --extra-args "-only-testing:$QA_TEST"

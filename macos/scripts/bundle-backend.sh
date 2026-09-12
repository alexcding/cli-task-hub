#!/usr/bin/env bash
# Run after the Xcode build. Produces an ad-hoc signed development bundle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:?usage: bash macos/scripts/bundle-backend.sh /absolute/path/TaskHub.app}"
NODE_SIDECAR="${TASKHUB_NODE_SIDECAR:-$ROOT/src-tauri/binaries/taskhub-node-aarch64-apple-darwin}"
test -d "$APP/Contents/MacOS"
test -x "$NODE_SIDECAR"
node "$ROOT/scripts/gen-swift-routes.mjs" --check
cargo build --locked --release --manifest-path "$ROOT/crates/taskhub-ptyd/Cargo.toml"
BACKEND="$APP/Contents/Resources/backend"
mkdir -p "$BACKEND/src" "$APP/Contents/Helpers"
cp -R "$ROOT/src/server" "$ROOT/src/shared" "$BACKEND/src/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$BACKEND/"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix "$BACKEND"
cp "$NODE_SIDECAR" "$APP/Contents/Helpers/taskhub-node"
cp "$ROOT/crates/taskhub-ptyd/target/release/taskhub-ptyd" "$APP/Contents/Helpers/taskhub-ptyd"
codesign --force --sign - "$APP/Contents/Helpers/taskhub-node"
codesign --force --sign - "$APP/Contents/Helpers/taskhub-ptyd"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "Bundled Node backend and PTY daemon: $APP"

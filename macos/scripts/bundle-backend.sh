#!/usr/bin/env bash
# Run after the Xcode build. Produces an ad-hoc signed development bundle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:?usage: bash macos/scripts/bundle-backend.sh /absolute/path/TaskHub.app}"
test -d "$APP/Contents/MacOS"
python3 "$ROOT/macos/scripts/check-runtime-frameworks.py" "$APP"
if [[ -n "${TASKHUB_NODE_SIDECAR:-}" ]]; then
  NODE_SIDECAR="$TASKHUB_NODE_SIDECAR"
  NODE_LICENSE="${TASKHUB_NODE_LICENSE:?Provide the corresponding LICENSE for a custom Node runtime}"
else
  python3 "$ROOT/macos/scripts/node_runtime.py"
  NODE_SIDECAR="$ROOT/macos/.build/node/runtime/taskhub-node"
  NODE_LICENSE="$ROOT/macos/.build/node/runtime/LICENSE"
fi
test -x "$NODE_SIDECAR"
test -f "$NODE_LICENSE"
node "$ROOT/scripts/gen-swift-routes.mjs" --check
cargo build --locked --release --manifest-path "$ROOT/crates/taskhub-ptyd/Cargo.toml" --features terminal-snapshots
mkdir -p "$APP/Contents/Resources"
BACKEND_STAGE="$(mktemp -d "$APP/Contents/Resources/.backend-XXXXXX")"
trap 'rm -rf "$BACKEND_STAGE"' EXIT
BACKEND="$BACKEND_STAGE/backend"
mkdir -p "$BACKEND/src" "$APP/Contents/Helpers"
cp -R "$ROOT/src/server" "$ROOT/src/shared" "$BACKEND/src/"
while IFS= read -r asset || [[ -n "$asset" ]]; do
  [[ -z "$asset" || "$asset" == \#* ]] && continue
  mkdir -p "$BACKEND/src/renderer/$(dirname "$asset")"
  cp "$ROOT/src/renderer/$asset" "$BACKEND/src/renderer/$asset"
done < "$ROOT/macos/web-assets.txt"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$BACKEND/"
python3 "$ROOT/macos/scripts/backend-release.py" "$BACKEND" "$APP/Contents/Info.plist"
# Resolve the copied package from its own directory. npm's --prefix path can
# otherwise mix the caller's package root with the bundle's directory name.
(
  cd "$BACKEND"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)
cp "$NODE_SIDECAR" "$APP/Contents/Helpers/taskhub-node"
mkdir -p "$APP/Contents/Resources/Licenses"
cp "$NODE_LICENSE" "$APP/Contents/Resources/Licenses/Node-LICENSE"
cp "$ROOT/macos/licenses/Sparkle-LICENSE" "$APP/Contents/Resources/Licenses/Sparkle-LICENSE"
cp "$ROOT/macos/.build/ghostty-native/source/LICENSE" "$APP/Contents/Resources/Licenses/Ghostty-LICENSE"
cp "$ROOT/macos/.build/ghostty-native/package/LICENSE" "$APP/Contents/Resources/Licenses/GhosttyTerminal-LICENSE"
cp "$ROOT/macos/.build/ghostty-native/package/Sources/GhosttyTheme/LICENSE" "$APP/Contents/Resources/Licenses/GhosttyTheme-LICENSE"
cp "$ROOT/crates/taskhub-ptyd/target/release/taskhub-ptyd" "$APP/Contents/Helpers/taskhub-ptyd"
# Replace the complete generated resource tree. Re-bundling must not retain
# renderer files removed from the native allowlist or stale npm dependencies.
rm -rf "$APP/Contents/Resources/backend"
mv "$BACKEND" "$APP/Contents/Resources/backend"
rmdir "$BACKEND_STAGE"
trap - EXIT
codesign --force --sign - "$APP/Contents/Helpers/taskhub-node"
codesign --force --sign - "$APP/Contents/Helpers/taskhub-ptyd"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "Bundled Node backend and PTY daemon: $APP"

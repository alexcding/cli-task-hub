#!/usr/bin/env bash
# Run after the Xcode build. Produces an ad-hoc signed development bundle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:?usage: bash macos/scripts/bundle-backend.sh /absolute/path/TaskHub.app}"
test -d "$APP/Contents/MacOS"
python3 "$ROOT/macos/scripts/check-runtime-frameworks.py" "$APP"

cargo build --locked --release --manifest-path "$ROOT/crates/taskhub-backend/Cargo.toml"
cargo build --locked --release --manifest-path "$ROOT/crates/taskhub-ptyd/Cargo.toml" --features terminal-snapshots

mkdir -p "$APP/Contents/Helpers" "$APP/Contents/Resources/Licenses"
cp "$ROOT/crates/taskhub-backend/target/release/taskhub-backend" "$APP/Contents/Helpers/taskhub-backend"
cp "$ROOT/crates/taskhub-ptyd/target/release/taskhub-ptyd" "$APP/Contents/Helpers/taskhub-ptyd"
rm -f "$APP/Contents/Helpers/taskhub-node" "$APP/Contents/Resources/Licenses/Node-LICENSE"

# The native toolbar still uses committed provider artwork. No renderer code
# or JavaScript runtime is shipped with the application.
rm -rf "$APP/Contents/Resources/TaskHubImages" "$APP/Contents/Resources/backend"
mkdir -p "$APP/Contents/Resources/TaskHubImages"
cp -R "$ROOT/src/renderer/img/." "$APP/Contents/Resources/TaskHubImages/"

cp "$ROOT/macos/licenses/Sparkle-LICENSE" "$APP/Contents/Resources/Licenses/Sparkle-LICENSE"
# The GhosttyTerminal package checkout SwiftPM made for the Xcode build (the
# derived-data path the README's release build uses), unless one is given.
GHOSTTY_PKG="${TASKHUB_GHOSTTY_PACKAGE:-$ROOT/macos/.build/xcode/SourcePackages/checkouts/ghostty-terminal-spm}"
test -f "$GHOSTTY_PKG/LICENSE-ghostty" || { echo "GhosttyTerminal checkout not found at $GHOSTTY_PKG; set TASKHUB_GHOSTTY_PACKAGE" >&2; exit 1; }
cp "$GHOSTTY_PKG/LICENSE-ghostty" "$APP/Contents/Resources/Licenses/Ghostty-LICENSE"
cp "$GHOSTTY_PKG/LICENSE" "$APP/Contents/Resources/Licenses/GhosttyTerminal-LICENSE"
cp "$GHOSTTY_PKG/Sources/GhosttyTheme/LICENSE" "$APP/Contents/Resources/Licenses/GhosttyTheme-LICENSE"

codesign --force --sign - "$APP/Contents/Helpers/taskhub-backend"
codesign --force --sign - "$APP/Contents/Helpers/taskhub-ptyd"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "Bundled Rust backend and PTY daemon: $APP"

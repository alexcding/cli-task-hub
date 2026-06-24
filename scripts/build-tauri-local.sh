#!/usr/bin/env bash
# Local, ad-hoc-signed Tauri build for testing (no Apple account / notarization).
#
# Why this exists: `tauri build`'s own ad-hoc signing can leave the .app's signature inconsistent
# — Gatekeeper then refuses to launch it ("code has no resources but signature indicates they must
# be present"), so the app opens to a blank window because the backend sidecar never starts. We
# force a clean deep ad-hoc re-sign after bundling (the Tauri analog of the old Electron
# scripts/afterPack.js). For a real distributable release use `npm run build:tauri` with Developer
# ID signing + notarization instead.
#
# Builds only the .app (no DMG: bundle_dmg.sh drives Finder via AppleScript and needs a GUI
# session; it also isn't needed for local testing).
set -euo pipefail
cd "$(dirname "$0")/.."

APP="src-tauri/target/release/bundle/macos/TaskHub.app"

echo "── Building TaskHub.app (release, ad-hoc) ──"
npx tauri build -c '{"bundle":{"targets":["app"],"createUpdaterArtifacts":false}}'

echo "── Ad-hoc re-signing (clean, deep) ──"
codesign --force --deep --sign - "$APP"
codesign --verify --deep "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "✓ Launchable build at: $APP"
echo "  open \"$APP\""

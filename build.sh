#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/dist"
BUILD="$ROOT/build"
APP="$DIST/mac-arm64/TaskHub.app"

cyan()  { echo "\033[36m── $*\033[0m"; }
green() { echo "\033[32m✓ $*\033[0m"; }
die()   { echo "\033[31m✗ $*\033[0m" >&2; exit 1; }

# ── Args ──────────────────────────────────────────────────────────────────────
RUN=true
CLEAN=false

for arg in "$@"; do
  case $arg in
    --no-run) RUN=false ;;
    --clean)  CLEAN=true ;;
    --help|-h)
      echo "Usage: ./build.sh [--no-run] [--clean]"
      echo ""
      echo "  --no-run  Build only, don't launch the app"
      echo "  --clean   Remove dist/ and generated icons before building"
      exit 0
      ;;
  esac
done

# ── Clean ─────────────────────────────────────────────────────────────────────
if $CLEAN; then
  cyan "Cleaning"
  rm -rf "$DIST"
  rm -f "$BUILD/icon.icns" "$BUILD/icon.png" "$BUILD/tray-icon.png"
  rm -rf "$BUILD/icon.iconset"
  green "Clean done"
fi

# ── Icons ─────────────────────────────────────────────────────────────────────
cyan "Generating icons"

if [ ! -f "$BUILD/icon.icns" ]; then
  node "$ROOT/scripts/gen-icon.js"

  ICONSET="$BUILD/icon.iconset"
  SRC="$BUILD/icon.png"
  mkdir -p "$ICONSET"

  for size in 16 32 64 128 256 512; do
    sips -z $size $size "$SRC" --out "$ICONSET/icon_${size}x${size}.png" > /dev/null
    sips -z $((size*2)) $((size*2)) "$SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" > /dev/null
  done

  iconutil -c icns "$ICONSET" -o "$BUILD/icon.icns"
  green "icon.icns ready"
else
  echo "icon.icns already exists, skipping"
fi

# Tray icon — monochrome template glyph (transparent bg, auto-tinted by macOS)
node "$ROOT/scripts/gen-tray-icon.js"

# ── Build (dir target → TaskHub.app only, no DMG) ───────────────────────────────
cyan "Building TaskHub.app (arm64)"
cd "$ROOT"
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64

green "Build complete"
echo "  ${APP#$ROOT/}"

# ── Run ───────────────────────────────────────────────────────────────────────
if $RUN; then
  [ -d "$APP" ] || die "App not found at $APP"

  cyan "Stopping any running TaskHub"
  pkill -f "TaskHub.app/Contents/MacOS/TaskHub" 2>/dev/null || true
  pkill -f "$ROOT/server.js" 2>/dev/null || true
  lsof -ti:"${PORT:-3000}" | xargs kill -9 2>/dev/null || true

  cyan "Launching TaskHub.app"
  open "$APP"
fi

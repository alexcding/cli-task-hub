#!/usr/bin/env bash
# M3 — provide the Node backend's runtime for `tauri build`.
#
# The backend uses Node's built-in node:sqlite, so the sidecar must be REAL Node (bun's
# --compile fails: "No such built-in module: node:sqlite"). We ship the node binary itself as
# Tauri's externalBin; the server source + node_modules ride along as bundle.resources, and the
# Rust host spawns `node <resources>/src/server/app.js` in release (see start_backend in lib.rs).
#
# We download the OFFICIAL node binary (self-contained — links only system frameworks, verified),
# NOT the Homebrew one (a 67K launcher needing @rpath/libnode + /opt/homebrew dylibs that aren't
# in the .app). The version matches the local `node` so behavior matches dev.
#
# Tauri resolves externalBin "binaries/taskhub-node" to the target-triple-suffixed file.
set -euo pipefail
cd "$(dirname "$0")/.."

TRIPLE="$(rustc -Vv | sed -n 's/^host: //p')"
DEST="src-tauri/binaries/taskhub-node-${TRIPLE}"
VER="$(node --version)"                       # e.g. v26.3.1
case "$(uname -m)" in arm64) NARCH=arm64 ;; *) NARCH=x64 ;; esac
PKG="node-${VER}-darwin-${NARCH}"
URL="https://nodejs.org/dist/${VER}/${PKG}.tar.gz"

mkdir -p src-tauri/binaries
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "[build-sidecar] downloading self-contained Node ${VER} (${NARCH})…"
curl -fsSL "$URL" -o "$TMP/node.tgz"
tar -xzf "$TMP/node.tgz" -C "$TMP"
rm -f "$DEST"                                 # the source node is read-only; cp can't overwrite it
cp "$TMP/${PKG}/bin/node" "$DEST"
chmod +x "$DEST"
echo "[build-sidecar] wrote self-contained Node → ${DEST} ($(du -h "$DEST" | cut -f1))"

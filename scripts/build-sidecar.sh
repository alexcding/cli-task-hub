#!/usr/bin/env bash
# M3 — build the Node backend as a packaged sidecar for `tauri build`.  ⚠️ NOT YET WORKING.
#
# FINDING (2026): `bun build --compile` produces a single binary but FAILS AT RUNTIME with
# "No such built-in module: node:sqlite" — the backend (src/server/database/*) uses Node's
# built-in SQLite, which bun does not implement. So a bun single-file binary is a dead end.
#
# Two viable approaches (need a real `tauri build` + launch to verify, hence not wired into
# beforeBuildCommand / externalBin yet):
#
#   A. Ship real Node as the sidecar (simplest, ~heavy):
#      - cp "$(command -v node)" "src-tauri/binaries/taskhub-node-$(rustc -Vv|sed -n 's/host: //p')"
#        and declare it in tauri.conf.json bundle.externalBin.
#      - Bundle src/server + src/shared + src/renderer via bundle.resources.
#      - In lib.rs start_backend(): spawn the node sidecar with the resource path to
#        server/app.js as its arg (real Node → node:sqlite works). Verify the server's static/
#        path resolution works from the bundled (read-only) resource dir; data dir already honors
#        TASKHUB_DATA_DIR → userData.
#
#   B. Node SEA (single-executable-application): esbuild-bundle src/server into one CJS file,
#      then `node --experimental-sea-config` + postject into a copied node binary. Smaller, more
#      moving parts; confirm node:sqlite + the .mjs shared contracts survive bundling.
#
# Until one is implemented + verified, `tauri build` ships without a backend; `tauri dev` is
# unaffected (beforeDevCommand runs `node src/server/app.js`).
echo "M3 sidecar packaging is not implemented — see comments in this script." >&2
exit 1

# Native Ghostty snapshot bridge

These patches extend the exact Ghostty and Swift wrapper revisions in
`macos/scripts/ghostty-vt.lock.json`. Apply the wrapper's own patch stack first,
then `0001-native-snapshot-import.patch` to Ghostty and
`0002-swift-snapshot-import.patch` to the wrapper. The maintained build script
does this in generated checkouts; do not edit SwiftPM dependency checkouts.

`ghostty_surface_restore_snapshot` / `InMemoryTerminalSession.restoreSnapshot`
imports a complete bounded snapshot into a fresh host-managed surface. Call on
the main actor before exposing the surface to input or feeding live output.
The capture supplies the logical grid independently of the current physical view.
Invalid, truncated or trailing
data returns false without changing the original terminal. Search, selection,
composition, previous output and a second import also reject the operation.

The importer holds the terminal/renderer mutex while replacing state, places the
terminal at its final address, and reconstructs continuation with the supported
read-only standard TerminalStream. It verifies byte-identical continuation export,
then moves the shared Parser, UTF8Decoder, APC and DCS builders to the native
StreamHandler. It does not replay those bytes through a second handler. Future
output, key encoding, paste framing and terminal replies use normal native paths.
Host visual defaults remain configured while explicit terminal color overrides
and snapshot contents survive.

Before feeding live output, call `publishSnapshotMetadata()` on a worker and
keep draining `flushSnapshotMetadataCallbacks()` on the main actor. Publication
uses the native title and OSC 7 handlers, including local-host validation and
percent decoding. It converts the headless parser's working-directory URI into
the native path without feeding bytes into an unfinished parser. Publication is
allowed once, before subsequent output; callback draining holds no native surface
operation, allowing a callback to close the surface safely. TaskHub's attachment
pipeline owns this worker/tick lifecycle, including hidden surfaces.

After import, physical view resizes request a host resize without reflowing the
logical terminal. Apply each daemon resize event with
`InMemoryTerminalSession.applyHostGridSize(columns:rows:)` in the same serial
queue as output. The wrapper drains preceding bytes before changing the grid;
later output then uses that grid. Input stays gated until attachment completes.

This is a TaskHub extension, not an upstream snapshot compatibility promise. The
native app consumes the generated local Swift package for download/import and
ordered live resizes. Transient transport loss reconnects through a fresh surface
only when input delivery was settled; uncertain input requires manual recovery.
Offline query response ownership, native default/config synchronization and
snapshot-v1 omissions (Kitty images and glyph registrations) also remain open.

Build and run the separate real-surface integration suite:

```sh
python3 macos/scripts/build-ghostty-vt.py
python3 macos/scripts/build-ghostty-native.py
cargo build --manifest-path crates/taskhub-vt/Cargo.toml --example snapshot
xcodebuildmcp swift-package test --package-path "$PWD/macos/GhosttySnapshotTests"
```

The native build requires Apple's Metal compiler component. It uses a local,
single-slice arm64 XCFramework and the wrapper's local package manifest. A build
input fingerprint and source-diff hashes reject unexpected generated-source edits.
Changed patches are reapplied after reversing the previously recorded generated
changes, including newly added files. Older build directories without complete
patch tracking require a fresh `--build-root`. `--zig` selects the pinned
toolchain explicitly, and `--global-cache` permits reuse of its dependency cache.
With another build root, set `TASKHUB_GHOSTTY_PACKAGE` to its `package` directory
when running the integration suite. The Rust example accepts VT bytes on stdin
and produces a snapshot; it never executes commands or accesses application data.

The tests exercise a real native surface with history beyond the daemon replay
tail, primary and alternate screens, saved cursor, restored paste/key modes,
unfinished SGR, split UTF-8, OSC, DCS and APC, and live cursor-query responses.
They verify that rejected imports preserve the surface and historical queries
do not send replies to the shell. Metadata checks cover local/remote URIs, title
fallback, preserved parser continuation and surface closure during callbacks.
These tests establish the bridge behavior;
they do not establish complete app reconnection or the M1 performance gate.

# Isolated Tauri baseline preparation

The existing Tauri app can now be built for comparison without its production
backend launcher, updater checks, data directory or shared PTY socket. This is
build/startup evidence only; no performance acceptance result is claimed.

`macos/scripts/prepare-tauri-baseline.py` archives a pinned Git HEAD into a new
directory. It changes seven files solely to supply a unique app identity, fixed
loopback origin, exact remote capability, private daemon directory/socket, and
disabled backend/update startup. It records the patch, original/modified hashes,
and the complete copied source inventory in `baseline.json`. Existing output
directories are rejected. It never runs the normal Tauri development hooks.

The registered updater plugin still requires its configuration. The baseline
keeps that configuration with an empty endpoint list, and its automatic update
function is a no-op. Removing the configuration entirely caused a verified
startup panic; the corrected build below starts successfully.

## Reproduce

Choose an unused loopback port other than 3000 and a new output directory:

```bash
rtk proxy python3 macos/scripts/prepare-tauri-baseline.py \
  --origin http://127.0.0.1:43211 --output macos/.build/tauri-baseline-example
```

Run the `buildArguments` printed by the script, prefixed with `rtk proxy`.
`--offline` can be added when the locked dependencies are already cached. Then:

```bash
rtk proxy python3 macos/scripts/prepare-tauri-baseline.py \
  --bundle --output macos/.build/tauri-baseline-example
```

Bundling verifies the copied sources still match their manifest and that the
binary contains all four private identity/origin/path values. It creates and
ad-hoc signs a new app bundle, verifies its signature, and records the executable
hash in `build.json`. Build and bundle success do not prove successful startup.

Before launching with XcodeBuildMCP, start an owned fixture backend at the exact
manifest origin with `backendDataDir`, and verify its PID and a fixture identity
endpoint. Do not use `npm run dev` or `tauri dev` for this comparison. The staging
script does not start or validate the backend on the runner's behalf.

## Verified build and startup

- Source revision: `46d9b512a447957146001d421ad49275702bc61c`.
- Staging directory: `macos/.build/tauri-baseline-20260913-v2`.
- Runtime directory: `/private/tmp/th-compare-9wiuyj5x`, mode 0700.
- Rust: `rustc 1.93.0 (254b59607 2026-01-19)`.
- Locked offline release build: passed in 1m 07s. Existing vendored `muda`
  emitted 26 unnecessary-unsafe warnings.
- Signed bundle executable SHA-256:
  `be289588bcf23bb9f30086d4e6edd2e8b1506295204dbe3e1107dd98da299756`.
- Baseline manifest SHA-256:
  `bc147476f583c3ef485681e3cc66efc0b08d42c980dd7a4a4ab37a705b503cb2`.
- Three Python tests passed in 7.016s. They reject unsafe origins, existing output
  and changed function signatures; verify isolation settings; compare every
  untouched copied file against the pinned commit; and verify that only the path
  functions changed in the terminal host and daemon files.
- Before launch, `/fixture/baseline-identity` returned marker
  `th-compare-9wiuyj5x`, backend PID 93268 and the expected private data directory.
- XcodeBuildMCP launched host PID 93388. The inspected window was titled
  `TaskHub Tauri Baseline`, with HTML at `127.0.0.1:43211/`, the fixture project,
  native window controls and the rendered dashboard with empty PR groups.
- Daemon PID 93444 ran the staged executable with `__ptyd__` and the private
  directory. Its log confirmed protocol 2 at the private `tauri.sock` and the
  app connection. No user shells were created in this startup check.
- The host and fixture backend were stopped after inspection. The empty daemon
  was allowed to take its normal idle-exit path.

## Comparison work still required

Run the same ten-session workload in both full apps for at least ten minutes.
Measure key-to-display latency and CPU/GPU/RSS, verify hidden drawing and queue
bounds, and investigate regressions. Keep the source inventory and binary hashes
with each result. This startup fixture's 100ms SSE timer is for UI checks and
must not silently become the performance workload.

The copied xterm renderer has a 4,000-line scrollback limit. Tauri's Cargo feature
set does not enable `terminal-snapshots`, so it does not run the native daemon's
headless VT parser. Record the native retention and parser settings explicitly;
these differences affect how memory and CPU results can be interpreted.

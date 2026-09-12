# Headless terminal snapshot runtime

This crate owns a headless Ghostty terminal and exposes binary snapshot capture and
restore for the detached PTY daemon. The daemon consumes it in builds with the
`terminal-snapshots` feature, required by the native macOS app. Tauri retains its
feature-free helper protocol.

Build the pinned runtime and run its real-library tests:

```sh
python3 macos/scripts/build-ghostty-vt.py
cargo test --manifest-path crates/taskhub-vt/Cargo.toml
```

The script downloads a checksum-verified Zig toolchain into `macos/.build/ghostty-vt`,
checks out the same Ghostty revision as the native renderer, and builds a static
library. It does not install global tools. `TASKHUB_GHOSTTY_VT_DIR` may select an
already-built runtime; its revision marker must match. The Rust build copies the
archive under a unique name so Apple ld cannot substitute the upstream dylib.

Every terminal operation requires exclusive mutable access. Snapshots retain primary
and alternate screens, saved cursor, modes, styles, hyperlinks and scrollback, plus
up to 1 MiB of unfinished parser input. Scrollback is limited to 8 MiB, subject to
Ghostty's page-sized allocation granularity. Encoded snapshots are capped at 32 MiB;
truncated, corrupted and trailing data is rejected. Diagnostic VT formatting is not
used to restore state.

Upstream snapshot version 1 is not a stable cross-version disk format. Encoder and
decoder revisions must match. Kitty image payloads and glyph registrations are not
included by upstream; this runtime alone does not establish full terminal fidelity.
See the [pinned snapshot format source](https://github.com/ghostty-org/ghostty/blob/82938b633ba646db38591d969c3c526332bd7e65/src/terminal/snapshot/terminal.zig).

The daemon now parses every output batch, serializes kernel/parser resizes on its
I/O thread, and captures an atomic sequence boundary. Its connection-owned transfer
returns at most 128 KiB per read, with one snapshot of at most 32 MiB per connection.
See [the daemon snapshot protocol](../taskhub-ptyd/SNAPSHOTS.md).

The native app imports state into a fresh surface before applying newer output
and ordered resizes, preserving the shell across reattachment and reconnect.

`feed_with_responses` additionally collects the pinned runtime's synchronous
protocol replies, capped at 256 KiB per call. It applies input exactly once and
clears its temporary C callback/userdata before returning. If collection fails,
state may already have advanced: discard the partial reply buffer and do not
retry the input. Plain `feed` continues to parse silently. This API does not access
the host clipboard or write to a PTY; default runtime replies can include protocol
denials for unsupported host effects.

`feed_state_responses` filters complete response effect packets to the fixed
`daemon-state-v1` set: DSR status/cursor, DECRQM except native clipboard mode 5522,
DECRQSS, and Kitty keyboard flags. The daemon selects this only for shells created
with that owner; legacy shells retain silent `feed`. The native renderer suppresses
the identical set after import. Clipboard/UI, geometry, colors, device identity
and other configuration-dependent reports remain renderer-owned and require more
work for complete offline behavior. See the daemon protocol for the contract and
failure handling.

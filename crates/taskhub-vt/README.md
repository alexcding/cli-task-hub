# Headless terminal snapshot runtime

This crate owns a headless Ghostty terminal and exposes binary snapshot capture and
restore for the detached PTY daemon. It is an integration foundation: the production
daemon and Metal surface do not consume it yet.

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

Next integration steps are daemon-owned parsing of PTY output/resize events, an
atomic sequence boundary with bounded snapshot transport, and importing state into
the existing native surface before applying newer output. Those steps must preserve
the same shell and suppress historical side effects.

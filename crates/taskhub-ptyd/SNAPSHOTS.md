# Terminal snapshots (integration builds)

Build the pinned runtime first, then enable the explicit integration feature:

```sh
python3 macos/scripts/build-ghostty-vt.py
cargo test --manifest-path crates/taskhub-ptyd/Cargo.toml --features terminal-snapshots
```

Normal app/helper builds do not enable this feature yet. The native embedding
surface still needs snapshot import; its existing truncated-tail rejection remains
in place. Snapshot v1 also omits Kitty images and glyph glossary registrations.

Each terminal owns a headless Ghostty parser from creation. Output enters that
parser and the legacy ring under one lock. Kernel and parser resizing run on the
terminal's I/O thread between output batches; an acknowledged resize completes
after the kernel size changes. Dimensions must be nonzero, at most 4096 on each
axis, and at most 1,048,576 total cells. Failed parser resizing invalidates further
snapshots of that terminal instead of returning stale state.

The existing `seq` counts only output batches, so legacy replay clients keep their
contiguous output sequence. `stateSeq` counts both output and successful parser
resizes. Data events include both. A resize event carries `ev:"resize"`, `id`,
`cols`, `rows`, `seq` and `stateSeq`. Snapshot clients must subscribe before capture,
buffer these events, import the captured state, then apply only events with newer
`stateSeq`, in order. A sequence gap requires a fresh capture. Existing clients
ignore the extra fields and resize events.

Protocol 2 gains optional operations, available only in feature builds:

1. `hello` returns `snapshotRevision`. To opt in, send `dataEncoding:"base64"`
   and the exact expected `snapshotRevision`. A mismatch is rejected. Repeating
   `hello` clears any transfer and requires negotiating again.
2. `snapshotBegin {term}` captures immutable binary state under the terminal lock.
   Its response contains `token`, `size`, `chunkBytes`, `seq`, `stateSeq`, `cols`,
   `rows` and `revision`. It releases the previous transfer before capturing.
3. `snapshotRead {token,offset}` returns `{token,offset,bytes,done}`. `bytes` is
   padded base64 for at most 128 KiB. Offsets must be chunk aligned and within the
   snapshot. Reads are repeatable, so transport retries do not mutate state.
4. `snapshotEnd {token}` frees that connection's capture. Stale tokens fail and
   cannot release a newer capture. Disconnect also releases it. Reads after
   60 seconds reject and release an expired capture; an idle connection can retain
   at most its single bounded capture until disconnect or its next snapshot operation.

Tokens have meaning only on the connection that created them. Capturing does not
pause or kill the shell. The 32 MiB snapshot cap is independent of the 8 MiB socket
outbox cap; whole snapshots are never queued to the outbox. The client may use the
existing connection-owned flow pause while downloading if its live-event buffer
would otherwise overflow. Connection loss releases that pause.

Validation uses the real static Ghostty library and an isolated PTY: output beyond
the 256 KiB tail, chunked snapshot transfer, alternate/primary screens, unfinished
SGR, saved cursor, a resize followed by future output, and restoration from a new
connection with the same shell PID. Tests also cover revision/token/offset errors,
expiry, byte/text coexistence and contiguous legacy output across resizes.

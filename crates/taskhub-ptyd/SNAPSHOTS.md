# Terminal snapshots (integration builds)

Build the pinned runtime first, then enable the explicit integration feature:

```sh
python3 macos/scripts/build-ghostty-vt.py
cargo test --manifest-path crates/taskhub-ptyd/Cargo.toml --features terminal-snapshots
```

The native app and its bundle script require this feature; Tauri keeps its
existing feature-free helper protocol. Prepare both runtimes before building the
native app as described in `macos/README.md`. Snapshot v1 omits Kitty images and
glyph glossary registrations. UI/config-dependent offline queries remain open;
the state-only response contract below is implemented.

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

## State response ownership

Feature helpers advertise `stateResponseOwner:"daemon-state-v1"` in `hello`.
The native app requires it before creating a shell and sends the same value in
`create.opts.stateResponseOwner`. `create` and `list` return each shell's owner.
Ownership is fixed at creation; it never follows viewer count or connection state.
Unknown owners are rejected before spawning. The feature-free helper rejects any
explicit owner. Missing ownership retains the legacy silent parser, including in
feature-enabled builds, so existing Tauri shells keep their response path.

`daemon-state-v1` owns DSR operating status/cursor position, DECRQM except Kitty
paste mode 5522, DECRQSS, and Kitty keyboard-flag queries. It filters complete
synchronous Ghostty response packets, not raw requests, so fragmented queries and
snapshot continuations use the single authoritative parser. The pinned parser
ignores ANSI DECRQM in both runtime variants; this existing upstream limitation is
not changed by ownership. Device attributes, version/terminfo, clipboard (including
mode 5522), colors, title, visibility/focus, geometry and graphics remain native.
Those categories still need an explicit offline policy and configuration mediation.

Replies are generated before snapshot capture can observe the advanced state and
queued by the same PTY I/O worker. They share the bounded input queue and preserve
accepted input order, but do not set `hasContext`. Collection is capped at 256 KiB
per output batch. Collection/queue/write failure latches input failure, discards the
unsent suffix and emits `inputError`; collection failure also invalidates snapshots.
Neither output nor uncertain input is retried and the shell is preserved.

After checking the shell owner, native attachment imports the snapshot and enables
selective suppression before applying any newer output. It suppresses only the
owned handlers, preserving native clipboard/UI effects and ordinary keyboard/paste
input. Ownership persists through terminal reset and new native surfaces on
reconnect. An older shell is preserved and rejected rather than silently switching
its response owner. Legacy renderers must not render state-owned shells; the native
app uses a separate daemon socket from Tauri.

Real-PTY validation queries with no clients, two snapshot observers and after their
disconnection, checking exact response bytes, same PID and unchanged `hasContext`.
Native tests verify suppression across split DCS and reset, native paste/capability
responses, and exactly one CPR with two live app surfaces.

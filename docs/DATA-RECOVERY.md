# Native upgrade and rollback data

The native app uses `~/Library/Application Support/TaskHub` unless `--data-dir` or
`TASKHUB_DATA_DIR` overrides it. An external backend owns its own data directory.
Use the directory of the backend you intend to preserve, not a guessed directory
from a bundle identifier. The snapshot command requires an explicit source path.

## Backup and restore

The standalone `src/server/database/data-snapshot.js` tool uses Node's SQLite backup
API without importing application stores or running their schema changes. It ships
with the native backend. Use the bundled Node executable, or Node 22.16 or newer.

For a checkpoint across all files, save editor buffers and quit the frontend(s) and
backend(s) using the data directory before backup. Native tray Quit ends its PTYs;
Command-Q only hides the window. Online backups are also supported: each SQLite
file is a consistent read snapshot, including committed WAL contents, but the
database, rolling log and native JSON cache are captured separately. They are not
one cross-file transaction. Unsaved editor buffers must be saved separately.

From a checkout:

```bash
node src/server/database/data-snapshot.js backup \
  '/absolute/path/to/data' '/absolute/path/to/new-backup'
node src/server/database/data-snapshot.js verify '/absolute/path/to/new-backup'
node src/server/database/data-snapshot.js restore \
  '/absolute/path/to/new-backup' '/absolute/path/to/new-restored-data'
```

From an installed app, replace the command's executable and script with:

```bash
'/Applications/TaskHub.app/Contents/Helpers/taskhub-node' \
  '/Applications/TaskHub.app/Contents/Resources/backend/src/server/database/data-snapshot.js' \
  backup '/absolute/path/to/data' '/absolute/path/to/new-backup'
```

Backup and restore destinations must **not exist**, even as empty directories.
Their parents must exist. Restore validates the complete manifest, checksums and
SQLite integrity before creating the destination, then verifies each copied file
again. It never replaces a live database. An interrupted operation leaves incomplete
output for inspection, without a completed manifest/receipt. Choose a fresh path
for a retry. Snapshot directories are created with mode `0700`, files with `0600`.
They contain the same configuration secrets as the source database; keep them private.

Test the appropriate saved app version with `--data-dir /absolute/path/to/new-restored-data`
and an unused backend port. Close the current frontend/backend first, or also provide
a distinct `--pty-socket` when running isolated acceptance fixtures: changing the data
directory alone does not change the native daemon's default socket. The data tool
does not launch apps, poll GitHub/Jira, change login registration, run worktree
commands, adopt existing PTYs, or write to your original data directory's databases.

Use the **pre-upgrade** snapshot when rolling the app back. Starting a newer backend
may change its database schema, so copying a post-upgrade database to an older app
is not a rollback guarantee. Keep the original data and old app until acceptance
passes.

## Automatic packaged startup checkpoint

The packaged native app now runs `native-launcher.js` before importing any backend
application stores. On first adoption of existing data, and whenever the packaged
release identity changes, it creates and verifies a checkpoint under
`DATA_DIR/native-backups/checkpoint-<UUID>`. This also protects the first backend
launch after a Sparkle restart: the app binary has already been installed, but its
database-opening/schema code has not run yet. It is not a backup of the old app binary.

The release identity includes packaged backend/document source files and dependency manifests,
the app's bundle identifier/version/build, and the running Node version. Re-bundling
identical inputs keeps the identity stable. Distribution builds must increment
`CFBundleVersion`; compiled Swift changes are identified through that app metadata.
The `last-launch.json` receipt records
the prepared identity and checkpoint only after snapshot files and metadata have
been flushed. A repeated launch re-verifies the same checkpoint. A new transition,
including returning to a previously used version, gets a new directory so previous
rollback copies are retained. Fresh installations record their identity without an
empty snapshot. Backups are not pruned automatically.

Backup failure or damaged/missing state stops startup before loading application
stores. A damaged previous checkpoint is not silently replaced with a backup of
already-upgraded data. Preserve the `native-backups` directory and inspect the
reported error in `native-backend.log`; recovery uses a new data directory as above.
The native host allows up to two minutes for checkpoint preparation plus backend
readiness, and cancellation stops only its owned child. Incomplete checkpoint
directories may remain for inspection after cancellation or a crash.

A separate SQLite transaction in `native-backups/owner.db` serializes packaged
native owners for the lifetime of their backend process. Normal exit and process
death release its OS lock; the lock file is never deleted or replaced. This guards
native packaged instances, not old Tauri or standalone backend processes, which do
not participate. Stop those processes before a native upgrade, or use native
external-backend mode for deliberate shared-backend development. External and
unpackaged development launches do not run this checkpoint gate.

## State inventory

| State | Storage and handling |
| --- | --- |
| Projects, workflows, automation settings, CLI preferences, PR/Jira links | `taskhub.db`; included without rewriting schema or unknown columns. |
| Worktree sessions, pinned state, CLI conversation IDs | `taskhub.db`; included. Actual checkout files and agent conversation stores remain in their existing locations. |
| Viewer tabs, document paths/order/history, native context settings | `taskhub.db`; included. Native `native.context.*` settings coexist with web tab rows. |
| Pending native context writes | `ptyd-native-spike/page-tabs.json`; included when present. This is page metadata, not unsaved editor text. |
| Review requested/viewed timestamps | `taskhub.db`; included, avoiding an artificial reset of acknowledged reviews on restore. |
| Activity and diagnostic history | `logs.db`; included when present as a separate consistent SQLite snapshot. |
| Older durable filename | If `taskhub.db` is absent, `config.db` is captured/restored under its original name. Backup does not trigger the application's legacy rename or destructive schema changes. |
| GitHub/Jira snapshots | `data.db`; regenerable, omitted. The normal poller repopulates the restored installation. |
| Terminal screen state and live process metadata | Daemon memory and PTY manifests; omitted. Restoring files cannot restore OS processes. Sparkle restart preserves the existing daemon separately; explicit tray Quit terminates it. |
| Native sidebar selection/collapse, window geometry | AppKit/UserDefaults in `com.alexcding.taskhub`; left in place during same-bundle upgrades. Not part of this data-directory snapshot. |
| Native cached settings and pending preference writes | UserDefaults `native.*`; not copied by this tool. Synced values are in SQLite. Reconnect and let pending writes finish before taking an offline checkpoint. |
| Tauri localStorage appearance | Theme is mirrored to SQLite; the database remains authoritative. |
| Tauri localStorage layout | `taskhub.prRatio`, `taskhub.projCollapsed`, `taskhub.sidebarWidth`, `taskhub.histSplit` are web layout preferences. Native layouts use their own defaults; the web values are left untouched for rollback. |
| Remote website logins/cookies, OS notification/login approvals | Browser and macOS stores; not moved by this tool. Cross-host login migration and real OS upgrade behavior still require acceptance. |

## Evidence and remaining release gates

`test/data-snapshot.test.js` exercises committed-but-uncheckpointed WAL rows, unknown
legacy schema, native pending pages, log history, Unicode, private permissions,
corruption and symlink rejection, and refusal to overwrite existing destinations.
It also seeds the real current backend with projects/workflows/sessions/tabs/settings/
review state/activity, restores into another temporary directory, and compares the
backend's full returned durable state after reopen. Tests never use production data
or start polling/CLI automation.

The seven focused tests pass. The live-WAL fixture takes about 30 seconds inside
Node's asynchronous backup, with the full suite around 71 seconds on the development
machine; these tests establish correctness, not a startup latency budget.
`node macos/scripts/smoke-data-recovery.cjs /absolute/path/TaskHub.app` also copies the
packaged Node helper and recovery script outside the checkout and exercises the
documented backup/verify/restore commands. Its isolated legacy schema is preserved
and the source database checksum is unchanged.

`test/native-checkpoint.test.js` verifies startup ordering before a destructive
fixture migration, repeat launch, successive upgrades/rollback, failure refusal,
and interprocess ownership with recovery after a killed owner. A Swift integration
test runs the real launcher with fixture application code, checks readiness ordering,
and cancels an injected slow checkpoint before the application module loads.
`test/native-launcher-lifetime.test.js` forces garbage collection after startup and
verifies a competing process remains excluded; this reproduced and then verified
the fix for a prematurely released ownership handle.
The packaged recovery smoke test also runs copied launcher/checkpoint resources
with a no-network fixture application module: first adoption creates a checkpoint,
repeat launch reuses it, and corruption prevents the fixture module from loading.

This proves snapshot and restoration behavior for those fixtures. Real previous
release binaries, clean-Mac installation, signed Sparkle updates, browser
authentication, and native UserDefaults migration remain release acceptance work.

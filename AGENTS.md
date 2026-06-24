# AGENTS.md - working guide for TaskHub

Read `README.md` for the full picture. This file is the fast path for making changes.

## What this is

Localhost web dashboard + macOS menu-bar app that tracks GitHub PRs and Jira tickets
per project, shows CI status, and auto-transitions Jira tickets when a PR merges.
Pure Node + Express + a no-build ES-module SPA (`src/renderer/`, see `CLAUDE.md` for the
renderer pattern) + a Tauri (Rust) menu-bar shell. Code is a layered tree — `src-tauri/`
(the Tauri/Rust host: window, tray, menus, terminals, embedded viewer, notifications),
`src/server` (CLI backend: `routes/` / `services/` / `repositories/` / `database/`, run as
a Node sidecar), `src/renderer`, `src/shared` (cross-process contracts) — see
`docs/ARCHITECTURE.md`. Data via the `gh` and `acli` CLIs (no API tokens). No build step
for the web; Tauri provides the native shell.

## The one mental model that matters

**Stale-while-revalidate over a DB snapshot.**

- `src/server/services/poller.js` is the **only** thing that calls `gh`. Every `poll_interval`
  (default 60s) it fetches each project's PRs once and writes a **lean snapshot** to
  `data.db` (via `src/server/database/db.js`). Concurrent syncs of one project are coalesced
  (see `syncProject`) so a stale read racing the poll loop can't double-spawn `gh`.
- Every API endpoint **reads the snapshot** (instant). On read, a stale snapshot (>30s)
  triggers a background sync (SWR). Never add a `gh` call to a request handler.
- `/api/stream` (SSE) pushes `{type:'sync'}` when a snapshot changes, so open pages re-read
  seamlessly. It also pushes `{type:'reload'}` for dev live-reload.

If you need fresher data in the UI, fix the sync loop. Do not make endpoints call `gh`.

## Run / iterate

```bash
npm install
npm run dev            # web-only dev: frees the port, watch-runs the server, opens the browser
bunx tauri dev         # the desktop app: starts the backend (beforeDevCommand) + opens the Tauri window
bunx tauri build       # package the macOS .app/.dmg (builds the Node sidecar first)
```

- `npm run dev` → `./dev.sh`: kills any stale server, runs `node --watch src/server/app.js`,
  and opens http://localhost:3000. Override the port with `PORT=4000 npm run dev`; skip the
  browser with `./dev.sh --no-open`. Raw watch (no port-free / browser) is `npm run dev:server`.
- `bunx tauri dev`: `beforeDevCommand` frees `:3000` and runs `node src/server/app.js` (with
  `TASKHUB_DATA_DIR` set), then the Rust window loads `http://localhost:3000`. The host layer
  lives in `src-tauri/` (Rust); see `docs/TAURI-PORT.md` for the port's mechanics.
- Web changes: just save; the page auto-reloads (server watches `src/renderer` + `src/shared`
  → SSE `reload`). The Tauri window reloads with it (it's just pointed at `:3000`).
- Host (`src-tauri/`, Rust) changes: `bunx tauri dev` rebuilds the Rust crate on restart.
- Requires Node ≥22.12 (the server `require()`s the `.mjs` shared contracts). Packaged builds
  ship the **official Node binary as a sidecar** (`src-tauri/binaries/taskhub-node`) — Homebrew/
  system Node isn't self-contained enough to bundle (see `docs/TAURI-PORT.md` Milestone 3).

## Files

**Server** (`src/server/`, the CLI backend — runs as a Node sidecar, or standalone):
- `app.js` - Express bootstrap, middleware/static, route registration, SSE wiring, start/stop.
- `routes/*.js` - thin handlers (parse → service/repository → JSON): `config`, `projects`,
  `git`, `prs`, `jira`, `logs`, `system`, `sse`; `helpers.js` is `wrap()`.
- `services/poller.js` - sync engine + merge automation + lifecycle events;
  `services/sync.js` - SWR snapshot orchestration (`snapshotFor`, `jiraStale`);
  `services/webhook-forwarder.js` - `gh webhook forward` child processes.
- `repositories/github.js` - `gh` wrapper (`getPRs`, `parseRepo`, `summarizeCI`, `getCurrentUser`)
  + gh-latency metrics (`ghStats`); `repositories/jira.js` - `acli`; `repositories/usage.js` -
  `ccusage` (SWR-cached).
- `database/db.js` - facade over the SQLite stores: `configdb.js` (`taskhub.db`, durable),
  `datadb.js` (`data.db`, volatile CLI cache), `logdb.js` (`logs.db`, rolling log);
  `datadir.js` resolves the data dir. `logger.js` - rolling file-log transports.

**Renderer** (`src/renderer/`): `index.html` + `css/*` markup/styles; `app.js` bootstrap;
`stores/store.js` state; `pages/*` + `components/*` views; `services/{api,theme,fonts}.js`;
`lib/{util,icons,diff-parse.mjs,git-graph.mjs}`. See `CLAUDE.md`.

**Tauri host** (`src-tauri/`, Rust): `src/lib.rs` (entry; builds the window in Rust, spawns
the Node sidecar in release, wires tray/plugins) + `src/main.rs`; `src/commands.rs` (the
`window.taskhub.*` commands — theme/dialog/open/usage/avatar); `src/terminals.rs` (PTYs via
`portable-pty`); `src/tray.rs` + `src/menu.rs` + `src/webview_menu.rs` (tray, app menu,
embedded-webview context menu); `src/viewer.rs` (WKWebView title/URL/nav poll for the
embedded tabs); `src/notify.rs` (review + activity notifications); `src/usage_image.rs` +
`src/avatars.rs`. `bridge.js` is the preload-equivalent init script that defines
`window.taskhub.*` over Tauri `invoke`/events; `tauri.conf.json` + `capabilities/` configure
the window, sidecar, and the remote-origin IPC allowlist. See `docs/TAURI-PORT.md`.

**Shared** (`src/shared/`): `routes.mjs` (HTTP route paths), `constants.mjs`
(`PR_CATEGORY`/`PR_GROUP`). `.mjs` are served to the renderer at `/shared` and `require()`d by Node.

**Scripts**: `scripts/gen-icon.js` - icon generation; `scripts/build-sidecar.sh` - downloads the
official Node binary into `src-tauri/binaries/` (run by `tauri build`'s `beforeBuildCommand`).

## Conventions / gotchas

- **One repo per project.** Project shape: `{id,name,color,repo,workspace,jiraProjectKey,jql,mergeTransition,forwardWebhooks,created_at}`.
- **Project IDs are UUIDs.** In inline HTML `onclick`, always quote IDs: `onclick="fn('${id}')"` .
- **Schema is `CREATE TABLE IF NOT EXISTS`** in each `src/server/database/*db.js` — no migration framework;
  `data.db` and `logs.db` are safe to delete (regenerable), `taskhub.db` is not.
- **CI is inline** via `gh pr list --json ...,statusCheckRollup`, collapsed by `summarizeCI`.
- **Two PR classifications, different surfaces — don't conflate them** (`src/server/repositories/github.js`):
  - **`category`** (`mine`/`review`/`other`) — strictly "I'm an *actively requested* reviewer".
    Drives the **tray menu + sound** (`src-tauri/src/tray.rs`, `src-tauri/src/notify.rs`). Keep it narrow:
    broadening it would re-fire review sounds. GitHub drops you from `reviewRequests` the moment
    you submit *any* review (even a comment), so `category` flips to `other` then.
  - **`awaitingMyReview`** — broader "still in my review orbit": requested **OR** I've left any
    review (commented / approved-but-unmerged / changes-requested), non-draft, not mine. Drives the
    **dashboard "Review Requested"** section and the **sidebar Mine/Review grouping** (via
    `store.prGroup`). Mirror it in any new Mine-vs-Review split — never group on raw `category`.
- **The snapshot is *lean*** (`src/server/services/poller.js#lean`): the renderer only ever sees fields `lean()`
  copies through. If a card/view needs a new `gh` field (e.g. `reviewDecision`, `awaitingMyReview`),
  add it to both `PR_FIELDS` (`src/server/repositories/github.js`) **and** `lean()` — a field present on the raw PR but
  absent from `lean()` is silently `undefined` client-side (this bit the approved-check + grouping).
- **Data dir**: `TASKHUB_DATA_DIR` -> the Tauri app-data dir (`~/Library/Application Support/tv.accedo.taskhub`,
  set by `beforeDevCommand` in dev and by `lib.rs` in packaged) -> repo root.
- **Storage is built-in `node:sqlite`** (Node 22+, provided by the bundled Node sidecar) — no native
  module like `better-sqlite3`; the built-in keeps the sidecar a plain stock Node binary.
- **`acli` flags**: `workitem transition --key K --status S --yes`; use `--json` for reads.
- **`gh webhook` extension may be missing**. Polling still catches merges. Install with:
  `gh extension install cli/gh-webhook`.
- **Build is arm64-only**, ad-hoc/unsigned (signing the updater is owed — see `docs/TAURI-PORT.md`).
- **Icons are committed**; regenerate with `scripts/gen-icon.js`.
- Tray status color: **black/white** idle, **blue** tasks, **bronze (#98712c)** review.

## CLI tools available in this environment

`gh` (GitHub), `acli` (Atlassian/Jira), `bun`, `node`, `cargo`/`bunx tauri` (the Tauri CLI).

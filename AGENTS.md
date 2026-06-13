# AGENTS.md - working guide for TaskHub

Read `README.md` for the full picture. This file is the fast path for making changes.

## What this is

Localhost web dashboard + macOS menu-bar app that tracks GitHub PRs and Jira tickets
per project, shows CI status, and auto-transitions Jira tickets when a PR merges.
Pure Node + Express + a no-build ES-module SPA (`src/renderer/`, see `CLAUDE.md` for the
renderer pattern) + Electron tray. Code is a layered `src/` tree — `src/main` (Electron
host), `src/preload`, `src/server` (forked CLI backend: `routes/` / `services/` /
`repositories/` / `database/`), `src/renderer`, `src/shared` (cross-process contracts) —
see `docs/ARCHITECTURE.md`. Data via the `gh` and `acli` CLIs (no API tokens). No build
step for the web; Electron only for the tray.

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
npm run dev            # web dev: frees the port, watch-runs the server, opens the browser
npm run dev:app        # web dev but launches the Electron app instead of the browser
npm run build          # package the Electron app (.dmg/.zip/.app, ad-hoc signed)
```

- `npm run dev` → `./dev.sh`: kills any stale server, runs `node --watch src/server/app.js`,
  and opens http://localhost:3000. Override the port with `PORT=4000 npm run dev`; skip the
  browser with `./dev.sh --no-open`. Raw watch (no port-free / browser) is `npm run dev:server`.
- Web changes: just save; the page auto-reloads (server watches `src/renderer` + `src/shared`
  → SSE `reload`).
- Tray (`src/main/`) or server-startup (`src/server/app.js`) changes: rebuild with `npm run build`.
- Requires Node ≥22.12 (the server/main `require()` the `.mjs` shared contracts); Electron's
  bundled Node 24 satisfies this for the packaged app.

## Files

**Server** (`src/server/`, the forked CLI backend):
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
  `datadir.js` resolves the data dir. `logger.js` - electron-log transports.

**Renderer** (`src/renderer/`): `index.html` + `css/*` markup/styles; `app.js` bootstrap;
`stores/store.js` state; `pages/*` + `components/*` views; `services/{api,theme,fonts}.js`;
`lib/{util,icons,diff-parse.mjs,git-graph.mjs}`. See `CLAUDE.md`.

**Electron host** (`src/main/`, `src/preload/index.js`): `app/main.js` (entry; forks the
server) + `app/const.js`; `windows/window.js`; `tray/menu.js`; `menu/app-menu.js`;
`updater/updater.js`; `server/supervisor.js`; `ipc/` (`terminals.js` PTYs, `system.js`
theme/dialog/avatar/usage/sound — the whole native IPC surface); `native/`
(`icons.js`, `notifications.js`, `usage.js` = TaskHub RAM/CPU, `usage-image.js` = the
Claude/Codex token panel as a menu-row image).

**Shared** (`src/shared/`): `routes.mjs` (HTTP route paths), `channels.js` (IPC channel
names, CommonJS — the sandboxed preload inlines literals and can't import it), `constants.mjs`
(`PR_CATEGORY`/`PR_GROUP`). `.mjs` are served to the renderer at `/shared` and `require()`d by Node.

**Scripts**: `scripts/{gen-icon,build,afterPack}.js` - icon generation + packaging.

## Conventions / gotchas

- **One repo per project.** Project shape: `{id,name,color,repo,workspace,jiraProjectKey,jql,mergeTransition,forwardWebhooks,created_at}`.
- **Project IDs are UUIDs.** In inline HTML `onclick`, always quote IDs: `onclick="fn('${id}')"` .
- **Schema is `CREATE TABLE IF NOT EXISTS`** in each `src/server/database/*db.js` — no migration framework;
  `data.db` and `logs.db` are safe to delete (regenerable), `taskhub.db` is not.
- **CI is inline** via `gh pr list --json ...,statusCheckRollup`, collapsed by `summarizeCI`.
- **Two PR classifications, different surfaces — don't conflate them** (`src/server/repositories/github.js`):
  - **`category`** (`mine`/`review`/`other`) — strictly "I'm an *actively requested* reviewer".
    Drives the **tray menu + sound** (`src/main/tray/menu.js`, `src/main/native/notifications.js`). Keep it narrow:
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
- **Data dir**: `TASKHUB_DATA_DIR` -> Electron `userData` -> repo root.
- **Storage is built-in `node:sqlite`** (Node 22+/Electron's Node) — no native module like
  `better-sqlite3`, which is incompatible with the current Electron and must stay out.
- **`acli` flags**: `workitem transition --key K --status S --yes`; use `--json` for reads.
- **`gh webhook` extension may be missing**. Polling still catches merges. Install with:
  `gh extension install cli/gh-webhook`.
- **Build is arm64-only, `dir` target**, unsigned (`identity:null`).
- **Icons are committed**; regenerate with `scripts/gen-*.js`.
- Tray status color: **black/white** idle, **blue** tasks, **bronze (#98712c)** review.

## CLI tools available in this environment

`gh` (GitHub), `acli` (Atlassian/Jira), `bun`, `node`, `electron`/`electron-builder`.

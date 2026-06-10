# AGENTS.md - working guide for TaskHub

Read `README.md` for the full picture. This file is the fast path for making changes.

## What this is

Localhost web dashboard + macOS menu-bar app that tracks GitHub PRs and Jira tickets
per project, shows CI status, and auto-transitions Jira tickets when a PR merges.
Pure Node + Express + a no-build ES-module SPA (`public/index.html` + `public/js/`,
see `CLAUDE.md` for the renderer pattern) + Electron tray. Data via the `gh` and
`acli` CLIs (no API tokens). No build step for the web; Electron only for the tray.

## The one mental model that matters

**Stale-while-revalidate over a DB snapshot.**

- `lib/poller.js` is the **only** thing that calls `gh`. Every `poll_interval` (default 60s)
  it fetches each project's PRs once and writes a **lean snapshot** to
  `data.db` (via `lib/db.js`).
- Every API endpoint **reads the snapshot** (instant). On read, a stale snapshot (>30s)
  triggers a background sync (SWR). Never add a `gh` call to a request handler.
- `/api/stream` (SSE) pushes `{type:'sync'}` when a snapshot changes, so open pages re-read
  seamlessly. It also pushes `{type:'reload'}` for dev live-reload.

If you need fresher data in the UI, fix the sync loop. Do not make endpoints call `gh`.

## Run / iterate

```bash
npm install
npm run dev            # web dev: frees the port, watch-runs server.js, opens the browser
npm run build:run      # package + launch the Electron tray app
```

- `npm run dev` → `./dev.sh`: kills any stale server, runs `bun --watch server.js`
  (falls back to `node --watch` if bun is absent), and opens http://localhost:3000.
  Override the port with `PORT=4000 npm run dev`; skip the browser with `./dev.sh --no-open`.
  Raw watch (no port-free / browser) is still `npm run dev:server`.
- Web changes: just save; the page auto-reloads (server watches `public/` → SSE `reload`).
- Tray, `tray.js`, or `server.js` startup changes: rebuild with `npm run build:run`.
- `build:run` kills any running instance and frees port 3000 first.

## Files

- `server.js` - routes, SSE, webhook, static serving.
- `lib/db.js` - facade over the SQLite stores: `lib/configdb.js` (`taskhub.db`, durable),
  `lib/datadb.js` (`data.db`, volatile CLI cache), `lib/logdb.js` (`logs.db`, rolling log).
- `lib/github.js` - `gh` wrapper: `getPRs`, `parseRepo`, `summarizeCI`, `getCurrentUser`.
- `lib/jira.js` - `acli` wrapper.
- `lib/poller.js` - sync engine + merge automation + lifecycle events.
- `lib/webhook-forwarder.js` - `gh webhook forward` child processes.
- `public/index.html` - SPA markup + stylesheet; `public/js/` - renderer modules (see `CLAUDE.md`).
- `tray.js` + `main/` - Electron menu bar (menu, notifications, PTYs, window, updater).
- `scripts/gen-icon.js`, `scripts/gen-tray-icon.js`, `scripts/build.js` - app/tray icon generation and packaging.

## Conventions / gotchas

- **One repo per project.** Project shape: `{id,name,color,repo,workspace,jiraProjectKey,jql,mergeTransition,forwardWebhooks,created_at}`.
- **Project IDs are UUIDs.** In inline HTML `onclick`, always quote IDs: `onclick="fn('${id}')"` .
- **Schema is `CREATE TABLE IF NOT EXISTS`** in each `lib/*db.js` — no migration framework;
  `data.db` and `logs.db` are safe to delete (regenerable), `taskhub.db` is not.
- **CI is inline** via `gh pr list --json ...,statusCheckRollup`, collapsed by `summarizeCI`.
- **PR `category`** (`mine`/`review`/`other`) is computed from `gh api user`.
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

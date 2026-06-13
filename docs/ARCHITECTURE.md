# TaskHub Architecture

This document describes the **target** layered architecture for TaskHub. It adapts
the Clean-Architecture-for-Electron pattern (layers, services, repositories, shared
contracts, one-way dependency flow, a hard transport boundary) to TaskHub's actual
reality:

- **No framework, no bundler.** The renderer is vanilla ES modules — by choice.
- **The backend is CLI orchestration**, not a DB server. The heavy lifting is shelling
  out to `gh`, `acli` (Jira), `git`, and `rtk` and snapshotting the results.
- **The transport is HTTP, not IPC.** The renderer talks to a local Express server over
  `fetch` + SSE. A small IPC surface remains for the things HTTP can't do (PTYs, native
  dialogs, theme) — see *Two transports* below.

The generic pattern assumes React + TypeScript + "everything through typed IPC." We keep
its **discipline** and drop its **stack**: the layering, the service/repository split,
the shared contracts, and the strict dependency direction all apply; the framework, the
build step, and the IPC-only transport do not.

---

## The three processes

TaskHub is not a single process with one backend. It runs three:

```
┌─────────────────────┐      ┌──────────────────────┐      ┌─────────────────────────┐
│  Electron host       │ fork │  Server (backend)     │ CLI  │  gh / acli / git / rtk   │
│  (main process)      │─────▶│  Express child proc   │─────▶│  OS / filesystem         │
│  windows, tray,      │      │  poller, webhooks,    │      │                          │
│  menu, updater,      │      │  snapshot DBs         │      └─────────────────────────┘
│  native IPC          │      └──────────┬───────────┘
└──────────┬───────────┘                 │ HTTP (fetch) + SSE
           │ preload bridge               │
           │ (window.taskhub.*)           ▼
           ▼                    ┌──────────────────────┐
   ┌──────────────────┐  load  │  Renderer (vanilla)   │
   │  <webview> /      │◀───────│  pages, stores,       │
   │  BrowserWindow    │        │  services, components │
   └──────────────────┘        └──────────────────────┘
```

1. **Electron host (main process)** — the desktop shell. Owns windows, the tray, the
   app/native menus, the auto-updater, and the small native IPC surface. It also
   *supervises* the server: it `fork()`s it and restarts it.
2. **Server (backend, forked child)** — the CLI-orchestration backend. Owns the poller,
   the webhook forwarder, the snapshot databases, and all `gh`/`acli`/`git` access.
   Exposes everything over an HTTP API + an SSE stream. **This is where the doc's
   "services / repositories / database" layers physically live.** It runs as a separate
   process so a hung CLI call can't freeze the UI, and so it can run **standalone**
   (`node src/server/app.js`) and be reached from a plain **browser** with no Electron.
3. **Renderer** — the vanilla-ESM web UI. Pure function of state; never touches the OS.

> **Why a server and not IPC?** The CLI backend is the *reason* to keep it. A forked
> process gives crash/hang isolation, lets the poller + webhook loops own the snapshot
> DB, and keeps the app browser-accessible. Collapsing it into IPC handlers would run CLI
> spawns inside `main` (or re-fork a child anyway) and lose browser/standalone mode for
> nothing. So HTTP is the **primary** transport; IPC is the exception, not the rule.

---

## Target folder structure

```
src/
├── main/                       # Electron host (main process) — the desktop shell
│   ├── app/
│   │   ├── main.js             # entry point (package.json "main"); app lifecycle
│   │   └── const.js            # host-wide constants
│   ├── windows/
│   │   └── window.js           # BrowserWindow creation + window-scoped IPC
│   ├── tray/
│   │   └── menu.js             # tray menu model (the Tray itself is created in app/main.js)
│   ├── menu/
│   │   └── app-menu.js         # native application menu
│   ├── updater/
│   │   └── updater.js          # Squirrel.Mac auto-update
│   ├── server/
│   │   └── supervisor.js       # fork + supervise the backend server child
│   ├── ipc/                    # the ENTIRE native IPC surface lives here, nowhere else
│   │   ├── terminals.js        # term:create / write / resize / kill / list / attach
│   │   └── system.js           # avatar:fetch, usage:get, choose-folder, open-path, theme…
│   └── native/                 # OS/native helpers (no UI, no IPC wiring)
│       ├── icons.js
│       ├── notifications.js
│       ├── usage.js
│       └── usage-image.js
│
├── preload/
│   └── index.js                # contextBridge: exposes window.taskhub.* (thin, validated)
│
├── server/                     # Backend (forked child) — the doc's service+repo+db layers
│   ├── app.js                  # entry: Express app, route wiring, listen(); self-starts standalone
│   ├── routes/                 # HTTP handlers = the transport boundary (≈ ipcMain.handle)
│   │   ├── prs.js              # thin: parse request → call a service → send JSON
│   │   ├── jira.js
│   │   ├── logs.js
│   │   ├── projects.js
│   │   └── sse.js              # the /events SSE stream
│   ├── services/               # business logic / orchestration / workflows
│   │   ├── poller.js           # long-running sync loop
│   │   ├── webhook-forwarder.js
│   │   └── sync.js             # snapshot orchestration (services call repositories)
│   ├── repositories/           # data access only — CLI, external API, no business rules
│   │   ├── github.js           # gh CLI
│   │   ├── jira.js             # acli CLI
│   │   └── usage.js
│   ├── database/               # snapshot persistence + data-dir resolution
│   │   ├── db.js
│   │   ├── datadb.js
│   │   ├── configdb.js
│   │   ├── logdb.js
│   │   └── datadir.js
│   └── logger.js
│
├── renderer/                   # Vanilla-ESM UI (served statically by the server)
│   ├── index.html              # static shell + page containers (markup only)
│   ├── app.js                  # bootstrap + router (showPage), SSE refresh, window bridge
│   ├── pages/                  # one module per page — was public/js/views/*
│   │   ├── dashboard.js
│   │   ├── jira.js
│   │   ├── logs.js
│   │   ├── settings.js
│   │   ├── project.js
│   │   └── git-tab.js
│   ├── components/             # reusable render helpers (no page ownership)
│   │   ├── cards.js
│   │   ├── modal.js
│   │   ├── usage-widget.js
│   │   ├── sidebar.js
│   │   ├── viewer.js           # embedded PR/terminal/diff panel
│   │   ├── split.js
│   │   ├── terminal.js
│   │   ├── commit.js
│   │   ├── diff.js
│   │   ├── git.js              # shared git render helpers
│   │   ├── menu.js             # context menus
│   │   └── toast.js
│   ├── stores/
│   │   └── store.js            # the single mutable `state` + pure lookups
│   ├── services/
│   │   ├── api.js              # the ONLY HTTP client: api() / apiJson()
│   │   ├── theme.js
│   │   └── fonts.js
│   ├── lib/                    # DOM-free pure logic (unit-testable directly)
│   │   ├── util.js
│   │   ├── icons.js
│   │   ├── diff-parse.mjs
│   │   └── git-graph.mjs
│   │   # Served static assets stay at the renderer web root (not under assets/) so
│   │   # their absolute URLs survive — JS/HTML reference /css, /vendor, /img, /favicon.
│   ├── css/                   # tokens.css, layout.css, viewer.css, components.css, pages.css
│   ├── vendor/                # xterm, diff2html, sortable, highlight.js
│   ├── img/                   # claude.png, codex.png
│   └── favicon.svg / favicon.png
│
├── shared/                     # contracts shared across processes (plain JS, no deps)
│   ├── routes.mjs              # HTTP route paths + param builders — no magic strings
│   ├── constants.mjs           # shared enums (PR_CATEGORY, PR_GROUP…)
│   └── channels.js             # IPC channel name constants — no magic strings (Node-only)
│
tests/                          # node:test suite (was test/)
```

---

## Layer responsibilities

### Renderer (`src/renderer`)
**Does:** render UI from state, manage UI-only state, handle user interactions, routing.
**Never:** touch the filesystem, the DB, or Electron APIs; never embed `gh`/`acli`/`git`
logic or compute server-side concerns. Views present what the API returns.

- Data lives in exactly two places: the server (reached **only** through
  `services/api.js`) and `stores/store.js` (the single mutable `state` + pure lookups).
- `pages/*` fetch via `api.js`, cache shared data in the store, and render HTML strings
  into their page container. Module-local vars are fine for view-only concerns (filters,
  render-cache keys) — never for data another module needs.
- `components/*` are reusable render helpers with no page ownership.
- `app.js` owns navigation (`showPage`), SSE refresh (`refreshActivePage`), and the
  `window` bridge for inline `on*` handlers.

### Preload (`src/preload`)
**Does:** expose a small, named, validated `window.taskhub.*` surface via `contextBridge`;
forward calls to the host over IPC channels named in `shared/channels.js`.
**Never:** contain business logic, touch DBs, or expose `ipcRenderer` directly.

### Electron host (`src/main`)
**Does:** window management, tray, native + app menus, auto-update, native dialogs,
notifications, and the native IPC handlers. Supervises (forks/restarts) the server.
**Never:** contain UI markup; never embed renderer logic. IPC handlers stay thin —
parse, validate, delegate to a `native/` helper, return.

### Server — services (`src/server/services`)
**Does:** business logic, orchestration, workflows, domain rules. The poller and
webhook-forwarder loops live here; `sync.js` orchestrates a snapshot by calling
repositories and writing the database.
**Never:** know about HTTP, Express `req`/`res`, or the CLI's argv shape — it asks
repositories for data and applies rules.

### Server — repositories (`src/server/repositories`)
**Does:** data access only — spawn `gh`/`acli`/`git`, call external APIs, read/write
through the database layer. One repository per source (`github.js`, `jira.js`, …).
**Never:** contain business rules. A repository returns data; it does not decide policy.

### Server — database (`src/server/database`)
**Does:** snapshot persistence (the snapshot DBs), config/log stores, and data-dir
resolution (`datadir.js`, honoring `TASKHUB_DATA_DIR`).
**Never:** orchestrate or apply domain rules.

### Server — routes (`src/server/routes`)
**Does:** the transport boundary — the HTTP equivalent of `ipcMain.handle`. Parse the
request, validate input, call **one** service, serialize the result. Route *paths* come
from `shared/routes.mjs`.
**Never:** contain business logic. A route is glue, like a thin IPC handler.

### Shared (`src/shared`)
Plain-JS contracts imported by more than one process: HTTP route paths, IPC channel
constants, and shared enums. No runtime dependencies; safe to import anywhere.

**Module format — the no-bundler bridge.** The server is CommonJS; the renderer is browser
ES modules. With no bundler, one file can't natively be both, so the rule is:

- A contract the **renderer** imports is authored as **ESM** (`.mjs`) — the browser requires
  ESM. Node consumers `require()` it (supported on Node ≥22.12; we're on 26). So far:
  `routes.mjs`, `constants.mjs`.
- A contract used **only** by Node processes (the renderer never sees it) stays **CommonJS**
  (`.js`): `channels.js` — the renderer reaches the host via `window.taskhub.*`, never raw
  channels, so it never imports it.

**Serving the contract to the renderer.** `src/shared` can't be reached by a relative import
from the page (it's outside the web root). The server exposes it at **`/shared`**
(`app.use('/shared', express.static('src/shared'))`), so the renderer imports
`/shared/routes.mjs` / `/shared/constants.mjs` by absolute URL. That URL is intentionally
decoupled from disk layout, so it stays valid no matter where the renderer's files move.

---

## Two transports — which to use

| Use **HTTP** (`api.js` → `routes/` → `services/`) | Use **IPC** (`window.taskhub.*` → `main/ipc/`) |
|---|---|
| Anything data: PRs, Jira, logs, projects, config | PTY terminals (bidirectional stream) |
| Anything the poller/webhooks produce | Native dialogs (folder picker) |
| Anything a browser should be able to see | `shell.openPath`, native theme, sound preview |
| Request/response or server-pushed (SSE) | Avatar/usage that must run in the host process |

**Rule of thumb:** *data and CLI orchestration → HTTP; native, streaming, or
main-process-only → IPC.* If a feature could ever make sense in a plain browser, it
belongs behind HTTP.

No magic strings on either transport:
- HTTP paths: `shared/routes.mjs` (e.g. `ROUTES.DASHBOARD = '/api/dashboard'`, and
  builders for parameterized routes: `ROUTES.jiraKey(key)`).
- IPC channels: `shared/channels.js` (e.g. `CH.TERM_CREATE = 'term:create'`).

---

## Dependency flow (one direction only)

```
renderer  ──HTTP──▶  server/routes  ──▶  server/services  ──▶  server/repositories  ──▶  CLI / DB / FS
renderer  ──IPC───▶  preload  ──▶  main/ipc  ──▶  main/native  ──▶  OS

shared/*  is imported by any layer; it imports nothing from them.
```

- The renderer never imports from `server/` or `main/`, and vice-versa — they are
  separate processes. The only renderer→server link is `api.js` over HTTP; the only
  renderer→host link is `window.taskhub.*` over the preload bridge.
- `routes` may import `services`; `services` may import `repositories`; `repositories`
  may import `database`. Never the reverse. A repository must not import a service.
- `shared/` sits to the side: everything may import it; it imports nothing.

---

## Security baseline (unchanged, non-negotiable)

`BrowserWindow` `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, `preload` set. Never expose `ipcRenderer` to the renderer; expose a
named, minimal `window.taskhub.*` surface and validate every IPC input in the handler.
The server listens on `127.0.0.1` only.

---

## What this is NOT

- Not TypeScript, not React/Zustand, not a bundler. The discipline is the point; the
  stack stays vanilla and build-free.
- Not "everything through IPC." HTTP is primary because the backend is a CLI server that
  must stay browser-accessible and crash-isolated.
- Not a rewrite of behavior. The migration (see `MIGRATION-PLAN.md`) is a **structural
  move + renaming of layers**, not a change to how any feature works.

---

## Architecture summary

The generic Clean-Architecture summary, mapped to TaskHub's reality (it differs in two
deliberate ways — the backend is a **forked HTTP server**, not the main process, and the
primary transport is **HTTP**, not IPC):

| Layer | Path | Responsibility |
|-------|------|----------------|
| **Renderer** | `src/renderer` | UI only — render state, handle interaction. Never touches the OS. |
| **Preload** | `src/preload` | Secure bridge only — exposes a thin, named `window.taskhub.*`. No logic. |
| **Main (host)** | `src/main` | Desktop shell — windows, tray, menus, updater, native IPC. Supervises the server. |
| **Server (backend)** | `src/server` | The forked CLI backend. Hosts the layers below + the HTTP/SSE API. |
| **Services** | `src/server/services` | Business logic — orchestration, workflows, the poller/webhook loops. |
| **Repositories** | `src/server/repositories` | Data access only — `gh`/`acli` CLI + external APIs. No business rules. |
| **Database** | `src/server/database` | Snapshot persistence + data-dir resolution. |
| **Shared** | `src/shared` | Contracts — route paths, IPC channels, enums (plain JS; `.mjs` cross-boundary, `.js` Node-only). |

**The one rule that differs from the generic doc:** the renderer never talks directly to
the operating system. **Data and CLI orchestration flow over HTTP** (`api.js` → `routes` →
`services` → `repositories` → CLI) into the forked **server**; **native, streaming, and
main-process-only** concerns flow over **typed IPC contracts** (`window.taskhub.*` →
`main/ipc`) into the **host**. Generic Clean Architecture routes everything through IPC into
main because it assumes a DB-backed app; TaskHub is CLI+polling, so the server earns its own
process (crash isolation, browser-accessible, owns the background loops).

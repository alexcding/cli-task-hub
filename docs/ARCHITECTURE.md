# TaskHub Architecture

This document describes the **target** layered architecture for TaskHub. It adapts the
Clean-Architecture pattern (layers, services, repositories, shared contracts, one-way
dependency flow, a hard transport boundary) to TaskHub's actual reality:

- **No framework, no bundler.** The renderer is vanilla ES modules — by choice.
- **The backend is CLI orchestration**, not a DB server. The heavy lifting is shelling
  out to `gh`, `acli` (Jira), `git`, and `rtk` and snapshotting the results.
- **The desktop shell is Tauri (Rust), not Electron.** The native window, tray, menus,
  terminals, and embedded viewer live in `src-tauri/` (Rust). See `docs/TAURI-PORT.md`
  for how the shell is wired.
- **The transport is HTTP, not IPC.** The renderer is served from a local Express server
  and talks to it over `fetch` + SSE. A small native surface remains for the things HTTP
  can't do (PTYs, native dialogs, theme) — exposed as `window.taskhub.*` and routed to
  Rust commands; see *Two transports* below.

The generic pattern assumes React + TypeScript + "everything through typed IPC." We keep
its **discipline** and drop its **stack**: the layering, the service/repository split,
the shared contracts, and the strict dependency direction all apply; the framework, the
build step, and the IPC-only transport do not.

---

## The three processes

TaskHub is not a single process with one backend. It runs three:

```
┌─────────────────────┐ spawn┌──────────────────────┐      ┌─────────────────────────┐
│  Tauri host (Rust)   │ sidecar  Server (backend)   │ CLI  │  gh / acli / git / rtk   │
│  src-tauri/          │─────▶│  Express + Node       │─────▶│  OS / filesystem         │
│  window, tray,       │      │  poller, webhooks,    │      │                          │
│  menus, terminals,   │      │  snapshot DBs         │      └─────────────────────────┘
│  embedded viewer     │      └──────────┬───────────┘
└──────────┬───────────┘                 │ HTTP (fetch) + SSE
           │ bridge.js init script        │
           │ (window.taskhub.* → invoke)  ▼
           ▼                    ┌──────────────────────┐
   ┌──────────────────┐  load  │  Renderer (vanilla)   │
   │  Tauri window +   │◀───────│  pages, stores,       │
   │  child WKWebviews │  :3000 │  services, components │
   └──────────────────┘        └──────────────────────┘
```

1. **Tauri host (Rust, `src-tauri/`)** — the desktop shell. Owns the window, the tray, the
   app/native menus, terminals (PTYs), the embedded PR/Jira viewer (child WKWebviews), and
   notifications. In packaged builds it also *launches* the backend as a **Node sidecar** and
   waits for it before loading the window.
2. **Server (backend, Node sidecar / standalone)** — the CLI-orchestration backend. Owns the
   poller, the webhook forwarder, the snapshot databases, and all `gh`/`acli`/`git` access.
   Exposes everything over an HTTP API + an SSE stream. **This is where the doc's
   "services / repositories / database" layers physically live.** It runs as a separate
   process so a hung CLI call can't freeze the UI, and so it can run **standalone**
   (`node src/server/app.js`) and be reached from a plain **browser** with no desktop shell.
3. **Renderer** — the vanilla-ESM web UI, served over HTTP and loaded into the Tauri window
   (and any plain browser) at `http://localhost:3000`. Pure function of state; never touches the OS.

> **Why a server and not IPC?** The CLI backend is the *reason* to keep it. A separate
> process gives crash/hang isolation, lets the poller + webhook loops own the snapshot DB,
> and keeps the app browser-accessible. Collapsing it into Rust commands would run CLI
> spawns inside the host (or re-spawn a child anyway) and lose browser/standalone mode for
> nothing. So HTTP is the **primary** transport; the `window.taskhub.*` native surface is the
> exception, not the rule. (Because the renderer loads from a *remote* origin — localhost,
> not a `tauri://` bundle — that surface is granted via a capability allowlist; see Security.)

---

## Target folder structure

```
src-tauri/                      # Tauri host (Rust) — the desktop shell
├── src/
│   ├── main.rs                 # binary entry (calls lib.rs run())
│   ├── lib.rs                  # builds the window in Rust, spawns the Node sidecar (release),
│   │                           #   wires tray + plugins; the app-lifecycle owner
│   ├── commands.rs             # the window.taskhub.* commands (theme/dialog/open/usage/avatar)
│   ├── terminals.rs            # PTYs via portable-pty (term_create/write/resize/kill/list/attach)
│   ├── tray.rs                 # tray menu model + refresh (PR rows, usage panel, open tabs)
│   ├── menu.rs                 # native application menu + accelerators
│   ├── webview_menu.rs         # curated right-click menu for the embedded webview (objc2)
│   ├── viewer.rs               # WKWebView title/URL/nav-state poll → wcv://event
│   ├── notify.rs               # review + activity notifications (+ SSE client)
│   ├── usage_image.rs          # Claude/Codex token panel rendered as a tray menu image
│   └── avatars.rs              # author-avatar cache for tray rows
├── bridge.js                   # preload-equivalent init script: defines window.taskhub.* over
│                               #   Tauri invoke()/events (no contextBridge — it's a remote origin)
├── capabilities/               # remote.json allow-lists the localhost origin for the commands
├── tauri.conf.json             # window, beforeDev/BuildCommand, sidecar (externalBin), bundle
└── binaries/                   # the official Node sidecar (taskhub-node-<triple>; gitignored)

src/
├── server/                     # Backend (Node sidecar / standalone) — the service+repo+db layers
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
**Never:** touch the filesystem, the DB, or native APIs directly; never embed `gh`/`acli`/`git`
logic or compute server-side concerns. Views present what the API returns.

- Data lives in exactly two places: the server (reached **only** through
  `services/api.js`) and `stores/store.js` (the single mutable `state` + pure lookups).
- `pages/*` fetch via `api.js`, cache shared data in the store, and render HTML strings
  into their page container. Module-local vars are fine for view-only concerns (filters,
  render-cache keys) — never for data another module needs.
- `components/*` are reusable render helpers with no page ownership.
- `app.js` owns navigation (`showPage`), SSE refresh (`refreshActivePage`), and the
  `window` bridge for inline `on*` handlers.

### Tauri host bridge (`src-tauri/bridge.js`)
**Does:** define a small, named `window.taskhub.*` surface as a window init script, forwarding
each call to a Rust command via Tauri `invoke()` (and fanning `invoke`/event streams back, e.g.
terminal output). It's the preload-equivalent — but because the renderer loads from a *remote*
origin (localhost), there's no `contextBridge`; the surface is plain `invoke` against
commands allow-listed in `capabilities/`.
**Never:** contain business logic or touch DBs.

### Tauri host (`src-tauri/src`, Rust)
**Does:** window management, tray, native + app menus, auto-update, native dialogs, terminals
(PTYs), the embedded PR/Jira viewer, and notifications. In packaged builds it launches and
waits on the backend Node sidecar.
**Never:** contain UI markup; never embed renderer logic. Commands stay thin — parse, do the
native work, return.

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

| Use **HTTP** (`api.js` → `routes/` → `services/`) | Use **`window.taskhub.*`** (`bridge.js` → `invoke` → `src-tauri` commands) |
|---|---|
| Anything data: PRs, Jira, logs, projects, config | PTY terminals (bidirectional stream) |
| Anything the poller/webhooks produce | Native dialogs (folder picker) |
| Anything a browser should be able to see | open path/URL, native theme, sound preview |
| Request/response or server-pushed (SSE) | Avatar/usage that must run in the host process |

**Rule of thumb:** *data and CLI orchestration → HTTP; native, streaming, or
host-process-only → `window.taskhub.*`.* If a feature could ever make sense in a plain
browser, it belongs behind HTTP.

No magic strings on the HTTP transport: paths come from `shared/routes.mjs` (e.g.
`ROUTES.DASHBOARD = '/api/dashboard'`, and builders for parameterized routes:
`ROUTES.jiraKey(key)`). The `window.taskhub.*` surface degrades gracefully — every method is
optional-chained at the call site, so the renderer still runs in a plain browser where it's absent.

---

## Dependency flow (one direction only)

```
renderer  ──HTTP───────▶  server/routes  ──▶  server/services  ──▶  server/repositories  ──▶  CLI / DB / FS
renderer  ──taskhub.*──▶  bridge.js  ──invoke──▶  src-tauri commands  ──▶  OS

shared/*  is imported by any layer; it imports nothing from them.
```

- The renderer never imports from `server/` or the Rust host, and vice-versa — they are
  separate processes. The only renderer→server link is `api.js` over HTTP; the only
  renderer→host link is `window.taskhub.*` (`bridge.js` → Tauri `invoke`).
- `routes` may import `services`; `services` may import `repositories`; `repositories`
  may import `database`. Never the reverse. A repository must not import a service.
- `shared/` sits to the side: everything may import it; it imports nothing.

---

## Security baseline (non-negotiable)

The renderer is served from `127.0.0.1` only and loaded as a **remote origin** in the Tauri
window. Tauri denies IPC to remote origins by default; the `window.taskhub.*` surface is granted
explicitly by `capabilities/remote.json`, which allow-lists the localhost origin for exactly the
commands the app needs — every new `window.taskhub.*` that calls a core command needs its explicit
`allow-*` permission there (see `docs/TAURI-PORT.md`). Expose a named, minimal surface; validate
every command input in Rust. No `nodeIntegration`-style escape hatch exists — the renderer can
only reach the host through the allow-listed commands.

---

## What this is NOT

- Not TypeScript, not React/Zustand, not a bundler. The discipline is the point; the
  stack stays vanilla and build-free.
- Not "everything through IPC." HTTP is primary because the backend is a CLI server that
  must stay browser-accessible and crash-isolated; the `window.taskhub.*` surface is only for
  native/streaming/host-only work.
- Not a rewrite of behavior. The Tauri port (see `docs/TAURI-PORT.md`) replaced only the host
  shell — the server and renderer are unchanged because the transport was already HTTP, not IPC.

---

## Architecture summary

The generic Clean-Architecture summary, mapped to TaskHub's reality (it differs in two
deliberate ways — the backend is a **standalone HTTP server**, not the host process, and the
primary transport is **HTTP**, not IPC):

| Layer | Path | Responsibility |
|-------|------|----------------|
| **Renderer** | `src/renderer` | UI only — render state, handle interaction. Never touches the OS. |
| **Host bridge** | `src-tauri/bridge.js` | Secure bridge only — exposes a thin, named `window.taskhub.*` over `invoke`. No logic. |
| **Tauri host** | `src-tauri/src` | Desktop shell (Rust) — window, tray, menus, updater, terminals, embedded viewer. Launches the server sidecar. |
| **Server (backend)** | `src/server` | The CLI backend (Node sidecar / standalone). Hosts the layers below + the HTTP/SSE API. |
| **Services** | `src/server/services` | Business logic — orchestration, workflows, the poller/webhook loops. |
| **Repositories** | `src/server/repositories` | Data access only — `gh`/`acli` CLI + external APIs. No business rules. |
| **Database** | `src/server/database` | Snapshot persistence + data-dir resolution. |
| **Shared** | `src/shared` | Contracts — route paths + enums (plain JS; `.mjs` cross-boundary, served at `/shared`). |

**The one rule that differs from the generic doc:** the renderer never talks directly to
the operating system. **Data and CLI orchestration flow over HTTP** (`api.js` → `routes` →
`services` → `repositories` → CLI) into the standalone **server**; **native, streaming, and
host-process-only** concerns flow over the **`window.taskhub.*` surface** (`bridge.js` →
`invoke` → `src-tauri` commands) into the **Tauri host**. Generic Clean Architecture routes
everything through IPC into the host process because it assumes a DB-backed app; TaskHub is
CLI+polling, so the server earns its own process (crash isolation, browser-accessible, owns
the background loops).

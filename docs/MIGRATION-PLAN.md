# Migration Plan — restructure to the layered `src/` tree

Target architecture: see `ARCHITECTURE.md`. This is the **big-bang `src/` move**, executed
as ordered phases so the repo boots and `npm test` passes between each one. Plain JS
throughout, vanilla renderer kept — this is a **structural move + layer renaming**, not a
behavior change or a rewrite.

> **Branch first.** This touches nearly every import path. Do it on a dedicated branch
> (`refactor/src-layout`), one phase per commit, with `npm test` + a manual app boot green
> before each commit. `git mv` every file so history follows.

---

## 0. Ground rules

- **One phase = one commit**, and each commit leaves the app bootable (`./dev.sh --app`)
  and `npm test` green.
- Use `git mv`, never delete+create — preserves blame across the move.
- Keep the renderer's **static root** at `src/renderer/`, so browser URLs change only by
  sub-path (e.g. `/js/store.js` → `/stores/store.js`), never by host.
- After each move, fix imports with search-and-replace, then **run tests**. Do not batch
  multiple phases before testing.

---

## 1. File-by-file move map

### Electron host → `src/main/`
| From | To |
|---|---|
| `tray.js` | `src/main/app/main.js`  *(also the new `package.json` "main")* |
| `main/const.js` | `src/main/app/const.js` |
| `main/window.js` | `src/main/windows/window.js` |
| `main/menu.js` | `src/main/tray/menu.js` |
| `main/app-menu.js` | `src/main/menu/app-menu.js` |
| `main/updater.js` | `src/main/updater/updater.js` |
| `main/server-supervisor.js` | `src/main/server/supervisor.js` |
| `main/terminals.js` | `src/main/ipc/terminals.js` |
| `main/icons.js` | `src/main/native/icons.js` |
| `main/notifications.js` | `src/main/native/notifications.js` |
| `main/usage.js` | `src/main/native/usage.js` |
| `main/usage-image.js` | `src/main/native/usage-image.js` |
| `preload.js` | `src/preload/index.js` |

> The IPC handlers currently inline in `main/window.js` (`avatar:fetch`, `usage:get`,
> `choose-folder`, `open-path`, `set-native-theme`, `close-window`, `sound:preview`) may be
> extracted into `src/main/ipc/system.js` in **Phase 6** (optional polish). The base move
> keeps them in `window.js`.

### CLI backend → `src/server/`
| From | To |
|---|---|
| `server.js` | `src/server/app.js` |
| `lib/poller.js` | `src/server/services/poller.js` |
| `lib/webhook-forwarder.js` | `src/server/services/webhook-forwarder.js` |
| `lib/github.js` | `src/server/repositories/github.js` |
| `lib/jira.js` | `src/server/repositories/jira.js` |
| `lib/usage.js` | `src/server/repositories/usage.js` |
| `lib/db.js` | `src/server/database/db.js` |
| `lib/datadb.js` | `src/server/database/datadb.js` |
| `lib/configdb.js` | `src/server/database/configdb.js` |
| `lib/logdb.js` | `src/server/database/logdb.js` |
| `lib/datadir.js` | `src/server/database/datadir.js` |
| `lib/logger.js` | `src/server/logger.js` |

> Splitting `server.js`'s route handlers into `src/server/routes/*` and extracting
> `services/sync.js` is **Phase 5** (recommended but separable). The base move lands
> `server.js` whole as `app.js`.

### Renderer → `src/renderer/`
| From | To |
|---|---|
| `public/index.html` | `src/renderer/index.html` |
| `public/js/app.js` | `src/renderer/app.js` |
| `public/js/store.js` | `src/renderer/stores/store.js` |
| `public/js/api.js` | `src/renderer/services/api.js` |
| `public/js/theme.js` | `src/renderer/services/theme.js` |
| `public/js/fonts.js` | `src/renderer/services/fonts.js` |
| `public/js/views/dashboard.js` | `src/renderer/pages/dashboard.js` |
| `public/js/views/jira.js` | `src/renderer/pages/jira.js` |
| `public/js/views/logs.js` | `src/renderer/pages/logs.js` |
| `public/js/views/settings.js` | `src/renderer/pages/settings.js` |
| `public/js/views/project.js` | `src/renderer/pages/project.js` |
| `public/js/views/git-tab.js` | `src/renderer/pages/git-tab.js` |
| `public/js/views/cards.js` | `src/renderer/components/cards.js` |
| `public/js/views/modal.js` | `src/renderer/components/modal.js` |
| `public/js/views/usage-widget.js` | `src/renderer/components/usage-widget.js` |
| `public/js/views/git.js` | `src/renderer/components/git.js` |
| `public/js/sidebar.js` | `src/renderer/components/sidebar.js` |
| `public/js/viewer.js` | `src/renderer/components/viewer.js` |
| `public/js/split.js` | `src/renderer/components/split.js` |
| `public/js/terminal.js` | `src/renderer/components/terminal.js` |
| `public/js/commit.js` | `src/renderer/components/commit.js` |
| `public/js/diff.js` | `src/renderer/components/diff.js` |
| `public/js/menu.js` | `src/renderer/components/menu.js` |
| `public/js/toast.js` | `src/renderer/components/toast.js` |
| `public/js/util.js` | `src/renderer/lib/util.js` |
| `public/js/icons.js` | `src/renderer/lib/icons.js` |
| `public/js/diff-parse.mjs` | `src/renderer/lib/diff-parse.mjs` |
| `public/js/git-graph.mjs` | `src/renderer/lib/git-graph.mjs` |
| `public/css/*` | `src/renderer/assets/css/*` |
| `public/img/*`, `public/vendor/*`, `public/favicon.*` | `src/renderer/assets/*` |

### New shared contracts → `src/shared/`
| New file | Contents |
|---|---|
| `src/shared/routes.js` | `ROUTES` — every `/api/...` path string, used by `api.js` + `routes/` |
| `src/shared/channels.js` | `CH` — every IPC channel (`term:*`, `avatar:fetch`, `usage:get`, `choose-folder`, `open-path`, `set-native-theme`, `close-window`, `sound:preview`, `tray:refresh`) |
| `src/shared/constants.js` | shared enums: PR categories, `prGroup` semantics, log categories |

### Tests → `tests/`
| From | To |
|---|---|
| `test/*.test.js` | `tests/*.test.js` |

---

## 2. Path-break inventory (every hard-coded path that must change)

These are the references that will silently break if missed. Each is verified present in
the current tree.

1. **`package.json`**
   - `"main": "tray.js"` → `"src/main/app/main.js"`
   - `"start": "node server.js"` → `"node src/server/app.js"`
   - `"dev:server": "node --watch server.js"` → `"node --watch src/server/app.js"`
   - `"test"` glob `'test/**/*.test.js'` → `'tests/**/*.test.js'`
   - `build`/`gen-icon` call `scripts/*.js` — unaffected (scripts/ stays at root).

2. **`src/main/server/supervisor.js`** (was `main/server-supervisor.js`)
   - `fork(path.join(__dirname, '..', 'server.js'))` → path to `src/server/app.js`
     (from `src/main/server/` that is `path.join(__dirname, '..', '..', 'server', 'app.js')`).

3. **`src/main/windows/window.js`** (was `main/window.js`)
   - preload path `path.join(__dirname, '..', 'preload.js')` → `src/preload/index.js`
     (from `src/main/windows/` → `path.join(__dirname, '..', '..', 'preload', 'index.js')`).

4. **`src/server/app.js`** (was `server.js`)
   - `express.static(path.join(__dirname, 'public'))` → `path.join(__dirname, '..', 'renderer')`.
   - dev live-reload `fs.watch(path.join(__dirname, 'public'))` → same renderer path.
   - `__dirname.includes('app.asar')` packaged-check still works (asar path unchanged).

5. **`src/main/app/main.js`** (was `tray.js`)
   - `app.dock.setIcon(path.join(__dirname, 'build', 'icon.png'))` → repo `build/` is now
     up two levels: `path.join(__dirname, '..', '..', '..', 'build', 'icon.png')`.

6. **`src/main/native/icons.js`** (was `main/icons.js`)
   - `path.join(__dirname, '..', 'build')` → adjust depth to reach repo-root `build/`
     (`path.join(__dirname, '..', '..', '..', 'build')`).

7. **`src/server/database/datadir.js`** (was `lib/datadir.js`) — **highest-risk**
   - returns `path.join(__dirname, '..')` as the non-packaged base (governs where data /
     the dev store resolves when `TASKHUB_DATA_DIR` is unset). Moving it deeper changes
     `..`. Re-anchor it to still resolve **repo root** (now `__dirname` + `'../../..'`),
     or better: resolve from a stable anchor (e.g. `app.getPath`/`process.cwd()` rule it
     already uses) so depth no longer matters. **Verify the resolved data dir is byte-identical before/after** — a wrong base silently points at an empty store.

8. **`electron-builder.config.js`** — `files` whitelist:
   `['tray.js','preload.js','server.js','main/**','lib/**','public/**', …]` →
   `['src/**', …]` (keep the `!**/*.md`, `!**/*.map`, `node_modules` entries).
   `afterPack: 'scripts/afterPack.js'`, `extraResources` from `build/`, and `mac.icon:
   'build/icon.icns'` are unaffected (root `build/` and `scripts/` stay).

9. **`scripts/afterPack.js`, `scripts/build.js`, `scripts/gen-icon.js`** — grep for any
   reference to `tray.js`, `server.js`, `public/`, `main/`, `lib/` and repoint. (Most
   reference `build/`, which is unchanged.)

10. **`dev.sh`** — references `server.js` indirectly via `npm`/`PORT`; confirm any direct
    path to `server.js` or `public/` is updated. The data-dir block reads
    `TASKHUB_DATA_DIR` only — unaffected.

11. **`tests/*.test.js`**
    - `api.test.js` boots the real server: `require('../server.js')` → `require('../src/server/app.js')`.
    - `diff-parse.test.js`, `git-graph.test.js` import `../public/js/*.mjs` →
      `../src/renderer/lib/*.mjs`.
    - `review-category.test.js` — repoint whatever it imports.

12. **Renderer module specifiers** (the bulk of the churn) — every `import` in
    `src/renderer/**` and every `<link>`/`<script type="module">` in `index.html`:
    - `./store.js` → `./stores/store.js`; `./api.js` → `./services/api.js`;
      `./views/x.js` → `./pages/x.js` or `./components/x.js`; `./util.js` →
      `./lib/util.js`; etc.
    - `index.html`: `/js/app.js` → `/app.js`; `/css/*.css` → `/assets/css/*.css`;
      any `/img`, `/vendor`, `/favicon.*` → `/assets/...`.
    - The dynamic page loaders in `app.js` (`showPage`) and the `Object.assign(window,…)`
      bridge must use the new specifiers.

13. **`CLAUDE.md` / `AGENTS.md` / `README.md`** — update every path reference
    (`public/js/...`, `main/...`, `lib/...`, `server.js`) and the renderer-pattern section
    to describe `src/renderer/{pages,components,stores,services,lib}` and the
    server/host split. (CLAUDE.md's "entire stylesheet lives in index.html" line is
    already stale post-CSS-split — fix it here too.)

---

## 3. Phased execution

Each phase is one commit; run `npm test` + `./dev.sh --app` before committing.

**Phase 1 — `src/shared/` contracts (additive, no moves).**
Create `routes.js`, `channels.js`, `constants.js`. Wire `api.js` and the server routes to
import `ROUTES`; wire preload + `main/ipc` to import `CH`. *Pure win, zero move risk —
proves the shared layer before the big shuffle.* Tests green.

**Phase 2 — move the server (`lib/` + `server.js` → `src/server/`).**
`git mv` into `services/`, `repositories/`, `database/`. Fix intra-server requires, the
`datadir.js` anchor (#7), and `api.test.js`'s `require`. Update `package.json` `start` /
`dev:server` and the supervisor fork path (#2). The server still serves `public/` for now
(only the static path in #4 changes once the renderer moves). Tests green; `node
src/server/app.js` boots standalone.

**Phase 3 — move the Electron host (`main/` + `tray.js` + `preload.js` → `src/main`,
`src/preload`).**
`git mv` into the host sub-tree. Fix `package.json` "main" (#1), the preload path (#3),
dock/icon paths (#5, #6). App boots via `./dev.sh --app`.

**Phase 4 — move the renderer (`public/` → `src/renderer`).**
`git mv` files per the map; rewrite every import specifier and `index.html` asset href
(#12); flip the server's static root + watch path (#4). App boots in browser **and** in
Electron; navigation + SSE refresh work.

**Phase 5 — (recommended) split `server/app.js` into `routes/` + `services/sync.js`.**
Carve the Express handlers out of `app.js` into `routes/*` (thin: request → service →
JSON) and lift orchestration into `services/sync.js`. Enforces the service/repository/
route boundary the doc is about. Separable from the move; do it once the tree is stable.

**Phase 6 — (optional polish) extract `main/ipc/system.js`.**
Pull the inline IPC handlers out of `window.js` into `ipc/system.js`, all channels via
`CH`. Update the builder `files` whitelist (#8), scripts (#9), `dev.sh` (#10), and the
docs (#13).

**Phase 7 — docs + final sweep.**
Land `ARCHITECTURE.md` references everywhere, update `CLAUDE.md`/`AGENTS.md`/`README.md`,
and do a repo-wide grep for stale `public/`, `lib/`, `main/`, `server.js`, `tray.js`
strings (comments included).

---

## 4. Verification checklist (run at every phase, hard gate on the last)

- [ ] `npm test` — all suites pass (incl. `api.test.js` booting the real server).
- [ ] `node src/server/app.js` boots standalone; dashboard loads in a **plain browser**.
- [ ] `./dev.sh --app` launches Electron; window, tray, and menus work.
- [ ] Open a PR (embedded webview), open a **terminal** (IPC PTY), view a **diff**, commit.
- [ ] Jira tab loads/transitions a ticket; Activity page streams; SSE refresh updates the
      active page on a sync event.
- [ ] **Data dir unchanged** — the app reads your existing projects/config, not an empty
      store (guards against the `datadir.js` anchor regression, #7).
- [ ] `npm run build` produces a working `.app` (validates the builder `files` whitelist).
- [ ] Repo-wide grep finds no stale `public/`, `lib/`, `main/`, `server.js`, `tray.js`
      path references outside `docs/` history.

---

## 5. Risk register

| Risk | Why | Mitigation |
|---|---|---|
| `datadir.js` resolves a different base after the move | depth-based `__dirname/'..'` | Re-anchor to repo root or a stable path; verify resolved dir byte-for-byte (#7). |
| Renderer 404s on moved assets/modules | dozens of specifier + href changes | Keep static root = `src/renderer`; change sub-paths only; boot in browser before Electron. |
| Packaged app missing files | builder `files` switched to `src/**` | `npm run build` + launch the `.app` in Phase 6/7, not just dev. |
| Supervisor can't find the server | fork path depth changed | Fix #2 in Phase 2; assert the child boots in the host log. |
| Preload fails to load → no `window.taskhub` | preload path depth changed | Fix #3 in Phase 3; assert folder picker / terminals work. |
| Big diff buries a behavior change | huge move | One phase per commit, tests green between; no logic edits inside a move commit. |

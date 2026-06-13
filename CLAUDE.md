# CLAUDE.md — TaskHub

Read `AGENTS.md` first (backend model, run/iterate, conventions, gotchas),
`docs/ARCHITECTURE.md` for the layered `src/` design (host / preload / server /
renderer / shared + the HTTP-vs-IPC transport split), and `README.md` for the full
picture. This file documents the **renderer architecture**, which they cover only briefly.

The renderer lives in `src/renderer/`: `app.js` (bootstrap/router) + `pages/`,
`components/`, `stores/`, `services/`, `lib/`, with `index.html` + `css/*` at the web root.

## Renderer pattern: views and data are separated

The web UI is vanilla ES modules — no framework, no bundler, by choice. The
separation everything follows:

**Data lives in two places only:**
- The server (snapshot DB; see AGENTS.md). The renderer reaches it exclusively
  through `src/renderer/services/api.js` (`api()` / `apiJson()`) — never raw `fetch`.
  Route paths come from the shared contract (`/shared/routes.mjs` → `ROUTES`), not literals.
- `src/renderer/stores/store.js` — the single mutable renderer `state` plus pure lookups
  over it (`prByUrl`, `jiraByKey`, `projectByRepo`, …). No other module holds
  long-lived data.

**Views are functions of that state:**
- `src/renderer/pages/*.js` — one module per page (`dashboard.js`, `jira.js`, `logs.js`,
  `settings.js`, `project.js`, `git-tab.js`). A page's `loadX()` fetches via `api.js`,
  caches anything shared in `state`, and renders HTML strings into its page container.
  Module-local variables are fine for view-only concerns (filters, render-cache keys) —
  not for data other modules need.
- `src/renderer/components/*.js` — reusable render helpers with no page ownership
  (`cards.js`, `modal.js`, `usage-widget.js`, `sidebar.js`, `viewer.js`, `git.js`, …).
- Views never call `gh`/`acli`-shaped logic or compute server-side concerns;
  they present what the API returns.

**Wiring lives in `src/renderer/app.js`:**
- `showPage(name)` — navigation. A page = `div#page-<name>` in `src/renderer/index.html` +
  a `.nav-btn[data-page=<name>]` + a branch in `showPage` that sets the title
  and calls the view's loader.
- SSE refresh — `refreshActivePage()` re-runs the active page's loader on
  server `sync` events; new pages that show live data need a branch there.
- Window bridge — every function referenced from inline `on*` markup must be
  registered in the `Object.assign(window, {...})` block (ES modules aren't
  globals). Keep it auditable; remove entries when handlers go away.

**Markup and style:**
- Static page markup lives in `src/renderer/index.html`.
- The stylesheet is split by concern into `src/renderer/css/{tokens,layout,viewer,components,pages}.css`,
  linked in that order (concatenation = cascade order — keep it). CSS custom-property
  tokens drive everything; the dark theme is a pure palette swap — never per-widget colors.
- `css/`, `vendor/`, `img/`, and the favicons sit at the renderer web root (not under a
  subfolder) so their absolute URLs (`/css`, `/vendor`, `/img`, `/favicon`) stay stable.

## UI conventions

- Escape everything interpolated into HTML with `esc()` (`lib/util.js`).
- PR links open the embedded viewer: `openPrSplit(url, '#<num>', repo, branch)`.
- **Mine vs Review splits use `store.prGroup(pr)`, never raw `pr.category`.** The dashboard
  "Review Requested" section and the sidebar's GitHub groups must agree, so both route through
  `prGroup` (`'review'` when `awaitingMyReview`, else `'mine'`). A PR I've only commented on is
  `category:'other'` but belongs under Review — grouping on `category` sends it to Mine. Persist
  the *group* on a tab (`prGroup`), not the raw category, so restored tabs land correctly. The
  tray/sound are the exception: they intentionally stay on `category==='review'` (see AGENTS.md).
- Jira keys link via `jiraUrl(key)` with `onclick="jiraClick(event, this.href, key)"`.
- Icons come from `lib/icons.js` (`ICON` for UI strokes, `TAB_ICON` for GitHub/Jira
  brand marks). SVG only — no emoji.
- Project IDs are UUIDs — quote them in inline handlers: `onclick="fn('${id}')"`.
- Design: restrained slate + single accent; flat, native-mac feel.

## Tests

`npm test` (`node --test --test-force-exit 'test/**/*.test.js'`) — API tests boot the
real server (`test/api.test.js`); `test/contracts.test.js` asserts every `ROUTES` path
has a handler and the sandboxed preload stays import-clean; `test/poller.test.js` covers
sync coalescing. Pure renderer logic with no DOM (e.g. `src/renderer/lib/diff-parse.mjs`)
is tested directly. ES modules under `src/renderer/` that tests import must stay DOM-free
or guard their DOM access.

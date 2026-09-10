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
  "Review Requested" section routes through `prGroup` (`'review'` when `awaitingMyReview`, else
  `'mine'`). A PR I've only commented on is `category:'other'` but belongs under Review — grouping
  on `category` sends it to Mine. The tray/sound are the exception: they intentionally stay on
  `category==='review'` (see AGENTS.md).
- **The sidebar is laid out by project → session, and reads ONLY session records.** A session
  (`services/tasks.js → taskSessions()`, one task record per worktree) is the agent running on a
  worktree — live or stopped — keyed by id (its terminal's `pairKey`), titled by its worktree folder,
  linked to its context tab by `url`. The renderer keeps no worktree list and shows no
  worktree UI: git worktrees without a session are invisible here (the project Git tab lists them).
  **Open tabs that are not tasks never sit under a project folder**: every task-less tab — PR, Jira
  issue or plain web page (`kind:'web'`, any URL that isn't a PR) — renders in one "Tabs" group below
  the projects (`openTabsMarkup`); it becomes a session row under its project the moment a task is
  created for it (the terminal pane's New Task CTAs on a PR/Jira tab). Sessions are otherwise created
  only from the sidebar's project "+" (New session dialog) — there is no per-tab task button.
  Hover "+" on a project creates a worktree + session; clicking a folder focuses its project, clicking
  the focused folder again collapses/expands its rows (no disclosure caret). Right-click is the only removal:
  "Remove session" (`deleteTaskSession`, the single path) stops the terminal, forgets the task and
  force-removes the worktree folder, behind `confirmDialog()` (`components/confirm.js`) — never
  native `confirm()`. A session's tab is not closable by any browser-tab path (middle-click, ⌘W, the
  default chip's ×, the native tab menu): `closeTab` refuses task tabs; only `removeTaskRecord` drops
  one via `removeTaskTab`. A tab whose URL is a task renders only as a session row. There is no
  Tasks page, no Tasks group, no worktree row, and no grouping setting.
- **Every session has a CONTEXT tab — one implementation, different UI states.** A session started
  from a PR/Jira/web tab uses that tab as its context; one started from the sidebar's "+" has no page
  of its own and gets a synthetic `session:<taskId>` url (`lib/util.js → sessionUrl`, `hasPage`), so it
  is an ordinary `kind:'web'` viewer tab. Everything downstream — the toolbar (folder chip, Run,
  split toggle), `canSplitTerminal`, the split, the diff view, the extra web/file tabs, the sidebar
  row, `taskUrls()` — therefore has ONE code path; a bare session differs only in having no page
  (no default content-tab chip, and `paintLeft` paints nothing for it). Never add a kind-specific
  branch for it. Creating and reopening a session both go through
  `openInSplit → activateTab → openPrPanel` (`openTaskSession` has no second path), which is also
  the single place an agent is launched or resumed.
- **The right pane is one toggled state: `tab.paneView`.** `'off'` (hidden — the terminal fills the
  panel, `body.split-closed`), `'term'` (the context's page; blank for a bare session,
  `body.pane-blank`) or `'diff'` (the worktree diff, `body.pane-diff`). `applyPrLayout` is the only
  place that turns that state into geometry; `setPaneView` the only mutator (it persists + calls it).
  The toolbar's split toggle (`#split-toggle`, terminal segment, right edge) and ⌥⌘Return flip
  `'off'` ↔ the last shown view. `--pr-split` is the RIGHT pane's width, so `applyPrLayout`'s
  `animate` names the edge that moves: `'pane'` (the toggle — the pane grows out of / collapses into
  the right edge) or `'term'` (a session was just created — the terminal slides in from the left).
  Only a change in the pane's visibility animates; swapping page↔diff inside an open pane does not.
  During a `'pane'` animation `body.pane-resizing` pins the terminal at full width under the pane
  (it never moves or reflows mid-animation); `body.pr-tweening` is on for any boundary tween and
  tells the terminals' ResizeObserver to hold its refit until the boundary lands. A context with no live terminal always shows its page, whatever
  the persisted state says (`rightPaneHidden`).
- **Embedded webviews are pooled.** `tab.wv` / `link.wv` are built lazily on first show and torn
  down when they fall out of the LRU pool (`state.webviewPool`, Settings → System), then rebuilt
  from `tab.cur` / `link.url`. Never cache a `wv` reference; re-read `owner.wv` (may be null) and
  attach listeners inside `buildTabWebview` / `buildLinkWebview` so they survive a rebuild.
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

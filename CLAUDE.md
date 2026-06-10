# CLAUDE.md — TaskHub

Read `AGENTS.md` first (backend model, run/iterate, conventions, gotchas) and
`README.md` for the full picture. This file documents the **renderer architecture**,
which neither covers.

## Renderer pattern: views and data are separated

The web UI is vanilla ES modules — no framework, no bundler, by choice. The
separation everything follows:

**Data lives in two places only:**
- The server (snapshot DB; see AGENTS.md). The renderer reaches it exclusively
  through `public/js/api.js` (`api()` / `apiJson()`) — never raw `fetch`.
- `public/js/store.js` — the single mutable renderer `state` plus pure lookups
  over it (`prByUrl`, `jiraByKey`, `projectByRepo`, …). No other module holds
  long-lived data.

**Views are functions of that state:**
- `public/js/views/*.js` — one module per page/section (`dashboard.js`,
  `jira.js`, `logs.js`, `settings.js`, `project.js`, `cards.js`, `modal.js`).
  A view's `loadX()` fetches via `api.js`, caches anything shared in `state`,
  and renders HTML strings into its page container. Module-local variables are
  fine for view-only concerns (filters, render-cache keys) — not for data other
  modules need.
- Views never call `gh`/`acli`-shaped logic or compute server-side concerns;
  they present what the API returns.

**Wiring lives in `app.js`:**
- `showPage(name)` — navigation. A page = `div#page-<name>` in `index.html` +
  a `.nav-btn[data-page=<name>]` + a branch in `showPage` that sets the title
  and calls the view's loader.
- SSE refresh — `refreshActivePage()` re-runs the active page's loader on
  server `sync` events; new pages that show live data need a branch there.
- Window bridge — every function referenced from inline `on*` markup must be
  registered in the `Object.assign(window, {...})` block (ES modules aren't
  globals). Keep it auditable; remove entries when handlers go away.

**Markup and style live in `index.html`:**
- All static page markup and the entire stylesheet (CSS custom-property tokens;
  dark theme is a pure palette swap — never per-widget colors).

## UI conventions

- Escape everything interpolated into HTML with `esc()` (`util.js`).
- PR links open the embedded viewer: `openPrSplit(url, '#<num>', repo, branch)`.
- Jira keys link via `jiraUrl(key)` with `onclick="jiraClick(event, this.href, key)"`.
- Icons come from `icons.js` (`ICON` for UI strokes, `TAB_ICON` for GitHub/Jira
  brand marks). SVG only — no emoji.
- Project IDs are UUIDs — quote them in inline handlers: `onclick="fn('${id}')"`.
- Design: restrained slate + single accent; flat, native-mac feel.

## Tests

`npm test` (`node --test 'test/**/*.test.js'`) — API tests boot the real
server (`test/api.test.js`);
pure renderer logic with no DOM (e.g. `diff-parse.mjs`) is tested directly.
ES modules under `public/js/` that tests import must stay DOM-free or guard
their DOM access.

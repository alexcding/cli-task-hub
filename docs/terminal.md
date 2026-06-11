# TaskHub Terminal — Design & Plan

Status: **implemented** (slice 5 "Polish" pending — see Implementation slices). This is
the design for embedding interactive terminals in the TaskHub Electron app; it shipped as
`main/terminals.js` (PTYs) + `public/js/terminal.js` (xterm renderer).

## Goal

Multiple **interactive terminals** inside the app, one per **worktree folder**, each:

- a real login shell — same environment as a fresh Terminal.app tab (PATH, nvm,
  Homebrew, aliases, …), started in its worktree folder;
- **readable and writable from code** — the app can type into a terminal and read its
  output stream, per terminal, independently and concurrently;
- shown in the full right-side panel; listed in the left nav like PR/Jira tabs.

This is "Option A": a genuine terminal (node-pty + xterm.js), chosen over a lightweight
command-runner (execa + log pane) because we want live shells we can sit in, not just
fire-and-read commands. The programmatic read/write we want is fully supported by A.

## Decisions (locked)

| Topic | Decision |
| --- | --- |
| Terminal engine | **node-pty** (main process) + **xterm.js** (`@xterm/xterm`, renderer) |
| Count | **Multiple**, id-keyed. One terminal per worktree folder |
| Folder source | Native folder picker (already wired) or a project's `workspace` |
| Shell | User's login + interactive shell → full macOS terminal environment |
| Layout | **Full right-side panel** (replaces content, like the page viewer) |
| Nav | A **"Terminals"** group in the left nav (one row per open terminal) |
| Toolbar | **Add** a Terminal button to the viewer toolbar; **remove** the ✕ (close) button |
| Read/write API | Per-id `create` / `write` / `onData` / `resize` / `kill` on the IPC bridge |
| Browser | PTY needs Electron; in a plain browser show an "open in the app" note |
| Automation (execa, Agent-SDK loop) | **Out of scope** for this work — see Future |

## Architecture

```
renderer (index.html)                preload.js                 main (tray.js)
  xterm Terminal per id   ── write ──▶  contextBridge  ── ipc ──▶  node-pty per id
        ▲                                  window.taskhub.term      Map<id, pty>
        └────────── onData ◀── ipc ◀────────────────────────────────  pty.onData
```

- **Main process** owns the PTYs: `Map<string, IPty>`. Spawns/kills shells, pipes
  `pty.onData` → renderer over IPC, applies `pty.write` from the renderer.
- **preload.js** extends the existing `window.taskhub` bridge with a `term` namespace
  (contextIsolation stays on; only this minimal API is exposed).
- **Renderer** owns the xterm instances: `Map<string, Terminal>`. Renders the active
  one in the right panel; background terminals keep their buffer but don't render.

### IPC / bridge API

```js
// preload → window.taskhub.term
create({ cwd, shell? }) -> Promise<id>     // spawn a login shell in cwd, returns id
write(id, data)                            // type into that terminal (raw bytes)
onData(id, cb) -> unsubscribe()            // stream that terminal's output
resize(id, cols, rows)                     // keep PTY size in sync with xterm/FitAddon
kill(id)                                   // terminate the shell, free the PTY
list() -> Promise<[{id, cwd, title}]>      // restore/rehydrate UI on reload
```

`onData` dispatch: main emits `term:data` ipc events `{ id, chunk }`; preload keeps a
`Map<id, Set<cb>>` and fans out, returning an unsubscribe so the renderer can clean up
when a terminal view is destroyed.

### Shell & environment (matches macOS Terminal)

An Electron app launched from Finder/Dock does **not** inherit your dotfile `PATH`.
Fix: don't rely on `process.env` — spawn a **login + interactive** shell so it sources
`.zprofile`/`.zshrc` and rebuilds the full environment itself (same as opening a new
Terminal tab). This is what VS Code / iTerm / Hyper do.

```js
const shell = process.env.SHELL || '/bin/zsh';
pty.spawn(shell, ['-l', '-i'], {
  name: 'xterm-256color',
  cwd: worktreeFolder,
  env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor',
         LANG: process.env.LANG || 'en_US.UTF-8' },
});
```

## UI / UX

- **Terminal button** in the viewer toolbar (`.split-bar`) opens a terminal; **remove**
  the ✕ "Close panel" button (no longer relevant — views are switched from the nav).
- A new **"Terminals"** group renders in the left nav alongside the GitHub/Jira tab
  groups (reuse the `tabsMarkup`/`opentab` pattern). Each row = one worktree terminal;
  click to show it, middle-click / × to kill it.
- The active terminal shows in the right panel (`#split-body`), full width, using the
  same `viewing-tab` mechanism as the page viewer. Only one terminal is visible at a
  time; the rest stay alive in the background.
- New terminal cwd comes from the **folder picker** (`window.taskhub.chooseFolder`,
  already implemented) or the active project's **`workspace`**.

## Performance plan

The terminal is the heaviest piece; keep it light by:

1. **Prebuilt node-pty** binary (no local compile) — see Packaging.
2. **Lazy-load xterm** — import the xterm bundle only when the first terminal opens, so
   it costs nothing on initial load.
3. **WebGL renderer** (`@xterm/addon-webgl`) attached to the **active** terminal only
   (browsers cap WebGL contexts ~16); detach when a terminal is hidden.
4. **Render only the visible terminal** — hidden terminals still receive `write()` to
   keep their buffer current, but do no fit/render work.
5. **Batch IPC output** — coalesce `pty.onData` chunks on an ~8–16 ms timer in main and
   send one message per tick (biggest win against flooding builds/installs).
6. **Bounded scrollback** (~1000–5000 lines) to cap per-terminal memory.
7. **Flow control** available if the renderer falls behind (`term.write(data, cb)` +
   `pty.pause()/resume()`); rarely needed.

For a handful of mostly-idle terminals this is negligible (same stack as VS Code). If
we ever push many heavy terminals, move PTYs to a `utilityProcess` to keep main
responsive — not needed up front.

## Packaging / native module

node-pty is a native module → two wrinkles:

1. **ABI match.** Must be built for Electron's ABI, not Node's. Using a
   **prebuilt-binary fork** (`@homebridge/node-pty-prebuilt-multiarch@^0.12.0`) avoids a
   compile step. ✅ **Verified**: loads and runs under Electron 42.3.3 (ABI 146) with no
   rebuild; a `$SHELL -lic` login shell resolves the full env (`brew` found on PATH).
   Fallback if a future Electron bumps the ABI past available prebuilds:
   `@electron/rebuild` (Xcode CLT is present on this machine).
2. **asar.** Native `.node` files can't load from inside `app.asar`. Add to
   `package.json` build config:
   ```json
   "asarUnpack": ["**/node_modules/*node-pty*/**"]
   ```
   (The current build target is `dir`; still set `asarUnpack` so a future asar build
   works.)

## Browser fallback

The dashboard also runs in a plain browser (`npm run dev`), where there is no PTY.
When `window.taskhub?.term` is absent, the Terminal button shows a note ("Terminals
run in the TaskHub app") instead of opening a dead panel — mirroring how the folder
picker already degrades.

## Out of scope (future)

These came up but are deliberately **not** part of this work:

- **execa-based scripted automation** — `run(cmd) -> { output, exitCode }` as a separate
  process for exit-code-gated tasks (tests/build/PR). Add later if/when needed.
- **Claude Code agent loop** (implement → validate → PR) via the **Claude Agent SDK**
  (`@anthropic-ai/claude-agent-sdk`, `query()` + session `resume`). Explicitly deferred.

The interactive read/write primitives below are the foundation either could build on.

## PR ↔ terminal split

Each GitHub **PR tab** opens as a split: the PR page on the left, a **paired terminal on
the right**, with a draggable divider. Turns a PR into a workstation — read it, run
things in its checkout beside it.

- **Pairing.** Each PR tab lazily spawns its own terminal (`tab.termId`), created once
  and reused; closing the tab (or the panel) disposes it. Paired terminals are kept out
  of the standalone "Terminals" nav group.
- **cwd.** PR → its project (`projectByPrUrl`); if the PR's branch (`headRefName`) is
  checked out in a local **git worktree** (`/api/worktree` → `git worktree list`), the
  terminal opens there; otherwise the project's `workspace`; otherwise (no workspace) the
  main process falls back to the **app's own repo** (`app.getAppPath()` in dev; home if
  packaged/asar).
- **Layout.** Geometry is CSS-driven: `body.pr-split` + a `--pr-split` fraction size the
  webview (left) and `.term-pane` (right); `#pr-divider` drags the fraction
  (persisted as `taskhub.prRatio`). No webview reparenting (which would reload it).
- **Split toolbar.** The top bar mirrors the panes: a `.bar-wv` segment (back/home/
  reload/open-in-browser + PR title + the terminal toggle) sized to `--pr-split`, and a
  `.bar-term` segment (terminal folder name + Clear) over the terminal. Full-width
  terminal → only `.bar-term`; webview-only → only `.bar-wv`.
- **One icon.** A single terminal button (rounded-rect `>_`) toggles the terminal on/off
  (`taskhub.prSplit`, on by default). Standalone terminals are opened from a project
  page's `>_ Terminal` button. Jira tabs stay full-width.
- **Robust project mapping.** The PR card passes the PR's `repo` + `headRefName` onto the
  tab, so `prCwd` resolves the project **by repo** (`projectByRepo`) — this survives
  `_projects` losing its PR snapshot after a save/delete (which previously made every PR
  fall back to the app repo, e.g. a terminal titled "cli-task-hub"). Requires the project
  to have a Workspace folder set; otherwise the app-repo fallback still applies.

## Terminal theme & font

- **Theme.** `terminal_theme` config: `auto` (default, follows the OS light/dark via
  `prefers-color-scheme`), `light`, or `dark`. Applied to every open terminal live
  (Settings → Terminal → Theme). Light/dark xterm palettes in `TERM_THEMES`.
- **Font.** Stack is `"SF Mono", "SFMonoServed", Menlo, …`: a system-installed SF Mono
  (family "SF Mono") is used first; otherwise a copy served from Terminal.app at
  `/sf-mono` (filenames `SF-Mono-*.otf`; dir is `/System/Applications/Utilities/…` on
  Catalina+, falling back to `/Applications/Utilities/…`) under a **distinct** `@font-face`
  family `SFMonoServed` so it never shadows an installed SF Mono; else Menlo. Loaded
  before xterm measures glyph width.

Verified end-to-end in the real SPA: PR with a workspace → terminal in that folder; PR
without → app-repo fallback; split + divider shown; type/read in the paired terminal;
paired terminals excluded from the nav group.

## Implementation slices

1. ✅ **Deps + packaging** — prebuilt node-pty added (`@homebridge/node-pty-prebuilt-multiarch`),
   `asarUnpack` wired, load verified under Electron 42 (ABI 146). xterm vendoring happens
   with the renderer in slice 3.
2. ✅ **Multi-terminal core** — `Map<id,pty>` + IPC handlers (`create/write/data/resize/
   kill/list`) in `tray.js`; `window.taskhub.term` added to `preload.js` (onData/onExit
   fan-out with unsubscribe). PTYs killed on quit. Verified end-to-end via the bridge:
   create → write `echo` → read output → list → kill all confirmed.
3. ✅ **Renderer** — xterm vendored into `public/vendor/` and **lazy-loaded** on first
   terminal open; `_terms` `Map<id,{term,fit,…}>` wired to `taskhub.term.*` (keystrokes →
   PTY, PTY output → xterm); FitAddon + WebGL renderer; renders the active terminal in
   the right panel; "Terminals" nav group added. Verified: xterm globals/instantiation/
   fit/WebGL all work in the Electron renderer. (WebGL is attached per-terminal on
   create with graceful DOM fallback; per-active disposal to respect the ~16 context cap
   is a slice-5 refinement — degradation is already graceful.)
4. ✅ **UI entry points** — Terminal button added to the viewer toolbar; **✕ removed**;
   webview-only toolbar buttons hidden when a terminal is active (`body.viewing-term`).
   `newTerminal()` (folder picker, any worktree) + `openProjectTerminal()` (a project's
   workspace, button in the project topbar). Verified end-to-end in the real SPA: open
   terminal → type `echo` → read it back from the xterm buffer; nav group + title + pane
   visibility all correct.
5. **Polish** — restore terminals on reload (`list()`), bounded scrollback, IPC
   batching, resize sync.
6. ✅ **PR ↔ terminal split** — paired terminal per GitHub PR on the right (cwd =
   project workspace, else app repo); CSS-driven layout + draggable divider; toolbar
   toggle. Verified end-to-end (see "PR ↔ terminal split" above).
```

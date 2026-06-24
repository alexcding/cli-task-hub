# TaskHub

**A local dashboard and macOS menu-bar app for developers who live in GitHub,
Jira, and the terminal.**

[![macOS](https://img.shields.io/badge/platform-macOS-black)](#quick-start)
[![Node.js](https://img.shields.io/badge/runtime-Node.js-339933)](#quick-start)
[![Tauri](https://img.shields.io/badge/desktop-Tauri-24C8DB)](#desktop-app)
[![Powered by gh](https://img.shields.io/badge/powered%20by-gh-24292f)](#cli-native)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](#license)

TaskHub turns the CLIs you already trust into a fast local task hub. It watches
your pull requests, review requests, CI state, Jira tickets, and worktrees, then
keeps the active queue visible in a web dashboard and a tiny macOS tray signal.

No hosted backend. No new API tokens to paste into another app. Just
authenticated CLI tools, local SQLite snapshots, and a UI built for the daily
review loop.

![TaskHub dashboard](docs/images/dashboard.png)

## Highlights

- **CLI-native** - reads GitHub through `gh`, Jira through Atlassian's `acli`,
  and local repository state through `git`.
- **Local-first** - data stays in local SQLite files; the UI reads snapshots
  instead of calling hosted APIs on every click.
- **Built for review flow** - groups your authored PRs, review requests, CI
  state, Jira links, drafts, and approvals.
- **Project-aware** - each project maps to one GitHub repo, optional Jira JQL,
  workspace path, color, and merge transition.
- **Menu-bar signal** - the tray app shows Tasks and Review items without
  keeping a browser tab front and center.
- **Developer surfaces** - dashboard, project pages, activity logs, terminals,
  worktree actions, and Claude/Codex usage at a glance.

## Quick Start

### Requirements

- Node.js `>=22.12` and npm
- GitHub CLI (`gh`) installed and authenticated
- Atlassian CLI (`acli`) authenticated if you want Jira features
- macOS for the desktop tray app

### Run the dashboard

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000), create a project, and add a
GitHub repo in `owner/repo` format. Add JQL and a merge transition when you want
Jira integration.

For hot reload while developing:

```bash
npm run dev
```

## Desktop App

The desktop shell is a [Tauri](https://tauri.app) (Rust) app. Run it in development:

```bash
bunx tauri dev
```

This starts the local server and opens a native window pointed at it. Build the
packaged macOS app:

```bash
bunx tauri build
```

The app is arm64-focused today. The Rust host (`src-tauri/`) owns the window,
tray, menus, terminals, and the embedded PR/Jira viewer; the same Express backend
runs as a bundled Node sidecar, and user data is written outside the app bundle
(`~/Library/Application Support/tv.accedo.taskhub`). See
[docs/TAURI-PORT.md](docs/TAURI-PORT.md) for the host's internals.

## How It Works

TaskHub uses stale-while-revalidate over local snapshots:

```text
gh / acli / git
      |
poller + webhook forwarder
      |
SQLite snapshots
      |
Express API + SSE
      |
dashboard + tray + terminals
```

![TaskHub overview](docs/images/taskhub-overview.png)

The poller owns normal CLI reads and writes lean snapshots. API endpoints serve
those snapshots instantly, and stale reads trigger background refreshes. Open
pages update through Server-Sent Events.

The important invariant: normal UI reads should stay snapshot-backed. If data
needs to be fresher, improve the sync path instead of adding CLI calls to request
handlers.

For the deeper process and folder layout, see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## CLI-Native

TaskHub intentionally keeps auth in the tools you already use:

- GitHub data comes from the authenticated `gh` CLI.
- Jira data comes from the authenticated Atlassian `acli` CLI.
- Git data comes from local repositories and worktrees.
- The web dashboard and tray read local snapshots through TaskHub's API.

This keeps the app small, inspectable, and compatible with your existing
terminal setup.

## Project Layout

| Path | Purpose |
| --- | --- |
| `src/server` | Express API, poller, repositories, local SQLite stores |
| `src/renderer` | No-build vanilla ES-module web UI |
| `src-tauri` | Tauri/Rust host — window, tray, native menus, updater, terminals, embedded viewer; `bridge.js` exposes `window.taskhub` |
| `src/shared` | HTTP routes + shared constants |
| `docs` | Architecture notes and project images |

## Development

```bash
npm install
npm start        # plain local server
npm run dev      # hot reload server + browser
bunx tauri dev   # the desktop app (Tauri window + backend)
npm test         # node:test suite
bunx tauri build # package the macOS app
```

Useful notes:

- The renderer is plain HTML/CSS/ES modules; there is no frontend build step.
- `src/server/services/poller.js` is the normal GitHub sync path.
- `data.db` and `logs.db` are regenerable caches; `taskhub.db` is durable app
  config.
- Set `TASKHUB_DATA_DIR` to choose a custom data directory.
- If `gh webhook` is missing, polling still catches merges. Install the
  extension with `gh extension install cli/gh-webhook` for faster webhook-based
  updates.

## Releasing

`bunx tauri build` creates local packaged artifacts (`.app`/`.dmg`). Auto-update
is wired to GitHub Releases via `tauri-plugin-updater`; cutting a signed release
(minisign key + `latest.json` manifest) is described in
[docs/TAURI-PORT.md](docs/TAURI-PORT.md).

## Ideas Worth Building

- Desktop notifications for failed CI or new review requests.
- Multi-provider adapters for GitLab, Linear, Azure DevOps, or custom CLIs.
- Keyboard-first command palette.
- Per-project rules for labels, branches, and Jira transitions.
- Lightweight plugin hooks for custom task sources.
- Windows and Linux tray support.

## Contributing

Contributions are welcome. Small, visible improvements are the best place to
start: dashboard ergonomics, parser tests, clearer setup errors, and better docs
for common workflows.

Before changing data flow, keep the snapshot invariant in mind: request handlers
should stay thin, and long-running CLI work should live in services or
repositories.

## License

ISC. See `package.json`.

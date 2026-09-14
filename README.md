# TaskHub

**A local dashboard and macOS menu-bar app for developers who live in GitHub,
Jira, and the terminal.**

The production macOS client is in [`macos/`](macos/README.md): SwiftUI dashboard,
Cocoa sidebar, native Ghostty terminal, native Sprint Board/diff/editor, and a
separate Rust API process. It ships no Node runtime or TaskHub JavaScript.

[![macOS](https://img.shields.io/badge/platform-macOS-black)](#quick-start)
[![Rust](https://img.shields.io/badge/backend-Rust-b7410e)](#native-macos-app)
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

## Native macOS App

Requires macOS, Xcode, Rust ≥1.88, authenticated `gh`, and `acli` for Jira features.
Build the Rust helpers, then open the Xcode project:

```bash
cargo build --manifest-path crates/taskhub-backend/Cargo.toml
cargo build --manifest-path crates/taskhub-ptyd/Cargo.toml --features terminal-snapshots
open macos/TaskHub.xcodeproj
```

The shared scheme launches `crates/taskhub-backend/target/debug/taskhub-backend`.
Packaged apps contain `taskhub-backend` and `taskhub-ptyd` in `Contents/Helpers`.
The older Node web dashboard and Tauri client remain in the repository as legacy
development clients, but are not copied into the native app.

## How It Works

TaskHub uses stale-while-revalidate over local snapshots:

```text
gh / acli / git
      |
poller + webhook forwarder
      |
SQLite snapshots
      |
Rust API + SSE
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
| `crates/taskhub-backend` | Production Rust API, poller, CLI integrations, and SQLite stores |
| `crates/taskhub-ptyd` | Detached native terminal daemon |
| `macos` | Production SwiftUI/AppKit macOS client and packaging |
| `src/server`, `src/renderer`, `src-tauri` | Legacy Node web and Tauri clients; not shipped in the native app |
| `src/shared` | HTTP routes + shared constants |
| `docs` | Architecture notes and project images |

## Legacy web and Tauri development

These clients require Node.js ≥22.12 and npm. They are retained for development
and are not shipped in the native package. `npm start` serves localhost:3000.

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

Build the native Release scheme, run `macos/scripts/bundle-backend.sh`, and package
with `macos/scripts/package-direct.py --local`. See [the native guide](macos/README.md)
for exact commands and optional Developer ID/notarized distribution. The current
local review package is `macos/.build/review-20260914-rust-final/`.

The Rust helper also provides `backup`, `verify`, and `restore`; packaged startup
checks existing data before migrations. See [data recovery](docs/DATA-RECOVERY.md).

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
